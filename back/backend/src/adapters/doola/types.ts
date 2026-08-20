/**
 * doola Partner API wire types (design 2026-08-19 §2/§5/§9), grounded in the live sandbox E2E
 * probe of 2026-08-14→19 (WY LLC formed, playground-completed, real 12-page OA PDF downloaded).
 *
 * Only the fields we actually consume are modeled. The API is a partner surface that will grow
 * fields we do not know about, so every response type is a narrow READ shape — never a
 * round-trippable mirror — and unknown extras are simply ignored.
 *
 * Two conventions the API enforces and we must not paper over:
 *  - countries are ISO-3166-1 **alpha-3** ("USA", "FRA"), not alpha-2;
 *  - the US state is a 2-letter code on input ("WY").
 */

/** ISO-3166-1 alpha-3 country code, e.g. "USA". Aliased for readability at the call sites. */
export type Iso3Country = string;

/** doola only forms these two. (No DAO-LLC entityType — that question is open with Halyna.) */
export type DoolaEntityType = "LLC" | "CCorp";

export interface DoolaAddress {
  line1: string;
  line2?: string;
  city: string;
  /** US: the 2-letter state code. Nullable everywhere else — most countries have no region. */
  region?: string;
  postalCode: string;
  country: Iso3Country;
}

export interface CreateCustomerInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  address: DoolaAddress;
  /** Absent = a NON-US founder, which is what drives the SS-4 signature flow (§9). */
  ssn?: string;
}

export interface DoolaCustomer {
  id: string;
  email?: string;
}

export interface CreateCompanyInput {
  customerId: string;
  /** Ordered name preferences; exhausting them is one of doola's two required-action codes. */
  nameOptions: string[];
  entityType: DoolaEntityType;
  /** Formation state, 2-letter (we form in "WY"). */
  state: string;
  /** Offered only when the applicant is non-US (§9) — as a deployment default it would break
   *  every US-founder formation. */
  expeditedEin?: boolean;
}

export interface DoolaCompany {
  id: string;
  /** doola's own sub-status string; humanized for the tenant, never re-interpreted as truth. */
  status?: string;
  name?: string;
  entityType?: DoolaEntityType;
  state?: string;
  ein?: string | null;
  /** Unix seconds, when doola reports it. */
  formationDate?: number | null;
  filingNumber?: string | null;
  /** Present on non-US applicants: what still has to be signed (SS-4). */
  signatureRequirements?: { type: string; status: string }[];
}

export interface DoolaDocument {
  id: string;
  /** e.g. "ArticlesOfOrganization", "OperatingAgreement", "SS4". */
  type: string;
  name?: string;
  contentType?: string;
  size?: number;
  createdAt?: string;
}

/** Signed download URL. ~1h expiry and NOT single-use (fact-check correction) — the expiry
 *  window, HTTPS-only parsing and a streamed size cap are the controls, not one-shot-ness. */
export interface DoolaDocumentDownload {
  url: string;
  expiresAt?: string;
}

/** Only `FORMATION_NAME_OPTIONS_EXHAUSTED` is answerable through the resolution endpoint;
 *  `FORMATION_SIGNATURE_SS4_RESET` self-closes when the replacement signature completes. */
export interface DoolaRequiredAction {
  code: string;
  message?: string;
  createdAt?: string;
}

export interface DoolaComplianceEvent {
  id?: string;
  type?: string;
  dueDate?: string;
  description?: string;
}

/** doola's error envelope. `payload` rides alongside `error` on failures. */
export interface DoolaErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    fields?: Record<string, string | string[]>;
    requestId?: string;
  };
  payload?: unknown;
}
