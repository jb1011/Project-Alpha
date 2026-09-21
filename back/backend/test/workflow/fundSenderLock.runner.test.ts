/**
 * TWO FUNDS AT ONCE, THROUGH THE REAL PATHS — `OnboardingRunner` + the real saga + the real
 * `ArcAdapter` + a real viem wallet + file-backed SQLite. The only fake is the node.
 *
 * The defect: two entities funded in the same moment each asked the node "what nonce next?", got
 * the same answer, and signed the same nonce. One transfer landed and the other was rejected or
 * replaced — recorded and recoverable since the submission ledger (`workflow/fundSubmissions.ts`),
 * but a ten-minute wait for the founder either way.
 *
 * The wallet is a REAL `privateKeyToAccount` over a fake transport, not a mock: the nonce has to
 * end up in the signed bytes, and the assertions read it back out of them. The key below is a
 * published test key (anvil's account #1) and signs nothing outside this file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  keccak256,
  parseTransaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { resetSenderNonces } from "../../src/adapters/arc/senderLock";
import type { OperatorSigner } from "../../src/adapters/turnkey/signer";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import { runOnboarding } from "../../src/workflow/onboarding";
import { OnboardingRunner } from "../../src/workflow/runner";

const TENANT = "0x000000000000000000000000000000000000bBbb";
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const AMOUNT = 2_000_000n;
/** anvil's well-known account #1 — a published test key. */
const TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const account = privateKeyToAccount(TEST_KEY);

const chain = defineChain({
  id: 31_337,
  name: "fake",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://node.invalid"] } },
});

const specFor = (name: string) =>
  ({
    name,
    jurisdiction: "Wyoming-DAO-LLC",
    roles: {
      manager: "0x000000000000000000000000000000000000aAaa",
      guardian: TENANT,
      operator: "0x000000000000000000000000000000000000cCcc",
    },
    treasury: {
      payoutAddress: "0x000000000000000000000000000000000000dDdd",
      spendingCapUsdc: "100.00",
      spendingPeriod: "24h",
      allowlistEnabled: false,
    },
    governance: { amendmentDelay: "24h" },
    legal: {},
    metadata: {},
  }) as unknown as AgentSpec;

const passkey = { challenge: "c", attestation: {} } as never;
const fakeSigner = {
  address: "0x000000000000000000000000000000000000cCcc",
  signWalletSet: async () => "0xsig",
} as unknown as OperatorSigner;

/**
 * A node that answers the handful of calls the fund path makes, and — the point of the whole file —
 * answers `eth_getTransactionCount` from what it has actually ACCEPTED.
 *
 * `stale: true` freezes that answer at 0 for the whole run: the load-balanced-RPC shape, where the
 * replica serving the second read has not seen the first transaction. Under it, a nonce taken from
 * the node alone is the SAME nonce twice.
 */
function fakeNode(opts: { stale?: boolean } = {}) {
  const accepted: { nonce: number; hash: Hex }[] = [];
  /** Every send, so a test can prove nothing was broadcast twice. */
  const raw: Hex[] = [];
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case "eth_chainId":
        return "0x7a69";
      case "eth_blockNumber":
        return "0x1";
      case "eth_getBlockByNumber":
        return { number: "0x1", baseFeePerGas: "0x1", timestamp: "0x1", transactions: [] };
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_gasPrice":
        return "0x2";
      case "eth_getTransactionCount":
        return `0x${(opts.stale ? 0 : accepted.length).toString(16)}`;
      // The transfer's pre-flight `simulateContract`: ERC-20 `transfer` returning true.
      case "eth_call":
        return `0x${"0".repeat(63)}1`;
      case "eth_estimateGas":
        return "0xdbba0";
      case "eth_sendRawTransaction": {
        const serialized = (params as Hex[])[0]!;
        const tx = parseTransaction(serialized);
        const hash = keccak256(serialized);
        // A node REFUSES a nonce it has already taken — the fact the old code discovered the hard
        // way, and the reason this file exists.
        if (accepted.some((a) => a.nonce === tx.nonce))
          throw new Error(`nonce ${tx.nonce} already known`);
        accepted.push({ nonce: tx.nonce!, hash });
        raw.push(serialized);
        return hash;
      }
      case "eth_getTransactionReceipt": {
        const hash = (params as Hex[])[0]!;
        if (!accepted.some((a) => a.hash === hash)) return null;
        return {
          transactionHash: hash,
          status: "0x1",
          blockNumber: "0x1",
          blockHash: `0x${"11".repeat(32)}`,
          transactionIndex: "0x0",
          from: account.address,
          to: USDC,
          cumulativeGasUsed: "0x1",
          gasUsed: "0x1",
          logs: [],
          logsBloom: `0x${"0".repeat(512)}`,
          type: "0x2",
          effectiveGasPrice: "0x1",
          contractAddress: null,
        };
      }
      default:
        throw new Error(`unexpected RPC call ${method}`);
    }
  });
  const transport = custom({ request: request as never });
  const adapter = new ArcAdapter({
    publicClient: createPublicClient({ chain, transport }),
    managerWallet: createWalletClient({ account, chain, transport }),
    chainId: chain.id,
    factory: "0x0000000000000000000000000000000000000001" as Address,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
  });
  return { adapter, accepted, raw };
}

/** The fake chain the ONBOARDING steps run against — this file is about the fund step only. */
function fakeOnboardArc(treasury: Address) {
  return {
    chainId: chain.id,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
    broadcastCreateEntity: vi.fn(async () => "0xcreate1" as Hex),
    confirmCreateEntity: vi.fn(async (txHash: string) => ({
      agentId: 7n,
      proxy: "0x0000000000000000000000000000000000000abc" as Address,
      treasury,
      txHash: txHash as Hex,
    })),
    setAgentWallet: vi.fn(async () => "0xbind" as Hex),
    walletSetDeadline: vi.fn(async () => 9_999_999_999n),
    eip712Domain: vi.fn(async () => ({ name: "Reg", version: "1" })),
  } as unknown as ArcAdapter;
}

let dir: string;
let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;

beforeEach(() => {
  resetSenderNonces();
  dir = mkdtempSync(join(tmpdir(), "legalbody-sendlock-"));
  db = openDatabase(join(dir, "state.db"));
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(join(dir, "docs"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeRunner(arcFor: (key: string) => ArcAdapter) {
  return new OnboardingRunner({
    repo,
    runSaga: ((i: { idempotencyKey: string; spec: AgentSpec; fundAmount?: bigint }) =>
      runOnboarding({
        spec: i.spec,
        idempotencyKey: i.idempotencyKey,
        repo,
        docStore,
        arc: arcFor(i.idempotencyKey),
        operatorSigner: fakeSigner,
        usdc: USDC,
        ownerTenantId: TENANT,
        specJson: JSON.stringify(i.spec),
        metadataBaseUrl: "https://host.example/backend",
        fundAmount: i.fundAmount,
      } as never)) as never,
    fundCaps: { perCall: 10_000_000n, perTenantTotal: 100_000_000n },
  });
}

/** Drive two agents to `bound`, exactly as the wizard does, and hand back their keys. */
async function onboardTwo(): Promise<[string, string]> {
  const treasuries = {
    A: "0x00000000000000000000000000000000000000a1" as Address,
    B: "0x00000000000000000000000000000000000000b2" as Address,
  };
  const runner = makeRunner((key) =>
    fakeOnboardArc(key.endsWith("A") ? treasuries.A : treasuries.B),
  );
  const keys = ["Agent A", "Agent B"].map(
    (name) =>
      runner.start({
        spec: specFor(name),
        userKey: name,
        tenantId: TENANT,
        guardianPasskey: passkey,
      }).id,
  );
  await runner.settled();
  for (const key of keys) expect(repo.findByIdempotencyKey(key)?.status).toBe("bound");
  return [keys[0]!, keys[1]!];
}

/** The nonces the node accepted, read back out of the signed bytes. */
const nonces = (raw: Hex[]) => raw.map((r) => parseTransaction(r).nonce);

test("two entities funded AT ONCE get two nonces, and both are funded", async () => {
  const [a, b] = await onboardTwo();
  const node = fakeNode();
  const runner = makeRunner(() => node.adapter);

  runner.fund({ id: a, tenantId: TENANT, amount: AMOUNT });
  runner.fund({ id: b, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(nonces(node.raw)).toEqual([0, 1]);
  expect(repo.findByIdempotencyKey(a)?.status).toBe("funded");
  expect(repo.findByIdempotencyKey(b)?.status).toBe("funded");
  expect(repo.findByIdempotencyKey(a)?.error).toBeNull();
  expect(repo.findByIdempotencyKey(b)?.error).toBeNull();
  // Two submissions, two distinct nonces on the rows, both settled.
  const submitted = [a, b].flatMap((k) =>
    repo.listEvents(k).filter((e) => e.step === "fundTreasury" && e.status === "submitted"),
  );
  expect(submitted).toHaveLength(2);
  expect(new Set(submitted.map((e) => JSON.parse(e.detail!).nonce)).size).toBe(2);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT * 2n);
});

test("…even when the node's nonce read is STALE for the whole run", async () => {
  // Serialising the sends is not enough on its own: a replica that has not seen the first transfer
  // answers the same count to the second, so the floor is what keeps the two apart.
  const [a, b] = await onboardTwo();
  const node = fakeNode({ stale: true });
  const runner = makeRunner(() => node.adapter);

  runner.fund({ id: a, tenantId: TENANT, amount: AMOUNT });
  runner.fund({ id: b, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(nonces(node.raw)).toEqual([0, 1]);
  expect(repo.findByIdempotencyKey(a)?.status).toBe("funded");
  expect(repo.findByIdempotencyKey(b)?.status).toBe("funded");
});

test("a fund racing a MANAGER CALL from the same key: distinct nonces, neither refused", async () => {
  // The other half of the report: a top-up and a metadata write (any role-gated manager call) are
  // the same key's transactions, so they compete for the same nonces.
  const [a] = await onboardTwo();
  const node = fakeNode({ stale: true });
  const runner = makeRunner(() => node.adapter);

  runner.fund({ id: a, tenantId: TENANT, amount: AMOUNT });
  const managerCall = node.adapter.setAgentMetadata(
    7n,
    "ens",
    "0xabcd",
    "0x000000000000000000000000000000000000aAaa" as Address,
  );
  await runner.settled();
  await expect(managerCall).resolves.toMatch(/^0x/);

  expect(node.accepted.map((x) => x.nonce).sort()).toEqual([0, 1]);
  expect(repo.findByIdempotencyKey(a)?.status).toBe("funded");
});
