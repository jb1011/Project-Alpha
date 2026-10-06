/**
 * Shutdown with more than one sweeper: the single `sweeper` it always took and the list beside it
 * are all stopped first, before the drain, so no new work starts while the old is finishing. The
 * composition root hands it the formation sweeper and the legal-body sweeper, and starts the
 * legal-body sweeper only after the socket is listening.
 *
 * Everything is injected: the one thing a test of shutdown code must not do is shut the test
 * runner down.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type SignalSource, installShutdownHandlers } from "../../src/api/shutdown";
import { LegalBodySweeper } from "../../src/legalBody/sweeper";
import { migrate, openDatabase } from "../../src/persistence/db";
import { legalBodyOrderDeps, openLegalBodyStores } from "../helpers/legalBodyFixtures";

/** A stand-in for `process` that never receives a real signal. */
const fakeProc: SignalSource = { on: () => fakeProc };

beforeEach(() => {
  // Shutdown writes its own ops lines; none of them is what these tests read.
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("shutdown stops the single sweeper and every sweeper in the list, all before the drain", async () => {
  const order: string[] = [];
  const shutdown = installShutdownHandlers({
    proc: fakeProc,
    sweeper: { stop: () => void order.push("sweeper.stop") },
    sweepers: [
      { stop: () => void order.push("sweepers[0].stop") },
      { stop: () => void order.push("sweepers[1].stop") },
    ],
    drainMs: 5,
    tasks: {
      settled: async () => {
        order.push("tasks.settled");
        return true;
      },
    },
    server: {
      close: (cb) => {
        order.push("server.close");
        cb?.();
      },
    },
    exit: () => void order.push("exit"),
  });

  await shutdown("SIGTERM");

  expect(order).toEqual([
    "sweeper.stop",
    "sweepers[0].stop",
    "sweepers[1].stop",
    "tasks.settled",
    "server.close",
    "exit",
  ]);
});

test("shutdown stops both the formation sweeper and a running legal-body sweeper, which ticks no more", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const db = openDatabase(":memory:");
  try {
    migrate(db);
    // No order in the database: a tick lists nothing and never reads the chain.
    const legalBodySweeper = new LegalBodySweeper({
      ...legalBodyOrderDeps(openLegalBodyStores(db)),
      intervalMs: 30_000,
      maxPerTick: 5,
      housekeeping: { expireEvidence: () => 0, expireStaleCompanies: () => 0 },
    });
    const ticks = vi.spyOn(legalBodySweeper, "tick");
    const formationSweeper = { stop: vi.fn() };
    let exited = false;
    const shutdown = installShutdownHandlers({
      proc: fakeProc,
      sweeper: formationSweeper,
      sweepers: [legalBodySweeper],
      exit: () => {
        exited = true;
      },
    });

    legalBodySweeper.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ticks).toHaveBeenCalledTimes(2);

    await shutdown("SIGINT");
    await vi.advanceTimersByTimeAsync(5 * 30_000);

    expect(formationSweeper.stop).toHaveBeenCalledTimes(1);
    expect(ticks).toHaveBeenCalledTimes(2);
    expect(exited).toBe(true);
  } finally {
    db.close();
  }
});

/**
 * The composition root boots against a chain and has no injectable seam for its own wiring, so
 * this reads the file, as the boot-order guard does. What it protects: the legal-body sweeper
 * exists only where the feature is on (the order doors' dependencies exist), runs the customer
 * companies' two expiry calls with the file store (which can delete) and the legal-body store's
 * open-body read and IMMEDIATE transaction, starts after `serve()` with nothing awaiting it, and
 * is stopped by shutdown beside the formation sweeper.
 */
test("the composition root builds the legal-body sweeper only with the feature, starts it after serve(), and hands it to shutdown beside the formation sweeper", () => {
  const main = readFileSync(join(import.meta.dirname, "..", "..", "src", "api", "main.ts"), "utf8");

  const builtAt = main.indexOf("const legalBodySweeper = legalBodyOrders");
  expect(builtAt, "the legal-body sweeper was not found").toBeGreaterThan(0);
  const built = main.slice(builtAt, main.indexOf(": undefined;", builtAt));
  expect(built).toMatch(/\? new LegalBodySweeper\(\{\n\s+\.\.\.legalBodyOrders,/);
  expect(built).toMatch(/maxPerTick: LEGAL_BODY_SWEEP_MAX_PER_TICK,/);
  expect(built).toMatch(/intervalMs: legalBodySweepMs,/);
  expect(main).toMatch(
    /^ {2}const legalBodySweepMs = cfg\.legalBodySweepIntervalMs \?\? DEFAULT_LEGAL_BODY_SWEEP_INTERVAL_MS;$/m,
  );
  expect(built).toMatch(
    /expireEvidence: \(\) =>\s+expireEvidenceBytes\(\{ documents: formationDocuments, docStore \}, HOUSEKEEPING_BATCH\),/,
  );
  expect(built).toMatch(/expireStaleCompanies: \(\) =>\s+expireStaleCustomerCompanies\(/);
  expect(built).toMatch(
    /hasOpenLegalBody: \(companyId: string\) =>\s+legalBodyOrders\.repo\.hasOpenForCompany\(companyId, Date\.now\(\)\),/,
  );
  expect(built).toMatch(
    /transaction: <T>\(fn: \(\) => T\) => legalBodyOrders\.repo\.transaction\(fn\),/,
  );
  expect(built).toMatch(/\},\n\s+HOUSEKEEPING_BATCH,\n\s+\),/);
  // The file store the document routes read, which can delete.
  expect(main).toMatch(/^ {2}const docStore = new FileDocumentStore\(cfg\.docStoreDir\);$/m);

  const serveAt = main.indexOf("serve({ fetch: app.fetch");
  const startAt = main.indexOf("legalBodySweeper.start()");
  expect(serveAt, "serve() call not found").toBeGreaterThan(0);
  expect(startAt, "the legal-body sweeper's start not found").toBeGreaterThan(serveAt);
  expect(main).not.toMatch(/await\s+legalBodySweeper/);

  expect(main).toMatch(
    /installShutdownHandlers\(\{\n\s+sweeper: formationSweeper,\n\s+sweepers: legalBodySweeper \? \[legalBodySweeper\] : \[\],/,
  );
});
