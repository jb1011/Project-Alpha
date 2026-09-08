/**
 * The formation lifecycle, as the backend derives it — ONE definition for this package.
 *
 * The literal union was written out twice here (the entity view and the transparency row) and
 * switched on with no default in the formation card. That is three places to update when the
 * backend's `src/formation/status.ts` grows a state, and the one that gets missed is the switch:
 * TypeScript is perfectly happy with an exhaustive switch over a union that is no longer the
 * backend's, and the card just renders nothing where a status line should be. A backend drift test
 * (`test/api/formationStatusUnion.test.ts`) asserts these members match the backend's, and the
 * card's switches carry a default for the window between a backend deploy and an interface one.
 *
 * Exported as a runtime array as well as a type, because "is this a status this build knows?" is a
 * question the card has to ask at runtime — of a value that arrived over the wire.
 */
export const FORMATION_STATUSES = [
  "none",
  "in_progress",
  "filed",
  "complete",
  "failed",
] as const;

export type FormationStatus = (typeof FORMATION_STATUSES)[number];

export function isKnownFormationStatus(value: string): value is FormationStatus {
  return (FORMATION_STATUSES as readonly string[]).includes(value);
}

export type EntityStatus =
  | "pending"
  | "provisioned"
  | "translating"
  | "created"
  | "bound"
  | "funded"
  | "failed";

export type EntityView = {
  id: string;
  name: string;
  status: EntityStatus;
  agentId: string | null;
  proxy: string | null;
  treasury: string | null;
  operator: string | null;
  manager: string;
  guardian: string;
  oaHash: string | null;
  metadataURI: string | null;
  createTxHash: string | null;
  bindTxHash: string | null;
  fundTxHash: string | null;
  error: string | null;
  perTxCap: string | null;
  /** Per-agent buyer trust dial; null = inherits the platform default. */
  trustPolicy: "open" | "verified-sellers-only" | "verified-legal-bodies-only" | null;
  /** WebAuthn credentialId of the guardian passkey registered at onboarding. */
  rootPasskeyId?: string | null;
  /** Tier-0 custody provider; null/absent = legacy row (behaves as "turnkey"). */
  walletProvider?: "turnkey" | "circle" | null;
  /** What `oaHash` COMMITS to. "legacy" = the operating-agreement document alone; "manifest" =
   *  the OA bundle manifest (terms doc + legal documents + chain identity), which is why the two
   *  are labelled differently. The backend decides the scheme with the same predicate it anchors
   *  with, so the UI never re-derives it from a version number. Optional for deploy-order safety:
   *  a backend that predates this field means "legacy". */
  oaAnchor?:
    | { scheme: "legacy"; hash: string | null }
    | {
        scheme: "manifest";
        hash: string | null;
        /** Anchored version; null while v1 is still in flight. */
        version: number | null;
        pendingHash: string | null;
        /** The in-flight version's number — a LABEL beside the pending hash, nothing more. The
         *  hash a guardian actually vetoes is read off the chain by the veto card itself. */
        pendingVersion?: number | null;
        /** Unix **SECONDS** the pending amendment becomes executable on-chain; null until the
         *  schedule tx confirmed. Optional for deploy-order safety: a backend that predates it
         *  has no countdown to show. */
        amendmentExecutableAt?: number | null;
      };
  /** Formation (doola). null/absent = stub, forever. `environment` is always present when the
   *  block is: a sandbox filing must render amber ("Demo formation"), never green. Never
   *  carries PII — no name, no address, no email. */
  formation?: {
    provider: string;
    environment: "sandbox" | "production";
    /**
     * HOW MANY AGENTS SHARE THIS FILING, including this one (§7 sharing labels).
     *
     * `1` means not shared. The TOTAL rather than "others": an off-by-one that lives in the field
     * is one every renderer inherits, so a UI that wants "shared with 2 others" subtracts once,
     * where the sentence is written. `null`/absent = this backend did not count — never "not
     * shared", because an attached entity always has at least itself.
     *
     * Owner-visible only: the public surfaces do not carry it, and a backend test asserts they
     * cannot grow it.
     */
    sharedWith?: number | null;
    /** OUR company id — what the document routes, the compliance calendar and the Companies
     *  section are addressed by. Owner-visible only, like `ein` and `documents`; the public
     *  surfaces carry doola's `providerRef` instead. Optional for deploy-order safety: a backend
     *  that predates A3 serves no company id, and the card then offers no download rather than
     *  building a URL out of an entity key the route no longer takes. */
    companyId?: string;
    /** Derived from the formation sub-saga: nothing opened / opened but nothing legally true
     *  yet / the state has FILED it / the EIN has issued / the filing step is in error. */
    status: FormationStatus;
    /** doola's company id — an opaque provider reference, not personal data. */
    providerRef?: string | null;
    /** Unix seconds the state filed the company. */
    filedAt?: number | null;
    filingNumber?: string | null;
    /** Owner-visible only: this field exists on the authenticated entity view and on no public
     *  surface. Never render it outside a signed-in owner's own dashboard. */
    ein?: string | null;
    /** Open required-action CODES (e.g. `FORMATION_NAME_OPTIONS_EXHAUSTED`) — never doola's
     *  free-text reason, which their operators write and can name the responsible party.
     *  Optional for deploy-order safety: a backend that predates this field has no actions. */
    requiredActions?: string[];
    /** Legal documents fetched from doola so far. Metadata only — the bytes come from
     *  `downloadDocument`, which re-asserts ownership server-side. */
    documents?: FormationDocument[];
  } | null;
};

/** One stored legal document. `sha256` is what a verifier recomputes from the downloaded bytes
 *  (and, from PR 3, what the on-chain OA bundle manifest commits to). */
export type FormationDocument = {
  id: string;
  /** doola's document type, e.g. "ArticlesOfOrganization" | "OperatingAgreement". */
  type: string;
  /** A safe, derived filename — never a provider-supplied string. */
  name: string;
  size: number;
  sha256: string;
};

/**
 * The legal identity of the natural person a filing names — the ONE personal-data shape in this
 * package, mirroring the backend's `FormationPartySchema` field for field.
 *
 * It exists only to travel: typed here, held in the wizard's non-persisted PII slice, POSTed to
 * `/formation-party`, and forgotten. It must never be written to localStorage, never enter a
 * React Query key, and never enter `AgentSpec` — the caller keeps the opaque `partyId` the
 * endpoint hands back and passes THAT to onboard.
 *
 * `phone` is REQUIRED (backend C6): doola refuses a company create whose responsible party has
 * no phone, so a party without one is an identity that can never be filed.
 */
export type FormationPartyInput = {
  legalFirstName: string;
  legalLastName: string;
  email: string;
  phone: string;
  address: {
    line1: string;
    /** Omitted entirely when blank — the backend schema is `.strict()` and rejects an empty one. */
    line2?: string;
    city: string;
    /** US: the 2-letter state. Absent for the countries that have no state/province. */
    region?: string;
    postalCode: string;
    /** ISO-3166-1 **alpha-3** ("USA", "FRA") — doola's convention, not alpha-2. */
    country: string;
  };
};

/** Public deployment capabilities (GET /config, unauthenticated) — lets the wizard preselect the
 *  platform default and never offer a custody option this deployment can't serve. */
export type PublicConfig = {
  walletProviderDefault: "turnkey" | "circle";
  circleCustodyAvailable: boolean;
  /** Optional for deploy-order safety: a backend that predates this field means "available"
   *  (every legacy deployment served turnkey). Mainnet ships false — circle-only. */
  turnkeyCustodyAvailable?: boolean;
  /** doola formation. Both are optional for deploy-order safety: a backend that predates them
   *  forms nothing, which is exactly what absent should mean. `formationEnvironment` is non-null
   *  whenever formation is available — the honesty invariant, and the reason the two are served
   *  as projections of one value rather than as independent flags. (Whether formation is
   *  REQUIRED is not advertised until the door gate that enforces it ships.) */
  formationAvailable?: boolean;
  formationEnvironment?: "sandbox" | "production" | null;
  /** Whether onboarding REFUSES without a partyId — i.e. whether the legal-identity step is
   *  mandatory or optional. Optional for deploy-order safety: a backend that predates it
   *  enforces nothing, which is exactly what absent should mean. */
  formationRequired?: boolean;
  /**
   * Whether a company must be PAID for before it can be filed (B1).
   *
   * Absent means false, and that is the honest reading rather than a convenience: a backend that
   * predates the field takes no payment, so the wizard says formation is included during the beta.
   * B1 ships the field and the payment step together; A3's wizard has neither.
   */
  formationPaymentRequired?: boolean;
  /** All-in fee in whole USDC, advertised so the beta copy can name what it is waiving (B1). */
  formationFeeUsdc?: number;
  /**
   * PRODUCT COPY the wizard and the Companies section render verbatim (§7).
   *
   * Served rather than bundled because every sentence makes a CLAIM about what the backend does —
   * that an SSN dies with the company id, that one edit buys one retry, that agents sharing a
   * company are publicly linkable. Copy in the browser bundle drifts from the code that keeps it,
   * silently, in the direction of the older promise.
   *
   * Optional for deploy-order safety: a backend that predates it serves none, and the surfaces
   * that need a sentence render nothing rather than a stale one of their own.
   */
  formationCopy?: {
    ssn: { label: string; help: string; retention: string };
    park: Record<
      "awaitingIntakeEdit" | "awaitingPartyEdit" | "awaitingSsnDecision",
      { title: string; what: string; youCan: string }
    >;
    reuseDisclosure: string;
  };
};

/** One row of the public transparency registry (GET /transparency, unauthenticated).
 *  USDC fields are atomic strings (6 decimals). */
export type TransparencyEntity = {
  publicId: string | null;
  name: string;
  agentId: string;
  status: string;
  legalManager: string | null;
  treasury: string | null;
  walletProvider: "turnkey" | "circle";
  humanVerified: boolean;
  /** World ID credential tier backing the guardian (e.g. "orb"), null when unverified. */
  credential: string | null;
  createdAt: string | null;
  jobsSettled: number;
  usdcSettledAtomic: string;
  /** Formation status + the environment it was filed in. null = a stub entity (every legacy
   *  row). Deliberately carries no EIN, no filing number and nothing about the natural person
   *  behind the entity — this surface is unauthenticated. */
  formation?: {
    status: FormationStatus;
    environment: "sandbox" | "production";
  } | null;
};

/** Public transparency surface: platform stats + the on-chain entity registry. */
export type TransparencyView = {
  stats: { entities: number; jobsSettled: number; usdcSettledAtomic: string };
  entities: TransparencyEntity[];
};

/** Real on-chain treasury state (from GET /entities/:id/treasury). All USDC fields are atomic strings (6 decimals). */
export type TreasuryView = {
  usdcBalance: string;
  available: string;
  cap: string;
  period: string;
  paused: boolean;
  /** Honest total un-clawback-able standing exposure (operator EOA + pocket EOA + Gateway), atomic
   *  USDC, plus the configured ceiling. See back/docs/design/2026-07-20-s2-interim-float-ceiling-design.md.
   *  null when the Gateway/standing-exposure read failed (degraded, not zero — see T6 hardening);
   *  the dashboard renders "—" for null, same as when standingExposure isn't configured at all. */
  standing: {
    operatorEoa: string;
    pocketEoa: string;
    gateway: string;
    total: string;
    ceiling: string;
  } | null;
  /** true when the entity's on-chain legal status is Active (LegalManager status() === 0); null
   *  when the on-chain legal-status read failed (degraded, not a fake default — rendered as "—"). */
  legalActive: boolean | null;
};

export type GuardianPasskey = {
  authenticatorName?: string;
  challenge: string;
  attestation: {
    credentialId: string;
    clientDataJson: string;
    attestationObject: string;
    transports: string[];
  };
};

export type AgentSpec = {
  name: string;
  jurisdiction?: string;
  roles: {
    manager: string;
    guardian: string;
    operator?: string;
  };
  treasury: {
    usdc?: string;
    payoutAddress: string;
    spendingCapUsdc: string;
    spendingPeriod: string;
    allowlistEnabled?: boolean;
    perTxCapUsdc?: string;
  };
  governance?: {
    amendmentDelay?: string;
  };
  legal?: {
    ein?: string;
    formationDate?: string;
  };
  metadata?: {
    description?: string;
    agentType?: string;
    capabilities?: string[];
    version?: string;
  };
};

export type AuthSession = {
  token: string;
  address: `0x${string}`;
  expiresAt: number;
};

export type RunPayment = { direction: "buy" | "sell"; counterparty: string; amount: string; transferId: string | null; status: string };
export type AgentRun = { id: string; query: string; cost: string; revenue: string; pnl: string; status: "completed" | "failed"; createdAt: number; payments: RunPayment[] };

export type ReputationView = {
  totalJobs: number;
  completed: number;
  reputed: number;
};

export type JobStatus =
  | "pending"
  | "created"
  | "funded"
  | "submitted"
  | "completed"
  | "reputed"
  | "failed";

export type JobView = {
  jobKey: string;
  jobId: string | null;
  entityKey: string;
  status: JobStatus;
  clientAddress: string;
  evaluatorAddress: string;
  providerAddress: string;
  budgetAmount: string;
  description: string;
  deliverableHash: string | null;
  deliverablePath: string | null;
  createTxHash: string | null;
  fundTxHash: string | null;
  submitTxHash: string | null;
  completeTxHash: string | null;
  sweepTxHash: string | null;
  reputationTxHash: string | null;
  error: string | null;
};

export type ApiKeyView = {
  id: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
  entityId: string | null;
  capability: Capability;
};

export type Capability = "read" | "earn" | "spend" | "provision";

export type ConnectionSnippets = {
  claudeCode: string;
  cursor: string;
  codex: string;
  openclaw: string;
  gemini: string;
  windsurf: string;
  cline: string;
  vscode: string;
  claudeDesktop: string;
  generic: string;
  hermes?: string; // present only if the backend Hermes snippet shipped (T1)
};

export type ConnectionPackage = {
  mcpUrl: string;
  apiKey: string;
  entityId: string;
  capability: Capability;
  snippets: ConnectionSnippets;
};

export type BootstrapPackage = {
  mcpUrl: string;
  apiKey: string;
  passkeyId: string;
  capability: Capability;
  linkCode: string;
  snippets: ConnectionSnippets;
};

export type PasskeyView = {
  id: string;
  name: string | null;
  createdAt: number;
  revokedAt: number | null;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
  };
};

/** World ID guardian verification (proof-of-personhood for the legally required human). */
export type WorldIdMe = {
  verified: boolean;
  required: boolean;
  credential?: string;
  verifiedAt?: number;
  /** Per-app pseudonym — the only identity datum stored, and the seed for the guardian seal. */
  nullifier?: string;
  entitiesUsed?: number;
  maxEntities?: number;
  /** Whether this deployment offers the identity step-up at all. */
  attestAvailable?: boolean;
  /** True when a live document-backed attestation is on file. */
  formationReady?: boolean;
  attestation?: { minAge: number; credential?: string | null; verifiedAt: number };
};

/** Params for the identity-attestation widget (the step-up uses its own World action). */
export type WorldIdAttestContext = {
  appId: string;
  action: string;
  environment: "production" | "staging" | "sandbox";
  signal: string;
  rpContext: Record<string, unknown>;
  minAge: number;
};

export type WorldIdContext = {
  appId: string;
  action: string;
  environment: "production" | "staging" | "sandbox";
  signal: string;
  rpContext: Record<string, unknown>;
};

export type WorldIdRequestView = {
  requestId: string;
  connectorURI: string;
  action: string;
  environment: string;
};

export type WorldIdStatusView = {
  status: "pending" | "verified" | "failed";
  detail?: string;
  credential?: string;
  nullifier?: string;
  entitiesUsed?: number;
  maxEntities?: number;
  /** Whether this deployment offers the identity step-up at all. */
  attestAvailable?: boolean;
  /** True when a live document-backed attestation is on file. */
  formationReady?: boolean;
  attestation?: { minAge: number; credential?: string | null; verifiedAt: number };
};


export class ApiError extends Error {
  code: string;
  status: number;
  details?: { path: string; message: string }[];

  constructor(status: number, body: ApiErrorBody["error"]) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.code;
    this.status = status;
    this.details = body.details;
  }
}

/* ------------------------------------------------------------------ */
/* COMPANIES — the legal body an agent is filed under (design §7)      */
/* ------------------------------------------------------------------ */

/**
 * THE EIGHT-WORD STATE the Companies section renders, derived by the backend
 * (`src/formation/status.ts#companyState`) from three facts a UI must never combine for itself.
 *
 * §7 names a ninth, `empty`, which is the state of a LIST with no rows rather than of a company.
 *
 * Exported as a runtime array as well as a type, for the reason `FORMATION_STATUSES` is: "is this
 * a state this build knows?" is a question asked at render time of a value that arrived over the
 * wire, and a switch with no default renders a blank line where a company's status should be.
 */
export const COMPANY_STATES = [
  "draft",
  "paying",
  "ready",
  "in_progress",
  "filed",
  "complete",
  "failed",
  "abandoned",
] as const;

export type CompanyState = (typeof COMPANY_STATES)[number];

export function isKnownCompanyState(value: string): value is CompanyState {
  return (COMPANY_STATES as readonly string[]).includes(value);
}

/** One stored name candidate, in the canonical shape the backend files under. */
export type CompanyNameOption = { name: string; entityTypeEnding: string; position: number };

/**
 * ONE ROW of `GET /companies` — and of MCP `list_companies`, which renders the same projection.
 *
 * The ORDERING is an API-level contract (newest first) shared with the wizard's reuse picker,
 * whose default is the last-used company. Never re-sorted here: two renderers sorting for
 * themselves is how a picker ends up disagreeing with the list behind it.
 *
 * NO PII. The responsible party is not projected, and a company's own name candidates are not
 * personal data.
 */
export type CompanyView = {
  companyId: string;
  status: "draft" | "ready" | "abandoned";
  environment: "sandbox" | "production";
  synthetic: boolean;
  nameOptions: CompanyNameOption[];
  legalNameFiled: string | null;
  businessPurpose: string;
  industryLabel: string;
  formationStatus: FormationStatus;
  paying: boolean;
  state: CompanyState;
  filedAt: number | null;
  filingNumber: string | null;
  /** How many agents share this filing. The picker's sharing label. */
  agents: number;
  createdAt: string;
};

/** `GET /companies/:companyId` — the list row plus what a list has no room for. */
export type CompanyDetailView = CompanyView & {
  /** True = the intake was DERIVED by the migration, not typed by a human. */
  intakeSynthesized: boolean;
  providerRef: string | null;
  /** ⚠ Owner-scoped surfaces only. */
  ein: string | null;
  requiredActions: string[];
  documents: FormationDocument[];
  attachedAgents: { id: string; name: string; status: EntityStatus }[];
  /**
   * WHAT STOPPED THIS FILING, and who can restart it (§4.6a/§4.7).
   *
   * Three flags rather than one, because they have three different exits — and the section
   * renders the sentence and the form that clears each. All false on a healthy company.
   */
  park: {
    awaitingIntakeEdit: boolean;
    awaitingPartyEdit: boolean;
    awaitingSsnDecision: boolean;
  };
};

/** One row of `GET /companies/:companyId/compliance`. Every field is explicitly null when the
 *  provider did not say, never absent — a renderer must not have to guess which it is. */
export type ComplianceEventView = {
  type: string | null;
  state: string | null;
  nextDueDate: string | null;
  lastFiledDate: string | null;
  status: string | null;
};

export type ComplianceView = {
  companyId: string;
  /** doola's id, or null when no filing has been opened — then `events` is empty because there is
   *  nothing to have a calendar about, which is not an error. */
  providerRef: string | null;
  /** Epoch ms the provider was last asked; null when it was not. */
  fetchedAt: number | null;
  events: ComplianceEventView[];
  /** The Wyoming annual report — a PLACEHOLDER and an admission, not provider data. */
  annualReport: { label: string; due: string; handledBy: string; note: string };
};

/** The production create-company intake (§5). Three ranked candidates, the company's own purpose,
 *  and an industry from `GET /formation/industries`. */
export type CompanyIntakeInput = {
  partyId: string;
  names: [string, string, string] | string[];
  businessPurpose: string;
  industryLabel: string;
  /** PRODUCTION REST ONLY, and optional even there (§4.1). Never persisted, never logged, never
   *  put in a React Query key — it travels as a mutation argument and is forgotten. */
  ssn?: string;
  /** The sandbox deployment's marker, checked against the box's own setting — never a claim the
   *  caller gets to make about a production filing. */
  synthetic?: true;
};

/** `PATCH /companies/:companyId` — the §4.7 edit-and-retry, with a fresh SSN capture. */
export type CompanyIntakeUpdate = Omit<CompanyIntakeInput, "partyId" | "synthetic"> & {
  /** The §4.6a decision: the clock took the number and the owner is choosing the slower route. */
  proceedWithoutSsn?: true;
};
