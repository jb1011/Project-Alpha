/**
 * R1 (Critical, 2026-09-17 review) — the saga half: a broadcast we could not confirm is a FACT ON
 * THE TRAIL, and the next attempt resolves it by receipt instead of sending again.
 *
 * The failure this prevents, end to end: the platform transfer is mined, the receipt poll 429s,
 * the wizard shows an error, the founder presses the new Retry button, and a SECOND transfer of
 * the same amount leaves the platform wallet — uncounted by the S5 ceiling, because
 * `outflows.record` sat after the await.
 *
 * Structural fake arc, no chain (the anvil tests cover the real receipt path).
 */
import type Database from "better-sqlite3";
import { HttpRequestError } from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import type { OperatorSigner } from "../../src/adapters/turnkey/signer";
import { BroadcastUnconfirmedError, PriorTransferUnconfirmedError } from "../../src/errors";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import { runOnboarding } from "../../src/workflow/onboarding";
import { publicErrorMessage } from "../../src/workflow/publicError";

const KEY = "fund-A";
const FUND_TX = "0xfeed000000000000000000000000000000000000000000000000000000000001" as const;

const spec = {
  name: "Fund Agent",
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

/** The prod condition: the Canteen key throttling a receipt poll, wrapped as the adapter now does. */
const unconfirmed = () =>
  new BroadcastUnconfirmedError(FUND_TX, "fundTreasury", {
    cause: new HttpRequestError({
      body: { method: "eth_getTransactionReceipt" },
      details: "rate limit exceeded",
      status: 429,
      url: "https://arc.example.com/v2/SECRETKEY123456",
    }),
  });

function makeFakeArc(
  opts: {
    /** Broadcast, then fail to READ the receipt — the prod 429 shape. */
    unconfirmed?: boolean;
    hash?: `0x${string}`;
    outcome?: "success" | "reverted" | "unknown";
  } = {},
) {
  // The seam the saga uses: the hash is ours (and recorded) before anything is sent.
  // Prepared before the send lock is taken; the signature happens inside it.
  const prepareFundTreasury = vi.fn(async (p: unknown) => p);
  const signFundTreasury = vi.fn(async () => ({
    rawTx: "0xrawtx" as `0x${string}`,
    txHash: opts.hash ?? FUND_TX,
    nonce: 3,
  }));
  const sendRawFundTreasury = vi.fn(async () => opts.hash ?? FUND_TX);
  const confirmFundTreasury = vi.fn(async (txHash: `0x${string}`) => {
    if (opts.unconfirmed) throw unconfirmed();
    return txHash;
  });
  const receiptOutcome = vi.fn(async () => opts.outcome ?? "unknown");
  // High enough that an unreadable receipt reads as "still pending" rather than "dropped", which
  // is the state these tests are about.
  const platformNonce = vi.fn(async () => 0);
  const arc = {
    chainId: 31337,
    identityRegistry: "0x0000000000000000000000000000000000000001" as const,
    broadcastCreateEntity: vi.fn(async () => "0xcreate1" as `0x${string}`),
    confirmCreateEntity: vi.fn(async (txHash: string) => ({
      agentId: 7n,
      proxy: "0x0000000000000000000000000000000000000abc" as const,
      treasury: "0x0000000000000000000000000000000000000def" as const,
      txHash: txHash as `0x${string}`,
    })),
    setAgentWallet: vi.fn(async () => "0xbind" as const),
    walletSetDeadline: vi.fn(async () => 9_999_999_999n),
    eip712Domain: vi.fn(async () => ({ name: "Reg", version: "1" })),
    prepareFundTreasury,
    signFundTreasury,
    sendRawFundTreasury,
    confirmFundTreasury,
    receiptOutcome,
    platformNonce,
  };
  return arc as unknown as ArcAdapter & typeof arc;
}

let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;
let recorded: { kind: string; amount: bigint; txHash: string }[];
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(`/tmp/legalbody-fundrec-${Math.floor(performance.now())}`);
  recorded = [];
});
afterEach(() => db.close());

const deps = (arc: ArcAdapter, fundAmount?: bigint) => ({
  spec,
  idempotencyKey: KEY,
  repo,
  docStore,
  arc,
  operatorSigner: fakeSigner,
  usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
  ownerTenantId: "t1",
  specJson: JSON.stringify(spec),
  metadataBaseUrl: "https://host.example/backend",
  fundAmount,
  outflows: {
    record: (kind: string, amount: bigint, txHash: string) =>
      recorded.push({ kind, amount, txHash }),
  },
});

const fundEvents = () => repo.listEvents(KEY).filter((e) => e.step === "fundTreasury");

test("an unconfirmed broadcast is recorded WITH its hash, the outflow is counted, and it rethrows", async () => {
  const arc = makeFakeArc({ unconfirmed: true });

  const err = await runOnboarding(deps(arc, 2_000_000n)).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BroadcastUnconfirmedError);

  // (b) The trail carries the hash, so the next attempt has something to reconcile.
  expect(fundEvents()).toHaveLength(1);
  expect(fundEvents()[0]!.status).toBe("submitted");
  expect(fundEvents()[0]!.txHash).toBe(FUND_TX);
  expect(JSON.parse(fundEvents()[0]!.detail!)).toMatchObject({ amount: "2000000" });

  // ⚠ The S5 ceiling counts it. `outflows.record` used to sit after the await, so a transfer that
  // may well have left the platform wallet was invisible to the brake — conservative is the only
  // safe direction for a ceiling.
  expect(recorded).toEqual([{ kind: "fund_treasury", amount: 2_000_000n, txHash: FUND_TX }]);

  // The entity is NOT funded (we do not know that yet) and the status has not moved.
  expect(repo.findByIdempotencyKey(KEY)?.status).toBe("bound");
  expect(repo.findByIdempotencyKey(KEY)?.fundTxHash).toBeNull();
  // ⚠ REVERSED by the 2026-09-18 gate, deliberately. This used to assert `0n` — "only a `funded`
  // event counts" — which meant a broadcast whose receipt we could not read consumed no quota at
  // all, and none ever if nobody retried. The lifetime cap is a brake on PLATFORM funds, so it
  // counts money we can no longer account for; a `reverted` settlement is what removes it again.
  expect(repo.sumFundedByTenant("t1")).toBe(2_000_000n);

  // …and what the founder is told never says nothing was sent.
  const message = publicErrorMessage(err);
  expect(message).toContain("The transfer was sent (0xfeed…0001)");
  expect(message).not.toContain("Nothing was sent");
  expect(message).not.toContain("SECRETKEY123456");
});

test("THE DOUBLE-SPEND GUARD: a since-mined transfer is adopted, not sent again", async () => {
  // First attempt: mined, receipt unreadable.
  const first = makeFakeArc({ unconfirmed: true });
  await expect(runOnboarding(deps(first, 2_000_000n))).rejects.toBeInstanceOf(
    BroadcastUnconfirmedError,
  );

  // Second attempt: the RPC is healthy again and the receipt says the transfer landed.
  const second = makeFakeArc({ outcome: "success" });
  const rec = await runOnboarding(deps(second, 2_000_000n));

  // ⚠ THE ASSERTION THE WHOLE FINDING IS ABOUT: no second transfer.
  expect(second.signFundTreasury).not.toHaveBeenCalled();
  expect(second.receiptOutcome).toHaveBeenCalledWith(FUND_TX);

  // The entity is finalised from the transfer that actually happened.
  expect(rec.status).toBe("funded");
  expect(rec.fundTxHash).toBe(FUND_TX);
  expect(rec.error).toBeNull();
  // The trail resolves the earlier `unconfirmed` row rather than replacing it.
  expect(fundEvents().map((e) => e.status)).toEqual(["submitted", "funded"]);
  expect(fundEvents()[1]!.txHash).toBe(FUND_TX);
  // The quota now counts the amount that really moved — once.
  expect(repo.sumFundedByTenant("t1")).toBe(2_000_000n);
  // …and the S5 ceiling counts it once too: the first attempt already recorded this transfer, so
  // adopting it must not record a second outflow for the same money.
  expect(recorded).toEqual([{ kind: "fund_treasury", amount: 2_000_000n, txHash: FUND_TX }]);
});

test("a previous transfer that REVERTED clears the way for a new send", async () => {
  const first = makeFakeArc({ unconfirmed: true });
  await expect(runOnboarding(deps(first, 2_000_000n))).rejects.toBeInstanceOf(
    BroadcastUnconfirmedError,
  );

  const second = makeFakeArc({ outcome: "reverted", hash: "0xnew" });
  const rec = await runOnboarding(deps(second, 2_000_000n));

  // Settled and moved nothing, so sending again is correct — and it is the only case that sends.
  expect(second.signFundTreasury).toHaveBeenCalledTimes(1);
  expect(rec.status).toBe("funded");
  expect(rec.fundTxHash).toBe("0xnew");
  expect(fundEvents().map((e) => e.status)).toEqual([
    "submitted",
    "reverted",
    "submitted",
    "funded",
  ]);
});

test("a receipt we still cannot read REFUSES, and says so without blaming anyone", async () => {
  const first = makeFakeArc({ unconfirmed: true });
  await expect(runOnboarding(deps(first, 2_000_000n))).rejects.toBeInstanceOf(
    BroadcastUnconfirmedError,
  );

  const second = makeFakeArc({ outcome: "unknown" });
  const err = await runOnboarding(deps(second, 2_000_000n)).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(PriorTransferUnconfirmedError);
  expect(second.signFundTreasury).not.toHaveBeenCalled();
  const message = publicErrorMessage(err);
  expect(message).toContain("A previous transfer (0xfeed…0001)");
  expect(message).toContain("nothing new was sent");
  // No SECOND outflow: the refusal sent nothing, so the only record is the first attempt's.
  expect(recorded).toHaveLength(1);
});

test("with no unconfirmed history, step 7 sends exactly once and records the outflow", async () => {
  const arc = makeFakeArc();
  const rec = await runOnboarding(deps(arc, 2_000_000n));
  expect(arc.receiptOutcome).not.toHaveBeenCalled();
  expect(arc.signFundTreasury).toHaveBeenCalledTimes(1);
  expect(rec.status).toBe("funded");
  expect(fundEvents().map((e) => e.status)).toEqual(["submitted", "funded"]);
  expect(recorded).toEqual([{ kind: "fund_treasury", amount: 2_000_000n, txHash: FUND_TX }]);
});

test("a RESOLVED unconfirmed row is not reconciled a second time", async () => {
  // Once a `funded` (or `reverted`) row follows it, the `unconfirmed` row is history. Only the
  // LAST fundTreasury event decides, or every later top-up would re-litigate an old hash.
  const arc = makeFakeArc();
  await runOnboarding(deps(arc, 1_000_000n));
  const again = makeFakeArc({ hash: "0xsecond" });
  await runOnboarding(deps(again, 1_000_000n));
  expect(again.receiptOutcome).not.toHaveBeenCalled();
  expect(again.signFundTreasury).toHaveBeenCalledTimes(1);
});
