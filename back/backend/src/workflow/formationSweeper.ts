import { DOOLA_DEFAULT_TIMEOUT_MS, describeDoolaError } from "../adapters/doola/doolaClient";
import { sqliteUtcTimestamp } from "../formation";
import type { PiiKeyring } from "../formation/pii";
import {
  EVENT_RETENTION_MS,
  FORMATION_STALE_MS,
  MAX_FORMATION_ATTEMPTS,
  POLL_BASE_MS,
  POLL_CAP_MS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  SSN_MAX_AGE_MS,
  SUBMITTED_STALL_SLACK_MS,
  type StepBackoff,
  UNBOUND_PARTY_MAX_AGE_MS,
  retryDelayMs,
} from "../formation/schedule";
import { eraseSsnLogged } from "../formation/ssnErasure";
import { deriveFormationStatus } from "../formation/status";
import { opsLog } from "../observability/opsLog";
import { withKeyedLock } from "../payments/keyedMutex";
import type { CompanyRepository } from "../persistence/companyRepository";
import type {
  DoolaEventRepository,
  DoolaWebhookEventRecord,
} from "../persistence/doolaEventRepository";
import type { FormationPartyRepository } from "../persistence/formationPartyRepository";
import {
  type FormationRequestRecord,
  type FormationStep,
  parseDetail,
} from "../persistence/formationRepository";
import { parseSqliteUtc } from "../util/sqliteTime";
import { advanceAnchor, newAnchorReadCache } from "./anchorLoop";
import {
  type FormationAdvanceDeps,
  advanceFormation,
  currentPolledStep,
  processDoolaEvent,
} from "./formationProcessor";
import { runFormationCreateProvider } from "./formationProvider";
import { abandonFormation, persistPollBackoff, recordCompanyEvent } from "./formationStep";

/**
 * The formation sweeper (design §7 "Reconcile & sweeper") — the first recurring timer in the API
 * process.
 *
 * Everything here exists because a webhook is a BEST-EFFORT signal. doola auto-disables an
 * endpoint after five failures; a deploy can drop an acked-but-unprocessed event
 * (`synchronous=NORMAL` means a power loss can lose a just-committed row — the poll is the
 * designed backstop, L7); a company id and its first webhook can race; and `await_ein` waits four
 * to six weeks for the IRS, during which no event may arrive at all. So the timer, not the
 * webhook, is what makes progress guaranteed. The webhook only makes it FAST.
 *
 * A tick does seven things, in this order and for these reasons:
 *
 *   (a) re-drive events nothing could place when they arrived — once `create_provider` lands the
 *       company id, they become processable;
 *   (b) OPEN what a crash never opened, and re-run what a crash left mid-call (C2). These are the
 *       two windows in which an entity is pinned, owes a filing, and is invisible to every other
 *       pass: with no rows at all it matches no row query, and stuck in `submitted` it is not
 *       `failed` so the retry pass skips it. Both used to strand the formation forever;
 *   (c) retry `failed` rows with backoff, and give up at a bounded attempt count rather than
 *       retrying a hopeless row forever;
 *   (d) poll doola for anything still in flight, with its own much slower backoff;
 *   (e) drive the ON-CHAIN anchor sub-saga — open the cycle a confirmed fact justifies, adopt a
 *       broadcast a crash orphaned, and execute what the timelock has released. This is the leg
 *       that makes anchoring GUARANTEED rather than merely fast: the webhook path opens a version
 *       within the second, but only a timer can be there when a 24h timelock elapses;
 *   (f0) erase an SSN that is no longer needed or has waited out its 7-day clock (§4.6a) — a
 *        SHORTER clock than (f), over a different fact, and it never manufactures `abandoned`;
 *   (f) erase PII whose filing provably never happened;
 *   (g) warn about formations that have been in flight far too long;
 *   (h) drop webhook rows past their retention window.
 *
 * Loop shape is the monitor's (`monitor/monitor.ts:302-314`): a guarded self-rescheduling
 * `setTimeout`, so one throwing tick can never stop the next one from being scheduled.
 */

// ── the schedules ───────────────────────────────────────────────────────────────────────────
//
// Defined in `src/formation/schedule.ts` and re-exported here. They had to move: the step helpers
// write backoff now (a row parked without an attempt bump still has to back off — C1/C3), the
// helpers are imported BY the sweeper, and constants the sweeper owned would have made that a
// cycle. "The sweeper's schedules" is still how the tests and the runbook name these numbers, so
// this is where they are still reachable from.

/** The SQLite timestamp parser is defined beside its formatter in `util/sqliteTime` (M4) and
 *  re-exported here with the schedules: the sweeper's clock is what the tests read it through. */
export { parseSqliteUtc };

export {
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  MAX_FORMATION_ATTEMPTS,
  POLL_BASE_MS,
  POLL_CAP_MS,
  UNBOUND_PARTY_MAX_AGE_MS,
  SSN_MAX_AGE_MS,
  FORMATION_STALE_MS,
  EVENT_RETENTION_MS,
  SUBMITTED_STALL_SLACK_MS,
  retryDelayMs,
};

/**
 * The retention sweep and the stale warning run every Nth tick rather than every tick.
 *
 * Amortising them on INSERT alone (the usual trick) does not work here: a quiet table gets no
 * inserts, so an idle deployment would keep webhook rows forever — which is precisely the
 * deployment where nobody is watching. At the 60s default this is hourly.
 */
export const AMORTISED_EVERY_N_TICKS = 60;

/** How many entities one tick may poll, and how many stranded rows it may re-open. A tick is a
 *  timer, not a batch job: a backlog is worked down over several of them rather than in one pass
 *  that holds the process for minutes. */
export const POLL_BATCH = 200;
export const STRANDED_BATCH = 50;

/**
 * How many entities one tick may drive through the ANCHOR sub-saga, and how many at once.
 *
 * Smaller than `POLL_BATCH` because the work is heavier: an anchor pass is several sequential
 * chain reads and, on the broadcast path, a bounded receipt wait. Four in flight hides the RPC
 * latency without letting one sweep saturate the endpoint or the event loop of a process that is
 * also serving HTTP (the document fetcher's `DOCUMENT_FETCH_CONCURRENCY` reasoning, applied to a
 * per-entity unit of work).
 */
export const ANCHOR_BATCH = 50;
export const ANCHOR_CONCURRENCY = 4;

/** How long a `submitted` `create_provider` row may sit before a tick presumes the process that
 *  wrote it is gone (C2). The client's own deadline plus slack — imported, never re-typed, so the
 *  two cannot drift. */
export const SUBMITTED_STALL_MS = DOOLA_DEFAULT_TIMEOUT_MS + SUBMITTED_STALL_SLACK_MS;

// ── deps ────────────────────────────────────────────────────────────────────────────────────

export interface FormationSweeperDeps extends FormationAdvanceDeps {
  events: DoolaEventRepository;
  parties: FormationPartyRepository;
  companies: CompanyRepository;
  /** The SSN keyring (§4.2), handed on to the filing step so a resumed create can rebuild the
   *  body it originally sent. Absent on every deployment that never collected one. */
  pii?: PiiKeyring;
  /** `FORMATION_SWEEP_MS`. */
  intervalMs: number;
}

export class FormationSweeper {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** In-flight guard: a tick that outruns the interval must not overlap itself. */
  private ticking = false;
  private ticks = 0;
  /**
   * Stale warnings already emitted, keyed `companyId:step:YYYY-MM-DD`.
   *
   * In memory, and deliberately so: this is de-duplication of an ops LINE, not state anything
   * depends on. A restart re-warns, which is the failure direction to prefer — the alternative is
   * a persisted marker that could suppress a warning about a formation nobody is watching.
   */
  private readonly warned = new Set<string>();

  /**
   * Where the last anchor batch stopped (2026-08-26 §3) — PERSISTED in `meta.anchor_cursor`.
   *
   * It used to live only in memory, on the argument that it is a fairness aid rather than state
   * anything depends on. That argument is wrong in exactly the case the cursor exists for: a
   * deployment that restarts more often than it takes to page through the due set (a deploy, a
   * crash loop, an OOM) resets to the head every time, and the tail is never reached at all —
   * which IS the starvation. The field is the in-process mirror; the row is the truth.
   */
  private anchorCursor: string | undefined;
  /** Whether the persisted cursor has been read yet. One read per process, at the first tick that
   *  has anchor wiring — the composition root builds this object before the DB is interesting. */
  private anchorCursorLoaded = false;

  constructor(private readonly d: FormationSweeperDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Poll forever. Each tick is fully guarded — the loop is scheduled again no matter what. */
  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (err) {
        opsLog("formation_sweep_failed", { level: "warn", ...describeDoolaError(err) });
      }
      if (!this.stopped) {
        this.timer = setTimeout(loop, this.d.intervalMs);
        // A pending sweep must never be the reason a process (or a test worker) stays alive.
        (this.timer as { unref?: () => void }).unref?.();
      }
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One pass. Safe to call directly — `start()` calls it immediately, and that first call is
   *  the boot reconcile (C4). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const amortised = this.ticks % AMORTISED_EVERY_N_TICKS === 0;
    try {
      await this.redriveEvents();
      await this.openStrandedFormations();
      await this.resumeStalledCreates();
      await this.retryFailedSteps();
      await this.pollInFlight();
      await this.advanceAnchors();
      this.eraseExpiredSsns();
      this.erasePii();
      if (amortised) {
        this.warnStale();
        this.sweepEvents();
        this.pruneWarned();
      }
    } finally {
      this.ticks++;
      this.ticking = false;
    }
  }

  // ── (a) events nothing could place when they arrived ──────────────────────────────────────

  private async redriveEvents(): Promise<void> {
    const pending = this.d.events.listUnprocessed();

    // Coalesce by company id (M5). doola's retry ladder plus a busy formation can leave five or
    // six unprocessed events for ONE company, and each of them used to be its own
    // fetch-and-advance: the same three reads, five times, for a state that can only be read
    // once. One advance answers all of them, because a wake-up carries no facts — every event
    // for a company is the same request, "look again".
    const byRef = new Map<string, DoolaWebhookEventRecord[]>();
    const companyless: DoolaWebhookEventRecord[] = [];
    for (const e of pending) {
      if (!e.providerRef) {
        companyless.push(e);
        continue;
      }
      const group = byRef.get(e.providerRef);
      if (group) group.push(e);
      else byRef.set(e.providerRef, [e]);
    }

    for (const e of companyless) await this.redriveOne(e, [e]);
    for (const group of byRef.values()) await this.redriveOne(group[0]!, group);
  }

  /**
   * Re-drive ONE group of events through the SAME dispatcher the receiver uses (M2).
   *
   * The sweeper used to re-implement the dispatch — skipping the name check, forcing the
   * required-actions read, and marking the event itself. Two dispatchers is two answers to "what
   * does an event mean", and the copy had already drifted. The differences are options now,
   * because that is what they always were: by the time the SWEEPER sees a row, an unknown name
   * has had its chance at an operator's attention, and a periodic pass has no name to infer
   * required-actions from.
   */
  private async redriveOne(
    lead: DoolaWebhookEventRecord,
    group: DoolaWebhookEventRecord[],
  ): Promise<void> {
    try {
      const result = await processDoolaEvent(
        this.d,
        { eventId: lead.eventId, eventName: lead.eventName, providerRef: lead.providerRef },
        { source: "sweeper", acceptUnknownNames: true, requiredActions: true },
      );
      // Only a real read may retire an event — and it retires the whole group, because one read
      // is exactly what all of them were asking for.
      if (result.fetched)
        for (const e of group)
          if (e.eventId !== lead.eventId) this.d.events.markProcessed(e.eventId);
    } catch (err) {
      opsLog("doola_event_redrive_failed", {
        level: "warn",
        eventId: lead.eventId,
        coalesced: group.length,
        ...describeDoolaError(err),
      });
    }
  }

  // ── (b) the two crash windows (C2) ────────────────────────────────────────────────────────

  /**
   * READY companies with a party bound and no formation rows at all.
   *
   * Two shapes come through here since the re-key. The original is the crash window: the claim
   * writes the pin and binds the party in one transaction, `claimAllSteps` runs later at the top
   * of the create step, and a crash anywhere in that stretch left an entity that owed a real
   * filing and had NOTHING to find it by. The second is ordinary operation — a company created
   * through `POST /companies` is fileable before any agent attaches to it, and this is the leg
   * that opens its filing.
   */
  private async openStrandedFormations(): Promise<void> {
    // The DEPLOYMENT's environment is part of the query, not a check made after the fact: opening
    // a company mints a `create_provider` row, and that row counts against the daily ceiling and
    // the tenant quota. A company pinned elsewhere must never consume a slot it can never use.
    for (const companyId of this.d.requests.listUnopenedFormations(
      this.d.environment,
      STRANDED_BATCH,
    )) {
      opsLog("formation_stranded_opened", { companyId, environment: this.d.environment });
      try {
        // `runFormationCreateProvider` claims all four steps in one transaction before it does
        // anything else, so this both opens the saga and runs its first step.
        await withKeyedLock(companyId, () => this.retryCreateProvider(companyId));
      } catch (err) {
        opsLog("formation_stranded_failed", {
          level: "warn",
          companyId,
          ...describeDoolaError(err),
        });
      }
    }
  }

  /**
   * `create_provider` rows left in `submitted` by a process that died mid-call.
   *
   * `submitted` means "we are inside a doola call right now", and the client's own deadline
   * bounds that. A row still `submitted` well past it belongs to nobody — and it is invisible to
   * the retry pass, which only looks at `failed`. The re-run is safe by construction: a persisted
   * `provider_ref` is ADOPTED, a persisted customer id makes the pre-create lookup meaningful,
   * and the idempotency key is derived from an attempt that nothing here moves, so a company
   * create that did commit is replayed rather than re-filed.
   */
  private async resumeStalledCreates(): Promise<void> {
    const now = this.now();
    for (const row of this.d.requests.listByState("submitted")) {
      if (row.step !== "create_provider") continue;
      if (now - parseSqliteUtc(row.updatedAt) < SUBMITTED_STALL_MS) continue;
      opsLog("formation_create_resumed", {
        level: "warn",
        companyId: row.companyId,
        stalledMs: now - parseSqliteUtc(row.updatedAt),
        providerRef: row.providerRef,
        environment: this.d.environment,
      });
      try {
        await withKeyedLock(row.companyId, () => this.retryCreateProvider(row.companyId));
      } catch (err) {
        opsLog("formation_retry_failed", {
          level: "warn",
          companyId: row.companyId,
          step: row.step,
          ...describeDoolaError(err),
        });
      }
    }
  }

  // ── (c) retry, then give up ───────────────────────────────────────────────────────────────

  private async retryFailedSteps(): Promise<void> {
    const now = this.now();
    for (const row of this.d.requests.listByState("failed")) {
      // ── PARKED FOR A HUMAN, and it comes FIRST — before the attempt bound, deliberately.
      //
      //    doola REJECTED this intake. Re-sending the identical body cannot succeed, so the
      //    sweeper used to spend seven more attempts on a doubling backoff proving it and then
      //    `abandon` the company — which erases the responsible party's data and forecloses the
      //    edit-and-retry §4.7 offers, all within about eight hours and usually overnight.
      //
      //    The row therefore leaves the sweeper's reach entirely until the intake is EDITED: a
      //    successful `PATCH /companies/:id` clears the flag in the same transaction as the edit,
      //    which is the only evidence that exists that the next body will be different. The
      //    abandon check is BELOW this on purpose — a verdict belongs to the human who owns the
      //    row, not to a counter.
      if (this.awaitingIntakeEdit(row)) continue;
      // The terminal verdict: a row past the attempt bound is not retried once more.
      if (row.attempt >= MAX_FORMATION_ATTEMPTS) {
        this.abandon(row);
        continue;
      }
      if (now < this.retryDueAt(row)) continue;
      try {
        await this.retry(row);
      } catch (err) {
        opsLog("formation_retry_failed", {
          level: "warn",
          companyId: row.companyId,
          step: row.step,
          ...describeDoolaError(err),
        });
      }
    }
  }

  /**
   * Is this row waiting on a human to correct the intake (§4.7)?
   *
   * Only `create_provider` can be: it is the only step whose input a caller can edit, and the
   * flag is written by the one failure class that re-opens the intake — a doola `rejected`.
   */
  private awaitingIntakeEdit(row: FormationRequestRecord): boolean {
    if (row.step !== "create_provider") return false;
    return parseDetail<{ awaitingIntakeEdit?: boolean }>(row.detail).awaitingIntakeEdit === true;
  }

  /**
   * When a parked row may be tried again.
   *
   * TWO schedules, because there are two kinds of parking (C1/C3). A row whose attempt was BURNED
   * carries the count in `attempt`, and `retryDelayMs` reads it. A row parked WITHOUT a bump — a
   * lost doola answer, a transient read failure, a config mismatch — has an `attempt` that
   * deliberately does not move, so the interval itself is its only memory of how many times this
   * has happened; it is persisted as `nextRetryAt` and it wins when present.
   */
  private retryDueAt(row: FormationRequestRecord): number {
    const backoff = parseDetail<StepBackoff>(row.detail);
    return backoff.nextRetryAt ?? parseSqliteUtc(row.updatedAt) + retryDelayMs(row.attempt);
  }

  /**
   * Which driver owns each step's retry — a TABLE, not an `if` (M2).
   *
   * The distinction is real and it is per-step: `create_provider` is driven by the filing step
   * (it is the only one that can create a company, and it carries the whole crash-window
   * discipline), while every polled step is driven by fetch-and-advance. A fifth step added to
   * `FORMATION_STEP_ORDER` without a driver is now a type error rather than a row that silently
   * never retries.
   */
  private readonly drivers: Record<FormationStep, (companyId: string) => Promise<unknown>> = {
    create_provider: (companyId) =>
      withKeyedLock(companyId, () => this.retryCreateProvider(companyId)),
    await_filing: (companyId) => this.advance(companyId),
    fetch_documents: (companyId) => this.advance(companyId),
    await_ein: (companyId) => this.advance(companyId),
  };

  private async retry(row: FormationRequestRecord): Promise<void> {
    await this.drivers[row.step](row.companyId);
  }

  /** Fetch-and-advance under the COMPANY lock, asking for required-actions: a periodic pass has
   *  no event name to infer them from. */
  private advance(companyId: string): Promise<{ fetched: boolean; advanced: boolean }> {
    return withKeyedLock(companyId, () =>
      advanceFormation(this.d, companyId, { requiredActions: true }),
    );
  }

  /**
   * Re-run the filing step.
   *
   * `runFormationCreateProvider` never throws and carries the whole crash-window discipline — a
   * persisted company id is ADOPTED, never re-filed — so the sweeper simply calls it again. That
   * is the entire reason the saga step was written as a standalone module rather than as another
   * branch inside onboarding: the retry driver is not the saga.
   */
  private async retryCreateProvider(companyId: string): Promise<void> {
    // The company row IS the persisted intake — names, purpose, industry — so a resume re-derives
    // nothing and re-reads everything. (It used to parse the agent's spec_json, which is why an
    // entity with no persisted spec could not be retried at all.)
    const company = this.d.companies.find(companyId);
    if (!company) {
      opsLog("formation_retry_skipped", {
        level: "warn",
        companyId,
        step: "create_provider",
        reason: "no company row to file with",
      });
      return;
    }
    await runFormationCreateProvider({
      company,
      companies: this.d.companies,
      repo: this.d.repo,
      requests: this.d.requests,
      parties: this.d.parties,
      doola: this.d.doola,
      environment: this.d.environment,
      // Without it, a resumed create that originally carried an SSN would park rather than
      // rebuild the body it sent (§4.5) — which is safe, but only correct on a box that really
      // has no key.
      pii: this.d.pii,
    });
  }

  /** The terminal verdict. CRITICAL: a mandatory formation has permanently failed, and the
   *  entity is live without one. */
  private abandon(row: FormationRequestRecord): void {
    // The step transition and the COMPANY's status move in ONE transaction (2026-08-26 §4.6):
    // company-level `abandoned` has exactly three writers, and all three go through the SAME
    // function so the company and its step can never disagree about whether the filing is over.
    const moved = abandonFormation(
      this.d.requests,
      this.d.companies,
      row.companyId,
      row.error ?? `abandoned after ${row.attempt} attempts`,
      { transaction: (fn) => this.d.repo.transaction(fn), step: row.step, from: "failed" },
    );
    if (!moved) return;
    opsLog("formation_abandoned", {
      severity: "CRITICAL",
      level: "error",
      companyId: row.companyId,
      step: row.step,
      attempt: row.attempt,
      environment: this.d.environment,
    });
  }

  // ── (d) the slow poll ─────────────────────────────────────────────────────────────────────

  private async pollInFlight(): Promise<void> {
    const now = this.now();
    // The due-set comes from SQL (M5). It used to be "every entity with an open row", whose cost
    // grows with the number of formations ever opened rather than with the number actually due —
    // and for each of them a `stepsOf` plus a JSON parse, once a minute, forever. `next_poll_at`
    // is a column precisely so this is an indexed range scan; the result is a SUPERSET (it does
    // not know which step an entity is waiting on) and the loop below still decides.
    const candidates = this.d.requests.listPollDueCompanyIds(
      now,
      // A row that has never been polled has a NULL column; its clock is its own `updated_at`,
      // which is the ">24h since it last moved" rule the design specifies.
      sqliteUtcTimestamp(now - POLL_BASE_MS),
      POLL_BATCH,
    );
    for (const companyId of candidates) {
      const steps = this.d.requests.stepsOf(companyId);
      const status = deriveFormationStatus(steps);
      // `failed` companies belong to the retry path above, not here; `complete`/`none` are done or
      // have not started. What is left is genuinely in flight.
      if (status === "complete" || status === "failed" || status === "none") continue;
      const step = currentPolledStep(steps);
      if (!step) continue;
      const row = steps.find((s) => s.step === step);
      if (!row) continue;

      const backoff = parseDetail<StepBackoff>(row.detail);
      // Never polled: the row's own age is the clock, which is the ">24h since updated_at" rule.
      const due = backoff.nextPollAt ?? parseSqliteUtc(row.updatedAt) + POLL_BASE_MS;
      if (now < due) continue;

      let outcome: Awaited<ReturnType<typeof advanceFormation>>;
      try {
        outcome = await this.advance(companyId);
      } catch (err) {
        opsLog("formation_poll_failed", {
          level: "warn",
          companyId,
          ...describeDoolaError(err),
        });
        continue;
      }
      // A poll that never reached doola tells us nothing about the cadence, so it must not slow
      // the next one down — the failure path already has its own backoff.
      if (!outcome.fetched) continue;

      this.persistBackoff(companyId, outcome.advanced);
    }
  }

  /** Write the poll schedule onto whichever step the company is waiting on NOW — which may not be
   *  the one it was waiting on before the poll, because the poll may have advanced it. */
  private persistBackoff(companyId: string, advanced: boolean): void {
    const steps = this.d.requests.stepsOf(companyId);
    const step = currentPolledStep(steps);
    if (!step) return; // fully formed: there is nothing left to schedule
    const row = steps.find((s) => s.step === step);
    if (!row) return;
    // The processor may already have scheduled this row on the way past — `advanceEin` does,
    // because it is the step that spends six weeks doing nothing and it is the one handler with
    // no state change to hang an `updated_at` on. Doubling an interval twice for one poll would
    // make the cadence grow at the square of the intended rate, so a schedule that is already in
    // the future is left alone. An ADVANCE still resets it: something happened, ask again soon.
    if (!advanced && row.nextPollAt !== null && row.nextPollAt > this.now()) return;
    // The same helper the processor uses, so the blob and the `next_poll_at` column are written
    // together by ONE piece of code — the column is an index over the blob, never a second truth.
    persistPollBackoff(this.d, row, { advanced });
  }

  // ── (e) the on-chain anchor sub-saga (design §7) ──────────────────────────────────────────

  /**
   * Drive every entity whose anchor pipeline could possibly move.
   *
   * THE CANDIDATE SET IS INCREMENTAL (review F6). It used to be "every open cycle, plus every
   * entity with a confirmed formation step" — and the second half is every entity that has ever
   * been formed, a set that only grows and never shrinks. Each member cost a manifest read, a
   * keccak and a canonical re-serialization, once a minute, forever, to conclude that nothing had
   * changed. `listDueEntityKeys` asks the database the question instead: an open cycle, a held
   * one, or a confirmed step written since the entity's last anchor write. The entities it still
   * over-includes (SQLite timestamps have one-second resolution, so the fast path's
   * confirm-and-open pair can look simultaneous) are dismissed by the cheap gates at the top of
   * `advanceAnchor` without a single file being opened.
   *
   * BOUNDED CONCURRENCY (review F7). Each entity is several sequential RPC round trips and, on the
   * broadcast path, a receipt wait — sequentially, a backlog of fifty is a tick that runs for
   * minutes and blocks the poll behind it. Four at a time is the same compromise the document
   * fetcher makes: enough to hide the latency, few enough that a sweep cannot saturate the RPC
   * (or the event loop of a process that is also serving HTTP). `allSettled`, because one
   * entity's rejection must never cancel its neighbours' work.
   *
   * The keyed lock is taken per entity HERE, because `advanceAnchor` is deliberately lock-free —
   * and it is REQUIRED, not an optimization: fetch-and-advance drives the same entities from
   * under the COMPANY's lock, and without an entity lock on both sides the two could each read
   * `oaScheduledAt == 0` and each broadcast a schedule, the second resetting the guardian's veto
   * window. Fetch-and-advance takes the entity lock inside the company lock, so the ordering is
   * company → entity on one side and entity alone on the other: no cycle.
   */
  private async advanceAnchors(): Promise<void> {
    const anchor = this.d.anchor;
    if (!anchor) return; // no anchor wiring: the v1-row-only shape, unchanged
    const deps = { ...this.d, ...anchor };
    // THE KEYSET CURSOR (2026-08-26 §3). A held cycle whose key sorts early used to occupy a slot
    // on every tick forever, so under N:1 — where one company can contribute ten entities to the
    // same page — the tail of the due set was never reached at all. The cursor is carried across
    // ticks and WRAPS: a short batch means the end of the set, and the next tick starts over.
    if (!this.anchorCursorLoaded) {
      this.anchorCursor = anchor.anchors.readDueCursor();
      this.anchorCursorLoaded = true;
    }
    const { entityKeys, nextCursor, companies } = anchor.anchors.listDue(
      ANCHOR_BATCH,
      this.anchorCursor,
    );
    this.anchorCursor = nextCursor ?? undefined;
    // Written on EVERY page, including the null that wraps: a restart must resume where the last
    // completed page stopped, not at the head.
    anchor.anchors.writeDueCursor(nextCursor);
    if (nextCursor !== null)
      // A full batch means work was left behind. That is ordinary and it is what the cursor makes
      // safe — INFO, not warn: it is the steady state of any deployment with more due keys than
      // one tick's budget, and a warn here trains an operator to ignore the channel. Both counts
      // are reported because they answer different questions: `entities` is what the tick
      // actually drove, `companies` is how much of the due SET one page covered.
      opsLog("anchor_batch_full", {
        level: "info",
        batch: ANCHOR_BATCH,
        companies,
        entities: entityKeys.length,
        environment: this.d.environment,
      });
    const queue = entityKeys;
    // ONE cache for the whole pass. A batch under N:1 is mostly SIBLINGS — ten agents on one
    // filing used to cost ten `companies.find`, ten `stepsOf` and ten `listByCompany` for three
    // answers that are identical by construction. Per TICK and no longer: these rows move, and a
    // cache that outlived its pass would be a staler source of truth for the facts an amendment
    // is derived from.
    const cache = newAnchorReadCache();
    const worker = async () => {
      for (;;) {
        const entityKey = queue.shift();
        if (entityKey === undefined) return;
        try {
          await withKeyedLock(entityKey, () => advanceAnchor(deps, entityKey, cache));
        } catch (err) {
          // advanceAnchor has its own catch-all, so reaching this is a bug rather than a bad
          // minute — but one entity's bug must still not stop the sweep.
          opsLog("anchor_sweep_failed", {
            level: "warn",
            entityKey,
            message: (err as Error).message,
          });
        }
      }
    };
    await Promise.allSettled(
      Array.from({ length: Math.min(ANCHOR_CONCURRENCY, queue.length) }, worker),
    );
  }

  // ── (f0) SSN retention — THE SHORT CLOCK (design 2026-08-26 §4.6a) ────────────────────────

  /**
   * Erase an SSN that is either no longer needed or has waited too long.
   *
   * TWO clauses, and they are deliberately not one:
   *
   *  - **terminal** — the company is `abandoned`, or `create_provider` is `confirmed`/
   *    `abandoned`. The `confirmed` arm is an idempotent BACKSTOP, not a TTL: §4.4 already erased
   *    in the transaction that persisted `provider_ref`, and this catches a row that somehow
   *    missed it;
   *  - **TTL** — the SSN is older than 7 days AND the filing was never in flight. Seven days is
   *    a retention promise we make in the intake copy, and "never in flight" is what makes the
   *    erasure safe: nothing is holding a body under an idempotency key, so nothing can be
   *    wedged by the value disappearing (§4.5).
   *
   * **Nothing here manufactures `abandoned` from a clock.** A company with no `provider_ref` at
   * day 7 raises `formation_stale` — an ops alert and a guardian-visible entity event — and
   * KEEPS its intake. A NULL `provider_ref` is not proof no company exists at doola (the adopt
   * path exists for exactly that case), and an erased party makes adoption unrecoverable. Only
   * the max-attempt path and the operator CLI set `abandoned`.
   *
   * Party erasure (below) is UNCHANGED: it is a different clock over a different fact.
   */
  private eraseExpiredSsns(): void {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    for (const row of this.d.parties.listSsnRetention()) {
      const ageMs = now - parseSqliteUtc(row.capturedAt);
      const terminal =
        row.companyStatus === "abandoned" ||
        row.createState === "confirmed" ||
        row.createState === "abandoned";
      const expired = ageMs >= SSN_MAX_AGE_MS && !row.everSubmitted;

      if (terminal || expired) {
        // ONE helper for every erase in the system, so the row's reason and the ops line are
        // written by the same code and an erase without an audit trail is unwritable.
        eraseSsnLogged(
          this.d.parties,
          row.companyId,
          terminal ? "terminal" : "ttl",
          this.d.environment,
        );
        continue;
      }

      // Day 7 with a filing that DID reach doola and still has no company id back. The intake is
      // kept — that is the whole point — and a human is told, once a day.
      if (ageMs >= SSN_MAX_AGE_MS && !row.providerRef) {
        const key = `ssn:${row.companyId}:${day}`;
        if (this.warned.has(key)) continue;
        this.warned.add(key);
        opsLog("formation_stale", {
          level: "error",
          severity: "CRITICAL",
          companyId: row.companyId,
          reason: "ssn_ttl_no_provider_ref",
          ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
          environment: this.d.environment,
        });
        // The guardian-visible half. There is no notification module yet (A1 deviation 8), and
        // the entity event trail is the primitive that exists and that the UI already renders —
        // so the required action is recorded where an owner will actually see it, fanned out
        // over every agent attached to the company.
        recordCompanyEvent(
          this.d.repo,
          row.companyId,
          "formationStale",
          "action required: this filing has been in flight for 7 days with no company id from the provider, and the responsible party's SSN is still held. Contact support before it is erased.",
        );
      }
    }
  }

  // ── (f) PII erasure (design §3, audit H7) ─────────────────────────────────────────────────

  private erasePii(): void {
    const cutoff = sqliteUtcTimestamp(this.now() - UNBOUND_PARTY_MAX_AGE_MS);
    for (const { partyId, reason } of this.d.parties.listErasable(cutoff)) {
      if (!this.d.parties.erase(partyId)) continue;
      // The party id and the reason, and nothing else — an erasure log that named the person
      // would be the one place their data outlived the erasure.
      opsLog("formation_party_erased", { partyId, reason });
    }
  }

  // ── (g) formations that have been in flight far too long ──────────────────────────────────

  private warnStale(): void {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    for (const state of ["pending", "submitted"] as const) {
      for (const row of this.d.requests.listByState(state)) {
        const ageMs = now - parseSqliteUtc(row.createdAt);
        if (ageMs < FORMATION_STALE_MS) continue;
        const key = `${row.companyId}:${row.step}:${day}`;
        if (this.warned.has(key)) continue;
        this.warned.add(key);
        opsLog("formation_stale", {
          level: "warn",
          companyId: row.companyId,
          step: row.step,
          ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
          environment: this.d.environment,
        });
      }
    }
  }

  /**
   * Drop stale-warning keys from days that are over (M5).
   *
   * The set is keyed `companyId:step:YYYY-MM-DD` and it is what stops one stuck formation
   * producing a warning every hour. It only ever GREW, though, and the API process is meant to
   * run for months: one entry per stuck step per day, forever. Yesterday's keys can never match
   * again, so they are simply dropped.
   */
  private pruneWarned(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    for (const key of this.warned) if (!key.endsWith(`:${today}`)) this.warned.delete(key);
  }

  // ── (h) retention ─────────────────────────────────────────────────────────────────────────

  private sweepEvents(): void {
    const deleted = this.d.events.deleteOlderThan(
      sqliteUtcTimestamp(this.now() - EVENT_RETENTION_MS),
    );
    if (deleted) opsLog("doola_events_swept", { deleted });
  }
}

/**
 * The boot reconcile is `start()` itself (C4).
 *
 * There used to be a `formationReconcile(sweeper)` helper, awaited in `api/main.ts` BEFORE
 * `serve()`. That put a third party on the boot path: the reconcile fetch-and-advances every
 * in-flight entity, so a doola outage delayed the port opening, /healthz did not answer, and the
 * deploy failed for a reason unrelated to whether the process could serve requests.
 *
 * `start()` runs its first loop iteration immediately, and that iteration IS the reconcile — the
 * helper was a duplicate of it, and awaiting it doubled every boot's doola traffic. Formation
 * entities are `bound`/`funded` and therefore invisible to `listInFlight()`, so this remains the
 * only thing that picks up what a restart interrupted; it simply does so a few milliseconds after
 * the socket is listening rather than before.
 */

/** Steps the sweeper retries. Exported for the tests that enumerate them. */
export const RETRYABLE_STEPS: readonly FormationStep[] = [
  "create_provider",
  "await_filing",
  "fetch_documents",
  "await_ein",
] as const;
