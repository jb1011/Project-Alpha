import { opsLog } from "../observability/opsLog";

/**
 * A drain-able set of fire-and-forget background tasks.
 *
 * The webhook receiver acks doola in milliseconds and does the real work afterwards (design §6
 * step 5) — which means that at any instant the process may hold work no request is waiting on.
 * Two things need to know about that work and neither can find it otherwise:
 *
 *  - **SIGTERM.** The API process is about to get its first signal handlers. A deploy that kills
 *    the process mid-fetch leaves an event acked, unprocessed and (correctly) `processed_at`
 *    NULL — recoverable, but only on the next sweeper tick. Draining first turns a routine
 *    restart into a clean one.
 *  - **Tests.** "the webhook returned 200" is not the assertion; "the row advanced" is. Without a
 *    join point a test has to sleep, and a sleeping test is a flaky test.
 *
 * Deliberately NOT `OnboardingRunner.pending`: that array is unbounded (it only grows, for the
 * life of the process) and it is the onboarding saga's join point. Webhook processing is neither
 * onboarding nor bounded in number, so it gets its own tracker whose entries are removed as they
 * settle.
 */
export class TaskTracker {
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly label = "task") {}

  /** How many tasks are in flight right now. */
  get size(): number {
    return this.inflight.size;
  }

  /**
   * Start `fn` and remember it until it settles.
   *
   * A rejection is LOGGED, never rethrown and never left unhandled: these tasks have no caller,
   * so an unhandled rejection would take the API process down on a doola outage.
   */
  track(fn: () => Promise<unknown>): void {
    let started: Promise<unknown>;
    try {
      started = fn();
    } catch (e) {
      // A synchronous throw before the first await — same treatment, no task to remember.
      opsLog(`${this.label}_failed`, { level: "warn", message: (e as Error).message });
      return;
    }
    const task = started
      .catch((e: Error) => {
        opsLog(`${this.label}_failed`, { level: "warn", message: e?.message ?? String(e) });
      })
      .finally(() => {
        this.inflight.delete(task);
      });
    this.inflight.add(task);
  }

  /**
   * Wait until nothing is in flight, or until `timeoutMs` elapses. Returns whether it drained.
   *
   * The LOOP is the point: a task may start another task (a webhook wake-up that schedules a
   * follow-up fetch), so awaiting one snapshot of the set can return with work still running.
   * The timeout bounds a shutdown against a task that will never finish — a deploy must not hang
   * because one doola call is wedged behind a deadline that has not fired yet.
   */
  async settled(timeoutMs?: number): Promise<boolean> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    while (this.inflight.size > 0) {
      const wave = Promise.allSettled([...this.inflight]);
      if (deadline === undefined) {
        await wave;
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const timer = new Promise<"timeout">((resolve) => {
        const t = setTimeout(() => resolve("timeout"), remaining);
        (t as { unref?: () => void }).unref?.();
      });
      if ((await Promise.race([wave.then(() => "drained" as const), timer])) === "timeout")
        return false;
    }
    return true;
  }
}
