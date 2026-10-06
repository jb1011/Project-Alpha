import { opsLog } from "../observability/opsLog";
import { withKeyedLock } from "../payments/keyedMutex";
import { isDraftExpired } from "../persistence/legalBodyRepository";
import { checkBinding } from "./binding";
import { type LegalBodyOrderDeps, orderLockKey } from "./orders";
import { RESOLVE_FIRST_INTERVAL_MS, resolveOrder } from "./resolver";

/**
 * THE LEGAL-BODY SWEEPER: the timer that settles reserved orders and watches bindings.
 *
 * A door does what it can while its caller waits; the rest is this loop's. Each tick, in order:
 *  1. up to `maxPerTick` reserved orders whose resolve schedule is due (`listReserved`), each
 *     settled from the chain (`resolveOrder`);
 *  2. up to `maxPerTick` bodies whose binding check is due (`listBindingDue`), each checked
 *     (`checkBinding`);
 *  3. on the first tick and every `HOUSEKEEPING_EVERY_N_TICKS` after it, the housekeeping: the
 *     drafts no longer linkable are abandoned, then the customer companies' evidence bytes and
 *     stale companies are expired, at most `HOUSEKEEPING_BATCH` of each.
 * The first tick runs when `start()` is called, and it is the boot reconcile: whatever a restart
 * interrupted is due already.
 *
 * ONE WRITER PER ORDER: every row is worked under its order's lock (`orderLockKey`), the lock the
 * doors take, so a door and the sweeper never move one order at the same time. Neither the
 * resolver nor the binding check takes it: the lock is not re-entrant.
 *
 * NOBODY CAN STOP IT. Both listings are deployment-scoped (a row of another factory or chain is
 * never listed) and scheduled, soonest first: every answer of the resolver and the binding check
 * that leaves a row in place moves its schedule, so a row that cannot be settled backs off instead
 * of staying due. A pass that throws (a fault that is not the chain's, which those two let
 * through) moves the row's schedule forward here, so it cannot stay first and starve the rows
 * behind it. Each row, each listing and each housekeeping call has its own try/catch and one log
 * line naming the error, never its message: one failure never stops the tick, and a tick that
 * throws all the same is followed by the next one. It takes no token from any budget, so a caller
 * that empties the doors' budget does not slow it: `maxPerTick` is its bound, at most ten rows a
 * tick, a handful of reads each.
 *
 * The loop is the formation sweeper's: a self-rescheduling `setTimeout` guarded against
 * overlapping ticks, unref'd so a pending tick never keeps a process alive.
 */

/** The most rows each due listing hands one tick. */
export const LEGAL_BODY_SWEEP_MAX_PER_TICK = 5;
/** The housekeeping leg runs on the first tick and on every tick this many after it: hourly at
 *  the default interval of 30 seconds. Its deadlines are days long. */
export const HOUSEKEEPING_EVERY_N_TICKS = 120;
/** The most rows each housekeeping call handles in one run. */
export const HOUSEKEEPING_BATCH = 50;

export interface LegalBodySweeperDeps extends LegalBodyOrderDeps {
  /** Milliseconds from the end of one tick to the start of the next. */
  intervalMs: number;
  /** The most rows each due listing hands one tick. */
  maxPerTick: number;
  /** The customer-company housekeeping, each call bounded by its caller; each answers how many
   *  rows it changed. */
  housekeeping: { expireEvidence: () => number; expireStaleCompanies: () => number };
}

/** The two legs that work scheduled rows. */
type Leg = "resolve" | "binding";

const nameOf = (err: unknown) => (err instanceof Error ? err.name : "not_an_error");

export class LegalBodySweeper {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** In-flight guard: a tick that outruns the interval must not overlap itself. */
  private ticking = false;
  private ticks = 0;

  constructor(private readonly d: LegalBodySweeperDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Tick at once, then forever. Each tick is guarded: the next one is scheduled no matter what. */
  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (err) {
        opsLog("legal_body_sweep_failed", { level: "warn", errorName: nameOf(err) });
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

  /** One pass. Safe to call directly: `start()` calls it at once, and a call made while a pass
   *  is running returns without doing anything. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const housekeeping = this.ticks % HOUSEKEEPING_EVERY_N_TICKS === 0;
    try {
      await this.guarded("resolve", () => this.workDue("resolve"));
      await this.guarded("binding", () => this.workDue("binding"));
      if (housekeeping) await this.housekeep();
    } finally {
      this.ticks++;
      this.ticking = false;
    }
  }

  /** One leg's due rows, soonest first, each under its order's lock. */
  private async workDue(leg: Leg): Promise<void> {
    const { repo, deployment, maxPerTick } = this.d;
    const due =
      leg === "resolve"
        ? repo.listReserved(deployment, this.now(), maxPerTick)
        : repo.listBindingDue(deployment, this.now(), maxPerTick);
    for (const row of due) await this.workRow(leg, row.legalBodyId);
  }

  /** One row: its pass, and if the pass throws, its schedule moved forward and one line. */
  private async workRow(leg: Leg, id: string): Promise<void> {
    try {
      const failed = await withKeyedLock(orderLockKey(id), async () => {
        try {
          if (leg === "resolve") await resolveOrder(this.d, id);
          else await checkBinding(this.d, id);
          return undefined;
        } catch (err) {
          return { errorName: nameOf(err), rescheduled: this.moveForward(id) };
        }
      });
      if (failed !== undefined)
        opsLog("legal_body_sweep_row_failed", { level: "warn", orderId: id, leg, ...failed });
    } catch (err) {
      opsLog("legal_body_sweep_row_failed", {
        level: "warn",
        orderId: id,
        leg,
        errorName: nameOf(err),
      });
    }
  }

  /**
   * After a pass that threw: the row's next check moves forward, never back, so that a row that
   * throws on every pass goes behind the rows due after it instead of staying first. A reserved
   * row waits the resolve schedule's first interval, any other row its own interval, which stays
   * as it is. A row with no schedule is left without one: a reserved row's schedule is never
   * cleared, and none is set where there was none. Answers whether the schedule moved; a fault
   * here too leaves it where it was.
   */
  private moveForward(id: string): boolean {
    try {
      const row = this.d.repo.findById(id);
      if (row === undefined || row.nextBindingCheckAt === null) return false;
      // Both columns are set together: the fallback is never read.
      const interval = row.bindingCheckIntervalMs ?? RESOLVE_FIRST_INTERVAL_MS;
      const wait = row.bindingState === "reserved" ? RESOLVE_FIRST_INTERVAL_MS : interval;
      const nextAt = Math.max(row.nextBindingCheckAt, this.now() + wait);
      return this.d.repo.scheduleBindingCheck(id, nextAt, interval);
    } catch {
      return false;
    }
  }

  /**
   * Abandons the drafts no longer linkable, then runs the two customer-company calls. One line
   * says what changed, when anything did.
   */
  private async housekeep(): Promise<void> {
    const drafts = await this.guarded("drafts", () => this.abandonExpiredDrafts());
    const evidence = await this.guarded("evidence", async () =>
      this.d.housekeeping.expireEvidence(),
    );
    const companies = await this.guarded("stale_companies", async () =>
      this.d.housekeeping.expireStaleCompanies(),
    );
    const counts = {
      draftsAbandoned: drafts ?? 0,
      evidenceExpired: evidence ?? 0,
      companiesAbandoned: companies ?? 0,
    };
    if (counts.draftsAbandoned + counts.evidenceExpired + counts.companiesAbandoned > 0)
      opsLog("legal_body_housekeeping", { level: "info", ...counts });
  }

  /**
   * A draft can be linked for 24 hours after its creation; after that it is abandoned, by the
   * system, with the reason `expired`. Each under its order's lock, and read again there: the link
   * door may have reserved it meanwhile. The age is the repository's own cutoff, the one the doors
   * apply, so a door and this leg never disagree about one draft.
   */
  private async abandonExpiredDrafts(): Promise<number> {
    let abandoned = 0;
    for (const listed of this.d.repo.listExpiredDrafts(this.now(), HOUSEKEEPING_BATCH)) {
      const id = listed.legalBodyId;
      try {
        const moved = await withKeyedLock(orderLockKey(id), async () => {
          const row = this.d.repo.findById(id);
          if (row === undefined || !isDraftExpired(row, this.now())) return false;
          return this.d.repo.abandon(id, "expired", "system");
        });
        if (moved) abandoned++;
      } catch (err) {
        opsLog("legal_body_sweep_row_failed", {
          level: "warn",
          orderId: id,
          leg: "drafts",
          errorName: nameOf(err),
        });
      }
    }
    return abandoned;
  }

  /** One unit of a tick: its throw is one line, and the tick goes on. */
  private async guarded<T>(leg: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      opsLog("legal_body_sweep_failed", { level: "warn", leg, errorName: nameOf(err) });
      return undefined;
    }
  }
}
