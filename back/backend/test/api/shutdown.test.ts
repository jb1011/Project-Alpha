/**
 * SIGTERM/SIGINT for the API process (design §7) — the first signal handlers it has ever had.
 *
 * Everything is injected, because the one thing a test of shutdown code must not do is shut the
 * test runner down. That is also the reason `shouldInstallSignalHandlers` exists at all: a
 * handler that called `process.exit` under vitest would turn a Ctrl-C into a confusing half-exit.
 */
import { expect, test } from "vitest";
import {
  SHUTDOWN_DRAIN_MS,
  type SignalSource,
  installShutdownHandlers,
  shouldInstallSignalHandlers,
} from "../../src/api/shutdown";

/** A stand-in for `process` that lets a test fire a signal without sending one. */
function fakeProc() {
  const handlers = new Map<string, (() => void)[]>();
  const proc: SignalSource = {
    on(signal, handler) {
      handlers.set(signal, [...(handlers.get(signal) ?? []), handler]);
      return proc;
    },
  };
  return {
    proc,
    signals: () => [...handlers.keys()],
    fire: (signal: string) => {
      for (const h of handlers.get(signal) ?? []) h();
    },
  };
}

test("the guard refuses to install real handlers under a test runner", () => {
  expect(shouldInstallSignalHandlers({ VITEST: "true" })).toBe(false);
  expect(shouldInstallSignalHandlers({ NODE_ENV: "test" })).toBe(false);
  // The testnet box runs NODE_ENV=production and must absolutely have them.
  expect(shouldInstallSignalHandlers({ NODE_ENV: "production" })).toBe(true);
  expect(shouldInstallSignalHandlers({})).toBe(true);
});

test("both signals are installed", () => {
  const p = fakeProc();
  installShutdownHandlers({ proc: p.proc, exit: () => undefined });
  expect(p.signals().sort()).toEqual(["SIGINT", "SIGTERM"]);
});

test("shutdown runs in order: stop the sweeper, drain the tasks, close the server, exit", async () => {
  const order: string[] = [];
  const p = fakeProc();
  const shutdown = installShutdownHandlers({
    proc: p.proc,
    sweeper: {
      stop: () => {
        order.push("sweeper.stop");
      },
    },
    tasks: {
      settled: async (ms) => {
        order.push(`tasks.settled(${ms})`);
        return true;
      },
    },
    server: {
      close: (cb) => {
        order.push("server.close");
        cb?.();
      },
    },
    exit: () => {
      order.push("exit");
    },
  });

  await shutdown("SIGTERM");
  expect(order).toEqual([
    // No NEW work may start while we are trying to finish the old.
    "sweeper.stop",
    `tasks.settled(${SHUTDOWN_DRAIN_MS})`,
    "server.close",
    "exit",
  ]);
});

test("a wedged background task cannot hang the deploy — the drain is bounded", async () => {
  const p = fakeProc();
  let exited = false;
  const shutdown = installShutdownHandlers({
    proc: p.proc,
    drainMs: 20,
    // Never drains: the tracker reports the truth and shutdown proceeds anyway.
    tasks: { settled: async () => false },
    server: { close: (cb) => cb?.() },
    exit: () => {
      exited = true;
    },
  });
  await shutdown("SIGTERM");
  expect(exited).toBe(true);
});

test("a keep-alive connection cannot hold the process open forever", async () => {
  const p = fakeProc();
  let exited = false;
  const shutdown = installShutdownHandlers({
    proc: p.proc,
    drainMs: 20,
    // `close` never calls back — an idle browser tab on a keep-alive connection.
    server: { close: () => undefined },
    exit: () => {
      exited = true;
    },
  });
  await shutdown("SIGTERM");
  expect(exited).toBe(true);
});

test("a second signal during a drain is ignored, not a second shutdown", async () => {
  const p = fakeProc();
  let stops = 0;
  let exits = 0;
  installShutdownHandlers({
    proc: p.proc,
    drainMs: 10,
    sweeper: {
      stop: () => {
        stops++;
      },
    },
    tasks: { settled: () => new Promise((r) => setTimeout(() => r(true), 20)) },
    server: { close: (cb) => cb?.() },
    exit: () => {
      exits++;
    },
  });

  // An impatient operator pressing Ctrl-C twice must not be how a half-written transition happens.
  p.fire("SIGTERM");
  p.fire("SIGINT");
  p.fire("SIGTERM");
  await new Promise((r) => setTimeout(r, 60));
  expect(stops).toBe(1);
  expect(exits).toBe(1);
});

test("shutdown works with nothing wired at all (a credential-less deployment)", async () => {
  const p = fakeProc();
  let exited = false;
  const shutdown = installShutdownHandlers({ proc: p.proc, exit: () => (exited = true) });
  await shutdown("SIGINT");
  expect(exited).toBe(true);
});
