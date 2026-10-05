/**
 * The operator's commands over a customer's declaration: `company:show`, `company:check` (passed or
 * failed), `company:revoke`, `company:reinstate`, and `legal-body:revoke`.
 *
 * Each command opens the database and the document store itself, through the configuration, so
 * every test here works in a temporary data directory: the database file and the evidence bytes
 * the commands read are both under it, and the test writes them through its own connection and
 * its own file store over the same paths.
 *
 * Every name, company and filing number here is an invention, and the keys are anvil's published
 * test accounts.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { toCompanyView } from "../../src/api/views";
import { companyNameKeyOf } from "../../src/cli/companyChecks";
import { buildCli } from "../../src/cli/index";
import {
  CUSTOMER_PROVIDER,
  abandonCustomerCompany,
  createCustomerCompany,
} from "../../src/legalBody/customerCompany";
import { type EvidenceKind, acceptEvidence } from "../../src/legalBody/evidence";
import { buildStatementMessage, statementTypedDataWire } from "../../src/legalBody/statement";
import {
  type CompanyCheck,
  type NewCompanyCheck,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import {
  type DocumentIndexRecord,
  SqliteDocumentIndexRepository,
} from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteLegalBodyRepository } from "../../src/persistence/legalBodyRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  APPROVED,
  CHAIN_ID,
  FACTORY,
  FORMATION_PROVIDER,
  type Signer,
  customerCompanyDeps,
  recordHuman,
} from "../helpers/customerCompanyFixtures";

/** anvil's published accounts #2 and #3: test keys, never real wallets. */
const owner = ANVIL_ACCOUNT_2;
const rival = ANVIL_ACCOUNT_3;

interface Typed {
  declarantName: string;
  declarantTitle: string;
  companyName: string;
  filingNumber: string;
}

const OWNER_DECLARATION: Typed = {
  declarantName: "Ada Example",
  declarantTitle: "Sole Example Manager",
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
};
/** The same LLC, declared by another guardian with its filing number hyphenated differently. */
const RIVAL_DECLARATION: Typed = {
  declarantName: "Bea Example",
  declarantTitle: "Example Member",
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-00-01",
};

const OPERATOR = "ops.example";
/** The sha256 of the operator's own registry printout: any 64 hexadecimal digits. */
const PRINTOUT = `0x${"ab".repeat(32)}`;
const AMENDMENT_DELAY = 48 * 3600;

let dir: string;
let db: Database.Database;
let companies: SqliteCompanyRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let documents: SqliteDocumentIndexRepository;
let legalBodies: SqliteLegalBodyRepository;
let store: SqliteWorldStore;
let docStore: FileDocumentStore;
/** Every line written to standard output, the commands' and the ops lines alike. */
let printed: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "company-checks-"));
  // The commands find the database and the document store through the configuration.
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  db = openDatabase(join(dir, "legalbody.db"));
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  documents = new SqliteDocumentIndexRepository(db);
  legalBodies = new SqliteLegalBodyRepository(db);
  store = new SqliteWorldStore(db);
  docStore = new FileDocumentStore(join(dir, "documents"));
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

/** A customer's company, declared with a real signature by a verified human. */
async function declare(signer: Signer, nullifier: string, typed: Typed): Promise<string> {
  const nowMs = Date.now();
  recordHuman(store, signer.address, nullifier, nowMs);
  const issuedAt = BigInt(Math.floor(nowMs / 1000));
  const message = buildStatementMessage(
    { ...typed, jurisdiction: "WY", guardian: signer.address },
    APPROVED,
    issuedAt,
  );
  const served = statementTypedDataWire(CHAIN_ID, FACTORY, message);
  const signature = await signer.signTypedData(JSON.parse(JSON.stringify(served)));
  const { companyId } = await createCustomerCompany(customerDeps(nowMs), signer.address, {
    ...typed,
    issuedAt: issuedAt.toString(),
    signature,
  });
  return companyId;
}

const customerDeps = (nowMs = Date.now()) =>
  customerCompanyDeps({ db, companies, declarations, checks, store }, () => nowMs);

/** A company filed through formation. */
function formationCompany(): string {
  return companies.create({
    tenantId: owner.address,
    status: "ready",
    provider: FORMATION_PROVIDER,
    environment: "production",
    synthetic: false,
    nameOptions: [{ name: "Example Robotics", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "Operating autonomous software agents.",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
}

/** A small PDF, different for every label. */
const pdf = (label: string): Buffer => Buffer.from(`%PDF-1.7\n% ${label}\n%%EOF\n`, "latin1");
const sha256Of = (bytes: Uint8Array): Hex =>
  `0x${createHash("sha256").update(bytes).digest("hex")}`;

/** Uploads a PDF as the customer does, into the store the commands read. Returns its sha256. */
function upload(companyId: string, kind: EvidenceKind, label: string): Hex {
  const bytes = pdf(label);
  const result = acceptEvidence(
    { documents, docStore },
    { companyId, kind, expectedSha256: sha256Of(bytes), bytes },
  );
  if (!result.ok) throw new Error(`the upload was refused: ${result.problem}`);
  return result.sha256;
}

function uploadRow(companyId: string, kind: EvidenceKind, sha256: Hex): DocumentIndexRecord {
  const row = documents.findByProviderDocId(companyId, `upload:${kind}:${sha256}`);
  if (!row) throw new Error("no such upload");
  return row;
}

/** The owner's company, with one control upload. */
async function ownerCompany(): Promise<{ companyId: string; control: Hex }> {
  const companyId = await declare(owner, "1001", OWNER_DECLARATION);
  return { companyId, control: upload(companyId, "control", "owner control") };
}

/** The rival's company over the same LLC, with one control upload. */
async function rivalCompany(): Promise<{ companyId: string; control: Hex }> {
  const companyId = await declare(rival, "1002", RIVAL_DECLARATION);
  return { companyId, control: upload(companyId, "control", "rival control") };
}

/** A check written straight through the repository, as an earlier command would have. */
function appendCheck(companyId: string, over: Partial<NewCompanyCheck>): CompanyCheck {
  return checks.append({
    companyId,
    result: "failed",
    operator: "ops.other",
    operatorOsUser: "operator",
    checkedAt: Math.floor(Date.now() / 1000),
    registryName: null,
    registryFilingId: null,
    registryStatus: null,
    formationDate: null,
    registeredAgent: null,
    existenceEvidenceSha256: null,
    controlEvidenceSha256: null,
    controlEvidenceKind: null,
    reasonCode: "other",
    reason: "A first look found nothing to check against.",
    ...over,
  });
}

/** What the tenant's own view says of the operator's check. */
function tenantVerification(companyId: string) {
  const company = companies.find(companyId);
  if (!company) throw new Error("no such company");
  return toCompanyView(company, [], false, 0, {
    declaration: declarations.find(companyId),
    latestCheck: checks.latest(companyId),
  }).verification;
}

// ── Command lines ─────────────────────────────────────────────────────────────────────────────

type Options = Record<string, string | null>;

/** The options as a command line; an option given as null is left out. */
const flags = (options: Options): string[] =>
  Object.entries(options).flatMap(([name, value]) => (value === null ? [] : [name, value]));

function passedCheck(companyId: string, control: string, over: Options = {}, yes = true) {
  return [
    "company:check",
    companyId,
    "--result",
    "passed",
    ...flags({
      "--operator": OPERATOR,
      "--expect-latest": "none",
      "--registry-name": "Example Holdings LLC",
      "--registry-filing-id": "TEST-0001",
      "--registry-status": "Active",
      "--formation-date": "2020-01-15",
      "--registered-agent": "Example Registered Agent Co",
      "--existence-evidence": PRINTOUT,
      "--control-evidence": control,
      "--control-evidence-kind": "ein_letter",
      ...over,
    }),
    ...(yes ? ["--yes"] : []),
  ];
}

function failedCheck(companyId: string, over: Options = {}, yes = true) {
  return [
    "company:check",
    companyId,
    "--result",
    "failed",
    ...flags({
      "--operator": OPERATOR,
      "--expect-latest": "none",
      "--reason-code": "name_mismatch",
      "--reason": "The registry shows another name for this filing.",
      ...over,
    }),
    ...(yes ? ["--yes"] : []),
  ];
}

function revokeCompany(companyId: string, expectLatest: string, over: Options = {}, yes = true) {
  return [
    "company:revoke",
    companyId,
    ...flags({
      "--operator": OPERATOR,
      "--expect-latest": expectLatest,
      "--reason": "Revoked while a dispute over control is resolved.",
      ...over,
    }),
    ...(yes ? ["--yes"] : []),
  ];
}

function reinstateCompany(companyId: string, expectLatest: string, yes = true) {
  return [
    "company:reinstate",
    companyId,
    "--operator",
    OPERATOR,
    "--expect-latest",
    expectLatest,
    "--reason",
    "The revocation was recorded on the wrong company.",
    ...(yes ? ["--yes"] : []),
  ];
}

function revokeLegalBody(legalBodyId: string, yes = true) {
  return [
    "legal-body:revoke",
    legalBodyId,
    "--operator",
    OPERATOR,
    "--reason",
    "The body was ordered for a company that is not the customer's.",
    ...(yes ? ["--yes"] : []),
  ];
}

const noChain = () => {
  throw new Error("this command must not build a chain context");
};

const isOpsLine = (line: string): boolean => {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && "opslog" in parsed;
  } catch {
    return false;
  }
};

interface Run<T> {
  /** The one JSON object the command printed. */
  output: T;
  /** The ops lines it wrote, parsed. */
  ops: Record<string, unknown>[];
  /** Everything it wrote to standard output. */
  lines: string[];
}

async function run<T = Record<string, unknown>>(args: string[]): Promise<Run<T>> {
  const from = printed.length;
  await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  const lines = printed.slice(from);
  const outputs = lines.filter((line) => !isOpsLine(line));
  expect(outputs).toHaveLength(1);
  return {
    output: JSON.parse(outputs[0] as string) as T,
    ops: lines.filter(isOpsLine).map((line) => JSON.parse(line) as Record<string, unknown>),
    lines,
  };
}

/** The refusal's message. A refusal writes no ops line. */
async function refusal(args: string[]): Promise<string> {
  const from = printed.length;
  let message: string | undefined;
  try {
    await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (message === undefined) throw new Error(`expected ${args[0]} to be refused`);
  expect(printed.slice(from).filter(isOpsLine)).toEqual([]);
  return message;
}

interface Recorded {
  recorded: true;
  check: CompanyCheck;
}
interface NotRecorded {
  recorded: false;
}
interface Shown {
  company: { companyId: string; provider: string; status: string };
  declaration: {
    declarantName: string | null;
    declarantTitle: string | null;
    companyName: string;
    filingNumber: string;
    wordingVersion: string;
    issuedAt: number;
    tenantId: string;
    piiErasedAt: number | null;
  } | null;
  latestCheckId: number | null;
  checks: CompanyCheck[];
  uploads: {
    kind: string;
    sha256: string;
    size: number;
    path: string;
    bytesPresent: boolean;
  }[];
  otherCompaniesWithSameFiling: string[];
}

// ── company:show ──────────────────────────────────────────────────────────────────────────────

describe("company:show", () => {
  test("prints the declaration, every check, the uploads and the other companies declaring the same filing; no ops line carries them", async () => {
    const { companyId, control } = await ownerCompany();
    const existence = upload(companyId, "existence", "owner existence");
    const gone = uploadRow(companyId, "existence", existence);
    docStore.delete(gone.path);
    expect(documents.markBytesDeleted(gone.id, Math.floor(Date.now() / 1000))).toBe(true);
    const first = appendCheck(companyId, {});
    const { companyId: rivalId } = await rivalCompany();

    const { output, ops } = await run<Shown>(["company:show", companyId]);

    expect(output.declaration).toMatchObject({
      declarantName: OWNER_DECLARATION.declarantName,
      declarantTitle: OWNER_DECLARATION.declarantTitle,
      companyName: OWNER_DECLARATION.companyName,
      filingNumber: OWNER_DECLARATION.filingNumber,
      wordingVersion: APPROVED.version,
      tenantId: owner.address,
      piiErasedAt: null,
    });
    expect(output.declaration?.issuedAt).toBe(declarations.find(companyId)?.issuedAt);
    expect(output.company).toMatchObject({ companyId, provider: CUSTOMER_PROVIDER });
    expect(output.checks).toEqual([first]);
    expect(output.latestCheckId).toBe(first.checkId);
    const byKind = Object.fromEntries(output.uploads.map((u) => [u.kind, u]));
    const controlRow = uploadRow(companyId, "control", control);
    expect(byKind.control).toMatchObject({
      sha256: control,
      size: pdf("owner control").length,
      path: join(dir, "documents", controlRow.path),
      bytesPresent: true,
    });
    expect(byKind.existence).toMatchObject({ sha256: existence, bytesPresent: false });
    expect(output.otherCompaniesWithSameFiling).toEqual([rivalId]);

    const opsText = JSON.stringify(ops);
    for (const value of [
      OWNER_DECLARATION.declarantName,
      OWNER_DECLARATION.declarantTitle,
      OWNER_DECLARATION.companyName,
      OWNER_DECLARATION.filingNumber,
      control.slice(2),
      existence.slice(2),
      controlRow.path,
      rivalId,
      first.reason as string,
    ])
      expect(opsText).not.toContain(value);
  });

  test("an erased declaration shows no declarant", async () => {
    const companyId = await declare(owner, "1001", OWNER_DECLARATION);
    abandonCustomerCompany(customerDeps(), owner.address, companyId);

    const { output } = await run<Shown>(["company:show", companyId]);

    expect(output.declaration).toMatchObject({
      declarantName: null,
      declarantTitle: null,
      companyName: OWNER_DECLARATION.companyName,
    });
    expect(output.declaration?.piiErasedAt).toEqual(expect.any(Number));
    expect(output.company.status).toBe("abandoned");
  });

  test("an unknown company is refused", async () => {
    expect(await refusal(["company:show", "no-such-company"])).toMatch(
      /no company no-such-company/,
    );
  });
});

// ── Confirmation ──────────────────────────────────────────────────────────────────────────────

describe("without --yes", () => {
  test("every writing command prints what it found and writes nothing", async () => {
    const { companyId, control } = await ownerCompany();
    const body = legalBodies.create({
      tenantId: owner.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: AMENDMENT_DELAY,
    });

    for (const args of [
      passedCheck(companyId, control, {}, false),
      failedCheck(companyId, {}, false),
      revokeCompany(companyId, "none", {}, false),
    ]) {
      const { output, ops } = await run<NotRecorded>(args);
      expect(output.recorded).toBe(false);
      expect(ops).toEqual([]);
    }
    expect(checks.list(companyId)).toEqual([]);

    const revoked = appendCheck(companyId, { result: "revoked", reasonCode: null });
    const reinstated = await run<NotRecorded>(
      reinstateCompany(companyId, String(revoked.checkId), false),
    );
    expect(reinstated.output.recorded).toBe(false);
    expect(reinstated.ops).toEqual([]);
    expect(checks.list(companyId)).toEqual([revoked]);

    const bodyRun = await run<NotRecorded>(revokeLegalBody(body.legalBodyId, false));
    expect(bodyRun.output.recorded).toBe(false);
    expect(bodyRun.ops).toEqual([]);
    expect(legalBodies.listEvents(body.legalBodyId).map((e) => e.kind)).toEqual(["created"]);
  });
});

// ── company:check --result passed ─────────────────────────────────────────────────────────────

describe("company:check --result passed", () => {
  test("appends a row with the operator and the OS user, and the tenant's view reads verified", async () => {
    const { companyId, control } = await ownerCompany();
    expect(tenantVerification(companyId)?.state).toBe("awaiting_check");
    const before = Math.floor(Date.now() / 1000);

    const { output, ops } = await run<Recorded>(passedCheck(companyId, control));

    const after = Math.floor(Date.now() / 1000);
    expect(output.recorded).toBe(true);
    expect(output.check).toMatchObject({
      companyId,
      result: "passed",
      operator: OPERATOR,
      operatorOsUser: userInfo().username,
      registryName: "Example Holdings LLC",
      registryFilingId: "TEST-0001",
      filingKey: "TEST0001",
      registryStatus: "Active",
      formationDate: "2020-01-15",
      registeredAgent: "Example Registered Agent Co",
      existenceEvidenceSha256: PRINTOUT,
      controlEvidenceSha256: control,
      controlEvidenceKind: "ein_letter",
      reasonCode: null,
      reason: null,
    });
    expect(output.check.checkedAt).toBeGreaterThanOrEqual(before);
    expect(output.check.checkedAt).toBeLessThanOrEqual(after);
    expect(checks.list(companyId)).toEqual([output.check]);
    expect(tenantVerification(companyId)).toEqual({
      state: "verified",
      checkedAt: output.check.checkedAt,
      reasonCode: null,
    });

    // One ops line: the ids, the result, the reason code and the operator, and nothing typed.
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      opslog: "company_check_recorded",
      companyId,
      checkId: output.check.checkId,
      result: "passed",
      reasonCode: null,
      operator: OPERATOR,
    });
    const line = JSON.stringify(ops[0]);
    for (const typed of ["Example Holdings LLC", "Example Registered Agent Co", "Active"])
      expect(line).not.toContain(typed);
  });

  test("takes the hashes with or without 0x, in any case, and stores them as 0x and lower case", async () => {
    const { companyId, control } = await ownerCompany();

    const { output } = await run<Recorded>(
      passedCheck(companyId, control.slice(2).toUpperCase(), {
        "--existence-evidence": `0X${PRINTOUT.slice(2).toUpperCase()}`,
      }),
    );

    expect(output.check.controlEvidenceSha256).toBe(control);
    expect(output.check.existenceEvidenceSha256).toBe(PRINTOUT);
  });

  test("compares the registry name with the declared one by their company-name keys", async () => {
    expect(companyNameKeyOf("Example Holdings, L.L.C.")).toBe("EXAMPLE HOLDINGS LLC");
    expect(companyNameKeyOf("  example  holdings ,  llc ")).toBe("EXAMPLE HOLDINGS LLC");
    const { companyId, control } = await ownerCompany();

    const { output } = await run<Recorded>(
      passedCheck(companyId, control, { "--registry-name": "EXAMPLE HOLDINGS, L.L.C." }),
    );

    expect(output.check.registryName).toBe("EXAMPLE HOLDINGS, L.L.C.");
  });

  test("a second passed check over a passed one is a re-check, and is recorded", async () => {
    const { companyId, control } = await ownerCompany();
    const first = await run<Recorded>(passedCheck(companyId, control));

    const second = await run<Recorded>(
      passedCheck(companyId, control, { "--expect-latest": String(first.output.check.checkId) }),
    );

    expect(checks.list(companyId).map((c) => c.result)).toEqual(["passed", "passed"]);
    expect(checks.latest(companyId)?.checkId).toBe(second.output.check.checkId);
  });

  describe("refuses, and records nothing", () => {
    test("a company filed through formation", async () => {
      const companyId = formationCompany();
      expect(await refusal(passedCheck(companyId, PRINTOUT))).toMatch(/declared by its customer/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("an abandoned company", async () => {
      const { companyId, control } = await ownerCompany();
      expect(companies.setStatus(companyId, "draft", "abandoned")).toBe(true);
      expect(await refusal(passedCheck(companyId, control))).toMatch(/abandoned/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("an erased declaration", async () => {
      const { companyId, control } = await ownerCompany();
      abandonCustomerCompany(customerDeps(), owner.address, companyId);
      // Back to draft by hand, so the erasure is the only thing left to refuse it.
      db.prepare("UPDATE companies SET status = 'draft' WHERE company_id = ?").run(companyId);
      expect(await refusal(passedCheck(companyId, control))).toMatch(/erased/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a registry filing id with another filing key, pointing at a failed check", async () => {
      const { companyId, control } = await ownerCompany();
      const message = await refusal(
        passedCheck(companyId, control, { "--registry-filing-id": "TEST-0002" }),
      );
      expect(message).toMatch(/--result failed/);
      expect(message).toMatch(/filing_not_found/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a registry filing id that is not a filing number, before its key is compared", async () => {
      const { companyId, control } = await ownerCompany();
      for (const malformed of ["TEST 0001", "TEST_0001", "T01", "T".repeat(33)]) {
        const message = await refusal(
          passedCheck(companyId, control, { "--registry-filing-id": malformed }),
        );
        expect(message).toMatch(/--registry-filing-id/);
        expect(message).not.toMatch(/filing_not_found/);
      }
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a registry name that differs from the declared one, pointing at a failed check", async () => {
      const { companyId, control } = await ownerCompany();
      const message = await refusal(
        passedCheck(companyId, control, { "--registry-name": "Example Holdings Inc" }),
      );
      expect(message).toMatch(/--result failed/);
      expect(message).toMatch(/name_mismatch/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a control hash that matches no upload of the company", async () => {
      const { companyId } = await ownerCompany();
      const { control: rivalControl } = await rivalCompany();
      expect(await refusal(passedCheck(companyId, sha256Of(pdf("never uploaded"))))).toMatch(
        /matches no upload/,
      );
      // Another company's upload is not this company's.
      expect(await refusal(passedCheck(companyId, rivalControl))).toMatch(/matches no upload/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a control hash of an upload of kind existence", async () => {
      const { companyId } = await ownerCompany();
      const existence = upload(companyId, "existence", "owner existence");
      expect(await refusal(passedCheck(companyId, existence))).toMatch(/kind existence/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a control upload whose bytes were deleted", async () => {
      const { companyId, control } = await ownerCompany();
      const row = uploadRow(companyId, "control", control);
      docStore.delete(row.path);
      expect(documents.markBytesDeleted(row.id, Math.floor(Date.now() / 1000))).toBe(true);
      expect(await refusal(passedCheck(companyId, control))).toMatch(/deleted/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a control upload whose file is missing from the store", async () => {
      const { companyId, control } = await ownerCompany();
      docStore.delete(uploadRow(companyId, "control", control).path);
      expect(await refusal(passedCheck(companyId, control))).toMatch(/not in the document store/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a control upload whose stored bytes no longer hash to it", async () => {
      const { companyId, control } = await ownerCompany();
      docStore.putBytes(uploadRow(companyId, "control", control).path, pdf("altered on disk"));
      expect(await refusal(passedCheck(companyId, control))).toMatch(/no longer hash/);
      expect(checks.list(companyId)).toEqual([]);
    });

    test("a second company for the same LLC while the first holds a passed check, naming the first", async () => {
      const { companyId, control } = await ownerCompany();
      await run<Recorded>(passedCheck(companyId, control));
      const { companyId: rivalId, control: rivalControl } = await rivalCompany();

      const message = await refusal(
        passedCheck(rivalId, rivalControl, { "--registry-filing-id": "TEST-00-01" }),
      );

      expect(message).toContain(companyId);
      expect(message).toMatch(/revoke/);
      expect(checks.list(rivalId)).toEqual([]);
    });
  });

  test("after the first company is revoked, the second can pass", async () => {
    const { companyId, control } = await ownerCompany();
    const first = await run<Recorded>(passedCheck(companyId, control));
    const { companyId: rivalId, control: rivalControl } = await rivalCompany();
    await refusal(passedCheck(rivalId, rivalControl));

    await run<Recorded>(revokeCompany(companyId, String(first.output.check.checkId)));
    const { output } = await run<Recorded>(passedCheck(rivalId, rivalControl));

    expect(output.check).toMatchObject({ companyId: rivalId, result: "passed" });
    expect(tenantVerification(rivalId)?.state).toBe("verified");
    expect(tenantVerification(companyId)?.state).toBe("revoked");
  });
});

// ── --expect-latest ───────────────────────────────────────────────────────────────────────────

describe("--expect-latest", () => {
  test("a stale value is refused by check, revoke and reinstate", async () => {
    const { companyId, control } = await ownerCompany();
    const first = appendCheck(companyId, {});
    const stale = /latest check .* is 1, not none/;

    expect(await refusal(passedCheck(companyId, control))).toMatch(stale);
    expect(await refusal(failedCheck(companyId))).toMatch(stale);
    expect(await refusal(revokeCompany(companyId, "none"))).toMatch(stale);
    expect(await refusal(revokeCompany(companyId, "2"))).toMatch(/is 1, not 2/);
    expect(checks.list(companyId)).toEqual([first]);

    const revoked = await run<Recorded>(revokeCompany(companyId, String(first.checkId)));
    expect(await refusal(reinstateCompany(companyId, String(first.checkId)))).toMatch(
      /is 2, not 1/,
    );
    expect(checks.list(companyId)).toEqual([first, revoked.output.check]);
  });

  test("a value that is neither a check id nor none is refused", async () => {
    const { companyId, control } = await ownerCompany();
    for (const malformed of ["latest", "0", "01", "-1", "1.5"])
      expect(
        await refusal(passedCheck(companyId, control, { "--expect-latest": malformed })),
      ).toMatch(/--expect-latest/);
    // A reinstatement always follows a check, so `none` is not a value it takes.
    expect(await refusal(reinstateCompany(companyId, "none"))).toMatch(/--expect-latest/);
    expect(checks.list(companyId)).toEqual([]);
  });
});

// ── company:check --result failed ─────────────────────────────────────────────────────────────

describe("company:check --result failed", () => {
  test("is refused when the latest check passed, and points at company:revoke", async () => {
    const { companyId, control } = await ownerCompany();
    const passed = await run<Recorded>(passedCheck(companyId, control));

    const message = await refusal(
      failedCheck(companyId, { "--expect-latest": String(passed.output.check.checkId) }),
    );

    expect(message).toMatch(/company:revoke/);
    expect(checks.list(companyId)).toEqual([passed.output.check]);
  });

  test("needs a reason code, and the tenant's view shows it", async () => {
    const { companyId } = await ownerCompany();
    expect(await refusal(failedCheck(companyId, { "--reason-code": null }))).toMatch(
      /--reason-code/,
    );
    expect(await refusal(failedCheck(companyId, { "--reason-code": "looks_wrong" }))).toMatch(
      /reasonCode must be one of/,
    );
    expect(checks.list(companyId)).toEqual([]);

    const { output, ops } = await run<Recorded>(failedCheck(companyId));

    expect(output.check).toMatchObject({
      result: "failed",
      reasonCode: "name_mismatch",
      reason: "The registry shows another name for this filing.",
      operatorOsUser: userInfo().username,
    });
    expect(tenantVerification(companyId)).toEqual({
      state: "failed",
      checkedAt: output.check.checkedAt,
      reasonCode: "name_mismatch",
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ result: "failed", reasonCode: "name_mismatch" });
    expect(JSON.stringify(ops[0])).not.toContain("another name");
  });

  test("is refused on a company filed through formation", async () => {
    const companyId = formationCompany();
    expect(await refusal(failedCheck(companyId))).toMatch(/declared by its customer/);
    expect(checks.list(companyId)).toEqual([]);
  });

  test("takes only the options of its own result", async () => {
    const { companyId, control } = await ownerCompany();
    expect(
      await refusal(failedCheck(companyId, { "--registry-name": "Example Holdings LLC" })),
    ).toMatch(/--registry-name/);
    expect(await refusal(passedCheck(companyId, control, { "--reason-code": "other" }))).toMatch(
      /--reason-code/,
    );
    expect(await refusal(passedCheck(companyId, control, { "--registered-agent": null }))).toMatch(
      /--registered-agent/,
    );
    expect(
      await refusal([
        "company:check",
        companyId,
        "--result",
        "pending",
        ...failedCheck("x").slice(4),
      ]),
    ).toMatch(/--result/);
    expect(checks.list(companyId)).toEqual([]);
  });
});

// ── company:revoke and company:reinstate ──────────────────────────────────────────────────────

describe("company:revoke and company:reinstate", () => {
  test("a reinstated customer company reads awaiting_check; a reinstatement needs a revocation", async () => {
    const { companyId, control } = await ownerCompany();
    const passed = await run<Recorded>(passedCheck(companyId, control));
    expect(await refusal(reinstateCompany(companyId, String(passed.output.check.checkId)))).toMatch(
      /revoked/,
    );

    const revoked = await run<Recorded>(
      revokeCompany(companyId, String(passed.output.check.checkId)),
    );
    expect(revoked.output.check).toMatchObject({
      result: "revoked",
      reason: "Revoked while a dispute over control is resolved.",
      operator: OPERATOR,
      operatorOsUser: userInfo().username,
    });
    expect(tenantVerification(companyId)?.state).toBe("revoked");

    const reinstated = await run<Recorded>(
      reinstateCompany(companyId, String(revoked.output.check.checkId)),
    );
    expect(reinstated.output.check.result).toBe("reinstated");
    expect(tenantVerification(companyId)?.state).toBe("awaiting_check");
    expect(
      await refusal(reinstateCompany(companyId, String(reinstated.output.check.checkId))),
    ).toMatch(/revoked/);
    expect(checks.list(companyId).map((c) => c.result)).toEqual([
      "passed",
      "revoked",
      "reinstated",
    ]);
  });

  test("both work for a company of any provider", async () => {
    const companyId = formationCompany();
    const revoked = await run<Recorded>(revokeCompany(companyId, "none"));
    await run<Recorded>(reinstateCompany(companyId, String(revoked.output.check.checkId)));
    expect(checks.list(companyId).map((c) => c.result)).toEqual(["revoked", "reinstated"]);
  });

  test("an unknown company is refused", async () => {
    expect(await refusal(revokeCompany("no-such-company", "none"))).toMatch(
      /no company no-such-company/,
    );
  });

  test("a reason is at most 300 characters, counted in code points", async () => {
    const companyId = formationCompany();
    expect(
      await refusal(revokeCompany(companyId, "none", { "--reason": "x".repeat(301) })),
    ).toMatch(/300/);
    expect(checks.list(companyId)).toEqual([]);
    // 300 code points, 600 UTF-16 units.
    const { output } = await run<Recorded>(
      revokeCompany(companyId, "none", { "--reason": "\u{1F4C4}".repeat(300) }),
    );
    expect(output.check.reason).toBe("\u{1F4C4}".repeat(300));
  });

  test("an operator name outside the allowed set is refused", async () => {
    const companyId = formationCompany();
    for (const operator of ["Ops Example", "o", "ops@example"])
      expect(await refusal(revokeCompany(companyId, "none", { "--operator": operator }))).toMatch(
        /--operator/,
      );
    expect(checks.list(companyId)).toEqual([]);
  });
});

// ── legal-body:revoke ─────────────────────────────────────────────────────────────────────────

describe("legal-body:revoke", () => {
  test("appends one revoked event with the operator as actor; a second revoke is refused", async () => {
    const { companyId } = await ownerCompany();
    const body = legalBodies.create({
      tenantId: owner.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: AMENDMENT_DELAY,
    });

    const { output, ops } = await run<{ recorded: true }>(revokeLegalBody(body.legalBodyId));

    expect(output.recorded).toBe(true);
    const events = legalBodies.listEvents(body.legalBodyId);
    expect(events.map((e) => e.kind)).toEqual(["created", "revoked"]);
    expect(events[1]).toMatchObject({
      actor: `operator:${OPERATOR}`,
      detail: { reason: "The body was ordered for a company that is not the customer's." },
      txHash: null,
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      opslog: "legal_body_revoked",
      legalBodyId: body.legalBodyId,
      companyId,
      result: "revoked",
      operator: OPERATOR,
    });
    expect(JSON.stringify(ops[0])).not.toContain("ordered for a company");

    expect(await refusal(revokeLegalBody(body.legalBodyId))).toMatch(/already revoked/);
    expect(legalBodies.listEvents(body.legalBodyId)).toHaveLength(2);
  });

  test("an unknown legal body is refused", async () => {
    expect(await refusal(revokeLegalBody("no-such-body"))).toMatch(/no legal body no-such-body/);
  });
});

// ── Personal data ─────────────────────────────────────────────────────────────────────────────

describe("personal data", () => {
  test("no writing command writes the declarant's name or title; only company:show prints them", async () => {
    const { companyId, control } = await ownerCompany();
    const body = legalBodies.create({
      tenantId: owner.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: AMENDMENT_DELAY,
    });
    const from = printed.length;

    await run(passedCheck(companyId, control, {}, false));
    const passed = await run<Recorded>(passedCheck(companyId, control));
    const id = String(passed.output.check.checkId);
    await run(revokeCompany(companyId, id, {}, false));
    const revoked = await run<Recorded>(revokeCompany(companyId, id));
    const reinstated = await run<Recorded>(
      reinstateCompany(companyId, String(revoked.output.check.checkId)),
    );
    await run(
      failedCheck(companyId, { "--expect-latest": String(reinstated.output.check.checkId) }),
    );
    await run(revokeLegalBody(body.legalBodyId, false));
    await run(revokeLegalBody(body.legalBodyId));
    await refusal(revokeLegalBody(body.legalBodyId));

    const written = printed.slice(from).join("\n");
    expect(written).not.toContain(OWNER_DECLARATION.declarantName);
    expect(written).not.toContain(OWNER_DECLARATION.declarantTitle);

    const shown = await run<Shown>(["company:show", companyId]);
    expect(shown.output.declaration?.declarantName).toBe(OWNER_DECLARATION.declarantName);
    expect(JSON.stringify(shown.ops)).not.toContain(OWNER_DECLARATION.declarantName);
  });

  test("the help keeps personal data out of reasons, and the registered agent to a name", () => {
    const cli = buildCli(noChain);
    const help = (name: string): string => {
      const command = cli.commands.find((c) => c.name() === name);
      if (!command) throw new Error(`no command ${name}`);
      // Commander wraps long lines: compare the words, whatever the terminal width.
      return command.helpInformation().replace(/\s+/g, " ");
    };
    for (const name of [
      "company:check",
      "company:revoke",
      "company:reinstate",
      "legal-body:revoke",
    ])
      expect(help(name)).toMatch(/no personal data/);
    expect(help("company:check")).toMatch(/name only, no address/);
  });
});
