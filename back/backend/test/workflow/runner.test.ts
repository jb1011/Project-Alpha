import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import type { EntityRecord } from "../../src/types";
import { OnboardingRunner } from "../../src/workflow/runner";

const TENANT = "0x000000000000000000000000000000000000aAaa";
const spec = {
  name: "Demo",
  roles: { manager: "0x00000000000000000000000000000000000000Ma", guardian: TENANT },
} as unknown as AgentSpec;
const passkey = { challenge: "c", attestation: {} } as never;

let db: Database.Database;
let repo: SqliteEntityRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

// A fake saga that drives the persisted record to `bound` (mirrors what the real saga upserts).
const runSaga = async (i: {
  idempotencyKey: string;
  tenantId: string;
  specJson: string;
}): Promise<EntityRecord> => {
  const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
  const bound: EntityRecord = {
    ...cur,
    status: "bound" as const,
    agentId: "5",
    treasury: "0x00000000000000000000000000000000000000Fe" as `0x${string}`,
  };
  repo.upsert(bound);
  return bound;
};

test("start persists a pending record immediately and returns its id", () => {
  const runner = new OnboardingRunner({ repo, runSaga });
  const { id, status } = runner.start({
    spec,
    userKey: "Demo",
    tenantId: TENANT,
    guardianPasskey: passkey,
  });
  expect(id).toBe(`${TENANT}:Demo`);
  expect(status).toBe("pending");
  const row = repo.findByIdempotencyKey(id)!;
  expect(row.ownerTenantId).toBe(TENANT);
  expect(row.status).toBe("pending");
  expect(row.specJson).toContain("Demo");
});

test("background saga drives the record to bound", async () => {
  const runner = new OnboardingRunner({ repo, runSaga });
  const { id } = runner.start({
    spec,
    userKey: "Demo",
    tenantId: TENANT,
    guardianPasskey: passkey,
  });
  await runner.settled();
  expect(repo.findByIdempotencyKey(id)?.status).toBe("bound");
});

test("a failing saga marks the record failed with the error", async () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async () => {
      throw new Error("provision blew up");
    },
  });
  const { id } = runner.start({
    spec,
    userKey: "Demo",
    tenantId: TENANT,
    guardianPasskey: passkey,
  });
  await runner.settled();
  const row = repo.findByIdempotencyKey(id)!;
  expect(row.status).toBe("failed");
  expect(row.error).toBe("provision blew up");
});

test("starting an already in-flight key is a 409 conflict", () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i) => repo.findByIdempotencyKey(i.idempotencyKey)!,
  });
  runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey });
  expect(() =>
    runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey }),
  ).toThrowError(expect.objectContaining({ status: 409 }));
});

test("two tenants may reuse the same userKey", () => {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i) => repo.findByIdempotencyKey(i.idempotencyKey)!,
  });
  const a = runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey });
  const b = runner.start({
    spec,
    userKey: "Demo",
    tenantId: "0x000000000000000000000000000000000000bBbb",
    guardianPasskey: passkey,
  });
  expect(a.id).not.toBe(b.id);
});

test("reconcileInFlight resumes a record stuck at created (subOrgId present)", async () => {
  // Seed a crashed-mid-flight record: created, with a sub-org id, and persisted spec.
  repo.upsert({
    idempotencyKey: `${TENANT}:Resume`,
    name: "Resume",
    status: "created",
    ownerTenantId: TENANT,
    manager: "0x00000000000000000000000000000000000000Ma",
    guardian: TENANT,
    operator: "0x00000000000000000000000000000000000000Op",
    amendmentDelay: "3600",
    ein: "",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: "5",
    proxy: null,
    treasury: null,
    createTxHash: "0x1",
    bindTxHash: null,
    fundTxHash: null,
    turnkeySubOrgId: "sub_1",
    turnkeyWalletId: "w_1",
    specJson: JSON.stringify(spec),
    error: null,
  });
  const runner = new OnboardingRunner({ repo, runSaga });
  expect(runner.reconcileInFlight()).toBe(1);
  await runner.settled();
  expect(repo.findByIdempotencyKey(`${TENANT}:Resume`)?.status).toBe("bound");
});

test("reconcileInFlight fails a pending record with no sub-org (cannot resume without passkey)", async () => {
  repo.upsert({
    idempotencyKey: `${TENANT}:Stuck`,
    name: "Stuck",
    status: "pending",
    ownerTenantId: TENANT,
    manager: "0x00000000000000000000000000000000000000Ma",
    guardian: TENANT,
    operator: null,
    amendmentDelay: "3600",
    ein: "",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: null,
    proxy: null,
    treasury: null,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    specJson: JSON.stringify(spec),
    error: null,
  });
  const runner = new OnboardingRunner({ repo, runSaga });
  runner.reconcileInFlight();
  await runner.settled();
  expect(repo.findByIdempotencyKey(`${TENANT}:Stuck`)?.status).toBe("failed");
});
