import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import { OnboardingRunner } from "../../src/workflow/runner";

/** Tier-0 P1d — custody through the runner: the claim record carries the provider (so a restart
 *  resumes the RIGHT path), and the reconciler is provider-aware (pre-provision circle records
 *  resume; pre-provision turnkey records still fail — their passkey was never persisted). */

const spec = {
  name: "R",
  roles: { manager: "0x000000000000000000000000000000000000aAaa" },
} as unknown as AgentSpec;
const passkey = { attestation: { credentialId: "cred-1" } } as never;

let db: Database.Database;
let repo: SqliteEntityRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

const CAPS = { perCall: 25_000_000n, perTenantTotal: 100_000_000n };

test("start claims the record WITH its custody provider, and passes custody to the saga", async () => {
  const runSaga = vi.fn(async (i: { idempotencyKey: string }) => {
    return repo.findByIdempotencyKey(i.idempotencyKey)!;
  });
  const runner = new OnboardingRunner({ repo, runSaga, fundCaps: CAPS });
  runner.start({
    spec,
    userKey: "k1",
    tenantId: "0xT",
    guardianPasskey: passkey,
    custody: "circle",
  });
  // The CLAIM row (written before any side effect) already carries the provider.
  expect(repo.findByIdempotencyKey("0xT:k1")?.walletProvider).toBe("circle");
  await runner.settled();
  expect(runSaga.mock.calls[0]![0]).toMatchObject({ custody: "circle" });
});

test("reconcile: pre-provision circle records resume; pre-provision turnkey records fail", async () => {
  const runSaga = vi.fn(async (i: { idempotencyKey: string }) => {
    return repo.findByIdempotencyKey(i.idempotencyKey)!;
  });
  const runner = new OnboardingRunner({ repo, runSaga, fundCaps: CAPS });
  // Claim two pending pre-provision rows (as a crash right after start would leave them).
  runner.start({
    spec,
    userKey: "c",
    tenantId: "0xT",
    guardianPasskey: passkey,
    custody: "circle",
  });
  runner.start({
    spec,
    userKey: "t",
    tenantId: "0xT",
    guardianPasskey: passkey,
    custody: "turnkey",
  });
  await runner.settled();
  // Reset both to pending pre-provision state (simulating the crash) and reconcile with a FRESH
  // runner (fresh inFlight set).
  for (const k of ["0xT:c", "0xT:t"]) {
    const r = repo.findByIdempotencyKey(k)!;
    repo.upsert({ ...r, status: "pending", turnkeySubOrgId: undefined });
  }
  const runSaga2 = vi.fn(async (i: { idempotencyKey: string }) => {
    return repo.findByIdempotencyKey(i.idempotencyKey)!;
  });
  const runner2 = new OnboardingRunner({ repo, runSaga: runSaga2, fundCaps: CAPS });
  const resumed = runner2.reconcileInFlight();
  await runner2.settled();

  expect(resumed).toBe(1); // only the circle record
  expect(
    runSaga2.mock.calls.map((c) => (c[0] as { idempotencyKey: string }).idempotencyKey),
  ).toEqual(["0xT:c"]);
  // The turnkey record failed with the named pre-provision reason.
  const t = repo.findByIdempotencyKey("0xT:t")!;
  expect(t.status).toBe("failed");
  expect(t.error).toMatch(/interrupted before provisioning/);
});

test("reconcile: a circle record that crashed POST-provisioning (created) also resumes", async () => {
  const runSaga = vi.fn(async (i: { idempotencyKey: string }) => {
    return repo.findByIdempotencyKey(i.idempotencyKey)!;
  });
  const runner = new OnboardingRunner({ repo, runSaga, fundCaps: CAPS });
  runner.start({
    spec,
    userKey: "c2",
    tenantId: "0xT",
    guardianPasskey: passkey,
    custody: "circle",
  });
  await runner.settled();
  const r = repo.findByIdempotencyKey("0xT:c2")!;
  repo.upsert({
    ...r,
    status: "created",
    circleOperatorWalletId: "op-w",
    circlePocketWalletId: "pk-w",
    pocketAddress: "0xpocket",
  });
  const runSaga2 = vi.fn(async (i: { idempotencyKey: string }) => {
    return repo.findByIdempotencyKey(i.idempotencyKey)!;
  });
  const runner2 = new OnboardingRunner({ repo, runSaga: runSaga2, fundCaps: CAPS });
  expect(runner2.reconcileInFlight()).toBe(1);
  await runner2.settled();
  expect(runSaga2).toHaveBeenCalledTimes(1);
});
