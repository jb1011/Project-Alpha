import Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, expect, test } from "vitest";
import { derivePocketKey } from "../../src/adapters/x402/pocketDerivation";
import { migrate } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { assertCircleCoverage, backfillPocketAddresses } from "../../src/persistence/tier0";
import type { Hex } from "../../src/types";

const SEED = `0x${"ab".repeat(32)}` as Hex;

let db: Database.Database;
let repo: SqliteEntityRepository;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});

function seed(key: string, over: Record<string, unknown> = {}) {
  repo.upsert({
    idempotencyKey: key,
    name: key,
    status: "bound",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: "0x000000000000000000000000000000000000000B",
    operator: "0x000000000000000000000000000000000000000C",
    amendmentDelay: "0",
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
    ownerTenantId: "0xT",
    ...over,
  } as never);
}

test("backfill stores the derived pocket address once, marker-guarded (turnkey agents too)", () => {
  seed("t:a1");
  seed("t:a2");
  const n = backfillPocketAddresses(db, SEED);
  expect(n).toBe(2);
  const expected = privateKeyToAccount(derivePocketKey(SEED, "t:a1")).address;
  expect(repo.findByIdempotencyKey("t:a1")?.pocketAddress).toBe(expected);
  // marker-guarded: a re-run touches nothing (even for rows added after — deliberate: new rows
  // get their address at creation, the backfill is a one-shot for the pre-Tier-0 fleet)
  seed("t:a3");
  expect(backfillPocketAddresses(db, SEED)).toBe(0);
});

test("fail-closed boot: circle-path agents present but no circle config -> refuses", () => {
  seed("t:c1", { walletProvider: "circle" });
  expect(() => assertCircleCoverage(db, undefined)).toThrow(/circle/i);
  expect(() => assertCircleCoverage(db, { apiKey: "k", entitySecret: "s" })).not.toThrow();
});

test("fail-closed boot: turnkey-only fleet needs no circle config", () => {
  seed("t:t1");
  expect(() => assertCircleCoverage(db, undefined)).not.toThrow();
});
