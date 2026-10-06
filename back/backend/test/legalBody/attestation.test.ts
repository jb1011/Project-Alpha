import Database from "better-sqlite3";
import { type Hex, getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type Attestation,
  type VerificationState,
  attestationFactsFor,
  deriveAttestationState,
  publicCompanyNames,
  verificationStateOf,
} from "../../src/legalBody/attestation";
import {
  type CompanyCheck,
  type CompanyCheckResult,
  type NewCompanyCheck,
  SqliteCompanyCheckRepository,
} from "../../src/persistence/companyCheckRepository";
import { SqliteCompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import {
  type CompanyStatus,
  SqliteCompanyRepository,
} from "../../src/persistence/companyRepository";
import { migrate } from "../../src/persistence/db";
import type { FormationRequestRecord } from "../../src/persistence/formationRepository";

/** Invented values only: no real person, company, filing number or wallet. */
const TENANT = getAddress("0x00000000000000000000000000000000000000a1");
const FACTORY = getAddress("0x00000000000000000000000000000000000000f1");
/** A 32-byte value: one byte, written as two hex digits, repeated. */
const H = (byte: string) => `0x${byte.repeat(32)}` as Hex;
/** The time of the i-th check of a history, in unix seconds: one minute apart. */
const at = (i: number) => 1_790_000_000 + i * 60;
/** A provider other than "customer": a company filed through formation. The rules treat every
 *  such provider alike, so the tests use an invented one. */
const FORMATION = "example-formation-provider";

let db: Database.Database;
let companies: SqliteCompanyRepository;
let checks: SqliteCompanyCheckRepository;
let declarations: SqliteCompanyDeclarationRepository;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  companies = new SqliteCompanyRepository(db);
  checks = new SqliteCompanyCheckRepository(db);
  declarations = new SqliteCompanyDeclarationRepository(db);
});
afterEach(() => db.close());

/** A check in the shape the operator records it: a pass carries the registry's facts and both
 *  evidence hashes, anything else a reason. */
function checkOf(
  companyId: string,
  result: CompanyCheckResult,
  checkedAt: number,
): NewCompanyCheck {
  const none: NewCompanyCheck = {
    companyId,
    result,
    operator: "ops.example",
    operatorOsUser: "ops",
    checkedAt,
    registryName: null,
    registryFilingId: null,
    registryStatus: null,
    formationDate: null,
    registeredAgent: null,
    existenceEvidenceSha256: null,
    controlEvidenceSha256: null,
    controlEvidenceKind: null,
    reasonCode: null,
    reason: null,
  };
  switch (result) {
    case "passed":
      return {
        ...none,
        registryName: "Example Holdings LLC",
        registryFilingId: "TEST-0001",
        registryStatus: "Active",
        formationDate: "2024-02-29",
        registeredAgent: "Example Registered Agent LLC",
        existenceEvidenceSha256: H("e1"),
        controlEvidenceSha256: H("c1"),
        controlEvidenceKind: "ein_letter",
      };
    case "failed":
      return { ...none, reasonCode: "filing_not_found", reason: "No filing under this number." };
    case "revoked":
      return { ...none, reason: "Recorded in error." };
    case "reinstated":
      return { ...none, reason: "The revocation was the error." };
  }
}

/** Records the checks in order, one minute apart, and reads back the company's latest. */
function history(companyId: string, results: CompanyCheckResult[]): CompanyCheck | undefined {
  results.forEach((result, i) => checks.append(checkOf(companyId, result, at(i))));
  return checks.latest(companyId);
}

function company(companyId: string, provider: string, status: CompanyStatus = "draft"): void {
  companies.create({
    companyId,
    tenantId: TENANT,
    status: "draft",
    provider,
    environment: "sandbox",
    synthetic: false,
    nameOptions: [{ name: "Example Holdings", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "placeholder",
    industryLabel: "placeholder",
    intakeSynthesized: false,
  });
  if (status !== "draft") expect(companies.setStatus(companyId, "draft", status)).toBe(true);
}

function step(
  companyId: string,
  name: FormationRequestRecord["step"],
  state: FormationRequestRecord["state"],
): FormationRequestRecord {
  return {
    companyId,
    step: name,
    state,
    attempt: 0,
    providerRef: null,
    detail: null,
    error: null,
    nextPollAt: null,
    createdAt: "2026-09-01 12:00:00",
    updatedAt: "2026-09-01 12:00:00",
    factsUpdatedAt: "2026-09-01 12:00:00",
  };
}

describe("deriveAttestationState", () => {
  interface Case {
    provider: string;
    checks: CompanyCheckResult[];
    formationFiled?: boolean;
    paid: boolean;
    bodyRevoked?: boolean;
    expected: Attestation;
  }
  const unestablished = { established: false, controlVerified: false, existenceCheckedAt: null };

  test.each<[string, Case]>([
    [
      "a customer company not checked yet, paid",
      {
        provider: "customer",
        checks: [],
        paid: true,
        expected: { state: "pending", ...unestablished },
      },
    ],
    [
      "a customer company verified, not paid",
      {
        provider: "customer",
        checks: ["passed"],
        paid: false,
        expected: {
          state: "pending",
          established: true,
          controlVerified: true,
          existenceCheckedAt: at(0),
        },
      },
    ],
    [
      "a customer company verified and paid",
      {
        provider: "customer",
        checks: ["passed"],
        paid: true,
        expected: {
          state: "active",
          established: true,
          controlVerified: true,
          existenceCheckedAt: at(0),
        },
      },
    ],
    [
      "a customer company whose check failed",
      {
        provider: "customer",
        checks: ["failed"],
        paid: true,
        expected: { state: "pending", ...unestablished },
      },
    ],
    [
      "a customer company revoked after it passed",
      {
        provider: "customer",
        checks: ["passed", "revoked"],
        paid: true,
        expected: { state: "revoked", ...unestablished },
      },
    ],
    [
      "a customer company reinstated after a revocation reads pending until checked again",
      {
        provider: "customer",
        checks: ["passed", "revoked", "reinstated"],
        paid: true,
        expected: { state: "pending", ...unestablished },
      },
    ],
    [
      "a formation company filed and paid, reinstated after a revocation, is active",
      {
        provider: FORMATION,
        checks: ["revoked", "reinstated"],
        formationFiled: true,
        paid: true,
        expected: {
          state: "active",
          established: true,
          controlVerified: false,
          existenceCheckedAt: null,
        },
      },
    ],
    [
      "a customer company passed again after a reinstatement",
      {
        provider: "customer",
        checks: ["passed", "revoked", "reinstated", "passed"],
        paid: true,
        expected: {
          state: "active",
          established: true,
          controlVerified: true,
          existenceCheckedAt: at(3),
        },
      },
    ],
    [
      "a customer company passed again directly after a revocation",
      {
        provider: "customer",
        checks: ["passed", "revoked", "passed"],
        paid: true,
        expected: {
          state: "active",
          established: true,
          controlVerified: true,
          existenceCheckedAt: at(2),
        },
      },
    ],
    [
      "a formation company filed and paid, with no check, is active",
      {
        provider: FORMATION,
        checks: [],
        formationFiled: true,
        paid: true,
        expected: {
          state: "active",
          established: true,
          controlVerified: false,
          existenceCheckedAt: null,
        },
      },
    ],
    [
      "a formation company not filed",
      {
        provider: FORMATION,
        checks: [],
        formationFiled: false,
        paid: true,
        expected: { state: "pending", ...unestablished },
      },
    ],
    [
      "a customer company is established by a passed check alone, never by a filing",
      {
        provider: "customer",
        checks: [],
        formationFiled: true,
        paid: true,
        expected: { state: "pending", ...unestablished },
      },
    ],
    [
      "a formation company is established by its filing alone, never by a passed check",
      {
        provider: FORMATION,
        checks: ["passed"],
        formationFiled: false,
        paid: true,
        expected: { state: "pending", ...unestablished },
      },
    ],
    [
      "a formation company revoked at the company level, though filed and paid",
      {
        provider: FORMATION,
        checks: ["revoked"],
        formationFiled: true,
        paid: true,
        expected: {
          state: "revoked",
          established: true,
          controlVerified: false,
          existenceCheckedAt: null,
        },
      },
    ],
    [
      "a revoked legal body over a verified and paid customer company",
      {
        provider: "customer",
        checks: ["passed"],
        paid: true,
        bodyRevoked: true,
        expected: {
          state: "revoked",
          established: true,
          controlVerified: true,
          existenceCheckedAt: at(0),
        },
      },
    ],
    [
      "a revoked legal body over a filed and paid formation company",
      {
        provider: FORMATION,
        checks: [],
        formationFiled: true,
        paid: true,
        bodyRevoked: true,
        expected: {
          state: "revoked",
          established: true,
          controlVerified: false,
          existenceCheckedAt: null,
        },
      },
    ],
  ])("%s", (_name, c) => {
    const attestation = deriveAttestationState({
      provider: c.provider,
      latestCheck: history("co_1", c.checks),
      formationFiled: c.formationFiled ?? false,
      paid: c.paid,
      bodyRevoked: c.bodyRevoked ?? false,
    });
    expect(attestation).toEqual(c.expected);
  });
});

describe("verificationStateOf", () => {
  test.each<[string, CompanyCheckResult[], VerificationState]>([
    ["no check", [], "awaiting_check"],
    ["a passed check", ["passed"], "verified"],
    ["a failed check", ["failed"], "failed"],
    ["a revocation", ["passed", "revoked"], "revoked"],
    ["a reinstatement", ["passed", "revoked", "reinstated"], "awaiting_check"],
  ])("%s", (_name, results, expected) => {
    expect(verificationStateOf(history("co_1", results))).toBe(expected);
  });
});

describe("attestationFactsFor", () => {
  test("an unknown company has no facts", () => {
    const formationSteps = vi.fn((): FormationRequestRecord[] => []);
    expect(attestationFactsFor({ companies, checks, formationSteps }, "co_unknown", false)).toBe(
      undefined,
    );
  });

  test("a customer company: its latest check, paid once ready, and never a formation filing", () => {
    company("co_customer", "customer", "ready");
    checks.append(checkOf("co_customer", "failed", at(0)));
    const passed = checks.append(checkOf("co_customer", "passed", at(1)));
    // Steps that would read as filed are not even asked for.
    const formationSteps = vi.fn(() => [
      step("co_customer", "create_provider", "confirmed"),
      step("co_customer", "await_filing", "confirmed"),
    ]);
    const facts = attestationFactsFor({ companies, checks, formationSteps }, "co_customer", false);
    expect(facts).toEqual({
      provider: "customer",
      latestCheck: passed,
      formationFiled: false,
      paid: true,
      bodyRevoked: false,
    });
    expect(formationSteps).not.toHaveBeenCalled();
    expect(facts && deriveAttestationState(facts).state).toBe("active");
  });

  test("a formation company filed, and one not filed", () => {
    company("co_filed", FORMATION, "ready");
    company("co_unfiled", FORMATION, "draft");
    const steps: Record<string, FormationRequestRecord[]> = {
      co_filed: [
        step("co_filed", "create_provider", "confirmed"),
        step("co_filed", "await_filing", "confirmed"),
      ],
      co_unfiled: [
        step("co_unfiled", "create_provider", "confirmed"),
        step("co_unfiled", "await_filing", "pending"),
      ],
    };
    const deps = { companies, checks, formationSteps: (id: string) => steps[id] ?? [] };

    expect(attestationFactsFor(deps, "co_filed", false)).toEqual({
      provider: FORMATION,
      latestCheck: undefined,
      formationFiled: true,
      paid: true,
      bodyRevoked: false,
    });
    expect(attestationFactsFor(deps, "co_unfiled", true)).toEqual({
      provider: FORMATION,
      latestCheck: undefined,
      formationFiled: false,
      paid: false,
      bodyRevoked: true,
    });
  });
});

describe("publicCompanyNames", () => {
  /** A customer company and its declaration, as stored. */
  function declared(companyId: string, digest: Hex) {
    company(companyId, "customer");
    declarations.insert({
      companyId,
      tenantId: TENANT,
      humanNullifier: "nullifier-0001",
      declarantName: "Ada Example",
      declarantTitle: "Manager",
      statementText: "Example statement of authority, written for tests.",
      statementHash: H("a1"),
      statementDigest: digest,
      signature: `0x${"1b".repeat(65)}` as Hex,
      companyName: "Example Holdings LLC",
      jurisdiction: "WY",
      filingNumber: "TEST-0001",
      wordingVersion: "2026-10-draft-1",
      chainId: 31_337,
      factory: FACTORY,
      issuedAt: at(0),
      synthetic: false,
    });
    return declarations.find(companyId);
  }
  const NAMES = { legalName: "Example Holdings LLC", filingNumber: "TEST-0001" };

  test("names the company only while its latest check is a pass", () => {
    const d = declared("co_1", H("d1"));
    const names = () => publicCompanyNames(d, checks.latest("co_1"));

    expect(names()).toBeNull(); // before any check
    checks.append(checkOf("co_1", "failed", at(1)));
    expect(names()).toBeNull(); // after a failed check
    checks.append(checkOf("co_1", "passed", at(2)));
    expect(names()).toEqual(NAMES);
    checks.append(checkOf("co_1", "revoked", at(3)));
    expect(names()).toBeNull(); // after a revocation
    checks.append(checkOf("co_1", "reinstated", at(4)));
    expect(names()).toBeNull(); // a reinstatement waits for a new check
    checks.append(checkOf("co_1", "passed", at(5)));
    expect(names()).toEqual(NAMES);
  });

  test("names nothing without a declaration, nor for an erased one, even under a passed check", () => {
    declared("co_1", H("d1"));
    checks.append(checkOf("co_1", "passed", at(1)));
    expect(publicCompanyNames(undefined, checks.latest("co_1"))).toBeNull();
    expect(publicCompanyNames(declarations.find("co_1"), checks.latest("co_1"))).toEqual(NAMES);

    expect(companies.setStatus("co_1", "draft", "abandoned")).toBe(true);
    expect(declarations.erasePii("co_1", at(2))).toBe(true);
    const erased = declarations.find("co_1");
    expect(erased?.piiErasedAt).toBe(at(2));
    expect(publicCompanyNames(erased, checks.latest("co_1"))).toBeNull();
  });

  test("another company's passed check names nothing", () => {
    const unchecked = declared("co_1", H("d1"));
    declared("co_2", H("d2"));
    checks.append(checkOf("co_2", "passed", at(1)));
    expect(publicCompanyNames(unchecked, checks.latest("co_2"))).toBeNull();
  });
});
