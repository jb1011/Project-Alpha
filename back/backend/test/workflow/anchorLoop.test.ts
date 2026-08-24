/**
 * The anchor sub-saga (design 2026-08-19 §7) — the B+ core.
 *
 * Almost every test here exists because of ONE of the four LegalManager properties the design's
 * audit found, so each is named for the rule it protects:
 *
 *   1. re-scheduling a hash silently RESETS its clock;
 *   2. executing DELETES `scheduledAt[hash]`, so `== 0` cannot tell "never scheduled" from
 *      "already executed";
 *   3. there is no manager-side cancel — only the guardian's permanent per-hash veto;
 *   4. a scheduled hash stays executable FOREVER once its delay elapses.
 *
 * The fake chain in `helpers/formationFakes` reproduces all four, so a test that passes against
 * it is testing the rule and not a convenient fiction.
 */
import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  buildManifestV1,
  manifestDocName,
  manifestHash,
  parseManifest,
  serializeManifestBytes,
} from "../../src/oa/manifest";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  SqliteDocumentIndexRepository,
  documentIndexId,
} from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqliteOaAnchorRepository } from "../../src/persistence/oaAnchorRepository";
import { parseAgentSpec } from "../../src/policy/agentSpec";
import { translate } from "../../src/policy/translator";
import type { EntityRecord } from "../../src/types";
import {
  type AnchorLoopDeps,
  advanceAnchor,
  deriveLegalBlock,
} from "../../src/workflow/anchorLoop";
import {
  COMPANY_ID,
  ENTITY_KEY,
  type FakeAnchorChain,
  MemoryDocumentStore,
  fakeAnchorChain,
  formedEntity,
} from "../helpers/formationFakes";

const USDC = "0x3600000000000000000000000000000000000000" as const;
const NOW = Date.parse("2026-08-21T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW / 1000);
const CHAIN_ID = 5042002;
const FILED_AT = 1_755_600_000;

const SPEC = parseAgentSpec({
  name: "Anchor Agent",
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
});

let db: Database.Database;
let repo: SqliteEntityRepository;
let requests: SqliteFormationRepository;
let documents: SqliteDocumentIndexRepository;
let anchors: SqliteOaAnchorRepository;
let docStore: MemoryDocumentStore;
let chain: FakeAnchorChain;
let clock: number;

function deps(over: Partial<AnchorLoopDeps> = {}): AnchorLoopDeps {
  return {
    repo,
    requests,
    documents,
    docStore,
    anchors,
    arc: chain.chain,
    chainId: CHAIN_ID,
    environment: "sandbox",
    now: () => clock,
    ...over,
  };
}

/**
 * The state PR 1 + PR 2 hand this loop: an entity anchored at v1, its `create_provider` confirmed.
 * The v1 manifest is a REAL one, stored and hashed the way the saga stores it, because every
 * later version chains onto its bytes.
 */
function seedV1(over: Partial<EntityRecord> = {}): Hex {
  const r = translate(SPEC, { usdc: USDC });
  const termsDoc = "# Operating Agreement\n";
  const manifest = buildManifestV1(
    SPEC,
    r,
    "pub-anchor",
    { chainId: CHAIN_ID, entityKey: ENTITY_KEY },
    termsDoc,
  );
  const bytes = serializeManifestBytes(manifest);
  const hash = manifestHash(bytes);
  docStore.putBytes(manifestDocName(ENTITY_KEY, 1), bytes);
  repo.upsert(
    formedEntity({
      oaHash: hash,
      oaManifestVersion: 1,
      oaManifestAnchoredHash: hash,
      ...over,
    }),
  );
  requests.claimAllSteps(ENTITY_KEY);
  requests.transition(ENTITY_KEY, "create_provider", "pending", "confirmed", {
    providerRef: COMPANY_ID,
  });
  chain.state.current = hash;
  return hash;
}

/** The v2 trigger: the state filed the company AND both required documents are indexed. */
function confirmFiling(over: { filingNumber?: string | null } = {}): void {
  requests.transition(ENTITY_KEY, "await_filing", "pending", "confirmed");
  requests.transition(ENTITY_KEY, "fetch_documents", "pending", "confirmed");
  const rec = repo.findByIdempotencyKey(ENTITY_KEY)!;
  repo.upsert({
    ...rec,
    formationFiledAt: FILED_AT,
    formationFilingNumber: over.filingNumber === undefined ? "2026-001234567" : over.filingNumber,
  });
  for (const [type, sha] of [
    ["ArticlesOfOrganization", "a".repeat(64)],
    ["OperatingAgreement", "b".repeat(64)],
  ] as const)
    documents.insert({
      id: documentIndexId(ENTITY_KEY, type),
      entityKey: ENTITY_KEY,
      docType: type,
      sha256: sha,
      contentType: "application/pdf",
      size: 1024,
      providerDocId: type,
      path: `doc-${type}.pdf`,
    });
}

/** The v3 trigger: the IRS issued. */
function confirmEin(ein = "88-1234567"): void {
  requests.transition(ENTITY_KEY, "await_ein", "pending", "confirmed");
  const rec = repo.findByIdempotencyKey(ENTITY_KEY)!;
  repo.upsert({ ...rec, einReal: ein });
}

const entity = () => repo.findByIdempotencyKey(ENTITY_KEY)!;
const cycles = () => anchors.versionsOf(ENTITY_KEY);
const cycle = (v: number) => anchors.find(ENTITY_KEY, v);
/** Move both clocks past the timelock — the sweeper's and the chain's. */
function warpPastDelay(): void {
  clock += 25 * 60 * 60 * 1000;
  chain.state.nowSeconds = Math.floor(clock / 1000);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  requests = new SqliteFormationRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  anchors = new SqliteOaAnchorRepository(db);
  docStore = new MemoryDocumentStore();
  clock = NOW;
  chain = fakeAnchorChain({ nowSeconds: NOW_SECONDS });
});
afterEach(() => db.close());

// ── the happy path, end to end ─────────────────────────────────────────────────────────────

test("A-1: a confirmed filing opens v2, writes the manifest and SCHEDULES it", async () => {
  const v1Hash = seedV1();
  confirmFiling();

  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ advanced: true, version: 2, state: "scheduled" });

  const row = cycle(2)!;
  expect(row.state).toBe("scheduled");
  expect(row.scheduleTx).toBeTruthy();
  // The timelock the CHAIN reports, not `now + delay` guessed locally: the guardian's countdown
  // is a promise about when we may act, and block time is the only clock that decides it.
  expect(row.executableAt).toBe(NOW_SECONDS + 86_400);
  expect(chain.state.scheduledAt.get(row.manifestHash)).toBe(BigInt(NOW_SECONDS + 86_400));

  // The manifest on disk IS the anchor, and it chains onto v1's own bytes.
  const stored = parseManifest(docStore.getBytes(manifestDocName(ENTITY_KEY, 2)));
  expect(manifestHash(docStore.getBytes(manifestDocName(ENTITY_KEY, 2)))).toBe(row.manifestHash);
  expect(stored.previous).toBe(v1Hash);
  expect(stored.chain).toEqual({
    chainId: CHAIN_ID,
    legalManager: entity().proxy,
    agentId: entity().agentId,
  });
  expect(stored.legal).toMatchObject({
    provider: "doola",
    environment: "sandbox",
    providerCompanyId: COMPANY_ID,
    entityType: "LLC",
    state: "WY",
    formationDate: FILED_AT,
    filingNumber: "2026-001234567",
    // v2 anchors WITHOUT an EIN and says so — the IRS takes four to six weeks.
    ein: null,
  });
  expect(stored.legal?.documents.map((doc) => doc.type)).toEqual([
    "ArticlesOfOrganization",
    "OperatingAgreement",
  ]);

  // The fixed projection the monitor and the guardian card read (audit H3/14).
  expect(entity().oaManifestPendingHash).toBe(row.manifestHash);
  expect(entity().oaManifestPendingVersion).toBe(2);
  expect(entity().oaAmendmentExecutableAt).toBe(NOW_SECONDS + 86_400);
  // …and nothing is anchored yet. The DB may never claim an anchor the chain does not hold.
  expect(entity().oaManifestVersion).toBe(1);
  expect(entity().oaHash).toBe(v1Hash);
});

test("A-2: the timelock is respected, and the execute promotes the entity in ONE transaction", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const hash = cycle(2)!.manifestHash;

  // Not due: nothing is broadcast, and the chain still holds v1.
  const early = await advanceAnchor(deps(), ENTITY_KEY);
  expect(early).toMatchObject({ skipped: "not_due", advanced: false });
  expect(chain.calls.filter((c) => c.startsWith("execute:"))).toHaveLength(0);

  warpPastDelay();
  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ advanced: true, version: 2, state: "executed" });

  expect(chain.state.current).toBe(hash);
  const row = cycle(2)!;
  expect(row.state).toBe("executed");
  expect(row.executeTx).toBeTruthy();
  // The schedule tx SURVIVES — a crash resumes by adopting a persisted broadcast.
  expect(row.scheduleTx).toBeTruthy();

  const e = entity();
  expect(e.oaHash).toBe(hash);
  expect(e.oaManifestVersion).toBe(2);
  expect(e.oaManifestAnchoredHash).toBe(hash);
  expect(e.oaManifestPendingHash).toBeNull();
  expect(e.oaManifestPendingVersion).toBeNull();
  expect(e.oaAmendmentExecutableAt).toBeNull();
  const anchored = repo.listEvents(ENTITY_KEY).find((ev) => ev.step === "oaAnchored");
  expect(anchored?.txHash).toBe(row.executeTx);
  expect(JSON.parse(anchored!.detail!)).toMatchObject({ version: 2, manifestHash: hash });
});

test("A-3: v3 folds the EIN in and chains onto the ANCHORED v2", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  warpPastDelay();
  await advanceAnchor(deps(), ENTITY_KEY);
  const v2Hash = cycle(2)!.manifestHash;

  confirmEin();
  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ advanced: true, version: 3, state: "scheduled" });
  const stored = parseManifest(docStore.getBytes(manifestDocName(ENTITY_KEY, 3)));
  expect(stored.previous).toBe(v2Hash);
  expect(stored.legal?.ein).toBe("88-1234567");

  warpPastDelay();
  await advanceAnchor(deps(), ENTITY_KEY);
  expect(entity().oaManifestVersion).toBe(3);
  expect(chain.state.current).toBe(cycle(3)!.manifestHash);
});

test("A-4: a fully anchored entity with no new facts does NOTHING — no version churn", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  warpPastDelay();
  await advanceAnchor(deps(), ENTITY_KEY);

  for (let i = 0; i < 3; i++) {
    const out = await advanceAnchor(deps(), ENTITY_KEY);
    expect(out).toMatchObject({ advanced: false, skipped: "no_new_facts" });
  }
  expect(cycles().map((c) => c.version)).toEqual([2]);
  expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(1);
});

// ── the crash windows (contract properties 1 and 2) ────────────────────────────────────────

test("A-5: a crash between the schedule BROADCAST and its persist resumes by ADOPTING", async () => {
  seedV1();
  confirmFiling();
  // First pass writes the manifest and opens the cycle, but the process dies before the tx hash
  // is persisted — modelled by the broadcast landing on chain with the row still `pending` and
  // carrying no `schedule_tx`.
  chain.state.scheduleMode = "lost"; // the receipt wait throws, so nothing is persisted
  await advanceAnchor(deps(), ENTITY_KEY);
  const row = cycle(2)!;
  expect(row.state).toBe("pending");
  // The tx DID land, we simply never learned it.
  chain.state.scheduledAt.set(row.manifestHash, BigInt(NOW_SECONDS + 86_400));
  chain.state.scheduleMode = "ok";
  const before = chain.calls.filter((c) => c.startsWith("schedule:")).length;

  clock += 10 * 60_000; // past the park backoff
  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ advanced: true, version: 2, state: "scheduled" });
  // NOT re-broadcast. Property 1: a second schedule would silently reset the clock and hand the
  // guardian a shorter veto window than the notification named.
  expect(chain.calls.filter((c) => c.startsWith("schedule:")).length).toBe(before);
  expect(cycle(2)!.executableAt).toBe(NOW_SECONDS + 86_400);
});

test("A-6: a crash AFTER the execute (scheduledAt==0 + meta==hash) marks executed, never re-schedules", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const hash = cycle(2)!.manifestHash;

  // The execute landed and the process died before the receipt: the chain deleted the schedule
  // and moved `meta`, while our row still says `scheduled`. Property 2 — `scheduledAt == 0` here
  // means "already executed", and a loop that read only that would RE-SCHEDULE an executed
  // version and let a stale manifest land after a newer one.
  chain.state.scheduledAt.delete(hash);
  chain.state.current = hash;
  warpPastDelay();

  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ advanced: true, version: 2, state: "executed" });
  expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(1); // the original one
  expect(entity().oaManifestVersion).toBe(2);
  expect(entity().oaManifestAnchoredHash).toBe(hash);
  expect(entity().oaManifestPendingHash).toBeNull();
});

test("A-7: a schedule is only ever broadcast when scheduledAt == 0", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const hash = cycle(2)!.manifestHash;
  const scheduledFor = chain.state.scheduledAt.get(hash);

  // Many more passes before the timelock elapses: none of them may touch the clock.
  for (let i = 0; i < 5; i++) {
    clock += 60 * 60_000;
    chain.state.nowSeconds = Math.floor(clock / 1000);
    await advanceAnchor(deps(), ENTITY_KEY);
  }
  expect(chain.state.scheduledAt.get(hash)).toBe(scheduledFor);
  expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(1);
});

// ── the single-pending rule (audit C1 part 1) ──────────────────────────────────────────────

test("A-8: facts arriving before the broadcast SUPERSEDE the pending version and fold in", async () => {
  seedV1();
  confirmFiling();
  // The cycle is opened and then parked by a transport failure BEFORE anything is broadcast —
  // the "not yet on chain" half of the single-pending rule.
  chain.state.failNextRead = "legalStatus";
  await advanceAnchor(deps(), ENTITY_KEY);
  expect(cycle(2)!.state).toBe("pending");
  expect(cycle(2)!.scheduleTx).toBeNull();

  confirmEin();
  clock += 10 * 60_000;
  const out = await advanceAnchor(deps(), ENTITY_KEY);

  expect(out).toMatchObject({ version: 3, state: "scheduled" });
  expect(cycle(2)!.state).toBe("superseded");
  expect(cycle(2)!.error).toMatch(/before it was broadcast/);
  // v3 folds ALL the facts — the filing AND the EIN — and still chains onto the ANCHORED v1,
  // never onto the superseded v2 (design §4, M9).
  const v3 = parseManifest(docStore.getBytes(manifestDocName(ENTITY_KEY, 3)));
  expect(v3.legal?.ein).toBe("88-1234567");
  expect(v3.legal?.filingNumber).toBe("2026-001234567");
  expect(v3.previous).toBe(entity().oaManifestAnchoredHash);
  expect(entity().oaManifestPendingVersion).toBe(3);
});

test("A-9: a SCHEDULED version that is superseded is left to EXPIRE — there is no cancel", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const v2Hash = cycle(2)!.manifestHash;
  expect(cycle(2)!.state).toBe("scheduled");

  confirmEin();
  await advanceAnchor(deps(), ENTITY_KEY);

  expect(cycle(2)!.state).toBe("superseded");
  expect(cycle(2)!.error).toMatch(/left to expire unexecuted/);
  expect(cycle(3)!.state).toBe("scheduled");
  // Property 3 + 4: v2's schedule is STILL on chain and stays executable forever. Nothing we can
  // do removes it — which is why the execute leg re-checks the version and why monitoring treats
  // an execute of a non-current version as CRITICAL.
  expect(chain.state.scheduledAt.get(v2Hash)).toBeDefined();

  // And we never execute it ourselves, however long we run.
  warpPastDelay();
  await advanceAnchor(deps(), ENTITY_KEY);
  expect(chain.state.current).toBe(cycle(3)!.manifestHash);
  expect(chain.calls.filter((c) => c === `execute:${v2Hash}`)).toHaveLength(0);
});

test("A-10: at most ONE cycle is ever pending or scheduled for an entity", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  confirmEin();
  await advanceAnchor(deps(), ENTITY_KEY);
  const open = cycles().filter((c) => c.state === "pending" || c.state === "scheduled");
  expect(open).toHaveLength(1);
  expect(open[0]!.version).toBe(3);
});

// ── the monotonic gate (contract property 4) ───────────────────────────────────────────────

test("A-11: a cycle the ANCHORED version has overtaken is retired, never executed", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const row = cycle(2)!;

  // v2 got anchored by something that is not this row — a resumed sibling, an operator, a replay.
  // Our scheduled row is now stale, and property 4 means its on-chain schedule outlives that fact
  // forever: nothing but our own ordering rules stops it from landing later.
  repo.upsert({
    ...entity(),
    oaManifestVersion: 2,
    oaManifestAnchoredHash: row.manifestHash,
    oaHash: row.manifestHash,
  });
  warpPastDelay();

  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(cycle(2)!.state).toBe("superseded");
  // …and no successor is minted to say what the chain already says.
  expect(out).toMatchObject({ advanced: false, skipped: "no_new_facts" });
  expect(cycles().map((c) => c.version)).toEqual([2]);
  expect(chain.calls.filter((c) => c === `execute:${row.manifestHash}`)).toHaveLength(0);
});

test("A-11b: the version gate ALSO guards the two legs directly, with no facts to re-derive", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const row = cycle(2)!;

  // Same staleness, but now the facts cannot be re-derived at all (the document index is gone),
  // so the reconcile has nothing to compare and hands the stale cycle straight to the execute
  // leg. The monotonic gate inside the prechecks is what refuses it.
  db.exec("DELETE FROM documents");
  repo.upsert({
    ...entity(),
    oaManifestVersion: 2,
    oaManifestAnchoredHash: row.manifestHash,
    oaHash: row.manifestHash,
  });
  warpPastDelay();

  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ version: 2, state: "superseded" });
  expect(cycle(2)!.error).toMatch(/does not advance the anchored v2/);
  expect(chain.calls.filter((c) => c === `execute:${row.manifestHash}`)).toHaveLength(0);
});

// ── the guardian veto (audit H4) ───────────────────────────────────────────────────────────

test("A-12: a veto parks the ENTITY'S WHOLE pipeline — new facts do not route around it", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const v2Hash = cycle(2)!.manifestHash;

  chain.veto(v2Hash);
  warpPastDelay();
  const vetoed = await advanceAnchor(deps(), ENTITY_KEY);
  expect(vetoed).toMatchObject({ version: 2, state: "vetoed" });
  expect(cycle(2)!.state).toBe("vetoed");

  // New facts arrive. A backend that simply re-versioned around the veto would defeat the
  // guardian entirely, so NOTHING is built and nothing is scheduled.
  confirmEin();
  const parked = await advanceAnchor(deps(), ENTITY_KEY);
  expect(parked).toMatchObject({ skipped: "hold_park", advanced: false });
  expect(cycles().map((c) => c.version)).toEqual([2]);
  expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(1);
});

test("A-13: liftVeto resumes the pipeline, and the newest facts are what get anchored", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const v2Hash = cycle(2)!.manifestHash;
  chain.veto(v2Hash);
  await advanceAnchor(deps(), ENTITY_KEY);
  confirmEin();

  chain.liftVeto(v2Hash);
  const resumed = await advanceAnchor(deps(), ENTITY_KEY);
  // The lifted version returns to `pending`, then the facts that arrived during the park
  // supersede it — one pass, because the reconcile runs after the park is resolved.
  expect(cycle(2)!.state).toBe("superseded");
  expect(resumed).toMatchObject({ version: 3, state: "scheduled" });
  expect(parseManifest(docStore.getBytes(manifestDocName(ENTITY_KEY, 3))).legal?.ein).toBe(
    "88-1234567",
  );
});

test("A-14: an operator ACK also ends the park, without the guardian lifting anything", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  chain.veto(cycle(2)!.manifestHash);
  await advanceAnchor(deps(), ENTITY_KEY);

  expect(anchors.acknowledgeHold(ENTITY_KEY, 2)).toBe(true);
  confirmEin();
  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ version: 3, state: "scheduled" });
  // The vetoed HASH is still blacklisted on chain; we simply never propose it again.
  expect(chain.state.vetoed.has(cycle(2)!.manifestHash)).toBe(true);
  expect(cycle(3)!.manifestHash).not.toBe(cycle(2)!.manifestHash);
});

// ── hash-final discipline (audit M7) ───────────────────────────────────────────────────────

test("A-15: an execute-time REHASH MISMATCH parks CRITICAL and never broadcasts", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const hash = cycle(2)!.manifestHash;

  // The file rots between the two transactions. There is no manager-side cancel, so executing a
  // hash whose document we can no longer reproduce would anchor something unverifiable forever.
  docStore.files.set(manifestDocName(ENTITY_KEY, 2), Buffer.from("{}\n", "utf8"));
  warpPastDelay();

  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ version: 2, state: "failed" });
  expect(cycle(2)!.error).toMatch(/no longer re-hashes/);
  expect(chain.calls.filter((c) => c === `execute:${hash}`)).toHaveLength(0);
  expect(chain.state.current).not.toBe(hash);
  // It is a REFUSAL, not a retry, and it HOLDS the whole pipeline: the amendment is still
  // scheduled on chain and only the guardian can stop it, so the platform must not quietly move
  // on to a successor while a human has not looked.
  confirmEin();
  const again = await advanceAnchor(deps(), ENTITY_KEY);
  expect(again).toMatchObject({ advanced: false, skipped: "hold_park" });
  expect(cycle(2)!.state).toBe("failed");
  expect(cycles().map((c) => c.version)).toEqual([2]);

  // …until an operator acknowledges it, at which point the newest facts get a fresh cycle.
  expect(anchors.acknowledgeHold(ENTITY_KEY, 2)).toBe(true);
  expect((await advanceAnchor(deps(), ENTITY_KEY)).version).toBe(3);
});

test("A-16: a manifest that does not read back is never claimed and never scheduled", async () => {
  seedV1();
  confirmFiling();
  // A store whose write silently produced different bytes — the torn-file hazard, forced.
  const rotting = new MemoryDocumentStore();
  for (const [k, v] of docStore.files) rotting.files.set(k, v);
  rotting.putBytes = (name: string, bytes: Buffer) => {
    rotting.files.set(name, name.includes("v2") ? Buffer.from("truncated") : Buffer.from(bytes));
    return { id: name, path: `/memory/${name}`, uri: `file:///memory/${name}` };
  };

  const out = await advanceAnchor(deps({ docStore: rotting }), ENTITY_KEY);
  expect(out.advanced).toBe(false);
  expect(cycles()).toHaveLength(0);
  expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(0);
});

test("A-17: an unreadable ANCHORED manifest parks the pipeline instead of guessing", async () => {
  seedV1();
  confirmFiling();
  docStore.files.delete(manifestDocName(ENTITY_KEY, 1));
  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out.advanced).toBe(false);
  expect(cycles()).toHaveLength(0);
  expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(0);
});

// ── transport failures never abandon an amendment ──────────────────────────────────────────

test("A-18: a transport failure PARKS with a doubling backoff and burns NO attempt", async () => {
  seedV1();
  confirmFiling();
  chain.state.failNextRead = "legalStatus";
  await advanceAnchor(deps(), ENTITY_KEY);

  let row = cycle(2)!;
  expect(row.state).toBe("pending");
  expect(row.attempt).toBe(0); // a lost read is not evidence that anything failed
  expect(row.error).toMatch(/timed out/);
  expect(row.nextRetryAt).toBe(NOW + 2 * 60_000);
  expect(row.retryIntervalMs).toBe(2 * 60_000);

  // Parked: a pass before the backoff elapses does nothing at all.
  const early = await advanceAnchor(deps(), ENTITY_KEY);
  expect(early).toMatchObject({ skipped: "not_due" });
  expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(0);

  // The interval doubles rather than counting attempts.
  clock = row.nextRetryAt!;
  chain.state.failNextRead = "legalStatus";
  await advanceAnchor(deps(), ENTITY_KEY);
  row = cycle(2)!;
  expect(row.attempt).toBe(0);
  expect(row.retryIntervalMs).toBe(4 * 60_000);

  // …and a successful pass CLEARS the schedule, so a healthy cycle is not parked forever.
  clock = row.nextRetryAt!;
  await advanceAnchor(deps(), ENTITY_KEY);
  row = cycle(2)!;
  expect(row.state).toBe("scheduled");
  expect(row.nextRetryAt).toBeNull();
  expect(row.retryIntervalMs).toBeNull();
});

test("A-19: a REVERTED schedule tx is re-broadcast (scheduledAt == 0 proves there is no clock to reset)", async () => {
  seedV1();
  confirmFiling();
  chain.state.scheduleMode = "revert";
  await advanceAnchor(deps(), ENTITY_KEY);
  expect(cycle(2)!.state).toBe("pending");
  expect(cycle(2)!.scheduleTx).toBeTruthy();

  chain.state.scheduleMode = "ok";
  clock += 10 * 60_000;
  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ state: "scheduled" });
  expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(2);
});

// ── dissolution ────────────────────────────────────────────────────────────────────────────

test("A-20: a body that is not Active parks the sub-saga (whenActive gates BOTH legs)", async () => {
  seedV1();
  confirmFiling();
  chain.state.status = 1; // WindingDown
  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ skipped: "not_active", advanced: false });
  expect(cycle(2)!.state).toBe("pending");
  expect(cycle(2)!.error).toMatch(/not Active/);
  expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(0);

  // Dissolution is reversible until it is finalized, so this is a park, not a failure.
  chain.state.status = 0;
  clock = cycle(2)!.nextRetryAt!;
  expect((await advanceAnchor(deps(), ENTITY_KEY)).state).toBe("scheduled");
});

// ── the gates: who this loop must never touch ──────────────────────────────────────────────

test("A-21: legacy, stub and legacy-scheme entities never reach the chain from here", async () => {
  const cases: [Partial<EntityRecord>, string][] = [
    // No doola pin: the 13 testnet + existing prod agents, stub forever.
    [{ formationProvider: null, formationEnvironment: null }, "not_pinned"],
    // Pinned elsewhere: a mainnet flip must never act on an in-flight sandbox entity (audit M5).
    [{ formationEnvironment: "production" }, "environment_pin"],
    // The create tx has not confirmed: no proxy to amend, no v1 to chain onto.
    [
      { proxy: null, oaHash: null, oaManifestVersion: null, oaManifestAnchoredHash: null },
      "not_anchored",
    ],
  ];
  for (const [over, skipped] of cases) {
    db.exec("DELETE FROM entities; DELETE FROM formation_requests; DELETE FROM documents");
    seedV1(over);
    confirmFiling();
    expect((await advanceAnchor(deps(), ENTITY_KEY)).skipped, skipped).toBe(skipped);
    expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(0);
  }
});

test("A-22: a LEGACY-SCHEME record (doc-hash anchor, no manifest version) is left alone", async () => {
  // `usesManifestScheme` is the one predicate that decides this, and it is shared with the saga.
  repo.upsert(
    formedEntity({
      oaHash: "0xdeadbeef" as Hex,
      oaManifestVersion: null,
      oaManifestAnchoredHash: null,
      oaManifestPendingHash: null,
    }),
  );
  requests.claimAllSteps(ENTITY_KEY);
  requests.transition(ENTITY_KEY, "create_provider", "pending", "confirmed", {
    providerRef: COMPANY_ID,
  });
  confirmFiling();
  expect((await advanceAnchor(deps(), ENTITY_KEY)).skipped).toBe("not_manifest_scheme");
});

// ── the trigger, read from OUR records only (audit H2) ─────────────────────────────────────

test("A-23: the legal block comes from the entity record and the document index, and nothing else", () => {
  seedV1();
  const d = deps();
  // Nothing confirmed yet.
  expect(deriveLegalBlock(d, entity())).toBeNull();

  // Filing confirmed but documents not: v2 needs BOTH halves.
  requests.transition(ENTITY_KEY, "await_filing", "pending", "confirmed");
  repo.upsert({ ...entity(), formationFiledAt: FILED_AT, formationFilingNumber: "F-1" });
  expect(deriveLegalBlock(d, entity())).toBeNull();

  confirmFiling();
  const legal = deriveLegalBlock(d, entity())!;
  expect(legal.formationDate).toBe(FILED_AT);
  expect(legal.documents).toHaveLength(2);
  // The document NAME is derived from the type, never echoed from doola: a partner-controlled
  // string would otherwise end up hashed onto a public chain.
  expect(legal.documents.map((doc) => doc.name)).toEqual([
    "ArticlesOfOrganization.pdf",
    "OperatingAgreement.pdf",
  ]);
});

test("A-24: a filing confirmed with NO filing number does not anchor (and says so)", () => {
  seedV1();
  confirmFiling({ filingNumber: null });
  // Anchoring a manifest that claims a filing with no filing number would be the dishonest fix;
  // the honest one is to wait and warn. (Flagged: fetch-and-advance only writes the number inside
  // the CAS that confirms the step, so a late-arriving number needs the poll to re-confirm.)
  expect(deriveLegalBlock(deps(), entity())).toBeNull();
});
