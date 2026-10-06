/**
 * THE LEGAL-BODY FLOW ON A LOCAL CHAIN: an order becomes a body its identity points at.
 *
 * The real API app with its order, link, binding and gas-seed doors and its MCP endpoint, the real
 * repository over a database file, the real sweeper, and the real chain adapter over anvil, where
 * the real NoviController relays each create to the real LegalBodyFactory. The identity registry
 * is the mock registry the factory reads; a contract owner is one of the two mock wallets. The
 * guardian's human verification is seeded in the World store, and its company is declared through
 * the customer company functions and checked as the operator records a check.
 *
 * One chain for the file. One database, one document store, one app and one sweeper per case, so
 * a sweeper tick works the rows of its own case only. Each case:
 *  - mines a block first: the chain adapter does not believe a head more than 120 seconds old;
 *  - has its own guardian: a verified human with its own checked company;
 *  - signs the links for one identity with different lifetimes, so no two of them share a digest.
 * The doors, the sweeper and the chain adapter read one clock. A case that needs a second pass
 * over a row moves that clock past the row's next check, and moves the chain's clock with it. The
 * cases that move the chain's clock by hours or days run after the cases that do not.
 *
 * The first `describe` is the path; the second is the path an agent takes through the MCP
 * endpoint's tools, and the gas seed an owner that holds nothing pays for its pointer with; the
 * third is what the path survives: a lost response, a restart, a transfer of the identity, a gap in
 * the platform key's nonces, and the payment quote that waits for a linked body. The path's last
 * case, which moves the clocks by days, comes after all three. Every answer a door or a tool gives
 * in the file is checked as it arrives: no bigint, no node URL and no text of a thrown error.
 *
 * The app's throttles never refuse here; the caps are the deployment's defaults. Its formation
 * block and payment config are wired as a deployment that does not charge wires them, except in
 * the one case about the payment quote, which runs on a deployment that charges. Its gas seed is
 * off, as a deployment's is by default, except in the one case about the seed, which runs on a
 * deployment that sets one.
 *
 * Every key is derived from anvil's published test mnemonic, never a real wallet, and every name
 * and filing number is an invention.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  http,
  type Address,
  type Hex,
  type Log,
  type PrivateKeyAccount,
  type PublicClient,
  type TestClient,
  type WalletClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseEther,
  parseEventLogs,
  stringToBytes,
  toHex,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  iIdentityRegistryAbi,
  legalBodyFactoryAbi,
  legalManagerAbi,
  mockIdentityRegistryAbi,
} from "../../src/abis/generated";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { LegalBodyChain } from "../../src/adapters/arc/legalBodyChain";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { anvilChain } from "../../src/chains";
import {
  DEFAULT_LEGAL_BODY_SWEEP_INTERVAL_MS,
  LEGAL_BODY_FLOW_DEFAULTS,
} from "../../src/config/env";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { checkLink } from "../../src/legalBody/checkLink";
import {
  type CustomerCompanyDeps,
  createCustomerCompany,
  expireStaleCustomerCompanies,
  prepareCustomerStatement,
} from "../../src/legalBody/customerCompany";
import { expireEvidenceBytes } from "../../src/legalBody/evidence";
import { type GasSeedDeps, SEED_TRANSFER_GAS_LIMIT } from "../../src/legalBody/gasSeed";
import { linkFromWire } from "../../src/legalBody/link";
import type { LegalBodyOrderDeps } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { buildStatementMessage, statementTypedDataWire } from "../../src/legalBody/statement";
import {
  HOUSEKEEPING_BATCH,
  LEGAL_BODY_SWEEP_MAX_PER_TICK,
  LegalBodySweeper,
} from "../../src/legalBody/sweeper";
import { buildOutflowMeter } from "../../src/payments/outflowMeter";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteLegalBodyRepository } from "../../src/persistence/legalBodyRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import {
  FORMATION_PROVIDER,
  recordHuman,
  sandboxCustomerCompanyDeps,
  worldFor,
} from "../helpers/customerCompanyFixtures";
import { fakeChain, paymentCfg } from "../helpers/formationPayment";
import { type Json, answerOf, call } from "../helpers/legalBodyFixtures";
import {
  type LegalBodyStack,
  deployContract,
  deployLegalBodyStack,
} from "../helpers/legalBodyStack";
import { startMcpTestClient } from "../mcp/helpers";

/** This file's own port: 8545 to 8553 belong to the other anvil-based files. */
const PORT = 8554;

/** anvil's published test mnemonic: every key below is derived from it. */
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
/**
 * The key at `addressIndex` of the test mnemonic, as an in-process private key: the platform's
 * send path signs only with one of those.
 */
function keyAt(addressIndex: number): PrivateKeyAccount {
  const { privateKey } = mnemonicToAccount(TEST_MNEMONIC, { addressIndex }).getHdKey();
  if (!privateKey) throw new Error(`no private key at index ${addressIndex}`);
  return privateKeyToAccount(toHex(privateKey));
}

/** Signs and pays for every create: the backend's platform key. */
const executor = keyAt(0);
/** The controller's role administrator. */
const admin = keyAt(1);
/** The identities' owner, and the signer of both contract wallets. */
const owner = keyAt(2);
/** A key that owns nothing here. */
const stranger = keyAt(3);
/** Deploys the contracts, so the executor's nonce moves only for creates. */
const deployer = keyAt(4);
/** The identity's next owner, once the owner transfers it. */
const buyer = keyAt(5);
/** Each case's guardians take the next keys from here on. */
const FIRST_GUARDIAN_INDEX = 10;
/** An identity's owner that starts with nothing: anvil funds only the first ten keys, and no
 *  guardian reaches this one. */
const freshOwner = keyAt(1_000);

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const COMPANY_NAME = "Example Holdings LLC";
/** The identity-metadata key the factory reads the pointer under, and the pointer's version. */
const POINTER_KEY = "legalBody";
const POINTER_VERSION = 1n;
/** A day, in the chain's unit. */
const DAY_SECONDS = 24 * 3_600;

const ORDERS = "/legal-body-orders";
const orderPath = (id: string) => `${ORDERS}/${id}`;
const gasSeedPath = (id: string) => `${orderPath(id)}/gas-seed`;
const requotePath = (companyId: string) => `/companies/${companyId}/payment/requote`;

/** The gas seed of the one case that sets one: the largest a deployment may set, in USDC. */
const SEED_USDC = "0.05";
/** The same amount in the native unit's 18 decimals, as the seed's door sends it. */
const SEED_WEI = parseEther(SEED_USDC);
/** …and in 6-decimal USDC, as the platform's outflow meter counts it. */
const SEED_MICRO_USDC = 50_000;
/** The platform's outflow ceiling and window, a deployment's defaults: 200 USDC, in 6-decimal
 *  units, over 24 hours. */
const OUTFLOW_CEILING_ATOMIC = 200_000_000n;
const OUTFLOW_WINDOW_MS = 24 * 3_600_000;

/** A customer company's fee, in atomic units, on the deployment that charges: a placeholder. */
const CUSTOMER_FEE = 7_000_000n;
/** The payment door's refusal of a customer company with no linked legal body. */
const NOT_LINKED = "this company has no linked legal body yet";

const contractWalletAbi = parseAbi([
  "function execute(address target, bytes data) returns (bytes)",
]);
const policyWalletAbi = parseAbi(["function approve(bytes32 digest)"]);

let anvil: AnvilHandle | undefined;
let pub: PublicClient;
/** anvil's own controls: mine a block, move the chain's clock, set a balance. */
let node: TestClient;
let stack: LegalBodyStack;
/** The platform's adapter: every create, and the gas seed's native send, from the executor. */
let arc: ArcAdapter;
let lb: LegalBodyChain;

/**
 * The one clock of the doors, the sweeper and the chain adapter: the wall clock, moved forward
 * only together with the chain's (`moveTime`).
 */
let clockOffsetMs = 0;
const now = () => Date.now() + clockOffsetMs;

/**
 * The node the chain adapter reads, a transport in front of anvil. While `throttle.on` is set it
 * answers every request with HTTP 429, as a provider over its rate limit does, and counts them.
 */
const throttle = { on: false, answered: 0 };

function walletOf(account: PrivateKeyAccount): WalletClient {
  if (!anvil) throw new Error("anvil is not running");
  return createWalletClient({ account, chain: anvilChain, transport: http(anvil.rpcUrl) });
}

beforeAll(async () => {
  anvil = await startAnvil(PORT);
  const rpcUrl = anvil.rpcUrl;
  pub = createPublicClient({
    chain: anvilChain,
    transport: http(rpcUrl, {
      retryCount: 0,
      fetchFn: async (input, init) => {
        if (!throttle.on) return fetch(input, init);
        throttle.answered++;
        return new Response("Too Many Requests", { status: 429 });
      },
    }),
  });
  node = createTestClient({ chain: anvilChain, mode: "anvil", transport: http(rpcUrl) });
  stack = await deployLegalBodyStack({
    deployer: walletOf(deployer),
    admin: walletOf(admin),
    pub,
    executor: executor.address,
  });
  arc = new ArcAdapter({
    publicClient: pub,
    managerWallet: walletOf(executor),
    sendClient: pub,
    chainId: anvilChain.id,
    // The entity factory, a placeholder: the legal-body path never calls it.
    factory: "0x00000000000000000000000000000000000000f1",
    identityRegistry: stack.registry,
    controller: stack.controller,
  });
  lb = new LegalBodyChain({
    publicClient: pub,
    arc,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
    maxHeadAgeSeconds: 120,
    now,
  });
}, 60_000);

afterAll(() => anvil?.stop());

// ── One deployment per case ───────────────────────────────────────────────────────────────────

/** What one case runs on: its stores, the doors' dependencies, the app and the sweeper. */
interface Deployment {
  db: Database.Database;
  checks: SqliteCompanyCheckRepository;
  store: SqliteWorldStore;
  legalBodies: SqliteLegalBodyRepository;
  payments: SqliteFormationPaymentRepository;
  customerDeps: CustomerCompanyDeps;
  app: ReturnType<typeof buildApiApp>;
  sweeper: LegalBodySweeper;
}

let dir: string;
let d: Deployment;
/** Every console line written in the case: the ops lines among them. */
let printed: string[];
let nextGuardian = FIRST_GUARDIAN_INDEX;

/** A throttle that always has a token: the caps under test are the deployment's own. */
const open = () => ({ take: () => true });

/**
 * The deployment as the composition root wires it where the legal-body feature is on, over this
 * case's database and document store, on the shared clock. With `charging`, it charges for a
 * customer company: the company waits as a draft for its payment, and the payment doors quote it.
 * Nothing in this file settles a payment, so the settlement's executor is the fake chain of the
 * payment fixture, and no payment ever reaches anvil.
 *
 * Its gas seed is off unless `gasSeedUsdc` sets one, and its deps are built as the composition root
 * builds them: the amount in wei, the owner's code and balance read through the public client, and
 * the transfer's gas estimated through it from the platform key's address, the platform's outflow
 * meter over this database, asked before a seed and fed after it on the `gas_seed` path, and the
 * adapter's native send from the platform key, with the gas limit the seed gives it.
 */
function deploy(opts: { charging?: boolean; gasSeedUsdc?: string } = {}): Deployment {
  const charging = opts.charging === true;
  const db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  const companies = new SqliteCompanyRepository(db);
  const declarations = new SqliteCompanyDeclarationRepository(db);
  const checks = new SqliteCompanyCheckRepository(db);
  const documents = new SqliteDocumentIndexRepository(db);
  const docStore = new FileDocumentStore(join(dir, "documents"));
  const store = new SqliteWorldStore(db);
  const legalBodies = new SqliteLegalBodyRepository(db);
  const payments = new SqliteFormationPaymentRepository(db);
  const requests = new SqliteFormationRepository(db);
  const parties = new SqliteFormationPartyRepository(db);
  const world = worldFor(store);
  const deployment = { chainId: anvilChain.id, factory: stack.factory };

  const orderDeps: LegalBodyOrderDeps = {
    repo: legalBodies,
    companies,
    declarations,
    checks,
    world,
    chain: lb,
    docStore,
    deployment,
    identityRegistry: stack.registry,
    // The agreement's wording is a draft, which only a sandbox serves.
    environment: "sandbox",
    ...LEGAL_BODY_FLOW_DEFAULTS,
    doorBudget: open(),
    tenantBucket: open,
    identityBucket: open,
    transaction: (fn) => legalBodies.transaction(fn),
    now,
    // The door's reads of a create's receipt follow each other at once: a 202 costs no real time.
    sleep: async () => {},
  };
  const outflows = buildOutflowMeter(db, {
    ceilingAtomic: OUTFLOW_CEILING_ATOMIC,
    windowMs: OUTFLOW_WINDOW_MS,
    now,
  });
  const gasSeed: GasSeedDeps = {
    orders: orderDeps,
    amountWei: parseEther(opts.gasSeedUsdc ?? "0"),
    readCode: (address) => pub.getCode({ address }),
    readBalance: (address) => pub.getBalance({ address }),
    estimateTransferGas: (to, value) => pub.estimateGas({ account: executor.address, to, value }),
    checkOutflow: (valueAtomic) => outflows.check(valueAtomic),
    sendNative: (to, value, gas) => arc.sendNativeAsPlatform(to, value, gas),
    recordOutflow: (valueAtomic, hash) => outflows.record("gas_seed", valueAtomic, hash),
  };
  const customerDeps = sandboxCustomerCompanyDeps(
    { db, companies, declarations, checks, store },
    now,
    {
      chainId: anvilChain.id,
      factory: stack.factory,
      paymentRequired: charging,
      world,
    },
  );
  const payment = charging
    ? paymentCfg(payments, { byoFeeAtomic: CUSTOMER_FEE })
    : paymentCfg(payments, { required: false });
  const pin = { provider: FORMATION_PROVIDER, environment: "sandbox" } as const;
  const formationLimits = { sandboxSyntheticPii: false, maxPerTenant: 3, dailyCeiling: 10 };
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: anvilChain.id,
    identityRegistry: stack.registry,
    repo: new SqliteEntityRepository(db),
    companies,
    documents,
    docStore,
    formationSteps: (id: string) => requests.stepsOf(id),
    customerFacts: {
      declarations,
      checks,
      hasLinkedLegalBody: (companyId: string) => legalBodies.hasLinkedForCompany(companyId),
    },
    customerCompanies: { ...customerDeps, documents, docStore },
    legalBodyOrders: orderDeps,
    legalBodyGasSeed: gasSeed,
    formation: {
      environment: pin.environment,
      required: true,
      ...formationLimits,
      maxAgentsPerCompany: 10,
      parties,
      requests,
      companies,
      pin,
      companyDeps: { companies, parties, requests, pin, ...formationLimits, payment },
      payment,
      feeUsdc: payment.feeUsdc,
      paymentExecutor: charging ? fakeChain().executor : undefined,
    },
    apiKeys: new SqliteApiKeyStore(db),
    passkeys: new SqlitePasskeyStore(db),
    jobs: new SqliteJobRepository(db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  const sweeper = new LegalBodySweeper({
    ...orderDeps,
    intervalMs: DEFAULT_LEGAL_BODY_SWEEP_INTERVAL_MS,
    maxPerTick: LEGAL_BODY_SWEEP_MAX_PER_TICK,
    housekeeping: {
      expireEvidence: () => expireEvidenceBytes({ documents, docStore, now }, HOUSEKEEPING_BATCH),
      expireStaleCompanies: () =>
        expireStaleCustomerCompanies(
          {
            companies,
            declarations,
            checks,
            hasOpenLegalBody: (companyId: string) =>
              legalBodies.hasOpenForCompany(companyId, now()),
            transaction: (fn) => legalBodies.transaction(fn),
            now,
          },
          HOUSEKEEPING_BATCH,
        ),
    },
  });
  return {
    db,
    checks,
    store,
    legalBodies,
    payments,
    customerDeps,
    app: buildApiApp(deps as ApiDeps),
    sweeper,
  };
}

/**
 * The case's deployment built again over the same database file and document store, as a process
 * that restarts opens them, with a new app and a new sweeper. The old database handle is closed
 * first, and the sender's nonce floors are forgotten, as a new process starts without them.
 */
function redeploy(opts: { charging?: boolean; gasSeedUsdc?: string } = {}): void {
  d.db.close();
  resetSenderNonces();
  d = deploy(opts);
}

beforeEach(async () => {
  // A head more than 120 seconds old is not believed: every case starts on a fresh block.
  await node.mine({ blocks: 1 });
  dir = mkdtempSync(join(tmpdir(), "legal-body-flow-"));
  d = deploy();
  printed = [];
  for (const method of ["log", "info", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  d.db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── The guardian and its company ──────────────────────────────────────────────────────────────

interface Guardian {
  account: PrivateKeyAccount;
  address: Address;
  token: string;
  companyId: string;
}

/**
 * A guardian of its own: the next key, a verified human in the World store, and a customer
 * company declared through the company functions with the guardian's signed statement and then
 * checked, as the operator records a passed check.
 */
async function newGuardian(): Promise<Guardian> {
  const n = nextGuardian++;
  const account = keyAt(n);
  recordHuman(d.store, account.address, String(5_000 + n), now());

  const cc = d.customerDeps;
  const declared = {
    companyName: COMPANY_NAME,
    filingNumber: `TEST-${String(n).padStart(4, "0")}`,
    synthetic: true,
  };
  const { fields } = prepareCustomerStatement(cc, account.address, declared);
  const issuedAt = BigInt(Math.floor(now() / 1_000));
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
  d.checks.append({
    companyId,
    result: "passed",
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt: Math.floor(now() / 1_000),
    registryName: COMPANY_NAME,
    registryFilingId: declared.filingNumber,
    registryStatus: "Active",
    formationDate: "2020-01-15",
    registeredAgent: "Example Registered Agent LLC",
    existenceEvidenceSha256: `0x${"e1".repeat(32)}`,
    controlEvidenceSha256: `0x${"c1".repeat(32)}`,
    controlEvidenceKind: "ein_letter",
    reasonCode: null,
    reason: null,
  });

  const { token } = await signSession(
    account.address,
    JWT_SECRET,
    3_600,
    Math.floor(Date.now() / 1_000),
  );
  return { account, address: account.address, token, companyId };
}

// ── The chain, as the identity's owner and the guardian use it ────────────────────────────────

/** Wait for a transaction and refuse a revert, so a failed setup step cannot pass for anything. */
async function mined(hash: Hex) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`setup transaction ${hash} reverted`);
  return receipt;
}

/** The identity id the registry minted in this receipt. */
function mintedId(logs: Log[]): bigint {
  const minted = parseEventLogs({ abi: mockIdentityRegistryAbi, eventName: "Transfer", logs }).find(
    (l) => isAddressEqual(l.address, stack.registry),
  );
  if (!minted) throw new Error("the registry minted no identity");
  return minted.args.tokenId;
}

/** An identity owned by the owner's key. */
async function identityOfKey(): Promise<bigint> {
  const hash = await walletOf(owner).writeContract({
    address: stack.registry,
    abi: iIdentityRegistryAbi,
    functionName: "register",
    args: ["ipfs://legal-body-flow"],
    account: owner,
    chain: anvilChain,
  });
  return mintedId((await mined(hash)).logs);
}

/** An identity owned by the contract wallet `wallet`, registered through its signer. */
async function identityOfWallet(wallet: Address): Promise<bigint> {
  const hash = await walletOf(owner).writeContract({
    address: wallet,
    abi: contractWalletAbi,
    functionName: "execute",
    args: [
      stack.registry,
      encodeFunctionData({
        abi: iIdentityRegistryAbi,
        functionName: "register",
        args: ["ipfs://legal-body-flow"],
      }),
    ],
    account: owner,
    chain: anvilChain,
  });
  return mintedId((await mined(hash)).logs);
}

/**
 * The pointer bytes, encoded here from the intent the binding door serves, as the owner's wallet
 * encodes them: the pointer's version, the chain id and the body, one 32-byte word each.
 */
function pointerFrom(intent: Json): Hex {
  expect(intent).toMatchObject({ action: "setLegalBodyPointer", chainId: anvilChain.id });
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "address" }],
    [POINTER_VERSION, BigInt(intent.chainId), intent.body],
  );
}

/** The owner writes `pointer` in its identity's metadata; `0x` clears it. */
async function setPointer(agentId: bigint, pointer: Hex): Promise<void> {
  await mined(
    await walletOf(owner).writeContract({
      address: stack.registry,
      abi: iIdentityRegistryAbi,
      functionName: "setMetadata",
      args: [agentId, POINTER_KEY, pointer],
      account: owner,
      chain: anvilChain,
    }),
  );
}

/** The guardian calls one of its body's dissolution functions. */
async function asGuardian(
  g: Guardian,
  body: Address,
  functionName: "initiateDissolution" | "finalizeDissolution",
): Promise<void> {
  await mined(
    await walletOf(g.account).writeContract({
      address: body,
      abi: legalManagerAbi,
      functionName,
      account: g.account,
      chain: anvilChain,
    }),
  );
}

/** The executor's mined and pending transaction counts. */
async function executorCounts() {
  return {
    mined: await lb.executorNonce(),
    pending: await pub.getTransactionCount({ address: executor.address, blockTag: "pending" }),
  };
}

/** Move the chain's clock and the shared clock forward together, by whole seconds. */
async function moveTime(seconds: number): Promise<void> {
  await node.increaseTime({ seconds });
  await node.mine({ blocks: 1 });
  clockOffsetMs += seconds * 1_000;
}

/** Move both clocks past the latest next check of these orders, so a tick finds each one due. */
async function pastNextCheck(...ids: string[]): Promise<void> {
  const due = ids.map((id) => {
    const at = d.legalBodies.findById(id)?.nextBindingCheckAt;
    if (at === null || at === undefined) throw new Error(`order ${id} has no next check`);
    return at;
  });
  await moveTime(Math.max(1, Math.ceil((Math.max(...due) - now()) / 1_000) + 1));
}

/** The ops lines named `event` this case printed, parsed. */
function opsLines(event: string): Json[] {
  return printed.flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as { opslog?: string };
      return parsed.opslog === event ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

// ── The doors, as the guardian's client calls them ────────────────────────────────────────────

/** The marks the text of a thrown error leaves: viem's, the node's, and a stack's. */
const THROWN_TEXT_MARKS = [
  "Version: viem",
  "Details:",
  "Request body:",
  "Request Arguments:",
  "Raw Call Arguments:",
  "Contract Call:",
  "execution reverted",
  "already imported",
  "nonce too low",
  "could not be found",
  "Error:",
  "\n    at ",
];

/** Calls `visit` with every key and value of a parsed JSON answer, at any depth. */
function walkJson(value: unknown, visit: (key: string, value: unknown) => void, key = ""): void {
  visit(key, value);
  if (Array.isArray(value)) for (const item of value) walkJson(item, visit, key);
  else if (value !== null && typeof value === "object")
    for (const [k, v] of Object.entries(value)) walkJson(v, visit, k);
}

/** The fixed sentences a door's message may be: the legal-body doors' (a lapsed order's refusal
 *  carries the lapse's sentence after its own), and the payment door's refusal above. */
function fixedSentences(): Set<string> {
  const sentences = Object.values(LEGAL_BODY_SENTENCES);
  return new Set([
    ...sentences,
    ...sentences.map((s) => `${s} ${LEGAL_BODY_SENTENCES.order_lapsed}`),
    NOT_LINKED,
  ]);
}

/** The factory's own error names: the only names a refusal's detail may repeat. */
const FACTORY_ERRORS: ReadonlySet<string> = new Set(
  legalBodyFactoryAbi.flatMap((item) => (item.type === "error" ? [item.name] : [])),
);

/**
 * An answer as a door may give it: not a 500; neither the node's URL nor the marks of a thrown
 * error's text; no bigint (a JSON number is a safe integer or no integer at all, and no string is
 * a bigint's literal); every message a fixed sentence; and a refusal's detail made of hex,
 * decimals and the factory's own error names.
 */
function expectWireSafe(answer: { method: string; path: string; status: number; text: string }) {
  const where = `${answer.method} ${answer.path}: ${answer.status}`;
  expect(answer.status, where).not.toBe(500);
  const url = anvil?.rpcUrl;
  if (!url) throw new Error("anvil is not running");
  for (const part of [url, "127.0.0.1", "localhost", `:${PORT}`])
    expect(answer.text, `${where} holds ${part}`).not.toContain(part);
  for (const mark of THROWN_TEXT_MARKS)
    expect(answer.text, `${where} holds ${JSON.stringify(mark)}`).not.toContain(mark);

  const fixed = fixedSentences();
  walkJson(answer.text ? JSON.parse(answer.text) : null, (key, value) => {
    if (typeof value === "number")
      expect(
        Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)),
        `${where}: ${key} = ${value}`,
      ).toBe(true);
    if (typeof value === "string") expect(value, `${where}: ${key}`).not.toMatch(/^-?[0-9]+n$/);
    if (key === "message" && typeof value === "string")
      expect(fixed.has(value), `${where}: message ${JSON.stringify(value)}`).toBe(true);
    if (key === "detail" && value !== null && typeof value === "object")
      for (const [field, fact] of Object.entries(value))
        expect(
          typeof fact === "string" &&
            (/^0x[0-9a-fA-F]*$/.test(fact) ||
              /^(?:0|[1-9][0-9]*)$/.test(fact) ||
              FACTORY_ERRORS.has(fact)),
          `${where}: detail.${field} = ${JSON.stringify(fact)}`,
        ).toBe(true);
  });
}

/** Every answer a door gave in this file, in order. */
const answers: { method: string; path: string; status: number; text: string }[] = [];

/** One request to a door. Its answer is kept, and checked as every answer in this file is. */
async function api(method: "GET" | "POST", path: string, g: Guardian, body?: object) {
  const answer = await answerOf(await call(d.app, method, path, g.token, body));
  const kept = { method, path, status: answer.status, text: answer.text };
  answers.push(kept);
  expectWireSafe(kept);
  return answer;
}

/** The guardian orders a body for its company: a draft, its agreement frozen. */
async function order(g: Guardian): Promise<Json> {
  const res = await api("POST", ORDERS, g, { companyId: g.companyId });
  expect(res.status).toBe(201);
  expect(res.body).toMatchObject({ state: "draft", guardian: g.address, companyId: g.companyId });
  return res.body;
}

async function readOrder(g: Guardian, id: string): Promise<Json> {
  const res = await api("GET", orderPath(id), g);
  expect(res.status).toBe(200);
  return res.body;
}

async function binding(g: Guardian, id: string): Promise<Json> {
  const res = await api("GET", `${orderPath(id)}/binding`, g);
  expect(res.status).toBe(200);
  return res.body;
}

async function refresh(g: Guardian, id: string): Promise<Json> {
  const res = await api("POST", `${orderPath(id)}/binding/refresh`, g);
  expect(res.status).toBe(200);
  return res.body;
}

/** The link message the identity's owner signs, for `ttlSeconds`. */
async function linkMessage(g: Guardian, id: string, agentId: bigint, ttlSeconds: number) {
  const res = await api("POST", `${orderPath(id)}/link-message`, g, {
    agentId: agentId.toString(),
    ttlSeconds,
  });
  expect(res.status).toBe(200);
  return res.body as { typedData: Json; identityOwner: Address; deadline: number };
}

function submitLink(g: Guardian, id: string, typedData: Json, signature: Hex) {
  return api("POST", `${orderPath(id)}/link`, g, { message: typedData.message, signature });
}

/**
 * A new order of `g`, linked for `agentId`: the owner's key signs the served message as it
 * arrives, and the link door answers the order `deployed`.
 */
async function deployedOrder(
  g: Guardian,
  agentId: bigint,
  ttlSeconds: number,
): Promise<{ id: string; body: Address; typedData: Json; view: Json }> {
  const { id } = await order(g);
  const { typedData } = await linkMessage(g, id, agentId, ttlSeconds);
  const res = await submitLink(g, id, typedData, await owner.signTypedData(typedData));
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ id, state: "deployed", agentId: agentId.toString() });
  return { id, body: res.body.bodyAddress, typedData, view: res.body };
}

/** A deployed order whose owner then points the identity at its body, and the sweeper's next
 *  tick links it. */
async function linkedOrder(g: Guardian, agentId: bigint, ttlSeconds: number) {
  const made = await deployedOrder(g, agentId, ttlSeconds);
  await setPointer(agentId, pointerFrom((await binding(g, made.id)).intent));
  await d.sweeper.tick();
  const linked = await binding(g, made.id);
  expect(linked).toMatchObject({ state: "linked", intent: null });
  return { ...made, linked };
}

// ── The path ──────────────────────────────────────────────────────────────────────────────────

describe("an order becomes a linked body on a local chain", () => {
  test("order, agreement, link message, the owner's signature of the wire form, link: deployed at the predicted address, created by the executor through the controller, under the agreement the agreement door serves", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();

    const ordered = await order(g);
    const id: string = ordered.id;
    expect(ordered).toMatchObject({
      chainId: anvilChain.id,
      factory: stack.factory,
      agentId: null,
      bodyAddress: null,
    });

    const agreement = await api("GET", `${orderPath(id)}/agreement`, g);
    expect(agreement.status).toBe(200);
    expect(agreement.body.manifestHash).toBe(ordered.agreement.hash);

    const served = await linkMessage(g, id, agentId, 3_600);
    expect(served.identityOwner).toBe(owner.address);
    const { typedData } = served;
    expect(typedData.domain).toMatchObject({
      chainId: anvilChain.id,
      verifyingContract: stack.factory,
    });
    expect(typedData.message).toMatchObject({
      agentId: agentId.toString(),
      guardian: g.address,
      amendmentDelay: String(LEGAL_BODY_FLOW_DEFAULTS.amendmentDelaySeconds),
      deadline: String(served.deadline),
    });
    // The manifest the agreement door serves hashes to the hash the link carries.
    expect(keccak256(stringToBytes(agreement.body.manifest))).toBe(
      typedData.message.operatingAgreementHash,
    );
    expect(typedData.message.operatingAgreementHash).toBe(ordered.agreement.hash);

    // The owner's wallet signs the wire form exactly as it arrived.
    const signature = await owner.signTypedData(typedData);
    const before = await executorCounts();
    const linked = await submitLink(g, id, typedData, signature);
    expect(linked.status).toBe(200);
    const view = linked.body;
    expect(view).toMatchObject({
      id,
      state: "deployed",
      agentId: agentId.toString(),
      identityOwner: owner.address,
      guardian: g.address,
      linkDeadline: served.deadline,
    });

    // The body is at the address the factory predicts for the digest the owner signed.
    const digest = hashTypedData(typedData);
    const predicted = await pub.readContract({
      address: stack.factory,
      abi: legalBodyFactoryAbi,
      functionName: "predictLegalBody",
      args: [digest],
    });
    expect(view.bodyAddress).toBe(predicted);
    await expect(
      pub.readContract({
        address: stack.factory,
        abi: legalBodyFactoryAbi,
        functionName: "identityOwnerAtCreation",
        args: [predicted],
      }),
    ).resolves.toBe(owner.address);

    // One transaction, sent by the executor to the controller, which relayed it to the factory.
    const receipt = await pub.getTransactionReceipt({ hash: view.createTxHash });
    expect(receipt.status).toBe("success");
    expect(isAddressEqual(receipt.from, executor.address)).toBe(true);
    expect(receipt.to && isAddressEqual(receipt.to, stack.controller)).toBe(true);
    expect(await lb.executorNonce()).toBe(before.mined + 1);
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    expect(view.deployedAt).toBe(Number(block.timestamp));

    // The body holds what the owner signed: its guardian, its delay, its agreement, its agent.
    const read = <F extends "guardian" | "manager" | "amendmentDelay" | "meta">(functionName: F) =>
      pub.readContract({ address: predicted, abi: legalManagerAbi, functionName });
    await expect(read("guardian")).resolves.toBe(g.address);
    await expect(read("manager")).resolves.toBe(stack.factory);
    await expect(read("amendmentDelay")).resolves.toBe(
      BigInt(LEGAL_BODY_FLOW_DEFAULTS.amendmentDelaySeconds),
    );
    const [, , agreementHash, bodyAgentId] = (await read("meta")) as readonly [
      string,
      bigint,
      Hex,
      bigint,
    ];
    expect(agreementHash).toBe(typedData.message.operatingAgreementHash);
    expect(bodyAgentId).toBe(agentId);

    // Not linked: the owner has not pointed the identity at it yet.
    await expect(lb.linkedLegalBody(agentId)).resolves.toBeUndefined();
    expect(await readOrder(g, id)).toEqual(view);
  });

  test("the owner writes the pointer the binding door's intent describes, and one sweeper tick finds the body linked", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();
    const { id, body } = await deployedOrder(g, agentId, 3_600);

    const deployed = await binding(g, id);
    expect(deployed).toEqual({
      state: "deployed",
      agentId: agentId.toString(),
      bodyAddress: body,
      intent: {
        action: "setLegalBodyPointer",
        agentId: agentId.toString(),
        body,
        chainId: anvilChain.id,
      },
      pointerSeenAt: null,
      nextCheckAt: expect.any(Number),
    });
    expect(deployed.nextCheckAt).toBeLessThanOrEqual(now());

    // The test's encoding of the intent is the factory's own pointer for that body.
    const pointer = pointerFrom(deployed.intent);
    await expect(lb.encodePointer(body)).resolves.toBe(pointer);
    await setPointer(BigInt(deployed.intent.agentId), pointer);
    await expect(lb.linkedLegalBody(agentId)).resolves.toBe(body);

    await d.sweeper.tick();

    const head = await pub.getBlock({ blockTag: "latest" });
    expect(await binding(g, id)).toMatchObject({
      state: "linked",
      intent: null,
      pointerSeenAt: Number(head.timestamp),
    });
    expect(await readOrder(g, id)).toMatchObject({
      state: "linked",
      pointerSeenAt: Number(head.timestamp),
    });
  });

  test("the owner clears the pointer and a refresh reads the binding broken; the owner writes it again and the next refresh reads it linked", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();
    const { id, body } = await linkedOrder(g, agentId, 3_600);

    await setPointer(agentId, "0x");
    await expect(lb.linkedLegalBody(agentId)).resolves.toBeUndefined();
    const broken = await refresh(g, id);
    expect(broken).toMatchObject({
      state: "broken",
      bodyAddress: body,
      intent: { action: "setLegalBodyPointer", agentId: agentId.toString(), body },
    });
    expect(d.legalBodies.latestBrokenReason(id)).toBe("not_linked");

    await setPointer(agentId, pointerFrom(broken.intent));
    expect(await refresh(g, id)).toMatchObject({
      state: "linked",
      bodyAddress: body,
      intent: null,
    });
    expect(await readOrder(g, id)).toMatchObject({ state: "linked" });
  });

  test("a contract owner that checks the signature itself, and a contract owner that approved the digest and sends an empty signature, both reach deployed", async () => {
    const g = await newGuardian();

    // A contract wallet with an ERC-1271 check of its signer's signature.
    const wallet = await deployContract(walletOf(deployer), pub, "MockERC1271Wallet", [
      owner.address,
    ]);
    const walletAgent = await identityOfWallet(wallet);
    const first = await order(g);
    const toWallet = await linkMessage(g, first.id, walletAgent, 3_600);
    expect(toWallet.identityOwner).toBe(wallet);
    const viaCheck = await submitLink(
      g,
      first.id,
      toWallet.typedData,
      await owner.signTypedData(toWallet.typedData),
    );
    expect(viaCheck.status).toBe(200);
    expect(viaCheck.body).toMatchObject({ state: "deployed", identityOwner: wallet });

    // A policy wallet that approved the digest beforehand, and an empty signature.
    const policy = await deployContract(walletOf(deployer), pub, "MockPolicyWallet", [
      owner.address,
    ]);
    const policyAgent = await identityOfWallet(policy);
    const second = await order(g);
    const toPolicy = await linkMessage(g, second.id, policyAgent, 3_600);
    expect(toPolicy.identityOwner).toBe(policy);
    await mined(
      await walletOf(owner).writeContract({
        address: policy,
        abi: policyWalletAbi,
        functionName: "approve",
        args: [hashTypedData(toPolicy.typedData)],
        account: owner,
        chain: anvilChain,
      }),
    );
    const viaApproval = await submitLink(g, second.id, toPolicy.typedData, "0x");
    expect(viaApproval.status).toBe(200);
    expect(viaApproval.body).toMatchObject({ state: "deployed", identityOwner: policy });

    // The factory records each wallet as the owner that signed its body's link.
    for (const [view, signer] of [
      [viaCheck.body, wallet],
      [viaApproval.body, policy],
    ] as const)
      await expect(
        pub.readContract({
          address: stack.factory,
          abi: legalBodyFactoryAbi,
          functionName: "identityOwnerAtCreation",
          args: [view.bodyAddress],
        }),
      ).resolves.toBe(signer);
  });

  test("a link signed by a key that does not own the identity: 422 bad_signature, the order is still a draft, and the executor's nonce did not move", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();
    const { id } = await order(g);
    const { typedData } = await linkMessage(g, id, agentId, 3_600);
    const before = await executorCounts();

    const refused = await submitLink(g, id, typedData, await stranger.signTypedData(typedData));
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      code: "bad_signature",
      message: LEGAL_BODY_SENTENCES.bad_signature,
      detail: { identityOwner: owner.address },
      order: { id, state: "draft", agentId: null },
    });
    expect(await readOrder(g, id)).toMatchObject({ state: "draft", agentId: null });
    expect(await executorCounts()).toEqual(before);
  });

  test("a replacement: with a body linked, a second order for the same identity is deployed; once the owner points at the new body, it is linked and the old one is broken, replaced", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();
    const first = await linkedOrder(g, agentId, 3_600);

    // A linked body is not on its way: nothing gives way to the second order's link.
    const second = await deployedOrder(g, agentId, 3_700);
    expect(second.body).not.toBe(first.body);
    expect(await readOrder(g, first.id)).toMatchObject({ state: "linked" });
    const intent = (await binding(g, second.id)).intent;
    expect(intent).toMatchObject({ agentId: agentId.toString(), body: second.body });

    await setPointer(agentId, pointerFrom(intent));
    await d.sweeper.tick();

    expect(await binding(g, second.id)).toMatchObject({ state: "linked", intent: null });
    expect(await binding(g, first.id)).toMatchObject({
      state: "broken",
      bodyAddress: first.body,
      intent: { body: first.body },
    });
    expect(d.legalBodies.latestBrokenReason(first.id)).toBe("replaced");
  });

  test("a second tenant's link for the same identity, signed by the same owner, supersedes the first tenant's deployed, unlinked order", async () => {
    const firstTenant = await newGuardian();
    const secondTenant = await newGuardian();
    const agentId = await identityOfKey();

    const earlier = await deployedOrder(firstTenant, agentId, 3_600);
    const later = await deployedOrder(secondTenant, agentId, 3_700);

    expect(await readOrder(firstTenant, earlier.id)).toMatchObject({
      state: "superseded",
      bodyAddress: earlier.body,
    });
    expect(await readOrder(secondTenant, later.id)).toMatchObject({ state: "deployed" });
    expect(
      d.legalBodies
        .listEvents(earlier.id)
        .filter((e) => e.kind === "superseded")
        .map((e) => e.detail),
    ).toEqual([{ by: later.id }]);
    // Its body stays on chain, and stays one the owner may point at.
    expect((await binding(firstTenant, earlier.id)).intent).toMatchObject({ body: earlier.body });
  });

  test("the daily cap: five orders for one identity and tenant, each superseding the last, are created; the sixth create is refused, and nothing is sent", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();
    expect(LEGAL_BODY_FLOW_DEFAULTS.maxCreatesPerTenantPerDay).toBe(5);

    const ids: string[] = [];
    for (const ttlSeconds of [3_600, 3_700, 3_800, 3_900, 4_000])
      ids.push((await deployedOrder(g, agentId, ttlSeconds)).id);
    const states: string[] = [];
    for (const id of ids) states.push((await readOrder(g, id)).state);
    expect(states).toEqual(["superseded", "superseded", "superseded", "superseded", "deployed"]);

    const sixth = await order(g);
    const { typedData } = await linkMessage(g, sixth.id, agentId, 4_100);
    const before = await executorCounts();
    const refused = await submitLink(g, sixth.id, typedData, await owner.signTypedData(typedData));
    expect(refused).toMatchObject({
      status: 429,
      body: {
        error: {
          code: "legal_body_attempts",
          message: LEGAL_BODY_SENTENCES.legal_body_attempts,
        },
      },
    });
    expect(await readOrder(g, sixth.id)).toMatchObject({ state: "draft", agentId: null });
    expect(await readOrder(g, ids[4]!)).toMatchObject({ state: "deployed" });
    expect(await executorCounts()).toEqual(before);
  });

  test("a node that answers 429: the link-message door answers 503, and neither its body nor any log line holds the node's URL", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();
    const { id } = await order(g);
    const url = anvil?.rpcUrl ?? "";

    throttle.answered = 0;
    throttle.on = true;
    let res: Awaited<ReturnType<typeof api>>;
    try {
      res = await api("POST", `${orderPath(id)}/link-message`, g, {
        agentId: agentId.toString(),
        ttlSeconds: 3_600,
      });
    } finally {
      throttle.on = false;
    }
    expect(throttle.answered).toBeGreaterThan(0);

    expect(res).toMatchObject({
      status: 503,
      body: {
        error: { code: "chain_unavailable", message: LEGAL_BODY_SENTENCES.chain_unavailable },
      },
    });
    // The port with its colon: an order id is random, and its digits can hold the port's.
    for (const part of [url, "://", "127.0.0.1", `:${PORT}`]) {
      expect(res.text, part).not.toContain(part);
      expect(printed.join("\n"), part).not.toContain(part);
    }
    expect(opsLines("legal_body_chain_unavailable")).toEqual([
      expect.objectContaining({ orderId: id, stage: "head", errorName: "HttpRequestError" }),
    ]);
    expect(await readOrder(g, id)).toMatchObject({ state: "draft", agentId: null });
  });
});

// ── The tools, as an agent calls them, and the gas seed ───────────────────────────────────────

/** An agent connected to the MCP endpoint of the case's app with one API key. */
type Agent = Awaited<ReturnType<typeof startMcpTestClient>>;

/**
 * One tool call, as the agent makes it. Its answer is checked as a door's is, and it must be an
 * answer, not a refusal: a refusal fails the case with the tool's own text.
 */
async function useTool(agent: Agent, name: string, args: Record<string, unknown>): Promise<Json> {
  const out = (await agent.client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = out.content[0]?.text ?? "";
  expect(out.isError === true, `${name} refused: ${text}`).toBe(false);
  expectWireSafe({ method: "TOOL", path: name, status: 200, text });
  return JSON.parse(text);
}

/** The platform's outflows recorded in the case's database, oldest first. */
const outflowRows = () =>
  d.db.prepare("SELECT path, amount, ref FROM platform_outflows ORDER BY id").all();

describe("an agent that holds the identity owner's key, and the gas seed, on a local chain", () => {
  test("an agent with a provision key of the guardian's tenant gets the link message, has the owner's key sign it as served, and submits it: the order is deployed, and get_binding answers the pointer intent, the factory's own pointer for the body", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();

    // The guardian places the order in the browser and gives its agent a provision key of its
    // tenant. No tool call names a tenant: each tool reads it from the key.
    const { id } = await order(g);
    const { key } = new SqliteApiKeyStore(d.db).mint(g.address, { capability: "provision" });
    const agent = await startMcpTestClient(d.app, key);
    try {
      const served = await useTool(agent, "get_link_message", {
        orderId: id,
        agentId: agentId.toString(),
      });
      expect(served.identityOwner).toBe(owner.address);
      const { typedData } = served;
      expect(typedData.domain).toMatchObject({
        chainId: anvilChain.id,
        verifyingContract: stack.factory,
      });
      expect(typedData.message).toMatchObject({
        agentId: agentId.toString(),
        guardian: g.address,
        deadline: String(served.deadline),
      });

      // The owner's key signs the typed data exactly as the tool served it.
      const signature = await owner.signTypedData(typedData);
      const before = await executorCounts();
      const submitted = await useTool(agent, "submit_link", {
        orderId: id,
        message: typedData.message,
        signature,
      });
      expect(submitted).toMatchObject({
        status: "deployed",
        order: {
          id,
          state: "deployed",
          agentId: agentId.toString(),
          identityOwner: owner.address,
          guardian: g.address,
        },
      });
      const body: Address = submitted.order.bodyAddress;

      // One create, sent by the executor and mined, at the address the factory predicts for the
      // digest the owner signed, with the owner recorded as the identity's owner at creation.
      expect(await executorCounts()).toEqual({
        mined: before.mined + 1,
        pending: before.pending + 1,
      });
      expect(await pub.getTransactionReceipt({ hash: submitted.order.createTxHash })).toMatchObject(
        { status: "success" },
      );
      await expect(
        pub.readContract({
          address: stack.factory,
          abi: legalBodyFactoryAbi,
          functionName: "predictLegalBody",
          args: [hashTypedData(typedData)],
        }),
      ).resolves.toBe(body);
      await expect(
        pub.readContract({
          address: stack.factory,
          abi: legalBodyFactoryAbi,
          functionName: "identityOwnerAtCreation",
          args: [body],
        }),
      ).resolves.toBe(owner.address);
      // The guardian's browser reads the same order.
      expect(await readOrder(g, id)).toEqual(submitted.order);

      const bound = await useTool(agent, "get_binding", { orderId: id });
      expect(bound).toEqual({
        state: "deployed",
        agentId: agentId.toString(),
        bodyAddress: body,
        intent: {
          action: "setLegalBodyPointer",
          agentId: agentId.toString(),
          body,
          chainId: anvilChain.id,
        },
        pointerSeenAt: null,
        nextCheckAt: expect.any(Number),
      });
      expect(bound).toEqual(await binding(g, id));
      // The pointer the intent describes is the factory's own pointer for the body.
      await expect(lb.encodePointer(body)).resolves.toBe(pointerFrom(bound.intent));
    } finally {
      await agent.close();
    }
  });

  test("the gas seed: the owner of an identity, holding nothing, is seeded once through the door and pays for its pointer transaction with the seed, and the body is linked; a second request by the same tenant is refused with gas_seed_used, and nothing is sent", async () => {
    redeploy({ gasSeedUsdc: SEED_USDC });
    const g = await newGuardian();

    // An identity registered by the owner's key and transferred to an address with no balance
    // and no code.
    const agentId = await identityOfKey();
    await mined(
      await walletOf(owner).writeContract({
        address: stack.registry,
        abi: iIdentityRegistryAbi,
        functionName: "transferFrom",
        args: [owner.address, freshOwner.address, agentId],
        account: owner,
        chain: anvilChain,
      }),
    );
    await expect(lb.identityOwner(agentId)).resolves.toBe(freshOwner.address);
    expect(await pub.getBalance({ address: freshOwner.address })).toBe(0n);
    expect(await pub.getCode({ address: freshOwner.address })).toBeUndefined();

    // The guardian orders, and the new owner signs the link, which costs it nothing: the platform
    // creates the body.
    const { id } = await order(g);
    const served = await linkMessage(g, id, agentId, 3_600);
    expect(served.identityOwner).toBe(freshOwner.address);
    const linked = await submitLink(
      g,
      id,
      served.typedData,
      await freshOwner.signTypedData(served.typedData),
    );
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ id, state: "deployed", identityOwner: freshOwner.address });
    const body: Address = linked.body.bodyAddress;
    expect(await pub.getBalance({ address: freshOwner.address })).toBe(0n);

    // The seed, through the door: one transfer of the amount, from the executor to the owner,
    // counted against the platform's outflow in 6-decimal USDC.
    const before = await executorCounts();
    const seeded = await api("POST", gasSeedPath(id), g);
    expect(seeded.status).toBe(200);
    expect(seeded.body).toEqual({
      status: "sent",
      txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    const seedHash: Hex = seeded.body.txHash;
    const seedReceipt = await mined(seedHash);
    expect(isAddressEqual(seedReceipt.from, executor.address)).toBe(true);
    expect(seedReceipt.to && isAddressEqual(seedReceipt.to, freshOwner.address)).toBe(true);
    // The amount, sent with the seed's gas cap as its gas limit.
    expect(await pub.getTransaction({ hash: seedHash })).toMatchObject({
      value: SEED_WEI,
      gas: SEED_TRANSFER_GAS_LIMIT,
    });
    expect(await pub.getBalance({ address: freshOwner.address })).toBe(SEED_WEI);
    const afterSeed = { mined: before.mined + 1, pending: before.pending + 1 };
    expect(await executorCounts()).toEqual(afterSeed);
    expect(outflowRows()).toEqual([{ path: "gas_seed", amount: SEED_MICRO_USDC, ref: seedHash }]);

    // The owner's pointer transaction, encoded from the binding door's intent and paid for with
    // the seed: what the owner holds now is the seed less that transaction's fee.
    const { intent } = await binding(g, id);
    expect(intent).toMatchObject({ agentId: agentId.toString(), body });
    const pointerReceipt = await mined(
      await walletOf(freshOwner).writeContract({
        address: stack.registry,
        abi: iIdentityRegistryAbi,
        functionName: "setMetadata",
        args: [agentId, POINTER_KEY, pointerFrom(intent)],
        account: freshOwner,
        chain: anvilChain,
      }),
    );
    expect(isAddressEqual(pointerReceipt.from, freshOwner.address)).toBe(true);
    const left = SEED_WEI - pointerReceipt.gasUsed * pointerReceipt.effectiveGasPrice;
    expect(await pub.getBalance({ address: freshOwner.address })).toBe(left);
    await expect(lb.linkedLegalBody(agentId)).resolves.toBe(body);

    // A second request by the same tenant, for the same order: the order is still deployed and
    // its owner now holds less than a seed, so what answers it is the tenant's one seed, spent.
    expect(await readOrder(g, id)).toMatchObject({ state: "deployed" });
    expect(left).toBeLessThan(SEED_WEI);
    const again = await api("POST", gasSeedPath(id), g);
    expect(again).toMatchObject({
      status: 409,
      body: { error: { code: "gas_seed_used", message: LEGAL_BODY_SENTENCES.gas_seed_used } },
    });
    expect(await executorCounts()).toEqual(afterSeed);
    expect(await pub.getBalance({ address: freshOwner.address })).toBe(left);
    expect(outflowRows()).toHaveLength(1);
    expect(d.legalBodies.countEventsByTenant(g.address, "gas_seed_requested")).toBe(1);
    expect(d.legalBodies.countEventsByTenant(g.address, "gas_seeded")).toBe(1);

    // The next tick reads the pointer the seed paid for: the body is linked.
    await d.sweeper.tick();
    expect(await binding(g, id)).toMatchObject({
      state: "linked",
      bodyAddress: body,
      intent: null,
    });
  });
});

// ── What the path survives ────────────────────────────────────────────────────────────────────

/** The order's one recorded create: its hash, its raw bytes and its nonce. */
function onlySubmission(id: string) {
  const submissions = d.legalBodies.listDeploySubmissions(id);
  expect(submissions).toHaveLength(1);
  const [submission] = submissions;
  if (submission === undefined) throw new Error(`order ${id} recorded no create`);
  return submission;
}

describe("an order survives a lost response, a restart, a transfer and a nonce gap", () => {
  afterEach(async () => {
    // A case that stopped half-way must leave the next one a node that mines every transaction
    // at once, with nothing left in its pool, and no sender's nonce floor from what it sent.
    const pool = await node.getTxpoolContent();
    for (const bySender of [pool.pending, pool.queued])
      for (const transactions of Object.values(bySender))
        for (const tx of Object.values(transactions)) await node.dropTransaction({ hash: tx.hash });
    await node.setAutomine(true);
    resetSenderNonces();
  });

  test("a lost response: the create is sent and not mined yet, so the link door answers 202 reserved; once a block mines it, the next tick marks the order deployed with the mined hash", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();
    const { id } = await order(g);
    const { typedData } = await linkMessage(g, id, agentId, 3_600);
    const signature = await owner.signTypedData(typedData);
    const before = await executorCounts();

    await node.setAutomine(false);
    const res = await submitLink(g, id, typedData, signature);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      id,
      state: "reserved",
      agentId: agentId.toString(),
      identityOwner: owner.address,
      deployedAt: null,
    });
    const sent = onlySubmission(id);
    expect(sent.nonce).toBe(before.pending);
    // In the node's pool, in no block.
    expect(await executorCounts()).toEqual({ mined: before.mined, pending: before.pending + 1 });

    await node.mine({ blocks: 1 });
    const block = await pub.getBlock({ blockTag: "latest" });
    expect(block.transactions).toEqual([sent.txHash]);
    expect(await readOrder(g, id)).toMatchObject({ state: "reserved" });

    await d.sweeper.tick();
    expect(await readOrder(g, id)).toMatchObject({
      state: "deployed",
      bodyAddress: res.body.bodyAddress,
      createTxHash: sent.txHash,
      deployedAt: Number(block.timestamp),
    });
    expect(await pub.getTransactionReceipt({ hash: sent.txHash })).toMatchObject({
      status: "success",
      blockNumber: block.number,
    });
    expect(await lb.executorNonce()).toBe(before.mined + 1);
    expect((await binding(g, id)).intent).toMatchObject({ body: res.body.bodyAddress });
  });

  test("a restart between the reserve and the send: the order is reserved and no create was submitted; the first tick of a new sweeper submits it, and the order reaches deployed", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();
    const { id } = await order(g);
    const { typedData } = await linkMessage(g, id, agentId, 3_600);
    const signature = await owner.signTypedData(typedData);

    // The link door's check and reserve, written as the door writes them, and nothing after: the
    // process stops before the create is submitted.
    const draft = d.legalBodies.findById(id);
    if (!draft?.oaManifestHash) throw new Error(`order ${id} has no agreement`);
    const link = linkFromWire(typedData.message);
    const check = await checkLink(lb, {
      link,
      signature,
      expected: {
        tenant: g.address,
        operatingAgreementHash: draft.oaManifestHash,
        amendmentDelay: BigInt(draft.amendmentDelay),
      },
    });
    if (!check.ok) throw new Error(`the link was refused: ${check.code}`);
    expect(
      d.legalBodies.reserve(id, {
        agentId: agentId.toString(),
        identityOwner: check.identityOwner,
        linkDigest: check.linkDigest,
        linkDeadline: Number(link.deadline),
        linkSignature: check.signature,
        bodyAddress: check.bodyAddress,
        observedAtBlock: check.observedAtBlock,
        firstCheckAt: now(),
      }),
    ).toBe("reserved");
    expect(d.legalBodies.listDeploySubmissions(id)).toEqual([]);
    const before = await executorCounts();

    // The process starts again: a new app and a new sweeper over the same database.
    redeploy();
    await d.sweeper.tick();
    const sent = onlySubmission(id);
    expect(sent.nonce).toBe(before.pending);
    const receipt = await pub.getTransactionReceipt({ hash: sent.txHash });
    expect(receipt.status).toBe("success");
    expect(await executorCounts()).toEqual({
      mined: before.mined + 1,
      pending: before.pending + 1,
    });
    expect(opsLines("legal_body_resolve")).toEqual([
      expect.objectContaining({
        orderId: id,
        outcome: "resubmitted",
        txHash: sent.txHash,
        nonce: sent.nonce,
      }),
    ]);
    expect(await readOrder(g, id)).toMatchObject({ state: "reserved" });

    await pastNextCheck(id);
    await d.sweeper.tick();
    const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
    expect(await readOrder(g, id)).toMatchObject({
      state: "deployed",
      bodyAddress: check.bodyAddress,
      createTxHash: sent.txHash,
      deployedAt: Number(block.timestamp),
    });
    expect(onlySubmission(id)).toEqual(sent);
    expect(await lb.executorNonce()).toBe(before.mined + 1);
  });

  test("a gap in the platform key's nonces: the recorded bytes fill it, and both orders reach deployed", async () => {
    const g = await newGuardian();
    const agentA = await identityOfKey();
    const agentB = await identityOfKey();
    const a = (await order(g)).id as string;
    const b = (await order(g)).id as string;
    const forA = await linkMessage(g, a, agentA, 3_600);
    const forB = await linkMessage(g, b, agentB, 3_600);
    const signedA = await owner.signTypedData(forA.typedData);
    const signedB = await owner.signTypedData(forB.typedData);
    const before = await executorCounts();

    await node.setAutomine(false);
    const resA = await submitLink(g, a, forA.typedData, signedA);
    expect(resA).toMatchObject({ status: 202, body: { id: a, state: "reserved" } });
    const sentA = onlySubmission(a);
    expect(sentA.nonce).toBe(before.pending);
    await node.dropTransaction({ hash: sentA.txHash });

    const resB = await submitLink(g, b, forB.typedData, signedB);
    expect(resB).toMatchObject({ status: 202, body: { id: b, state: "reserved" } });
    const sentB = onlySubmission(b);
    expect(sentB.nonce).toBe(sentA.nonce + 1);
    expect(await node.getTxpoolStatus()).toEqual({ pending: 0, queued: 1 });

    // A block: B cannot be mined, and stays reserved.
    await node.mine({ blocks: 1 });
    await expect(
      lb.createOutcome(sentB.txHash, { bodyAddress: resB.body.bodyAddress }),
    ).resolves.toEqual({ status: "absent" });
    expect(await lb.executorNonce()).toBe(before.mined);
    expect(await readOrder(g, b)).toMatchObject({ state: "reserved" });

    // One tick sends A's recorded bytes again, and the gap is filled: both are ready to be mined.
    // No create is signed for either order.
    await d.sweeper.tick();
    expect(opsLines("legal_body_resolve")).toContainEqual(
      expect.objectContaining({ orderId: a, outcome: "rebroadcast", nonce: sentA.nonce }),
    );
    expect(opsLines("legal_body_executor_nonce_gap")).toEqual([]);
    expect(await pub.getTransaction({ hash: sentA.txHash })).toMatchObject({
      nonce: sentA.nonce,
      blockNumber: null,
    });
    expect(await node.getTxpoolStatus()).toEqual({ pending: 2, queued: 0 });
    expect(onlySubmission(a)).toEqual(sentA);
    expect(onlySubmission(b)).toEqual(sentB);

    // A block mines both, in nonce order.
    await node.mine({ blocks: 1 });
    const receiptA = await pub.getTransactionReceipt({ hash: sentA.txHash });
    const receiptB = await pub.getTransactionReceipt({ hash: sentB.txHash });
    expect(receiptA.status).toBe("success");
    expect(receiptB.status).toBe("success");
    expect(receiptB.blockNumber).toBe(receiptA.blockNumber);
    expect(receiptB.transactionIndex).toBeGreaterThan(receiptA.transactionIndex);
    expect(await lb.executorNonce()).toBe(before.mined + 2);

    // The next tick marks both deployed, each with its own mined hash.
    await pastNextCheck(a, b);
    await d.sweeper.tick();
    const block = await pub.getBlock({ blockNumber: receiptA.blockNumber });
    expect(await readOrder(g, a)).toMatchObject({
      state: "deployed",
      bodyAddress: resA.body.bodyAddress,
      createTxHash: sentA.txHash,
      deployedAt: Number(block.timestamp),
    });
    expect(await readOrder(g, b)).toMatchObject({
      state: "deployed",
      bodyAddress: resB.body.bodyAddress,
      createTxHash: sentB.txHash,
      deployedAt: Number(block.timestamp),
    });
    expect(onlySubmission(a)).toEqual(sentA);
    expect(onlySubmission(b)).toEqual(sentB);
  });

  test("a customer company's payment quote, on a deployment that charges: refused while none of its legal bodies is linked, its deployed body included; given once the body is linked", async () => {
    redeploy({ charging: true });
    const g = await newGuardian();
    const quote = () => api("POST", requotePath(g.companyId), g);
    const refused = {
      status: 400,
      body: { error: { code: "validation_error", message: NOT_LINKED } },
    };

    // No order yet.
    expect(await quote()).toMatchObject(refused);

    // A body created, not linked.
    const agentId = await identityOfKey();
    const { id, body } = await deployedOrder(g, agentId, 3_600);
    expect(await quote()).toMatchObject(refused);
    expect(d.payments.findLive(g.companyId, "formation")).toBeUndefined();

    // The owner points the identity at it, and a tick finds it linked.
    await setPointer(agentId, pointerFrom((await binding(g, id)).intent));
    await d.sweeper.tick();
    expect(await binding(g, id)).toMatchObject({ state: "linked", bodyAddress: body });

    const quoted = await quote();
    expect(quoted.status).toBe(201);
    expect(quoted.body).toMatchObject({ amountUsdc: CUSTOMER_FEE.toString() });
    expect(d.payments.findLive(g.companyId, "formation")).toMatchObject({
      status: "quoted",
      amountUsdc: CUSTOMER_FEE,
    });
  });

  // It moves the chain's clock past a link's deadline, an hour on.
  test("an identity transferred before its create is mined: the order lapses at its deadline, and the new owner can link", async () => {
    const g = await newGuardian();
    const agentId = await identityOfKey();
    const { id } = await order(g);
    const { typedData, deadline } = await linkMessage(g, id, agentId, 3_600);
    const signature = await owner.signTypedData(typedData);

    await node.setAutomine(false);
    const res = await submitLink(g, id, typedData, signature);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id, state: "reserved", identityOwner: owner.address });
    const body: Address = res.body.bodyAddress;
    const sent = onlySubmission(id);

    // The node drops the create; the owner transfers the identity; a block; automine again.
    await node.dropTransaction({ hash: sent.txHash });
    const transfer = await walletOf(owner).writeContract({
      address: stack.registry,
      abi: iIdentityRegistryAbi,
      functionName: "transferFrom",
      args: [owner.address, buyer.address, agentId],
      account: owner,
      chain: anvilChain,
    });
    await node.mine({ blocks: 1 });
    await mined(transfer);
    await node.setAutomine(true);
    await expect(lb.identityOwner(agentId)).resolves.toBe(buyer.address);
    await expect(lb.createOutcome(sent.txHash, { bodyAddress: body })).resolves.toEqual({
      status: "absent",
    });
    expect(await executorCounts()).toEqual({ mined: sent.nonce, pending: sent.nonce });

    // One tick: the order's one recorded create is settled on chain, and the order stays reserved.
    await d.sweeper.tick();
    const reverted = await pub.getTransactionReceipt({ hash: sent.txHash });
    expect(reverted.status).toBe("reverted");
    expect(isAddressEqual(reverted.from, executor.address)).toBe(true);
    expect(opsLines("legal_body_resolve")).toEqual([
      expect.objectContaining({
        orderId: id,
        outcome: "rebroadcast",
        why: "lost_bytes",
        nonce: sent.nonce,
      }),
    ]);
    expect(await readOrder(g, id)).toMatchObject({ state: "reserved" });
    expect(onlySubmission(id)).toEqual(sent);
    const afterRevert = await executorCounts();
    expect(afterRevert).toEqual({ mined: sent.nonce + 1, pending: sent.nonce + 1 });

    // The next tick checks the link again: the identity's owner did not sign it. The order waits,
    // and nothing is sent.
    await pastNextCheck(id);
    await d.sweeper.tick();
    expect(opsLines("legal_body_resolve").slice(1)).toEqual([
      expect.objectContaining({
        orderId: id,
        outcome: "waiting",
        why: "link_refused",
        code: "bad_signature",
      }),
    ]);
    expect(await readOrder(g, id)).toMatchObject({ state: "reserved" });
    expect(onlySubmission(id)).toEqual(sent);
    expect(await executorCounts()).toEqual(afterRevert);

    // The chain's time passes the link's deadline, and the order is due again: the next tick
    // lapses it.
    const { timestamp } = await lb.head();
    await moveTime(deadline - Number(timestamp) + 1);
    expect((await lb.head()).timestamp).toBeGreaterThan(BigInt(deadline));
    expect(now()).toBeGreaterThan(d.legalBodies.findById(id)?.nextBindingCheckAt ?? Number.NaN);
    await d.sweeper.tick();
    expect(await readOrder(g, id)).toMatchObject({ state: "lapsed", createTxHash: sent.txHash });
    const lapses = d.legalBodies
      .listEvents(id)
      .filter((e) => e.kind === "lapsed")
      .map((e) => e.detail as { reason: string; blockTime: number });
    expect(lapses).toEqual([{ reason: "deadline_passed", blockTime: expect.any(Number) }]);
    expect(lapses[0]?.blockTime).toBeGreaterThan(deadline);
    await expect(lb.bodyCreator(body)).resolves.toBeUndefined();
    expect(await executorCounts()).toEqual(afterRevert);

    // The new owner's turn: a guardian orders, the new owner signs, and the body is created.
    const next = await newGuardian();
    const { id: nextId } = await order(next);
    const served = await linkMessage(next, nextId, agentId, 3_700);
    expect(served.identityOwner).toBe(buyer.address);
    const linked = await submitLink(
      next,
      nextId,
      served.typedData,
      await buyer.signTypedData(served.typedData),
    );
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({
      id: nextId,
      state: "deployed",
      agentId: agentId.toString(),
      identityOwner: buyer.address,
    });
    await expect(
      pub.readContract({
        address: stack.factory,
        abi: legalBodyFactoryAbi,
        functionName: "identityOwnerAtCreation",
        args: [linked.body.bodyAddress],
      }),
    ).resolves.toBe(buyer.address);
    expect(await readOrder(g, id)).toMatchObject({ state: "lapsed" });
  });

  // It reads the answers of the cases before it. `api` checks each answer as it arrives, the
  // answers of the case after this one included.
  test("no answer a door gave in this file holds a bigint, the node's URL or the text of a thrown error", () => {
    const statuses = new Set(answers.map((a) => a.status));
    for (const status of [200, 201, 202, 400, 422, 429, 503])
      expect(statuses.has(status), `an answer with status ${status}`).toBe(true);
    for (const answer of answers) expectWireSafe(answer);
  });
});

// ── The path's last case, days on ─────────────────────────────────────────────────────────────

/**
 * Last in the file, after every case that creates an order: it moves the chain's clock and the
 * shared clock forward by days, for good, and a draft's age is counted from the database's own
 * clock, which does not move. An order created after it would be past its 24 hours at once.
 */
describe("a linked body on a local chain, days on", () => {
  test("a dissolution of a linked body: while it winds down the next check reads it broken with winding_down, still checked and with no intent; once the guardian makes it final the next check reads it dissolved, with no intent and no further check", async () => {
    const g = await newGuardian();
    await node.setBalance({ address: g.address, value: parseEther("1") });
    const agentId = await identityOfKey();
    const { id, body, linked } = await linkedOrder(g, agentId, 3_600);

    // The guardian starts the dissolution: the factory no longer counts the pointer.
    await asGuardian(g, body, "initiateDissolution");
    await expect(lb.bodyStatus(body)).resolves.toBe("winding_down");
    await expect(lb.linkedLegalBody(agentId)).resolves.toBeUndefined();

    // The linked body's next check, a day on.
    expect(linked.nextCheckAt).toBeGreaterThan(now());
    await moveTime(Math.ceil((linked.nextCheckAt - now()) / 1_000) + 60);
    await d.sweeper.tick();
    const windingDown = await binding(g, id);
    expect(windingDown).toMatchObject({ state: "broken", bodyAddress: body, intent: null });
    expect(windingDown.nextCheckAt).toBeGreaterThan(now());
    expect(d.legalBodies.latestBrokenReason(id)).toBe("winding_down");
    expect(await readOrder(g, id)).toMatchObject({ state: "broken" });

    // Once its window has passed, the guardian makes the dissolution final.
    const executableAt = await pub.readContract({
      address: body,
      abi: legalManagerAbi,
      functionName: "dissolutionExecutableAt",
    });
    const { timestamp } = await lb.head();
    expect(executableAt - timestamp).toBeLessThanOrEqual(BigInt(2 * DAY_SECONDS));
    await moveTime(Number(executableAt - timestamp) + 60);
    await asGuardian(g, body, "finalizeDissolution");
    await expect(lb.bodyStatus(body)).resolves.toBe("dissolved");

    // The next check.
    expect(now()).toBeGreaterThan(windingDown.nextCheckAt);
    await d.sweeper.tick();
    expect(d.legalBodies.latestBrokenReason(id)).toBe("dissolved");
    expect(await binding(g, id)).toMatchObject({
      state: "broken",
      bodyAddress: body,
      intent: null,
      nextCheckAt: null,
    });
  });
});
