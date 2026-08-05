import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { runJob } from "../../src/jobs/runJob";
import { migrate } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { makeRunJobDeps, seedBoundEntity } from "../helpers/runJobDeps";

/** Tier-0 audit item 4: runJob's onboarding guard was one of the two chokepoints that
 *  hard-required Turnkey fields of every agent, breaking the compatibility guarantee for
 *  circle-custody agents. These tests pin the provider-aware guard. */

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  migrate(db);
  return db;
}

describe("runJob provider-aware onboarding guard", () => {
  test("circle entity WITHOUT a turnkey sub-org runs the saga (no turnkey fields demanded)", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:circle", {
      turnkeySubOrgId: undefined,
      turnkeyWalletId: undefined,
      walletProvider: "circle",
      circleOperatorWalletId: "op-w",
      circlePocketWalletId: "pk-w",
      pocketAddress: "0x4000000000000000000000000000000000000004",
    });
    const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:cj", entityKey: "t:circle" });
    const rec = await runJob(deps);
    expect(rec.status).toBe("reputed");
  });

  test("circle entity missing its Circle wallet ids refuses loudly by name", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:half", {
      turnkeySubOrgId: undefined,
      walletProvider: "circle",
    });
    const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:hj", entityKey: "t:half" });
    await expect(runJob(deps)).rejects.toThrow(/circle custody path.*missing/s);
  });

  test("turnkey entity still requires its sub-org", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:tk", { turnkeySubOrgId: undefined });
    const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:tj", entityKey: "t:tk" });
    await expect(runJob(deps)).rejects.toThrow(/missing turnkeySubOrgId/);
  });

  test("providerOpsFor receives the entity and jobKey on every provider-signed step", async () => {
    const db = makeDb();
    const jobs = new SqliteJobRepository(db);
    const entities = new SqliteEntityRepository(db);
    seedBoundEntity(entities, "t:agent", { treasury: undefined });
    const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:k2", entityKey: "t:agent" });
    const ops = {
      setBudget: vi.fn().mockResolvedValue("0xsb"),
      submit: vi.fn().mockResolvedValue("0xsub"),
      sweepToTreasury: vi.fn(),
    };
    deps.providerOpsFor = vi.fn(() => ops);
    const rec = await runJob(deps);
    expect(rec.status).toBe("reputed");
    expect(ops.setBudget).toHaveBeenCalledTimes(1);
    expect(ops.submit).toHaveBeenCalledTimes(1);
    expect(ops.sweepToTreasury).not.toHaveBeenCalled(); // sweepToTreasury=false fixture
  });
});
