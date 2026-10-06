import { companyFiled } from "../formation/status";
import type { CompanyCheck, CompanyCheckRepository } from "../persistence/companyCheckRepository";
import type { CompanyDeclaration } from "../persistence/companyDeclarationRepository";
import type { CompanyRepository } from "../persistence/companyRepository";
import type { FormationRequestRecord } from "../persistence/formationRepository";
import { CUSTOMER_PROVIDER } from "./provider";

/**
 * A COMPANY'S STANDING, derived. Every answer here is a pure function of facts other modules own
 * (the company row, the operator's append-only checks, the formation steps, the legal body's
 * events), so nothing stores a standing that could drift from the facts it was read from. A
 * revocation and a reinstatement are new check rows, and the derivation reads only the latest.
 *
 * Two kinds of company stand behind a legal body:
 *  - a customer's company: an existing Wyoming LLC its guardian declared, established by the
 *    operator's passed check of that declaration;
 *  - a company filed through formation, established once the state confirms the filing.
 */

export type AttestationState = "pending" | "active" | "revoked";
export type VerificationState = "awaiting_check" | "verified" | "failed" | "revoked";

export interface AttestationFacts {
  provider: string;
  latestCheck: CompanyCheck | undefined; // any provider: a company-level revoke applies to all
  formationFiled: boolean; // a formation company whose filing is confirmed
  paid: boolean; // company.status === "ready"
  bodyRevoked: boolean; // a `revoked` event on the legal body
}

export interface Attestation {
  state: AttestationState;
  /** The company's existence is established: a passed check, or a confirmed filing. */
  established: boolean;
  /** The operator saw evidence that the declarant controls the company (customer only). */
  controlVerified: boolean;
  /** Unix seconds of the passed check that established a customer's company, else null. */
  existenceCheckedAt: number | null;
}

/**
 * The standing, in this order:
 *  1. `revoked` when the legal body is revoked, or the company's latest check is a revocation,
 *     whatever the provider. A reinstatement is not a revocation.
 *  2. `active` when the company is established and paid.
 *  3. `pending` otherwise.
 *
 * A customer's company is established only while its latest check is a pass: after a
 * reinstatement it reads `pending` until the operator checks it again. A formation company is
 * established by its confirmed filing, which a reinstatement falls back to.
 *
 * `established`, `controlVerified` and `existenceCheckedAt` describe the company whatever the
 * state, so a revoked body over a verified company still says what was verified, and when.
 */
export function deriveAttestationState(f: AttestationFacts): Attestation {
  const customerPassed = f.provider === CUSTOMER_PROVIDER && f.latestCheck?.result === "passed";
  const established = f.provider === CUSTOMER_PROVIDER ? customerPassed : f.formationFiled;
  const revoked = f.bodyRevoked || f.latestCheck?.result === "revoked";
  return {
    state: revoked ? "revoked" : established && f.paid ? "active" : "pending",
    established,
    controlVerified: customerPassed,
    existenceCheckedAt: customerPassed && f.latestCheck ? f.latestCheck.checkedAt : null,
  };
}

/** What the tenant is told about the operator's check of its declaration. A reinstatement waits
 *  for a new check, exactly like no check at all. */
export function verificationStateOf(latest: CompanyCheck | undefined): VerificationState {
  if (latest === undefined) return "awaiting_check";
  switch (latest.result) {
    case "passed":
      return "verified";
    case "failed":
      return "failed";
    case "revoked":
      return "revoked";
    case "reinstated":
      return "awaiting_check";
  }
}

/**
 * The facts `deriveAttestationState` reads, for one company, or `undefined` for an unknown
 * company. It only reads. A customer's company is never filed through formation, so its formation
 * steps are not even asked for.
 */
export function attestationFactsFor(
  deps: {
    companies: CompanyRepository;
    checks: CompanyCheckRepository;
    formationSteps: (companyId: string) => FormationRequestRecord[];
  },
  companyId: string,
  bodyRevoked: boolean,
): AttestationFacts | undefined {
  const company = deps.companies.find(companyId);
  if (!company) return undefined;
  return {
    provider: company.provider,
    latestCheck: deps.checks.latest(companyId),
    formationFiled:
      company.provider === CUSTOMER_PROVIDER ? false : companyFiled(deps.formationSteps(companyId)),
    // On a deployment that does not charge, a company is `ready` from creation.
    paid: company.status === "ready",
    bodyRevoked,
  };
}

/**
 * The names a public surface may show: null unless the latest check passed.
 *
 * Until the operator has checked a declaration, the LLC name and the filing number are only the
 * declarant's word, and they stay inside the tenant's own view. An erased declaration (its company
 * abandoned) is never named, and neither is a declaration paired with another company's check.
 */
export function publicCompanyNames(
  d: CompanyDeclaration | undefined,
  latest: CompanyCheck | undefined,
): { legalName: string; filingNumber: string } | null {
  if (d === undefined || d.piiErasedAt !== null) return null;
  if (latest?.result !== "passed" || latest.companyId !== d.companyId) return null;
  return { legalName: d.companyName, filingNumber: d.filingNumber };
}
