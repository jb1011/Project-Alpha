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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { MAX_ANCHOR_REVERT_ATTEMPTS } from "../../src/formation/schedule";
import {
  buildManifestV1,
  manifestDocName,
  manifestHash,
  parseManifest,
  serializeManifestBytes,
} from "../../src/oa/manifest";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
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
  resetAnchorWarnings,
} from "../../src/workflow/anchorLoop";
import {
  COMPANY_ID,
  COMPANY_KEY,
  ENTITY_KEY,
  type FakeAnchorChain,
  MemoryDocumentStore,
  fakeAnchorChain,
  formedEntity,
  seedCompany,
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
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let documents: SqliteDocumentIndexRepository;
let anchors: SqliteOaAnchorRepository;
let docStore: MemoryDocumentStore;
let chain: FakeAnchorChain;
let clock: number;

function deps(over: Partial<AnchorLoopDeps> = {}): AnchorLoopDeps {
  return {
    repo,
    companies,
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
  seedCompany(companies);
  repo.upsert(
    formedEntity({
      oaHash: hash,
      oaManifestVersion: 1,
      oaManifestAnchoredHash: hash,
      ...over,
    }),
  );
  requests.claimAllSteps(COMPANY_KEY);
  requests.transition(COMPANY_KEY, "create_provider", "pending", "confirmed", {
    providerRef: COMPANY_ID,
  });
  chain.state.current = hash;
  return hash;
}

/** The v2 trigger: the state filed the company AND both required documents are indexed. */
function confirmFiling(over: { filingNumber?: string | null } = {}): void {
  requests.transition(COMPANY_KEY, "await_filing", "pending", "confirmed");
  requests.transition(COMPANY_KEY, "fetch_documents", "pending", "confirmed");
  // The legal facts live on the COMPANY since 2026-08-26 §3.
  companies.recordFilingFacts(COMPANY_KEY, {
    filedAt: FILED_AT,
    filingNumber: over.filingNumber === undefined ? "2026-001234567" : over.filingNumber,
  });
  for (const [type, sha] of [
    ["ArticlesOfOrganization", "a".repeat(64)],
    ["OperatingAgreement", "b".repeat(64)],
  ] as const)
    documents.insert({
      id: documentIndexId(COMPANY_KEY, type),
      companyId: COMPANY_KEY,
      docType: type,
      sha256: sha,
      contentType: "application/pdf",
      size: 1024,
      providerDocId: type,
      path: `doc-${type}.pdf`,
    });
}

/**
 * Re-stamp the company's facts as of NOW.
 *
 * A SCHEDULED cycle inside its timelock is deliberately skipped when no fact has moved since it
 * was written (F6) — that is the optimization that stopped every formed entity re-reading and
 * re-hashing its manifest on every tick. SQLite timestamps have ONE-SECOND resolution, so whether
 * a fixture's steps and its cycle land in the same second is a race with the machine's load. The
 * tests below are about the veto, not about that race, so they say what they mean.
 */
function touchFacts(): void {
  db.prepare("UPDATE formation_requests SET facts_updated_at = CURRENT_TIMESTAMP").run();
}

/** The v3 trigger: the IRS issued. */
function confirmEin(ein = "88-1234567"): void {
  requests.transition(COMPANY_KEY, "await_ein", "pending", "confirmed");
  companies.recordEin(COMPANY_KEY, ein);
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
  companies = new SqliteCompanyRepository(db);
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
  touchFacts();
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
  touchFacts();
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
    // The entity's pin is a COPY of its company's, so the entity-side value is what this gate
    // reads; the company-side refusal is `formationProcessor`'s.
    [{ formationEnvironment: "production" }, "environment_pin"],
    // The create tx has not confirmed: no proxy to amend, no v1 to chain onto.
    [
      { proxy: null, oaHash: null, oaManifestVersion: null, oaManifestAnchoredHash: null },
      "not_anchored",
    ],
  ];
  for (const [over, skipped] of cases) {
    db.exec(
      "DELETE FROM entities; DELETE FROM formation_requests; DELETE FROM documents; DELETE FROM companies",
    );
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
  requests.claimAllSteps(COMPANY_KEY);
  requests.transition(COMPANY_KEY, "create_provider", "pending", "confirmed", {
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
  requests.transition(COMPANY_KEY, "await_filing", "pending", "confirmed");
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

// ══════════════════════════════════════════════════════════════════════════════════════════════
// The merge-gate review fixes. Each is named for the finding it protects.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/** The projection columns are a function of the ROWS. Asserted as one invariant, so a test that
 *  drives the pipeline anywhere can check it without restating the rule (review F2). */
function expectProjectionMatchesRows(): void {
  const e = entity();
  const open = cycles()
    .filter((c) => c.state === "pending" || c.state === "scheduled")
    .at(-1);
  expect(e.oaManifestPendingHash).toBe(open?.manifestHash ?? null);
  expect(e.oaManifestPendingVersion).toBe(open?.version ?? null);
  expect(e.oaAmendmentExecutableAt).toBe(
    open?.state === "scheduled" ? (open.executableAt ?? null) : null,
  );
  const anchored = cycles()
    .filter((c) => c.state === "executed")
    .at(-1);
  if (anchored) {
    expect(e.oaManifestVersion).toBe(anchored.version);
    expect(e.oaManifestAnchoredHash).toBe(anchored.manifestHash);
    expect(e.oaHash).toBe(anchored.manifestHash);
  }
}

// ── F1: the veto-lift wedge ────────────────────────────────────────────────────────────────

test("F1: a lifted veto RE-SCHEDULES the same version — the stale schedule tx is not a wedge", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const v2Hash = cycle(2)!.manifestHash;
  expect(cycle(2)!.scheduleTx).toBeTruthy();

  // The guardian cancels: the contract DELETES the schedule and blacklists the hash.
  chain.veto(v2Hash);
  touchFacts();
  await advanceAnchor(deps(), ENTITY_KEY);
  expect(cycle(2)!.state).toBe("vetoed");

  // …and then lifts it, with NO new facts. There is nothing to supersede v2 with, so v2 itself
  // has to go back on chain — and it can, because the veto deleted the clock a re-schedule would
  // otherwise reset.
  chain.liftVeto(v2Hash);
  const before = chain.calls.length;
  const resumed = await advanceAnchor(deps(), ENTITY_KEY);
  expect(resumed).toMatchObject({ version: 2, state: "scheduled" });
  expect(chain.state.scheduledAt.get(v2Hash)).toBeDefined();
  expect(chain.calls.filter((c) => c === `schedule:${v2Hash}`)).toHaveLength(2);
  expectProjectionMatchesRows();

  // The wedge itself: the resumed pass must not go looking for the OLD schedule's receipt first.
  // With the stale `schedule_tx` still on the row it did, found it mined, read `scheduledAt == 0`
  // and parked "refusing to re-broadcast blindly" — forever, on every pass.
  const after = chain.calls.slice(before);
  expect(after.indexOf(`schedule:${v2Hash}`)).toBeLessThan(
    after.findIndex((c) => c.startsWith("receipt:")),
  );
});

test("F1: a scheduled cycle the chain has no schedule for is demoted AND loses its stale txs", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const v2Hash = cycle(2)!.manifestHash;

  // The schedule is gone and the hash is neither vetoed nor anchored — a guardian cancel plus a
  // lift that both happened between two passes, so the loop never saw the veto at all.
  chain.state.scheduledAt.delete(v2Hash);
  warpPastDelay();

  const demoted = await advanceAnchor(deps(), ENTITY_KEY);
  expect(demoted).toMatchObject({ version: 2, state: "pending" });
  expect(cycle(2)!.scheduleTx).toBeNull();
  expect(cycle(2)!.executeTx).toBeNull();
  // The countdown stops being advertised too: there is nothing left to count down to.
  expect(entity().oaAmendmentExecutableAt).toBeNull();
  expectProjectionMatchesRows();

  const rescheduled = await advanceAnchor(deps(), ENTITY_KEY);
  expect(rescheduled).toMatchObject({ version: 2, state: "scheduled" });
  expect(chain.calls.filter((c) => c === `schedule:${v2Hash}`)).toHaveLength(2);
});

test("F1: a MINED schedule whose clock is gone is re-broadcast, not parked forever", async () => {
  seedV1();
  confirmFiling();
  // The broadcast lands but the receipt is lost, so the tx hash is persisted and nothing else is.
  chain.state.scheduleMode = "lost";
  await advanceAnchor(deps(), ENTITY_KEY);
  const row = cycle(2)!;
  expect(row.state).toBe("pending");
  expect(row.scheduleTx).toBeTruthy();
  expect(chain.state.scheduledAt.get(row.manifestHash)).toBeUndefined();

  // The tx DID mine; the guardian then cancelled it and lifted the veto. Not vetoed, not the
  // current anchor, no schedule: the one shape in which re-broadcasting resets nothing.
  chain.state.scheduleMode = "ok";
  clock = row.nextRetryAt!;
  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ version: 2, state: "scheduled" });
  expect(cycle(2)!.error).toBeNull();
  expect(chain.calls.filter((c) => c.startsWith("schedule:"))).toHaveLength(2);
});

// ── F2: one projection writer ──────────────────────────────────────────────────────────────

test("F2: a supersede with no successor CLEARS the pending pair — no phantom amendment", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const row = cycle(2)!;
  expect(entity().oaManifestPendingHash).toBe(row.manifestHash);

  // v2 was anchored by something that is not this row, so the cycle is retired and NOTHING
  // replaces it. The entity used to go on advertising a pending amendment that had ceased to
  // exist — which the monitor reads as "the hash on chain is not the one we have pending".
  repo.upsert({
    ...entity(),
    oaManifestVersion: 2,
    oaManifestAnchoredHash: row.manifestHash,
    oaHash: row.manifestHash,
  });
  warpPastDelay();
  await advanceAnchor(deps(), ENTITY_KEY);

  expect(cycle(2)!.state).toBe("superseded");
  expect(entity().oaManifestPendingHash).toBeNull();
  expect(entity().oaManifestPendingVersion).toBeNull();
  expect(entity().oaAmendmentExecutableAt).toBeNull();
  // …and the anchored trio is untouched. An entity never un-anchors.
  expect(entity().oaManifestVersion).toBe(2);
  expect(entity().oaManifestAnchoredHash).toBe(row.manifestHash);
});

test("F2: the monotonic gate's supersede clears it too, with no facts left to re-derive", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const row = cycle(2)!;

  db.exec("DELETE FROM documents"); // the reconcile now has nothing to compare
  repo.upsert({
    ...entity(),
    oaManifestVersion: 2,
    oaManifestAnchoredHash: row.manifestHash,
    oaHash: row.manifestHash,
  });
  warpPastDelay();

  expect(await advanceAnchor(deps(), ENTITY_KEY)).toMatchObject({ state: "superseded" });
  expect(entity().oaManifestPendingHash).toBeNull();
  expect(entity().oaManifestPendingVersion).toBeNull();
  expect(entity().oaAmendmentExecutableAt).toBeNull();
});

test("F2: the projection tracks the ROWS at every step of a two-version lifecycle", async () => {
  seedV1();
  confirmFiling();
  expectProjectionMatchesRows();
  await advanceAnchor(deps(), ENTITY_KEY); // v2 opened + scheduled
  expectProjectionMatchesRows();
  warpPastDelay();
  await advanceAnchor(deps(), ENTITY_KEY); // v2 executed
  expectProjectionMatchesRows();
  confirmEin();
  await advanceAnchor(deps(), ENTITY_KEY); // v3 opened + scheduled
  expectProjectionMatchesRows();
  expect(entity().oaManifestPendingVersion).toBe(3);
  expect(entity().oaManifestVersion).toBe(2);
  warpPastDelay();
  await advanceAnchor(deps(), ENTITY_KEY); // v3 executed
  expectProjectionMatchesRows();
  expect(entity().oaManifestPendingVersion).toBeNull();
});

// ── F3: recovery before rehash ─────────────────────────────────────────────────────────────

test("F3: a crash AFTER the execute is recovered even when the manifest is gone", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  const v2Hash = cycle(2)!.manifestHash;
  const v2Bytes = docStore.getBytes(manifestDocName(ENTITY_KEY, 2));

  // The execute landed, the process died before the receipt, and the manifest file was then lost
  // (a restore that missed it, a half-synced volume). The chain holds v2.
  chain.state.scheduledAt.delete(v2Hash);
  chain.state.current = v2Hash;
  docStore.files.delete(manifestDocName(ENTITY_KEY, 2));
  warpPastDelay();

  // Recovered, NOT `failed`: re-hashing a version the chain ALREADY HOLDS decides nothing, and
  // the refusal used to hold the whole pipeline over an amendment that had in fact landed.
  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ version: 2, state: "executed" });
  expect(cycle(2)!.state).toBe("executed");
  expect(entity().oaManifestVersion).toBe(2);
  expect(entity().oaManifestAnchoredHash).toBe(v2Hash);
  expect(entity().oaHash).toBe(v2Hash);
  expect(entity().oaManifestPendingHash).toBeNull();

  // …and once a human restores the file, the NEXT version chains onto the hash the chain
  // actually holds — where a `failed` v2 plus an ack would have chained v3 onto v1.
  docStore.putBytes(manifestDocName(ENTITY_KEY, 2), v2Bytes);
  confirmEin();
  expect(await advanceAnchor(deps(), ENTITY_KEY)).toMatchObject({ version: 3, state: "scheduled" });
  expect(parseManifest(docStore.getBytes(manifestDocName(ENTITY_KEY, 3))).previous).toBe(v2Hash);
});

// ── F5: deterministic reverts vs transport ─────────────────────────────────────────────────

test("F5: a deterministic revert BURNS attempts and ends in the `failed` hold", async () => {
  seedV1();
  confirmFiling();
  // The shape a legacy agent produces: its LegalManager obeys an EOA the controller is not, so
  // every relayed amendment comes back `NotManager()` — the same answer, forever.
  chain.state.revertBroadcast = "NotManager";
  for (let i = 1; i <= MAX_ANCHOR_REVERT_ATTEMPTS; i++) {
    await advanceAnchor(deps(), ENTITY_KEY);
    const row = cycle(2)!;
    expect(row.attempt).toBe(i);
    expect(row.error).toMatch(/NotManager/);
    clock = row.nextRetryAt ?? clock;
  }
  expect(cycle(2)!.state).toBe("failed");

  // The hold is the ENTITY's: nothing new is built while a human has not looked at this.
  confirmEin();
  expect(await advanceAnchor(deps(), ENTITY_KEY)).toMatchObject({ skipped: "hold_park" });
  expect(cycles().map((c) => c.version)).toEqual([2]);

  // The operator's ack is the exit, and it clears the phantom pending with it.
  expect(anchors.acknowledgeHold(ENTITY_KEY, 2)).toBe(true);
  expect(entity().oaManifestPendingHash).toBeNull();
  chain.state.revertBroadcast = undefined;
  expect((await advanceAnchor(deps(), ENTITY_KEY)).version).toBe(3);
});

test("F5: a TRANSPORT failure never burns an attempt, however often it happens", async () => {
  seedV1();
  confirmFiling();
  for (let i = 0; i < MAX_ANCHOR_REVERT_ATTEMPTS + 2; i++) {
    chain.state.failNextRead = "legalStatus";
    await advanceAnchor(deps(), ENTITY_KEY);
    const row = cycle(2)!;
    // A lost read is not evidence that anything failed — the schedule may well be on chain.
    expect(row.attempt).toBe(0);
    expect(row.state).toBe("pending");
    clock = row.nextRetryAt!;
  }
  chain.state.failNextRead = undefined;
  expect(await advanceAnchor(deps(), ENTITY_KEY)).toMatchObject({ state: "scheduled" });
});

test("F5: `TooEarly` is the timelock, not a failure — no park, no burned attempt", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  // OUR clock says the amendment is due; the CHAIN's block time does not agree yet.
  clock += 25 * 60 * 60 * 1000;

  const out = await advanceAnchor(deps(), ENTITY_KEY);
  expect(out).toMatchObject({ version: 2, state: "scheduled", skipped: "not_due" });
  const row = cycle(2)!;
  expect(row.attempt).toBe(0);
  expect(row.nextRetryAt).toBeNull();
  expect(row.state).toBe("scheduled");

  // …and the moment block time catches up, the same cycle executes.
  chain.state.nowSeconds = Math.floor(clock / 1000);
  expect(await advanceAnchor(deps(), ENTITY_KEY)).toMatchObject({ version: 2, state: "executed" });
});

// ── F6/F8/F9: the cheap gates, one history read, one warning ───────────────────────────────

/** Put the formation steps a day in the past, where a real entity's are by the time an anchor
 *  cycle has been through a timelock. SQLite stamps CURRENT_TIMESTAMP at one-second resolution,
 *  and the fast path confirms a step and opens its version inside the same second — which the
 *  gates deliberately read as "the facts may have moved". */
function stampStepsYesterday(): void {
  db.prepare(
    `UPDATE formation_requests
        SET updated_at = datetime('now','-1 day'), facts_updated_at = datetime('now','-1 day')
      WHERE company_id = ?`,
  ).run(COMPANY_KEY);
}

/** Count manifest reads. The gates' whole purpose is that a quiet entity causes none. */
function countingDocStore(): () => number {
  const original = docStore.getBytes.bind(docStore);
  let reads = 0;
  docStore.getBytes = ((name: string) => {
    reads++;
    return original(name);
  }) as typeof docStore.getBytes;
  return () => reads;
}

test("F6: a fully anchored entity is dismissed without reading a single manifest", async () => {
  seedV1();
  confirmFiling();
  confirmEin();
  await advanceAnchor(deps(), ENTITY_KEY);
  warpPastDelay();
  await advanceAnchor(deps(), ENTITY_KEY);
  expect(cycle(2)!.state).toBe("executed");
  // In production the facts land well before the anchor write that folds them in; SQLite's
  // one-second stamps make them look simultaneous inside a test, so the steps are stamped where
  // they would really be.
  stampStepsYesterday();

  const reads = countingDocStore();
  expect(await advanceAnchor(deps(), ENTITY_KEY)).toMatchObject({ skipped: "fully_anchored" });
  expect(reads()).toBe(0);
});

test("F6: a cycle inside its timelock with no new facts costs no file I/O either", async () => {
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  stampStepsYesterday();

  const reads = countingDocStore();
  expect(await advanceAnchor(deps(), ENTITY_KEY)).toMatchObject({
    version: 2,
    state: "scheduled",
    skipped: "not_due",
  });
  expect(reads()).toBe(0);
  // …but a step that MOVES is re-derived, timelock or not: the scheduled version has to be
  // superseded the moment the facts it describes stop being the newest ones.
  confirmEin();
  expect(await advanceAnchor(deps(), ENTITY_KEY)).toMatchObject({ version: 3, state: "scheduled" });
  expect(cycle(2)!.state).toBe("superseded");
});

test("F8: the cycle history is read ONCE per pass, not once per question", async () => {
  seedV1();
  confirmFiling();
  const original = anchors.versionsOf.bind(anchors);
  let calls = 0;
  anchors.versionsOf = ((k: string) => {
    calls++;
    return original(k);
  }) as typeof anchors.versionsOf;

  await advanceAnchor(deps(), ENTITY_KEY);
  expect(calls).toBe(1);
});

test("F9: a standing hold warns ONCE per entity per day, not once per tick", async () => {
  resetAnchorWarnings();
  seedV1();
  confirmFiling();
  await advanceAnchor(deps(), ENTITY_KEY);
  chain.veto(cycle(2)!.manifestHash);
  touchFacts();
  await advanceAnchor(deps(), ENTITY_KEY);

  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
  try {
    for (let i = 0; i < 5; i++) {
      clock = cycle(2)!.nextRetryAt ?? clock;
      await advanceAnchor(deps(), ENTITY_KEY);
    }
  } finally {
    spy.mockRestore();
  }
  expect(lines.filter((l) => l.includes("anchor_held"))).toHaveLength(1);

  // A new day says it again — the condition is still true and nobody has acted on it.
  clock += 24 * 60 * 60 * 1000;
  const nextDay: string[] = [];
  const spy2 = vi.spyOn(console, "log").mockImplementation((m) => nextDay.push(String(m)));
  try {
    await advanceAnchor(deps(), ENTITY_KEY);
  } finally {
    spy2.mockRestore();
  }
  expect(nextDay.filter((l) => l.includes("anchor_held"))).toHaveLength(1);
});

// ── F11 / F12: one hash-verify path, one warning, and the healed filing number ─────────────

test("F11: both sides of the hash-verify report under ONE event name", async () => {
  seedV1();
  confirmFiling();
  // The READ side: the anchored baseline no longer re-hashes to what we recorded.
  docStore.files.set(manifestDocName(ENTITY_KEY, 1), Buffer.from("{}\n", "utf8"));
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
  try {
    await advanceAnchor(deps(), ENTITY_KEY);
  } finally {
    spy.mockRestore();
  }
  // "The file on disk is not the anchor it claims to be" is ONE fact, whichever side notices it,
  // and it used to be two event names an operator had to know to grep for.
  const unverifiable = lines
    .map((l) => JSON.parse(l))
    .filter((l) => l.opslog?.startsWith("anchor_"));
  expect(unverifiable.map((l) => l.opslog)).toEqual(["anchor_manifest_unverifiable"]);
  expect(unverifiable[0]).toMatchObject({ severity: "CRITICAL", version: 1 });
  expect(cycles()).toHaveLength(0);
});

test("F12: a filing number that arrives late unblocks v2 — the refusal is a wait, not a deadlock", async () => {
  resetAnchorWarnings();
  seedV1();
  confirmFiling({ filingNumber: null });
  // Anchoring a manifest that claims a filing with no filing number would be the dishonest fix.
  expect(await advanceAnchor(deps(), ENTITY_KEY)).toMatchObject({ skipped: "no_new_facts" });
  expect(cycles()).toHaveLength(0);

  // The warning is deduped like every other standing condition (F9) — this used to be one WARN
  // per entity per tick, forever.
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
  try {
    for (let i = 0; i < 3; i++) await advanceAnchor(deps(), ENTITY_KEY);
  } finally {
    spy.mockRestore();
  }
  expect(lines.filter((l) => l.includes("anchor_awaiting_filing_number"))).toHaveLength(0);

  // `advanceFiling` heals the number onto the record on a later poll (F12); the anchor loop then
  // has both halves and opens v2 on the very next pass.
  companies.recordFilingFacts(COMPANY_KEY, { filingNumber: "2026-001234567" });
  expect(await advanceAnchor(deps(), ENTITY_KEY)).toMatchObject({ version: 2, state: "scheduled" });
  expect(parseManifest(docStore.getBytes(manifestDocName(ENTITY_KEY, 2))).legal?.filingNumber).toBe(
    "2026-001234567",
  );
});
