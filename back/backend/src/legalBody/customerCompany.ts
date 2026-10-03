import type { Address, Hex } from "viem";
import { type WorldIdDeps, assertRealHuman } from "../api/routes/worldId";
import { ApiError } from "../errors";
import { NAME_CHARSET_SOURCE } from "../formation/intake";
import { opsLog } from "../observability/opsLog";
import type { CompanyCheckRepository } from "../persistence/companyCheckRepository";
import type { CompanyDeclarationRepository } from "../persistence/companyDeclarationRepository";
import type { CompanyRepository } from "../persistence/companyRepository";
import type { GuardianVerification } from "../persistence/worldStore";
import { sqliteUtcTimestamp } from "../util/sqliteTime";
import {
  buildStatementMessage,
  statementDigest,
  statementHash,
  verifyStatement,
} from "./statement";
import { type LegalText, assertTextsServable } from "./texts/index";
import type { StatementFields } from "./texts/statementOfAuthority";

/**
 * A CUSTOMER'S OWN COMPANY: an existing Wyoming LLC that its guardian declares, with a signed
 * statement of authority, as the company behind a legal body. It is a `companies` row with the
 * provider `customer`, beside one `company_declarations` row that holds exactly what was signed.
 * Nothing is filed here and nothing is confirmed: the declaration is the declarant's word until the
 * operator checks it.
 *
 * The create runs its checks in this order, and writes nothing until every one has passed:
 *  1. a real human: a verified credential, never a waiver, whatever the enforcement switch says;
 *  2. the wording can be served: a production deployment refuses a draft;
 *  3. the synthetic rule: a production declaration is never synthetic and a sandbox one always is,
 *     and on a sandbox the declarant is a fixture, never a name the caller typed;
 *  4. the field rules, and the shape of `issuedAt` and of the signature;
 *  4a. the same statement with the same signature, already used by this tenant, is answered with
 *     its company before any cap: a client that retries after a lost response must not be refused
 *     by the cap its own first request filled;
 *  5. the human's company cap, when one is set;
 *  6. the tenant's caps: open customer companies, and declarations in the last 24 hours;
 *  7. the signature, checked by local recovery over the sentence the server renders itself.
 * Then ONE transaction writes the company and its declaration. It looks the statement up and counts
 * the caps again first, because step 7 awaits and another request can have written meanwhile;
 * better-sqlite3 transactions are synchronous, so nothing else in this process runs between that
 * lookup and the inserts.
 *
 * The filing number is not unique here: two tenants may declare the same LLC, and the operator's
 * check decides.
 */

/** The provider value of a customer's own company. */
export const CUSTOMER_PROVIDER = "customer";
/** The business purpose and the industry of a customer's company: both columns are required, and
 *  an existing company has no formation intake to take them from. */
export const CUSTOMER_COMPANY_PLACEHOLDER = "not applicable: an existing company";
/** The declarant of every sandbox declaration. A sandbox takes no name from its caller, so no real
 *  person's name can be stored there. */
export const SYNTHETIC_DECLARANT = { name: "Novi Sandbox Declarant", title: "Manager" } as const;
/** Customer companies one tenant may create in 24 hours, abandoned ones included. */
export const CUSTOMER_COMPANIES_PER_TENANT_PER_DAY = 5;

export interface CustomerCompanyDeps {
  companies: CompanyRepository;
  declarations: CompanyDeclarationRepository;
  checks: CompanyCheckRepository;
  world: WorldIdDeps | undefined;
  chainId: number;
  /** The deployment's legal-body factory: the `verifyingContract` of the statement's domain. */
  factory: Address;
  environment: "sandbox" | "production";
  /** The wording new declarations are made under: the composition passes STATEMENT_OF_AUTHORITY.
   *  Every step reads this one, never the constant. */
  text: LegalText<StatementFields>;
  maxOpenPerTenant: number;
  /** True: a new company lands `draft`, owing its payment. False: it lands `ready`. */
  paymentRequired: boolean;
  /** Whether the company stands behind a legal body that is still open. Until that lookup is
   *  wired, the composition passes `() => false`. */
  hasOpenLegalBody: (companyId: string) => boolean;
  transaction: <T>(fn: () => T) => T;
  now?: () => number;
}

export interface CustomerStatementInput {
  /** Typed by a production caller. A sandbox refuses both and uses SYNTHETIC_DECLARANT. */
  declarantName?: string;
  declarantTitle?: string;
  companyName: string;
  filingNumber: string;
  synthetic?: boolean;
}

export interface CustomerCompanyInput extends CustomerStatementInput {
  /** The `issuedAt` of the typed data that was signed: unix seconds, in decimal. */
  issuedAt: string;
  signature: Hex;
}

/** One field that broke a rule. `problem` names the rule, never the value. */
interface FieldProblem {
  field: string;
  problem: string;
}

/** Every field a body may carry, read as what it is at run time: unknown. */
type Body = Partial<Record<keyof CustomerCompanyInput, unknown>>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `issuedAt` on the wire: unix seconds in canonical decimal, at most 16 digits. */
const ISSUED_AT_WIRE = /^(0|[1-9][0-9]{0,15})$/;
/** `0x` and whole bytes of hex. Whether it is a signature the statement accepts (65 bytes that
 *  recover to the guardian) is step 7's question, not the shape's. */
const SIGNATURE_WIRE = /^0x(?:[0-9a-fA-F]{2})+$/;

/** A control, format (a zero-width character, a direction override), surrogate, private-use or
 *  unassigned character. */
const CONTROL_OR_INVISIBLE = /\p{C}/u;
/** A separator other than U+0020: a non-breaking space, a line separator, an ideographic space. */
const OTHER_SPACE = /(?! )\p{Z}/u;
const SPACES_AT_THE_ENDS = /^ +| +$/g;
const SPACE_RUNS = / {2,}/g;

interface TextRule {
  /** Inclusive, in code points, after the spaces are normalised. */
  min: number;
  max: number;
  /** The characters the field may hold, as a whole-string test. */
  chars: RegExp;
  charsProblem: string;
  /** A further pattern the value must match. */
  also?: { pattern: RegExp; problem: string };
}

const DECLARANT_NAME: TextRule = {
  min: 2,
  max: 120,
  chars: /^[\p{L}\p{M} '.-]+$/u,
  charsProblem: "may hold only letters, spaces, apostrophes, hyphens and full stops",
};
const DECLARANT_TITLE: TextRule = {
  min: 2,
  max: 80,
  chars: /^[\p{L}\p{M}0-9 '.&/,-]+$/u,
  charsProblem:
    "may hold only letters, digits, spaces, apostrophes, hyphens, full stops, &, / and commas",
};
/** The characters the formation intake accepts in a Wyoming entity name. */
const COMPANY_NAME: TextRule = {
  min: 2,
  max: 200,
  chars: new RegExp(`^[${NAME_CHARSET_SOURCE}]+$`),
  charsProblem:
    "may hold only the characters a Wyoming entity name takes: A-Z, a-z, 0-9, spaces and & ' - , . ( ) +",
};
const FILING_NUMBER: TextRule = {
  min: 4,
  max: 32,
  chars: /^[0-9A-Za-z-]+$/,
  charsProblem: "may hold only A-Z, a-z, 0-9 and hyphens",
};
/** On a sandbox, a test number, so a sandbox declaration can never name a real Wyoming filing. */
const SANDBOX_FILING_NUMBER: TextRule = {
  ...FILING_NUMBER,
  also: {
    pattern: /^TEST-[0-9A-Z-]{4,27}$/,
    problem: "must be a test number on this deployment: TEST- then 4 to 27 of A-Z, 0-9 and hyphens",
  },
};

/**
 * One field through the field rules, in their order: NFC; then a field holding a control or
 * invisible character, a space other than U+0020, or a double quote is refused, never cleaned (a
 * tab or a non-breaking space is not turned into a space); then the U+0020 at the ends are stripped
 * and runs of them collapsed to one; then the length, in code points, and the characters.
 * Returns the normalised value, or records the problem and returns undefined.
 */
function applyTextRule(
  field: string,
  raw: unknown,
  rule: TextRule,
  problems: FieldProblem[],
): string | undefined {
  const refuse = (problem: string): undefined => {
    problems.push({ field, problem });
    return undefined;
  };
  if (raw === undefined || raw === null) return refuse("is required");
  if (typeof raw !== "string") return refuse("must be text");
  const nfc = raw.normalize("NFC");
  if (CONTROL_OR_INVISIBLE.test(nfc)) return refuse("holds a control or invisible character");
  if (OTHER_SPACE.test(nfc)) return refuse("holds a space other than a plain space");
  if (nfc.includes('"')) return refuse("holds a double quote");
  const value = nfc.replace(SPACES_AT_THE_ENDS, "").replace(SPACE_RUNS, " ");
  const length = [...value].length;
  if (length < rule.min || length > rule.max)
    return refuse(`must be ${rule.min} to ${rule.max} characters long`);
  if (!rule.chars.test(value)) return refuse(rule.charsProblem);
  if (rule.also && !rule.also.pattern.test(value)) return refuse(rule.also.problem);
  return value;
}

/** The wire half of step 4, for the create door: `issuedAt` and the signature, well-formed. */
function readSignedPart(
  body: Body,
  problems: FieldProblem[],
): { issuedAt: bigint; signature: Hex } | undefined {
  const { issuedAt, signature } = body;
  const issuedAtOk = typeof issuedAt === "string" && ISSUED_AT_WIRE.test(issuedAt);
  if (!issuedAtOk)
    problems.push({
      field: "issuedAt",
      problem: issuedAt == null ? "is required" : "must be unix seconds, written in decimal",
    });
  const signatureOk = typeof signature === "string" && SIGNATURE_WIRE.test(signature);
  if (!signatureOk)
    problems.push({
      field: "signature",
      problem: signature == null ? "is required" : "must be 0x followed by whole bytes of hex",
    });
  if (!issuedAtOk || !signatureOk) return undefined;
  return { issuedAt: BigInt(issuedAt), signature: signature as Hex };
}

/**
 * Steps 1 to 4. `readMore` runs after the field rules, so the problems it records come after
 * theirs, and both are answered as one refusal.
 */
function prepare<T>(
  deps: CustomerCompanyDeps,
  tenantId: Address,
  input: CustomerStatementInput,
  readMore: (body: Body, problems: FieldProblem[]) => T | undefined,
): { verification: GuardianVerification; fields: StatementFields; more: T } {
  // 1. A real human, and the row whose nullifier the declaration will name.
  const verification = assertRealHuman(deps.world, tenantId, deps.environment);

  // 2. Throws LegalTextNotApprovedError; the doors answer it as `legal_text_not_approved`.
  assertTextsServable(deps.environment, [deps.text]);

  // A body that is not an object carries no field at all.
  const body: Body = typeof input === "object" && input !== null ? input : {};

  // 3. The synthetic rule, keyed on the deployment. Only a sandbox is sandbox: any other value is
  //    held to the production rule, as the two checks above hold it.
  const sandbox = deps.environment === "sandbox";
  if (sandbox) {
    if (body.synthetic !== true)
      throw new ApiError(
        "synthetic_rule",
        400,
        "a sandbox deployment takes only a synthetic declaration: send synthetic: true",
      );
    if (body.declarantName !== undefined || body.declarantTitle !== undefined)
      throw new ApiError(
        "synthetic_declarant_only",
        400,
        "a sandbox declaration names the sandbox declarant: leave out declarantName and declarantTitle",
      );
  } else if (body.synthetic !== undefined && body.synthetic !== false) {
    throw new ApiError(
      "synthetic_rule",
      400,
      "a production deployment does not take a synthetic declaration",
    );
  }

  // 4. The field rules. Every bad field is named once, in this order.
  const problems: FieldProblem[] = [];
  const declarantName = sandbox
    ? SYNTHETIC_DECLARANT.name
    : applyTextRule("declarantName", body.declarantName, DECLARANT_NAME, problems);
  const declarantTitle = sandbox
    ? SYNTHETIC_DECLARANT.title
    : applyTextRule("declarantTitle", body.declarantTitle, DECLARANT_TITLE, problems);
  const companyName = applyTextRule("companyName", body.companyName, COMPANY_NAME, problems);
  const filingNumber = applyTextRule(
    "filingNumber",
    body.filingNumber,
    sandbox ? SANDBOX_FILING_NUMBER : FILING_NUMBER,
    problems,
  );
  const more = readMore(body, problems);
  if (
    problems.length > 0 ||
    declarantName === undefined ||
    declarantTitle === undefined ||
    companyName === undefined ||
    filingNumber === undefined ||
    more === undefined
  )
    throw new ApiError("validation_error", 400, "some fields of the declaration are not valid", [
      ...problems,
    ]);

  return {
    verification,
    fields: {
      declarantName,
      declarantTitle,
      companyName,
      jurisdiction: "WY",
      filingNumber,
      // Exactly as the session spells it (checksummed): the statement must name the wallet in the
      // one spelling its verification accepts.
      guardian: tenantId,
    },
    more,
  };
}

/** Steps 1 to 4: the human, the texts, the synthetic rule, the fields. Used by both doors. */
export function prepareCustomerStatement(
  deps: CustomerCompanyDeps,
  tenantId: Address,
  input: CustomerStatementInput,
): { verification: GuardianVerification; fields: StatementFields } {
  const { verification, fields } = prepare(deps, tenantId, input, () => null);
  return { verification, fields };
}

/** Steps 5 and 6. Run before the signature's check, and again inside the transaction. */
function assertCaps(
  deps: CustomerCompanyDeps,
  tenantId: Address,
  verification: GuardianVerification,
  nowMs: number,
): void {
  // 5. The human's company cap, which counts every company of this human, formation ones included.
  const world = deps.world;
  const humanCap = world?.maxCompaniesPerHuman;
  if (world !== undefined && humanCap != null) {
    const used = world.store.countCompaniesForNullifier(verification.nullifier, world.cfg.action);
    if (used >= humanCap)
      throw new ApiError(
        "guardian_company_cap",
        403,
        `this human already controls ${used} companies (max ${humanCap})`,
      );
  }
  // 6. The tenant's open customer companies, then its declarations in the last 24 hours.
  const open = deps.companies.countCustomerOpenByTenant(tenantId);
  if (open >= deps.maxOpenPerTenant)
    throw new ApiError(
      "customer_company_cap",
      409,
      `this tenant already has ${open} declared companies open (max ${deps.maxOpenPerTenant})`,
    );
  const recent = deps.declarations.countCreatedSince(tenantId, sqliteUtcTimestamp(nowMs - DAY_MS));
  if (recent >= CUSTOMER_COMPANIES_PER_TENANT_PER_DAY)
    throw new ApiError(
      "customer_company_rate",
      429,
      `this tenant has declared ${recent} companies in the last 24 hours (max ${CUSTOMER_COMPANIES_PER_TENANT_PER_DAY})`,
    );
}

/**
 * Creates a customer's company from a signed statement of authority, or answers the company an
 * earlier request already created from the same statement (`created: false`).
 */
export async function createCustomerCompany(
  deps: CustomerCompanyDeps,
  tenantId: Address,
  input: CustomerCompanyInput,
): Promise<{ companyId: string; created: boolean }> {
  // One instant for the whole request: the caps' window and the statement's freshness.
  const nowMs = (deps.now ?? Date.now)();

  // Steps 1 to 4, with the shape of `issuedAt` and the signature.
  const {
    verification,
    fields,
    more: { issuedAt, signature },
  } = prepare(deps, tenantId, input, readSignedPart);

  // 4a. A replay. The digest needs no signature; the stored signature must equal this one.
  const digest = statementDigest(
    deps.chainId,
    deps.factory,
    buildStatementMessage(fields, deps.text, issuedAt),
  );
  const replayed = deps.declarations.findByDigest(tenantId, digest);
  if (replayed !== undefined && replayed.signature === signature)
    return { companyId: replayed.companyId, created: false };

  // 5 and 6.
  assertCaps(deps, tenantId, verification, nowMs);

  // 7. The signature, over the sentence the server renders from these fields and its own wording.
  const verdict = await verifyStatement({
    chainId: deps.chainId,
    factory: deps.factory,
    tenant: tenantId,
    text: deps.text,
    fields,
    issuedAt,
    signature,
    nowSeconds: BigInt(Math.floor(nowMs / 1000)),
  });
  if (!verdict.ok) {
    if (verdict.problem === "stale")
      throw new ApiError(
        "statement_stale",
        400,
        "the statement was issued too long ago, or too far ahead of the server's clock: ask for a new one and sign it",
      );
    throw new ApiError(
      "statement_not_valid",
      400,
      "the signature is not the guardian's over this statement",
    );
  }
  const { message } = verdict;
  const synthetic = deps.environment === "sandbox";

  // 8. One transaction. A thrown refusal rolls it back, and nothing has been written before it.
  const result = deps.transaction((): { companyId: string; created: boolean } => {
    const used = deps.declarations.findByDigest(tenantId, verdict.digest);
    if (used !== undefined) return { companyId: used.companyId, created: false };
    assertCaps(deps, tenantId, verification, nowMs);
    const companyId = deps.companies.create({
      tenantId,
      status: deps.paymentRequired ? "draft" : "ready",
      provider: CUSTOMER_PROVIDER,
      environment: deps.environment,
      synthetic,
      nameOptions: [{ name: fields.companyName, entityTypeEnding: "LLC", position: 1 }],
      businessPurpose: CUSTOMER_COMPANY_PLACEHOLDER,
      industryLabel: CUSTOMER_COMPANY_PLACEHOLDER,
      intakeSynthesized: false,
    });
    deps.declarations.insert({
      companyId,
      tenantId,
      humanNullifier: verification.nullifier,
      declarantName: fields.declarantName,
      declarantTitle: fields.declarantTitle,
      statementText: message.statement,
      statementHash: statementHash(message),
      statementDigest: verdict.digest,
      signature,
      companyName: fields.companyName,
      jurisdiction: fields.jurisdiction,
      filingNumber: fields.filingNumber,
      wordingVersion: message.wordingVersion,
      chainId: deps.chainId,
      factory: deps.factory,
      // Inside the statement's time window by now, so a safe integer.
      issuedAt: Number(issuedAt),
      synthetic,
    });
    // No payment quote here: when one may be written is the payment flow's rule.
    return { companyId, created: true };
  });

  // 9. Ids and flags only: never a name, a title or a filing number.
  if (result.created)
    opsLog("customer_company_created", {
      companyId: result.companyId,
      tenantPrefix: tenantId.slice(0, 10),
      environment: deps.environment,
      synthetic,
    });
  return result;
}

function conflict(message: string): ApiError {
  return new ApiError("conflict", 409, message);
}

/**
 * The tenant abandons its own customer company, while nobody has checked it, no payment is live or
 * settled and no legal body stands open on it. In one transaction, the status moves to `abandoned`
 * by compare-and-set from the one it has, and the declarant's personal data is erased; if either
 * fails, neither happens.
 *
 * An unknown company and another tenant's get one answer, 404: telling them apart would make this
 * an existence oracle over company ids. Every other refusal is a 409 `conflict`.
 */
export function abandonCustomerCompany(
  deps: CustomerCompanyDeps,
  tenantId: Address,
  companyId: string,
): void {
  const atSeconds = Math.floor((deps.now ?? Date.now)() / 1000);
  deps.transaction(() => {
    const company = deps.companies.findOwned(tenantId, companyId);
    if (company === undefined) throw new ApiError("not_found", 404, "company not found");
    if (company.provider !== CUSTOMER_PROVIDER)
      throw conflict("only a declared company can be abandoned this way");
    if (company.status !== "draft" && company.status !== "ready")
      throw conflict("this company is already abandoned");
    if (deps.checks.latest(companyId) !== undefined)
      throw conflict("the operator has checked this company's declaration, so it is kept");
    if (deps.companies.hasLiveOrSettledPayment(companyId))
      throw conflict("this company has a payment, so it is kept");
    if (deps.hasOpenLegalBody(companyId))
      throw conflict("this company stands behind an open legal body");
    if (!deps.companies.setStatus(companyId, company.status, "abandoned"))
      throw conflict("this company changed while it was being abandoned");
    // Thrown, so the status change rolls back with it: an abandoned company must not keep a
    // declarant's personal data because its erasure failed.
    if (!deps.declarations.erasePii(companyId, atSeconds))
      throw new Error(`company ${companyId}: its declaration could not be erased`);
  });
}
