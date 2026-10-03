import Database from "better-sqlite3";
import { type Hex, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type NewCompanyDeclaration,
  SqliteCompanyDeclarationRepository,
  filingKeyOf,
} from "../../src/persistence/companyDeclarationRepository";
import {
  type CompanyStatus,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate } from "../../src/persistence/db";
import { sqliteUtcTimestamp } from "../../src/util/sqliteTime";

const TENANT_A = getAddress("0x00000000000000000000000000000000000000a1");
const TENANT_B = getAddress("0x00000000000000000000000000000000000000b2");
const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
/** A 32-byte value: one byte, written as two hex digits, repeated. */
const H = (byte: string) => `0x${byte.repeat(32)}` as Hex;
const SIGNATURE = `0x${"1b".repeat(65)}` as Hex;
const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

let db: Database.Database;
let declarations: SqliteCompanyDeclarationRepository;
let companies: SqliteCompanyRepository;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  companies = new SqliteCompanyRepository(db);
});
afterEach(() => db.close());

function declaration(over: Partial<NewCompanyDeclaration> = {}): NewCompanyDeclaration {
  return {
    companyId: "co_1",
    tenantId: TENANT_A,
    humanNullifier: "nullifier-0001",
    declarantName: "Ada Example",
    declarantTitle: "Manager",
    statementText: "Example statement of authority, written for tests.",
    statementHash: H("a1"),
    statementDigest: H("d1"),
    signature: SIGNATURE,
    companyName: "Example Holdings LLC",
    jurisdiction: "WY",
    filingNumber: "TEST-0001",
    wordingVersion: "1",
    chainId: 5042002,
    factory: FACTORY,
    issuedAt: 1_790_000_000,
    synthetic: false,
    ...over,
  };
}

/** A customer company, created as the application creates one, then moved to `status`. */
function company(companyId: string, status: CompanyStatus = "draft", tenantId: string = TENANT_A) {
  companies.create({
    companyId,
    tenantId,
    status: "draft",
    provider: "customer",
    environment: "sandbox",
    synthetic: false,
    nameOptions: [{ name: "Example Holdings", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "placeholder",
    industryLabel: "placeholder",
    intakeSynthesized: false,
  });
  if (status !== "draft") expect(companies.setStatus(companyId, "draft", status)).toBe(true);
}

const abandon = (companyId: string) =>
  expect(companies.setStatus(companyId, "draft", "abandoned")).toBe(true);

const rowsOf = () =>
  db.prepare("SELECT rowid, * FROM company_declarations ORDER BY rowid").all() as Record<
    string,
    unknown
  >[];

/** Every column of a declaration as raw SQL writes it, for the statements the repository never makes. */
function rawRow(companyId: string, digest: Hex, extra: Record<string, unknown> = {}) {
  return {
    company_id: companyId,
    tenant_id: TENANT_A,
    human_nullifier: "nullifier-0001",
    declarant_name: "Ada Example",
    declarant_title: "Manager",
    statement_text: "Example statement of authority, written for tests.",
    statement_hash: H("a1"),
    statement_digest: digest,
    signature: SIGNATURE,
    company_name: "Example Holdings LLC",
    jurisdiction: "WY",
    filing_number: "TEST-0001",
    filing_key: "TEST0001",
    wording_version: "1",
    chain_id: 5042002,
    factory: FACTORY,
    issued_at: 1_790_000_000,
    synthetic: 0,
    ...extra,
  };
}
function rawInsert(row: Record<string, unknown>, verb = "INSERT", tail = "") {
  const columns = Object.keys(row);
  return db
    .prepare(
      `${verb} INTO company_declarations (${columns.join(", ")})
       VALUES (${columns.map((c) => `@${c}`).join(", ")}) ${tail}`,
    )
    .run(row);
}

/** The erasure as one raw statement: the six personal columns cleared, the time stamped. */
const RAW_ERASE = `UPDATE company_declarations
  SET declarant_name = NULL, declarant_title = NULL, statement_text = NULL,
      statement_hash = NULL, statement_digest = NULL, signature = NULL, pii_erased_at = 1790000500
  WHERE company_id = 'co_1'`;

describe("the schema", () => {
  const OBJECTS = `SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name IN ('company_declarations', 'company_checks') AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name`;
  const objects = () => db.prepare(OBJECTS).all() as { type: string; name: string; sql: string }[];
  const named = (type: string) =>
    objects()
      .filter((o) => o.type === type)
      .map((o) => o.name);

  test("migrate creates both tables with their indexes and triggers, and a second migrate changes nothing", () => {
    expect(named("table")).toEqual(["company_checks", "company_declarations"]);
    expect(named("index")).toEqual([
      "idx_company_checks_company",
      "idx_company_checks_filing_key",
      "idx_company_declarations_digest",
      "idx_company_declarations_filing_key",
      "idx_company_declarations_tenant",
    ]);
    expect(named("trigger")).toEqual([
      "trg_company_checks_next_id",
      "trg_company_checks_no_delete",
      "trg_company_checks_no_replace",
      "trg_company_checks_no_update",
      "trg_company_declarations_erase_only",
      "trg_company_declarations_no_delete",
      "trg_company_declarations_no_replace",
      "trg_company_declarations_positive_rowid",
    ]);

    declarations.insert(declaration());
    db.prepare(
      `INSERT INTO company_checks (company_id, result, operator, operator_os_user, checked_at, reason)
       VALUES ('co_1', 'revoked', 'ops.example', 'ops', 1790000000, 'Recorded in error.')`,
    ).run();
    const snapshot = () => ({
      schema: db
        .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
        .all(),
      declarations: rowsOf(),
      checks: db.prepare("SELECT * FROM company_checks").all(),
      meta: db.prepare("SELECT * FROM meta ORDER BY key").all(),
    });
    const before = snapshot();
    migrate(db);
    expect(snapshot()).toEqual(before);
  });

  test("an upgrade: a database without the two tables gets both back, with their triggers", () => {
    const defined = objects();
    db.exec("DROP TABLE company_declarations; DROP TABLE company_checks;");
    expect(objects()).toEqual([]);
    migrate(db);
    expect(objects()).toEqual(defined);
    // The triggers act again.
    const fresh = new SqliteCompanyDeclarationRepository(db);
    fresh.insert(declaration());
    expect(() => fresh.insert(declaration({ statementDigest: H("d2") }))).toThrow(/never replaced/);
    expect(() => db.prepare("DELETE FROM company_declarations").run()).toThrow(/never deleted/);
    db.prepare(
      `INSERT INTO company_checks (company_id, result, operator, operator_os_user, checked_at, reason)
       VALUES ('co_1', 'revoked', 'ops.example', 'ops', 1790000000, 'Recorded in error.')`,
    ).run();
    expect(() => db.prepare("DELETE FROM company_checks").run()).toThrow(/append-only/);
  });
});

describe("a declaration", () => {
  test("its filing key is the filing number in upper case with every hyphen removed", () => {
    for (const spelling of ["TEST-00-01", "TEST-0001", "test-0001"])
      expect(filingKeyOf(spelling), spelling).toBe("TEST0001");
  });

  test("round-trips with its filing key; a second insert for the same company throws", () => {
    const input = declaration({ filingNumber: "TEST-00-01" });
    declarations.insert(input);
    const stored = declarations.find("co_1");
    expect(stored).toEqual({
      ...input,
      filingKey: "TEST0001",
      piiErasedAt: null,
      createdAt: expect.stringMatching(SQLITE_UTC),
    });
    // A sandbox declaration reads back as one.
    declarations.insert(
      declaration({ companyId: "co_2", statementDigest: H("d2"), synthetic: true }),
    );
    expect(declarations.find("co_2")?.synthetic).toBe(true);

    expect(() =>
      declarations.insert(
        declaration({ statementDigest: H("d3"), companyName: "Other Example LLC" }),
      ),
    ).toThrow(/never replaced/);
    expect(declarations.find("co_1")).toEqual(stored);
    expect(declarations.find("co_unknown")).toBeUndefined();
  });

  test("every spelling of one filing number is listed under its key, oldest first", () => {
    declarations.insert(declaration({ companyId: "co_1", filingNumber: "TEST-00-01" }));
    declarations.insert(
      declaration({
        companyId: "co_2",
        filingNumber: "TEST-0001",
        statementDigest: H("d2"),
        tenantId: TENANT_B,
      }),
    );
    declarations.insert(
      declaration({ companyId: "co_3", filingNumber: "test-0001", statementDigest: H("d3") }),
    );
    declarations.insert(
      declaration({ companyId: "co_4", filingNumber: "TEST-0002", statementDigest: H("d4") }),
    );
    // Written last, created first.
    rawInsert(
      rawRow("co_5", H("d5"), {
        filing_number: "Test-0001",
        filing_key: "TEST0001",
        created_at: "2001-01-01 00:00:00",
      }),
    );
    const ids = (key: string) => declarations.listByFilingKey(key).map((d) => d.companyId);
    expect(ids("TEST0001")).toEqual(["co_5", "co_1", "co_2", "co_3"]);
    expect(ids("test-00-01")).toEqual(["co_5", "co_1", "co_2", "co_3"]);
    expect(ids("TEST0003")).toEqual([]);
    // The number is kept as it was typed; only the key is normalised.
    expect(declarations.find("co_3")?.filingNumber).toBe("test-0001");
  });

  test("findByDigest finds the tenant's own declaration and not another tenant's", () => {
    declarations.insert(declaration());
    expect(declarations.findByDigest(TENANT_A, H("d1"))?.companyId).toBe("co_1");
    expect(declarations.findByDigest(TENANT_B, H("d1"))).toBeUndefined();
    expect(declarations.findByDigest(TENANT_A, H("d2"))).toBeUndefined();
  });

  test("a second row with the same digest is refused, by the insert guard and by the unique index beneath it", () => {
    declarations.insert(declaration());
    const before = rowsOf();
    const second = () =>
      declarations.insert(declaration({ companyId: "co_2", tenantId: TENANT_B }));
    expect(second).toThrow(/never replaced/);
    expect(rowsOf()).toEqual(before);
    // The index holds on its own: with the insert guard set aside, the same insert fails on it.
    db.exec("DROP TRIGGER trg_company_declarations_no_replace");
    expect(second).toThrow(/UNIQUE constraint failed: company_declarations\.statement_digest/);
    expect(rowsOf()).toEqual(before);
  });

  test("countCreatedSince counts a tenant's declarations created at or after an instant, abandoned ones included", () => {
    rawInsert(rawRow("co_old", H("01"), { created_at: "2001-01-01 23:59:59" }));
    rawInsert(rawRow("co_edge", H("02"), { created_at: "2001-01-02 00:00:00" }));
    rawInsert(rawRow("co_new", H("03"), { created_at: "2001-01-02 12:00:00" }));
    rawInsert(rawRow("co_b", H("04"), { tenant_id: TENANT_B, created_at: "2001-01-02 12:00:00" }));
    const since = "2001-01-02 00:00:00";
    expect(declarations.countCreatedSince(TENANT_A, since)).toBe(2);
    expect(declarations.countCreatedSince(TENANT_B, since)).toBe(1);

    company("co_new");
    abandon("co_new");
    expect(declarations.erasePii("co_new", 1_790_000_500)).toBe(true);
    expect(declarations.countCreatedSince(TENANT_A, since)).toBe(2);

    // A window measured back from now, through the shared formatter.
    declarations.insert(declaration({ companyId: "co_now", statementDigest: H("05") }));
    const dayAgo = sqliteUtcTimestamp(Date.now() - 24 * 60 * 60 * 1000);
    expect(declarations.countCreatedSince(TENANT_A, dayAgo)).toBe(1);
    expect(declarations.countCreatedSince(TENANT_B, dayAgo)).toBe(0);
  });

  test("countCreatedSince takes only the text the created_at column holds", () => {
    // An ISO instant sorts after every stored time of the same day, and would undercount.
    for (const since of [new Date().toISOString(), "2001-01-02", "2001-01-02T00:00:00", ""])
      expect(() => declarations.countCreatedSince(TENANT_A, since), since).toThrow(
        /YYYY-MM-DD HH:MM:SS/,
      );
  });
});

describe("erasePii", () => {
  test("on an abandoned company it removes the six personal fields and stamps the time, once", () => {
    company("co_1");
    declarations.insert(declaration());
    abandon("co_1");
    const before = declarations.find("co_1");
    expect(before).toBeDefined();

    expect(declarations.erasePii("co_1", 1_790_000_500)).toBe(true);
    const erased = declarations.find("co_1");
    expect(erased).toEqual({
      ...before,
      declarantName: null,
      declarantTitle: null,
      statementText: null,
      statementHash: null,
      statementDigest: null,
      signature: null,
      piiErasedAt: 1_790_000_500,
    });

    expect(declarations.erasePii("co_1", 1_790_000_900)).toBe(false);
    expect(declarations.find("co_1")).toEqual(erased);
    // The digest went with the statement.
    expect(declarations.findByDigest(TENANT_A, H("d1"))).toBeUndefined();
  });

  test("answers false and changes nothing unless the company is abandoned", () => {
    company("co_draft");
    company("co_ready", "ready");
    declarations.insert(declaration({ companyId: "co_draft", statementDigest: H("d1") }));
    declarations.insert(declaration({ companyId: "co_ready", statementDigest: H("d2") }));
    // A declaration whose company row does not exist.
    declarations.insert(declaration({ companyId: "co_orphan", statementDigest: H("d3") }));
    const before = rowsOf();
    for (const companyId of ["co_draft", "co_ready", "co_orphan", "co_unknown"])
      expect(declarations.erasePii(companyId, 1_790_000_500), companyId).toBe(false);
    expect(rowsOf()).toEqual(before);
  });

  test("takes a whole number of unix seconds", () => {
    company("co_1");
    declarations.insert(declaration());
    abandon("co_1");
    const before = rowsOf();
    for (const at of [0, -1, 1_790_000_000.5, 1_790_000_000_000, Number.NaN])
      expect(() => declarations.erasePii("co_1", at), String(at)).toThrow(/unix seconds/);
    expect(rowsOf()).toEqual(before);
  });
});

describe("the database guards a declaration against raw SQL", () => {
  beforeEach(() => {
    company("co_1");
    declarations.insert(declaration());
  });

  test("a declaration is never deleted, erased or not", () => {
    expect(() =>
      db.prepare("DELETE FROM company_declarations WHERE company_id = 'co_1'").run(),
    ).toThrow(/never deleted/);
    abandon("co_1");
    expect(declarations.erasePii("co_1", 1_790_000_500)).toBe(true);
    expect(() => db.prepare("DELETE FROM company_declarations").run()).toThrow(/never deleted/);
    expect(rowsOf()).toHaveLength(1);
  });

  test("no INSERT lands on an existing declaration, whether it names its company, its digest or its rowid", () => {
    const before = rowsOf();
    const rowid = before[0]?.rowid;
    expect(typeof rowid).toBe("number");
    const collisions = [
      ["its company", rawRow("co_1", H("d9"))],
      // A new company carrying the stored statement's digest: REPLACE would delete co_1's row.
      ["its digest", rawRow("co_2", H("d1"), { tenant_id: TENANT_B })],
      ["its rowid", rawRow("co_3", H("d8"), { rowid })],
    ] as const;
    for (const [label, row] of collisions)
      for (const verb of ["INSERT OR REPLACE", "REPLACE", "INSERT OR IGNORE", "INSERT"])
        expect(() => rawInsert(row, verb), `${label}: ${verb}`).toThrow(/never replaced/);
    // An upsert on the company is refused before its UPDATE could run.
    expect(() =>
      rawInsert(
        rawRow("co_1", H("d9")),
        "INSERT",
        "ON CONFLICT(company_id) DO UPDATE SET company_name = 'Other Example LLC'",
      ),
    ).toThrow(/never replaced/);
    expect(rowsOf()).toEqual(before);
    // A new company with a new statement is still accepted.
    expect(rawInsert(rawRow("co_4", H("d4"))).changes).toBe(1);
  });

  test("a rowid is positive, so an automatic rowid can never match a stored one", () => {
    for (const rowid of [-1, 0])
      expect(
        () => rawInsert(rawRow(`co_${rowid + 10}`, H("e1"), { rowid })),
        String(rowid),
      ).toThrow(/rowid is positive/);
    expect(rowsOf()).toHaveLength(1);
    declarations.insert(declaration({ companyId: "co_2", statementDigest: H("d2") }));
    expect(rowsOf()).toHaveLength(2);
  });

  test("the only UPDATE is the erasure of an abandoned company's personal data", () => {
    const refused = (sql: string) =>
      expect(() => db.prepare(sql).run(), sql).toThrow(/only update is the erasure/);
    const facts = [
      "UPDATE company_declarations SET filing_number = 'TEST-0002' WHERE company_id = 'co_1'",
      `UPDATE company_declarations SET tenant_id = '${TENANT_B}' WHERE company_id = 'co_1'`,
      `UPDATE company_declarations SET tenant_id = '${TENANT_A.toLowerCase()}' WHERE company_id = 'co_1'`,
      "UPDATE company_declarations SET company_name = 'Other Example LLC' WHERE company_id = 'co_1'",
      "UPDATE company_declarations SET company_name = company_name WHERE company_id = 'co_1'",
      "UPDATE company_declarations SET created_at = '2001-01-01 00:00:00' WHERE company_id = 'co_1'",
      "UPDATE company_declarations SET rowid = rowid + 100 WHERE company_id = 'co_1'",
      // OR REPLACE would turn the NULL into the column default; the guard sees the NULL first.
      "UPDATE OR REPLACE company_declarations SET created_at = NULL WHERE company_id = 'co_1'",
    ];
    const before = rowsOf();
    // While the company is open, not even the erasure.
    for (const sql of [...facts, RAW_ERASE]) refused(sql);
    abandon("co_1");
    for (const sql of facts) refused(sql);
    // Erasing only the name, keeping the signature.
    refused(
      "UPDATE company_declarations SET declarant_name = NULL, pii_erased_at = 1790000500 WHERE company_id = 'co_1'",
    );
    // The six fields cleared without the stamp, and the erasure carrying another change.
    refused(RAW_ERASE.replace(", pii_erased_at = 1790000500", ""));
    refused(RAW_ERASE.replace("signature = NULL,", "signature = NULL, company_name = 'Other',"));
    expect(rowsOf()).toEqual(before);

    expect(db.prepare(RAW_ERASE).run().changes).toBe(1);
    // Un-erasing, and erasing again.
    refused(
      `UPDATE company_declarations SET declarant_name = 'Ada Example', declarant_title = 'Manager',
         statement_text = 'Example statement.', statement_hash = '${H("a1")}',
         statement_digest = '${H("d1")}', signature = '${SIGNATURE}', pii_erased_at = NULL
       WHERE company_id = 'co_1'`,
    );
    refused("UPDATE company_declarations SET pii_erased_at = 1790000900 WHERE company_id = 'co_1'");
    refused(RAW_ERASE.replace("1790000500", "1790000900"));
    expect(declarations.find("co_1")?.piiErasedAt).toBe(1_790_000_500);
  });

  test("no column but the six personal ones and the erasure stamp ever changes", () => {
    const changes: Record<string, unknown> = {
      company_id: "co_other",
      tenant_id: TENANT_B,
      human_nullifier: "nullifier-0002",
      company_name: "Other Example LLC",
      jurisdiction: "DE",
      filing_number: "TEST-0002",
      filing_key: "TEST0002",
      wording_version: "2",
      chain_id: 1,
      factory: TENANT_B,
      issued_at: 1_790_000_001,
      synthetic: 1,
      created_at: "2001-01-01 00:00:00",
      // Not a declared column, but UPDATE OR REPLACE onto another row's rowid would delete it.
      rowid: 100,
    };
    const before = rowsOf();
    abandon("co_1");
    for (const [column, value] of Object.entries(changes)) {
      const set = (assignments: string) =>
        expect(
          () =>
            db
              .prepare(`UPDATE company_declarations SET ${assignments} WHERE company_id = 'co_1'`)
              .run({ value }),
          `${column}: ${assignments}`,
        ).toThrow(/only update is the erasure/);
      set(`${column} = @value`);
      // Carried along with an otherwise valid erasure.
      set(
        `declarant_name = NULL, declarant_title = NULL, statement_text = NULL, statement_hash = NULL,
         statement_digest = NULL, signature = NULL, pii_erased_at = 1790000500, ${column} = @value`,
      );
    }
    expect(rowsOf()).toEqual(before);
  });

  test("a declaration whose company has no row is never erased", () => {
    rawInsert(rawRow("co_orphan", H("d7")));
    expect(() => db.prepare(RAW_ERASE.replace("'co_1'", "'co_orphan'")).run()).toThrow(
      /only update is the erasure/,
    );
    expect(declarations.find("co_orphan")?.piiErasedAt).toBeNull();
  });
});
