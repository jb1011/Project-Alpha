import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import type { OperatorSigner } from "../../src/adapters/turnkey/signer";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import { runOnboarding } from "../../src/workflow/onboarding";

// Legacy (no-passkey) saga path, structural fake arc — the point is the create->persist WINDOW:
// the saga must persist the broadcast tx hash at status 'translating' BEFORE confirming, then ADOPT
// that tx on resume instead of broadcasting a second mint. No chain; that's covered by the int tests.
const spec = {
  name: "Window Agent",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: {
    manager: "0x000000000000000000000000000000000000aAaa",
    guardian: "0x000000000000000000000000000000000000bBbb",
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
} as unknown as AgentSpec;

const fakeSigner = {
  address: "0x000000000000000000000000000000000000cCcc",
  signWalletSet: async () => "0xsig",
} as unknown as OperatorSigner;

/** Fake arc exposing the broadcast/confirm seam. `confirmFails` makes the FIRST confirm throw once. */
function makeFakeArc(opts: { confirmFails?: boolean; broadcastFails?: boolean } = {}) {
  let confirmShouldFail = opts.confirmFails ?? false;
  let broadcastShouldFail = opts.broadcastFails ?? false;
  let nextTx = 0;
  const broadcastCreateEntity = vi.fn(async () => {
    if (broadcastShouldFail) {
      broadcastShouldFail = false;
      throw new Error("simulated broadcast crash");
    }
    return `0xcreate${nextTx++}` as `0x${string}`;
  });
  const confirmCreateEntity = vi.fn(async (txHash: string) => {
    if (confirmShouldFail) {
      confirmShouldFail = false;
      throw new Error("simulated confirm crash");
    }
    return {
      agentId: 7n,
      proxy: "0x0000000000000000000000000000000000000abc" as const,
      treasury: "0x0000000000000000000000000000000000000def" as const,
      txHash: txHash as `0x${string}`,
    };
  });
  const arc = {
    chainId: 31337,
    identityRegistry: "0x0000000000000000000000000000000000000001" as const,
    broadcastCreateEntity,
    confirmCreateEntity,
    setAgentWallet: vi.fn(async () => "0xbind" as const),
    walletSetDeadline: vi.fn(async () => 9_999_999_999n),
    eip712Domain: vi.fn(async () => ({ name: "Reg", version: "1" })),
  };
  return arc as unknown as ArcAdapter & typeof arc;
}

let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(`/tmp/legalbody-window-${Math.floor(performance.now())}`);
});
afterEach(() => db.close());

const deps = (arc: ArcAdapter) => ({
  spec,
  idempotencyKey: "win-A",
  repo,
  docStore,
  arc,
  operatorSigner: fakeSigner,
  usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
  ownerTenantId: "t1",
  specJson: JSON.stringify(spec),
  metadataBaseUrl: "https://host.example/backend",
});

test("happy path: broadcasts once, persists the create tx hash, ends bound", async () => {
  const arc = makeFakeArc();
  const rec = await runOnboarding(deps(arc));

  expect(rec.status).toBe("bound");
  expect(rec.agentId).toBe("7");
  expect(arc.broadcastCreateEntity).toHaveBeenCalledTimes(1);
  expect(arc.confirmCreateEntity).toHaveBeenCalledTimes(1);
  // the create tx hash is persisted on the final record (and was written at the 'translating' step).
  expect(rec.createTxHash).toBe("0xcreate0");
  expect(repo.findByIdempotencyKey("win-A")?.createTxHash).toBe("0xcreate0");
  // Public metadataURI: minted publicId, not a file:// path, and matches what was broadcast on-chain.
  expect(rec.metadataURI).toMatch(/^https:\/\/host\.example\/backend\/metadata\/[0-9a-f-]{36}$/);
  expect(rec.metadataURI).not.toContain("file://");
  expect(rec.publicId).toBeTruthy();
  expect(arc.broadcastCreateEntity).toHaveBeenCalledWith(
    expect.objectContaining({ metadataURI: rec.metadataURI }),
  );
});

test("keystone: a crash between broadcast and confirm resumes by ADOPTING the tx, never re-minting", async () => {
  const arc = makeFakeArc({ confirmFails: true });

  // First run: broadcast persists the hash, then confirm throws. The saga leaves the record at
  // 'translating' WITH the create tx hash set and agentId still null — the mid-window state.
  await expect(runOnboarding(deps(arc))).rejects.toThrow(/simulated confirm crash/);
  const mid = repo.findByIdempotencyKey("win-A");
  expect(mid?.status).toBe("translating");
  expect(mid?.createTxHash).toBe("0xcreate0"); // persisted BEFORE confirm
  expect(mid?.agentId).toBeNull();
  expect(arc.broadcastCreateEntity).toHaveBeenCalledTimes(1);

  // Resume: the persisted hash is adopted (confirm re-reads it). No SECOND broadcast => no second
  // agentId. Exactly one broadcast across both runs; confirm ran twice (failed, then succeeded).
  const rec = await runOnboarding(deps(arc));
  expect(rec.status).toBe("bound");
  expect(rec.agentId).toBe("7");
  expect(rec.createTxHash).toBe("0xcreate0");
  expect(arc.broadcastCreateEntity).toHaveBeenCalledTimes(1); // STILL one — adopted, not re-minted
  expect(arc.confirmCreateEntity).toHaveBeenCalledTimes(2);
});

test("broadcast failure persists NO tx hash; retry mints fresh (never a false adopt)", async () => {
  const arc = makeFakeArc({ broadcastFails: true });

  // First run: broadcast itself throws (the tx was never sent). There is nothing to adopt, so the
  // record must NOT carry a create tx hash — otherwise resume would 'confirm' a tx that never existed.
  await expect(runOnboarding(deps(arc))).rejects.toThrow(/simulated broadcast crash/);
  const mid = repo.findByIdempotencyKey("win-A");
  expect(mid?.status).toBe("translating");
  expect(mid?.createTxHash).toBeNull();
  expect(arc.confirmCreateEntity).not.toHaveBeenCalled();

  // Retry: broadcasts a fresh tx and proceeds. Two broadcast attempts total (one threw, one stuck).
  const rec = await runOnboarding(deps(arc));
  expect(rec.status).toBe("bound");
  expect(rec.createTxHash).toBe("0xcreate0");
  expect(arc.broadcastCreateEntity).toHaveBeenCalledTimes(2);
});
