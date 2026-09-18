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
import { finaliseFunded, sweepUnresolvedFunding } from "../../src/workflow/fundSubmissions";
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

type Outcome = "success" | "reverted" | "absent";

/**
 * A fake chain with the THREE-STEP seam the redesign needs: sign locally, send the raw bytes,
 * confirm the receipt. `signFundTreasury` is what mints a hash, so a hash exists — and is
 * recorded — before anything at all is sent.
 */
function makeFakeArc(
  opts: {
    hashes?: string[];
    nonce?: number;
    /** What `sendRawFundTreasury` does. "lost" and "refused" are indistinguishable HERE — that is
     *  the point: only the chain knows, and only a later receipt read can say. */
    send?: "ok" | "throws";
    confirm?: Outcome;
    /** What `receiptOutcome` answers. "throws" is the READ BREAKING — the documented prod
     *  condition, an Arc RPC 429 on `eth_getTransactionReceipt` — which is a different fact from a
     *  chain that definitively has no receipt. */
    receipt?: Outcome | "throws" | (Outcome | "throws")[];
    /** The platform account's MINED transaction count at "latest". */
    platformNonce?: number;
    /** Wall clock the age gate reads. */
    now?: () => number;
  } = {},
) {
  const hashes = [...(opts.hashes ?? [FIRST_TX])];
  let signed = 0;
  const signFundTreasury = vi.fn(async () => {
    const txHash = (hashes.shift() ?? SECOND_TX) as `0x${string}`;
    return {
      rawTx: `0xraw${txHash.slice(2, 10)}` as `0x${string}`,
      txHash,
      nonce: (opts.nonce ?? 7) + signed++,
    };
  });
  const sendRawFundTreasury = vi.fn(async (rawTx: `0x${string}`) => {
    if (opts.send === "throws") throw receiptThrottled();
    return `0x${rawTx.slice(5)}` as `0x${string}`;
  });
  const confirmFundTreasury = vi.fn(async (txHash: `0x${string}`) => {
    const outcome = opts.confirm ?? "success";
    if (outcome === "absent")
      throw new BroadcastUnconfirmedError(txHash, "fundTreasury", { cause: receiptThrottled() });
    if (outcome === "reverted")
      throw new Error(`fundTreasury: transaction ${txHash} reverted on chain`);
    return txHash;
  });
  // An array lets a test answer differently on the re-check the `dropped` rule makes.
  const receipts = Array.isArray(opts.receipt) ? [...opts.receipt] : undefined;
  const receiptOutcome = vi.fn(async () => {
    const answer = receipts ? (receipts.shift() ?? "absent") : (opts.receipt ?? "absent");
    // The adapter rethrows anything that is not a definitive absence; the resolution must then
    // refuse rather than guess.
    if (answer === "throws") throw receiptThrottled();
    return answer as Outcome;
  });
  const platformNonce = vi.fn(async () => opts.platformNonce ?? 0);
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
    signFundTreasury,
    sendRawFundTreasury,
    confirmFundTreasury,
    receiptOutcome,
    platformNonce,
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
function makeRunner(
  arc: ArcAdapter,
  over: { repo?: SqliteEntityRepository; now?: () => number } = {},
) {
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
        now: over.now,
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
  const arc = makeFakeArc({ confirm: "absent" });
  const runner = makeRunner(arc);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();
  expect(arc.signFundTreasury).toHaveBeenCalledTimes(1);
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
  expect(arc.sendRawFundTreasury).toHaveBeenCalledTimes(1);
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
  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
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

  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
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

    expect(swept).toEqual({
      checked: 1,
      finalised: 1,
      reverted: 0,
      dropped: 0,
      unresolved: 0,
      skipped: 0,
    });
    expect(arcBoot.signFundTreasury).not.toHaveBeenCalled();
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

  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
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
  expect(arc2.signFundTreasury).toHaveBeenCalledTimes(1);
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

  const arc2 = makeFakeArc({ receipt: "absent", hashes: [SECOND_TX] });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
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
  arc.signFundTreasury.mockRejectedValue(
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

  const arcBoot = makeFakeArc({ receipt: "absent" });
  expect(await sweepUnresolvedFunding({ repo, arc: arcBoot })).toEqual({
    checked: 0,
    finalised: 0,
    reverted: 0,
    dropped: 0,
    unresolved: 0,
    skipped: 0,
  });
  expect(arcBoot.receiptOutcome).not.toHaveBeenCalled();
});

test("the boot sweep leaves an unreadable receipt alone for next time", async () => {
  await onboard(makeFakeArc());
  await attemptOneUnconfirmed();

  const arcBoot = makeFakeArc({ receipt: "absent" });
  expect(await sweepUnresolvedFunding({ repo, arc: arcBoot })).toEqual({
    checked: 1,
    finalised: 0,
    reverted: 0,
    dropped: 0,
    unresolved: 1,
    skipped: 0,
  });
  // Untouched: still one submission, still unresolved, still counted against the cap.
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);
});

/* ── N4: the send's RESPONSE can be lost, and that is not "nothing was sent" ─────────────────── */

/** Sign, persist, then have the send throw. What the chain did is decided by the NEXT pass. */
async function attemptOneSendThrew(opts: { hashes?: string[]; nonce?: number } = {}) {
  const arc = makeFakeArc({ send: "throws", ...opts });
  const runner = makeRunner(arc);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();
  return arc;
}

test("N4: a send that throws still leaves a `submitted` row — the hash existed before the send", async () => {
  await onboard(makeFakeArc());
  const arc = await attemptOneSendThrew();

  // Signed locally, so the hash is ours before anything is on the wire; persisted before the send,
  // so a response lost AFTER the node accepted the transaction is still a recorded submission.
  expect(arc.signFundTreasury).toHaveBeenCalledTimes(1);
  expect(arc.sendRawFundTreasury).toHaveBeenCalledTimes(1);
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
  const detail = JSON.parse(fundEvents()[0]!.detail!);
  expect(detail).toMatchObject({ amount: AMOUNT.toString(), nonce: 7 });
  expect(detail.rawTx).toMatch(/^0xraw/);
  expect(outflows).toEqual([{ kind: "fund_treasury", amount: AMOUNT, ref: FIRST_TX }]);

  // ⚠ THE SENTENCE. It used to say "Nothing was sent" for exactly this case.
  const stored = repo.findByIdempotencyKey(KEY)!.error!;
  expect(stored).not.toContain("Nothing was sent");
  expect(stored).toContain("The transfer was sent (0xfeed…0001)");
});

test("N4 LOST RESPONSE: the node had it — the retry signs nothing, sends nothing, finalises", async () => {
  await onboard(makeFakeArc());
  await attemptOneSendThrew();

  // The transfer was mined all along; only our HTTP response went missing.
  const arc2 = makeFakeArc({ receipt: "success", hashes: [SECOND_TX] });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
  expect(arc2.sendRawFundTreasury).not.toHaveBeenCalled();
  const row = repo.findByIdempotencyKey(KEY)!;
  expect(row.status).toBe("funded");
  expect(row.fundTxHash).toBe(FIRST_TX);
  expect(outflows).toHaveLength(1);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);
});

test("N4 REFUSED SEND: the SAME raw tx is re-broadcast, never a second signature", async () => {
  // The other half of the indistinguishable pair: the node never accepted it. Re-sending the same
  // signed bytes is idempotent — at worst the node already has them. Signing AGAIN would build a
  // second transaction at a NEW nonce, which is how one transfer becomes two.
  await onboard(makeFakeArc());
  await attemptOneSendThrew();

  const arc2 = makeFakeArc({ receipt: "absent", platformNonce: 7, hashes: [SECOND_TX] });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  // ⚠ No new signature, and the re-broadcast carries the ORIGINAL bytes.
  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
  expect(arc2.sendRawFundTreasury).toHaveBeenCalledTimes(1);
  expect(arc2.sendRawFundTreasury.mock.calls[0]![0]).toMatch(/^0xraw/);
  // Still one submission, still unresolved, still refusing.
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
  expect(repo.findByIdempotencyKey(KEY)!.error).toContain("A previous transfer (0xfeed…0001)");
  expect(outflows).toHaveLength(1);
});

test("N6 DROPPED: the nonce moved past it and no receipt exists — one new send is allowed", async () => {
  // A transfer dropped from the mempool used to lock the entity out of funding forever, while
  // still consuming the tenant's quota. `latest` counts MINED transactions, so a higher count than
  // ours means the chain moved past our nonce without us.
  await onboard(makeFakeArc());
  await attemptOneSendThrew({ nonce: 7 });

  // receipt reads: the first is the normal check, the second is the re-check the rule insists on
  // before it calls a success a failure. Both absent => genuinely dropped.
  const arc2 = makeFakeArc({
    receipt: ["absent", "absent"],
    platformNonce: 9,
    hashes: [SECOND_TX],
  });
  // ⚠ And the age gate: `dropped` may not be concluded seconds after a broadcast. Eleven minutes
  // on, two definitive absences and an advanced nonce are finally enough.
  const runner = makeRunner(arc2, { now: () => Date.now() + 11 * 60_000 });
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(arc2.receiptOutcome).toHaveBeenCalledTimes(2);
  // Exactly ONE new send, and it is a NEW signature (the old bytes are dead — their nonce is used).
  expect(arc2.signFundTreasury).toHaveBeenCalledTimes(1);
  expect(arc2.sendRawFundTreasury).toHaveBeenCalledTimes(1);
  expect(fundEventShape()).toEqual([
    `submitted:${FIRST_TX}`,
    `dropped:${FIRST_TX}`,
    `submitted:${SECOND_TX}`,
    `funded:${SECOND_TX}`,
  ]);
  const row = repo.findByIdempotencyKey(KEY)!;
  expect(row.status).toBe("funded");
  expect(row.fundTxHash).toBe(SECOND_TX);
  // A dropped transfer moved nothing, so it stops consuming the tenant's quota…
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);
  // …but its S5 entry stays. That meter brakes on what we asked the chain to move, and it must
  // fail safe by over-counting rather than under-counting.
  expect(outflows).toHaveLength(2);
});

test("N6: a tx that mines DURING the drop check is adopted, not declared dropped", async () => {
  // The window the AgentBook reconciler guards with the same re-check: the nonce advanced because
  // OUR transaction mined, between the first receipt read and the nonce read.
  await onboard(makeFakeArc());
  await attemptOneSendThrew({ nonce: 7 });

  const arc2 = makeFakeArc({ receipt: ["absent", "success"], platformNonce: 9 });
  const runner = makeRunner(arc2, { now: () => Date.now() + 11 * 60_000 });
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
  expect(repo.findByIdempotencyKey(KEY)!.fundTxHash).toBe(FIRST_TX);
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`, `funded:${FIRST_TX}`]);
});

/* ── N8: "we could not ask" is NOT "the transaction is gone" ─────────────────────────────────── */

test("N8 PROD CONDITION: a THROTTLED receipt read never drops a transfer that mined", async () => {
  // The exact incident this branch exists for, and the one round 4 introduced a second transfer
  // into: Arc's RPC 429s `eth_getTransactionReceipt` while the cheaper `eth_getTransactionCount`
  // still answers — and the count HAS advanced, because our own transaction mined. Round 4 read
  // the throttle as "no receipt", called it `dropped`, and sent 2 USDC a second time.
  await onboard(makeFakeArc());
  await attemptOneSendThrew({ nonce: 7 });

  const arc2 = makeFakeArc({
    receipt: "throws",
    platformNonce: 9,
    hashes: [SECOND_TX],
    // Old enough that ONLY the read's brokenness is keeping it alive.
  });
  const runner = makeRunner(arc2, { now: () => Date.now() + 11 * 60_000 });
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  // ⚠ ZERO of everything that spends money.
  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
  expect(arc2.sendRawFundTreasury).not.toHaveBeenCalled();
  // No verdict was recorded either: a broken read settles nothing.
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
  expect(repo.findByIdempotencyKey(KEY)!.error).toContain("A previous transfer (0xfeed…0001)");
  expect(outflows).toHaveLength(1);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);
});

test("N8: a broken read does not even re-broadcast — we know nothing, so we do nothing", async () => {
  await onboard(makeFakeArc());
  await attemptOneSendThrew();

  const arc2 = makeFakeArc({ receipt: "throws", platformNonce: 0 });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(arc2.sendRawFundTreasury).not.toHaveBeenCalled();
  expect(arc2.platformNonce).not.toHaveBeenCalled();
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
});

test("N8 AGE GATE: a definitively absent receipt is re-broadcast, not dropped, while it is young", async () => {
  // The registrar's `STALE_AFTER_MS` rule, which round 4 omitted: the nonce test was applied on the
  // first pass, seconds after the broadcast, so a founder pressing Retry at 90 seconds was enough
  // to declare a pending transaction dead.
  await onboard(makeFakeArc());
  await attemptOneSendThrew({ nonce: 7 });

  const arc2 = makeFakeArc({
    receipt: ["absent", "absent"],
    platformNonce: 9,
    hashes: [SECOND_TX],
  });
  const runner = makeRunner(arc2, { now: () => Date.now() + 60_000 }); // one minute later
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
  // The same bytes go back on the wire, and the submission stays open.
  expect(arc2.sendRawFundTreasury).toHaveBeenCalledTimes(1);
  expect(arc2.sendRawFundTreasury.mock.calls[0]![0]).toMatch(/^0xraw/);
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
});

test("N8: the boot sweep is held to the same three conditions", async () => {
  // The sweep runs unattended at boot — exactly when an unhealthy RPC is most likely — so it is the
  // last place that may guess.
  await onboard(makeFakeArc());
  await attemptOneSendThrew({ nonce: 7 });

  const arcBoot = makeFakeArc({ receipt: "throws", platformNonce: 9 });
  const swept = await sweepUnresolvedFunding({
    repo,
    arc: arcBoot,
    now: () => Date.now() + 11 * 60_000,
  });
  expect(swept).toMatchObject({ checked: 1, finalised: 0, dropped: 0, unresolved: 1 });
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
});

test("N10: a resolution row is written at most once per hash, whatever the interleaving", async () => {
  await onboard(makeFakeArc());
  await attemptOneSendThrew({ nonce: 7 });

  // Two sweeps, both concluding `dropped` on the same submission.
  const opts = { receipt: "absent" as const, platformNonce: 9 };
  const clock = () => Date.now() + 11 * 60_000;
  await sweepUnresolvedFunding({ repo, arc: makeFakeArc(opts), now: clock });
  await sweepUnresolvedFunding({ repo, arc: makeFakeArc(opts), now: clock });

  expect(fundEvents().filter((e) => e.status === "dropped")).toHaveLength(1);
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`, `dropped:${FIRST_TX}`]);
});

test("N10: the same guard covers `reverted`", async () => {
  await onboard(makeFakeArc());
  await attemptOneSendThrew();

  await sweepUnresolvedFunding({ repo, arc: makeFakeArc({ receipt: "reverted" }) });
  await sweepUnresolvedFunding({ repo, arc: makeFakeArc({ receipt: "reverted" }) });

  expect(fundEvents().filter((e) => e.status === "reverted")).toHaveLength(1);
});

/* ── N5: the sweep must not charge a transfer twice ──────────────────────────────────────────── */

test("N5: finalising the same hash twice writes ONE funded row, and charges the quota once", async () => {
  await onboard(makeFakeArc());
  const runner = makeRunner(makeFakeArc({ confirm: "success" }));
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`, `funded:${FIRST_TX}`]);

  // The sweep arrives at a row it has no business finalising again — the exact race the gate
  // measured (sweep + live saga = two `funded` rows for one transfer, quota charged twice).
  // Idempotence is enforced in the INSERT itself, so no ordering can produce a second row.
  const rec = repo.findByIdempotencyKey(KEY)!;
  finaliseFunded(repo, rec, FIRST_TX, AMOUNT, true);
  finaliseFunded(repo, rec, FIRST_TX, AMOUNT, true);

  expect(fundEvents().filter((e) => e.status === "funded")).toHaveLength(1);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);
});

test("N5: the boot sweep SKIPS an entity the runner is working on", async () => {
  // The sweep is awaited after `serve()`, so it walks its queue while `POST /entities/:id/fund` is
  // being served. It must never run beside a saga that is mid-fund.
  await onboard(makeFakeArc());
  await attemptOneSendThrew();

  const arcBoot = makeFakeArc({ receipt: "success" });
  const swept = await sweepUnresolvedFunding({
    repo,
    arc: arcBoot,
    busy: (key) => key === KEY,
  });

  expect(swept).toEqual({
    checked: 1,
    finalised: 0,
    reverted: 0,
    dropped: 0,
    unresolved: 0,
    skipped: 1,
  });
  expect(arcBoot.receiptOutcome).not.toHaveBeenCalled();
  expect(fundEventShape()).toEqual([`submitted:${FIRST_TX}`]);
});

test("N5: a sweep INTERLEAVED with a user retry still leaves exactly one funded row", async () => {
  await onboard(makeFakeArc());
  await attemptOneSendThrew();

  // A real interleaving, made deterministic: the sweep runs INSIDE the retry's receipt read, so
  // both resolve the same submission and both reach `finaliseFunded` for the same hash — which is
  // exactly the race the gate measured (two `funded` rows, the tenant's cap charged twice).
  const arcBoot = makeFakeArc({ receipt: "success" });
  const arc2 = makeFakeArc({ receipt: "success", hashes: [SECOND_TX] });
  arc2.receiptOutcome.mockImplementation(async () => {
    await sweepUnresolvedFunding({ repo, arc: arcBoot });
    return "success";
  });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  // The sweep got there first; the saga's own finalise is a no-op rather than a second row.
  expect(fundEvents().filter((e) => e.status === "funded")).toHaveLength(1);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT);
  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
  expect(outflows).toHaveLength(1);
  const row = repo.findByIdempotencyKey(KEY)!;
  expect(row.status).toBe("funded");
  expect(row.fundTxHash).toBe(FIRST_TX);
});

/* ── N7: one pass adopts EVERY landed submission ─────────────────────────────────────────────── */

test("N7: two landed submissions are both adopted in a single pass", async () => {
  // Reachable after a restart: two broadcasts, neither confirmed, both mined. Adopting one and
  // leaving the other would under-count the tenant's quota by a whole transfer.
  await onboard(makeFakeArc());
  await attemptOneSendThrew({ hashes: [FIRST_TX] });
  // A second unresolved submission on the same entity, as a restart could leave.
  repo.recordEvent(
    KEY,
    "fundTreasury",
    "submitted",
    SECOND_TX,
    JSON.stringify({ amount: "500000", rawTx: "0xrawsecond", nonce: 8 }),
  );

  const arcBoot = makeFakeArc({ receipt: "success" });
  const swept = await sweepUnresolvedFunding({ repo, arc: arcBoot });

  expect(swept).toMatchObject({ checked: 2, finalised: 2 });
  expect(
    fundEvents()
      .filter((e) => e.status === "funded")
      .map((e) => e.txHash),
  ).toEqual([FIRST_TX, SECOND_TX]);
  // Both transfers are counted, each at the amount that actually moved.
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT + 500_000n);
});

test("N7: a saga pass adopts both, and sends nothing", async () => {
  await onboard(makeFakeArc());
  await attemptOneSendThrew({ hashes: [FIRST_TX] });
  repo.recordEvent(
    KEY,
    "fundTreasury",
    "submitted",
    SECOND_TX,
    JSON.stringify({ amount: "500000", rawTx: "0xrawsecond", nonce: 8 }),
  );

  const arc2 = makeFakeArc({ receipt: "success", hashes: ["0xthird"] });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();

  expect(arc2.signFundTreasury).not.toHaveBeenCalled();
  expect(fundEvents().filter((e) => e.status === "funded")).toHaveLength(2);
  expect(repo.sumFundedByTenant(TENANT)).toBe(AMOUNT + 500_000n);
});

test("EVERY unresolved sentence avoids the words that invite a second transfer", async () => {
  // One table, one property: nothing we say about a transfer we cannot account for may suggest
  // that sending again is safe.
  await onboard(makeFakeArc());
  await attemptOneSendThrew();
  const afterSend = repo.findByIdempotencyKey(KEY)!.error!;

  const arc2 = makeFakeArc({ receipt: "absent", platformNonce: 7 });
  const runner = makeRunner(arc2);
  runner.fund({ id: KEY, tenantId: TENANT, amount: AMOUNT });
  await runner.settled();
  const afterRefusal = repo.findByIdempotencyKey(KEY)!.error!;

  for (const [label, message] of [
    ["send threw", afterSend],
    ["refused to re-send", afterRefusal],
    ["unconfirmed", publicErrorMessage(new BroadcastUnconfirmedError(FIRST_TX, "fundTreasury"))],
    ["prior unresolved", publicErrorMessage(new PriorTransferUnconfirmedError(FIRST_TX))],
  ] as const) {
    expect(message, label).not.toContain("Nothing was sent");
    expect(message, label).not.toContain("nothing was sent");
    expect(message, label).toContain("Do not retry");
  }
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
