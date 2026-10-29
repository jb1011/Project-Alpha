import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import {
  type Address,
  type Hex,
  type WalletClient,
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  keccak256,
  parseAbiItem,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { iIdentityRegistryAbi } from "../abis/generated";
import { awaitSuccessfulReceipt } from "../adapters/arc/receipts";
import { klerosCaseUrl } from "../adapters/kleros/deployments";
import type { FakeScript } from "../adapters/kleros/fakeDisputeService";
import { type Config, loadConfig } from "../config/env";
import {
  ChainTxRevertedError,
  ChainTxUnconfirmedError,
  JobFundRevertedError,
  JobFundUnconfirmedError,
} from "../errors";
import {
  LINK_DOMAIN_NAME,
  LINK_DOMAIN_VERSION,
  LINK_PRIMARY_TYPE,
  LinkShapeError,
  linkDomain,
  linkFromWire,
  linkVerifyTypes,
} from "../legalBody/link";
import { PILOT_FILED_OR_LATER_STATUSES, PILOT_FILED_STATUSES } from "../pilot/casesRepository";
import {
  DEFAULT_SCRIPT,
  type KlerosStage,
  buildKlerosService,
  buildPilotChain,
} from "../pilot/composition";
import { type PilotContext, openPilotContext } from "../pilot/context";
import {
  type FileDisputeDeps,
  type FileOutcome,
  type Preflight,
  fileDispute,
  preflightDispute,
} from "../pilot/dispute";
import {
  type CreatePilotJobInput,
  type PilotJobDeps,
  createMayHaveBeenSent,
  createPilotJob,
  pilotCaseIdOf,
  preflightPilotJob,
  withoutEmDash,
} from "../pilot/job";
import { checkKleros } from "../pilot/klerosCheck";
import { httpLookupClient } from "../pilot/lookup";
import {
  PILOT_MODES,
  type PilotCaseRecord,
  type PilotMode,
  type PilotStatus,
} from "../pilot/types";
import { formatUnitsUsd } from "../policy/units";
import { withDeadline } from "../util/deadline";
import { publicErrorMessage } from "../workflow/publicError";

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

/** ERC-721 `balanceOf`, read inline as `Transfer` is: the identity registry's ABI does not carry it. */
const BALANCE_OF = parseAbiItem("function balanceOf(address owner) view returns (uint256)");

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

function parseAgentId(value: string, option = "--agent"): bigint {
  if (!CANONICAL_DECIMAL.test(value)) refuse(`${option} must be an agent id in decimal`);
  const id = BigInt(value);
  if (id > UINT256_MAX) refuse(`${option} must fit in a uint256`);
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
  again: boolean,
): Promise<Record<string, unknown>> {
  const { address } = walletOf(ctx, party);
  const contract = ctx.cfg.identityRegistry;
  const args = [metadataUri] as const;
  // A second identity for the same wallet is almost always a repeated command, so it needs --again.
  const existing = await ctx.publicClient.readContract({
    address: contract,
    abi: [BALANCE_OF],
    functionName: "balanceOf",
    args: [address],
  });
  if (!yes)
    return {
      dryRun: true,
      party,
      address,
      contract,
      existingIdentities: existing.toString(),
      call: { functionName: "register", args },
      data: encodeFunctionData({ abi: iIdentityRegistryAbi, functionName: "register", args }),
      next: "nothing was sent: run the same command with --yes to send it",
    };
  if (existing > 0n && !again)
    refuse(
      `the ${party} (${address}) already holds an identity on the registry (count ${existing}): pass --again to register another`,
    );

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
  let text: string;
  try {
    text = readFileSync(typedDataPath, "utf8");
  } catch (e) {
    // The read error names the path, not the content.
    refuse(`--typed-data ${typedDataPath} cannot be read: ${(e as Error).message}`);
  }
  let served: unknown;
  try {
    served = JSON.parse(text);
  } catch {
    // Never echo the parser's message: it quotes the file's opening bytes, which may be a key.
    refuse(`--typed-data ${typedDataPath} cannot be read as JSON`);
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
  return {
    party,
    address,
    agentId: link.agentId.toString(),
    guardian: link.guardian,
    deadline: link.deadline.toString(),
    signature,
  };
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

// --- THE CASE COMMANDS: pilot:job, pilot:contest, pilot:case ---

/** What the case commands read beyond the context; every one has a default, and the tests stub them. */
export interface PilotCommandDeps {
  /** The config as the context would load it, read before the context opens: the mode and the
   *  agent ids decide what `pilot:job` accepts, and a refused option must open no database. */
  readConfig: () => Config;
  preflight: typeof preflightPilotJob;
  createJob: typeof createPilotJob;
  /** Unix seconds. */
  now: () => number;
  /** The Kleros stage the mode selects: the fake, or the HTTP client of the mode's key. */
  buildStage: typeof buildKlerosService;
  preflightDispute: typeof preflightDispute;
  fileDispute: typeof fileDispute;
  checkKleros: typeof checkKleros;
  /** The banner's wait before a testnet or live filing. */
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: PilotCommandDeps = {
  readConfig: () => {
    loadDotenv();
    return loadConfig();
  },
  preflight: preflightPilotJob,
  createJob: createPilotJob,
  now: () => Math.floor(Date.now() / 1000),
  buildStage: buildKlerosService,
  preflightDispute,
  fileDispute,
  checkKleros,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Shown on every job and case output: these are test agents moving test USDC on Arc testnet. */
const PILOT_NOTE = "test data: two test agents and test USDC on Arc testnet";

/** The most a free text (a contest reason or reply, a description, a note) may hold, in UTF-8 bytes. */
const MAX_TEXT_BYTES = 4096;
/** The most a case label may hold, in UTF-8 bytes: a short name, printed in every case list. */
const MAX_LABEL_BYTES = 64;
/** USDC's decimals. */
const USDC_DECIMALS = 6;
const DAY_SECONDS = 86_400;
const DEFAULT_EXPIRY_DAYS = 7;
const CASE_ID = /^pc_[0-9a-f]{12}$/;
/** A USDC amount in decimal: whole units, then at most six fraction digits. */
const USDC_DECIMAL = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,6}))?$/;

/** A C0 control, DEL or a C1 control; the tab and the newline only when `singleLine`. Read by
 *  code point, since the linter refuses control characters in a regular expression. */
function hasControl(text: string, singleLine: boolean): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (!singleLine && (c === 0x09 || c === 0x0a)) continue;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * The first invisible character in `text`, as `U+XXXX`: every Unicode format character (zero-width
 * characters and marks, the bidirectional embeddings, overrides and isolates, the invisible
 * operators, the soft hyphen, the tag characters, the byte order mark), the line and paragraph
 * separators, and the Hangul fillers, which render blank. The description goes on chain for
 * good and the texts are served publicly, where such a character would hide or reorder text.
 */
const FORMAT_CHARACTER = /\p{Cf}/u;
const BLANK_FILLERS: ReadonlySet<number> = new Set([
  0x115f, 0x1160, 0x3164, 0xffa0, 0x2028, 0x2029,
]);
function formatCharacterOf(text: string): string | undefined {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (FORMAT_CHARACTER.test(ch) || BLANK_FILLERS.has(c))
      return `U+${c.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return undefined;
}

/** Filed or later: a dispute exists on Kleros. The repository's list, so this gate and
 *  `countSeenInCourt` read the same statuses. */
const FILED_OR_LATER: ReadonlySet<PilotStatus> = new Set(PILOT_FILED_OR_LATER_STATUSES);
/** The statuses a mode's cap counts: the dispute exists or may exist on Kleros. */
const FILED: ReadonlySet<PilotStatus> = new Set(PILOT_FILED_STATUSES);

/** A transaction hash: 0x and 64 hex digits. */
function parseTxHash(option: string, value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value))
    refuse(`${option} must be a transaction hash (0x and 64 hex digits)`);
  return value.toLowerCase() as Hex;
}

function parseCaseId(option: string, value: string): string {
  if (!CASE_ID.test(value)) refuse(`${option} must be a pilot case id (pc_ and 12 hex digits)`);
  return value;
}

/** A free text: not blank, at most 4096 bytes, no control character (newline and tab allowed
 *  unless `singleLine`, and CRLF read as a newline). Returns the text with CRLF made LF. */
function checkText(what: string, raw: string, o: { singleLine?: boolean } = {}): string {
  // A file saved with Windows line endings is the same text: CRLF becomes LF before any check.
  const text = o.singleLine ? raw : raw.replaceAll("\r\n", "\n");
  if (text.trim() === "") refuse(`${what} is empty`);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_TEXT_BYTES) refuse(`${what} is over ${MAX_TEXT_BYTES} bytes (${bytes})`);
  if (hasControl(text, !!o.singleLine))
    refuse(
      `${what} holds a control character${o.singleLine ? "" : " other than a newline or a tab"}`,
    );
  const format = formatCharacterOf(text);
  if (format !== undefined) refuse(`${what} holds the invisible format character ${format}`);
  return text;
}

function readBytes(option: string, path: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch (e) {
    // The read error names the path, not the content.
    refuse(`${option} ${path} cannot be read: ${(e as Error).message}`);
  }
}

/** A text file, read as strict UTF-8 and checked as a free text. */
function readText(option: string, path: string): string {
  const bytes = readBytes(option, path);
  // Twice the limit before decoding: CRLF at most doubles a text that fits once made LF.
  if (bytes.byteLength > 2 * MAX_TEXT_BYTES)
    refuse(`${option} ${path} is over ${MAX_TEXT_BYTES} bytes (${bytes.byteLength})`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse(`${option} ${path} is not UTF-8 text`);
  }
  return checkText(`${option} ${path}`, text);
}

/** "2.00" to 2_000_000 atomic: whole units and fraction digits apart, no floating point. */
function parseBudget(value: string): bigint {
  const m = USDC_DECIMAL.exec(value);
  if (!m)
    refuse(
      `--budget must be a USDC amount in decimal with at most ${USDC_DECIMALS} fraction digits, for example 2.00`,
    );
  const whole = BigInt(m[1] as string);
  const fraction = BigInt((m[2] ?? "").padEnd(USDC_DECIMALS, "0"));
  const atomic = whole * 10n ** BigInt(USDC_DECIMALS) + fraction;
  if (atomic === 0n) refuse("--budget must be above zero");
  return atomic;
}

function parsePositiveInt(option: string, value: string, maxDigits: number): number {
  if (!new RegExp(`^[1-9][0-9]{0,${maxDigits - 1}}$`).test(value))
    refuse(`${option} must be a whole number above zero`);
  return Number(value);
}

/** The expiry in seconds: --expiry-days (default 7) or, in rehearsal only, --expiry-seconds. */
function parseExpiry(mode: PilotMode, days?: string, seconds?: string): number {
  if (days !== undefined && seconds !== undefined)
    refuse("--expiry-days and --expiry-seconds cannot both be given");
  if (seconds !== undefined) {
    if (mode !== "rehearsal")
      refuse(
        `--expiry-seconds is accepted in rehearsal mode only, and this box runs in ${mode} mode: use --expiry-days`,
      );
    return parsePositiveInt("--expiry-seconds", seconds, 9);
  }
  if (days === undefined) return DEFAULT_EXPIRY_DAYS * DAY_SECONDS;
  return parsePositiveInt("--expiry-days", days, 4) * DAY_SECONDS;
}

/** The agent id from the option, else from the environment, as a canonical decimal. */
function agentIdOf(role: Party, option: string | undefined, fromEnv: string | undefined): string {
  const flag = `--${role}-agent`;
  const variable = `PILOT_${role.toUpperCase()}_AGENT_ID`;
  const value = option ?? fromEnv;
  if (value === undefined)
    refuse(`the ${role}'s agent id is not given: pass ${flag} or ${variable}`);
  return parseAgentId(value, option !== undefined ? flag : variable).toString();
}

const isoOf = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

/** The case's page in the Kleros Court interface, from the row's own deployment; null without ids. */
function courtUrlOf(row: PilotCaseRecord): string | null {
  if (row.klerosChain === null || row.klerosChain === "fake" || row.coreDisputeId === null)
    return null;
  return klerosCaseUrl(row.klerosChain, row.coreDisputeId);
}

function findCase(ctx: PilotContext, caseId: string): PilotCaseRecord {
  const row = ctx.cases.find(caseId);
  if (!row) refuse(`no pilot case ${caseId}`);
  return row;
}

/** An error that names a transaction that was sent: its hash may exist nowhere else. */
function sentHashOf(e: unknown): Hex | undefined {
  return e instanceof ChainTxRevertedError ||
    e instanceof ChainTxUnconfirmedError ||
    e instanceof JobFundRevertedError ||
    e instanceof JobFundUnconfirmedError
    ? e.txHash
    : undefined;
}

interface JobOptions {
  label: string;
  descriptionFile: string;
  deliverable: string;
  budget: string;
  expiryDays?: string;
  expirySeconds?: string;
  resume?: string;
  fundTx?: string;
  submitTx?: string;
  buyerAgent?: string;
  sellerAgent?: string;
  yes?: boolean;
}

interface ParsedJob {
  mode: PilotMode;
  input: CreatePilotJobInput;
  agentIds: { buyer: string; seller: string };
  resume: string | undefined;
  deliverablePath: string;
}

/** Every option of `pilot:job`, checked before the context opens. */
function parseJob(opts: JobOptions, cfg: Config): ParsedJob {
  const pilot = cfg.pilot;
  if (!pilot)
    refuse(
      "the pilot keys are not set on this box (PILOT_BUYER_PRIVATE_KEY, PILOT_SELLER_PRIVATE_KEY, PILOT_REFEREE_PRIVATE_KEY)",
    );
  const mode = pilot.mode;
  const label = checkText("--label", opts.label, { singleLine: true });
  const labelBytes = Buffer.byteLength(label, "utf8");
  if (labelBytes > MAX_LABEL_BYTES)
    refuse(`--label is over ${MAX_LABEL_BYTES} bytes (${labelBytes})`);
  const budgetAtomic = parseBudget(opts.budget);
  const expirySeconds = parseExpiry(mode, opts.expiryDays, opts.expirySeconds);
  const resume = opts.resume === undefined ? undefined : parseCaseId("--resume", opts.resume);
  const givenTx = {
    fund: opts.fundTx === undefined ? undefined : parseTxHash("--fund-tx", opts.fundTx),
    submit: opts.submitTx === undefined ? undefined : parseTxHash("--submit-tx", opts.submitTx),
  };
  if (resume === undefined && (givenTx.fund !== undefined || givenTx.submit !== undefined))
    refuse(
      "--fund-tx and --submit-tx name a transaction of a recorded case: pass them with --resume",
    );
  const agentIds = {
    buyer: agentIdOf("buyer", opts.buyerAgent, pilot.buyerAgentId),
    seller: agentIdOf("seller", opts.sellerAgent, pilot.sellerAgentId),
  };
  const description = readText("--description-file", opts.descriptionFile);
  const bytes = readBytes("--deliverable", opts.deliverable);
  const name = basename(opts.deliverable);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  if (extension === "") refuse(`--deliverable ${opts.deliverable} has no file extension`);
  return {
    mode,
    input: {
      label,
      description,
      deliverable: { bytes, extension },
      budgetAtomic,
      expirySeconds,
      mode,
      ...(givenTx.fund === undefined && givenTx.submit === undefined ? {} : { givenTx }),
    },
    agentIds,
    resume,
    deliverablePath: opts.deliverable,
  };
}

async function job(
  ctx: PilotContext,
  deps: PilotCommandDeps,
  p: ParsedJob,
  yes: boolean,
): Promise<Record<string, unknown>> {
  const pilot = ctx.cfg.pilot;
  if (!pilot) refuse("the pilot keys are not set on this box");
  const jobDeps: PilotJobDeps = {
    chain: buildPilotChain(ctx),
    cases: ctx.cases,
    docStore: ctx.docStore,
    lookup: httpLookupClient(pilot.lookupBase),
    agentIds: p.agentIds,
    now: deps.now,
    maxBudgetAtomic: ctx.cfg.maxJobBudget,
  };
  const stage = { mode: p.mode };
  const { bytes, extension } = p.input.deliverable;
  const deliverable = {
    path: p.deliverablePath,
    extension,
    bytes: bytes.byteLength,
    hash: keccak256(bytes),
  };
  const budget = {
    budget: formatUnitsUsd(p.input.budgetAtomic),
    budgetAtomic: p.input.budgetAtomic.toString(),
  };

  if (!yes) {
    if (p.resume !== undefined) {
      const row = findCase(ctx, p.resume);
      if (row.mode !== p.mode)
        refuse(
          `pilot case ${row.caseId} was created in ${row.mode} mode, and this box runs in ${p.mode} mode`,
        );
      return {
        dryRun: true,
        ...stage,
        resume: { caseId: row.caseId, mode: row.mode, status: row.status, jobId: row.jobId },
        deliverable,
        note: PILOT_NOTE,
        next: "nothing was sent: run the same command with --yes to resume the case; the resume reads the chain and runs the pre-flight again before it sends",
      };
    }
    const pre = await deps.preflight(jobDeps, p.input);
    if (!pre.ok) refuse(pre.problem);
    return {
      dryRun: true,
      ...stage,
      label: p.input.label,
      buyer: { agentId: p.agentIds.buyer, address: ctx.addresses.buyer, legalName: pre.buyerName },
      seller: {
        agentId: p.agentIds.seller,
        address: ctx.addresses.seller,
        legalName: pre.sellerName,
      },
      referee: ctx.addresses.referee,
      buyerBalance: formatUnitsUsd(pre.buyerBalance),
      buyerBalanceAtomic: pre.buyerBalance.toString(),
      ...budget,
      expirySeconds: p.input.expirySeconds,
      expiresAt: isoOf(deps.now() + p.input.expirySeconds),
      deliverable,
      note: PILOT_NOTE,
      next: "nothing was sent: run the same command with --yes to create, fund and submit the job",
    };
  }

  let row: PilotCaseRecord;
  try {
    row = await deps.createJob(jobDeps, p.input, p.resume);
  } catch (e) {
    const txHash = sentHashOf(e);
    const caseId = pilotCaseIdOf(e);
    const error = withoutEmDash(publicErrorMessage(e));
    if (caseId !== undefined) {
      // A row exists: running the command again without --resume would create and fund a
      // second job, so the case to resume is printed with the step that resumes it.
      const resume = `run the same command with --resume ${caseId} --yes`;
      print({
        failed: true,
        ...stage,
        caseId,
        status: ctx.cases.find(caseId)?.status ?? null,
        ...(txHash === undefined ? {} : { txHash }),
        error,
        next:
          txHash === undefined
            ? `the case is recorded; once the cause is fixed, ${resume}`
            : `wait until the transaction is mined or dropped, then ${resume}`,
        note: PILOT_NOTE,
      });
    } else if (txHash === undefined && createMayHaveBeenSent(e))
      // No hash and no row: nothing records whether the create reached the chain.
      print({
        failed: true,
        ...stage,
        caseId: null,
        error,
        warning: "it may have been sent: check the buyer's latest transactions before re-running",
        note: PILOT_NOTE,
      });
    else if (txHash !== undefined)
      // A failed createJob leaves no row, so its hash is printed here or nowhere.
      print({
        failed: true,
        ...stage,
        caseId: null,
        txHash,
        error,
        next: "no case was recorded: look the hash up on the explorer before running the command again, since the job may exist on chain",
        note: PILOT_NOTE,
      });
    throw e;
  }
  return { ...stage, case: row, note: PILOT_NOTE };
}

async function contest(
  ctx: PilotContext,
  deps: PilotCommandDeps,
  caseId: string,
  reason: string,
  reply: string | null,
  yes: boolean,
): Promise<Record<string, unknown>> {
  const row = findCase(ctx, caseId);
  if (row.status !== "submitted")
    refuse(`pilot case ${caseId} is at ${row.status}; only a submitted case can be contested`);
  if (!yes)
    return {
      dryRun: true,
      caseId,
      from: "submitted",
      to: "contested",
      contestReason: reason,
      contestReply: reply,
      next: "nothing was changed: run the same command with --yes to contest the case",
    };
  const contestedAt = deps.now();
  const next = ctx.cases.transaction(() => {
    const moved = ctx.cases.advance(caseId, "submitted", "contested", {
      contestReason: reason,
      contestReply: reply,
      contestedAt,
    });
    if (!moved) refuse(`pilot case ${caseId} moved from submitted while this command ran`);
    ctx.cases.recordEvent(caseId, "contest", "ok", null, null);
    return moved;
  });
  return { case: next, contestedAt: isoOf(contestedAt), note: PILOT_NOTE };
}

function showCase(ctx: PilotContext, caseId: string): Record<string, unknown> {
  const row = findCase(ctx, caseId);
  return {
    case: row,
    events: ctx.cases.events(caseId),
    courtUrl: courtUrlOf(row),
    note: PILOT_NOTE,
  };
}

function listCases(ctx: PilotContext, mode: PilotMode | undefined): Record<string, unknown> {
  const rows = ctx.cases.list(mode === undefined ? undefined : { mode });
  return {
    cases: rows.map((r) => ({
      caseId: r.caseId,
      label: r.label,
      mode: r.mode,
      status: r.status,
      jobId: r.jobId,
      klerosChain: r.klerosChain,
      coreDisputeId: r.coreDisputeId,
      updatedAt: r.updatedAt,
    })),
    note: PILOT_NOTE,
  };
}

/**
 * Records that a person looked at the dispute in the Kleros Court interface. Only a testnet or
 * live case at filed or later with a dispute id qualifies, and only a success writes the event:
 * the count the next stage's gate reads counts every `seen_in_court` event.
 */
function seenInCourt(
  ctx: PilotContext,
  caseId: string,
  by: string | undefined,
  yes: boolean,
): Record<string, unknown> {
  // One transaction: the row cannot move between the checks and the event.
  return ctx.cases.transaction(() => {
    const row = findCase(ctx, caseId);
    if (row.mode === "rehearsal")
      refuse(`pilot case ${caseId} is a rehearsal case: no Kleros Court holds it`);
    if (!FILED_OR_LATER.has(row.status))
      refuse(
        `pilot case ${caseId} is at ${row.status}; only a case at filed or later is in the Court`,
      );
    const courtUrl = courtUrlOf(row);
    if (courtUrl === null)
      refuse(`pilot case ${caseId} has no Kleros dispute id, so it has no Court page`);
    const detail = `by ${by ?? "an operator"}`;
    if (!yes)
      return {
        dryRun: true,
        caseId,
        mode: row.mode,
        courtUrl,
        detail,
        next: "nothing was recorded: open the Court URL, then run the same command with --yes",
      };
    ctx.cases.recordEvent(caseId, "seen_in_court", "ok", courtUrl, detail);
    return {
      caseId,
      mode: row.mode,
      courtUrl,
      detail,
      seenInCourt: ctx.cases.countSeenInCourt(row.mode),
      note: PILOT_NOTE,
    };
  });
}

/**
 * Marks a case failed with a reason. A settled case is final. A testnet or live case at any
 * status the mode's cap counts (from filing on, and the two in-doubt exits) has a dispute that
 * exists or may exist on Kleros and goes on there whatever this row says, and failing it takes it
 * out of the cap's count, so it needs --force.
 */
function failCase(
  ctx: PilotContext,
  caseId: string,
  reason: string,
  force: boolean,
  yes: boolean,
  /** Unix seconds: the filing time a guarded row without one is given. */
  now: number,
): Record<string, unknown> {
  const row = findCase(ctx, caseId);
  if (row.status === "settled") refuse(`pilot case ${caseId} is settled, which is final`);
  if (row.status === "failed") refuse(`pilot case ${caseId} is failed already`);
  const guarded = FILED.has(row.status) && row.mode !== "rehearsal";
  if (guarded && !force)
    refuse(
      `pilot case ${caseId} is at ${row.status} in ${row.mode} mode, so its dispute exists or may exist on Kleros (${klerosIdsOf(row)}); marking the row failed changes nothing there: pass --force to mark it failed anyway`,
    );
  if (!yes)
    return {
      dryRun: true,
      caseId,
      from: row.status,
      to: "failed",
      reason,
      next: "nothing was changed: run the same command with --yes to mark the case failed",
    };
  // A funded job keeps its budget whatever the row says: no pilot command reclaims it.
  const escrow = ESCROWED.has(row.status)
    ? `${row.jobId === null ? "the job" : `job ${row.jobId}`} still holds the budget in escrow on chain until a claimRefund after its expiry at ${isoOf(row.expiredAt)}`
    : null;
  // A forced fail leaves a trace: the event says the guard was overridden and what it cost.
  const stated = escrow === null ? reason : `${reason}; ${escrow}`;
  // A failed case whose filing started keeps its slot in the cap count (`countFiled`). A guarded
  // row is filed or later, so its filing did start: a missing time is stamped with the fail.
  const detail = guarded
    ? `forced: ${stated} (the case keeps its slot in the ${row.mode} cap count)`
    : stated;
  const filingStamp = guarded && row.filingStartedAt === null ? { filingStartedAt: now } : {};
  const next = ctx.cases.transaction(() => {
    const moved = ctx.cases.advance(caseId, row.status, "failed", {
      error: reason,
      ...filingStamp,
    });
    if (!moved) refuse(`pilot case ${caseId} moved from ${row.status} while this command ran`);
    ctx.cases.recordEvent(caseId, "failed", "ok", null, detail);
    return moved;
  });
  return {
    case: next,
    ...(escrow === null ? {} : { escrow }),
    note: guarded ? `${detail}. ${PILOT_NOTE}` : PILOT_NOTE,
  };
}

/** The statuses of a funded job before any dispute: the budget sits in the job's escrow. */
const ESCROWED: ReadonlySet<PilotStatus> = new Set(["funded", "submitted", "contested"]);

/** What the row knows of its Kleros dispute, for a refusal: each id that is set. */
function klerosIdsOf(row: PilotCaseRecord): string {
  const known = [
    row.klerosChain === null ? null : `chain ${row.klerosChain}`,
    row.coreDisputeId === null ? null : `dispute ${row.coreDisputeId}`,
    row.localDisputeId === null ? null : `local dispute ${row.localDisputeId}`,
    row.createDisputeTx === null ? null : `create-dispute transaction ${row.createDisputeTx}`,
  ].filter((x) => x !== null);
  return known.length > 0 ? known.join(", ") : "no dispute id recorded yet";
}

// --- THE FILING: pilot:dispute and pilot:kleros check ---

/** How long the banner stays on screen before the first write. */
const BANNER_WAIT_MS = 1_000;
/** A legal body's standing, as the lookup words it. */
const STANDING_WORD = /^[a-z][a-z_]{0,31}$/;

interface DisputeOptions {
  case: string;
  script?: string;
  allowStanding?: string;
  testnet?: boolean;
  live?: boolean;
  yes?: boolean;
}

interface ParsedDispute {
  caseId: string;
  mode: PilotMode;
  flag: "--testnet" | "--live" | null;
  script: FakeScript | undefined;
  allowStanding: string | undefined;
  yes: boolean;
}

/** Every option of `pilot:dispute`, checked against the mode before the context opens. */
function parseDispute(opts: DisputeOptions, cfg: Config): ParsedDispute {
  const caseId = parseCaseId("--case", opts.case);
  const pilot = cfg.pilot;
  if (!pilot)
    refuse(
      "the pilot keys are not set on this box (PILOT_BUYER_PRIVATE_KEY, PILOT_SELLER_PRIVATE_KEY, PILOT_REFEREE_PRIVATE_KEY)",
    );
  const mode = pilot.mode;
  if (opts.testnet && opts.live) refuse("--testnet and --live cannot both be given");
  if (opts.live && mode !== "live")
    refuse(`--live is accepted in live mode only, and this box runs in ${mode} mode`);
  if (opts.testnet && mode !== "testnet")
    refuse(`--testnet is accepted in testnet mode only, and this box runs in ${mode} mode`);
  if (opts.script !== undefined && mode !== "rehearsal")
    refuse(`--script is accepted in rehearsal mode only, and this box runs in ${mode} mode`);
  if (opts.allowStanding !== undefined && !STANDING_WORD.test(opts.allowStanding))
    refuse("--allow-standing must be a standing as the lookup words it, for example pending");
  return {
    caseId,
    mode,
    flag: opts.testnet ? "--testnet" : opts.live ? "--live" : null,
    script: opts.script as FakeScript | undefined,
    allowStanding: opts.allowStanding,
    yes: !!opts.yes,
  };
}

/** The stage as the operator reads it: never a key, only the key's name. */
function stageView(stage: KlerosStage, script: FakeScript | undefined): Record<string, unknown> {
  return {
    mode: stage.mode,
    chain: stage.deployment?.chain ?? "fake",
    courtId: stage.deployment?.courtId ?? null,
    key: stage.mode === "rehearsal" ? null : stage.mode,
    flag: stage.flag,
    ...(stage.mode === "rehearsal" ? { script: script ?? DEFAULT_SCRIPT } : {}),
  };
}

/** What the pre-flight read, printable: the evidence in full, the clock, the escrow, the cap. */
function preflightView(pre: Extract<Preflight, { ok: true }>): Record<string, unknown> {
  const [evidenceSeconds, commitSeconds, voteSeconds, appealSeconds] = pre.court.timesPerPeriod;
  const expiredAt = Number(pre.escrow.expiredAt);
  return {
    evidence: {
      name: pre.evidence.name,
      sha256: pre.evidence.sha256,
      byteLength: pre.evidence.byteLength,
      description: pre.evidence.description,
    },
    instructions: pre.instructions,
    court: {
      courtId: pre.court.courtId,
      evidenceSeconds,
      commitSeconds,
      voteSeconds,
      appealSeconds,
      hiddenVotes: pre.court.hiddenVotes,
    },
    escrow: {
      status: pre.escrow.status,
      budgetAtomic: pre.escrow.budget.toString(),
      expiredAt,
      expiresAt: isoOf(expiredAt),
      client: pre.escrow.client,
      evaluator: pre.escrow.evaluator,
    },
    filedCount: pre.filedCount,
    cap: pre.cap,
  };
}

/** The court's juror count, when its payload carries one. */
function jurorCountOf(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  for (const field of ["jurors", "jurorCount"]) {
    const v = (raw as Record<string, unknown>)[field];
    const n = typeof v === "string" && /^[1-9][0-9]*$/.test(v) ? Number(v) : v;
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) return n;
  }
  return undefined;
}

/** The block a testnet or live filing prints before its writes. */
function bannerOf(
  stage: KlerosStage,
  pre: Extract<Preflight, { ok: true }>,
  row: PilotCaseRecord,
  policyUri: string | undefined,
): string {
  const jurors = jurorCountOf(pre.court.raw);
  return [
    `FILING A KLEROS DISPUTE IN ${stage.mode.toUpperCase()} MODE: what is sent is public and cannot be withdrawn.`,
    `  stage: ${stage.mode}`,
    `  chain: ${stage.deployment?.chain ?? "fake"}`,
    `  court id: ${stage.deployment?.courtId ?? "none"}`,
    `  juror count: ${jurors ?? "as the preset sets it"}`,
    `  key: ${stage.mode}`,
    `  policy URI: ${policyUri ?? "none configured"}`,
    `  cap: ${pre.filedCount} filed so far, of ${pre.cap ?? "no cap"}`,
    `  case: ${row.label} (${row.caseId})`,
    `  evidence: sha256 ${pre.evidence.sha256}, ${pre.evidence.byteLength} bytes (the dry run's, if nothing changed since)`,
  ].join("\n");
}

/** The next step after a filing that did not end filed. */
function nextAfter(outcome: Exclude<FileOutcome, { outcome: "filed" }>, caseId: string): string {
  if (outcome.outcome === "filing_unknown")
    return `the dispute may exist on Kleros: do not file it again; find it in the Court interface by the alias addresses and the time, then record its ids, or mark the case failed once Kleros confirms none exists (pilot:case show ${caseId} has the trail)`;
  if (outcome.code === "filing_in_progress")
    return `another command is filing this case: nothing was sent; wait for it to end, then read pilot:case show ${caseId}`;
  return "nothing was sent: fix the cause, then run the same command again; the row is contested and keeps its attachment";
}

/** What a filed case whose evidence is in doubt says, on top of its outcome. */
const EVIDENCE_IN_DOUBT =
  "the evidence item is in doubt: the dispute exists, but whether the evidence reached it is not known";

async function dispute(
  ctx: PilotContext,
  deps: PilotCommandDeps,
  stage: KlerosStage,
  p: ParsedDispute,
): Promise<Record<string, unknown>> {
  const pilot = ctx.cfg.pilot;
  if (!pilot) refuse("the pilot keys are not set on this box");
  const d: FileDisputeDeps = {
    chain: buildPilotChain(ctx),
    cases: ctx.cases,
    docStore: ctx.docStore,
    lookup: httpLookupClient(pilot.lookupBase),
    stage,
    klerosCfg: ctx.cfg.kleros,
    arcNetwork: ctx.cfg.arcNetwork === "mainnet" ? "mainnet" : "testnet",
    lookupBase: pilot.lookupBase,
    now: deps.now,
    sleep: deps.sleep,
  };
  const opts = p.allowStanding === undefined ? {} : { allowStanding: p.allowStanding };
  const view = stageView(stage, p.script);

  // A filing needs --yes and, in testnet and live, the mode's own flag; anything less is the dry run.
  if (!p.yes || (stage.flag !== null && p.flag !== stage.flag)) {
    const pre = await deps.preflightDispute(d, p.caseId, opts);
    if (!pre.ok) refuse(pre.problem);
    return {
      dryRun: true,
      caseId: p.caseId,
      stage: view,
      ...preflightView(pre),
      note: PILOT_NOTE,
      next:
        stage.flag === null
          ? "nothing was sent: run the same command with --yes to file it on the fake (a rehearsal sends nothing to Kleros)"
          : `nothing was sent: read the evidence above, then run the same command with ${stage.flag} --yes to file it with Kleros, where it is public and permanent`,
    };
  }

  // A row found at `filing` sends nothing whatever happens next (the filing reads it and answers
  // without a call), so it goes straight to the filing, which knows what that row means. With no
  // banner shown, the filing is asked to refuse the row if it has moved from `filing` since.
  const seenAtFiling = findCase(ctx, p.caseId).status === "filing";
  if (stage.flag !== null && !seenAtFiling) {
    const pre = await deps.preflightDispute(d, p.caseId, opts);
    if (!pre.ok) refuse(pre.problem);
    console.log(bannerOf(stage, pre, findCase(ctx, p.caseId), ctx.cfg.kleros?.policyUri));
    await deps.sleep(BANNER_WAIT_MS);
  }

  const outcome = await deps.fileDispute(d, p.caseId, {
    ...opts,
    confirmedFlag: p.flag,
    ...(seenAtFiling ? { onlyAtFiling: true } : {}),
  });
  const row = findCase(ctx, p.caseId);
  const base = { ...outcome, caseId: p.caseId, status: row.status, stage: view };
  if (outcome.outcome === "filed" && outcome.evidenceStatus === "unknown")
    return {
      ...base,
      courtUrl: courtUrlOf(row),
      warning: EVIDENCE_IN_DOUBT,
      case: row,
      note: PILOT_NOTE,
      next: "the evidence is in doubt: check the Court's evidence tab; do not submit again without deciding with Kleros",
    };
  if (outcome.outcome === "filed")
    return {
      ...base,
      courtUrl: courtUrlOf(row),
      case: row,
      note: PILOT_NOTE,
      next:
        stage.mode === "rehearsal"
          ? "a rehearsal: nothing was sent to Kleros, and the fake's dispute id is on the row"
          : `open the Court URL now and check the evidence item, then record it with pilot:case seen-in-court ${p.caseId} --yes`,
    };
  print({ failed: true, ...base, next: nextAfter(outcome, p.caseId), note: PILOT_NOTE });
  refuse(outcome.text);
}

function parseMode(value: string): PilotMode {
  if (!(PILOT_MODES as readonly string[]).includes(value))
    refuse("--mode must be rehearsal, testnet or live");
  return value as PilotMode;
}

interface PartyOption {
  party: string;
}

export function registerPilotCommands(
  program: Command,
  open: () => PilotContext = openPilotContext,
  overrides: Partial<PilotCommandDeps> = {},
): void {
  const deps: PilotCommandDeps = { ...defaultDeps, ...overrides };
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
    .option("--again", "register even though the party's wallet already holds an identity")
    .option("--yes", "confirm: send the transaction")
    .action(
      async (opts: PartyOption & { metadataUri?: string; again?: boolean; yes?: boolean }) => {
        const party = parseParty(opts.party);
        await withPilot(open, async (ctx) =>
          print(await register(ctx, party, opts.metadataUri ?? "", !!opts.yes, !!opts.again)),
        );
      },
    );

  agent
    .command("sign-link")
    .description(
      "sign the legal-body link message the browser flow served, with the party's key; prints the signature, sends nothing",
    )
    .requiredOption("--party <buyer|seller>", "the test agent whose wallet signs")
    .requiredOption("--typed-data <file>", "the served typed data, as JSON")
    .action(async (opts: PartyOption & { typedData: string }) => {
      const party = parseParty(opts.party);
      await withPilot(open, async (ctx) => print(await signLink(ctx, party, opts.typedData)));
    });

  agent
    .command("point")
    .description(
      `write the ${POINTER_KEY} metadata pointer on the party's identity; refused unless the party owns it`,
    )
    .requiredOption("--party <buyer|seller>", "the test agent whose wallet writes")
    .requiredOption("--agent <id>", "the agent id, in decimal")
    .requiredOption("--value <hex>", "the pointer value, as 0x hex")
    .option("--yes", "confirm: send the transaction")
    .action(async (opts: PartyOption & { agent: string; value: string; yes?: boolean }) => {
      // Options are parsed before the context opens, so a bad one never opens the database.
      const party = parseParty(opts.party);
      const agentId = parseAgentId(opts.agent);
      const value = parseValue(opts.value);
      await withPilot(open, async (ctx) =>
        print(await point(ctx, party, agentId, value, !!opts.yes)),
      );
    });

  agent
    .command("show")
    .description(
      "show the party's address, USDC balance and, with --agent, the identity's owner and the lookup answer",
    )
    .requiredOption("--party <buyer|seller>", "the test agent to show")
    .option("--agent <id>", "the agent id, in decimal")
    .action(async (opts: PartyOption & { agent?: string }) => {
      const party = parseParty(opts.party);
      const agentId = opts.agent === undefined ? undefined : parseAgentId(opts.agent);
      await withPilot(open, async (ctx) => print(await show(ctx, party, agentId)));
    });
  program
    .command("pilot:job")
    .description(
      "the pilot job between the two test agents (test data, Arc testnet): print the pre-flight; with --yes create, fund and submit it",
    )
    .requiredOption("--label <label>", "a short name for the case")
    .requiredOption("--description-file <file>", "the job's description, as UTF-8 text")
    .requiredOption("--deliverable <file>", "the seller's deliverable; its hash goes on chain")
    .option("--budget <usdc>", "the budget in USDC, at most 6 fraction digits", "2.00")
    .option("--expiry-days <n>", `days until the job expires (default ${DEFAULT_EXPIRY_DAYS})`)
    .option("--expiry-seconds <n>", "seconds until the job expires; rehearsal mode only")
    .option("--buyer-agent <id>", "the buyer's agent id (default PILOT_BUYER_AGENT_ID)")
    .option("--seller-agent <id>", "the seller's agent id (default PILOT_SELLER_AGENT_ID)")
    .option("--resume <caseId>", "continue a case left at created or funded")
    .option(
      "--fund-tx <hash>",
      "with --resume: the hash of a fund that landed when the case did not record it",
    )
    .option(
      "--submit-tx <hash>",
      "with --resume: the hash of a submit that landed when the case did not record it",
    )
    .option("--yes", "confirm: send the transactions")
    .action(async (opts: JobOptions) => {
      // Options are parsed before the context opens, so a bad one never opens the database.
      const parsed = parseJob(opts, deps.readConfig());
      await withPilot(open, async (ctx) => print(await job(ctx, deps, parsed, !!opts.yes)));
    });

  program
    .command("pilot:contest")
    .description("contest a submitted pilot case (test data): it moves to contested with the texts")
    .requiredOption("--case <caseId>", "the pilot case")
    .requiredOption(
      "--reason-file <file>",
      "the buyer's reason, as UTF-8 text (at most 4096 bytes)",
    )
    .option("--reply-file <file>", "the seller's reply, as UTF-8 text (at most 4096 bytes)")
    .option("--yes", "confirm: write the contest")
    .action(
      async (opts: { case: string; reasonFile: string; replyFile?: string; yes?: boolean }) => {
        const caseId = parseCaseId("--case", opts.case);
        const reason = readText("--reason-file", opts.reasonFile);
        const reply =
          opts.replyFile === undefined ? null : readText("--reply-file", opts.replyFile);
        await withPilot(open, async (ctx) =>
          print(await contest(ctx, deps, caseId, reason, reply, !!opts.yes)),
        );
      },
    );

  const cases = program
    .command("pilot:case")
    .description("the pilot's cases (test data): show, list, record a Court view, mark failed");

  cases
    .command("show <caseId>")
    .description("the case's row, its events and, once it has dispute ids, its Kleros Court page")
    .action(async (caseId: string) => {
      const id = parseCaseId("the case id", caseId);
      await withPilot(open, async (ctx) => print(showCase(ctx, id)));
    });

  cases
    .command("list")
    .description("every pilot case, newest first")
    .option("--mode <rehearsal|testnet|live>", "only the cases of this mode")
    .action(async (opts: { mode?: string }) => {
      const mode = opts.mode === undefined ? undefined : parseMode(opts.mode);
      await withPilot(open, async (ctx) => print(listCases(ctx, mode)));
    });

  cases
    .command("seen-in-court <caseId>")
    .description(
      "record that a person looked at a filed testnet or live case in the Kleros Court interface, the condition Kleros set before its Beta",
    )
    .option("--by <name>", "who looked")
    .option("--yes", "confirm: record it")
    .action(async (caseId: string, opts: { by?: string; yes?: boolean }) => {
      const id = parseCaseId("the case id", caseId);
      const by =
        opts.by === undefined ? undefined : checkText("--by", opts.by, { singleLine: true });
      await withPilot(open, async (ctx) => print(seenInCourt(ctx, id, by, !!opts.yes)));
    });

  cases
    .command("fail <caseId>")
    .description(
      "mark a case failed, with the reason; every testnet or live case the mode's cap counts needs --force",
    )
    .requiredOption("--reason <text>", "why the case failed")
    .option("--force", "mark a case failed although its dispute exists on Kleros")
    .option("--yes", "confirm: mark it failed")
    .action(async (caseId: string, opts: { reason: string; force?: boolean; yes?: boolean }) => {
      const id = parseCaseId("the case id", caseId);
      const reason = checkText("--reason", opts.reason);
      await withPilot(open, async (ctx) =>
        print(failCase(ctx, id, reason, !!opts.force, !!opts.yes, deps.now())),
      );
    });

  program
    .command("pilot:dispute")
    .description(
      "file a contested pilot case with Kleros (test data): print the pre-flight; with --yes (and --testnet or --live in those modes) pin the delivered file, create the dispute and submit the evidence, once",
    )
    .requiredOption("--case <caseId>", "the contested pilot case")
    .option(
      "--script <script>",
      `the fake's script; rehearsal mode only (default ${DEFAULT_SCRIPT})`,
    )
    .option(
      "--allow-standing <standing>",
      "accept a legal body of this standing; the evidence says so",
    )
    .option("--testnet", "confirm a filing on the Kleros testnet court; testnet mode only")
    .option("--live", "confirm a filing on the Kleros live court; live mode only")
    .option("--yes", "confirm: file")
    .action(async (opts: DisputeOptions) => {
      // Options are checked and the stage built before the context opens, so a refused option
      // never opens the database.
      const cfg = deps.readConfig();
      const parsed = parseDispute(opts, cfg);
      const stage = deps.buildStage(
        cfg,
        parsed.mode === "rehearsal" ? { script: parsed.script ?? DEFAULT_SCRIPT } : {},
      );
      await withPilot(open, async (ctx) => print(await dispute(ctx, deps, stage, parsed)));
    });

  program
    .command("pilot:kleros")
    .description("the Kleros Dispute Service the mode selects")
    .command("check")
    .description(
      "read the key's tools, its instructions and the court's clock, and name every problem; sends nothing",
    )
    .option(
      "--real-reads <testnet|live>",
      "rehearsal mode only: read that deployment with its key, writes disabled",
    )
    .action(async (opts: { realReads?: string }) => {
      const cfg = deps.readConfig();
      const mode = cfg.pilot?.mode;
      if (!mode) refuse("the pilot keys are not set on this box");
      let realReads: "testnet" | "live" | undefined;
      if (opts.realReads !== undefined) {
        if (opts.realReads !== "testnet" && opts.realReads !== "live")
          refuse("--real-reads must be testnet or live");
        if (mode !== "rehearsal")
          refuse(
            `--real-reads is accepted in rehearsal mode only, and this box runs in ${mode} mode`,
          );
        realReads = opts.realReads;
      }
      const stage = deps.buildStage(cfg, realReads === undefined ? {} : { realReads });
      const result = await deps.checkKleros(stage);
      print({ mode, ...result });
      if (result.problems.length > 0)
        refuse(
          `the Kleros check found ${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}: ${result.problems.join("; ")}`,
        );
    });
}
