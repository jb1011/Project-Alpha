import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { LiveRunResult } from "../../src/agent/liveRunner";
import { persistAgentRun } from "../../src/agent/persistRun";
import { SqliteAgentRunStore } from "../../src/persistence/agentRunStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

function seedEntity(entityKey: string, treasury: string) {
  const repo = new SqliteEntityRepository(db);
  repo.upsert({
    idempotencyKey: entityKey,
    name: "A",
    status: "funded",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: "0x000000000000000000000000000000000000000A",
    operator: null,
    amendmentDelay: "0",
    ein: "",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: "1",
    proxy: null,
    treasury: treasury as `0x${string}`,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: "t",
  });
}

test("persistAgentRun resolves the entity from the treasury and records the run + payments", () => {
  const TREASURY = "0x000000000000000000000000000000000000000F";
  seedEntity("t:agent1", TREASURY);
  const runs = new SqliteAgentRunStore(db);
  const entities = new SqliteEntityRepository(db);
  const result = {
    totalCost: 80000n,
    price: 120000n,
    pnl: 40000n,
    sold: true,
  } as unknown as LiveRunResult;
  const id = persistAgentRun({ runs, entities }, TREASURY, "q", result, [
    {
      direction: "buy",
      counterparty: "0xVendor",
      amount: "80000",
      transferId: "tr-1",
      status: "settled",
    },
    {
      direction: "sell",
      counterparty: "0xCustomer",
      amount: "120000",
      transferId: "tr-2",
      status: "settled",
    },
  ]);
  expect(typeof id).toBe("string");
  const got = runs.listByEntity("t:agent1");
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({
    cost: "80000",
    revenue: "120000",
    pnl: "40000",
    status: "completed",
  });
  expect(got[0]!.payments).toHaveLength(2);
});

test("persistAgentRun falls back to the treasury address as entityKey when no entity matches", () => {
  const runs = new SqliteAgentRunStore(db);
  const entities = new SqliteEntityRepository(db);
  const result = { totalCost: 1n, price: 2n, pnl: 1n, sold: true } as unknown as LiveRunResult;
  persistAgentRun({ runs, entities }, "0xUnknownTreasury", "q", result, []);
  expect(runs.listByEntity("0xUnknownTreasury")).toHaveLength(1);
});
