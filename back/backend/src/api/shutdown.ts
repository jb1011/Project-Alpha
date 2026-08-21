import { opsLog } from "../observability/opsLog";

/**
 * SIGTERM/SIGINT for the API process (design §7).
 *
 * The API process has never had signal handlers. Until now that was survivable: every request was
 * a request, so `systemctl restart` merely dropped in-flight HTTP and the client retried. Part B
 * changes that. The webhook receiver acks doola in milliseconds and does the work afterwards, and
 * the sweeper does work nobody asked for at all — so at any instant the process may hold state
 * transitions that no client is waiting on and no client will retry.
 *
 * None of it is LOST without a drain (an unprocessed event keeps `processed_at` NULL and the next
 * sweeper tick re-drives it), but "recovered by a timer within a minute" and "finished before we
 * exited" are different qualities of deploy, and the second one is available for about forty
 * lines.
 *
 * Everything is injected — the process object, the exit function, the clock bound — because the
 * one thing a test of shutdown code must not do is shut the test runner down.
 */

/** The default drain bound. Long enough for a doola fetch, short enough not to stall a deploy. */
export const SHUTDOWN_DRAIN_MS = 20_000;

/** The minimum surface a signal source has to offer. `process` satisfies it. */
export interface SignalSource {
  on(signal: string, handler: () => void): unknown;
}

export interface ShutdownDeps {
  /** Stopped FIRST, so no new work starts while the drain is running. */
  sweeper?: { stop(): void };
  /** Awaited, with a bound. */
  tasks?: { settled(timeoutMs?: number): Promise<boolean> };
  /** Closed after the drain: in-flight requests finish, no new connections are accepted. */
  server?: { close(cb?: (err?: Error) => void): void };
  drainMs?: number;
  proc?: SignalSource;
  exit?: (code: number) => void;
}

/**
 * Whether this process should install real signal handlers.
 *
 * A test runner sends its OWN SIGINT/SIGTERM, and a handler that called `process.exit` would turn
 * a Ctrl-C during `vitest --watch` into a confusing half-exit. So the composition root asks first,
 * and every test that imports the installer passes its own fake `proc` instead.
 */
export function shouldInstallSignalHandlers(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !env.VITEST && env.NODE_ENV !== "test";
}

/**
 * Install SIGTERM/SIGINT. Returns the shutdown routine itself, so a caller (or a test) can run it
 * without a signal.
 *
 * Order matters and is the whole point:
 *   1. stop the sweeper — no NEW work while we are trying to finish the old;
 *   2. drain tracked background tasks, bounded, so one wedged doola call cannot hang the deploy;
 *   3. close the HTTP server, letting in-flight requests finish;
 *   4. exit.
 *
 * Re-entrant by design: a second signal during a drain is ignored rather than starting a second
 * shutdown, because an impatient operator pressing Ctrl-C twice should not be how a half-written
 * transition happens.
 */
export function installShutdownHandlers(d: ShutdownDeps = {}): (signal: string) => Promise<void> {
  const proc = d.proc ?? process;
  const exit = d.exit ?? ((code: number) => process.exit(code));
  const drainMs = d.drainMs ?? SHUTDOWN_DRAIN_MS;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    opsLog("api_stop", { signal });

    d.sweeper?.stop();

    if (d.tasks) {
      const drained = await d.tasks.settled(drainMs);
      // Said out loud either way: "we exited with work outstanding" is exactly the line an
      // operator wants in journald when the next tick has to clean something up.
      opsLog("api_drain", { signal, drained, drainMs });
    }

    if (d.server) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        // A keep-alive connection can hold `close` open indefinitely, and a deploy waiting on an
        // idle browser tab is worse than a dropped keep-alive.
        const t = setTimeout(done, drainMs);
        (t as { unref?: () => void }).unref?.();
        d.server?.close(() => {
          clearTimeout(t);
          done();
        });
      });
    }

    exit(0);
  };

  proc.on("SIGINT", () => void shutdown("SIGINT"));
  proc.on("SIGTERM", () => void shutdown("SIGTERM"));
  return shutdown;
}
