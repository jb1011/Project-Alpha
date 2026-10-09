import {
  http,
  type Address,
  type Hex,
  type Log,
  type PrivateKeyAccount,
  type PublicClient,
  type WalletClient,
  createWalletClient,
  encodeAbiParameters,
  isAddressEqual,
  parseEventLogs,
  toHex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { expect } from "vitest";
import {
  iIdentityRegistryAbi,
  legalManagerAbi,
  mockIdentityRegistryAbi,
} from "../../src/abis/generated";
import { signSession } from "../../src/auth/session";
import { anvilChain } from "../../src/chains";
import {
  type CustomerCompanyDeps,
  createCustomerCompany,
  prepareCustomerStatement,
} from "../../src/legalBody/customerCompany";
import { buildStatementMessage, statementTypedDataWire } from "../../src/legalBody/statement";
import type {
  CompanyCheck,
  CompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import type { SqliteWorldStore } from "../../src/persistence/worldStore";
import { addDays, wyomingDate } from "../../src/util/wyomingCalendar";
import { recordHuman } from "./customerCompanyFixtures";
import { type Json, type RequestTarget, answerOf, call } from "./legalBodyFixtures";
import type { LegalBodyStack } from "./legalBodyStack";

/**
 * A LINKED LEGAL BODY ON A LOCAL CHAIN, made through the real doors: a guardian who is a verified
 * human, with a customer company declared through the company functions and checked as the
 * operator records a passed check; an identity owned by a key; an order, the owner's signed link,
 * the body created by the executor through the controller, the owner's pointer, and one sweeper
 * tick that sees the binding linked.
 *
 * The legal-body flow's own integration file keeps these steps to itself; they are copied here,
 * with the facts of the guardian's check made a parameter, so a file about what happens after the
 * link can start from a linked body.
 *
 * Every key is derived from anvil's published test mnemonic, never a real wallet, and every name
 * and filing number is an invention.
 */

/** anvil's published test mnemonic: every key here is derived from it. */
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/**
 * The key at `addressIndex` of the test mnemonic, as an in-process private key. anvil funds the
 * first ten; any other starts with nothing.
 */
export function keyAt(addressIndex: number): PrivateKeyAccount {
  const { privateKey } = mnemonicToAccount(TEST_MNEMONIC, { addressIndex }).getHdKey();
  if (!privateKey) throw new Error(`no private key at index ${addressIndex}`);
  return privateKeyToAccount(toHex(privateKey));
}

export const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
/** The name every guardian here declares for its company. */
export const COMPANY_NAME = "Example Holdings LLC";
/** The identity-metadata key the factory reads the pointer under, and the pointer's version. */
const POINTER_KEY = "legalBody";
const POINTER_VERSION = 1n;
const ORDERS = "/legal-body-orders";
/** A wallet change's deadline, after the latest block: the identity registry takes at most 300
 *  seconds. */
const WALLET_SET_DEADLINE_SECONDS = 120n;

/** What the harness reads and writes: the chain, and the deployment of the case. */
export interface LinkedHarness {
  /** The node the keys here send their transactions to. */
  rpcUrl: string;
  pub: PublicClient;
  stack: LegalBodyStack;
  /** The API app, with its order doors. */
  app: RequestTarget;
  /** One pass of the deployment's legal-body sweeper. */
  tick: () => Promise<void>;
  checks: CompanyCheckRepository;
  store: SqliteWorldStore;
  customerDeps: CustomerCompanyDeps;
  /** The clock the app, the sweeper and the chain adapter share, in milliseconds. */
  now: () => number;
}

export interface Guardian {
  account: PrivateKeyAccount;
  address: Address;
  /** A session for the order doors. */
  token: string;
  companyId: string;
  /** The filing number its company was declared with. */
  filingNumber: string;
}

/** What a passed check records about the company's filings. Each fact is left out unless given;
 *  the formation date defaults to 30 days before the shared clock. */
export interface CheckedFilings {
  formationDate?: string;
  lastReportPeriod?: number;
  lastReportFiledOn?: string;
}

export function walletOf(rpcUrl: string, account: PrivateKeyAccount): WalletClient {
  return createWalletClient({ account, chain: anvilChain, transport: http(rpcUrl) });
}

/** Wait for a transaction and refuse a revert, so a failed setup step cannot pass for anything. */
export async function mined(pub: PublicClient, hash: Hex) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`setup transaction ${hash} reverted`);
  return receipt;
}

/** The Wyoming date `days` days before the shared clock's: a formation date `days` days back. */
export function formationDaysAgo(h: Pick<LinkedHarness, "now">, days: number): string {
  return addDays(wyomingDate(Math.floor(h.now() / 1_000)), -days);
}

/**
 * A passed check of the company, as `company:check --result passed` records one, made now on the
 * shared clock. The registry showed the declared name and filing number, an active company and
 * its formation date: 30 days back unless told otherwise, so no annual report is due for about
 * eleven months. A last annual report is recorded only when given.
 */
export function recordPassedCheck(
  h: Pick<LinkedHarness, "checks" | "now">,
  companyId: string,
  filingNumber: string,
  filings: CheckedFilings = {},
): CompanyCheck {
  return h.checks.append({
    companyId,
    result: "passed",
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: Math.floor(h.now() / 1_000),
    registryName: COMPANY_NAME,
    registryFilingId: filingNumber,
    registryStatus: "Active",
    formationDate: filings.formationDate ?? formationDaysAgo(h, 30),
    registeredAgent: "Example Registered Agent LLC",
    existenceEvidenceSha256: `0x${"e1".repeat(32)}`,
    controlEvidenceSha256: `0x${"c1".repeat(32)}`,
    controlEvidenceKind: "ein_letter",
    reasonCode: null,
    reason: null,
    lastReportPeriod: filings.lastReportPeriod ?? null,
    lastReportFiledOn: filings.lastReportFiledOn ?? null,
  });
}

/**
 * A guardian of its own: the key at `index`, a verified human in the World store, and a customer
 * company declared through the company functions with the guardian's signed statement, then
 * checked as the operator records a passed check with `filings`.
 */
export async function newGuardian(
  h: LinkedHarness,
  index: number,
  filings: CheckedFilings = {},
): Promise<Guardian> {
  const account = keyAt(index);
  recordHuman(h.store, account.address, String(5_000 + index), h.now());

  const cc = h.customerDeps;
  const filingNumber = `TEST-${String(index).padStart(4, "0")}`;
  const declared = { companyName: COMPANY_NAME, filingNumber, synthetic: true };
  const { fields } = prepareCustomerStatement(cc, account.address, declared);
  const issuedAt = BigInt(Math.floor(h.now() / 1_000));
  const statement = statementTypedDataWire(
    cc.chainId,
    cc.factory,
    buildStatementMessage(fields, cc.text, issuedAt),
  );
  const signature = await account.signTypedData(JSON.parse(JSON.stringify(statement)));
  const { companyId, created } = await createCustomerCompany(cc, account.address, {
    ...declared,
    issuedAt: issuedAt.toString(),
    signature,
  });
  expect(created).toBe(true);
  recordPassedCheck(h, companyId, filingNumber, filings);

  const { token } = await signSession(
    account.address,
    JWT_SECRET,
    3_600,
    Math.floor(Date.now() / 1_000),
  );
  return { account, address: account.address, token, companyId, filingNumber };
}

/** The identity id the registry minted in this receipt. */
function mintedId(stack: LegalBodyStack, logs: Log[]): bigint {
  const minted = parseEventLogs({ abi: mockIdentityRegistryAbi, eventName: "Transfer", logs }).find(
    (l) => isAddressEqual(l.address, stack.registry),
  );
  if (!minted) throw new Error("the registry minted no identity");
  return minted.args.tokenId;
}

/** A new identity owned by `owner`'s key. The test registry binds the owner as its wallet. */
export async function identityOfKey(h: LinkedHarness, owner: PrivateKeyAccount): Promise<bigint> {
  const hash = await walletOf(h.rpcUrl, owner).writeContract({
    address: h.stack.registry,
    abi: iIdentityRegistryAbi,
    functionName: "register",
    args: ["ipfs://legal-body-statement"],
    account: owner,
    chain: anvilChain,
  });
  return mintedId(h.stack, (await mined(h.pub, hash)).logs);
}

/**
 * The pointer bytes, encoded from the intent the binding door serves, as the owner's wallet encodes
 * them: the pointer's version, the chain id and the body, one 32-byte word each.
 */
export function pointerFrom(intent: Json): Hex {
  expect(intent).toMatchObject({ action: "setLegalBodyPointer", chainId: anvilChain.id });
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "address" }],
    [POINTER_VERSION, BigInt(intent.chainId), intent.body],
  );
}

/** The owner writes `pointer` in its identity's metadata; `0x` clears it. */
export async function setPointer(
  h: LinkedHarness,
  owner: PrivateKeyAccount,
  agentId: bigint,
  pointer: Hex,
): Promise<void> {
  await mined(
    h.pub,
    await walletOf(h.rpcUrl, owner).writeContract({
      address: h.stack.registry,
      abi: iIdentityRegistryAbi,
      functionName: "setMetadata",
      args: [agentId, POINTER_KEY, pointer],
      account: owner,
      chain: anvilChain,
    }),
  );
}

/**
 * The owner binds `newWallet` as its identity's wallet. The test registry wants the new wallet's
 * signature over the RAW digest it computes (`walletSetDigest`), with a deadline it accepts: two
 * minutes after the latest block.
 */
export async function setAgentWallet(
  h: LinkedHarness,
  owner: PrivateKeyAccount,
  agentId: bigint,
  newWallet: PrivateKeyAccount,
): Promise<void> {
  const { timestamp } = await h.pub.getBlock({ blockTag: "latest" });
  const deadline = timestamp + WALLET_SET_DEADLINE_SECONDS;
  const digest = await h.pub.readContract({
    address: h.stack.registry,
    abi: mockIdentityRegistryAbi,
    functionName: "walletSetDigest",
    args: [agentId, newWallet.address, owner.address, deadline],
  });
  await mined(
    h.pub,
    await walletOf(h.rpcUrl, owner).writeContract({
      address: h.stack.registry,
      abi: iIdentityRegistryAbi,
      functionName: "setAgentWallet",
      args: [agentId, newWallet.address, deadline, await newWallet.sign({ hash: digest })],
      account: owner,
      chain: anvilChain,
    }),
  );
}

/** The owner transfers its identity to `to`. */
export async function transferIdentity(
  h: LinkedHarness,
  owner: PrivateKeyAccount,
  to: Address,
  agentId: bigint,
): Promise<void> {
  await mined(
    h.pub,
    await walletOf(h.rpcUrl, owner).writeContract({
      address: h.stack.registry,
      abi: iIdentityRegistryAbi,
      functionName: "transferFrom",
      args: [owner.address, to, agentId],
      account: owner,
      chain: anvilChain,
    }),
  );
}

/** The guardian calls one of its body's dissolution functions. A guardian key starts with no
 *  gas: fund it first. */
export async function asGuardian(
  h: LinkedHarness,
  g: Guardian,
  body: Address,
  functionName: "initiateDissolution" | "finalizeDissolution",
): Promise<void> {
  await mined(
    h.pub,
    await walletOf(h.rpcUrl, g.account).writeContract({
      address: body,
      abi: legalManagerAbi,
      functionName,
      account: g.account,
      chain: anvilChain,
    }),
  );
}

/** One request of the guardian to an order door. */
async function door(
  h: LinkedHarness,
  method: "GET" | "POST",
  path: string,
  g: Guardian,
  body?: object,
) {
  return answerOf(await call(h.app, method, path, g.token, body));
}

/**
 * A new order of `g`, linked for `agentId` by `owner`'s signature of the served message as it
 * arrives: the link door answers it `deployed`.
 */
export async function deployedOrder(
  h: LinkedHarness,
  g: Guardian,
  owner: PrivateKeyAccount,
  agentId: bigint,
  ttlSeconds = 3_600,
): Promise<{ id: string; body: Address }> {
  const ordered = await door(h, "POST", ORDERS, g, { companyId: g.companyId });
  expect(ordered.status).toBe(201);
  const id: string = ordered.body.id;
  const served = await door(h, "POST", `${ORDERS}/${id}/link-message`, g, {
    agentId: agentId.toString(),
    ttlSeconds,
  });
  expect(served.status).toBe(200);
  const { typedData } = served.body;
  const linked = await door(h, "POST", `${ORDERS}/${id}/link`, g, {
    message: typedData.message,
    signature: await owner.signTypedData(typedData),
  });
  expect(linked.status).toBe(200);
  expect(linked.body).toMatchObject({ id, state: "deployed", agentId: agentId.toString() });
  return { id, body: linked.body.bodyAddress };
}

/** A deployed order whose owner then points the identity at its body, as the binding door's
 *  intent describes; the sweeper's next tick sees it linked. */
export async function linkedOrder(
  h: LinkedHarness,
  g: Guardian,
  owner: PrivateKeyAccount,
  agentId: bigint,
): Promise<{ id: string; body: Address }> {
  const made = await deployedOrder(h, g, owner, agentId);
  const binding = await door(h, "GET", `${ORDERS}/${made.id}/binding`, g);
  expect(binding.status).toBe(200);
  await setPointer(h, owner, agentId, pointerFrom(binding.body.intent));
  await h.tick();
  const after = await door(h, "GET", `${ORDERS}/${made.id}/binding`, g);
  expect(after.body).toMatchObject({ state: "linked", bodyAddress: made.body, intent: null });
  return made;
}
