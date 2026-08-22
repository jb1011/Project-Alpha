import { DOOLA_DEFAULT_TIMEOUT_MS, describeDoolaError } from "../adapters/doola/doolaClient";
import { sqliteUtcTimestamp } from "../formation";
import {
  EVENT_RETENTION_MS,
  FORMATION_STALE_MS,
  MAX_FORMATION_ATTEMPTS,
  POLL_BASE_MS,
  POLL_CAP_MS,
  RETRY_BASE_MS,
  RETRY_CAP_MS,
  SUBMITTED_STALL_SLACK_MS,
  type StepBackoff,
  UNBOUND_PARTY_MAX_AGE_MS,
  retryDelayMs,
} from "../formation/schedule";
import { deriveFormationStatus } from "../formation/status";
import { opsLog } from "../observability/opsLog";
import { withKeyedLock } from "../payments/keyedMutex";
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
import type { AgentSpec } from "../policy/agentSpec";
import { parseSqliteUtc } from "../util/sqliteTime";
import {
  type FormationAdvanceDeps,
  advanceFormation,
  currentPolledStep,
  processDoolaEvent,
} from "./formationProcessor";
import { runFormationCreateProvider } from "./formationProvider";
import { persistPollBackoff } from "./formationStep";

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
 *   (e) erase PII whose filing provably never happened;
 *   (f) warn about formations that have been in flight far too long;
 *   (g) drop webhook rows past their retention window.
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

/** How long a `submitted` `create_provider` row may sit before a tick presumes the process that
 *  wrote it is gone (C2). The client's own deadline plus slack — imported, never re-typed, so the
 *  two cannot drift. */
export const SUBMITTED_STALL_MS = DOOLA_DEFAULT_TIMEOUT_MS + SUBMITTED_STALL_SLACK_MS;

// ── deps ────────────────────────────────────────────────────────────────────────────────────

export interface FormationSweeperDeps extends FormationAdvanceDeps {
  events: DoolaEventRepository;
  parties: FormationPartyRepository;
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
   * Stale warnings already emitted, keyed `entityKey:step:YYYY-MM-DD`.
   *
   * In memory, and deliberately so: this is de-duplication of an ops LINE, not state anything
   * depends on. A restart re-warns, which is the failure direction to prefer — the alternative is
   * a persisted marker that could suppress a warning about a formation nobody is watching.
   */
  private readonly warned = new Set<string>();

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
   * Entities that are PINNED to doola, have a party bound, and have no formation rows at all.
   *
   * The claim writes the pin and binds the party in one transaction; `claimAllSteps` runs later,
   * at the top of the create step, after provisioning, minting, binding and funding. A crash
   * anywhere in that stretch leaves an entity that owes a real filing and has NOTHING to find it
   * by: it is `bound`/`funded` so `listInFlight()` skips it, and it has no rows so every query in
   * this file skipped it too. It would sit there, pinned and unfiled, until a human noticed.
   */
  private async openStrandedFormations(): Promise<void> {
    for (const entityKey of this.d.requests.listUnopenedFormations(STRANDED_BATCH)) {
      opsLog("formation_stranded_opened", { entityKey, environment: this.d.environment });
      try {
        // `runFormationCreateProvider` claims all four steps in one transaction before it does
        // anything else, so this both opens the saga and runs its first step.
        await withKeyedLock(entityKey, () => this.retryCreateProvider(entityKey));
      } catch (err) {
        opsLog("formation_stranded_failed", {
          level: "warn",
          entityKey,
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
        entityKey: row.entityKey,
        stalledMs: now - parseSqliteUtc(row.updatedAt),
        providerRef: row.providerRef,
        environment: this.d.environment,
      });
      try {
        await withKeyedLock(row.entityKey, () => this.retryCreateProvider(row.entityKey));
      } catch (err) {
        opsLog("formation_retry_failed", {
          level: "warn",
          entityKey: row.entityKey,
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
      // The terminal verdict comes first: a row past the attempt bound is not retried once more.
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
          entityKey: row.entityKey,
          step: row.step,
          ...describeDoolaError(err),
        });
      }
    }
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
  private readonly drivers: Record<FormationStep, (entityKey: string) => Promise<unknown>> = {
    create_provider: (entityKey) =>
      withKeyedLock(entityKey, () => this.retryCreateProvider(entityKey)),
    await_filing: (entityKey) => this.advance(entityKey),
    fetch_documents: (entityKey) => this.advance(entityKey),
    await_ein: (entityKey) => this.advance(entityKey),
  };

  private async retry(row: FormationRequestRecord): Promise<void> {
    await this.drivers[row.step](row.entityKey);
  }

  /** Fetch-and-advance under the entity lock, asking for required-actions: a periodic pass has no
   *  event name to infer them from. */
  private advance(entityKey: string): Promise<{ fetched: boolean; advanced: boolean }> {
    return withKeyedLock(entityKey, () =>
      advanceFormation(this.d, entityKey, { requiredActions: true }),
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
  private async retryCreateProvider(entityKey: string): Promise<void> {
    const rec = this.d.repo.findByIdempotencyKey(entityKey);
    if (!rec) return;
    // The spec is persisted precisely so a resume can re-derive what to file.
    const spec = JSON.parse(rec.specJson ?? "{}") as AgentSpec;
    if (!spec.name) {
      opsLog("formation_retry_skipped", {
        level: "warn",
        entityKey,
        step: "create_provider",
        reason: "no persisted spec to file with",
      });
      return;
    }
    await runFormationCreateProvider({
      entityKey,
      rec,
      spec,
      repo: this.d.repo,
      requests: this.d.requests,
      parties: this.d.parties,
      doola: this.d.doola,
      environment: this.d.environment,
    });
  }

  /** The terminal verdict. CRITICAL: a mandatory formation has permanently failed, and the
   *  entity is live without one. */
  private abandon(row: FormationRequestRecord): void {
    const moved = this.d.requests.transition(row.entityKey, row.step, "failed", "abandoned", {
      error: row.error ?? `abandoned after ${row.attempt} attempts`,
    });
    if (!moved) return;
    opsLog("formation_abandoned", {
      severity: "CRITICAL",
      level: "error",
      entityKey: row.entityKey,
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
    const candidates = this.d.requests.listPollDueEntityKeys(
      now,
      // A row that has never been polled has a NULL column; its clock is its own `updated_at`,
      // which is the ">24h since it last moved" rule the design specifies.
      sqliteUtcTimestamp(now - POLL_BASE_MS),
      POLL_BATCH,
    );
    for (const entityKey of candidates) {
      const steps = this.d.requests.stepsOf(entityKey);
      const status = deriveFormationStatus(steps);
      // `failed` entities belong to the retry path above, not here; `complete`/`none` are done or
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
        outcome = await this.advance(entityKey);
      } catch (err) {
        opsLog("formation_poll_failed", {
          level: "warn",
          entityKey,
          ...describeDoolaError(err),
        });
        continue;
      }
      // A poll that never reached doola tells us nothing about the cadence, so it must not slow
      // the next one down — the failure path already has its own backoff.
      if (!outcome.fetched) continue;

      this.persistBackoff(entityKey, outcome.advanced);
    }
  }

  /** Write the poll schedule onto whichever step the entity is waiting on NOW — which may not be
   *  the one it was waiting on before the poll, because the poll may have advanced it. */
  private persistBackoff(entityKey: string, advanced: boolean): void {
    const steps = this.d.requests.stepsOf(entityKey);
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

  // ── (e) PII erasure (design §3, audit H7) ─────────────────────────────────────────────────

  private erasePii(): void {
    const cutoff = sqliteUtcTimestamp(this.now() - UNBOUND_PARTY_MAX_AGE_MS);
    for (const { partyId, reason } of this.d.parties.listErasable(cutoff)) {
      if (!this.d.parties.erase(partyId)) continue;
      // The party id and the reason, and nothing else — an erasure log that named the person
      // would be the one place their data outlived the erasure.
      opsLog("formation_party_erased", { partyId, reason });
    }
  }

  // ── (f) formations that have been in flight far too long ──────────────────────────────────

  private warnStale(): void {
    const now = this.now();
    const day = new Date(now).toISOString().slice(0, 10);
    for (const state of ["pending", "submitted"] as const) {
      for (const row of this.d.requests.listByState(state)) {
        const ageMs = now - parseSqliteUtc(row.createdAt);
        if (ageMs < FORMATION_STALE_MS) continue;
        const key = `${row.entityKey}:${row.step}:${day}`;
        if (this.warned.has(key)) continue;
        this.warned.add(key);
        opsLog("formation_stale", {
          level: "warn",
          entityKey: row.entityKey,
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
   * The set is keyed `entityKey:step:YYYY-MM-DD` and it is what stops one stuck formation
   * producing a warning every hour. It only ever GREW, though, and the API process is meant to
   * run for months: one entry per stuck step per day, forever. Yesterday's keys can never match
   * again, so they are simply dropped.
   */
  private pruneWarned(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    for (const key of this.warned) if (!key.endsWith(`:${today}`)) this.warned.delete(key);
  }

  // ── (g) retention ─────────────────────────────────────────────────────────────────────────

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
