import type { Address, Hex } from "viem";
import type { DoolaEnvironment } from "../adapters/doola/types";
import { RETRY_BASE_MS, RETRY_CAP_MS, nextInterval } from "../formation/schedule";
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
import type { FormationRepository } from "../persistence/formationRepository";
import type {
  OaAnchorRecord,
  OaAnchorRepository,
  OaAnchorState,
} from "../persistence/oaAnchorRepository";
import type { EntityRecord } from "../types";
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
 *     disambiguates, and it is read FIRST.
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
 * attempt counter can do here is abandon a legitimate one.
 */
export async function advanceAnchor(d: AnchorLoopDeps, entityKey: string): Promise<AnchorOutcome> {
  const rec = d.repo.findByIdempotencyKey(entityKey);
  if (!rec) return { advanced: false, skipped: "no_entity" };

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
    opsLog("anchor_environment_mismatch", {
      level: "warn",
      entityKey,
      pinned: rec.formationEnvironment,
      deployment: d.environment,
    });
    return { advanced: false, skipped: "environment_pin" };
  }

  try {
    // A veto parks the WHOLE pipeline (design §7, audit H4) — it is a stop sign, not a per-hash
    // speed bump a re-versioning backend routes around. Checked before anything else.
    if (await parkedByHold(d, rec)) return { advanced: false, skipped: "hold_park" };

    const prev = loadAnchoredManifest(d, rec);
    if (!prev) return NOTHING; // corrupt/unreadable baseline — already parked and logged
    const open = await reconcileTarget(d, rec, prev);
    if (!open) return { advanced: false, skipped: "no_new_facts" };
    return await driveCycle(d, rec, open);
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

// ── the veto park ───────────────────────────────────────────────────────────────────────────

/**
 * Is this entity's pipeline HELD — and, if it is held by a veto, has the guardian lifted it?
 *
 * Two states park the whole pipeline rather than just their own cycle:
 *
 *  - `vetoed`. A veto blacklists ONE hash, so a backend that simply re-versioned around it would
 *    defeat the guardian entirely (audit H4). It ends on chain via `liftVeto`, which this
 *    observes, or via `acknowledgeHold` — an operator saying "that version is dead, move on".
 *  - `failed`. Today that means a scheduled manifest stopped re-hashing to its anchor, and the
 *    amendment is STILL LIVE on chain with only the guardian able to stop it. Building a
 *    successor while that is true would be the platform quietly moving on from a problem the
 *    operator has to see. Ends only by acknowledgement.
 *
 * When a lift IS observed, only the NEWEST vetoed version resumes; older ones are superseded, so
 * the single-pending rule survives a guardian who vetoed twice and lifted both.
 */
async function parkedByHold(d: AnchorLoopDeps, rec: EntityRecord): Promise<boolean> {
  const all = d.anchors.versionsOf(rec.idempotencyKey);
  const failed = all.filter((r) => r.state === "failed");
  if (failed.length > 0) {
    opsLog("anchor_held", {
      level: "warn",
      entityKey: rec.idempotencyKey,
      versions: failed.map((r) => r.version),
      reason:
        "a cycle is in `failed` and needs an operator acknowledgement before anchoring resumes",
    });
    return true;
  }
  const vetoed = all.filter((r) => r.state === "vetoed");
  if (vetoed.length === 0) return false;

  const proxy = rec.proxy as Address;
  const lifted: OaAnchorRecord[] = [];
  for (const row of vetoed) {
    if (await d.arc.oaVetoed(proxy, row.manifestHash)) return true; // the park stands
    lifted.push(row);
  }

  // Every veto has been lifted. Newest resumes; the rest are history.
  const newest = lifted[lifted.length - 1]!;
  for (const row of lifted) {
    const to: OaAnchorState = row.version === newest.version ? "pending" : "superseded";
    if (d.anchors.transition(rec.idempotencyKey, row.version, "vetoed", to, { error: null }))
      logAnchor(rec.idempotencyKey, row.version, to, { code: "veto_lifted" });
  }
  return false;
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
 */
function loadAnchoredManifest(d: AnchorLoopDeps, rec: EntityRecord): AnchoredManifest | undefined {
  const key = rec.idempotencyKey;
  const version = rec.oaManifestVersion!;
  const name = manifestDocName(key, version);
  try {
    const bytes = d.docStore.getBytes(name);
    const hash = manifestHash(bytes);
    if (hash !== rec.oaManifestAnchoredHash)
      throw new ManifestError(
        `stored ${name} hashes to ${hash} but the anchored hash is ${rec.oaManifestAnchoredHash}`,
      );
    const manifest = parseManifest(bytes);
    if (manifest.version !== version)
      throw new ManifestError(
        `stored ${name} declares version ${manifest.version}, not the anchored ${version}`,
      );
    return { manifest, hash };
  } catch (err) {
    // CRITICAL: the anchored document cannot be reproduced from disk, so nothing can honestly
    // chain onto it. Anchoring stops here until a human restores the file (doola remains the
    // system of record for the PDFs; the manifest is ours and lives in the backup runbook).
    opsLog("anchor_baseline_unreadable", {
      severity: "CRITICAL",
      level: "error",
      entityKey: key,
      version,
      document: name,
      message: (err as Error).message,
    });
    return undefined;
  }
}

// ── the target: which version, and what does it say ─────────────────────────────────────────

/**
 * The legal block THIS entity's facts justify right now, or null if they do not justify one yet.
 *
 * The trigger, stated as data rather than as a sequence of `if`s (design §7): v2 becomes possible
 * when `await_filing` AND `fetch_documents` are both confirmed, because that is the moment both
 * halves exist — a filing date and filing number on the record, and the two required documents'
 * sha256s in the index. v3 follows when `await_ein` confirms. Everything is read from the ENTITY
 * RECORD and the `documents` table, never from a webhook payload (audit H2) and never from a live
 * provider response, so re-deriving a version after a restart produces the same bytes.
 */
export function deriveLegalBlock(d: AnchorLoopDeps, rec: EntityRecord): ManifestLegal | null {
  const key = rec.idempotencyKey;
  const steps = d.requests.stepsOf(key);
  const stateOf = (step: string) => steps.find((s) => s.step === step)?.state;
  const providerRef = steps.find((s) => s.step === "create_provider")?.providerRef;
  if (!providerRef) return null;
  if (stateOf("await_filing") !== "confirmed" || stateOf("fetch_documents") !== "confirmed")
    return null;
  if (rec.formationFiledAt == null) return null;
  if (!rec.formationFilingNumber) {
    // ⚠ FLAGGED. The filing number is part of the v2 trigger, and `advanceFiling` writes it onto
    // the entity only inside the CAS that CONFIRMS the step — so a company doola confirmed as
    // filed without one yet will never anchor v2 on its own. That is a real (pre-existing) gap in
    // the fetch-and-advance path rather than something to paper over here: anchoring a manifest
    // that claims a filing with no filing number would be the dishonest fix. Say so, once per
    // pass, where an operator will see it.
    opsLog("anchor_awaiting_filing_number", {
      level: "warn",
      entityKey: key,
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
    ein: stateOf("await_ein") === "confirmed" ? (rec.einReal ?? null) : null,
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
): Promise<OaAnchorRecord | undefined> {
  const key = rec.idempotencyKey;
  const legal = deriveLegalBlock(d, rec);
  const open = d.anchors.findPending(key);

  // Nothing new to say: an open cycle keeps being driven, and a quiet entity stays quiet.
  if (!legal) return open;

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
    const superseded = d.anchors.transition(key, open.version, open.state, "superseded", {
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
  const highest = d.anchors.versionsOf(key).reduce((m, r) => Math.max(m, r.version), 0);
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
  const name = manifestDocName(key, version);
  d.docStore.putBytes(name, built.bytes);
  const verified = verifyStoredManifest(d, key, version, built.hash);
  if (!verified) return undefined;

  // Claim the cycle. `claimVersion` adopts rather than restarts: a crash between the write and
  // this claim re-derives the SAME bytes and the same hash, so the second pass finds its own row.
  if (!d.anchors.claimVersion(key, version, built.hash)) {
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

  // The pending pair on the entity: the fixed projection the monitor and the guardian card read
  // (audit H3/14). Written in the same transaction as the claim it describes.
  d.repo.transaction(() => {
    const fresh = d.repo.findByIdempotencyKey(key);
    if (fresh)
      d.repo.upsert({
        ...fresh,
        oaManifestPendingHash: built.hash,
        oaManifestPendingVersion: version,
        oaAmendmentExecutableAt: null,
      });
  });
  logAnchor(key, version, "pending", { code: "opened", manifestHash: built.hash });
  return d.anchors.find(key, version);
}

/** Re-read the manifest we just wrote and re-hash it. The one check that makes "the file on disk
 *  IS the anchor" a fact rather than an intention. */
function verifyStoredManifest(
  d: AnchorLoopDeps,
  entityKey: string,
  version: number,
  expected: Hex,
): boolean {
  const name = manifestDocName(entityKey, version);
  try {
    const back = d.docStore.getBytes(name);
    const hash = manifestHash(back);
    if (hash !== expected)
      throw new ManifestError(`re-read ${name} hashes to ${hash}, not ${expected}`);
    return true;
  } catch (err) {
    opsLog("anchor_manifest_unverifiable", {
      severity: "CRITICAL",
      level: "error",
      entityKey,
      version,
      document: name,
      message: (err as Error).message,
    });
    return false;
  }
}

// ── driving one cycle ───────────────────────────────────────────────────────────────────────

async function driveCycle(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  row: OaAnchorRecord,
): Promise<AnchorOutcome> {
  const now = (d.now ?? Date.now)();
  // A parked cycle waits out its backoff. `next_retry_at` is epoch MILLISECONDS (the sweeper's
  // clock); `executable_at` below is unix SECONDS (chain time). They are different units because
  // they answer to different clocks, and both are labeled everywhere they appear.
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
  if (vetoed.parked) return NOTHING;
  if (vetoed.value) return recordVeto(d, rec, row);

  if (row.state === "pending") return schedulePhase(d, rec, row);
  if (row.state === "scheduled") return executePhase(d, rec, row);
  return NOTHING;
}

/** The guardian stopped this amendment. The row parks, and with it the whole pipeline. */
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
      d.anchors.transition(key, row.version, row.state, "superseded", {
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

/** pending -> scheduled: broadcast, persist, confirm. */
async function schedulePhase(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  row: OaAnchorRecord,
): Promise<AnchorOutcome> {
  const key = rec.idempotencyKey;
  const proxy = rec.proxy as Address;

  const stop = await tryChain(d, row, () => commonPrechecks(d, rec, row));
  if (stop.parked) return NOTHING;
  if (stop.value) return stop.value;

  const scheduled = await tryChain(d, row, () => d.arc.oaScheduledAt(proxy, row.manifestHash));
  if (scheduled.parked) return NOTHING;

  // Already on chain: ADOPT it. This is the crash-between-broadcast-and-persist window — the
  // chain has the schedule, our row does not know its tx. Re-broadcasting here would reset the
  // guardian's veto window (contract property 1).
  if (scheduled.value! > 0n)
    return confirmScheduled(d, rec, row, Number(scheduled.value!), row.scheduleTx ?? null);

  // A persisted broadcast that the chain does not reflect: either it is still unmined (the
  // receipt wait blocks, and a timeout parks us) or it reverted, in which case re-broadcasting is
  // exactly right — `scheduledAt == 0` proves there is no clock to reset.
  if (row.scheduleTx) {
    const receipt = await tryChain(d, row, () => d.arc.waitForManagerReceipt(row.scheduleTx!));
    if (receipt.parked) return NOTHING;
    if (receipt.value!.status === "success") {
      // Mined successfully and yet nothing is scheduled: re-read once before believing it.
      const again = await tryChain(d, row, () => d.arc.oaScheduledAt(proxy, row.manifestHash));
      if (again.parked) return NOTHING;
      if (again.value! > 0n)
        return confirmScheduled(d, rec, row, Number(again.value!), row.scheduleTx);
      park(
        d,
        row,
        `schedule tx ${row.scheduleTx} succeeded but scheduledAt is still 0 — refusing to re-broadcast blindly`,
      );
      return NOTHING;
    }
    logAnchor(key, row.version, "pending", { code: "schedule_reverted", txHash: row.scheduleTx });
  }

  // ── BROADCAST -> PERSIST -> CONFIRM. The persist happens between the two awaits, and that is
  //    the entire point: a crash after the broadcast resumes by adopting this hash.
  const sent = await tryChain(d, row, () =>
    d.arc.scheduleOperatingAgreementUpdate(proxy, row.manifestHash, rec.manager as Address),
  );
  if (sent.parked) return NOTHING;
  const txHash = sent.value!;
  d.anchors.transition(key, row.version, "pending", "pending", {
    scheduleTx: txHash,
    error: null,
  });
  logAnchor(key, row.version, "pending", { code: "schedule_broadcast", txHash });

  const receipt = await tryChain(d, row, () => d.arc.waitForManagerReceipt(txHash));
  if (receipt.parked) return NOTHING;
  if (receipt.value!.status !== "success") {
    park(d, row, `schedule tx ${txHash} reverted`);
    return NOTHING;
  }

  // Prefer the CHAIN's own executableAt over `now + amendmentDelay()`: the guardian's countdown
  // is a promise about when we may act, and block time is the only clock that decides it.
  const onChain = await tryChain(d, row, () => d.arc.oaScheduledAt(proxy, row.manifestHash));
  let executableAt = onChain.parked ? 0 : Number(onChain.value!);
  if (executableAt === 0) {
    const delay = await tryChain(d, row, () => d.arc.oaAmendmentDelay(proxy));
    if (delay.parked) return NOTHING;
    executableAt = Math.floor((d.now ?? Date.now)() / 1000) + Number(delay.value!);
  }
  return confirmScheduled(d, rec, row, executableAt, txHash);
}

/** Record `scheduled` + the guardian's countdown, in one transaction with the entity column. */
function confirmScheduled(
  d: AnchorLoopDeps,
  rec: EntityRecord,
  row: OaAnchorRecord,
  executableAt: number,
  txHash: Hex | null,
): AnchorOutcome {
  const key = rec.idempotencyKey;
  let won = false;
  d.repo.transaction(() => {
    won = d.anchors.transition(key, row.version, row.state, "scheduled", {
      ...(txHash ? { scheduleTx: txHash } : {}),
      executableAt,
      error: null,
    });
    if (!won) return;
    const fresh = d.repo.findByIdempotencyKey(key);
    if (fresh)
      d.repo.upsert({
        ...fresh,
        oaManifestPendingHash: row.manifestHash,
        oaManifestPendingVersion: row.version,
        // Unix SECONDS — chain time, which is what the veto countdown must be measured in.
        oaAmendmentExecutableAt: executableAt,
      });
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

  const stop = await tryChain(d, row, () => commonPrechecks(d, rec, row));
  if (stop.parked) return NOTHING;
  if (stop.value) return stop.value;

  const scheduled = await tryChain(d, row, () => d.arc.oaScheduledAt(proxy, row.manifestHash));
  if (scheduled.parked) return NOTHING;
  if (scheduled.value! === 0n) {
    // Not vetoed (checked), not executed (checked): our row believes something the chain does not.
    // Back to `pending`, where the schedule leg can re-derive it — safely, because it schedules
    // only when `scheduledAt == 0`, which is exactly what we just read.
    if (
      d.anchors.transition(key, row.version, "scheduled", "pending", {
        error: "the chain has no schedule for this hash — re-deriving from the schedule leg",
      })
    )
      logAnchor(key, row.version, "pending", { code: "schedule_missing" });
    return { advanced: true, version: row.version, state: "pending" };
  }

  // A persisted execute broadcast: adopt it rather than sending a second one.
  if (row.executeTx) {
    const receipt = await tryChain(d, row, () => d.arc.waitForManagerReceipt(row.executeTx!));
    if (receipt.parked) return NOTHING;
    if (receipt.value!.status === "success") {
      const current = await tryChain(d, row, () => d.arc.oaCurrentHash(proxy));
      if (current.parked) return NOTHING;
      if (current.value === row.manifestHash) {
        markExecuted(d, rec, row, row.executeTx, "adopted");
        return { advanced: true, version: row.version, state: "executed" };
      }
    }
    logAnchor(key, row.version, "scheduled", { code: "execute_reverted", txHash: row.executeTx });
  }

  const sent = await tryChain(d, row, () =>
    d.arc.executeOperatingAgreementUpdate(proxy, row.manifestHash, rec.manager as Address),
  );
  if (sent.parked) return NOTHING;
  const txHash = sent.value!;
  d.anchors.transition(key, row.version, "scheduled", "scheduled", {
    executeTx: txHash,
    error: null,
  });
  logAnchor(key, row.version, "scheduled", { code: "execute_broadcast", txHash });

  const receipt = await tryChain(d, row, () => d.arc.waitForManagerReceipt(txHash));
  if (receipt.parked) return NOTHING;
  if (receipt.value!.status !== "success") {
    park(d, row, `execute tx ${txHash} reverted`);
    return NOTHING;
  }
  // Confirm against the CHAIN, not against the receipt: the anchor is what `meta()` says it is.
  const current = await tryChain(d, row, () => d.arc.oaCurrentHash(proxy));
  if (current.parked) return NOTHING;
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
 * The promotion, in ONE transaction: the cycle becomes `executed` and the entity's four anchor
 * columns move with it. Split across two transactions, a crash in between would leave the DB
 * claiming an anchor the chain does not hold — or, worse, still advertising a pending amendment
 * that has already landed.
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
    won = d.anchors.transition(key, row.version, row.state, "executed", {
      ...(executeTx ? { executeTx } : {}),
      error: null,
    });
    if (!won) return;
    const fresh = d.repo.findByIdempotencyKey(key);
    if (!fresh) return;
    // Clear the pending pair ONLY if it still describes THIS version. A newer cycle may have been
    // opened while this one was in flight, and wiping its hash would blind the monitor's
    // compromise rule to the amendment that is actually pending.
    const stillOurs = (fresh.oaManifestPendingVersion ?? row.version) === row.version;
    d.repo.upsert({
      ...fresh,
      oaHash: row.manifestHash,
      oaManifestVersion: row.version,
      oaManifestAnchoredHash: row.manifestHash,
      ...(stillOurs
        ? {
            oaManifestPendingHash: null,
            oaManifestPendingVersion: null,
            oaAmendmentExecutableAt: null,
          }
        : {}),
    });
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

/** Run one chain interaction; a transport failure parks the row instead of propagating. */
async function tryChain<T>(
  d: AnchorLoopDeps,
  row: OaAnchorRecord,
  fn: () => Promise<T>,
): Promise<{ value?: T; parked: boolean }> {
  try {
    return { value: await fn(), parked: false };
  } catch (err) {
    park(d, row, (err as Error).message);
    return { parked: true };
  }
}
