import { type DoolaApi, describeDoolaError } from "../adapters/doola/doolaClient";
import type {
  DoolaCompany,
  DoolaDocument,
  DoolaEnvironment,
  DoolaRequiredAction,
} from "../adapters/doola/types";
import { POLL_BASE_MS, POLL_CAP_MS, type StepBackoff, nextInterval } from "../formation/schedule";
import { opsLog } from "../observability/opsLog";
import { withKeyedLock } from "../payments/keyedMutex";
import {
  type DocumentIndexRepository,
  documentIndexId,
  documentStoreName,
} from "../persistence/documentIndexRepository";
import type { DocumentStore } from "../persistence/documentStore";
import type { DoolaEventRepository } from "../persistence/doolaEventRepository";
import type { EntityRepository } from "../persistence/entityRepository";
import {
  type FormationRepository,
  type FormationRequestRecord,
  type FormationStep,
  parseDetail,
} from "../persistence/formationRepository";
import { downloadDocument } from "./documentDownloader";
import { environmentPinMismatchError } from "./formationProvider";
import { failFormationStep, logFormationStep, persistPollBackoff } from "./formationStep";

/**
 * FETCH-AND-ADVANCE: the only code that turns doola's state into ours (design §5, audit H2).
 *
 * **A webhook is a wake-up signal, never a source of facts.** Nothing in this module reads
 * `eventPayload`. What arrives from the wire is an event id, an event name and a company id; what
 * gets written is re-fetched over TLS with our own API key, every time. That is the structural
 * reason a leaked webhook secret is not a fact-forgery capability — it buys an attacker a
 * redundant poll (design §10).
 *
 * The same function is the SWEEPER's poll. There is deliberately one implementation: a webhook
 * and a timer are two ways of asking "has anything changed?", and if they advanced rows through
 * different code they would eventually disagree about what "filed" means.
 *
 * Concurrency is DB-level, not mutex-level (audit M13/20): every transition is a compare-and-set
 * and every entity fact is written INSIDE the transaction that won the CAS, so a webhook task and
 * a sweeper tick meeting on one entity advance it exactly once. `withKeyedLock` is layered on top
 * as an optimization — it is single-process by its own doc, and correctness may not rest on it.
 */

/**
 * What a verified webhook hands this module. Four fields, and deliberately not five: the payload
 * is NOT here, because a webhook is a wake-up signal and never a source of facts (audit H2).
 *
 * Defined here rather than in the receiver because the CONSUMER owns the contract — and because
 * `src/workflow` must not import from `src/api` (a layering test enforces it); the receiver
 * re-exports this type for its own callers.
 */
export interface DoolaWakeUp {
  eventId: string;
  eventName: string;
  /** doola's company id, when the envelope carried one. NULL = unmappable, for now. */
  providerRef: string | null;
}

// ── event names (design §5, fact-checked) ───────────────────────────────────────────────────

export const DOOLA_EVENT_NAMES = {
  formationCompleted: "company_formation_completed",
  formationFailed: "company_formation_failed",
  einIssued: "company_ein_issued",
  /** Account-level, no company: doola has switched our endpoint OFF and only a human can undo it. */
  webhookDisabled: "partner_webhook_disabled",
} as const;

/**
 * Is this a name we have a route for?
 *
 * Document events are matched by SHAPE (`document_<kind>_uploaded`) rather than enumerated: the
 * signed SS-4 arrives as `document_ss4_uploaded`, the EIN letter as its own, and doola will add
 * kinds we have not seen. Every one of them means the same thing to us — "look at the document
 * list" — so pinning the exact kinds would only produce spurious unknown-event warnings.
 */
export function isKnownDoolaEvent(name: string): boolean {
  return (
    (Object.values(DOOLA_EVENT_NAMES) as string[]).includes(name) ||
    /^document_[a-z0-9]+_uploaded$/i.test(name)
  );
}

/** Names that imply doola is waiting on somebody, so the poll should also read required-actions. */
export function eventSuggestsRequiredActions(name: string): boolean {
  return /required[_-]?action|signature|name[_-]?option/i.test(name);
}

// ── the `detail` shapes (the part A contract, extended for part B's three steps) ─────────────

/**
 * Poll backoff, carried on whichever step an entity is currently WAITING on (design §7).
 *
 * It lives in `detail` rather than in a column because it is scheduling state, not a fact: an
 * `await_ein` row legitimately sits for four to six weeks, and polling it every 24h for six weeks
 * is 42 pointless round trips per entity. The interval doubles on every empty poll and resets the
 * moment anything actually advances.
 */
export type PollBackoff = StepBackoff;

/** `formation_requests.await_filing.detail`. NEVER PII. */
export interface AwaitFilingDetail extends PollBackoff {
  /** doola's intake status at the last fetch (PENDING | SUBMITTED | FAILED) — not "filed". */
  submissionStatus?: string;
  /** doola's `formationFilingDate`, verbatim (yyyy-MM-dd). The parsed unix value goes on the
   *  ENTITY; this keeps the string we parsed, so a bad parse is diagnosable. */
  filingDate?: string;
  filingNumber?: string;
  /** Open required-actions, ids + codes + status. Codes only are exposed in the tenant view. */
  requiredActions?: { id: string; code: string; status: string | null }[];
}

/** `formation_requests.fetch_documents.detail`. NEVER PII. */
export interface FetchDocumentsDetail extends PollBackoff {
  /** What we have stored, by doola document id. The bytes live in the DocumentStore. */
  stored?: { docId: string; type: string; sha256: string }[];
  /** Required types still missing at the last fetch — why this step is not confirmed yet. */
  missing?: string[];
}

/** `formation_requests.await_ein.detail`. NEVER the EIN itself: that is a legal fact and it goes
 *  on the entity record, where the authenticated-views-only rule already governs it. */
export interface AwaitEinDetail extends PollBackoff {
  /** Unix ms we first observed an EIN on the company. */
  observedAt?: number;
}

/** The two documents that make a Wyoming LLC's paperwork complete for our purposes. */
export const REQUIRED_DOCUMENT_TYPES = ["ArticlesOfOrganization", "OperatingAgreement"] as const;

/** The steps this module drives. `create_provider` belongs to the onboarding saga + the sweeper. */
export const POLLED_STEPS: readonly FormationStep[] = [
  "await_filing",
  "fetch_documents",
  "await_ein",
] as const;

/** The `detail` reader lives with the column it reads (`persistence/formationRepository`, M4);
 *  re-exported here because this module is where the `detail` SHAPES are declared. */
export { parseDetail };

// ── reading doola's company, honestly ───────────────────────────────────────────────────────

/** doola models formation as a SERVICE on the company; its status is the authoritative signal. */
export function formationServiceStatus(company: DoolaCompany): string | undefined {
  return company.services?.find((s) => /formation/i.test(s.name ?? ""))?.status ?? undefined;
}

/**
 * Has the STATE filed the company?
 *
 * Either doola says the formation service completed, or a filing date exists — the second is the
 * stronger evidence of the two (a date is a fact about Wyoming's records), and it is checked
 * independently so a service-status vocabulary change cannot silently stall every entity.
 */
export function isFormationFiled(company: DoolaCompany): boolean {
  return (
    formationServiceStatus(company)?.toLowerCase() === "completed" ||
    Boolean(company.formationFilingDate)
  );
}

/**
 * Has the formation FAILED?
 *
 * ⚠ DELIBERATE DEVIATION, flagged for review. The design's event map routes
 * `company_formation_failed` to "fail the remaining rows". This implementation treats the event
 * as a reason to LOOK and the FETCHED state as the thing that decides — because failing a row
 * burns an attempt, eight burned attempts is `abandoned`, and `abandoned` erases the entity's
 * formation party. Honouring an unverified event name would hand anyone holding a leaked webhook
 * secret a way to abandon a real filing, which is exactly the capability H2 exists to deny. Two
 * fetched signals are accepted so a vocabulary difference on one cannot stall the other.
 */
export function isFormationFailed(company: DoolaCompany): boolean {
  return (
    formationServiceStatus(company)?.toLowerCase() === "failed" ||
    company.formationSubmissionStatus?.toUpperCase() === "FAILED"
  );
}

/** doola's `yyyy-MM-dd` filing date as unix SECONDS (UTC midnight), or null if unusable. */
export function filingDateToUnix(raw: string | null | undefined): number | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// ── deps ────────────────────────────────────────────────────────────────────────────────────

export interface FormationAdvanceDeps {
  repo: EntityRepository;
  requests: FormationRepository;
  documents: DocumentIndexRepository;
  docStore: DocumentStore;
  doola: DoolaApi;
  /** The environment THIS DEPLOYMENT runs. Compared against every entity's pin (audit M5). */
  environment: DoolaEnvironment;
  /** Injected in tests; the document downloader's transport. */
  fetchImpl?: typeof fetch;
  /** Injected in tests; the document downloader's DNS resolver (the SSRF check always runs). */
  lookupImpl?: import("../payments/ssrfGuard").HostLookup;
  now?: () => number;
}

export interface AdvanceOutcome {
  /** Did we actually reach doola and read its state? Only then may an event be marked processed. */
  fetched: boolean;
  /** Did anything change? This is what resets the poll backoff. */
  advanced: boolean;
  /** Why nothing happened, when nothing happened. */
  skipped?: "no_entity" | "environment_pin" | "no_provider_ref";
}

/** The step an entity is currently waiting on — where poll backoff is persisted. */
export function currentPolledStep(steps: FormationRequestRecord[]): FormationStep | undefined {
  return POLLED_STEPS.find((s) => {
    const row = steps.find((r) => r.step === s);
    return row !== undefined && row.state !== "confirmed" && row.state !== "abandoned";
  });
}

/**
 * Re-fetch doola's authoritative state for one entity and advance whatever it proves.
 *
 * Never throws for an ordinary failure: a provider error parks the step the entity is waiting on
 * (bump + `failed`) and the sweeper retries it with backoff. It returns rather than throwing
 * because both callers — a webhook task and a sweeper tick — must carry on with other entities.
 */
export async function advanceFormation(
  d: FormationAdvanceDeps,
  entityKey: string,
  opts: { requiredActions?: boolean } = {},
): Promise<AdvanceOutcome> {
  const rec = d.repo.findByIdempotencyKey(entityKey);
  if (!rec) return { fetched: false, advanced: false, skipped: "no_entity" };

  // ── Environment pinning (audit M5), BEFORE any provider call. An entity pinned to sandbox must
  //    never be routed at api.doola.com by a config flip, and one pinned to production must never
  //    be re-read out of a playground.
  if (rec.formationEnvironment !== d.environment) {
    opsLog("formation_environment_mismatch", {
      level: "warn",
      entityKey,
      pinned: rec.formationEnvironment ?? null,
      deployment: d.environment,
      message: environmentPinMismatchError(rec.formationEnvironment ?? null, d.environment),
    });
    return { fetched: false, advanced: false, skipped: "environment_pin" };
  }

  const steps = d.requests.stepsOf(entityKey);
  const providerRef = steps.find((s) => s.step === "create_provider")?.providerRef;
  // Nothing has been filed yet: `create_provider` is the sweeper's job, not this one's.
  if (!providerRef) return { fetched: false, advanced: false, skipped: "no_provider_ref" };

  const waitingOn = currentPolledStep(steps);

  let company: DoolaCompany;
  let documents: DoolaDocument[];
  let requiredActions: DoolaRequiredAction[] | undefined;
  try {
    // Three INDEPENDENT reads of the same company (M5). Sequential, they were three round trips
    // deep — and this runs while holding the entity's lock, once per wake-up, for every in-flight
    // entity on every sweep. None of them feeds another, so the only thing the sequence bought
    // was latency. `Promise.all` rejects on the first failure, which is the same behaviour the
    // `await` chain had.
    [company, documents, requiredActions] = await Promise.all([
      d.doola.getCompany(providerRef),
      d.doola.listDocuments(providerRef),
      opts.requiredActions ? d.doola.listRequiredActions(providerRef) : Promise.resolve(undefined),
    ]);
  } catch (e) {
    // ── C3. The read failed, so nothing is known and nothing is written — and, crucially,
    //    NOTHING WAS ATTEMPTED. A GET that 502s is not a formation going badly; it is a bad
    //    minute at a provider. Burning an attempt for it meant eight bad minutes `abandoned` a
    //    formation Wyoming may already have filed, and `abandoned` is what erases the responsible
    //    party's personal data.
    //
    //    So the row keeps its state (`pending`/`submitted`), records WHY on itself, and gets a
    //    doubling poll backoff. `failed` is reserved for what doola actually reports as a
    //    failure, which is the only thing a tenant should ever see rendered as one.
    const described = describeDoolaError(e);
    if (waitingOn) {
      const row = d.requests.find(entityKey, waitingOn);
      if (row) {
        const detail = parseDetail<StepBackoff>(row.detail);
        const pollIntervalMs = nextInterval(detail.pollIntervalMs, POLL_BASE_MS, POLL_CAP_MS);
        const nextPollAt = (d.now ?? Date.now)() + pollIntervalMs;
        d.requests.transition(entityKey, waitingOn, row.state, row.state, {
          error: `doola read failed: ${described.message}`,
          detail: JSON.stringify({ ...detail, pollIntervalMs, nextPollAt }),
          nextPollAt,
        });
      }
      opsLog("formation_read_failed", {
        level: "warn",
        entityKey,
        step: waitingOn,
        providerRef,
        // The distinction the whole change is about, said out loud in journald.
        attemptBurned: false,
        ...described,
      });
    }
    return { fetched: false, advanced: false };
  }

  if (isFormationFailed(company)) {
    return { fetched: true, advanced: failRemainingSteps(d, entityKey, steps, providerRef) };
  }

  // The read SUCCEEDED. Anything parked by a previous read failure is provably parked for a
  // reason that no longer holds, so it goes back to `pending` before the advance runs — otherwise
  // a tenant keeps seeing `failed` for a formation that is simply waiting, and the sweeper keeps
  // treating a healthy row as a retry candidate.
  unparkAfterSuccessfulRead(d, entityKey, steps);

  let advanced = false;
  advanced = advanceFiling(d, entityKey, company, requiredActions, providerRef) || advanced;
  advanced = (await advanceDocuments(d, entityKey, providerRef, documents)) || advanced;
  advanced = advanceEin(d, entityKey, company, providerRef) || advanced;
  return { fetched: true, advanced };
}

/**
 * Un-park every polled step a previous READ failure left in `failed` (C3).
 *
 * `failed` means "doola told us this went wrong". A read that could not reach doola never earned
 * that word, and the row it parked is now demonstrably reachable — so the row returns to
 * `pending`, its error is cleared, and its `updated_at` moves (which is what the never-polled
 * clock reads). The poll backoff is deliberately LEFT as it is: the row is still waiting, and the
 * cadence it has earned is the cadence it should keep until something actually advances.
 *
 * Rows doola itself failed are re-parked by `failRemainingSteps`, which runs before this on the
 * one path that can reach it.
 */
function unparkAfterSuccessfulRead(
  d: FormationAdvanceDeps,
  entityKey: string,
  steps: FormationRequestRecord[],
): void {
  for (const step of POLLED_STEPS) {
    const row = steps.find((s) => s.step === step);
    if (!row || row.state !== "failed") continue;
    if (d.requests.transition(entityKey, step, "failed", "pending", { error: null }))
      logFormationStep(entityKey, step, "pending", row.attempt, { unparked: true });
  }
}

/** `await_filing`: the STATE has filed the company. Writes the two legal facts onto the entity. */
function advanceFiling(
  d: FormationAdvanceDeps,
  entityKey: string,
  company: DoolaCompany,
  requiredActions: DoolaRequiredAction[] | undefined,
  providerRef: string,
): boolean {
  const row = d.requests.find(entityKey, "await_filing");
  if (!row || row.state === "abandoned") return false;

  const detail = parseDetail<AwaitFilingDetail>(row.detail);
  const next: AwaitFilingDetail = {
    ...detail,
    submissionStatus: company.formationSubmissionStatus ?? detail.submissionStatus,
    filingDate: company.formationFilingDate ?? detail.filingDate,
    filingNumber: company.formationFilingNumber ?? detail.filingNumber,
    // Ids + codes + status only. `reason` is doola prose that may name a person, so it is not
    // stored and never reaches a view.
    ...(requiredActions
      ? {
          requiredActions: requiredActions
            .filter((a) => a.open !== false)
            .map((a) => ({
              id: a.requiredActionId,
              code: a.actionCode,
              status: a.status ?? null,
            })),
        }
      : {}),
  };

  // Already filed: refresh the detail (required-actions in particular) without touching state.
  if (row.state === "confirmed") {
    d.requests.transition(entityKey, "await_filing", "confirmed", "confirmed", {
      detail: JSON.stringify(next),
    });
    return false;
  }

  if (!isFormationFiled(company)) {
    d.requests.transition(entityKey, "await_filing", row.state, row.state, {
      detail: JSON.stringify(next),
    });
    return false;
  }

  const filedAt = filingDateToUnix(company.formationFilingDate);
  let won = false;
  d.repo.transaction(() => {
    // The CAS decides; the facts are written inside the transaction it won. A second driver
    // observing the same `from` gets false here and writes nothing — which is what makes
    // "advance exactly once" true without depending on the in-process lock.
    won = d.requests.transition(entityKey, "await_filing", row.state, "confirmed", {
      detail: JSON.stringify(next),
      error: null,
    });
    if (!won) return;
    // Re-read inside the transaction: a doola round trip happened since the caller's snapshot.
    const fresh = d.repo.findByIdempotencyKey(entityKey);
    if (fresh)
      d.repo.upsert({
        ...fresh,
        formationFiledAt: filedAt,
        formationFilingNumber: company.formationFilingNumber ?? null,
      });
    d.repo.recordEvent(
      entityKey,
      "formationFiled",
      fresh?.status ?? "bound",
      null,
      JSON.stringify({
        providerRef,
        filingNumber: company.formationFilingNumber ?? null,
        filedAt,
        environment: d.environment,
      }),
    );
  });
  if (won) logFormationStep(entityKey, "await_filing", "confirmed", row.attempt, { providerRef });
  return won;
}

/** How many documents may be fetched at once for ONE entity (M5). */
export const DOCUMENT_FETCH_CONCURRENCY = 3;

/** Fetch, store and index ONE document. Never throws: returns whether it stored anything. */
async function storeOneDocument(
  d: FormationAdvanceDeps,
  entityKey: string,
  providerRef: string,
  doc: DoolaDocument,
): Promise<boolean> {
  const docType = doc.documentType?.trim() || "Unknown";
  try {
    const dl = await d.doola.getDocumentDownloadUrl(providerRef, doc.id!);
    const got = await downloadDocument(dl.downloadUrl, {
      fetchImpl: d.fetchImpl,
      lookupImpl: d.lookupImpl,
    });
    const path = documentStoreName(entityKey, docType, doc.id!);
    // Bytes to disk FIRST (atomically), index second: an index row that points at a file which
    // is not there would be a hash nobody can check, and PR 3 anchors these hashes on-chain.
    d.docStore.putBytes(path, got.bytes);
    d.documents.insert({
      id: documentIndexId(entityKey, doc.id!),
      entityKey,
      docType,
      sha256: got.sha256,
      contentType: got.contentType,
      size: got.size,
      providerDocId: doc.id!,
      path,
    });
    opsLog("formation_document_stored", {
      entityKey,
      providerRef,
      docType,
      providerDocId: doc.id,
      sha256: got.sha256,
      size: got.size,
    });
    return true;
  } catch (e) {
    opsLog("formation_document_failed", {
      level: "warn",
      entityKey,
      providerRef,
      docType,
      providerDocId: doc.id,
      ...describeDoolaError(e),
    });
    return false;
  }
}

/**
 * `fetch_documents`: store every document doola has that we do not, then confirm once the two
 * required types are in.
 *
 * One bad document never blocks the others — a single unreadable PDF must not stop the Articles
 * of Organization from being stored — and a document that is already indexed is never re-fetched.
 */
async function advanceDocuments(
  d: FormationAdvanceDeps,
  entityKey: string,
  providerRef: string,
  documents: DoolaDocument[],
): Promise<boolean> {
  const row = d.requests.find(entityKey, "fetch_documents");
  if (!row || row.state === "abandoned") return false;

  // Only what we do not already hold. A document already indexed is never re-fetched: doola
  // re-issues a document under a NEW id, so an id we know is bytes we know.
  const wanted = documents.filter(
    (doc) => doc.id && !d.documents.findByProviderDocId(entityKey, doc.id),
  );

  // BOUNDED concurrency (M5). Each document is a presigned-URL call plus a download of up to
  // 16 MiB, and a formed company can carry half a dozen. Sequentially that is six round trips
  // deep while holding the entity's lock; unbounded it is six simultaneous 16 MiB buffers in a
  // process that also serves HTTP. Three is the compromise, and it is a constant rather than a
  // setting because there is nothing here an operator could tune with better information.
  let stored = false;
  const queue = [...wanted];
  const worker = async () => {
    for (;;) {
      const doc = queue.shift();
      if (!doc?.id) return;
      // One bad document never blocks the others — a single unreadable PDF must not stop the
      // Articles of Organization from being stored.
      if (await storeOneDocument(d, entityKey, providerRef, doc)) stored = true;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DOCUMENT_FETCH_CONCURRENCY, queue.length) }, worker),
  );

  const have = new Set(d.documents.storedTypes(entityKey));
  const missing = REQUIRED_DOCUMENT_TYPES.filter((t) => !have.has(t));
  const detail: FetchDocumentsDetail = {
    ...parseDetail<FetchDocumentsDetail>(row.detail),
    stored: d.documents
      .listByEntity(entityKey)
      .map((r) => ({ docId: r.providerDocId, type: r.docType, sha256: r.sha256 })),
    missing,
  };

  if (row.state === "confirmed") {
    d.requests.transition(entityKey, "fetch_documents", "confirmed", "confirmed", {
      detail: JSON.stringify(detail),
    });
    return stored;
  }
  if (missing.length > 0) {
    d.requests.transition(entityKey, "fetch_documents", row.state, row.state, {
      detail: JSON.stringify(detail),
    });
    return stored;
  }

  const won = d.requests.transition(entityKey, "fetch_documents", row.state, "confirmed", {
    detail: JSON.stringify(detail),
    error: null,
  });
  if (won)
    logFormationStep(entityKey, "fetch_documents", "confirmed", row.attempt, {
      providerRef,
      documents: detail.stored?.length ?? 0,
    });
  return stored || won;
}

/** `await_ein`: the IRS has issued. Writes `ein_real` onto the entity inside the winning CAS. */
function advanceEin(
  d: FormationAdvanceDeps,
  entityKey: string,
  company: DoolaCompany,
  providerRef: string,
): boolean {
  const row = d.requests.find(entityKey, "await_ein");
  if (!row || row.state === "confirmed" || row.state === "abandoned") return false;
  const ein = company.ein?.trim();
  if (!ein) {
    // C3. The IRS takes four to SIX WEEKS, and this branch is the one an `await_ein` row spends
    // all of them in. Returning without writing anything left `updated_at` frozen and no
    // `next_poll_at` at all, so the row read as due on every single tick — 60 pointless round
    // trips an hour, for six weeks, per entity. The cadence is the row's own memory of how long
    // it has been waiting, so an empty read doubles it (capped at a week) whether the read came
    // from the timer or from a webhook wake-up; anything that actually advances resets it.
    persistPollBackoff(d, row, { advanced: false });
    return false;
  }

  const detail: AwaitEinDetail = {
    ...parseDetail<AwaitEinDetail>(row.detail),
    observedAt: (d.now ?? Date.now)(),
  };
  let won = false;
  d.repo.transaction(() => {
    won = d.requests.transition(entityKey, "await_ein", row.state, "confirmed", {
      detail: JSON.stringify(detail),
      error: null,
    });
    if (!won) return;
    const fresh = d.repo.findByIdempotencyKey(entityKey);
    // `ein_real`, never `ein`: the latter is the placeholder frozen on-chain at mint, and
    // overwriting it would make the record disagree with the chain.
    if (fresh) d.repo.upsert({ ...fresh, einReal: ein });
    // The EIN itself never reaches the audit trail — it is a tax identifier, and the event only
    // needs to record THAT one was issued.
    d.repo.recordEvent(
      entityKey,
      "formationEin",
      fresh?.status ?? "bound",
      null,
      JSON.stringify({ providerRef, environment: d.environment }),
    );
  });
  if (won) logFormationStep(entityKey, "await_ein", "confirmed", row.attempt, { providerRef });
  return won;
}

/** doola says the formation failed: park every step that has not already succeeded. */
function failRemainingSteps(
  d: FormationAdvanceDeps,
  entityKey: string,
  steps: FormationRequestRecord[],
  providerRef: string,
): boolean {
  const error = "doola reports the formation FAILED";
  let touched = false;
  for (const step of POLLED_STEPS) {
    const row = steps.find((s) => s.step === step);
    if (!row || row.state === "confirmed" || row.state === "abandoned") continue;
    failFormationStep(d, entityKey, step, error, { providerRef });
    touched = true;
  }
  if (touched)
    opsLog("formation_failed", {
      level: "warn",
      entityKey,
      providerRef,
      environment: d.environment,
    });
  return touched;
}

// ── the webhook side ────────────────────────────────────────────────────────────────────────

export interface FormationEventDeps extends FormationAdvanceDeps {
  events: DoolaEventRepository;
}

/**
 * How this wake-up should be dispatched (M2).
 *
 * There used to be TWO dispatchers: this function, and a re-implementation of it inside the
 * sweeper's re-drive that skipped the name check and forced the required-actions read. Two
 * dispatchers is two answers to "what does an event mean", and the sweeper's copy had already
 * quietly diverged (it never logged an unknown name, and it marked events processed on a
 * different condition). The differences are now PARAMETERS, which is what they always were.
 */
export interface ProcessEventOptions {
  /** Who is asking. Appears on every ops line so a re-drive is distinguishable from a delivery. */
  source?: "webhook" | "sweeper";
  /**
   * Accept a name we have no route for.
   *
   * The receiver refuses one deliberately: an event we do not understand deserves an operator's
   * attention BEFORE we act on it, and leaving it unprocessed is what gets it that attention. By
   * the time the sweeper re-drives the row, that attention has had its chance — and the right
   * action for any wake-up is the same one, which is to re-read doola.
   */
  acceptUnknownNames?: boolean;
  /** Force the required-actions read. A periodic pass has no event name to infer it from. */
  requiredActions?: boolean;
}

/** What the caller learns. `fetched` is the only thing that may retire an event. */
export interface ProcessEventResult {
  fetched: boolean;
  advanced: boolean;
  /** The entity the event mapped to, when it mapped to one. */
  entityKey?: string;
  /** Why nothing was done, when nothing was done. */
  skipped?: "webhook_disabled" | "no_provider_ref" | "unmapped" | "unknown_name";
}

/**
 * Handle one verified wake-up. The ONE dispatcher — the webhook receiver and the sweeper's
 * re-drive both come through here.
 *
 * The rules for `processed_at` are the whole design of this function:
 *  - marked ONLY after a successful fetch-and-advance, because an unmarked row is the sweeper's
 *    retry queue and marking early would silently drop the work;
 *  - an unmappable company id leaves it NULL forever — until `create_provider` lands that ref,
 *    at which point a sweeper tick re-drives it (design §5/§6);
 *  - re-processing a marked event is harmless anyway: every transition is a CAS.
 */
export async function processDoolaEvent(
  d: FormationEventDeps,
  wake: DoolaWakeUp,
  opts: ProcessEventOptions = {},
): Promise<ProcessEventResult> {
  const source = opts.source ?? "webhook";
  // Account-level and companyless: doola has switched our endpoint OFF and only a human can turn
  // it back on. CRITICAL because every formation in flight is now blind until someone does.
  // (The monitor alert wiring is PR 3; this journald line is the ops trail today.)
  if (wake.eventName === DOOLA_EVENT_NAMES.webhookDisabled) {
    opsLog("doola_webhook_disabled", {
      severity: "CRITICAL",
      level: "error",
      environment: d.environment,
      source,
      eventId: wake.eventId,
      message:
        "doola has DISABLED our webhook endpoint — re-enable it manually in the partner portal (docs/runbooks/doola-webhooks.md); until then the sweeper's poll is the only progress path",
    });
    d.events.markProcessed(wake.eventId);
    return { fetched: false, advanced: false, skipped: "webhook_disabled" };
  }

  if (!wake.providerRef) {
    opsLog("doola_webhook_unmapped", {
      level: "warn",
      environment: d.environment,
      source,
      eventId: wake.eventId,
      eventName: wake.eventName,
      reason: "no company id in the envelope",
    });
    return { fetched: false, advanced: false, skipped: "no_provider_ref" }; // processed_at stays NULL
  }

  const owner = d.requests.findByProviderRef(wake.providerRef);
  if (!owner) {
    // The company exists at doola but no `create_provider` row claims it yet — the create's
    // response and its webhook can race. Kept, not dropped: a later tick will place it.
    opsLog("doola_webhook_unmapped", {
      level: "warn",
      environment: d.environment,
      source,
      eventId: wake.eventId,
      eventName: wake.eventName,
      providerRef: wake.providerRef,
      reason: "no entity owns this company id yet",
    });
    return { fetched: false, advanced: false, skipped: "unmapped" };
  }

  if (!isKnownDoolaEvent(wake.eventName)) {
    opsLog("doola_webhook_unknown_event", {
      level: "warn",
      environment: d.environment,
      source,
      eventId: wake.eventId,
      eventName: wake.eventName,
      entityKey: owner.entityKey,
      accepted: Boolean(opts.acceptUnknownNames),
    });
    // Left unprocessed so the sweeper's re-drive picks it up — and the re-drive is the caller
    // that passes `acceptUnknownNames`, which is how the second look becomes an action.
    if (!opts.acceptUnknownNames)
      return {
        fetched: false,
        advanced: false,
        entityKey: owner.entityKey,
        skipped: "unknown_name",
      };
  }

  const outcome = await withKeyedLock(owner.entityKey, () =>
    advanceFormation(d, owner.entityKey, {
      // A periodic pass has no name to infer from, so it always asks.
      requiredActions: opts.requiredActions || eventSuggestsRequiredActions(wake.eventName),
    }),
  );
  // Only a real read may retire the event. A skipped or failed pass leaves it for the sweeper.
  if (outcome.fetched) d.events.markProcessed(wake.eventId);
  return { fetched: outcome.fetched, advanced: outcome.advanced, entityKey: owner.entityKey };
}
