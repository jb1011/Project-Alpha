/**
 * THE SEAM THE FIRST TWO ROUNDS MISSED — `OnboardingRunner` + the real saga + real SQLite.
 *
 * N1 (2026-09-18 verification gate): the R1 reconcile was correct on its own and the runner's
 * failure record was correct on its own, and together they double-sent. The runner appended a
 * `fundTreasury`/`failed` row AFTER the saga's `unconfirmed` row, the reconcile read only the LAST
 * fund event, and so on the very first Retry it never ran: a second real transfer, with only one
 * of the two counted against the tenant's lifetime cap.
 *
 * The earlier tests could not see it because they called `runOnboarding` directly. These go
 * through the runner, which is what production does, and through a FILE-backed database, which is
 * what makes the restart case (N2) a real restart: a new process, a new repository, a new runner,
 * the same rows.
 *
 * Every assertion here is about one question: how many times did USDC leave the platform wallet?
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { sweepUnresolvedFunding } from "../../src/workflow/fundSubmissions";
import { runOnboarding } from "../../src/workflow/onboarding";
import { publicErrorMessage } from "../../src/workflow/publicError";
import { OnboardingRunner } from "../../src/workflow/runner";

const TENANT = "0x000000000000000000000000000000000000bBbb";
const USER_KEY = "Fund Agent";
const KEY = `${TENANT}:${USER_KEY}`;
const FIRST_TX = "0xfeed000000000000000000000000000000000000000000000000000000000001" as const;
const SECOND_TX = "0xbeef000000000000000000000000000000000000000000000000000000000002" as const;
const AMOUNT = 2_000_000n;

const spec = {
  name: USER_KEY,
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
} as unknown as AgentSpec;

const passkey = { challenge: "c", attestation: {} } as never;
const fakeSigner = {
  address: "0x000000000000000000000000000000000000cCcc",
  signWalletSet: async () => "0xsig",
} as unknown as OperatorSigner;

/** The documented prod condition: the transfer is broadcast, then the RPC throttles the receipt. */
const receiptThrottled = () =>
  new HttpRequestError({
    body: { method: "eth_getTransactionReceipt" },
    details: "rate limit exceeded",
    status: 429,
    url: "https://arc.example.com/v2/SECRETKEY123456",
  });

type Outcome = "success" | "reverted" | "unknown";

/**
 * A fake chain with the broadcast/confirm seam exposed SEPARATELY — which is the whole point of
 * the redesign: the hash exists (and is recorded) before anything waits for a receipt.
 */
function makeFakeArc(opts: { hashes?: string[]; confirm?: Outcome; receipt?: Outcome } = {}) {
  const hashes = [...(opts.hashes ?? [FIRST_TX])];
  const broadcastFundTreasury = vi.fn(async () => (hashes.shift() ?? SECOND_TX) as `0x${string}`);
  const confirmFundTreasury = vi.fn(async (txHash: `0x${string}`) => {
    const outcome = opts.confirm ?? "success";
    if (outcome === "unknown")
      throw new BroadcastUnconfirmedError(txHash, "fundTreasury", { cause: receiptThrottled() });
    if (outcome === "reverted")
      throw new Error(`fundTreasury: transaction ${txHash} reverted on chain`);
  });
  const receiptOutcome = vi.fn(async () => opts.receipt ?? "unknown");
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
    broadcastFundTreasury,
    confirmFundTreasury,
    receiptOutcome,
  };
  return arc as unknown as ArcAdapter & typeof arc;
}

let dir: string;
let dbPath: string;
let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;
let outflows: { kind: string; amount: bigint; ref: string | null }[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "legalbody-fundsub-"));
  dbPath = join(dir, "state.db");
  db = openDatabase(dbPath);
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(join(dir, "docs"));
  outflows = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The saga wiring a runner gets in `api/main.ts`, with this test's chain and meter. */
function makeRunner(arc: ArcAdapter, over: { repo?: SqliteEntityRepository } = {}) {
  const r = over.repo ?? repo;
  return new OnboardingRunner({
    repo: r,
    runSaga: ((i: { fundAmount?: bigint }) =>
      runOnboarding({
        spec,
        idempotencyKey: KEY,
        repo: r,
        docStore,
        arc,
        operatorSigner: fakeSigner,
        usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
        ownerTenantId: TENANT,
        specJson: JSON.stringify(spec),
        metadataBaseUrl: "https://host.example/backend",
        fundAmount: i.fundAmount,
        outflows: {
          record: (kind: "fund_treasury", amount: bigint, ref: string | null) =>
            outflows.push({ kind, amount, ref }),
        },
      } as never)) as never,
    fundCaps: { perCall: 10_000_000n, perTenantTotal: 100_000_000n },
  });
}

/** Drive a fresh agent to `bound` through the real runner, exactly as the wizard does. */
async function onboard(arc: ArcAdapter) {
  const runner = makeRunner(arc);
  runner.start({ spec, userKey: USER_KEY, tenantId: TENANT, guardianPasskey: passkey });
  await runner.settled();
  expect(repo.findByIdempotencyKey(KEY)?.status).toBe("bound");
}

const fundEvents = (r: SqliteEntityRepository = repo) =>
  r.listEvents(KEY).filter((e) => e.step === "fundTreasury");
const fundEventShape = (r: SqliteEntityRepository = repo) =>
  fundEvents(r).map((e) => `${e.status}:${e.txHash ?? "-"}`);

/** The first attempt: broadcast lands, the receipt read is throttled. */
async function attemptOneUnconfirmed() {
  const arc = makeFakeArc({ confirm: "unknown" });
  const runner = makeRunner(arc);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();
  expect(arc.broadcastFundTreasury).toHaveBeenCalledTimes(1);
  return arc;
}

test("the hash is durable BEFORE the receipt wait — N2's restart window is closed", async () => {
  await onboard(makeFakeArc());
  const arc = await attemptOneUnconfirmed();

  // The `submitted` row is written between the broadcast and the confirm, so a process that dies
  // inside the receipt wait still leaves the hash behind. (Order proves it: the confirm ran after
  // a row that names the hash it was confirming.)
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
  expect(JSON.parse(fundEvents()[0]!.detail!)).toMatchObject({ amount: AMOUNT.toString() });
  expect(arc.confirmFundTreasury).toHaveBeenCalledWith(FIRST_TX);

  // ⚠ NO `failed` event for an unconfirmed broadcast: it is not a settled failure, and a `failed`
  // row here is exactly what masked the reconcile in N1.
  expect(fundEvents().some((e) => e.status === "failed")).toBe(false);

  // The row still carries the honest sentence for the wizard.
  expect(repo.findByIdempotencyKey(KEY)?.error).toContain("The transfer was sent (0xfeed…0001)");
  expect(repo.findByIdempotencyKey(KEY)?.status).toBe("bound");
  // The S5 meter counted the money as gone, once.
  expect(outflows).toEqual([{ kind: "fund_treasury", amount: AMOUNT, ref: FIRST_TX }]);
});

test("N1 THE DOUBLE SEND: a retry after an unconfirmed broadcast sends NOTHING", async () => {
  await onboard(makeFakeArc());
  await attemptOneUnconfirmed();

  // The founder presses Retry. The RPC is healthy again and the first transfer HAD landed.
  const arc2 = makeFakeArc({ receipt: "success", hashes: [SECOND_TX] });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  // ⚠ THE ASSERTION THE WHOLE FINDING IS ABOUT.
  expect(arc2.broadcastFundTreasury).not.toHaveBeenCalled();
  expect(arc2.receiptOutcome).toHaveBeenCalledWith(FIRST_TX);

  const row = repo.findByIdempotencyKey(KEY)!;
  expect(row.status).toBe("funded");
  expect(row.fundTxHash).toBe(FIRST_TX);
  expect(row.error).toBeNull();
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`, `funded:${FIRST_TX}`]);
  // Money left the platform wallet once, and is counted once, in both meters.
  expect(outflows).toHaveLength(1);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);
});

test("N1 defence in depth: a `failed` row after the submission does not hide it", async () => {
  // The literal N1 mechanism. Even with a settled-looking row appended afterwards — by a future
  // writer, or by a saga that threw for an unrelated reason — resolution is keyed by HASH, never
  // by recency.
  await onboard(makeFakeArc());
  await attemptOneUnconfirmed();
  repo.recordEvent(KEY, "fundTreasury", "failed", null, JSON.stringify({ error: "noise" }));

  const arc2 = makeFakeArc({ receipt: "success", hashes: [SECOND_TX] });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(arc2.broadcastFundTreasury).not.toHaveBeenCalled();
  expect(repo.findByIdempotencyKey(KEY)?.fundTxHash).toBe(FIRST_TX);
});

test("N2 A RESTART heals itself: a new process over the same database sends nothing", async () => {
  await onboard(makeFakeArc());
  await attemptOneUnconfirmed();

  // ── The restart. New connection, new repository, new runner: the only thing that survives is
  //    what was written to disk.
  db.close();
  const db2 = openDatabase(dbPath);
  migrate(db2);
  const repo2 = new SqliteEntityRepository(db2);
  try {
    expect(fundEventShape(repo2)).toEqual([`submitted:${FIRST_TX}`]);

    // The boot sweep, as `api/main.ts` runs it after the socket opens.
    const arcBoot = makeFakeArc({ receipt: "success" });
    const swept = await sweepUnresolvedFunding({ repo: repo2, arc: arcBoot });

    expect(swept).toEqual({ checked: 1, finalised: 1, reverted: 0, unresolved: 0 });
    expect(arcBoot.broadcastFundTreasury).not.toHaveBeenCalled();
    const row = repo2.findByIdempotencyKey(KEY)!;
    expect(row.status).toBe("funded");
    expect(row.fundTxHash).toBe(FIRST_TX);
    expect(row.error).toBeNull();
    expect(fundEventShape(repo2)).toEqual([`submitted:${FIRST_TX}`, `funded:${FIRST_TX}`]);
    // No user retry was needed, and no second transfer exists to count.
    expect(repo2.sumFundedByTenant(TENANT)).toBe(AMOUNT);
  } finally {
    db2.close();
  }
});

test("N2: a restart followed by a user retry still sends nothing", async () => {
  // The same restart, but the founder gets there before the sweep does.
  await onboard(makeFakeArc());
  await attemptOneUnconfirmed();

  const arc2 = makeFakeArc({ receipt: "success", hashes: [SECOND_TX] });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(arc2.broadcastFundTreasury).not.toHaveBeenCalled();
  expect(repo.findByIdempotencyKey(KEY)?.fundTxHash).toBe(FIRST_TX);
});

test("a REVERTED previous submission allows exactly one new send", async () => {
  await onboard(makeFakeArc());
  await attemptOneUnconfirmed();

  const arc2 = makeFakeArc({ receipt: "reverted", hashes: [SECOND_TX] });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  // Settled and it moved nothing, so re-sending is correct — and it happens exactly once.
  expect(arc2.broadcastFundTreasury).toHaveBeenCalledTimes(1);
  expect(fundEventShape()).toEqual([
    `submitted:${FIRST_TX}`,
    `reverted:${FIRST_TX}`,
    `submitted:${SECOND_TX}`,
    `funded:${SECOND_TX}`,
  ]);
  expect(repo.findByIdempotencyKey(KEY)?.fundTxHash).toBe(SECOND_TX);
  // The reverted transfer is no longer counted against the tenant's cap…
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);
  // …but BOTH broadcasts are in the S5 rolling meter. Accepted, documented bias: the meter is a
  // rate brake on what we ASKED the chain to move, and it fails safe by over-counting.
  expect(outflows).toHaveLength(2);
});

test("a receipt we still cannot read REFUSES, and sends nothing", async () => {
  await onboard(makeFakeArc());
  await attemptOneUnconfirmed();

  const arc2 = makeFakeArc({ receipt: "unknown", hashes: [SECOND_TX] });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(arc2.broadcastFundTreasury).not.toHaveBeenCalled();
  const row = repo.findByIdempotencyKey(KEY)!;
  expect(row.status).toBe("bound");
  expect(row.error).toContain("A previous transfer (0xfeed…0001)");
  expect(row.error).toContain("nothing new was sent");
  // Still exactly one submission and one outflow: the refusal is not an event of its own.
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
  expect(outflows).toHaveLength(1);
  // …and the refusal is not recorded as a fund FAILURE either.
  expect(fundEvents().some((e) => e.status === "failed")).toBe(false);
});

test("the tenant's lifetime cap counts an unresolved submission — money presumed moved", async () => {
  // The cap bypass the gate found: an unconfirmed transfer that probably moved USDC consumed zero
  // quota until somebody retried, and nothing at all if nobody did. `sumFundedByTenant` therefore
  // counts a submission until it is settled as `reverted`.
  await onboard(makeFakeArc());
  await attemptOneUnconfirmed();

  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);

  // The cap is enforced against that figure, so a second fund beyond it is refused at the door.
  const capped = new OnboardingRunner({
    repo,
    runSaga: (async () => repo.findByIdempotencyKey(KEY)!) as never,
    fundCaps: { perCall: 10_000_000n, perTenantTotal: AMOUNT },
  });
  expect(() => capped.fund({ id: KEY, tenantId: TENANT, amount: 1n })).toThrowError(
    expect.objectContaining({ code: "limit_exceeded" }),
  );
});

test("a settled submission stops being counted twice", async () => {
  // `funded` carries the same hash as its `submitted`, so the submission resolves rather than
  // adding a second amount — the quota must not double-count the happy path.
  await onboard(makeFakeArc());
  const runner = makeRunner(makeFakeArc({ confirm: "success" }));
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`, `funded:${FIRST_TX}`]);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);
  expect(outflows).toHaveLength(1);
});

test("a pre-broadcast failure records no submission and no outflow", async () => {
  // The 2026-09-14 shape: `simulateContract` refuses before anything is sent. Nothing may be
  // recorded as submitted, the S5 meter must not move, and this one IS a fund failure.
  await onboard(makeFakeArc());
  const arc = makeFakeArc();
  arc.broadcastFundTreasury.mockRejectedValue(
    new Error("execution reverted: ERC20: transfer amount exceeds balance"),
  );
  const runner = makeRunner(arc);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(fundEventShape()).toEqual(["failed:-"]);
  expect(outflows).toEqual([]);
  expect(repo.sumFundedByTenant(TENANT)).toBe(0n);
  expect(repo.findByIdempotencyKey(KEY)?.error).toContain(
    "The platform funding wallet cannot cover this transfer right now.",
  );
});

test("the boot sweep is a no-op when nothing is unresolved, and never guesses", async () => {
  await onboard(makeFakeArc());
  const arc = makeFakeArc({ confirm: "success" });
  const runner = makeRunner(arc);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  const arcBoot = makeFakeArc({ receipt: "unknown" });
  expect(await sweepUnresolvedFunding({ repo, arc: arcBoot })).toEqual({
    checked: 0,
    finalised: 0,
    reverted: 0,
    unresolved: 0,
  });
  expect(arcBoot.receiptOutcome).not.toHaveBeenCalled();
});

test("the boot sweep leaves an unreadable receipt alone for next time", async () => {
  await onboard(makeFakeArc());
  await attemptOneUnconfirmed();

  const arcBoot = makeFakeArc({ receipt: "unknown" });
  expect(await sweepUnresolvedFunding({ repo, arc: arcBoot })).toEqual({
    checked: 1,
    finalised: 0,
    reverted: 0,
    unresolved: 1,
  });
  // Untouched: still one submission, still unresolved, still counted against the cap.
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);
});

test("the public sentences survive the round trip through the runner", async () => {
  // What the wizard actually renders, read off the persisted row rather than from the thrower.
  await onboard(makeFakeArc());
  await attemptOneUnconfirmed();
  const stored = repo.findByIdempotencyKey(KEY)!.error!;
  expect(stored).toMatch(
    /^The transfer was sent \(0xfeed…0001\) but we could not confirm it yet\. Do not retry: it will appear on the dashboard once confirmed\. \(ref [0-9a-f]{8}\)$/,
  );
  expect(stored).not.toContain("SECRETKEY123456");
  expect(stored).not.toContain("Nothing was sent");
  // …and the two typed errors keep their own sentences.
  expect(publicErrorMessage(new PriorTransferUnconfirmedError(FIRST_TX))).toContain(
    "nothing new was sent",
  );
});
