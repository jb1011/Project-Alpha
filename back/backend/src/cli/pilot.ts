import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  type Address,
  type Hex,
  type WalletClient,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  parseAbiItem,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { iIdentityRegistryAbi } from "../abis/generated";
import { awaitSuccessfulReceipt } from "../adapters/arc/receipts";
import {
  LINK_DOMAIN_NAME,
  LINK_DOMAIN_VERSION,
  LINK_PRIMARY_TYPE,
  LinkShapeError,
  linkDomain,
  linkFromWire,
  linkVerifyTypes,
} from "../legalBody/link";
import { type PilotContext, openPilotContext } from "../pilot/context";
import { formatUnitsUsd } from "../policy/units";
import { withDeadline } from "../util/deadline";

/**
 * THE PILOT'S OPERATOR COMMANDS (Kleros pilot, test data on Arc testnet).
 *
 * `pilot:agent` lets the two test agents' wallets do, from the box, what the browser flow asks of
 * an identity owner: register an ERC-8004 identity, sign the link message the flow serves, write
 * the `legalBody` pointer, and show where they stand. The keys never leave the box: a command
 * prints addresses, hashes and signatures, never a key.
 *
 * Like `company:*`, every command opens its own narrow context (`openPilotContext`, never
 * `buildContext`), prints ONE JSON object on success and throws on a refusal. The sending
 * commands print the decoded call and send nothing without `--yes`; with it they simulate first
 * and send only what the simulation accepted.
 */

type Party = "buyer" | "seller";

/** The metadata key the legal-body pointer is written under. */
const POINTER_KEY = "legalBody";

/** How long the lookup may take before `show` gives up on it. */
const LOOKUP_DEADLINE_MS = 15_000;

/** The ERC-721 mint log. The identity registry's ABI carries no events, so it is parsed inline. */
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

/** A uint256 as a canonical decimal: no sign, no leading zero, at most 78 digits. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const UINT256_MAX = (1n << 256n) - 1n;
/** At least one whole byte of hex. */
const WHOLE_BYTES_HEX = /^0x(?:[0-9a-fA-F]{2})+$/;

function refuse(message: string): never {
  throw new Error(`refusing: ${message}`);
}

function print(output: Record<string, unknown>): void {
  console.log(JSON.stringify(output, null, 2));
}

function parseParty(value: string): Party {
  if (value !== "buyer" && value !== "seller") refuse("--party must be buyer or seller");
  return value;
}

function parseAgentId(value: string): bigint {
  if (!CANONICAL_DECIMAL.test(value)) refuse("--agent must be an agent id in decimal");
  const id = BigInt(value);
  if (id > UINT256_MAX) refuse("--agent must fit in a uint256");
  return id;
}

function parseValue(value: string): Hex {
  if (!WHOLE_BYTES_HEX.test(value)) refuse("--value must be 0x followed by whole bytes of hex");
  return value as Hex;
}

/** Opens the context, runs `fn`, and closes the context whatever happens. */
async function withPilot<T>(
  open: () => PilotContext,
  fn: (ctx: PilotContext) => Promise<T>,
): Promise<T> {
  const ctx = open();
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

function walletOf(ctx: PilotContext, party: Party): { wallet: WalletClient; address: Address } {
  return { wallet: ctx.wallets[party], address: ctx.addresses[party] };
}

/**
 * Simulates the registry call from the party's account, sends what the simulation returned, and
 * waits for a successful receipt. Nothing is signed if the simulation reverts.
 */
async function sendRegistryCall(
  ctx: PilotContext,
  party: Party,
  call:
    | { functionName: "register"; args: readonly [string] }
    | { functionName: "setMetadata"; args: readonly [bigint, string, Hex] },
): Promise<Hex> {
  const { wallet } = walletOf(ctx, party);
  const account = wallet.account;
  if (!account) refuse(`the ${party} wallet has no account`);
  const { request } = await ctx.publicClient.simulateContract({
    account,
    address: ctx.cfg.identityRegistry,
    abi: iIdentityRegistryAbi,
    ...call,
  } as Parameters<PilotContext["publicClient"]["simulateContract"]>[0]);
  const txHash = await wallet.writeContract(
    request as Parameters<WalletClient["writeContract"]>[0],
  );
  await awaitSuccessfulReceipt(ctx.publicClient, txHash, {
    reverted: (h) => new Error(`${call.functionName} ${h} reverted`),
    unconfirmed: (h) =>
      new Error(
        `${call.functionName} ${h} was sent but not confirmed: look it up before sending again`,
      ),
  });
  return txHash;
}

async function register(
  ctx: PilotContext,
  party: Party,
  metadataUri: string,
  yes: boolean,
): Promise<Record<string, unknown>> {
  const { address } = walletOf(ctx, party);
  const contract = ctx.cfg.identityRegistry;
  const args = [metadataUri] as const;
  if (!yes)
    return {
      dryRun: true,
      party,
      address,
      contract,
      call: { functionName: "register", args },
      data: encodeFunctionData({ abi: iIdentityRegistryAbi, functionName: "register", args }),
      next: "nothing was sent: run the same command with --yes to send it",
    };

  const txHash = await sendRegistryCall(ctx, party, { functionName: "register", args });
  const receipt = await ctx.publicClient.getTransactionReceipt({ hash: txHash });
  const mints = parseEventLogs({ abi: [TRANSFER_EVENT], logs: receipt.logs }).filter(
    (log) =>
      isAddressEqual(log.address, contract) &&
      isAddressEqual(log.args.from, zeroAddress) &&
      isAddressEqual(log.args.to, address),
  );
  const mint = mints[0];
  if (mints.length !== 1 || !mint)
    throw new Error(
      `register ${txHash} succeeded but carries ${mints.length} mints to ${address}: read the receipt before registering again`,
    );
  return { party, address, agentId: mint.args.tokenId.toString(), txHash };
}

async function point(
  ctx: PilotContext,
  party: Party,
  agentId: bigint,
  value: Hex,
  yes: boolean,
): Promise<Record<string, unknown>> {
  const { address } = walletOf(ctx, party);
  const contract = ctx.cfg.identityRegistry;
  const owner = await ctx.publicClient.readContract({
    address: contract,
    abi: iIdentityRegistryAbi,
    functionName: "ownerOf",
    args: [agentId],
  });
  if (!isAddressEqual(owner, address))
    refuse(`agent ${agentId} is owned by ${owner}, not by the ${party} (${address})`);

  const args = [agentId, POINTER_KEY, value] as const;
  if (!yes)
    return {
      dryRun: true,
      party,
      address,
      contract,
      call: { functionName: "setMetadata", args: [agentId.toString(), POINTER_KEY, value] },
      data: encodeFunctionData({ abi: iIdentityRegistryAbi, functionName: "setMetadata", args }),
      next: "nothing was sent: run the same command with --yes to send it",
    };

  const txHash = await sendRegistryCall(ctx, party, { functionName: "setMetadata", args });
  return { party, address, agentId: agentId.toString(), key: POINTER_KEY, value, txHash };
}

/**
 * Signs the link message the browser flow served, and only that: the file must be the legal-body
 * link typed data for this deployment's chain and factory. Anything else (a payment authorization
 * among them) is refused before the key is used.
 */
async function signLink(
  ctx: PilotContext,
  party: Party,
  typedDataPath: string,
): Promise<Record<string, unknown>> {
  const { wallet, address } = walletOf(ctx, party);
  let served: unknown;
  try {
    served = JSON.parse(readFileSync(typedDataPath, "utf8"));
  } catch (e) {
    refuse(`--typed-data cannot be read as JSON: ${(e as Error).message}`);
  }
  if (typeof served !== "object" || served === null)
    refuse("the typed data is not the legal-body link message");
  const { domain, primaryType, message } = served as Record<string, unknown>;
  if (primaryType !== LINK_PRIMARY_TYPE)
    refuse("the typed data is not the legal-body link message");

  const factory = ctx.cfg.legalBodyFactory;
  if (!factory) refuse("this box has no legal-body factory configured, so it serves no link");
  const expected = linkDomain(ctx.cfg.chainId, factory);
  const d = (domain ?? {}) as Record<string, unknown>;
  if (
    d.name !== LINK_DOMAIN_NAME ||
    d.version !== LINK_DOMAIN_VERSION ||
    d.chainId !== expected.chainId ||
    typeof d.verifyingContract !== "string" ||
    d.verifyingContract.toLowerCase() !== factory.toLowerCase()
  )
    refuse(
      `the link's domain is not this deployment's (chain ${expected.chainId}, factory ${factory})`,
    );

  let link: ReturnType<typeof linkFromWire>;
  try {
    link = linkFromWire(message);
  } catch (e) {
    if (e instanceof LinkShapeError) refuse(`the link message is malformed: ${e.message}`);
    throw e;
  }
  const account = wallet.account;
  if (!account) refuse(`the ${party} wallet has no account`);
  const signature = await wallet.signTypedData({
    account,
    domain: expected,
    types: linkVerifyTypes(),
    primaryType: LINK_PRIMARY_TYPE,
    message: link,
  });
  return { party, address, signature };
}

async function show(
  ctx: PilotContext,
  party: Party,
  agentId: bigint | undefined,
): Promise<Record<string, unknown>> {
  const { address } = walletOf(ctx, party);
  const balance = await ctx.publicClient.readContract({
    address: ctx.cfg.usdc,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
  let ownerOf: Address | null = null;
  let lookup: Record<string, unknown> | null = null;
  if (agentId !== undefined) {
    ownerOf = await ctx.publicClient.readContract({
      address: ctx.cfg.identityRegistry,
      abi: iIdentityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    });
    const base = ctx.cfg.pilot?.lookupBase;
    if (!base) refuse("this box has no pilot lookup base");
    const url = `${base}/legal-bodies/by-agent/${agentId}`;
    const answer = await withDeadline(LOOKUP_DEADLINE_MS, async (signal) => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`the lookup ${url} answered ${res.status}`);
      return (await res.json()) as { legalBody?: unknown; standing?: unknown };
    });
    lookup = { url, legalBody: answer.legalBody, standing: answer.standing };
  }
  return {
    party,
    address,
    usdcBalance: formatUnitsUsd(balance),
    usdcBalanceAtomic: balance.toString(),
    agentId: agentId === undefined ? null : agentId.toString(),
    ownerOf,
    lookup,
  };
}

interface PartyOption {
  party: string;
}

export function registerPilotCommands(
  program: Command,
  open: () => PilotContext = openPilotContext,
): void {
  const agent = program
    .command("pilot:agent")
    .description(
      "the Kleros pilot's two test agents (test data): register an identity, sign the link, write the pointer, show",
    );

  agent
    .command("register")
    .description("register an ERC-8004 identity owned by the party's wallet")
    .requiredOption("--party <buyer|seller>", "the test agent whose wallet registers")
    .option("--metadata-uri <uri>", "the registration URI (empty when not given)")
    .option("--yes", "confirm: send the transaction")
    .action((opts: PartyOption & { metadataUri?: string; yes?: boolean }) =>
      withPilot(open, async (ctx) =>
        print(await register(ctx, parseParty(opts.party), opts.metadataUri ?? "", !!opts.yes)),
      ),
    );

  agent
    .command("sign-link")
    .description(
      "sign the legal-body link message the browser flow served, with the party's key; prints the signature, sends nothing",
    )
    .requiredOption("--party <buyer|seller>", "the test agent whose wallet signs")
    .requiredOption("--typed-data <file>", "the served typed data, as JSON")
    .action((opts: PartyOption & { typedData: string }) =>
      withPilot(open, async (ctx) =>
        print(await signLink(ctx, parseParty(opts.party), opts.typedData)),
      ),
    );

  agent
    .command("point")
    .description(
      `write the ${POINTER_KEY} metadata pointer on the party's identity; refused unless the party owns it`,
    )
    .requiredOption("--party <buyer|seller>", "the test agent whose wallet writes")
    .requiredOption("--agent <id>", "the agent id, in decimal")
    .requiredOption("--value <hex>", "the pointer value, as 0x hex")
    .option("--yes", "confirm: send the transaction")
    .action((opts: PartyOption & { agent: string; value: string; yes?: boolean }) =>
      withPilot(open, async (ctx) => {
        const party = parseParty(opts.party);
        const agentId = parseAgentId(opts.agent);
        const value = parseValue(opts.value);
        print(await point(ctx, party, agentId, value, !!opts.yes));
      }),
    );

  agent
    .command("show")
    .description(
      "show the party's address, USDC balance and, with --agent, the identity's owner and the lookup answer",
    )
    .requiredOption("--party <buyer|seller>", "the test agent to show")
    .option("--agent <id>", "the agent id, in decimal")
    .action((opts: PartyOption & { agent?: string }) =>
      withPilot(open, async (ctx) => {
        const party = parseParty(opts.party);
        const agentId = opts.agent === undefined ? undefined : parseAgentId(opts.agent);
        print(await show(ctx, party, agentId));
      }),
    );
}
