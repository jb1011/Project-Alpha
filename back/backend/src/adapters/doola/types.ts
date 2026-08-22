/**
 * doola Partner API wire types (design 2026-08-19 §2/§5/§9).
 *
 * ⚠ CORRECTED IN PR 2 against the published OpenAPI document
 * (`https://docs.doola.com/api-reference/openapi.json`, re-fetched 2026-08-21) and a live
 * sandbox probe. PR 1 modeled these from the design prose, and the prose was a paraphrase: the
 * real surface is mounted under a `/v1/partner` prefix, the customer carries a
 * `countryOfResidence` rather than an address, the company create is a much richer document
 * (addresses / responsibleParty / members / industry / description), and every response id is
 * spelled `doolaCompanyId` / `doolaCustomerId`. Those are not stylistic differences — every one
 * of them is a 404 or a 422 against the live host, so the shapes below are the wire, verbatim.
 *
 * Only the fields we actually consume are modeled. The API is a partner surface that will grow
 * fields we do not know about, so every response type is a narrow READ shape — never a
 * round-trippable mirror — and unknown extras are simply ignored.
 *
 * Two conventions the API enforces and we must not paper over:
 *  - countries are ISO-3166-1 **alpha-3** ("USA", "FRA"), not alpha-2;
 *  - the US state is a 2-letter code on input ("WY").
 */

/**
 * Which doola environment a client, a deployment or a single ENTITY is pinned to.
 *
 * Exported from here and imported EVERYWHERE (config, manifest, views, the API surface) rather
 * than re-typed inline: the honesty invariant (§2) says a sandbox filing must never render as a
 * real one, and an inline copy is how one surface quietly grows a third value — or drops one.
 */
export type DoolaEnvironment = "sandbox" | "production";

/** ISO-3166-1 alpha-3 country code, e.g. "USA". Aliased for readability at the call sites. */
export type Iso3Country = string;

/** doola only forms these two. (No DAO-LLC entityType — that question is open with Halyna.) */
export type DoolaEntityType = "LLC" | "CCorp";

/** `PartnerAddressDto`. NOTE the field is `state`, not `region`: our PII table calls the column
 *  `region` because most countries have no state/province, and the mapping happens at the one
 *  call site that builds this (workflow/formationProvider.ts). */
export interface DoolaAddress {
  line1: string;
  line2?: string;
  city: string;
  /** US: the 2-letter state code. The OpenAPI document marks this REQUIRED on every address,
   *  which sits awkwardly with the countries that have no state/province — a §9 item to settle
   *  against the live API before the first non-US production filing. */
  state?: string;
  postalCode: string;
  country: Iso3Country;
  /** E.164. **REQUIRED on a natural person's address** (responsible party, member, executive
   *  member) — live sandbox 2026-08-21 answers `E_REQUEST_BODY_INVALID: Address Phone number
   *  cannot be null or empty` without it. Optional on a company mailing/business address. */
  phone?: string;
}

/** `CreateCustomerRequestDto`. The customer carries NO address — the postal addresses of the
 *  natural person ride on the company create's `responsibleParty` / `members` instead. */
export interface CreateCustomerInput {
  firstName: string;
  lastName: string;
  email: string;
  /** ISO-3 country of residence. NON-US here is half of the §9 expedited-EIN signal. */
  countryOfResidence: Iso3Country;
  /** E.164 when present. */
  phoneNumber?: string;
}

/** `PartnerCustomerResponseDto`. */
export interface DoolaCustomer {
  doolaCustomerId: string;
  email?: string;
  /** false when doola matched an EXISTING customer instead of creating one. */
  created?: boolean;
  /** Only the GET endpoint returns this. */
  companies?: { doolaCompanyId: string; name?: string }[];
}

/** `PartnerCompanyNameOptionDto` — the name WITHOUT its entity ending, plus the ending. */
export interface DoolaNameOption {
  name: string;
  entityTypeEnding: string;
  /** 1 = first choice. */
  position?: number;
}

/** `PartnerResponsiblePartyDto` — the natural person legally answerable for the company. */
export interface DoolaResponsibleParty {
  legalFirstName: string;
  legalLastName: string;
  email: string;
  address?: DoolaAddress;
  /** Absent = a NON-US applicant, which is what drives the SS-4 signature flow (§9). */
  ssn?: string;
}

/** `PartnerCompanyAddressDto`. `provider: "registeredAgent"` makes doola fill in its own
 *  registered-agent address for the state — which is how an AGENT, who has no premises, gets a
 *  mailing and a business address at all. `address` is then omitted and ignored. */
export interface DoolaCompanyAddress {
  provider: "customer" | "registeredAgent";
  type: "mailing" | "business";
  address?: DoolaAddress;
}

/** `PartnerCompanyMemberDto`. Ownership across all members must total 100. */
export interface DoolaCompanyMember {
  legalFirstName?: string;
  legalLastName?: string;
  contactFullName?: string;
  isNaturalPerson: boolean;
  address: DoolaAddress;
  ownershipPercent: number;
  ssn?: string;
}

/** `RequestedServiceDto`. Today only the EIN service is configurable, and `Expedite` REQUIRES a
 *  non-US applicant — as a deployment default it would break every US-founder formation (§9). */
export interface DoolaRequestedService {
  service: "EinCreation";
  variant: "Standard" | "Expedite";
}

/** `CreateCompanyRequest`. `addresses`, `description`, `doolaCustomerId`, `nameOptions`,
 *  `responsibleParty` and `state` are REQUIRED by the API; `members` is required for an LLC. */
export interface CreateCompanyInput {
  doolaCustomerId: string;
  entityType: DoolaEntityType;
  /** Formation state, 2-letter (we form in "WY"). */
  state: string;
  /** Ordered name preferences (1–3); exhausting them is one of doola's two required-actions. */
  nameOptions: DoolaNameOption[];
  /** The `industry` label from GET /references/naics-codes. Preferred over the deprecated
   *  `naicsCode`. */
  industry: string;
  description: string;
  responsibleParty: DoolaResponsibleParty;
  /** Exactly two entries: one `mailing`, one `business`. */
  addresses: DoolaCompanyAddress[];
  members: DoolaCompanyMember[];
  requestedServices?: DoolaRequestedService[];
}

/** `PartnerCompanyResponse` (and, for the fields they share, `PartnerCompanyListItemDto`). */
export interface DoolaCompany {
  doolaCompanyId: string;
  doolaCustomerId?: string;
  /** Present on the LIST item; the full response carries `nameOptions` instead. */
  name?: string;
  entityType?: DoolaEntityType;
  state?: string;
  nameOptions?: (DoolaNameOption & { id?: string })[];
  /** doola's intake status for the formation REQUEST — not "the company is formed". Their words:
   *  PENDING | SUBMITTED | FAILED. Humanized for the tenant, never re-interpreted as truth. */
  formationSubmissionStatus?: string;
  ein?: string | null;
  /** yyyy-MM-dd, once the state has filed it. */
  formationFilingDate?: string | null;
  formationFilingNumber?: string | null;
  services?: { name?: string; variant?: string; status?: string; subStatus?: string }[];
  /** Present on non-US applicants: what still has to be signed (SS-4 / 8821). */
  signatureRequirements?: { documentType?: string; status?: string }[];
}

/** `PartnerSearchPagePartnerCompanyListItemDto` — the paged wrapper on GET /companies. */
export interface DoolaCompanyPage {
  content?: DoolaCompany[] | null;
  page?: number;
  size?: number;
  total?: number;
  totalPages?: number;
}

/** `DocumentDto`. NOTE `documentType`, not `type` — e.g. "ArticlesOfOrganization",
 *  "OperatingAgreement", "EinLetter", "SignedSS4". */
export interface DoolaDocument {
  id: string;
  companyId?: string;
  name?: string;
  contentType?: string;
  documentType?: string | null;
  lastModified?: string;
  createdAt?: string | null;
}

/** `DocumentDownloadUrlDto`. ~1h expiry and NOT single-use (fact-check correction) — the expiry
 *  window, HTTPS-only parsing and a streamed size cap are the controls, not one-shot-ness. */
export interface DoolaDocumentDownload extends DoolaDocument {
  downloadUrl: string;
}

/** `PartnerRequiredActionDto`. Only `FORMATION_NAME_OPTIONS_EXHAUSTED` is answerable through the
 *  resolution endpoint; `FORMATION_SIGNATURE_SS4_RESET` self-closes when the replacement
 *  signature completes. */
export interface DoolaRequiredAction {
  requiredActionId: string;
  doolaCompanyId?: string;
  actionCode: string;
  actionName?: string;
  status?: string;
  reason?: string;
  open?: boolean;
  updatedAt?: string;
}

/** `PartnerComplianceEventDto`. */
export interface DoolaComplianceEvent {
  type?: string;
  state?: string | null;
  nextDueDate?: string | null;
  lastFiledDate?: string | null;
  status?: string;
}

/** `PlaygroundActionResponse` — sandbox only. `triggeredEvents` names the webhooks the call
 *  fired, which is how the E2E runbook proves an event actually left doola. */
export interface DoolaPlaygroundResult {
  doolaCompanyId?: string;
  service?: string;
  triggeredEvents?: string[];
}

/** doola's error envelope. `payload` rides alongside `error` on failures. */
export interface DoolaErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    /** Field-level detail. Live shape is `{field: {code, message}}` — NOT the flat
     *  `{field: "reason"}` PR 1 assumed — so it is carried opaquely and only ever logged. */
    fields?: Record<string, unknown>;
    requestId?: string;
  };
  payload?: unknown;
}
