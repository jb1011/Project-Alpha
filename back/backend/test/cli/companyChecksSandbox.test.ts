/**
 * The operator's commands on a sandbox deployment, where a customer's declaration writes its own
 * passed check under a reserved operator name.
 *
 *  - No operator may type that name, on any command that takes `--operator`.
 *  - A reinstatement of a sandbox customer company writes a fresh automatic pass in the same
 *    transaction, so the company reads verified again at once. A company pinned to production, a
 *    company filed through formation, and every company on a production deployment get the
 *    reinstatement alone, as before. Without `--yes` nothing is written.
 *  - The automatic pass holds the company's test number, so a reinstatement is refused while
 *    another company holds a passed check for that number.
 *
 * Each command opens the database through the configuration, so every test works in a temporary
 * data directory. With ARC_NETWORK unset, the deployment is a sandbox.
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
import { buildCli } from "../../src/cli/index";
import { verificationStateOf } from "../../src/legalBody/attestation";
import {
  type CustomerCompanyDeps,
  type CustomerStatementInput,
  abandonCustomerCompany,
  createCustomerCompany,
  prepareCustomerStatement,
} from "../../src/legalBody/customerCompany";
import { acceptEvidence } from "../../src/legalBody/evidence";
import {
  SANDBOX_AUTOMATIC_OPERATOR,
  SANDBOX_AUTOMATIC_SENTINEL_SHA256,
} from "../../src/legalBody/sandboxCheck";
import { buildStatementMessage, statementTypedDataWire } from "../../src/legalBody/statement";
import {
  type CompanyCheck,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteLegalBodyRepository } from "../../src/persistence/legalBodyRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import {
  ANVIL_ACCOUNT_2,
  ANVIL_ACCOUNT_3,
  CHAIN_ID,
  FACTORY,
  FORMATION_PROVIDER,
  SANDBOX_TYPED,
  type Signer,
  customerCompanyDeps,
  recordHuman,
  sandboxCustomerCompanyDeps,
} from "../helpers/customerCompanyFixtures";

/** anvil's published accounts #2 and #3: test keys, never real wallets. */
const owner = ANVIL_ACCOUNT_2;
const second = ANVIL_ACCOUNT_3;

/** Two sandbox declarations, each with its own test number. */
const SANDBOX_A: CustomerStatementInput = { ...SANDBOX_TYPED, filingNumber: "TEST-0101" };
const SANDBOX_C: CustomerStatementInput = { ...SANDBOX_TYPED, filingNumber: "TEST-0303" };
/** A declaration as a production caller sends it: its declarant typed, and no synthetic flag. */
const PRODUCTION_TYPED: CustomerStatementInput = {
  declarantName: "Ada Example",
  declarantTitle: "Manager",
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0202",
};

const OPERATOR = "ops.example";
/** The sha256 of the operator's own registry printout: any 64 hexadecimal digits. */
const PRINTOUT = `0x${"ab".repeat(32)}`;
const AMENDMENT_DELAY = 48 * 3600;

const RESERVED = "refusing: --operator sandbox-automatic is reserved for the sandbox's own check";
const heldBy = (companyId: string): string =>
  `refusing: company ${companyId} holds a passed check for the same filing: resolve the dispute, and revoke one of the two (company:revoke) before this one can pass`;
const stale = (companyId: string, latest: number): string =>
  `refusing: the latest check of company ${companyId} is ${latest}, not none: another operator has written since, or this command came from the shell history. Run company:show ${companyId} and decide again`;

let dir: string;
let db: Database.Database;
let companies: SqliteCompanyRepository;
let declarations: SqliteCompanyDeclarationRepository;
let checks: SqliteCompanyCheckRepository;
let documents: SqliteDocumentIndexRepository;
let legalBodies: SqliteLegalBodyRepository;
let store: SqliteWorldStore;
let docStore: FileDocumentStore;
/** Every console line written in the process, by any console method. */
let printed: string[];
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "company-checks-sandbox-"));
  // The commands find the database and the document store through the configuration.
  process.env.DATA_DIR = dir;
  process.env.ARC_TESTNET_RPC_URL = "https://rpc.example";
  process.env.PLATFORM_PRIVATE_KEY = `0x${"a".repeat(64)}`;
  // A network left unset is a sandbox deployment.
  Reflect.deleteProperty(process.env, "ARC_NETWORK");
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
  for (const method of ["log", "info", "warn", "error"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(" "));
    });
  const nowMs = Date.now();
  recordHuman(store, owner.address, "1001", nowMs);
  recordHuman(store, second.address, "1002", nowMs);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────

const stores = () => ({ db, companies, declarations, checks, store });
/** The doors of a sandbox deployment that does not charge: every company is `environment: sandbox`. */
const sandboxDoors = () =>
  sandboxCustomerCompanyDeps(stores(), Date.now, { paymentRequired: false });
/** The doors of a production deployment that charges: every company is `environment: production`. */
const productionDoors = () => customerCompanyDeps(stores(), Date.now);

/** A company declared through the create door with its guardian's signed statement. */
async function declare(
  deps: CustomerCompanyDeps,
  who: Signer,
  typed: CustomerStatementInput,
): Promise<string> {
  const { fields } = prepareCustomerStatement(deps, who.address, typed);
  const issuedAt = BigInt(Math.floor((deps.now ?? Date.now)() / 1000));
  const served = statementTypedDataWire(
    deps.chainId,
    deps.factory,
    buildStatementMessage(fields, deps.text, issuedAt),
  );
  const signature = await who.signTypedData(JSON.parse(JSON.stringify(served)));
  const { companyId } = await createCustomerCompany(deps, who.address, {
    ...typed,
    issuedAt: served.message.issuedAt,
    signature,
  });
  return companyId;
}

/** A company filed through formation, pinned to the sandbox. It has no declaration. */
function sandboxFormationCompany(): string {
  return companies.create({
    tenantId: owner.address,
    status: "ready",
    provider: FORMATION_PROVIDER,
    environment: "sandbox",
    synthetic: false,
    nameOptions: [{ name: "Example Test Robotics", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "Operating autonomous software agents.",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
}

/** Uploads a control PDF as the customer does, into the store the commands read. */
function uploadControl(companyId: string): Hex {
  const bytes = Buffer.from(`%PDF-1.7\n% control of ${companyId}\n%%EOF\n`, "latin1");
  const result = acceptEvidence(
    { documents, docStore },
    {
      companyId,
      kind: "control",
      expectedSha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
      bytes,
    },
  );
  if (!result.ok) throw new Error(`the upload was refused: ${result.problem}`);
  return result.sha256;
}

function latestOf(companyId: string): CompanyCheck {
  const latest = checks.latest(companyId);
  if (!latest) throw new Error("no check");
  return latest;
}

// ── Command lines ─────────────────────────────────────────────────────────────────────────────

function passedCheck(
  companyId: string,
  typed: CustomerStatementInput,
  control: Hex,
  expectLatest: string,
  operator = OPERATOR,
  yes = true,
) {
  return [
    "company:check",
    companyId,
    "--result",
    "passed",
    "--operator",
    operator,
    "--expect-latest",
    expectLatest,
    "--registry-name",
    typed.companyName,
    "--registry-filing-id",
    typed.filingNumber,
    "--registry-status",
    "Active",
    "--formation-date",
    "2020-01-15",
    "--registered-agent",
    "Example Registered Agent Co",
    "--existence-evidence",
    PRINTOUT,
    "--control-evidence",
    control,
    "--control-evidence-kind",
    "ein_letter",
    "--last-report-period",
    String(new Date().getUTCFullYear() - 1),
    ...(yes ? ["--yes"] : []),
  ];
}

function revokeCompany(companyId: string, expectLatest: string, operator = OPERATOR, yes = true) {
  return [
    "company:revoke",
    companyId,
    "--operator",
    operator,
    "--expect-latest",
    expectLatest,
    "--reason",
    "Revoked while a dispute over control is resolved.",
    ...(yes ? ["--yes"] : []),
  ];
}

function reinstateCompany(
  companyId: string,
  expectLatest: string,
  operator = OPERATOR,
  yes = true,
) {
  return [
    "company:reinstate",
    companyId,
    "--operator",
    operator,
    "--expect-latest",
    expectLatest,
    "--reason",
    "The revocation was recorded on the wrong company.",
    ...(yes ? ["--yes"] : []),
  ];
}

function revokeLegalBody(legalBodyId: string, operator = OPERATOR, yes = true) {
  return [
    "legal-body:revoke",
    legalBodyId,
    "--operator",
    operator,
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
  };
}

/** The refusal's message. A refusal prints nothing at all: no object, and no ops line. */
async function refusal(args: string[]): Promise<string> {
  const from = printed.length;
  let message: string | undefined;
  try {
    await buildCli(noChain).parseAsync(["node", "cli", ...args]);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (message === undefined) throw new Error(`expected ${args[0]} to be refused`);
  expect(printed.slice(from)).toEqual([]);
  return message;
}

interface Recorded {
  recorded: true;
  check: CompanyCheck;
  automaticPass?: true;
}
interface NotRecorded {
  recorded: false;
  wouldRecord: Record<string, unknown>;
  latestCheck: CompanyCheck | null;
  automaticPass?: true;
}

/** A sandbox customer company, revoked by the operator after its automatic pass. */
async function revokedSandboxCompany(
  who: Signer = owner,
  typed: CustomerStatementInput = SANDBOX_A,
): Promise<{ companyId: string; automatic: CompanyCheck; revoked: CompanyCheck }> {
  const companyId = await declare(sandboxDoors(), who, typed);
  const automatic = latestOf(companyId);
  expect(automatic.operator).toBe(SANDBOX_AUTOMATIC_OPERATOR);
  const { output } = await run<Recorded>(revokeCompany(companyId, String(automatic.checkId)));
  // A revocation passes no second row, and prints exactly what it printed before.
  expect(output).not.toHaveProperty("automaticPass");
  return { companyId, automatic, revoked: output.check };
}

// ── The reserved name ─────────────────────────────────────────────────────────────────────────

describe("the automatic operator's name", () => {
  test("is refused on every command that takes --operator, with or without --yes, and nothing is written", async () => {
    const { companyId, automatic, revoked } = await revokedSandboxCompany();
    const control = uploadControl(companyId);
    const body = legalBodies.create({
      tenantId: owner.address,
      companyId,
      chainId: CHAIN_ID,
      factory: FACTORY,
      amendmentDelay: AMENDMENT_DELAY,
    });
    const latest = String(revoked.checkId);
    /** Each command line, as an operator would type it with this name. */
    const lines = (operator: string, yes: boolean) => [
      passedCheck(companyId, SANDBOX_A, control, latest, operator, yes),
      revokeCompany(companyId, latest, operator, yes),
      reinstateCompany(companyId, latest, operator, yes),
      revokeLegalBody(body.legalBodyId, operator, yes),
    ];

    for (const yes of [true, false])
      for (const args of lines(SANDBOX_AUTOMATIC_OPERATOR, yes))
        expect(await refusal(args)).toBe(RESERVED);

    // The same lines under the operator's own name are accepted: only the name was refused.
    for (const args of lines(OPERATOR, false))
      expect((await run<NotRecorded>(args)).output.recorded).toBe(false);
    expect(checks.list(companyId)).toEqual([automatic, revoked]);
    expect(legalBodies.listEvents(body.legalBodyId).map((e) => e.kind)).toEqual(["created"]);
  });
});

// ── company:reinstate ─────────────────────────────────────────────────────────────────────────

describe("company:reinstate on a sandbox deployment", () => {
  test("with --yes, a sandbox customer company is reinstated and passes again at once: one object, two rows, two ops lines", async () => {
    const { companyId, automatic, revoked } = await revokedSandboxCompany();
    const declaration = declarations.find(companyId);
    if (!declaration) throw new Error("no declaration");
    const before = Math.floor(Date.now() / 1000);

    const { output, ops } = await run<Recorded>(
      reinstateCompany(companyId, String(revoked.checkId)),
    );

    expect(output.recorded).toBe(true);
    expect(output.automaticPass).toBe(true);
    expect(output.check).toMatchObject({ result: "reinstated", operator: OPERATOR });
    // The write prints the reinstated row and the flag, and nothing more.
    expect(Object.keys(output).sort()).toEqual(["automaticPass", "check", "recorded"]);
    const list = checks.list(companyId);
    expect(list.map((c) => c.result)).toEqual(["passed", "revoked", "reinstated", "passed"]);
    expect(list.slice(0, 3)).toEqual([automatic, revoked, output.check]);
    const fresh = latestOf(companyId);
    expect(fresh.checkId).toBeGreaterThan(output.check.checkId);
    expect(fresh).toMatchObject({
      result: "passed",
      operator: SANDBOX_AUTOMATIC_OPERATOR,
      operatorOsUser: userInfo().username,
      registryName: declaration.companyName,
      registryFilingId: declaration.filingNumber,
      registryStatus: "sandbox",
      registeredAgent: "sandbox",
      existenceEvidenceSha256: SANDBOX_AUTOMATIC_SENTINEL_SHA256,
      controlEvidenceSha256: SANDBOX_AUTOMATIC_SENTINEL_SHA256,
      controlEvidenceKind: "other",
      reasonCode: null,
      reason: null,
    });
    expect(fresh.checkedAt).toBeGreaterThanOrEqual(before);
    expect(fresh.checkedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(verificationStateOf(fresh)).toBe("verified");

    // One ops line per appended check, in the one shape: ids, the result and the operator.
    expect(ops.map(({ at: _at, ...line }) => line)).toEqual([
      {
        opslog: "company_check_recorded",
        companyId,
        checkId: output.check.checkId,
        result: "reinstated",
        reasonCode: null,
        operator: OPERATOR,
      },
      {
        opslog: "company_check_recorded",
        companyId,
        checkId: fresh.checkId,
        result: "passed",
        reasonCode: null,
        operator: SANDBOX_AUTOMATIC_OPERATOR,
      },
    ]);
    expect(JSON.stringify(ops)).not.toContain(declaration.companyName);
  });

  test("without --yes, nothing is written: one object that says an automatic pass would follow", async () => {
    const { companyId, automatic, revoked } = await revokedSandboxCompany();

    const { output, ops } = await run<NotRecorded>(
      reinstateCompany(companyId, String(revoked.checkId), OPERATOR, false),
    );

    expect(output.recorded).toBe(false);
    expect(output.automaticPass).toBe(true);
    expect(output.latestCheck).toEqual(revoked);
    expect(output.wouldRecord).toMatchObject({ result: "reinstated", operator: OPERATOR });
    // The second row is not printed: the flag is all the dry run adds.
    expect(Object.keys(output).sort()).toEqual([
      "automaticPass",
      "company",
      "latestCheck",
      "next",
      "recorded",
      "wouldRecord",
    ]);
    expect(ops).toEqual([]);
    expect(checks.list(companyId)).toEqual([automatic, revoked]);
    expect(verificationStateOf(latestOf(companyId))).toBe("revoked");
  });

  test("is refused while another company holds a passed check for the same test number, with or without --yes, and the reinstatement rolls back", async () => {
    const a = await revokedSandboxCompany(owner, SANDBOX_A);
    // Once A is revoked its number is free, and another company declares it.
    const b = await declare(sandboxDoors(), second, SANDBOX_A);
    const bPass = latestOf(b);
    expect(bPass).toMatchObject({ result: "passed", operator: SANDBOX_AUTOMATIC_OPERATOR });

    for (const yes of [true, false])
      expect(
        await refusal(reinstateCompany(a.companyId, String(a.revoked.checkId), OPERATOR, yes)),
      ).toBe(heldBy(b));
    expect(checks.list(a.companyId)).toEqual([a.automatic, a.revoked]);
    expect(latestOf(a.companyId)).toEqual(a.revoked);
    expect(checks.list(b)).toEqual([bPass]);

    // Once the other company no longer holds it, the reinstatement goes through.
    await run(revokeCompany(b, String(bPass.checkId)));
    const { output } = await run<Recorded>(
      reinstateCompany(a.companyId, String(a.revoked.checkId)),
    );
    expect(output.automaticPass).toBe(true);
    expect(latestOf(a.companyId)).toMatchObject({
      result: "passed",
      operator: SANDBOX_AUTOMATIC_OPERATOR,
    });
  });

  test("an abandoned sandbox customer company is reinstated alone: no automatic pass, no flag", async () => {
    const companyId = await declare(sandboxDoors(), owner, SANDBOX_A);
    const automatic = latestOf(companyId);
    abandonCustomerCompany(sandboxDoors(), owner.address, companyId);
    expect(companies.find(companyId)?.status).toBe("abandoned");
    const revoked = await run<Recorded>(revokeCompany(companyId, String(automatic.checkId)));
    const id = String(revoked.output.check.checkId);

    const dry = await run<NotRecorded>(reinstateCompany(companyId, id, OPERATOR, false));
    expect(dry.output.recorded).toBe(false);
    expect(dry.output).not.toHaveProperty("automaticPass");

    const { output, ops } = await run<Recorded>(reinstateCompany(companyId, id));
    expect(output.recorded).toBe(true);
    expect(output).not.toHaveProperty("automaticPass");
    expect(checks.list(companyId)).toEqual([automatic, revoked.output.check, output.check]);
    expect(latestOf(companyId).result).toBe("reinstated");
    expect(ops).toHaveLength(1);
  });

  test("a company pinned to production is reinstated alone: no automatic pass, no flag", async () => {
    const companyId = await declare(productionDoors(), owner, PRODUCTION_TYPED);
    expect(companies.find(companyId)?.environment).toBe("production");
    expect(checks.list(companyId)).toEqual([]);
    const revoked = await run<Recorded>(revokeCompany(companyId, "none"));
    const id = String(revoked.output.check.checkId);

    const dry = await run<NotRecorded>(reinstateCompany(companyId, id, OPERATOR, false));
    expect(dry.output.recorded).toBe(false);
    expect(dry.output).not.toHaveProperty("automaticPass");

    const { output, ops } = await run<Recorded>(reinstateCompany(companyId, id));
    expect(output.recorded).toBe(true);
    expect(output).not.toHaveProperty("automaticPass");
    expect(checks.list(companyId).map((c) => c.result)).toEqual(["revoked", "reinstated"]);
    expect(verificationStateOf(latestOf(companyId))).toBe("awaiting_check");
    expect(ops).toHaveLength(1);
  });

  test("a sandbox company filed through formation has no declaration, so it is reinstated alone", async () => {
    const companyId = sandboxFormationCompany();
    const revoked = await run<Recorded>(revokeCompany(companyId, "none"));

    const { output, ops } = await run<Recorded>(
      reinstateCompany(companyId, String(revoked.output.check.checkId)),
    );

    expect(output.recorded).toBe(true);
    expect(output).not.toHaveProperty("automaticPass");
    expect(checks.list(companyId).map((c) => c.result)).toEqual(["revoked", "reinstated"]);
    expect(ops).toHaveLength(1);
  });

  test("on a production deployment, even a sandbox customer company is reinstated alone", async () => {
    const { companyId, automatic, revoked } = await revokedSandboxCompany();
    // A legal mainnet configuration: the network, a chain that is not the testnet's, and the
    // formation provider in production with the identity and personal-data floors it demands.
    Object.assign(process.env, {
      ARC_NETWORK: "mainnet",
      ARC_CHAIN_ID: "8004",
      DOOLA_API_KEY: "dk_test_key",
      DOOLA_WEBHOOK_SECRET: "whsec_test",
      DOOLA_ENVIRONMENT: "production",
      WORLD_APP_ID: "app_staging_1",
      WORLD_RP_ID: "app.example",
      WORLD_RP_SIGNING_KEY: "0xsigning",
      WORLD_REQUIRE_GUARDIAN: "true",
      WORLD_MAX_COMPANIES_PER_HUMAN: "3",
      FORMATION_PII_KEY: Buffer.alloc(32, 7).toString("base64"),
    });

    const dry = await run<NotRecorded>(
      reinstateCompany(companyId, String(revoked.checkId), OPERATOR, false),
    );
    expect(dry.output).not.toHaveProperty("automaticPass");
    const { output, ops } = await run<Recorded>(
      reinstateCompany(companyId, String(revoked.checkId)),
    );

    expect(output.recorded).toBe(true);
    expect(output).not.toHaveProperty("automaticPass");
    expect(checks.list(companyId)).toEqual([automatic, revoked, output.check]);
    expect(ops).toHaveLength(1);
  });
});

// ── company:check ─────────────────────────────────────────────────────────────────────────────

describe("company:check on an auto-checked sandbox company", () => {
  test("--expect-latest none is stale: the latest check is the automatic one", async () => {
    const companyId = await declare(sandboxDoors(), owner, SANDBOX_C);
    const automatic = latestOf(companyId);
    const control = uploadControl(companyId);

    for (const yes of [true, false])
      expect(await refusal(passedCheck(companyId, SANDBOX_C, control, "none", OPERATOR, yes))).toBe(
        stale(companyId, automatic.checkId),
      );
    expect(checks.list(companyId)).toEqual([automatic]);
  });

  test("its help says so, in one sentence", () => {
    const command = buildCli(noChain).commands.find((c) => c.name() === "company:check");
    if (!command) throw new Error("no command company:check");
    // Commander wraps long lines: compare the words, whatever the terminal width.
    expect(command.helpInformation().replace(/\s+/g, " ")).toContain(
      "on a sandbox deployment the latest check is the automatic one",
    );
  });
});
