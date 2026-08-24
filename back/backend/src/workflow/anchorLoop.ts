import type { Address, Hex } from "viem";
import { decodedRevertName } from "../adapters/arc/relay";
import type { DoolaEnvironment } from "../adapters/doola/types";
import {
  MAX_ANCHOR_REVERT_ATTEMPTS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  VETO_RECHECK_CAP_MS,
  nextInterval,
} from "../formation/schedule";
import { companyFiled, documentsFetched, einIssued, providerRefOf } from "../formation/status";
import {
  type JsonValue,
  ManifestError,
  type ManifestLegal,
  type OaBundleManifest,
  buildManifestNext,
  canonicalizeJcs,
  manifestDocName,
  manifestHash,
  parseManifest,
  serializeManifestBytes,
} from "../oa/manifest";
import { opsLog } from "../observability/opsLog";
import {
  type DocumentIndexRepository,
  documentFileName,
} from "../persistence/documentIndexRepository";
import type { DocumentStore } from "../persistence/documentStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type {
  FormationRepository,
  FormationRequestRecord,
} from "../persistence/formationRepository";
import {
  HOLD_STATES,
  OPEN_STATES,
  type OaAnchorRecord,
  type OaAnchorRepository,
  type OaAnchorState,
} from "../persistence/oaAnchorRepository";
import type { EntityRecord } from "../types";
import { parseSqliteUtc } from "../util/sqliteTime";
import { FORMATION_ENTITY_TYPE, FORMATION_STATE } from "./formationProvider";
import { usesManifestScheme } from "./onboarding";

/**
 * THE ANCHOR SUB-SAGA (design 2026-08-19 §7) — the B+ core.
 *
 * Every material legal change (the state filed the company; the IRS issued the EIN) produces a
 * new version of the OA bundle manifest, whose keccak goes on chain through `LegalManager`'s
 * existing timelocked amendment path. This module is the whole of that: derive the target,
 * write it, schedule it, wait out the timelock, execute it — with the guardian able to stop it
 * at any point in between.
 *
 * ── Why this file is so defensive ──────────────────────────────────────────────────────────
 *
 * The contract has four properties that make the obvious implementation wrong, and every one of
 * them was found by the design's adversarial audit (C1). They are worth stating once, here,
 * because almost every branch below exists to respect one of them:
 *
 *  1. **Re-scheduling a hash silently RESETS its clock.** `scheduleOperatingAgreementUpdate` has
 *     no `AlreadyScheduled` guard (unlike the treasury's twin), so a retry that "just schedules
 *     again" hands the guardian a shorter veto window than the notification named. We therefore
 *     schedule only when `scheduledAt(hash) == 0`.
 *  2. **`executeOperatingAgreementUpdate` DELETES `scheduledAt[hash]`.** So `== 0` is ambiguous
 *     between "never scheduled" and "already executed", and a crash between the execute
 *     broadcast and its receipt would otherwise re-schedule an executed version — letting a
 *     stale manifest land AFTER a newer one. `meta().operatingAgreementHash` is what
 *     disambiguates, and it is read FIRST — before the manifest is even re-hashed, because a
 *     version the chain already holds is a version there is nothing left to verify about (F3).
 *  3. **There is no manager-side cancel.** Once a hash is scheduled we cannot take it back; the
 *     guardian's veto is the only stop, and it permanently blacklists that hash. Which is why a
 *     superseded-but-scheduled version is left to expire rather than "cancelled", and why the
 *     manifest bytes are re-read and re-hashed AGAIN immediately before the execute broadcast.
 *  4. **A scheduled hash stays executable forever** once its delay elapses. Nothing on chain
 *     enforces ordering between two scheduled amendments, so ORDERING IS OURS: the monotonic
 *     rules below (single pending version; `version > entities.oa_manifest_version` on both
 *     legs) are load-bearing, not belt-and-braces. The Foundry tests assert exactly this.
 *
 * ── Concurrency ────────────────────────────────────────────────────────────────────────────
 *
 * DB-level, not mutex-level (audit M13/20): every state move is a compare-and-set, and the entity
 * columns are written inside the transaction that WON it. `withKeyedLock` is layered on by the
 * callers as an optimization — this module is deliberately lock-free so it can be called from
 * inside a lock the caller already holds (the processor does exactly that).
 *
 * ── The projection ─────────────────────────────────────────────────────────────────────────
 *
 * Nothing here writes `entities.oa_manifest_*` directly. Those five columns are a projection of
 * `oa_anchors`, recomputed from the rows by `transitionAndProject` inside the transaction that
 * won the CAS (review F2). Six call sites each deciding for themselves what "pending" meant is
 * how a supersede with no successor left an entity advertising an amendment that had ceased to
 * exist.
 *
 * ── What never enters an anchor ────────────────────────────────────────────────────────────
 *
 * No webhook payload, ever (audit H2): the legal block is assembled from the ENTITY RECORD and
 * the `documents` index, both of which were written from an authenticated re-fetch. And no PII:
 * the manifest names a company, its filing and its documents' hashes — never a person.
 */

// ── deps ────────────────────────────────────────────────────────────────────────────────────

/** `LegalManager.Status.Active`. Amendments are gated `whenActive` on BOTH legs. */
export const LEGAL_STATUS_ACTIVE = 0;

/**
 * The slice of the chain adapter this loop uses.
 *
 * An interface rather than `ArcAdapter` so the tests can drive every branch — including the ones
 * that only happen when a broadcast is lost — without an RPC. `ArcAdapter` satisfies it
 * structurally.
 */
export interface AnchorChain {
  legalStatus(proxy: Address): Promise<number>;
  oaCurrentHash(proxy: Address): Promise<Hex>;
  oaScheduledAt(proxy: Address, hash: Hex): Promise<bigint>;
  oaVetoed(proxy: Address, hash: Hex): Promise<boolean>;
  oaAmendmentDelay(proxy: Address): Promise<bigint>;
  /** BROADCAST ONLY — the caller persists the hash before awaiting the receipt. */
  scheduleOperatingAgreementUpdate(
    proxy: Address,
    newHash: Hex,
    agentManager?: Address,
  ): Promise<Hex>;
  executeOperatingAgreementUpdate(
    proxy: Address,
    newHash: Hex,
    agentManager?: Address,
  ): Promise<Hex>;
  /** BOUNDED — a receipt that never arrives times out and parks the cycle (F7). */
  waitForManagerReceipt(txHash: Hex): Promise<{ status: "success" | "reverted" }>;
}

/** What the anchor loop needs BEYOND the formation deps it shares with fetch-and-advance. */
export interface AnchorWiring {
  anchors: OaAnchorRepository;
  arc: AnchorChain;
  /** The chain the manifest commits to (domain separation, M9). */
  chainId: number;
}

export type AnchorLoopDeps = AnchorWiring & {
  repo: EntityRepository;
  requests: FormationRepository;
  documents: DocumentIndexRepository;
  docStore: DocumentStore;
  /** The environment THIS DEPLOYMENT runs, compared against every entity's pin (audit M5). */
  environment: DoolaEnvironment;
  now?: () => number;
};

/** Why a pass did nothing. Every one of these is a normal, expected outcome. */
export type AnchorSkip =
  | "no_entity"
  | "not_manifest_scheme"
  | "not_pinned"
  | "not_anchored"
  | "environment_pin"
  | "hold_park"
  | "no_new_facts"
  | "fully_anchored"
  | "not_due"
  | "not_active";

export interface AnchorOutcome {
  /** Did anything about this entity's anchor state change? */
  advanced: boolean;
  version?: number;
  state?: OaAnchorState;
  skipped?: AnchorSkip;
}

const NOTHING: AnchorOutcome = { advanced: false };

/** Ids, versions, states and tx hashes only — never a document, never a person (design §7). */
function logAnchor(
  entityKey: string,
  version: number,
  state: OaAnchorState,
  extra: Record<string, unknown> = {},
): void {
  opsLog("anchor_step", { entityKey, version, state, ...extra });
}

// ── warning de-duplication (review F9) ──────────────────────────────────────────────────────

/**
 * Standing conditions warn ONCE PER ENTITY PER DAY, keyed `code:entityKey:YYYY-MM-DD`.
 *
 * Three of this module's WARN lines describe a state that does not change on its own: a held
 * pipeline, an entity pinned to the other environment, a filing confirmed without a number. The
 * sweeper visits each of them every tick, so at the 60s default they produced 1,440 identical
 * lines a day per entity — which does not make the condition more visible, it makes journald less
 * readable and buries the lines that fire once.
 *
 * In memory, and deliberately so (the sweeper's `warned` rule): this de-duplicates an ops LINE,
 * not state anything depends on. A restart re-warns, which is the failure direction to prefer.
 */
const warned = new Set<string>();

function warnOnce(
  code: string,
  entityKey: string,
  now: number,
  fields: Record<string, unknown>,
): void {
  const day = new Date(now).toISOString().slice(0, 10);
  const key = `${code}:${entityKey}:${day}`;
  if (warned.has(key)) return;
  // Yesterday's keys can never match again. Pruned here rather than on a timer, because this is
  // the only place the set grows and the API process is meant to run for months.
  for (const old of warned) if (!old.endsWith(`:${day}`)) warned.delete(old);
  warned.add(key);
  opsLog(code, { level: "warn", entityKey, ...fields });
}

/** Tests only: the de-dup set is process-wide, so a test asserting a warn must start clean. */
export function resetAnchorWarnings(): void {
  warned.clear();
}

// ── the entry point ─────────────────────────────────────────────────────────────────────────

/**
 * Advance ONE entity's anchor pipeline as far as it can go right now.
 *
 * Called from two places, both of which already hold the entity's keyed lock: the sweeper's
 * anchor phase (which is what makes progress guaranteed) and fetch-and-advance (which is what
 * makes it fast — a webhook that confirms the filing opens v2 within the second).
 *
 * Never throws for an ordinary failure. A transport error parks the cycle with a doubling
 * backoff and NO attempt bump, for the same reason a failed doola read does not burn one: a lost
 * receipt is not evidence about whether the amendment is going through, and the only thing an
 * attempt counter can do here is abandon a legitimate one. A DECODED CONTRACT REVERT is the
 * opposite and does burn one — see `classifyChainFailure`.
 *
 * ── The gate order (review F6) ──────────────────────────────────────────────────────────────
 *
 * Everything that can be answered from the database is answered before anything is read off the
 * disk. `loadAnchoredManifest` reads a file, hashes it and parses it, and `reconcileTarget` then
 * serializes and hashes a candidate — per entity, per tick, forever. A parked cycle, an entity
 * whose amendment is still inside its timelock and an entity that will never anchor again are all
 * dismissed above that line.
 */
export async function advanceAnchor(d: AnchorLoopDeps, entityKey: string): Promise<AnchorOutcome> {
  const rec = d.repo.findByIdempotencyKey(entityKey);
  if (!rec) return { advanced: false, skipped: "no_entity" };
  const now = (d.now ?? Date.now)();

  // ── Gates. A legacy row, a stub deployment or a legacy-scheme record must never reach the
  //    chain from here: `formation_provider = null` is stub forever, and a record anchored under
  //    the document scheme has an `oa_hash` that commits to a terms doc, not to a manifest.
  if (!usesManifestScheme(rec)) return { advanced: false, skipped: "not_manifest_scheme" };
  if (!rec.formationProvider || !rec.formationEnvironment)
    return { advanced: false, skipped: "not_pinned" };
  if (!rec.proxy || !rec.agentId || rec.oaManifestVersion == null || !rec.oaManifestAnchoredHash)
    // Nothing is anchored yet: the create tx has not confirmed, so there is no proxy to amend and
    // no v1 to chain onto. The onboarding saga owns this window.
    return { advanced: false, skipped: "not_anchored" };

  // Environment pinning (audit M5), before any chain read — the same refusal fetch-and-advance
  // makes, for the same reason: a config flip must never act on an entity pinned elsewhere.
  if (rec.formationEnvironment !== d.environment) {
    warnOnce("anchor_environment_mismatch", entityKey, now, {
      pinned: rec.formationEnvironment,
      deployment: d.environment,
    });
    return { advanced: false, skipped: "environment_pin" };
  }

  try {
    // ONE read of this entity's cycle history per pass (review F8). It answers the hold check,
    // the open-cycle lookup and the highest-version reduce; it is re-read only when this pass has
    // itself moved rows (a lifted veto) or after a lost CAS — the two moments it is provably
    // stale.
    //
    // A veto parks the WHOLE pipeline (design §7, audit H4) — it is a stop sign, not a per-hash
    // speed bump a re-versioning backend routes around. Checked before anything else.
    const hold = await parkedByHold(d, rec, d.anchors.versionsOf(entityKey), now);
    if (hold.held) return { advanced: false, skipped: "hold_park" };
    const all = hold.all;

    const open = newestOpen(all);
    const steps = d.requests.stepsOf(entityKey);

    // A parked cycle waits out its backoff. `next_retry_at` is epoch MILLISECONDS (the sweeper's
    // clock); `executable_at` below is unix SECONDS (chain time). They are different units
    // because they answer to different clocks, and both are labeled everywhere they appear.
    if (open && open.nextRetryAt !== null && now < open.nextRetryAt)
      return { advanced: false, version: open.version, state: open.state, skipped: "not_due" };

    // An amendment inside its timelock, with no formation step touched since the cycle was last
    // written: there is provably nothing to re-derive. EVERY fact `deriveLegalBlock` reads is
    // written in the same transaction as a `formation_requests` row (the filing facts and the EIN
    // inside their confirming CAS, the documents alongside the `fetch_documents` detail), so a
    // step's `updated_at` is a sound upper bound on when the facts last moved.
    if (open && awaitingTimelock(open, now) && !factsMovedSince(steps, open))
      return { advanced: false, version: open.version, state: open.state, skipped: "not_due" };

    // Fully and finally anchored: the IRS has issued, the anchored cycle was written after that
    // landed, and no cycle is open or held. The EIN is the LAST fact this entity can ever
    // produce, so the anchored manifest already carries it and no version will ever follow.
    if (!open && fullyAnchored(all, steps)) return { advanced: false, skipped: "fully_anchored" };

    const legal = deriveLegalBlock(d, rec, steps);
    // Nothing new to say and nothing in flight: the quiet entity, answered without a file read.
    if (!legal && !open) return { advanced: false, skipped: "no_new_facts" };

    let target = open;
    if (legal) {
      // Only NOW is the anchored manifest worth reading: it is the document the candidate chains
      // onto, and without a candidate there is nothing to chain.
      const prev = loadAnchoredManifest(d, rec);
      if (!prev) return NOTHING; // corrupt/unreadable baseline — already parked and logged
      target = await reconcileTarget(d, rec, prev, legal, all, open);
    }
    if (!target) return { advanced: false, skipped: "no_new_facts" };
    return await driveCycle(d, rec, target);
  } catch (err) {
    // The catch-all exists so one entity's bad minute cannot stop a sweep. Anything that reaches
    // here without having parked a row is a bug, so it is logged loudly rather than swallowed.
    opsLog("anchor_failed", {
      level: "error",
      entityKey,
      message: (err as Error).message,
    });
    return NOTHING;
  }
}

// ── the cheap gates ─────────────────────────────────────────────────────────────────────────

/** The entity's single in-flight cycle (single-pending rule), out of the one snapshot. */
function newestOpen(all: readonly OaAnchorRecord[]): OaAnchorRecord | undefined {
  return all.filter((r) => (OPEN_STATES as readonly string[]).includes(r.state)).at(-1);
}

/** A scheduled amendment whose timelock has not elapsed. Unix SECONDS — chain time. */
function awaitingTimelock(row: OaAnchorRecord, nowMs: number): boolean {
  return (
    row.state === "scheduled" &&
    (row.executableAt === null || Math.floor(nowMs / 1000) < row.executableAt)
  );
}

/** Has any formation step been written since this cycle was? `>=` because both timestamps have
 *  one-SECOND resolution and the fast path confirms a step and opens its version inside the same
 *  second: the safe direction is to re-derive one time too many, never one too few. */
function factsMovedSince(steps: FormationRequestRecord[], row: OaAnchorRecord): boolean {
  const at = parseSqliteUtc(row.updatedAt);
  return steps.some((s) => parseSqliteUtc(s.updatedAt) >= at);
}

/**
 * Is this entity done for good (review F6)?
 *
 * The check is deliberately made of facts already in memory: `await_ein` confirmed means no
 * further legal fact can arrive, and an anchored cycle written after every step means the manifest
 * the chain holds already folded them all in. Proving the same thing by reading the anchored
 * manifest and comparing its `legal.ein` would cost a file read and two hashes to reach a
 * conclusion that cannot change.
 */
function fullyAnchored(all: readonly OaAnchorRecord[], steps: FormationRequestRecord[]): boolean {
  if (!einIssued(steps)) return false;
  if (all.some((r) => (HOLD_STATES as readonly string[]).includes(r.state))) return false;
  const anchored = all.filter((r) => r.state === "executed").at(-1);
  return anchored !== undefined && !factsMovedSince(steps, anchored);
}

// ── the veto park ───────────────────────────────────────────────────────────────────────────

/**
 * Is this entity's pipeline HELD — and, if it is held by a veto, has the guardian lifted it?
 *
 * Two states park the whole pipeline rather than just their own cycle:
 *
 *  - `vetoed`. A veto blacklists ONE hash, so a backend that simply re-versioned around it would
 *    defeat the guardian entirely (audit H4). It ends on chain via `liftVeto`, which this
 *    observes, or via `acknowledgeHold` — an operator saying "that version is dead, move on".
 *  - `failed`. Today that means either a scheduled manifest stopped re-hashing to its anchor, or a
 *    manager call reverted deterministically until its attempts ran out. Both leave an amendment
 *    LIVE on chain with only the guardian able to stop it. Building a successor while that is true
 *    would be the platform quietly moving on from a problem the operator has to see. Ends only by
 *    acknowledgement.
 *
 * The lift check is SCHEDULED like every other chain read (review F6): a held entity is a
 * candidate on every single tick, `liftVeto` is a human action measured in hours, and an RPC per
 * tick per vetoed entity buys nothing. A transport failure here parks with the same backoff every
 * other read gets — it must never reach the catch-all and read as `anchor_failed`.
 *
 * When a lift IS observed, only the NEWEST vetoed version resumes; older ones are superseded, so
 * the single-pending rule survives a guardian who vetoed twice and lifted both.
 */
type HoldOutcome =
  | { held: true }
  /** Not held — carrying the snapshot, refreshed iff this call moved any row. */
  | { held: false; all: readonly OaAnchorRecord[] };

async function parkedByHold(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  all: readonly OaAnchorRecord[],
  now: number,
): Promise<HoldOutcome> {
  const key = rec.idempotencyKey;
  const failed = all.filter((r) => r.state === "failed");
  if (failed.length > 0) {
    warnOnce("anchor_held", key, now, {
      versions: failed.map((r) => r.version),
      reason:
        "a cycle is in `failed` and needs an operator acknowledgement before anchoring resumes",
    });
    return { held: true };
  }
  const vetoed = all.filter((r) => r.state === "vetoed");
  if (vetoed.length === 0) return { held: false, all };

  const proxy = rec.proxy as Address;
  const lifted: OaAnchorRecord[] = [];
  for (const row of vetoed) {
    if (row.nextRetryAt !== null && now < row.nextRetryAt) return heldWarn(key, vetoed, now);
    const still = await tryChain(d, row, () => d.arc.oaVetoed(proxy, row.manifestHash));
    if (still.stop) return { held: true }; // transient RPC: parked with backoff, the park stands
    if (still.value) {
      scheduleVetoRecheck(d, row, now);
      return heldWarn(key, vetoed, now);
    }
    lifted.push(row);
  }

  // Every veto has been lifted. Newest resumes; the rest are history.
  const newest = lifted[lifted.length - 1]!;
  for (const row of lifted) {
    const to: OaAnchorState = row.version === newest.version ? "pending" : "superseded";
    if (
      d.anchors.transitionAndProject(key, row.version, "vetoed", to, {
        error: null,
        // ── The wedge (review F1). The veto DELETED this hash's schedule, so the persisted
        //    `schedule_tx` now describes something the chain does not have. Left in place, the
        //    schedule leg read `scheduledAt == 0`, found the mined tx, and parked "refusing to
        //    re-broadcast blindly" — forever, on every pass, for a cycle whose only problem was
        //    that it had been stopped and un-stopped. Re-scheduling resets no clock here: there
        //    is no clock.
        clearScheduleTx: true,
        clearExecuteTx: true,
      })
    )
      logAnchor(key, row.version, to, { code: "veto_lifted" });
  }
  // Rows moved, so the caller's snapshot is stale by our own hand: the resumed cycle reads
  // `vetoed` in it, which would leave the pass with no open cycle and mint a successor around the
  // very version the guardian just released.
  return { held: false, all: d.anchors.versionsOf(key) };
}

function heldWarn(key: string, vetoed: OaAnchorRecord[], now: number): HoldOutcome {
  warnOnce("anchor_held", key, now, {
    versions: vetoed.map((r) => r.version),
    reason: "the guardian's veto is still in place — anchoring resumes on liftVeto or an ack",
  });
  return { held: true };
}

/** Space out the next `vetoed(hash)` read, preserving the row's error (it is still the veto).
 *  Its own cap: a guardian who lifts a veto must not wait hours for the pipeline to notice. */
function scheduleVetoRecheck(d: AnchorLoopDeps, row: OaAnchorRecord, now: number): void {
  const retryIntervalMs = nextInterval(
    row.retryIntervalMs ?? undefined,
    RETRY_BASE_MS,
    VETO_RECHECK_CAP_MS,
  );
  d.anchors.transition(row.entityKey, row.version, "vetoed", "vetoed", {
    error: row.error,
    nextRetryAt: now + retryIntervalMs,
    retryIntervalMs,
  });
}

// ── the baseline: the manifest the chain currently holds ────────────────────────────────────

interface AnchoredManifest {
  manifest: OaBundleManifest;
  hash: Hex;
}

/**
 * Read back the ANCHORED manifest — the document the next version chains onto.
 *
 * Three things are verified, and all three are the difference between a verifiable history and a
 * plausible-looking one: the bytes are canonical (`parseManifest`), their keccak IS the hash we
 * recorded as anchored, and the document's own `version` is the version we think is anchored. A
 * failure here parks the pipeline rather than guessing, because every later `previous` link would
 * inherit the mistake.
 *
 * The hash check is `verifyStoredManifest`'s — ONE hash-verify path and one event name for the
 * whole module (review F11), because "the file on disk is not the anchor it claims to be" is one
 * fact whichever side of the pipeline notices it.
 */
function loadAnchoredManifest(d: AnchorLoopDeps, rec: EntityRecord): AnchoredManifest | undefined {
  const key = rec.idempotencyKey;
  const version = rec.oaManifestVersion!;
  const hash = rec.oaManifestAnchoredHash as Hex;
  const bytes = verifyStoredManifest(d, key, version, hash, { declaredVersion: version });
  if (!bytes) return undefined;
  return { manifest: parseManifest(bytes), hash };
}

// ── the target: which version, and what does it say ─────────────────────────────────────────

/**
 * The legal block THIS entity's facts justify right now, or null if they do not justify one yet.
 *
 * The trigger, stated as data rather than as a sequence of `if`s (design §7): v2 becomes possible
 * when `await_filing` AND `fetch_documents` are both confirmed, because that is the moment both
 * halves exist — a filing date and filing number on the record, and the two required documents'
 * sha256s in the index. v3 follows when `await_ein` confirms. The step predicates are the shared
 * ones in `formation/status` (review F11), so a renamed step fails to compile rather than
 * silently stalling every entity. Everything is read from the ENTITY RECORD and the `documents`
 * table, never from a webhook payload (audit H2) and never from a live provider response, so
 * re-deriving a version after a restart produces the same bytes.
 */
export function deriveLegalBlock(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  steps: FormationRequestRecord[] = d.requests.stepsOf(rec.idempotencyKey),
): ManifestLegal | null {
  const key = rec.idempotencyKey;
  const providerRef = providerRefOf(steps);
  if (!providerRef) return null;
  if (!companyFiled(steps) || !documentsFetched(steps)) return null;
  if (rec.formationFiledAt == null) return null;
  if (!rec.formationFilingNumber) {
    // The filing number is part of the v2 trigger, and anchoring a manifest that claims a filing
    // with no filing number would be the dishonest fix. `advanceFiling` now HEALS the number onto
    // the entity on any later poll that reports one (review F12), so this is a wait, not a
    // deadlock — but it is a wait an operator should be able to see, once a day.
    warnOnce("anchor_awaiting_filing_number", key, (d.now ?? Date.now)(), {
      providerRef,
      message:
        "formation is confirmed filed but the record carries no filing number — v2 cannot be anchored until it does",
    });
    return null;
  }

  const docs = d.documents.listByEntity(key);
  if (docs.length === 0) return null;

  return {
    provider: rec.formationProvider!,
    environment: rec.formationEnvironment!,
    providerCompanyId: providerRef,
    // The values we FILED with, imported from the filer (see their doc comment) — not read back
    // off a provider response, which would put a partner-controlled string inside the anchor.
    entityType: FORMATION_ENTITY_TYPE,
    state: FORMATION_STATE,
    formationDate: rec.formationFiledAt,
    filingNumber: rec.formationFilingNumber,
    // v2 anchors WITHOUT an EIN and says so: the IRS takes four to six weeks, and pretending
    // otherwise is the deception §2 forbids. v3 lands when the IRS does.
    ein: einIssued(steps) ? (rec.einReal ?? null) : null,
    documents: docs.map((r) => ({
      type: r.docType,
      sha256: r.sha256,
      // The name we DERIVE from the type, which is also the filename the download route offers —
      // never doola's own `name` field, which is partner-controlled free text that would end up
      // hashed onto a public chain.
      name: documentFileName(r.docType),
    })),
  };
}

/**
 * Two legal blocks say the same thing iff their CANONICAL forms are identical.
 *
 * Compared through the same serializer the anchor is computed with, deliberately: "have the facts
 * changed?" and "is this a different anchor?" must be the same question, or an entity could churn
 * out a new version for a change that hashes identically (or, worse, sit still through one that
 * does not). The cast is the one `serializeManifest` already documents — a manifest fragment IS a
 * JsonValue, it just lacks the index signature TypeScript needs to prove it.
 */
function sameLegal(a: ManifestLegal | null, b: ManifestLegal | null): boolean {
  if (a === null || b === null) return a === b;
  return canonicalizeJcs(a as unknown as JsonValue) === canonicalizeJcs(b as unknown as JsonValue);
}

/**
 * Decide which cycle should be in flight, opening or superseding one as needed.
 *
 * THE SINGLE-PENDING RULE (design §4, audit C1 part 1) lives here. At most one version per entity
 * may be pending, and when new facts arrive while v(n) is in flight there are exactly two shapes:
 *
 *  - v(n) is `pending` and NOT yet broadcast — it never reached the chain, so it is simply marked
 *    `superseded` and v(n+1) folds ALL the facts;
 *  - v(n) is already `scheduled` on chain — there is no manager-side cancel, so it is marked
 *    `superseded` and LEFT TO EXPIRE UNEXECUTED. Nothing on chain stops it from being executed
 *    forever (contract property 4 above), which is precisely why the execute leg re-checks the
 *    version and why monitoring treats an execute of a non-current version as CRITICAL.
 *
 * Returns the cycle to drive, or undefined when there is nothing to anchor.
 */
async function reconcileTarget(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  prev: AnchoredManifest,
  legal: ManifestLegal,
  all: readonly OaAnchorRecord[],
  open: OaAnchorRecord | undefined,
): Promise<OaAnchorRecord | undefined> {
  const key = rec.idempotencyKey;

  const chain = {
    chainId: d.chainId,
    legalManager: rec.proxy as string,
    agentId: rec.agentId as string,
  };
  const build = (version: number) => {
    const manifest = buildManifestNext(prev.manifest, version, chain, legal);
    const bytes = serializeManifestBytes(manifest);
    return { manifest, bytes, hash: manifestHash(bytes) };
  };

  if (open) {
    // Is the in-flight cycle still the right one? Built at ITS version, so the comparison is on
    // the facts alone — a matching hash means nothing material has changed since it was opened.
    let candidate: ReturnType<typeof build> | undefined;
    try {
      candidate = build(open.version);
    } catch (err) {
      // The open cycle's version can no longer be built (e.g. it is not ahead of the anchored
      // one any more — a version this entity has already anchored). Superseding is the honest
      // outcome; the block below opens a fresh one.
      opsLog("anchor_target_unbuildable", {
        level: "warn",
        entityKey: key,
        version: open.version,
        message: (err as Error).message,
      });
    }
    if (candidate && candidate.hash === open.manifestHash) return open;

    // Facts moved. Supersede — from whatever state the row is actually in, via CAS.
    //
    // The two shapes the design distinguishes are "already on chain" and "not yet", and the fact
    // that decides it is whether a schedule was ever BROADCAST — not the row's state. A `pending`
    // row carrying a `schedule_tx` may well be on chain (the broadcast landed and the receipt was
    // lost), so it gets the same honest wording as a `scheduled` one: it is left to expire.
    const onChain = open.state === "scheduled" || open.scheduleTx !== null;
    const superseded = d.anchors.transitionAndProject(key, open.version, open.state, "superseded", {
      error: onChain
        ? "superseded by newer facts after its schedule was broadcast — left to expire unexecuted (there is no manager-side cancel)"
        : "superseded by newer facts before it was broadcast",
    });
    if (superseded)
      logAnchor(key, open.version, "superseded", {
        code: onChain ? "superseded_scheduled" : "superseded_pending",
        txHash: open.scheduleTx ?? undefined,
      });
    else return d.anchors.find(key, open.version); // lost the race; re-read and let the winner drive
  }

  // The next version: strictly ahead of BOTH the anchored one and every cycle ever opened, so a
  // superseded v3 can never be re-claimed as a v3 with different bytes.
  const highest = all.reduce((m, r) => Math.max(m, r.version), 0);
  const version = Math.max(rec.oaManifestVersion ?? 1, highest) + 1;

  let built: ReturnType<typeof build>;
  try {
    built = build(version);
  } catch (err) {
    opsLog("anchor_build_failed", {
      severity: "CRITICAL",
      level: "error",
      entityKey: key,
      version,
      message: (err as Error).message,
    });
    return undefined;
  }

  // No material change against what the chain already holds: nothing to anchor. Checked AFTER a
  // supersede too, and deliberately — an entity whose anchored version moved on underneath an
  // open cycle (the version-regression shape) must retire that cycle WITHOUT minting a successor
  // that says exactly what the chain already says.
  if (sameLegal(built.manifest.legal, prev.manifest.legal)) return undefined;

  // ── HASH-FINAL DISCIPLINE, first of two (audit M7). Write atomically, then read the file BACK
  //    and re-hash it. A torn or truncated manifest whose hash is already scheduled is a
  //    permanently unverifiable anchor, and there is no manager-side cancel to undo it.
  d.docStore.putBytes(manifestDocName(key, version), built.bytes);
  if (!verifyStoredManifest(d, key, version, built.hash)) return undefined;

  // Claim the cycle. `claimVersion` adopts rather than restarts: a crash between the write and
  // this claim re-derives the SAME bytes and the same hash, so the second pass finds its own row.
  // The projection — the pending pair the monitor and the guardian card read (audit H3/14) — is
  // recomputed inside the same transaction as the claim it describes.
  if (!d.anchors.claimVersionAndProject(key, version, built.hash)) {
    const existing = d.anchors.find(key, version);
    if (existing && existing.manifestHash !== built.hash) {
      opsLog("anchor_hash_conflict", {
        severity: "CRITICAL",
        level: "error",
        entityKey: key,
        version,
        recorded: existing.manifestHash,
        derived: built.hash,
        message:
          "a cycle for this version already exists with DIFFERENT bytes — refusing to anchor either",
      });
      return undefined;
    }
    return existing;
  }

  logAnchor(key, version, "pending", { code: "opened", manifestHash: built.hash });
  return d.anchors.find(key, version);
}

/**
 * Re-read a manifest from the store and re-hash it — the ONE check that makes "the file on disk
 * IS the anchor" a fact rather than an intention, used by both the write path (immediately after
 * `putBytes`) and the read path (the anchored baseline, and again before every execute).
 *
 * Returns the VERIFIED bytes, so a caller that needs the document does not read it twice.
 */
function verifyStoredManifest(
  d: AnchorLoopDeps,
  entityKey: string,
  version: number,
  expected: Hex,
  opts: { declaredVersion?: number } = {},
): Buffer | undefined {
  const name = manifestDocName(entityKey, version);
  try {
    const back = d.docStore.getBytes(name);
    const hash = manifestHash(back);
    if (hash !== expected)
      throw new ManifestError(`re-read ${name} hashes to ${hash}, not ${expected}`);
    if (opts.declaredVersion !== undefined) {
      const manifest = parseManifest(back);
      if (manifest.version !== opts.declaredVersion)
        throw new ManifestError(
          `stored ${name} declares version ${manifest.version}, not the anchored ${opts.declaredVersion}`,
        );
    }
    return back;
  } catch (err) {
    // CRITICAL either way: on the write path a torn manifest must never be scheduled, and on the
    // read path the anchored document cannot be reproduced from disk, so nothing can honestly
    // chain onto it. Anchoring stops until a human restores the file (doola remains the system of
    // record for the PDFs; the manifest is ours and lives in the backup runbook).
    opsLog("anchor_manifest_unverifiable", {
      severity: "CRITICAL",
      level: "error",
      entityKey,
      version,
      document: name,
      message: (err as Error).message,
    });
    return undefined;
  }
}

// ── driving one cycle ───────────────────────────────────────────────────────────────────────

async function driveCycle(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  row: OaAnchorRecord,
): Promise<AnchorOutcome> {
  const now = (d.now ?? Date.now)();
  // The backoff gate is hoisted into `advanceAnchor`; it is repeated here because a re-read row
  // (the CAS-lost path) may carry a schedule the caller's snapshot did not.
  if (row.nextRetryAt !== null && now < row.nextRetryAt)
    return { advanced: false, version: row.version, state: row.state, skipped: "not_due" };

  // The guardian's veto is read on EVERY pass, before the due gate — not as part of the two legs'
  // prechecks. A veto lands during the timelock window, which is precisely the window in which
  // this cycle has nothing else to do: deferring the observation until the amendment came due
  // would leave the row (and every surface reading it) claiming a pending amendment for a whole
  // timelock after the guardian had already stopped it.
  const vetoed = await tryChain(d, row, () =>
    d.arc.oaVetoed(rec.proxy as Address, row.manifestHash),
  );
  if (vetoed.stop) return vetoed.stop;
  if (vetoed.value) return recordVeto(d, rec, row);

  if (row.state === "pending") return schedulePhase(d, rec, row);
  if (row.state === "scheduled") return executePhase(d, rec, row);
  return NOTHING;
}

/**
 * The guardian stopped this amendment. The row parks, and with it the whole pipeline.
 *
 * Deliberately NOT a projecting transition: the amendment is still SCHEDULED on chain (a veto
 * blacklists the hash, it does not un-schedule the entity's pending state as far as any observer
 * is concerned), and the pending pair is exactly what the guardian card and the monitor's
 * compromise rule need to keep showing while a human decides what to do.
 */
function recordVeto(d: AnchorLoopDeps, rec: EntityRecord, row: OaAnchorRecord): AnchorOutcome {
  const key = rec.idempotencyKey;
  if (d.anchors.transition(key, row.version, row.state, "vetoed", { error: "guardian veto" }))
    logAnchor(key, row.version, "vetoed", { code: "guardian_veto" });
  opsLog("anchor_vetoed", {
    severity: "CRITICAL",
    level: "error",
    entityKey: key,
    version: row.version,
    manifestHash: row.manifestHash,
    message:
      "the guardian VETOED this manifest — the entity's whole anchor pipeline is parked until liftVeto or an operator acknowledgement",
  });
  return { advanced: true, version: row.version, state: "vetoed" };
}

/** The prechecks both legs share, in the ONE order §7 fixes. Returns an outcome when the caller
 *  must stop, or undefined to continue. */
async function commonPrechecks(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  row: OaAnchorRecord,
): Promise<AnchorOutcome | undefined> {
  const key = rec.idempotencyKey;
  const proxy = rec.proxy as Address;

  // `whenActive` gates schedule AND execute. A dissolving body parks the sub-saga rather than
  // failing it: dissolution is reversible until it is finalized (`cancelDissolution`).
  const status = await d.arc.legalStatus(proxy);
  if (status !== LEGAL_STATUS_ACTIVE) {
    park(d, row, `legal body is not Active (status ${status}) — the anchor pipeline is parked`);
    return { advanced: false, version: row.version, state: row.state, skipped: "not_active" };
  }

  // Contract property 2: `scheduledAt == 0` cannot tell "never scheduled" from "already
  // executed", so the chain's CURRENT hash is read first. Equal means this cycle is done —
  // recover, never re-schedule (the audit's regression scenario, exactly).
  const current = await d.arc.oaCurrentHash(proxy);
  if (current === row.manifestHash) {
    markExecuted(d, rec, row, row.executeTx ?? null, "recovered");
    return { advanced: true, version: row.version, state: "executed" };
  }

  // The monotonic gate, on BOTH legs. A superseded or older version can never be scheduled or
  // executed BY US — which is the whole reason the on-chain "stays executable forever" property
  // is survivable.
  const anchored = freshAnchoredVersion(d, key, rec);
  if (row.version <= anchored) {
    if (
      d.anchors.transitionAndProject(key, row.version, row.state, "superseded", {
        error: `v${row.version} does not advance the anchored v${anchored} — refusing to act on it`,
      })
    )
      logAnchor(key, row.version, "superseded", { code: "version_regression", anchored });
    return { advanced: true, version: row.version, state: "superseded" };
  }
  return undefined;
}

/** The anchored version, re-read: a doola round trip and a chain read have happened since the
 *  caller's snapshot, and the gate must not act on a stale number. */
function freshAnchoredVersion(d: AnchorLoopDeps, key: string, fallback: EntityRecord): number {
  return d.repo.findByIdempotencyKey(key)?.oaManifestVersion ?? fallback.oaManifestVersion ?? 1;
}

// ── the broadcast/persist/confirm shape, once ───────────────────────────────────────────────

/**
 * The half of each leg that is identical: adopt a persisted broadcast, or send a new one and
 * persist it BETWEEN the two awaits.
 *
 * That persist is the entire point of the split — a crash after the broadcast resumes by adopting
 * the tx rather than sending a second one, which for the schedule leg is not merely wasteful but
 * silently RESETS the guardian's veto window (contract property 1). It was written out twice, and
 * the two copies had already drifted in what they logged.
 *
 * `adopt` decides what a mined prior tx means for THIS leg and returns the outcome to stop with,
 * or undefined to say "that tx did not achieve it — send another".
 */
interface BroadcastLeg {
  priorTx: Hex | null;
  leg: "schedule" | "execute";
  adopt: () => Promise<AnchorOutcome | undefined>;
  send: () => Promise<Hex>;
  persistTx: (txHash: Hex) => void;
}

async function driveBroadcast(
  d: AnchorLoopDeps,
  row: OaAnchorRecord,
  o: BroadcastLeg,
): Promise<{ txHash?: Hex; stop?: AnchorOutcome }> {
  const { entityKey: key, version } = row;
  if (o.priorTx) {
    const receipt = await tryChain(d, row, () => d.arc.waitForManagerReceipt(o.priorTx!));
    if (receipt.stop) return { stop: receipt.stop };
    if (receipt.value!.status === "success") {
      const adopted = await o.adopt();
      if (adopted) return { stop: adopted };
    } else {
      logAnchor(key, version, row.state, { code: `${o.leg}_reverted`, txHash: o.priorTx });
    }
  }

  const sent = await tryChain(d, row, o.send);
  if (sent.stop) return { stop: sent.stop };
  const txHash = sent.value!;
  o.persistTx(txHash);
  logAnchor(key, version, row.state, { code: `${o.leg}_broadcast`, txHash });

  const receipt = await tryChain(d, row, () => d.arc.waitForManagerReceipt(txHash));
  if (receipt.stop) return { stop: receipt.stop };
  if (receipt.value!.status !== "success") {
    park(d, row, `${o.leg} tx ${txHash} reverted`);
    return { stop: NOTHING };
  }
  return { txHash };
}

/** pending -> scheduled: broadcast, persist, confirm. */
async function schedulePhase(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  row: OaAnchorRecord,
): Promise<AnchorOutcome> {
  const key = rec.idempotencyKey;
  const proxy = rec.proxy as Address;

  const pre = await tryChain(d, row, () => commonPrechecks(d, rec, row));
  if (pre.stop) return pre.stop;
  if (pre.value) return pre.value;

  const scheduled = await tryChain(d, row, () => d.arc.oaScheduledAt(proxy, row.manifestHash));
  if (scheduled.stop) return scheduled.stop;

  // Already on chain: ADOPT it. This is the crash-between-broadcast-and-persist window — the
  // chain has the schedule, our row does not know its tx. Re-broadcasting here would reset the
  // guardian's veto window (contract property 1).
  if (scheduled.value! > 0n)
    return confirmScheduled(d, rec, row, Number(scheduled.value!), row.scheduleTx ?? null);

  // A persisted broadcast the chain does not reflect: either it reverted (re-broadcasting is
  // exactly right — `scheduledAt == 0` proves there is no clock to reset) or it succeeded and
  // something removed the schedule afterwards, which `scheduleGone` adjudicates.
  const drive = await driveBroadcast(d, row, {
    priorTx: row.scheduleTx,
    leg: "schedule",
    adopt: async () => {
      // Mined successfully and yet nothing is scheduled: re-read once before believing it.
      const again = await tryChain(d, row, () => d.arc.oaScheduledAt(proxy, row.manifestHash));
      if (again.stop) return again.stop;
      if (again.value! > 0n)
        return confirmScheduled(d, rec, row, Number(again.value!), row.scheduleTx);
      return scheduleGone(d, rec, row);
    },
    send: () =>
      d.arc.scheduleOperatingAgreementUpdate(proxy, row.manifestHash, rec.manager as Address),
    persistTx: (txHash) => {
      d.anchors.transition(key, row.version, "pending", "pending", { scheduleTx: txHash });
    },
  });
  if (drive.stop) return drive.stop;

  // Prefer the CHAIN's own executableAt over `now + amendmentDelay()`: the guardian's countdown
  // is a promise about when we may act, and block time is the only clock that decides it.
  const onChain = await tryChain(d, row, () => d.arc.oaScheduledAt(proxy, row.manifestHash));
  let executableAt = onChain.stop ? 0 : Number(onChain.value!);
  if (executableAt === 0) {
    const delay = await tryChain(d, row, () => d.arc.oaAmendmentDelay(proxy));
    if (delay.stop) return delay.stop;
    executableAt = Math.floor((d.now ?? Date.now)() / 1000) + Number(delay.value!);
  }
  return confirmScheduled(d, rec, row, executableAt, drive.txHash!);
}

/**
 * Our schedule tx MINED, and the chain has no schedule for the hash. What now (review F1)?
 *
 * There is exactly one benign shape, and it is the guardian's: `cancelOperatingAgreementUpdate`
 * DELETES `scheduledAt[hash]` and blacklists the hash, and `liftVeto` then un-blacklists it —
 * leaving a hash that was scheduled, is not scheduled, is not vetoed and is not the current
 * anchor. Re-broadcasting there resets nothing, because there is no clock left to reset; refusing
 * to (which is what this used to do, forever, on every pass) is how a lifted veto became a
 * permanent wedge.
 *
 * The other two readings are checked first and are not benign: still vetoed, or already executed.
 * Returns undefined to say "re-broadcast".
 */
async function scheduleGone(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  row: OaAnchorRecord,
): Promise<AnchorOutcome | undefined> {
  const proxy = rec.proxy as Address;
  const vetoed = await tryChain(d, row, () => d.arc.oaVetoed(proxy, row.manifestHash));
  if (vetoed.stop) return vetoed.stop;
  if (vetoed.value) return recordVeto(d, rec, row);

  const current = await tryChain(d, row, () => d.arc.oaCurrentHash(proxy));
  if (current.stop) return current.stop;
  if (current.value === row.manifestHash) {
    markExecuted(d, rec, row, row.executeTx ?? null, "recovered");
    return { advanced: true, version: row.version, state: "executed" };
  }

  logAnchor(rec.idempotencyKey, row.version, row.state, {
    code: "schedule_cancelled",
    txHash: row.scheduleTx ?? undefined,
    reason:
      "the schedule this tx created is gone and the hash is neither vetoed nor anchored — re-scheduling resets no clock",
  });
  return undefined;
}

/** Record `scheduled` + the guardian's countdown. The projection moves with it, in the repo's
 *  own transaction, so the DB can never advertise a countdown the row does not have. */
function confirmScheduled(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  row: OaAnchorRecord,
  executableAt: number,
  txHash: Hex | null,
): AnchorOutcome {
  const key = rec.idempotencyKey;
  const won = d.anchors.transitionAndProject(key, row.version, row.state, "scheduled", {
    ...(txHash ? { scheduleTx: txHash } : {}),
    // Unix SECONDS — chain time, which is what the veto countdown must be measured in.
    executableAt,
  });
  if (won)
    logAnchor(key, row.version, "scheduled", {
      code: "scheduled",
      txHash: txHash ?? undefined,
      executableAt,
    });
  return { advanced: won, version: row.version, state: "scheduled" };
}

/** scheduled -> executed, once the timelock has elapsed. */
async function executePhase(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  row: OaAnchorRecord,
): Promise<AnchorOutcome> {
  const key = rec.idempotencyKey;
  const proxy = rec.proxy as Address;
  const nowSeconds = Math.floor((d.now ?? Date.now)() / 1000);
  if (row.executableAt === null || nowSeconds < row.executableAt)
    return { advanced: false, version: row.version, state: "scheduled", skipped: "not_due" };

  // ── ORDER MATTERS (review F3). The prechecks run FIRST because the first thing they read is
  //    `meta().operatingAgreementHash`, and a version the chain ALREADY HOLDS is a version there
  //    is nothing left to decide about: recovering it is the only honest outcome whatever state
  //    the file is in. Rehashing first meant a crash between the execute broadcast and its
  //    receipt, combined with a lost manifest, recorded the cycle as `failed` and held the
  //    pipeline over an amendment that had in fact LANDED — and the next version would then have
  //    chained onto a hash the chain no longer held.
  const pre = await tryChain(d, row, () => commonPrechecks(d, rec, row));
  if (pre.stop) return pre.stop;
  if (pre.value) return pre.value;

  // ── HASH-FINAL DISCIPLINE, second of two (audit M7). The file can rot between the two
  //    transactions, and there is NO manager-side cancel: executing a hash whose document we can
  //    no longer reproduce would anchor something unverifiable, forever. This is the one branch
  //    that refuses rather than retries.
  if (!verifyStoredManifest(d, key, row.version, row.manifestHash)) {
    if (
      d.anchors.transition(key, row.version, "scheduled", "failed", {
        error:
          "the stored manifest no longer re-hashes to the scheduled anchor — refusing to execute",
      })
    )
      logAnchor(key, row.version, "failed", { code: "manifest_rehash_mismatch" });
    opsLog("anchor_rehash_mismatch", {
      severity: "CRITICAL",
      level: "error",
      entityKey: key,
      version: row.version,
      manifestHash: row.manifestHash,
      message:
        "a scheduled amendment's manifest bytes changed on disk — the amendment stays scheduled on chain and MUST be vetoed by the guardian if it should never land",
    });
    return { advanced: true, version: row.version, state: "failed" };
  }

  const scheduled = await tryChain(d, row, () => d.arc.oaScheduledAt(proxy, row.manifestHash));
  if (scheduled.stop) return scheduled.stop;
  if (scheduled.value! === 0n) {
    // Not vetoed (checked), not executed (checked): our row believes something the chain does not.
    // Back to `pending`, where the schedule leg can re-derive it — safely, because it schedules
    // only when `scheduledAt == 0`, which is exactly what we just read. The persisted txs go with
    // it (review F1): they describe a schedule the chain does not have, and left in place they
    // would send the schedule leg straight back into "refusing to re-broadcast blindly".
    if (
      d.anchors.transitionAndProject(key, row.version, "scheduled", "pending", {
        error: "the chain has no schedule for this hash — re-deriving from the schedule leg",
        clearScheduleTx: true,
        clearExecuteTx: true,
      })
    )
      logAnchor(key, row.version, "pending", { code: "schedule_missing" });
    return { advanced: true, version: row.version, state: "pending" };
  }

  const drive = await driveBroadcast(d, row, {
    priorTx: row.executeTx,
    leg: "execute",
    adopt: async () => {
      const current = await tryChain(d, row, () => d.arc.oaCurrentHash(proxy));
      if (current.stop) return current.stop;
      if (current.value === row.manifestHash) {
        markExecuted(d, rec, row, row.executeTx, "adopted");
        return { advanced: true, version: row.version, state: "executed" };
      }
      logAnchor(key, row.version, row.state, {
        code: "execute_reverted",
        txHash: row.executeTx ?? undefined,
      });
      return undefined;
    },
    send: () =>
      d.arc.executeOperatingAgreementUpdate(proxy, row.manifestHash, rec.manager as Address),
    persistTx: (txHash) => {
      d.anchors.transition(key, row.version, "scheduled", "scheduled", { executeTx: txHash });
    },
  });
  if (drive.stop) return drive.stop;
  const txHash = drive.txHash!;

  // Confirm against the CHAIN, not against the receipt: the anchor is what `meta()` says it is.
  const current = await tryChain(d, row, () => d.arc.oaCurrentHash(proxy));
  if (current.stop) return current.stop;
  if (current.value !== row.manifestHash) {
    park(
      d,
      row,
      `execute tx ${txHash} mined but meta().operatingAgreementHash is ${current.value}`,
    );
    return NOTHING;
  }
  markExecuted(d, rec, row, txHash, "executed");
  return { advanced: true, version: row.version, state: "executed" };
}

/**
 * The promotion, in ONE transaction: the cycle becomes `executed`, the entity's projection is
 * recomputed from the rows, and the audit event is written. Split across two transactions, a
 * crash in between would leave the DB claiming an anchor the chain does not hold — or, worse,
 * still advertising a pending amendment that has already landed.
 *
 * The `stillOurs` guard this used to carry is gone with the hand-written projection (review F2):
 * "which version is pending now?" is a question the ROWS answer, and a newer cycle opened while
 * this one was in flight is simply the newest open row.
 */
function markExecuted(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  row: OaAnchorRecord,
  executeTx: Hex | null,
  code: string,
): void {
  const key = rec.idempotencyKey;
  let won = false;
  d.repo.transaction(() => {
    won = d.anchors.transitionAndProject(key, row.version, row.state, "executed", {
      ...(executeTx ? { executeTx } : {}),
    });
    if (!won) return;
    const fresh = d.repo.findByIdempotencyKey(key);
    if (!fresh) return;
    d.repo.recordEvent(
      key,
      "oaAnchored",
      fresh.status,
      executeTx,
      JSON.stringify({
        version: row.version,
        manifestHash: row.manifestHash,
        environment: d.environment,
      }),
    );
  });
  if (won) logAnchor(key, row.version, "executed", { code, txHash: executeTx ?? undefined });
}

// ── parking ─────────────────────────────────────────────────────────────────────────────────

/**
 * Park a cycle WITHOUT burning an attempt, with a doubling backoff.
 *
 * The rule is `parkFormationStep`'s, and it applies here for a sharper reason. An `attempt` is a
 * claim that the last request definitely did not commit — and a lost receipt cannot say that: the
 * schedule may well be on chain. So the interval itself is the row's memory, `attempt` stays put,
 * and nothing here can ever abandon an amendment the chain is holding.
 */
function park(d: AnchorLoopDeps, row: OaAnchorRecord, error: string): void {
  const retryIntervalMs = nextInterval(
    row.retryIntervalMs ?? undefined,
    RETRY_BASE_MS,
    RETRY_CAP_MS,
  );
  const nextRetryAt = (d.now ?? Date.now)() + retryIntervalMs;
  d.anchors.transition(row.entityKey, row.version, row.state, row.state, {
    error,
    nextRetryAt,
    retryIntervalMs,
  });
  logAnchor(row.entityKey, row.version, row.state, {
    code: "parked",
    attemptBurned: false,
    retryInMs: retryIntervalMs,
    reason: error,
  });
}

/** Run one chain interaction. A failure never propagates: it is classified and turned into the
 *  outcome the caller must stop with. */
interface ChainAttempt<T> {
  value?: T;
  /** Present iff the interaction failed — the outcome the caller must return. */
  stop?: AnchorOutcome;
}

async function tryChain<T>(
  d: AnchorLoopDeps,
  row: OaAnchorRecord,
  fn: () => Promise<T>,
): Promise<ChainAttempt<T>> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { stop: classifyChainFailure(d, row, err) };
  }
}

/**
 * Two kinds of failure, and treating them alike is how a driver either abandons a healthy
 * amendment or hides a broken deployment (review F5).
 *
 *  - **Transport.** An RPC timeout, a connection reset, a lost receipt. It says NOTHING about
 *    whether the amendment is going through — the schedule may well be on chain — so it parks
 *    with a doubling backoff and burns no attempt. Retried forever, deliberately.
 *  - **A decoded contract revert.** `NotManager`, `NotActive`, `Vetoed`, a custom error: a
 *    VERDICT, and the same verdict every time until a human changes something. It burns an
 *    attempt, and a bounded number of them escalates the cycle to the `failed` hold, which pages.
 *    A legacy agent's LegalManager that still obeys the old EOA is exactly this shape, and left
 *    to retry it would have retried silently forever.
 *  - **`TooEarly`** is neither. It is the timelock itself, observed from the chain's clock rather
 *    than ours, and the only correct response is to come back later.
 */
function classifyChainFailure(d: AnchorLoopDeps, row: OaAnchorRecord, err: unknown): AnchorOutcome {
  const message = (err as Error).message;
  const revert = decodedRevertName(err);
  if (revert === undefined) {
    park(d, row, message);
    return NOTHING;
  }
  if (revert === "TooEarly") {
    logAnchor(row.entityKey, row.version, row.state, {
      code: "too_early",
      reason: "the chain's clock has not reached this amendment's executableAt yet",
    });
    return { advanced: false, version: row.version, state: row.state, skipped: "not_due" };
  }
  return burnRevert(d, row, revert, message);
}

/** Burn one attempt for a deterministic revert, and escalate to the hold when they run out. */
function burnRevert(
  d: AnchorLoopDeps,
  row: OaAnchorRecord,
  revert: string,
  message: string,
): AnchorOutcome {
  const now = (d.now ?? Date.now)();
  const retryIntervalMs = nextInterval(
    row.retryIntervalMs ?? undefined,
    RETRY_BASE_MS,
    RETRY_CAP_MS,
  );
  const error = `${revert ? `${revert}: ` : ""}${message}`;
  const attempt = d.anchors.parkWithAttempt(row.entityKey, row.version, row.state, {
    error,
    nextRetryAt: now + retryIntervalMs,
    retryIntervalMs,
  });
  if (attempt === undefined) return NOTHING; // lost the CAS; the winner owns this cycle
  logAnchor(row.entityKey, row.version, row.state, {
    code: "parked",
    attemptBurned: true,
    attempt,
    revert: revert || undefined,
    retryInMs: retryIntervalMs,
    reason: error,
  });
  if (attempt < MAX_ANCHOR_REVERT_ATTEMPTS) return NOTHING;

  // Out of attempts. NOT a projecting transition, for `recordVeto`'s reason: whatever is on chain
  // is still on chain, and the pending pair is what the guardian and the monitor read.
  const held = d.anchors.transition(row.entityKey, row.version, row.state, "failed", {
    error: `${error} — abandoned after ${attempt} reverted attempts`,
  });
  if (!held) return NOTHING;
  logAnchor(row.entityKey, row.version, "failed", { code: "revert_exhausted", attempt, revert });
  opsLog("anchor_revert_exhausted", {
    severity: "CRITICAL",
    level: "error",
    entityKey: row.entityKey,
    version: row.version,
    attempt,
    revert: revert || undefined,
    message:
      "a manager call for this amendment reverted deterministically until its attempts ran out — the entity's whole anchor pipeline is now HELD until an operator acknowledges it (cli anchor-ack)",
  });
  warnOnce("anchor_held", row.entityKey, now, {
    versions: [row.version],
    reason: "a cycle is in `failed` and needs an operator acknowledgement before anchoring resumes",
  });
  return { advanced: true, version: row.version, state: "failed" };
}
