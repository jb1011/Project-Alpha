/**
 * THE LEGAL-BODY FLOW ON A LOCAL CHAIN: an order becomes a body its identity points at.
 *
 * The real API app with its order, link and binding doors, the real repository over a database
 * file, the real sweeper, and the real chain adapter over anvil, where the real NoviController
 * relays each create to the real LegalBodyFactory. The identity registry is the mock registry the
 * factory reads; a contract owner is one of the two mock wallets. The guardian's human
 * verification is seeded in the World store, and its company is declared through the customer
 * company functions and checked as the operator records a check.
 *
 * One chain for the file. One database, one document store, one app and one sweeper per case, so
 * a sweeper tick works the rows of its own case only. Each case:
 *  - mines a block first: the chain adapter does not believe a head more than 120 seconds old;
 *  - has its own guardian: a verified human with its own checked company;
 *  - signs the links for one identity with different lifetimes, so no two of them share a digest.
 * The doors, the sweeper and the chain adapter read one clock. A case that needs a second pass
 * over a row moves that clock past the row's next check, and moves the chain's clock with it. The
 * one case that moves the chain's clock runs last.
 *
 * The app's throttles never refuse here; the caps are the deployment's defaults. Its formation
 * block and payment config are wired as a deployment that does not charge wires them.
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
import { type ApiDeps, buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import { anvilChain } from "../../src/chains";
import {
  DEFAULT_LEGAL_BODY_SWEEP_INTERVAL_MS,
  LEGAL_BODY_FLOW_DEFAULTS,
} from "../../src/config/env";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import {
  type CustomerCompanyDeps,
  createCustomerCompany,
  expireStaleCustomerCompanies,
  prepareCustomerStatement,
} from "../../src/legalBody/customerCompany";
import { expireEvidenceBytes } from "../../src/legalBody/evidence";
import type { LegalBodyOrderDeps } from "../../src/legalBody/orders";
import { LEGAL_BODY_SENTENCES } from "../../src/legalBody/sentences";
import { buildStatementMessage, statementTypedDataWire } from "../../src/legalBody/statement";
import {
  HOUSEKEEPING_BATCH,
  LEGAL_BODY_SWEEP_MAX_PER_TICK,
  LegalBodySweeper,
} from "../../src/legalBody/sweeper";
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
import { paymentCfg } from "../helpers/formationPayment";
import { type Json, answerOf, call } from "../helpers/legalBodyFixtures";
import {
  type LegalBodyStack,
  deployContract,
  deployLegalBodyStack,
} from "../helpers/legalBodyStack";

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
/** Each case's guardians take the next keys from here on. */
const FIRST_GUARDIAN_INDEX = 10;

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const COMPANY_NAME = "Example Holdings LLC";
/** The identity-metadata key the factory reads the pointer under, and the pointer's version. */
const POINTER_KEY = "legalBody";
const POINTER_VERSION = 1n;

const ORDERS = "/legal-body-orders";
const orderPath = (id: string) => `${ORDERS}/${id}`;

const contractWalletAbi = parseAbi([
  "function execute(address target, bytes data) returns (bytes)",
]);
const policyWalletAbi = parseAbi(["function approve(bytes32 digest)"]);

let anvil: AnvilHandle | undefined;
let pub: PublicClient;
/** anvil's own controls: mine a block, move the chain's clock, set a balance. */
let node: TestClient;
let stack: LegalBodyStack;
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
  const arc = new ArcAdapter({
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

/** The deployment as the composition root wires it where the legal-body feature is on, over this
 *  case's database and document store, on the shared clock. */
function deploy(): Deployment {
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
  };
  const customerDeps = sandboxCustomerCompanyDeps(
    { db, companies, declarations, checks, store },
    now,
    {
      chainId: anvilChain.id,
      factory: stack.factory,
      paymentRequired: false,
      world,
    },
  );
  const payment = paymentCfg(payments, { required: false });
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
      paymentExecutor: undefined,
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
    customerDeps,
    app: buildApiApp(deps as ApiDeps),
    sweeper,
  };
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

// ── The doors, as the guardian's client calls them ────────────────────────────────────────────

async function api(method: "GET" | "POST", path: string, g: Guardian, body?: object) {
  return answerOf(await call(d.app, method, path, g.token, body));
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
    for (const part of [url, "://", "127.0.0.1", String(PORT)]) {
      expect(res.text, part).not.toContain(part);
      expect(printed.join("\n"), part).not.toContain(part);
    }
    const opsLines = printed.flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as { opslog?: string };
        return parsed.opslog === "legal_body_chain_unavailable" ? [parsed] : [];
      } catch {
        return [];
      }
    });
    expect(opsLines).toEqual([
      expect.objectContaining({ orderId: id, stage: "head", errorName: "HttpRequestError" }),
    ]);
    expect(await readOrder(g, id)).toMatchObject({ state: "draft", agentId: null });
  });

  // Last in the file: it moves the chain's clock a day forward, for good.
  test("a linked body whose guardian starts its dissolution: the next check reads it broken with winding_down, keeps it on the schedule, and shows no intent", async () => {
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
  });
});
