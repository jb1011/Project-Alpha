import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SqliteAgentRunStore } from "../../src/persistence/agentRunStore";
import { migrate, openDatabase } from "../../src/persistence/db";

let db: Database.Database;
let store: SqliteAgentRunStore;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqliteAgentRunStore(db);
});
afterEach(() => db.close());

test("record persists a run + its payments; listByEntity returns them nested", () => {
  const id = store.record(
    {
      entityKey: "t:agent1",
      query: "USDC flows on Arc?",
      cost: "80000",
      revenue: "120000",
      pnl: "40000",
      status: "completed",
    },
    [
      {
        direction: "buy",
        counterparty: "0xVendor",
        amount: "50000",
        transferId: "tr-1",
        status: "settled",
      },
      {
        direction: "buy",
        counterparty: "0xVendor",
        amount: "30000",
        transferId: "tr-2",
        status: "settled",
      },
      {
        direction: "sell",
        counterparty: "0xCustomer",
        amount: "120000",
        transferId: "tr-3",
        status: "settled",
      },
    ],
  );
  expect(typeof id).toBe("string");
  const runs = store.listByEntity("t:agent1");
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({
    id,
    query: "USDC flows on Arc?",
    cost: "80000",
    revenue: "120000",
    pnl: "40000",
    status: "completed",
  });
  expect(runs[0]!.payments).toHaveLength(3);
  expect(runs[0]!.payments.filter((p) => p.direction === "buy")).toHaveLength(2);
  expect(runs[0]!.payments.find((p) => p.direction === "sell")?.amount).toBe("120000");
});

test("listByEntity is scoped to the entity and newest-first", () => {
  store.record(
    { entityKey: "t:a", query: "q1", cost: "1", revenue: "2", pnl: "1", status: "completed" },
    [],
  );
  store.record(
    { entityKey: "t:b", query: "other", cost: "1", revenue: "1", pnl: "0", status: "completed" },
    [],
  );
  store.record(
    { entityKey: "t:a", query: "q2", cost: "1", revenue: "3", pnl: "2", status: "completed" },
    [],
  );
  const a = store.listByEntity("t:a");
  expect(a.map((r) => r.query)).toEqual(["q2", "q1"]);
});
