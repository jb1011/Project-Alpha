import { describeDoolaError } from "../adapters/doola/doolaClient";
import { sqliteUtcTimestamp } from "../formation";
import { deriveFormationStatus } from "../formation/status";
import { opsLog } from "../observability/opsLog";
import { withKeyedLock } from "../payments/keyedMutex";
import type {
  DoolaEventRepository,
  DoolaWebhookEventRecord,
} from "../persistence/doolaEventRepository";
import type { FormationPartyRepository } from "../persistence/formationPartyRepository";
import type { FormationRequestRecord, FormationStep } from "../persistence/formationRepository";
import type { AgentSpec } from "../policy/agentSpec";
import { parseSqliteUtc } from "../util/sqliteTime";
import {
  DOOLA_EVENT_NAMES,
  type FormationAdvanceDeps,
  type PollBackoff,
  advanceFormation,
  currentPolledStep,
  parseDetail,
  processDoolaEvent,
} from "./formationProcessor";
import { runFormationCreateProvider } from "./formationProvider";

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
 * A tick does six things, in this order and for these reasons:
 *
 *   (a) re-drive events nothing could place when they arrived — once `create_provider` lands the
 *       company id, they become processable;
 *   (b) retry `failed` rows with exponential backoff, and give up at a bounded attempt count
 *       rather than retrying a hopeless row forever;
 *   (c) poll doola for anything still in flight, with its own much slower backoff;
 *   (d) erase PII whose filing provably never happened;
 *   (e) warn about formations that have been in flight far too long;
 *   (f) drop webhook rows past their retention window.
 *
 * Loop shape is the monitor's (`monitor/monitor.ts:302-314`): a guarded self-rescheduling
 * `setTimeout`, so one throwing tick can never stop the next one from being scheduled.
 */

// ── the schedules, all in one place ─────────────────────────────────────────────────────────

/** Retry backoff for a `failed` row: 1m · 2^attempt, capped. `attempt` is already ≥1 when a row
 *  reaches `failed`, so the first retry waits two minutes. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_CAP_MS = 6 * 60 * 60 * 1000;

/** After this many burned attempts a row is `abandoned` — the sweeper's terminal verdict. */
export const MAX_FORMATION_ATTEMPTS = 8;

/** Poll cadence for an in-flight entity: daily, doubling on every EMPTY poll, capped at a week.
 *  An `await_ein` row legitimately sits 4–6 weeks; polling it 42 times to learn nothing is 42
 *  round trips and 42 chances to trip a rate limit. */
export const POLL_BASE_MS = 24 * 60 * 60 * 1000;
export const POLL_CAP_MS = 7 * 24 * 60 * 60 * 1000;

/** An unbound formation party is a form somebody filled in and never used. */
export const UNBOUND_PARTY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a step may be in flight before an operator hears about it. */
export const FORMATION_STALE_MS = 14 * 24 * 60 * 60 * 1000;

/** Webhook forensics retention. */
export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The retention sweep and the stale warning run every Nth tick rather than every tick.
 *
 * Amortising them on INSERT alone (the usual trick) does not work here: a quiet table gets no
 * inserts, so an idle deployment would keep webhook rows forever — which is precisely the
 * deployment where nobody is watching. At the 60s default this is hourly.
 */
export const AMORTISED_EVERY_N_TICKS = 60;

/** `1m · 2^attempt`, capped. */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(attempt, 0), RETRY_CAP_MS);
}

/** SQLite's TEXT `CURRENT_TIMESTAMP` ("YYYY-MM-DD HH:MM:SS", UTC) as epoch ms. Defined beside
 *  its formatter in `util/sqliteTime` (M4); re-exported here because the sweeper's schedules are
 *  what the tests read it through. */
export { parseSqliteUtc };

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

  /** One pass. Safe to call directly — that is what `formationReconcile` does at boot. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const amortised = this.ticks % AMORTISED_EVERY_N_TICKS === 0;
    try {
      await this.redriveEvents();
      await this.retryFailedSteps();
      await this.pollInFlight();
      this.erasePii();
      if (amortised) {
        this.warnStale();
        this.sweepEvents();
      }
    } finally {
      this.ticks++;
      this.ticking = false;
    }
  }

  // ── (a) events nothing could place when they arrived ──────────────────────────────────────

  private async redriveEvents(): Promise<void> {
    for (const e of this.d.events.listUnprocessed()) {
      try {
        await this.redrive(e);
      } catch (err) {
        opsLog("doola_event_redrive_failed", {
          level: "warn",
          eventId: e.eventId,
          ...describeDoolaError(err),
        });
      }
    }
  }

  private async redrive(e: DoolaWebhookEventRecord): Promise<void> {
    // Companyless and account-level: the receiver's own handler logs it CRITICAL and retires it.
    if (e.eventName === DOOLA_EVENT_NAMES.webhookDisabled) {
      await processDoolaEvent(this.d, {
        eventId: e.eventId,
        eventName: e.eventName,
        providerRef: e.providerRef,
      });
      return;
    }
    if (!e.providerRef) return; // nothing to map it to, ever; the retention sweep will drop it
    const owner = this.d.requests.findByProviderRef(e.providerRef);
    if (!owner) return; // still unmappable — keep waiting for `create_provider`

    // Note this does NOT go back through `processDoolaEvent`: that function refuses an event name
    // it has no route for, on purpose, so a name we do not understand gets an operator's
    // attention before we act on it. By the time the SWEEPER sees the row, that attention has had
    // its chance, and the correct action for any wake-up is the same one — re-read doola. Asking
    // for required-actions too, because a periodic pass has no name to infer them from.
    const outcome = await withKeyedLock(owner.entityKey, () =>
      advanceFormation(this.d, owner.entityKey, { requiredActions: true }),
    );
    if (outcome.fetched) this.d.events.markProcessed(e.eventId);
  }

  // ── (b) retry, then give up ───────────────────────────────────────────────────────────────

  private async retryFailedSteps(): Promise<void> {
    const now = this.now();
    for (const row of this.d.requests.listByState("failed")) {
      // The terminal verdict comes first: a row past the attempt bound is not retried once more.
      if (row.attempt >= MAX_FORMATION_ATTEMPTS) {
        this.abandon(row);
        continue;
      }
      if (now - parseSqliteUtc(row.updatedAt) < retryDelayMs(row.attempt)) continue;
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

  private async retry(row: FormationRequestRecord): Promise<void> {
    if (row.step === "create_provider") {
      await withKeyedLock(row.entityKey, () => this.retryCreateProvider(row.entityKey));
      return;
    }
    await withKeyedLock(row.entityKey, () =>
      advanceFormation(this.d, row.entityKey, { requiredActions: true }),
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

  // ── (c) the slow poll ─────────────────────────────────────────────────────────────────────

  private async pollInFlight(): Promise<void> {
    const now = this.now();
    for (const entityKey of this.d.requests.listOpenEntityKeys()) {
      const steps = this.d.requests.stepsOf(entityKey);
      const status = deriveFormationStatus(steps);
      // `failed` entities belong to the retry path above, not here; `complete`/`none` are done or
      // have not started. What is left is genuinely in flight.
      if (status === "complete" || status === "failed" || status === "none") continue;
      const step = currentPolledStep(steps);
      if (!step) continue;
      const row = steps.find((s) => s.step === step);
      if (!row) continue;

      const backoff = parseDetail<PollBackoff>(row.detail);
      // Never polled: the row's own age is the clock, which is the ">24h since updated_at" rule.
      const due = backoff.nextPollAt ?? parseSqliteUtc(row.updatedAt) + POLL_BASE_MS;
      if (now < due) continue;

      let outcome: Awaited<ReturnType<typeof advanceFormation>>;
      try {
        outcome = await withKeyedLock(entityKey, () =>
          advanceFormation(this.d, entityKey, { requiredActions: true }),
        );
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

      const interval = outcome.advanced
        ? POLL_BASE_MS
        : Math.min((backoff.pollIntervalMs ?? POLL_BASE_MS) * 2, POLL_CAP_MS);
      this.persistBackoff(entityKey, { nextPollAt: now + interval, pollIntervalMs: interval });
    }
  }

  /** Write the poll schedule onto whichever step the entity is waiting on NOW — which may not be
   *  the one it was waiting on before the poll, because the poll may have advanced it. */
  private persistBackoff(entityKey: string, backoff: PollBackoff): void {
    const steps = this.d.requests.stepsOf(entityKey);
    const step = currentPolledStep(steps);
    if (!step) return; // fully formed: there is nothing left to schedule
    const row = steps.find((s) => s.step === step);
    if (!row) return;
    this.d.requests.transition(entityKey, step, row.state, row.state, {
      detail: JSON.stringify({ ...parseDetail<PollBackoff>(row.detail), ...backoff }),
    });
  }

  // ── (d) PII erasure (design §3, audit H7) ─────────────────────────────────────────────────

  private erasePii(): void {
    const cutoff = sqliteUtcTimestamp(this.now() - UNBOUND_PARTY_MAX_AGE_MS);
    for (const { partyId, reason } of this.d.parties.listErasable(cutoff)) {
      if (!this.d.parties.erase(partyId)) continue;
      // The party id and the reason, and nothing else — an erasure log that named the person
      // would be the one place their data outlived the erasure.
      opsLog("formation_party_erased", { partyId, reason });
    }
  }

  // ── (e) formations that have been in flight far too long ──────────────────────────────────

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

  // ── (f) retention ─────────────────────────────────────────────────────────────────────────

  private sweepEvents(): void {
    const deleted = this.d.events.deleteOlderThan(
      sqliteUtcTimestamp(this.now() - EVENT_RETENTION_MS),
    );
    if (deleted) opsLog("doola_events_swept", { deleted });
  }
}

/**
 * One synchronous pass at boot, beside the two existing reconcilers in `api/main.ts`.
 *
 * Formation entities are `bound`/`funded` and therefore invisible to `listInFlight()` — the
 * onboarding reconciler will never look at them. Without this, everything a restart interrupted
 * would wait a full sweep interval, and everything a crash interrupted would wait until someone
 * noticed.
 */
export async function formationReconcile(sweeper: FormationSweeper): Promise<void> {
  await sweeper.tick();
}

/** Steps the sweeper retries. Exported for the tests that enumerate them. */
export const RETRYABLE_STEPS: readonly FormationStep[] = [
  "create_provider",
  "await_filing",
  "fetch_documents",
  "await_ein",
] as const;
