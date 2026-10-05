import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { Command } from "commander";
import { config as loadDotenv } from "dotenv";
import type { Hex } from "viem";
import { loadConfig } from "../config/env";
import { CUSTOMER_PROVIDER } from "../legalBody/provider";
import { opsLog } from "../observability/opsLog";
import {
  type CheckReasonCode,
  type CompanyCheck,
  type ControlEvidenceKind,
  type NewCompanyCheck,
  SqliteCompanyCheckRepository,
  validateCompanyCheck,
} from "../persistence/companyCheckRepository";
import {
  type CompanyDeclaration,
  SqliteCompanyDeclarationRepository,
  filingKeyOf,
} from "../persistence/companyDeclarationRepository";
import { type CompanyRecord, SqliteCompanyRepository } from "../persistence/companyRepository";
import { openDatabase } from "../persistence/db";
import { SqliteDocumentIndexRepository } from "../persistence/documentIndexRepository";
import { type DocumentStore, FileDocumentStore } from "../persistence/documentStore";
import { SqliteLegalBodyRepository } from "../persistence/legalBodyRepository";

/**
 * THE OPERATOR'S COMMANDS over a customer's declaration: see it, record the check of it (passed or
 * failed), revoke a company, reinstate one revoked by mistake, and revoke a legal body.
 *
 * Every command opens the database itself, through the configuration, like the `formation:*`
 * commands, prints ONE JSON object on success and throws on a refusal (the entry point prints the
 * message and exits non-zero).
 *
 * The writing commands share four rules:
 *  - without `--yes` they print what they found and write nothing;
 *  - `--expect-latest` names the company's latest check (or `none`), so a command typed against a
 *    view another operator has since changed, or replayed from the shell history, is refused;
 *  - the rules and the write run in ONE immediate transaction, so nothing lands between them;
 *  - the one ops line carries ids, the result, the reason code and the operator: never a name, a
 *    registry value or a reason's text. `company:show` writes no ops line at all, and is the only
 *    command that prints a declarant's name.
 *
 * Check rows and legal-body events are kept for ever: a reason must hold no personal data, and the
 * registered agent is recorded by name only.
 */

/** Every reason, check or legal body, is kept for ever: what the help says about it. */
const REASON_HELP = "why, at most 300 characters; kept for ever, so no personal data";
const EXPECT_LATEST_HELP =
  "the company's latest check id, as company:show prints it, or none when it has no check";

const OPERATOR_NAME = /^[a-z0-9._-]{2,40}$/;
const CHECK_ID = /^[1-9][0-9]{0,15}$/;
/** The filing-number rule a declaration's filing number was held to. */
const FILING_NUMBER = /^[0-9A-Za-z-]{4,32}$/;
/** A sha256 as an operator may paste it: with or without 0x, in either case. */
const SHA256_TYPED = /^(?:0[xX])?([0-9a-fA-F]{64})$/;
const MAX_REASON_CODE_POINTS = 300;
/** Control, format and other invisible characters, as the check rows refuse them. */
const OTHER_CHARACTER = /\p{C}/u;
/** A space other than the plain one (a non-breaking space, a thin space, a line separator). The
 *  check rows admit it, but the company-name key collapses plain spaces only, so a registry text
 *  pasted with one would never match what it says. */
const NON_PLAIN_SPACE = /(?! )\p{Z}/u;
/** The kind an upload was made under, from its provider document id `upload:<kind>:<sha256>`. */
const UPLOAD_KIND = /^upload:([a-z]+):/;

/** The options of each result, as [option key, flag]: a check needs its own result's options and
 *  refuses the other's. */
type OptionTable = readonly (readonly [keyof CheckOptions, string])[];
const PASSED_ONLY: OptionTable = [
  ["registryName", "--registry-name"],
  ["registryFilingId", "--registry-filing-id"],
  ["registryStatus", "--registry-status"],
  ["formationDate", "--formation-date"],
  ["registeredAgent", "--registered-agent"],
  ["existenceEvidence", "--existence-evidence"],
  ["controlEvidence", "--control-evidence"],
  ["controlEvidenceKind", "--control-evidence-kind"],
];
const FAILED_ONLY: OptionTable = [
  ["reasonCode", "--reason-code"],
  ["reason", "--reason"],
];
/** The registry texts a passed check copies from the registry, as [option key, flag]. */
const REGISTRY_TEXTS: OptionTable = [
  ["registryName", "--registry-name"],
  ["registryStatus", "--registry-status"],
  ["registeredAgent", "--registered-agent"],
];

/**
 * The company-name key two names are compared by: upper case; commas and full stops removed; then
 * runs of spaces collapsed to one and the spaces at the ends trimmed. `Example Holdings, L.L.C.`
 * and `EXAMPLE HOLDINGS LLC` are one name.
 */
export function companyNameKeyOf(name: string): string {
  return name
    .toUpperCase()
    .replace(/[,.]/g, "")
    .replace(/ {2,}/g, " ")
    .replace(/^ +| +$/g, "");
}

function refuse(message: string): never {
  throw new Error(`refusing: ${message}`);
}

function parseOperator(value: string): string {
  if (!OPERATOR_NAME.test(value)) refuse(`--operator must match ${OPERATOR_NAME.source}`);
  return value;
}

/** A check id, or null for `none` when `none` is allowed. */
function parseExpectLatest(value: string, allowNone: boolean): number | null {
  if (allowNone && value === "none") return null;
  if (!CHECK_ID.test(value))
    refuse(`--expect-latest must be a check id${allowNone ? " or none" : ""}`);
  return Number(value);
}

/** Text of 1 to 300 code points with no control or invisible character. */
function parseReason(value: string): string {
  if (value.length === 0) refuse("--reason must not be empty");
  if ([...value].length > MAX_REASON_CODE_POINTS)
    refuse(`--reason must be at most ${MAX_REASON_CODE_POINTS} characters`);
  if (OTHER_CHARACTER.test(value))
    refuse("--reason must not hold a control, format or other invisible character");
  return value;
}

/** The sha256 in the one spelling the check rows and the upload index keep: 0x, lower case. */
function parseSha256(option: string, value: string): Hex {
  const digits = SHA256_TYPED.exec(value)?.[1];
  if (digits === undefined) refuse(`${option} must be 64 hex digits, with or without 0x`);
  return `0x${digits.toLowerCase()}`;
}

function sha256Of(bytes: Uint8Array): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The OS user running the command, recorded on every check beside the operator's name. */
function osUser(): string {
  try {
    const name = userInfo().username;
    if (name) return name;
  } catch {
    // No passwd entry for this uid: fall back to the login environment below.
  }
  const fromEnv = process.env.USER ?? process.env.LOGNAME;
  if (fromEnv) return fromEnv;
  refuse("the OS user running this command cannot be read, and every check records it");
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function print(output: Record<string, unknown>): void {
  console.log(JSON.stringify(output, null, 2));
}

interface Stores {
  db: Database.Database;
  companies: SqliteCompanyRepository;
  declarations: SqliteCompanyDeclarationRepository;
  checks: SqliteCompanyCheckRepository;
  documents: SqliteDocumentIndexRepository;
}

/**
 * Opens the database the configuration names (never a path of its own: an operator who moved the
 * data directory must not open a different, empty database), runs `fn`, and closes it.
 */
function withDatabase<T>(fn: (db: Database.Database, docStoreDir: string) => T): T {
  loadDotenv();
  const cfg = loadConfig();
  const db = openDatabase(cfg.dbPath);
  try {
    return fn(db, cfg.docStoreDir);
  } finally {
    db.close();
  }
}

function storesOf(db: Database.Database): Stores {
  return {
    db,
    companies: new SqliteCompanyRepository(db),
    declarations: new SqliteCompanyDeclarationRepository(db),
    checks: new SqliteCompanyCheckRepository(db),
    documents: new SqliteDocumentIndexRepository(db),
  };
}

function findCompany(s: Stores, companyId: string): CompanyRecord {
  const company = s.companies.find(companyId);
  if (!company) refuse(`no company ${companyId}`);
  return company;
}

/** Only a declaration is checked: a company filed through formation has none. */
function assertDeclared(company: CompanyRecord): void {
  if (company.provider !== CUSTOMER_PROVIDER)
    refuse(
      `company ${company.companyId} was not declared by its customer (provider ${company.provider}), so it has no declaration to check`,
    );
}

function assertExpectedLatest(
  companyId: string,
  latest: CompanyCheck | undefined,
  expected: number | null,
): void {
  const actual = latest?.checkId ?? null;
  if (actual !== expected)
    refuse(
      `the latest check of company ${companyId} is ${actual ?? "none"}, not ${expected ?? "none"}: another operator has written since, or this command came from the shell history. Run company:show ${companyId} and decide again`,
    );
}

/**
 * Reads a store file's bytes, or undefined when the file is not there. Any other failure (a
 * directory, a permission, a name that escapes the store) is thrown.
 */
function readStored(docStore: DocumentStore, name: string): Buffer | undefined {
  try {
    return docStore.getBytes(name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * The control evidence: one of the company's uploads of kind `control`, its bytes present, and
 * those bytes, read again from the store now, still hashing to it.
 */
function assertControlEvidence(
  s: Stores,
  docStore: DocumentStore,
  companyId: string,
  sha256: Hex,
): void {
  const upload = (kind: string) => {
    const row = s.documents.findByProviderDocId(companyId, `upload:${kind}:${sha256}`);
    return row?.source === "customer" ? row : undefined;
  };
  const doc = upload("control");
  if (doc === undefined) {
    if (upload("existence") !== undefined)
      refuse(
        "--control-evidence names an upload of kind existence: name one of the company's control uploads",
      );
    refuse(`--control-evidence matches no upload of company ${companyId}`);
  }
  if (doc.bytesDeletedAt !== null)
    refuse(
      "the bytes of that control upload were deleted: ask the customer to upload it again, and check it then",
    );
  const bytes = readStored(docStore, doc.path);
  if (bytes === undefined)
    refuse(`the bytes of that control upload are not in the document store (${doc.path})`);
  if (sha256Of(bytes) !== sha256)
    refuse(
      "the stored bytes of that control upload no longer hash to it: record no check on them, and find out why the file changed",
    );
}

/**
 * The shared body of the four check commands: in ONE immediate transaction, the company, the rules
 * that read only the company, the latest check against `--expect-latest`, the rules that read the
 * latest check, and (with `--yes`) the append. Then the ops line, and the output.
 */
function recordCheck<F>(p: {
  s: Stores;
  row: NewCompanyCheck;
  expected: number | null;
  yes: boolean;
  /** Refusals that read only the company. What it returns is handed to `stateRules`. */
  companyRules: (company: CompanyRecord) => F;
  /** Refusals that read the latest check too, once it is the one the operator expected. */
  stateRules?: (facts: F, latest: CompanyCheck | undefined) => void;
}): void {
  const { s, row, expected, yes } = p;
  // The shape first, so a dry run refuses whatever the append would.
  validateCompanyCheck(row);
  const found = s.db
    .transaction(() => {
      const company = findCompany(s, row.companyId);
      const facts = p.companyRules(company);
      const latest = s.checks.latest(row.companyId);
      assertExpectedLatest(row.companyId, latest, expected);
      p.stateRules?.(facts, latest);
      return { company, latest, appended: yes ? s.checks.append(row) : undefined };
    })
    .immediate();

  if (found.appended === undefined) {
    print({
      recorded: false,
      company: {
        companyId: found.company.companyId,
        provider: found.company.provider,
        status: found.company.status,
      },
      latestCheck: found.latest ?? null,
      wouldRecord: row,
      next: "nothing was written: run the same command with --yes to record this",
    });
    return;
  }
  const check = found.appended;
  opsLog("company_check_recorded", {
    companyId: check.companyId,
    checkId: check.checkId,
    result: check.result,
    reasonCode: check.reasonCode,
    operator: check.operator,
  });
  print({ recorded: true, check });
}

// ── company:show ─────────────────────────────────────────────────────────────────────────────

function showCompany(s: Stores, docStoreDir: string, companyId: string): Record<string, unknown> {
  const docStore = new FileDocumentStore(docStoreDir);
  const company = findCompany(s, companyId);
  const declaration = s.declarations.find(companyId);
  const checks = s.checks.list(companyId);
  const uploads = s.documents
    .listByCompany(companyId)
    .filter((doc) => doc.source === "customer")
    .map((doc) => ({
      docId: doc.id,
      kind: UPLOAD_KIND.exec(doc.providerDocId)?.[1] ?? doc.docType,
      sha256: doc.sha256,
      size: doc.size,
      path: resolve(docStoreDir, doc.path),
      uploadedAt: doc.createdAt,
      expiresAt: doc.expiresAt,
      bytesDeletedAt: doc.bytesDeletedAt,
      bytesPresent: doc.bytesDeletedAt === null && readStored(docStore, doc.path) !== undefined,
    }));
  const otherCompaniesWithSameFiling = declaration
    ? s.declarations
        .listByFilingKey(declaration.filingKey)
        .map((d) => d.companyId)
        .filter((id) => id !== companyId)
    : [];
  return {
    company: {
      companyId: company.companyId,
      tenantId: company.tenantId,
      provider: company.provider,
      status: company.status,
      environment: company.environment,
      createdAt: company.createdAt,
    },
    declaration: declaration
      ? {
          // Null once the company was abandoned and the declaration erased.
          declarantName: declaration.declarantName,
          declarantTitle: declaration.declarantTitle,
          piiErasedAt: declaration.piiErasedAt,
          companyName: declaration.companyName,
          jurisdiction: declaration.jurisdiction,
          filingNumber: declaration.filingNumber,
          filingKey: declaration.filingKey,
          wordingVersion: declaration.wordingVersion,
          issuedAt: declaration.issuedAt,
          tenantId: declaration.tenantId,
          synthetic: declaration.synthetic,
          createdAt: declaration.createdAt,
        }
      : null,
    latestCheckId: checks.at(-1)?.checkId ?? null,
    checks,
    uploads,
    otherCompaniesWithSameFiling,
  };
}

// ── company:check ────────────────────────────────────────────────────────────────────────────

interface CheckOptions {
  result: string;
  operator: string;
  expectLatest: string;
  registryName?: string;
  registryFilingId?: string;
  registryStatus?: string;
  formationDate?: string;
  registeredAgent?: string;
  existenceEvidence?: string;
  controlEvidence?: string;
  controlEvidenceKind?: string;
  reasonCode?: string;
  reason?: string;
  yes?: boolean;
}

function checkCompany(companyId: string, opts: CheckOptions): void {
  if (opts.result !== "passed" && opts.result !== "failed")
    refuse("--result must be passed or failed (a revocation is company:revoke)");
  const passed = opts.result === "passed";
  const operator = parseOperator(opts.operator);
  const expected = parseExpectLatest(opts.expectLatest, true);
  const [own, other] = passed ? [PASSED_ONLY, FAILED_ONLY] : [FAILED_ONLY, PASSED_ONLY];
  for (const [key, flag] of other)
    if (opts[key] !== undefined) refuse(`${flag} is not taken with --result ${opts.result}`);
  const missing = own.filter(([key]) => opts[key] === undefined).map(([, flag]) => flag);
  if (missing.length > 0) refuse(`--result ${opts.result} needs ${missing.join(", ")}`);
  const base = { companyId, operator, operatorOsUser: osUser(), checkedAt: nowSeconds() };

  if (!passed) {
    const row: NewCompanyCheck = {
      ...base,
      result: "failed",
      registryName: null,
      registryFilingId: null,
      registryStatus: null,
      formationDate: null,
      registeredAgent: null,
      existenceEvidenceSha256: null,
      controlEvidenceSha256: null,
      controlEvidenceKind: null,
      reasonCode: opts.reasonCode as CheckReasonCode,
      reason: parseReason(opts.reason as string),
    };
    withDatabase((db) =>
      recordCheck({
        s: storesOf(db),
        row,
        expected,
        yes: opts.yes === true,
        companyRules: assertDeclared,
        stateRules: (_company, latest) => {
          if (latest?.result === "passed")
            refuse(
              `the latest check of company ${companyId} passed: a failed check does not undo it. Use company:revoke`,
            );
        },
      }),
    );
    return;
  }

  // Held to the filing-number rule before anything else is asked of it, so a typo is answered as
  // one and not as a filing that does not match.
  const registryFilingId = opts.registryFilingId as string;
  if (!FILING_NUMBER.test(registryFilingId))
    refuse("--registry-filing-id must be 4 to 32 characters of A-Z, a-z, 0-9 and hyphens");
  // Refused as a typing problem, never answered as a name that does not match.
  for (const [key, flag] of REGISTRY_TEXTS)
    if (NON_PLAIN_SPACE.test(opts[key] as string))
      refuse(`${flag} holds a space other than a plain space: retype it`);
  const controlSha256 = parseSha256("--control-evidence", opts.controlEvidence as string);
  const row: NewCompanyCheck = {
    ...base,
    result: "passed",
    registryName: opts.registryName as string,
    registryFilingId,
    registryStatus: opts.registryStatus as string,
    formationDate: opts.formationDate as string,
    registeredAgent: opts.registeredAgent as string,
    existenceEvidenceSha256: parseSha256("--existence-evidence", opts.existenceEvidence as string),
    controlEvidenceSha256: controlSha256,
    controlEvidenceKind: opts.controlEvidenceKind as ControlEvidenceKind,
    reasonCode: null,
    reason: null,
  };
  withDatabase((db, docStoreDir) => {
    const s = storesOf(db);
    const docStore = new FileDocumentStore(docStoreDir);
    recordCheck({
      s,
      row,
      expected,
      yes: opts.yes === true,
      companyRules: (company): CompanyDeclaration => {
        assertDeclared(company);
        if (company.status === "abandoned") refuse(`company ${companyId} is abandoned`);
        const declaration = s.declarations.find(companyId);
        if (!declaration) refuse(`company ${companyId} has no declaration`);
        if (declaration.piiErasedAt !== null)
          refuse(`the declaration of company ${companyId} was erased`);
        return declaration;
      },
      stateRules: (declaration) => {
        if (filingKeyOf(registryFilingId) !== declaration.filingKey)
          refuse(
            "--registry-filing-id is not the filing the declaration names, so this is not a passed check: record --result failed --reason-code filing_not_found",
          );
        if (
          companyNameKeyOf(row.registryName as string) !== companyNameKeyOf(declaration.companyName)
        )
          refuse(
            "--registry-name is not the declared company name, so this is not a passed check: record --result failed --reason-code name_mismatch",
          );
        assertControlEvidence(s, docStore, companyId, controlSha256);
        const elsewhere = s.checks.passedElsewhere(declaration.filingKey, companyId);
        if (elsewhere !== undefined)
          refuse(
            `company ${elsewhere} holds a passed check for the same filing: resolve the dispute, and revoke one of the two (company:revoke) before this one can pass`,
          );
      },
    });
  });
}

// ── company:revoke, company:reinstate ────────────────────────────────────────────────────────

interface StateChangeOptions {
  operator: string;
  expectLatest: string;
  reason: string;
  yes?: boolean;
}

function revokeOrReinstate(
  result: "revoked" | "reinstated",
  companyId: string,
  opts: StateChangeOptions,
): void {
  const operator = parseOperator(opts.operator);
  // A reinstatement follows a revocation, so there is always a check to name.
  const expected = parseExpectLatest(opts.expectLatest, result === "revoked");
  const row: NewCompanyCheck = {
    companyId,
    result,
    operator,
    operatorOsUser: osUser(),
    checkedAt: nowSeconds(),
    registryName: null,
    registryFilingId: null,
    registryStatus: null,
    formationDate: null,
    registeredAgent: null,
    existenceEvidenceSha256: null,
    controlEvidenceSha256: null,
    controlEvidenceKind: null,
    reasonCode: null,
    reason: parseReason(opts.reason),
  };
  withDatabase((db) =>
    recordCheck({
      s: storesOf(db),
      row,
      expected,
      yes: opts.yes === true,
      // Any provider: a company filed through formation can be revoked, and reinstated.
      companyRules: () => undefined,
      stateRules:
        result === "reinstated"
          ? (_company, latest) => {
              if (latest?.result !== "revoked")
                refuse(
                  `the latest check of company ${companyId} is ${latest?.result ?? "none"}, not revoked: only a revocation is reinstated`,
                );
            }
          : undefined,
    }),
  );
}

// ── legal-body:revoke ────────────────────────────────────────────────────────────────────────

function revokeLegalBody(legalBodyId: string, opts: Omit<StateChangeOptions, "expectLatest">) {
  const operator = parseOperator(opts.operator);
  const reason = parseReason(opts.reason);
  const actor = `operator:${operator}` as const;
  withDatabase((db) => {
    const bodies = new SqliteLegalBodyRepository(db);
    // The repository's transaction is immediate.
    const found = bodies.transaction(() => {
      const body = bodies.findById(legalBodyId);
      if (!body) refuse(`no legal body ${legalBodyId}`);
      const prior = bodies.listEvents(legalBodyId).find((e) => e.kind === "revoked");
      if (prior)
        refuse(
          `legal body ${legalBodyId} is already revoked (event ${prior.id}, by ${prior.actor}): a revocation is not undone, and a new order is needed`,
        );
      if (!opts.yes) return { body, event: undefined };
      bodies.recordEvent(legalBodyId, "revoked", actor, null, { reason });
      const event = bodies.listEvents(legalBodyId).at(-1);
      // Unreachable: the event was appended in this transaction, and events are never deleted.
      if (event?.kind !== "revoked") throw new Error(`legal body ${legalBodyId}: no revoked event`);
      return { body, event };
    });
    const legalBody = {
      legalBodyId: found.body.legalBodyId,
      publicId: found.body.publicId,
      companyId: found.body.companyId,
      bindingState: found.body.bindingState,
    };
    if (found.event === undefined) {
      print({
        recorded: false,
        legalBody,
        wouldRecord: { kind: "revoked", actor, detail: { reason } },
        next: "nothing was written: run the same command with --yes to record this",
      });
      return;
    }
    opsLog("legal_body_revoked", {
      legalBodyId: found.body.legalBodyId,
      companyId: found.body.companyId,
      eventId: found.event.id,
      result: "revoked",
      operator,
    });
    print({ recorded: true, legalBody, event: found.event });
  });
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────

export function registerCompanyCheckCommands(program: Command): void {
  program
    .command("company:show")
    .argument("<companyId>", "the company to show")
    .description(
      "show a company's declaration (the declarant's name included), its checks, its uploads and the other companies declaring the same filing",
    )
    .action((companyId: string) =>
      withDatabase((db, docStoreDir) => print(showCompany(storesOf(db), docStoreDir, companyId))),
    );

  program
    .command("company:check")
    .argument("<companyId>", "the customer's company whose declaration was checked")
    .description(
      "record the check of a customer's declaration, passed or failed. Rows are kept for ever: no personal data in a reason, and the registered agent by name only, no address",
    )
    .requiredOption("--result <passed|failed>", "the outcome of the check")
    .requiredOption("--operator <name>", `who checked: ${OPERATOR_NAME.source}`)
    .requiredOption("--expect-latest <checkId|none>", EXPECT_LATEST_HELP)
    .option("--registry-name <text>", "passed: the company's name as the registry shows it")
    .option("--registry-filing-id <text>", "passed: the filing id as the registry shows it")
    .option("--registry-status <text>", "passed: the status the registry shows")
    .option("--formation-date <YYYY-MM-DD>", "passed: the formation date the registry shows")
    .option(
      "--registered-agent <text>",
      "passed: the registered agent's name only, no address (kept for ever)",
    )
    .option(
      "--existence-evidence <sha256>",
      "passed: the sha256 of your own registry printout, with or without 0x",
    )
    .option(
      "--control-evidence <sha256>",
      "passed: the sha256 of the customer's control upload you checked, with or without 0x",
    )
    .option(
      "--control-evidence-kind <ein_letter|articles_and_resolution|other>",
      "passed: what the control upload is",
    )
    .option(
      "--reason-code <code>",
      "failed: name_mismatch, filing_not_found, not_active, control_not_shown or other",
    )
    .option("--reason <text>", `failed: ${REASON_HELP}`)
    .option("--yes", "confirm: record the check")
    .action((companyId: string, opts: CheckOptions) => checkCompany(companyId, opts));

  program
    .command("company:revoke")
    .argument("<companyId>", "the company to revoke, of any provider")
    .description(
      "revoke a company: a new check row. Rows are kept for ever: no personal data in the reason",
    )
    .requiredOption("--operator <name>", `who revokes: ${OPERATOR_NAME.source}`)
    .requiredOption("--expect-latest <checkId|none>", EXPECT_LATEST_HELP)
    .requiredOption("--reason <text>", REASON_HELP)
    .option("--yes", "confirm: record the revocation")
    .action((companyId: string, opts: StateChangeOptions) =>
      revokeOrReinstate("revoked", companyId, opts),
    );

  program
    .command("company:reinstate")
    .argument("<companyId>", "the revoked company to reinstate, of any provider")
    .description(
      "undo a revocation made by mistake: a new check row, after which a customer's company waits for a new check. Rows are kept for ever: no personal data in the reason",
    )
    .requiredOption("--operator <name>", `who reinstates: ${OPERATOR_NAME.source}`)
    .requiredOption(
      "--expect-latest <checkId>",
      "the company's latest check id, the revocation, as company:show prints it",
    )
    .requiredOption("--reason <text>", REASON_HELP)
    .option("--yes", "confirm: record the reinstatement")
    .action((companyId: string, opts: StateChangeOptions) =>
      revokeOrReinstate("reinstated", companyId, opts),
    );

  program
    .command("legal-body:revoke")
    .argument("<legalBodyId>", "the legal body to revoke")
    .description(
      "revoke a legal body: a revoked event, which cannot be undone (a new order is needed). Events are kept for ever: no personal data in the reason",
    )
    .requiredOption("--operator <name>", `who revokes: ${OPERATOR_NAME.source}`)
    .requiredOption("--reason <text>", REASON_HELP)
    .option("--yes", "confirm: record the revocation")
    .action((legalBodyId: string, opts: Omit<StateChangeOptions, "expectLatest">) =>
      revokeLegalBody(legalBodyId, opts),
    );
}
