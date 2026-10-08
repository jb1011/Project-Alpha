/**
 * The statement log: one row for each distinct set of claims signed about a legal body, with the
 * attestor that signed them. Append-only, in a table of its own that references `legal_bodies`
 * from outside the legal-body schema step.
 *
 * Every address is a placeholder or one of anvil's published test accounts, and every company is
 * an invention.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { type Address, getAddress, zeroAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { type Deployment, LegalBodyInputError } from "../../src/persistence/legalBodyRepository";
import {
  type NewStatementRecord,
  SqliteLegalBodyStatementRepository,
  type StatementEvidence,
} from "../../src/persistence/legalBodyStatementRepository";
import { ANVIL_ACCOUNT_2, CHAIN_ID, FACTORY } from "../helpers/customerCompanyFixtures";
import {
  H,
  type LegalBodyStores,
  OTHER_FACTORY,
  customerCompany,
  openLegalBodyStores,
} from "../helpers/legalBodyFixtures";

/** Placeholders whose checksummed spelling differs from their lower-case one. */
const WALLET = getAddress("0x00000000000000000000000000000000000a11e7");
const OTHER_WALLET = getAddress("0x00000000000000000000000000000000000a11e8");
const ATTESTOR = getAddress("0x00000000000000000000000000000000000a7e58");
const NEXT_ATTESTOR = getAddress("0x00000000000000000000000000000000000a7e59");
/** When the first statement was issued, in unix seconds. */
const ISSUED_AT = 1_800_000_000;
const DEPLOYMENT: Deployment = { chainId: CHAIN_ID, factory: FACTORY };
const EVIDENCE: StatementEvidence = {
  checkId: 1,
  revocationEventId: null,
  companyStatus: "ready",
  humanVerified: true,
};

let db: Database.Database;
let stores: LegalBodyStores;
let log: SqliteLegalBodyStatementRepository;
let companyId: string;
/** Two legal bodies of one company, on the deployment above. */
let bodyId: string;
let otherBodyId: string;

/** A new legal body, a draft, of the company above: on the deployment above unless told otherwise. */
function newBody(over: Partial<Deployment> = {}): string {
  return stores.repo.create({
    tenantId: ANVIL_ACCOUNT_2.address,
    companyId,
    ...DEPLOYMENT,
    ...over,
    amendmentDelay: 172_800,
  }).legalBodyId;
}

/** A legal body of a new company, in another database. */
function bodyIn(other: Database.Database): string {
  const s = openLegalBodyStores(other);
  return s.repo.create({
    tenantId: ANVIL_ACCOUNT_2.address,
    companyId: customerCompany(s, ANVIL_ACCOUNT_2.address),
    ...DEPLOYMENT,
    amendmentDelay: 172_800,
  }).legalBodyId;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  stores = openLegalBodyStores(db);
  log = new SqliteLegalBodyStatementRepository(db);
  companyId = customerCompany(stores, ANVIL_ACCOUNT_2.address);
  bodyId = newBody();
  otherBodyId = newBody();
});
afterEach(() => db.close());

/** A statement about the first body, with the claims hash `H("a")`, unless told otherwise. */
function record(over: Partial<NewStatementRecord> = {}): NewStatementRecord {
  return {
    legalBodyId: bodyId,
    chainId: CHAIN_ID,
    factory: FACTORY,
    agentId: "42",
    agentWallet: WALLET,
    attestor: ATTESTOR,
    standing: "active",
    claimsHash: H("a"),
    observedAtBlock: 100,
    issuedAt: ISSUED_AT,
    evidence: EVIDENCE,
    ...over,
  };
}

const rowCount = () => db.prepare("SELECT COUNT(*) FROM statement_log").pluck().get() as number;
const allRows = () => db.prepare("SELECT * FROM statement_log ORDER BY id").all();

test("the placeholders' checksummed and lower-case spellings differ, so the casing cases below compare two spellings", () => {
  for (const address of [WALLET, OTHER_WALLET, ATTESTOR, NEXT_ATTESTOR, FACTORY])
    expect(address, address).not.toBe(address.toLowerCase());
});

describe("appendIfChanged", () => {
  test("the first row is inserted; identical claims are not; changed claims are; a changed attestor is", () => {
    expect(log.appendIfChanged(record())).toBe(true);
    // The same claims, signed again at a later block and time: no row, and the row keeps the
    // block and the time of the first statement with these claims.
    expect(log.appendIfChanged(record({ observedAtBlock: 160, issuedAt: ISSUED_AT + 120 }))).toBe(
      false,
    );
    expect(rowCount()).toBe(1);
    expect(log.latest(bodyId)).toMatchObject({ id: 1, observedAtBlock: 100, issuedAt: ISSUED_AT });

    // Changed claims.
    expect(log.appendIfChanged(record({ claimsHash: H("b"), standing: "inactive" }))).toBe(true);
    // The same claims, signed with another key.
    expect(log.appendIfChanged(record({ claimsHash: H("b"), attestor: NEXT_ATTESTOR }))).toBe(true);
    expect(log.latest(bodyId)).toMatchObject({
      id: 3,
      claimsHash: H("b"),
      attestor: NEXT_ATTESTOR,
    });
    // The hash and the attestor are each compared in any letter case.
    expect(
      log.appendIfChanged(
        record({ claimsHash: H("B"), attestor: NEXT_ATTESTOR.toLowerCase() as Address }),
      ),
    ).toBe(false);
    // Claims seen before, but not in the latest row: a row.
    expect(log.appendIfChanged(record({ attestor: NEXT_ATTESTOR }))).toBe(true);
    expect(rowCount()).toBe(4);

    // Each body is compared with its own latest row.
    expect(log.latest(otherBodyId)).toBeUndefined();
    expect(log.appendIfChanged(record({ legalBodyId: otherBodyId, attestor: NEXT_ATTESTOR }))).toBe(
      true,
    );
    expect(log.latest(otherBodyId)?.id).toBe(5);
    expect(log.latest(bodyId)?.id).toBe(4);
    expect(log.latest(`lb_${"9".repeat(36)}`)).toBeUndefined();
  });

  test("a row holds the statement as given: addresses checksummed, the hash in lower case, the agent id canonical", () => {
    expect(
      log.appendIfChanged(
        record({
          factory: FACTORY.toLowerCase() as Address,
          agentId: "042",
          agentWallet: WALLET.toLowerCase() as Address,
          attestor: ATTESTOR.toLowerCase() as Address,
          standing: "pending",
          claimsHash: H("C"),
        }),
      ),
    ).toBe(true);
    expect(log.latest(bodyId)).toEqual({
      id: 1,
      legalBodyId: bodyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      agentId: "42",
      agentWallet: WALLET,
      attestor: ATTESTOR,
      standing: "pending",
      claimsHash: H("c"),
      observedAtBlock: 100,
      issuedAt: ISSUED_AT,
      evidence: EVIDENCE,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
    });
  });

  test("the evidence round-trips with numbers as numbers, stored as exactly its four fields", () => {
    // A wider object, its keys in another order: only the four fields are stored, in one order.
    const wider = {
      humanVerified: false,
      companyName: "Example Holdings LLC",
      filingNumber: "TEST-0001",
      companyStatus: "draft",
      revocationEventId: 3,
      checkId: 12,
    };
    expect(log.appendIfChanged(record({ evidence: wider as unknown as StatementEvidence }))).toBe(
      true,
    );
    expect(db.prepare("SELECT evidence FROM statement_log").pluck().get()).toBe(
      '{"checkId":12,"revocationEventId":3,"companyStatus":"draft","humanVerified":false}',
    );
    const evidence = log.latest(bodyId)?.evidence;
    expect(evidence).toEqual({
      checkId: 12,
      revocationEventId: 3,
      companyStatus: "draft",
      humanVerified: false,
    });
    expect(typeof evidence?.checkId).toBe("number");
    expect(typeof evidence?.revocationEventId).toBe("number");

    // No passed check and no revocation: nulls, kept as nulls.
    const none: StatementEvidence = {
      checkId: null,
      revocationEventId: null,
      companyStatus: "abandoned",
      humanVerified: true,
    };
    expect(log.appendIfChanged(record({ legalBodyId: otherBodyId, evidence: none }))).toBe(true);
    expect(log.latest(otherBodyId)?.evidence).toEqual(none);
  });

  test("evidence that is not ids, enums and booleans is refused before anything is written", () => {
    const bad: unknown[] = [
      null,
      "ready",
      [],
      { ...EVIDENCE, checkId: "1" },
      { ...EVIDENCE, checkId: 0 },
      { ...EVIDENCE, checkId: 1.5 },
      { ...EVIDENCE, checkId: undefined },
      { ...EVIDENCE, revocationEventId: -1 },
      { ...EVIDENCE, revocationEventId: Number.MAX_SAFE_INTEGER + 1 },
      { ...EVIDENCE, companyStatus: "active" },
      { ...EVIDENCE, companyStatus: "Ready" },
      { ...EVIDENCE, humanVerified: "true" },
      { ...EVIDENCE, humanVerified: 1 },
      { ...EVIDENCE, humanVerified: null },
    ];
    for (const evidence of bad)
      expect(
        () => log.appendIfChanged(record({ evidence: evidence as StatementEvidence })),
        JSON.stringify(evidence),
      ).toThrow(LegalBodyInputError);
    expect(rowCount()).toBe(0);
  });

  test("a statement no row may hold is refused before anything is written", () => {
    const bad: [string, Record<string, unknown>][] = [
      ["a chain id of zero", { chainId: 0 }],
      ["a fractional chain id", { chainId: 1.5 }],
      ["a chain id as text", { chainId: String(CHAIN_ID) }],
      ["a factory that is not an address", { factory: "0x1234" }],
      ["an agent id that is a number", { agentId: 42 }],
      ["an agent id that is not decimal", { agentId: "4a" }],
      ["an empty agent id", { agentId: "" }],
      ["an agent id past a uint256", { agentId: (2n ** 256n).toString() }],
      ["a wallet that is not an address", { agentWallet: "wallet" }],
      ["an attestor that is not an address", { attestor: `0x${"g".repeat(40)}` }],
      ["a standing outside the four", { standing: "good" }],
      ["a claims hash that is too short", { claimsHash: "0x1234" }],
      ["a claims hash that is not hex", { claimsHash: `0x${"z".repeat(64)}` }],
      ["block zero", { observedAtBlock: 0 }],
      ["a fractional block", { observedAtBlock: 100.5 }],
      ["an issue time in milliseconds", { issuedAt: ISSUED_AT * 1000 }],
      ["an issue time of zero", { issuedAt: 0 }],
    ];
    for (const [label, over] of bad)
      expect(() => log.appendIfChanged(record(over as Partial<NewStatementRecord>)), label).toThrow(
        LegalBodyInputError,
      );
    expect(rowCount()).toBe(0);
  });

  test("a row for a body that does not exist is refused by the foreign key", () => {
    expect(() => log.appendIfChanged(record({ legalBodyId: `lb_${"9".repeat(36)}` }))).toThrow(
      /FOREIGN KEY/,
    );
    expect(rowCount()).toBe(0);
  });

  test("the comparison and the insert are one immediate transaction: while another connection writes, even identical claims wait their turn", () => {
    // Two connections to one database file stand for two processes. A transaction that took the
    // write lock only at its insert would read the latest row while another writer could still
    // add one in between.
    const dir = mkdtempSync(join(tmpdir(), "statement-log-"));
    const path = join(dir, "log.db");
    const connections: Database.Database[] = [];
    try {
      const first = openDatabase(path);
      connections.push(first);
      migrate(first);
      const id = bodyIn(first);
      expect(
        new SqliteLegalBodyStatementRepository(first).appendIfChanged(record({ legalBodyId: id })),
      ).toBe(true);
      // The other connection does not wait for a lock: in one thread, nobody could release it.
      const second = new Database(path, { timeout: 0 });
      connections.push(second);
      second.pragma("foreign_keys = ON");
      const other = new SqliteLegalBodyStatementRepository(second);

      first.exec("BEGIN IMMEDIATE");
      expect(() => other.appendIfChanged(record({ legalBodyId: id }))).toThrow(
        /database is locked/,
      );
      first.exec("ROLLBACK");
      expect(other.appendIfChanged(record({ legalBodyId: id }))).toBe(false);
    } finally {
      for (const c of connections) c.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the database guards the log against raw SQL", () => {
  /** A well-formed row of the first body, written around the repository; `over` replaces or adds
   *  columns. */
  function rawInsert(over: Record<string, unknown> = {}, verb = "INSERT") {
    const row: Record<string, unknown> = {
      legal_body_id: bodyId,
      chain_id: CHAIN_ID,
      factory: FACTORY,
      agent_id: "42",
      agent_wallet: WALLET,
      attestor: ATTESTOR,
      standing: "active",
      claims_hash: H("a"),
      observed_at_block: 100,
      issued_at: ISSUED_AT,
      evidence: JSON.stringify(EVIDENCE),
      ...over,
    };
    const columns = Object.keys(row);
    return db
      .prepare(
        `${verb} INTO statement_log (${columns.join(", ")})
         VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
      )
      .run(row);
  }

  test("UPDATE, DELETE and an INSERT over an existing row abort", () => {
    log.appendIfChanged(record());
    const before = allRows();
    expect(() => db.prepare("UPDATE statement_log SET standing = 'inactive'").run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare("DELETE FROM statement_log").run()).toThrow(/append-only/);
    for (const verb of ["INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE", "INSERT"])
      expect(() => rawInsert({ id: 1, standing: "unknown" }, verb), verb).toThrow(/append-only/);
    expect(allRows()).toEqual(before);
  });

  test("an id is positive, and an id written out by hand is at most the next one", () => {
    for (const id of [-1, 0]) expect(() => rawInsert({ id }), String(id)).toThrow(/CHECK/);
    expect(log.appendIfChanged(record())).toBe(true);
    for (const id of [3, 1000])
      for (const verb of ["INSERT", "INSERT OR REPLACE", "INSERT OR IGNORE"])
        expect(() => rawInsert({ id }, verb), `${verb} ${id}`).toThrow(/ids are assigned in order/);
    // The next id may be written out, and appends follow it.
    expect(rawInsert({ id: 2, claims_hash: H("b") }).changes).toBe(1);
    expect(log.appendIfChanged(record())).toBe(true);
    expect(db.prepare("SELECT group_concat(id) FROM statement_log").pluck().get()).toBe("1,2,3");
  });

  test("the table's CHECKs refuse a malformed row", () => {
    expect(rawInsert().changes).toBe(1);
    const bad: [string, Record<string, unknown>][] = [
      ["a chain id of zero", { chain_id: 0 }],
      ["a fractional chain id", { chain_id: 1.5 }],
      ["a chain id as text", { chain_id: "x" }],
      ["a factory that is not an address", { factory: "0x1234" }],
      ["an agent id with a leading zero", { agent_id: "042" }],
      ["an agent id that is not decimal", { agent_id: "4a" }],
      ["an empty agent id", { agent_id: "" }],
      ["an agent id of 79 digits", { agent_id: "1".repeat(79) }],
      ["an agent id as a number", { agent_id: 42 }],
      ["a wallet that is not hex", { agent_wallet: `0x${"g".repeat(40)}` }],
      ["an attestor that is too short", { attestor: "0xabc" }],
      ["a standing outside the four", { standing: "good" }],
      ["a claims hash in upper case", { claims_hash: H("A") }],
      ["a claims hash that is too short", { claims_hash: "0x1234" }],
      ["block zero", { observed_at_block: 0 }],
      ["a fractional block", { observed_at_block: 1.5 }],
      ["an issue time in milliseconds", { issued_at: ISSUED_AT * 1000 }],
      ["an issue time of zero", { issued_at: 0 }],
      ["evidence that is not JSON", { evidence: "{" }],
    ];
    for (const [label, over] of bad) expect(() => rawInsert(over), label).toThrow(/CHECK/);
    expect(rowCount()).toBe(1);
  });
});

describe("agentIdsByWallet", () => {
  test("matches the wallet in any letter case", () => {
    log.appendIfChanged(record({ agentId: "7", agentWallet: WALLET.toLowerCase() as Address }));
    for (const spelling of [WALLET, WALLET.toLowerCase(), `0x${WALLET.slice(2).toUpperCase()}`])
      expect(log.agentIdsByWallet(DEPLOYMENT, spelling as Address, 5), spelling).toEqual(["7"]);
    expect(log.agentIdsByWallet(DEPLOYMENT, OTHER_WALLET, 5)).toEqual([]);
    // A value that is not an address matches nothing.
    expect(log.agentIdsByWallet(DEPLOYMENT, "not an address" as Address, 5)).toEqual([]);
  });

  test("only rows of this deployment count, its factory spelled in any letter case", () => {
    log.appendIfChanged(record({ agentId: "7" }));
    log.appendIfChanged(
      record({
        legalBodyId: newBody({ factory: OTHER_FACTORY }),
        factory: OTHER_FACTORY,
        agentId: "8",
      }),
    );
    log.appendIfChanged(
      record({
        legalBodyId: newBody({ chainId: CHAIN_ID + 1 }),
        chainId: CHAIN_ID + 1,
        agentId: "9",
      }),
    );
    expect(log.agentIdsByWallet(DEPLOYMENT, WALLET, 5)).toEqual(["7"]);
    expect(log.agentIdsByWallet({ chainId: CHAIN_ID, factory: OTHER_FACTORY }, WALLET, 5)).toEqual([
      "8",
    ]);
    expect(log.agentIdsByWallet({ chainId: CHAIN_ID + 1, factory: FACTORY }, WALLET, 5)).toEqual([
      "9",
    ]);
    expect(log.agentIdsByWallet({ chainId: CHAIN_ID + 2, factory: FACTORY }, WALLET, 5)).toEqual(
      [],
    );
    expect(
      log.agentIdsByWallet(
        { chainId: CHAIN_ID, factory: FACTORY.toLowerCase() as Address },
        WALLET,
        5,
      ),
    ).toEqual(["7"]);
    // A deployment no row may hold is a caller's bug.
    for (const d of [
      { chainId: 0, factory: FACTORY },
      { chainId: 1.5, factory: FACTORY },
      { chainId: CHAIN_ID, factory: "0x1234" as Address },
    ])
      expect(() => log.agentIdsByWallet(d, WALLET, 5), JSON.stringify(d)).toThrow(
        LegalBodyInputError,
      );
  });

  test("each agent once, newest first by its newest matching row", () => {
    const thirdBodyId = newBody();
    const append = (legalBodyId: string, agentId: string, claims: string, agentWallet = WALLET) =>
      expect(
        log.appendIfChanged(record({ legalBodyId, agentId, claimsHash: H(claims), agentWallet })),
      ).toBe(true);
    append(bodyId, "7", "1");
    append(otherBodyId, "8", "2");
    append(thirdBodyId, "9", "3");
    expect(log.agentIdsByWallet(DEPLOYMENT, WALLET, 5)).toEqual(["9", "8", "7"]);
    append(bodyId, "7", "4");
    expect(log.agentIdsByWallet(DEPLOYMENT, WALLET, 5)).toEqual(["7", "9", "8"]);
    // Agent 8's newest row records another wallet: it does not move agent 8 up for this one.
    append(otherBodyId, "8", "5", OTHER_WALLET);
    expect(log.agentIdsByWallet(DEPLOYMENT, WALLET, 5)).toEqual(["7", "9", "8"]);
    expect(log.agentIdsByWallet(DEPLOYMENT, OTHER_WALLET, 5)).toEqual(["8"]);
  });

  test("the limit bounds the answer, and is a whole number from 1 to 100", () => {
    for (const [i, legalBodyId] of [bodyId, otherBodyId, newBody()].entries())
      log.appendIfChanged(record({ legalBodyId, agentId: String(10 + i) }));
    expect(log.agentIdsByWallet(DEPLOYMENT, WALLET, 1)).toEqual(["12"]);
    expect(log.agentIdsByWallet(DEPLOYMENT, WALLET, 2)).toEqual(["12", "11"]);
    expect(log.agentIdsByWallet(DEPLOYMENT, WALLET, 100)).toEqual(["12", "11", "10"]);
    for (const limit of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null])
      expect(
        () => log.agentIdsByWallet(DEPLOYMENT, WALLET, limit as number),
        String(limit),
      ).toThrow(LegalBodyInputError);
    // The limit is checked whatever the wallet: one that can match nothing is no way around it.
    expect(() => log.agentIdsByWallet(DEPLOYMENT, zeroAddress, 0)).toThrow(LegalBodyInputError);
  });

  test("the zero address is never returned, though a row records it for an agent with no wallet", () => {
    expect(log.appendIfChanged(record({ agentId: "7", agentWallet: zeroAddress }))).toBe(true);
    expect(log.latest(bodyId)?.agentWallet).toBe(zeroAddress);
    expect(log.agentIdsByWallet(DEPLOYMENT, zeroAddress, 5)).toEqual([]);
  });

  test("the query is served by the wallet index", () => {
    // The query as the repository prepares it.
    const prepare = vi.spyOn(db, "prepare");
    new SqliteLegalBodyStatementRepository(db);
    const query = prepare.mock.calls
      .map(([source]) => source)
      .find((source) => source.includes("lower(agent_wallet)"));
    prepare.mockRestore();
    if (query === undefined) throw new Error("the repository prepared no query by wallet");
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all({ chain_id: CHAIN_ID, factory: FACTORY, wallet: WALLET.toLowerCase(), limit: 5 }) as {
      detail: string;
    }[];
    expect(plan.map((p) => p.detail).join("\n")).toContain("USING INDEX idx_statement_log_wallet");
  });
});

describe("beside the legal-body schema step", () => {
  /** The sha256 that the upgrade test pins schema version 1's legal-body DDL to. */
  const LEGAL_BODIES_DDL_V1_SHA256 =
    "56e84256a0c0d9992d087f1406adf36f4fae9244674e559ed46d3b28dc8237b4";

  /** Schema version 1's legal-body DDL, read from the upgrade test that keeps it as data, and
   *  checked against its pinned hash. */
  function legalBodiesDdlV1(): string {
    // A template literal reads every line break as \n, whatever the file holds.
    const source = readFileSync(
      join(import.meta.dirname, "legalBodySchemaUpgrade.test.ts"),
      "utf8",
    ).replace(/\r\n?/g, "\n");
    const opening = "const LEGAL_BODIES_DDL_V1 = `";
    expect(source).toContain(opening);
    const start = source.indexOf(opening) + opening.length;
    const ddl = source.slice(start, source.indexOf("`", start));
    expect(createHash("sha256").update(ddl).digest("hex")).toBe(LEGAL_BODIES_DDL_V1_SHA256);
    return ddl;
  }

  /**
   * A database as a build at legal-body schema version 1 left it, built as the upgrade test builds
   * one: every other table as this build makes it (the log among them, empty), the legal-body
   * tables from version 1's DDL, and version 1 stored.
   */
  function versionOneDatabase(): Database.Database {
    const v1 = new Database(":memory:");
    v1.pragma("foreign_keys = ON");
    migrate(v1);
    v1.exec("DROP TABLE legal_body_events; DROP TABLE legal_bodies;");
    v1.exec(legalBodiesDdlV1());
    v1.prepare("UPDATE meta SET value = '1' WHERE key = 'legal_bodies_schema_version'").run();
    return v1;
  }

  const LEGAL_BODY_OBJECTS = `SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name IN ('legal_bodies','legal_body_events') AND sql IS NOT NULL ORDER BY type, name`;
  const LOG_OBJECTS = `SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name = 'statement_log' AND sql IS NOT NULL ORDER BY type, name`;
  const storedVersion = (d: Database.Database) =>
    d.prepare("SELECT value FROM meta WHERE key = 'legal_bodies_schema_version'").pluck().get();

  test("migrate creates the log with its two indexes and four triggers, and it references legal_bodies", () => {
    expect(
      (db.prepare(LOG_OBJECTS).all() as { type: string; name: string }[]).map(
        (o) => `${o.type} ${o.name}`,
      ),
    ).toEqual([
      "index idx_statement_log_body",
      "index idx_statement_log_wallet",
      "table statement_log",
      "trigger trg_statement_log_next_id",
      "trigger trg_statement_log_no_delete",
      "trigger trg_statement_log_no_replace",
      "trigger trg_statement_log_no_update",
    ]);
    // The wallet index is partial: it leaves out the zero address.
    expect(db.prepare("PRAGMA index_list(statement_log)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "idx_statement_log_body", partial: 0 }),
        expect.objectContaining({ name: "idx_statement_log_wallet", partial: 1 }),
      ]),
    );
    expect(db.prepare("PRAGMA foreign_key_list(statement_log)").all()).toMatchObject([
      { table: "legal_bodies", from: "legal_body_id", to: "legal_body_id" },
    ]);
  });

  test("a version-1 database with empty legal-body tables still migrates: the step recreates them with the empty log in place, and the log is there afterwards", () => {
    // What this build defines, from the fresh database every test starts with.
    const definedLegalBodies = db.prepare(LEGAL_BODY_OBJECTS).all();
    const definedLog = db.prepare(LOG_OBJECTS).all();

    const v1 = versionOneDatabase();
    try {
      // The log is in place and empty, and its foreign key names the table the step drops.
      expect(v1.prepare(LOG_OBJECTS).all()).toEqual(definedLog);
      expect(v1.prepare("SELECT COUNT(*) FROM statement_log").pluck().get()).toBe(0);
      expect(v1.prepare("PRAGMA foreign_key_list(statement_log)").all()).toMatchObject([
        { table: "legal_bodies" },
      ]);
      expect(v1.prepare(LEGAL_BODY_OBJECTS).all()).not.toEqual(definedLegalBodies);
      expect(storedVersion(v1)).toBe("1");

      migrate(v1);

      expect(v1.prepare(LEGAL_BODY_OBJECTS).all()).toEqual(definedLegalBodies);
      expect(storedVersion(v1)).toBe("2");
      expect(v1.prepare(LOG_OBJECTS).all()).toEqual(definedLog);
      expect(v1.inTransaction).toBe(false);
      // The log works against the tables created again: its foreign key holds them.
      const v1Log = new SqliteLegalBodyStatementRepository(v1);
      expect(v1Log.appendIfChanged(record({ legalBodyId: bodyIn(v1) }))).toBe(true);
      expect(() => v1Log.appendIfChanged(record({ legalBodyId: `lb_${"9".repeat(36)}` }))).toThrow(
        /FOREIGN KEY/,
      );
      expect(v1.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      v1.close();
    }
  });

  test("a second migrate, with rows in the log, changes nothing", () => {
    expect(log.appendIfChanged(record())).toBe(true);
    expect(log.appendIfChanged(record({ legalBodyId: otherBodyId }))).toBe(true);
    const snapshot = () => ({
      schema: db
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all(),
      rows: allRows(),
      meta: db.prepare("SELECT * FROM meta ORDER BY key").all(),
    });
    const before = snapshot();
    migrate(db);
    expect(snapshot()).toEqual(before);
  });
});
