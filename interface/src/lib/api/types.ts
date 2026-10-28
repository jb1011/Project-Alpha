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
  /**
   * The treasury policy change the backend scheduled and has not seen executed (design
   * 2026-10-23, section 4.5). What was SENT, not the chain's state: a veto leaves it standing, so
   * the settings screen shows it only after `pendingPolicy(policyId).exists` on the treasury, and
   * takes every figure from the chain. Optional for deploy-order safety: absent = nothing known.
   */
  scheduledPolicy?: ScheduledPolicyRecord | null;
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
   * FORMATION PAYMENTS (B1, design §6.8) — the two fields A3 deliberately left out until the
   * branch they gate could actually be reached.
   *
   * `formationPaymentRequired` decides whether the wizard has a payment STEP at all. Optional for
   * deploy-order safety: a backend that predates B1 serves neither, and absent must read as
   * "this deployment does not charge" — which is true of it.
   *
   * `formationFeeUsdc` is the PRICE, in whole USDC, and it is served on every formation
   * deployment INCLUDING the ones that do not charge: it is the number in the beta sentence
   * ("included during the beta, normally $399"). Bundling that number into the browser build is
   * how a price on screen drifts from the price the backend would quote — the same argument
   * `formationCopy` exists for. Null where the backend cannot form companies at all.
   *
   * ⚠ There is no revenue address here and there never will be. `/config` is public and
   * unauthenticated; the payee rides the QUOTE, bound to an exact amount and nonce.
   */
  formationPaymentRequired?: boolean;
  formationFeeUsdc?: number | null;
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
  /** Whether this deployment can WRITE an AgentBook registration (design 2026-08-25 v3 §4.5).
   *  The READ side is wired everywhere, so the status chip answers regardless; only the vouch
   *  flow is gated on this. Optional for deploy-order safety: absent means the backend predates
   *  the feature, i.e. unavailable. */
  agentBookRegistrationAvailable?: boolean;
  /** Legal bodies on customer-owned identities. Optional for deploy-order safety: absent means
   *  the backend predates it, i.e. not offered, exactly like `{ available: false }`. */
  legalBodies?: LegalBodyConfig;
  /** Whether the settings screen shows an external track record, and the provider's one word.
   *  Optional for deploy-order safety: absent means the backend predates it, i.e. no card. */
  externalRecord?: { available: boolean; providerName: string | null };
};

/** A scheduled treasury policy change, as the backend's schedule route sent it. */
export type ScheduledPolicyRecord = {
  policyId: `0x${string}`;
  /** Atomic USDC (6 decimals), decimal string. */
  cap: string;
  /** Seconds, decimal string. */
  period: string;
  allowlistOn: boolean;
  payout: `0x${string}`;
  txHash: `0x${string}`;
  /** ISO 8601. */
  scheduledAt: string;
};

/**
 * GET /entities/:id/external-record (design 2026-10-23, section 4.2), copied verbatim from the
 * backend's `trackRecord/types.ts`. Two halves, each with its own source and its own failure:
 * the CHAIN half is what the provider posted to this agent's ERC-8004 identity on Arc, the RECORD
 * half is the provider's own record API. Never merged; `agreement` says whether they agree.
 */
export interface ExternalRecordView {
  provider: { name: string; recordUrl: string | null };
  agentId: string;
  chain:
    | {
        status: "ok";
        graded: number;
        correct: number;
        wrong: number;
        unrecognised: number;
        lastGradedAt: string | null;
      }
    | { status: "unavailable"; reason: "rpc" | "decode" };
  record:
    | {
        status: "ok";
        lockingWallet: `0x${string}`;
        graded: number;
        correct: number;
        wrong: number;
        worstMoveBps: number | null;
      }
    | { status: "not_linked" }
    | {
        status: "unavailable";
        reason: "rpc" | "http" | "timeout" | "malformed" | "too_large";
        lockingWallet: `0x${string}` | null;
      };
  agreement: "match" | "differ" | "unknown";
  network: "testnet";
  checkedAt: string;
}

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
  /** The Hedera registration, published ON THE ROW (see `hederaFactsOf` in the backend's
   *  transparency route) so this page needs no second request per entity. Absent whenever the
   *  deployment does not run the rail or the entity was never registered; never a null. */
  hedera?: TransparencyHedera;
};

/**
 * The Hedera facts a transparency row may carry. Every field but `agentId` is independently
 * optional, and the paid `/verify` url is deliberately not among them: this is the free surface.
 */
export type TransparencyHedera = {
  agentId: string;
  registerTx?: string;
  profileUrl?: string;
  uaid?: string;
};

/** Public transparency surface: platform stats + the on-chain entity registry. */
export type TransparencyView = {
  /** `legalBodies` is present only where the deployment serves statements. */
  stats: { entities: number; jobsSettled: number; usdcSettledAtomic: string; legalBodies?: number };
  entities: TransparencyEntity[];
  /** Linked legal bodies whose statement reads `active`. Absent without statements; empty AND
   *  `legalBodiesAvailable: false` when the chain could not be read. */
  legalBodies?: TransparencyLegalBody[];
  legalBodiesAvailable?: boolean;
};

/**
 * One ERC-8004 registration on GET /metadata/:publicId (`registrations[]`).
 *
 * `agentRegistry` is CAIP-10: `eip155:<chainId>:<registryAddress>`. Hedera testnet is chain 296.
 * Every field is optional on the wire: the array itself is absent until at least one id is known.
 */
export type AgentRegistration = {
  agentId?: string;
  agentRegistry?: string;
};

/** The Hedera rail block on GET /metadata/:publicId. Absent until a float account is linked. */
export type HederaMetadataBlock = {
  accountId?: string;
  verifyUrl?: string;
  profileUrl?: string;
  registerTx?: string;
  attestor?: string;
};

/**
 * The public metadata document (GET /metadata/:publicId), as far as this UI reads it.
 *
 * Hedera fields are additive and independently optional: `uaid` lands when identity is recorded,
 * the `eip155:296` registration when the Hedera agent id is recorded, the `hedera` block when a
 * float account is linked. Treat every one as missing until it is a non-empty string.
 */
export type PublicMetadata = {
  uaid?: string;
  registrations?: AgentRegistration[];
  hedera?: HederaMetadataBlock;
};

/**
 * The public legal-body lookup (GET /legal-bodies/:address, design 2026-09-10 D3).
 *
 * The question a seller asks about an address that is about to pay it: is this the payment
 * address of a Novi legal body, and is its standing active? Unauthenticated, because the
 * caller is a stranger holding nothing but the address — which is why the dashboard reads exactly
 * the same surface a seller would, rather than an owner-only view of the same fact.
 *
 * `standing` is a THREE-valued answer and the third value matters (D8): `unknown` is a chain read
 * that failed, not a negative. Never render it as one. A body with a signed statement may also
 * read `pending` (its company not established yet), which the chip reads as it reads any word it
 * does not name: could not check.
 *
 * Non-200s a caller must expect beside these shapes (§8): 400 (a malformed address), 404 (a
 * deployment with no resolver wired), 429 (either rate budget) and 503 (the local read failed).
 * All four are "we could not check", and none of them is an answer about the address.
 */
export type LegalBodyFormation = {
  /** The STATE has filed the company: it legally exists. */
  filed: boolean;
  /** The IRS has issued the EIN. The EIN itself is never on this surface. */
  einIssued: boolean;
  status: FormationStatus;
  /** Inseparable from `status` (the honesty invariant): a sandbox filing must never be readable
   *  as a real Wyoming company by omission. */
  environment: "sandbox" | "production";
};

export type LegalBodyLookup =
  | {
      address: string;
      legalBody: false;
      standing: null;
      checkedAt: string;
    }
  | {
      address: string;
      legalBody: true;
      standing: Standing;
      /** A DECIMAL STRING: an agent id is a uint256 token id and a JSON number loses precision
       *  above 2^53. Null for a body that reached the chain before its id was recorded. */
      agentId: string | null;
      publicId: string | null;
      name: string;
      /** The chain the AGENT runs on. */
      network: "testnet" | "mainnet";
      links: { transparency: string; metadata: string | null };
      /** The filing, REPORTED and never gating (D1). Null where this deployment cannot read
       *  filings, or for an entity with no company. */
      formation: LegalBodyFormation | null;
      checkedAt: string;
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

/** One failed field of a `validation_error`: the backend maps every Zod issue to this shape. */
export type ApiValidationIssue = { path: string; message: string };

/**
 * The `details` of a refusal that is not a `validation_error` — a small object the route attached
 * to say WHICH refusal it is, where the code alone is too coarse to act on.
 *
 * Open-ended on purpose: it is a bag of route-specific hints, not a schema, and a caller that does
 * not recognise a key must ignore it rather than break. The named keys are the ones a surface
 * currently branches on; everything else stays `unknown` so reading it forces a check.
 */
export type ApiErrorDetail = {
  /** `not_ready` (AgentBook): `"no-pocket-yet"`, `"no-agent-id-yet"`, or `"entity-is-<status>"`. */
  reason?: string;
  /** `proof_rejected` (AgentBook): the contract error name the registry reverted with. NEVER the
   *  revert message — that would carry the proof arguments. */
  errorName?: string;
  /** `not_eligible` (AgentBook): the World ID credential on file, null when there is none. */
  credential?: string | null;
  [key: string]: unknown;
};

/** Either shape the `details` field can take. Discriminate with `Array.isArray`, or use
 *  `apiErrorDetail()` below. */
export type ApiErrorDetails = ApiValidationIssue[] | ApiErrorDetail;

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: ApiErrorDetails;
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
  /** Whether the legal-body doors' real-human check accepts this guardian, by that check's own
   *  rule. Absent where this deployment mounts no legal-body door. */
  realHuman?: boolean;
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

/* ── AgentBook (World's registry on World Chain) ──────────────────────────── */

/**
 * What the registry says about this agent's wallet, after every source has been reconciled.
 *
 * `unknown` is its own answer, and the reason this exists beside `registered`: a World Chain read
 * we could not make must never render as a refusal. `disputed` means a human answers for the
 * wallet who is not the one we registered.
 */
export type AgentBookOutcome = "registered" | "unregistered" | "unknown" | "disputed";

/** Where OUR registration attempt got to. Deliberately independent of `AgentBookOutcome`: the row
 *  can read `confirmed` while the chain reads `disputed`. */
export type AgentBookRowStatus =
  | "pending"
  | "submitted"
  | "confirmed"
  | "disputed"
  | "failed"
  | "expired";

/**
 * AgentBook standing for one agent (GET /entities/:id/agentbook).
 *
 * `registered` is the CHAIN's answer and `status` is OURS; they are separate on purpose, because a
 * registration that is signed and broadcast but not yet mined is honestly `status: "submitted"`
 * with `registered: false`. Render `outcome` — it folds "could not check" out of the boolean.
 *
 * Everything the vouch feature added is optional for deploy-order safety: the interface and the
 * API deploy separately and this route predates the feature, so a new browser can meet an old
 * backend. An absent `outcome` is exactly that backend, and it is read as **`unknown`** — "could
 * not check", never a vouch. It is tempting to fall back to `registered`, but that boolean cannot
 * distinguish "no entry" from "we could not reach World Chain", and both of the claims it would
 * then make are public statements about a real person (design v3 §5.4, D9). Absent `disputed` is
 * `false`. `src/lib/agentbook/chipState.ts` is the one implementation of this rule; render through
 * it rather than reading these fields directly.
 */
export type AgentBookStatusView = {
  registered: boolean;
  /** The pseudonym of the human AgentBook binds to the wallet, when there is one. */
  humanId?: string;
  /** The address AgentBook was queried for: the agent's pocket EOA, which is what signs AgentKit
   *  challenges and therefore what a seller looks up. Absent only before the pocket exists.
   *  EIP-55 checksummed, the same form the session response uses — the guardian is asked to
   *  compare the two by eye. Compare it in code case-insensitively regardless: an older backend
   *  serves the stored form. */
  address?: string;
  /** Why there is nothing to look up yet, and the API has exactly one: the agent has no payment
   *  address, so there is no question to put to AgentBook and the dashboard shows no chip. */
  reason?: "no-pocket-yet";
  outcome?: AgentBookOutcome;
  /** Absent when nothing has ever been registered for this agent from here. */
  status?: AgentBookRowStatus;
  /** null while the transaction is signed and recorded but not yet on the wire. The reconciler
   *  re-broadcasts the same raw transaction, so that is "hash pending", never "failed". */
  txHash?: string | null;
  disputed?: boolean;
  /** The contract error name from the last attempt. Only sent when `status` is `"failed"`. */
  errorCode?: string;
  /**
   * The network the AGENT runs on — not AgentBook's, which is always World Chain mainnet.
   *
   * The same value the session response carries, served here so the consent step can say
   * "this agent runs on Arc testnet, the vouch is on mainnet and is just as permanent" BEFORE the
   * checkbox rather than after it (design §5.1, final review FR-F). Absent from a backend that
   * predates the field: the line is then omitted rather than guessed, because guessing "mainnet"
   * would suppress a warning that is true and guessing "testnet" would print one that is false.
   */
  network?: "testnet" | "mainnet";
  /**
   * Confirmed vouches this GUARDIAN'S TENANT has already made — per tenant, not per human. Also
   * from the session response, for the second §5.1 line. Absent means "not told": the linkability
   * line is omitted rather than rendered with a zero, which would read as a claim that this is
   * their first vouch.
   */
  priorVouches?: number;
};

/** POST /entities/:id/agentbook/session — everything the World App round trip needs. */
export type AgentBookSessionView = {
  /** Opaque handle, handed back verbatim on register. */
  sessionId: string;
  appId: string;
  action: string;
  /** `encodePacked(address, uint256 nonce)`: what the proof commits to, so neither the address nor
   *  the nonce can move between session and register. */
  signal: `0x${string}`;
  /** The registry nonce, decimal. Hand it back unchanged — a mismatch is a 409. */
  nonce: string;
  /** The address AgentBook will bind, checksummed. */
  pocketAddress: `0x${string}`;
  /** The agent's on-chain id. Always a string: the route refuses a session for an agent that has
   *  none. */
  agentId: string;
  /** Epoch ms. Past it, register answers 409 and the guardian starts again. */
  expiresAt: number;
  network: "testnet" | "mainnet";
  /** Confirmed vouches this GUARDIAN'S TENANT has already made — per tenant, not per human: our
   *  World ID pseudonym for this account is not the guardian's AgentBook pseudonym. */
  priorVouches: number;
};

/** POST /entities/:id/agentbook/register — the World ID proof, as the widget produced it. */
export type AgentBookRegisterBody = {
  sessionId: string;
  root: string;
  /** The nonce the session handed out, unchanged. */
  nonce: string;
  nullifierHash: string;
  /** Exactly 8 elements; the backend rejects any other length. */
  proof: string[];
};

/** The register route's answer. `txHash` is null when the transaction is signed and recorded but
 *  the broadcast did not land — the reconciler re-broadcasts the same raw transaction, so that is
 *  "submitted, hash pending" and NOT something for the caller to retry. */
export type AgentBookRegisterResult = { status: "submitted"; txHash: string | null };

export class ApiError extends Error {
  code: string;
  status: number;
  details?: ApiErrorDetails;

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

/**
 * `GET /formation/rules` — everything the create-company form enforces, from the backend that
 * enforces it (design §5/§7).
 *
 * The four scalars were MIRRORED constants in this bundle until A3, each with a comment naming
 * what it copied. A mirror is a second copy with a promise attached: the day one moves, the form
 * either refuses a name the door would take — an annoyance — or PROMISES one the door refuses,
 * after a founder has typed three of them and paid for the first.
 *
 * ⚠ Wyoming's ~80 RESTRICTED WORDS are deliberately absent, and a test asserts it. They are
 * matched on letter boundaries (so "Banksy" survives "bank"), which makes the MATCHER the rule
 * rather than the data; a client holding the words without it would disagree with the server in
 * both directions. The server's refusal names the offending word and the form renders it.
 */
export type FormationRules = {
  /** As served, in the order doola published it — the picker sorts nothing for itself. */
  industries: string[];
  /** Wyoming refuses a taken name, and a retry is a second fee: the alternates are the point. */
  nameOptionCount: number;
  nameMaxLength: number;
  purposeMaxLength: number;
  /** A character-CLASS BODY, compiled as `^[…]$` and tested one character at a time — never a
   *  whole pattern, which would carry an anchor and a quantifier this client did not choose. */
  nameCharset: string;
};

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
  environment: "sandbox" | "production";
  nameOptions: CompanyNameOption[];
  legalNameFiled: string | null;
  businessPurpose: string;
  industryLabel: string;
  /**
   * The eight-word state — the row's status, a live payment and the derived filing status,
   * combined ONCE, server-side.
   *
   * Its three inputs used to be served beside it and nothing here read them: `canAttach` reads
   * this word, the pill reads this word, the list page reads this word. They remain on
   * `CompanyDetailView`, where a page about one company can show the parts.
   */
  state: CompanyState;
  filedAt: number | null;
  filingNumber: string | null;
  /** How many agents share this filing. The picker's sharing label. */
  agents: number;
  /** EPOCH MILLISECONDS — what `formatDate` takes, with no reconstruction at the edge. */
  createdAt: number;
  /**
   * A customer's OWN company (declared, not filed through formation) carries three keys more;
   * a formation company has none of them, so its key set is unchanged.
   */
  provider?: "customer";
  /** What the guardian declared, as typed, and the version of the wording signed. Never the
   *  declarant's name or title. Null when the declaration could not be read. */
  declared?: { companyName: string; filingNumber: string; wordingVersion: string } | null;
  /** The operator's latest check: `checkedAt` is unix SECONDS (like `filedAt`), not ms. Null
   *  when this surface could not read the checks, never "not checked yet": that is
   *  `awaiting_check`. */
  verification?: {
    state: VerificationState;
    checkedAt: number | null;
    reasonCode: CheckReasonCode | null;
  } | null;
};

/** `GET /companies/:companyId` — the list row plus what a list has no room for. */
export type CompanyDetailView = CompanyView & {
  /** The row's own column — DETAIL only; the list serves the combined `state`. */
  status: "draft" | "ready" | "abandoned";
  synthetic: boolean;
  formationStatus: FormationStatus;
  paying: boolean;
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

/**
 * THE EIP-712 REQUEST the guardian's wallet signs (design §6.1).
 *
 * Served WHOLE by the backend rather than assembled here, and that is the point: a client that
 * built the message itself would be a second place to get the domain, the type list or the field
 * ORDER wrong, and each of those produces a signature that verifies against nothing and reverts
 * on-chain after the guardian has approved it. It is passed to wagmi's `useSignTypedData`
 * essentially untouched.
 *
 * `value`/`validAfter`/`validBefore` are decimal STRINGS: JSON has no bigint, and viem accepts
 * strings for `uint256`.
 */
export type PaymentTypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
};

/** A live, signable quote. Present only while the payment is `quoted` AND inside its window. */
export type FormationQuote = {
  paymentId: string;
  /** Atomic USDC (6 decimals), as a decimal string. */
  amountUsdc: string;
  /** Whole USDC — the price a human reads. */
  amountDisplayUsdc: number;
  payTo: `0x${string}`;
  nonce: `0x${string}`;
  validAfter: number;
  /** Unix SECONDS — what the guardian SIGNS. Later than `expiresAt` by the settlement grace, so
   *  a signature given at the last second still has time to be broadcast and mined. */
  validBefore: number;
  /** Unix SECONDS — WHEN THE QUOTE STOPS BEING OFFERED. This is the countdown a person is shown;
   *  showing `validBefore` would promise minutes the settle door will refuse. */
  expiresAt: number;
  typedData: PaymentTypedData;
};

/**
 * `GET /companies/:companyId/payment` — what is owed, or what happened.
 *
 * The status union is the backend's, enumerated once (`formation_payments.status`). A `settling`
 * row deliberately carries NO `quote`: signing again while a broadcast is in flight is how a
 * guardian gets charged twice, and a screen that could see a quote would render the button.
 */
export type FormationPaymentStatus =
  | "quoted"
  | "settling"
  | "settled"
  | "expired"
  | "failed"
  | "refunded";

export type FormationPaymentView = {
  paymentId: string;
  companyId: string;
  product: "formation" | "maintenance_year";
  status: FormationPaymentStatus;
  amountUsdc: string;
  amountDisplayUsdc: number;
  validBefore: number;
  /** When the quote stops being offered (unix seconds) — the countdown, not the token's clock. */
  expiresAt: number;
  payerAddress: `0x${string}` | null;
  txHash: `0x${string}` | null;
  refundTxHash: string | null;
  /**
   * ALWAYS present, including on a `settling` row that carries no quote — they are what the
   * guardian's CANCEL path needs to build `CancelAuthorization(authorizer, nonce)`.
   *
   * Safe where the quote is not: a transfer authorization also commits to the value, the
   * recipient and the window, and none of those is here. A wrong cancel message yields a
   * signature the token rejects — a stuck payment, never a moved one.
   */
  nonce: `0x${string}`;
  /** NULL on a deployment that no longer charges: the token's domain is read at boot only where
   *  it does, and a payment there is history rather than something to sign. */
  domain: PaymentTypedData["domain"] | null;
  quote?: FormationQuote;
  /**
   * The CANCELLATION, served whole — present exactly while there is something live to cancel.
   *
   * This package used to hold its own copy of the `CancelAuthorization` type list and assemble
   * the message from `nonce` + `domain`. That is a second place for a type list, a field order
   * and — worst — an AUTHORIZER to be got wrong: the authorizer is the address that SIGNED, which
   * is the payer once a settle has been attempted and the connected wallet only before that. The
   * server knows which; a browser guessing produces a signature the token rejects.
   */
  cancelTypedData?: {
    domain: PaymentTypedData["domain"];
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: { authorizer: `0x${string}`; nonce: `0x${string}` };
  };
};

/** `POST /companies/:id/payment/settle` — `settled` when the receipt confirmed, `pending` while
 *  the transaction is in flight (poll, never sign again). */
export type SettlePaymentResult = { status: "settled" | "pending"; txHash?: `0x${string}` };

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
 *  and an industry from `GET /formation/rules`. */
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

/**
 * `ApiError.details` as the hint object, or undefined.
 *
 * The one place the two shapes are told apart, so no surface has to cast. A `validation_error`'s
 * issue array is NOT a hint object and comes back undefined rather than as an array with no
 * `reason` on it — a caller reading `?.reason` gets the same answer either way, and one that
 * wants the issues can still ask `Array.isArray(err.details)`.
 */
export function apiErrorDetail(details: ApiErrorDetails | undefined): ApiErrorDetail | undefined {
  return details !== undefined && !Array.isArray(details) ? details : undefined;
}

// ---------------------------------------------------------------------------------------------
// Legal bodies on customer-owned identities: the customer company, the order, its binding, the
// link, the public statement. Copied from the backend's own types, field by field: every uint256
// is a canonical decimal string and every address or hash a `0x` string, so nothing here is a
// bigint.
//
// Beside every union and every view stands a runtime list, its members or its keys. A backend
// test (`test/api/legalBodyInterfaceTypes.test.ts`) reads this file as text and compares each list
// with the backend's own type, so keep each list's `export const NAME = [` opening and the
// `] as const` that closes it. A key list is checked against the type here too: it cannot name a
// key its view does not have, nor leave one out.
// ---------------------------------------------------------------------------------------------

/** An address as served, checksummed or not: compare addresses in lower case. */
export type Address = `0x${string}`;
/** A hex value: a hash, a signature. */
export type Hex = `0x${string}`;

/** The operator's check of a customer's company, as the tenant is told it. A reinstated company
 *  reads `awaiting_check` until a check passes again. */
export const VERIFICATION_STATES = ["awaiting_check", "verified", "failed", "revoked"] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

/** Why a check failed. The operator's free-text reason is never served. */
export const CHECK_REASON_CODES = [
  "name_mismatch",
  "filing_not_found",
  "not_active",
  "control_not_shown",
  "other",
] as const;
export type CheckReasonCode = (typeof CHECK_REASON_CODES)[number];

/** The eight states of an order and its binding. */
export const BINDING_STATES = [
  "draft",
  "reserved",
  "deployed",
  "linked",
  "broken",
  "lapsed",
  "superseded",
  "abandoned",
] as const;
export type BindingState = (typeof BINDING_STATES)[number];

/** Why a reservation closed without a body. */
export const LAPSE_REASONS = [
  "deadline_passed",
  "foreign_body",
  "owner_changed",
  "refused_before_send",
] as const;
export type LapseReason = (typeof LAPSE_REASONS)[number];

/** Why a linked body broke: the binding check records the first three, one per status of the
 *  body; `replaced` means a newer body of the same identity was linked, named by `replacedBy`. */
export const BROKEN_REASONS = ["not_linked", "winding_down", "dissolved", "replaced"] as const;
export type BrokenReason = (typeof BROKEN_REASONS)[number];

/** The public standing of a legal body, in four words. `active` only when every fact behind it
 *  holds; `unknown` is a read that could not be made, never a negative. */
export const STANDINGS = ["pending", "active", "unknown", "inactive"] as const;
export type Standing = (typeof STANDINGS)[number];

/** The annual report, as far as the recorded facts show it: `past_due_unverified` means nobody
 *  has confirmed a report that may well have been filed. */
export const FILING_STATUSES = [
  "not_yet_due",
  "filed",
  "past_due_unverified",
  "unverified",
] as const;
export type FilingStatus = (typeof FILING_STATUSES)[number];

/** `/config.legalBodies`: public facts only, each a projection of what mounts the doors, so the
 *  answer cannot offer a door that is not there. */
export type LegalBodyConfig =
  | { available: false }
  | {
      available: true;
      /** The customer company doors (declare, abandon, upload evidence) are mounted. */
      declarations: boolean;
      /** The public statement by agent is mounted. */
      statements: boolean;
      environment: "sandbox" | "production";
      chainId: number;
      identityRegistry: Address;
      factory: Address;
      /** The gas seed's amount is above zero. */
      gasSeedOffered: boolean;
      /** A new customer company lands `draft` and owes a payment. */
      paymentRequired: boolean;
      /** The link window a client may ask for, in seconds, counted from the chain's clock. */
      linkTtl: { min: number; max: number; default: number };
    };
/** The keys of the available arm; the other arm is `{ available: false }` alone. */
export const LEGAL_BODY_CONFIG_KEYS = [
  "available",
  "declarations",
  "statements",
  "environment",
  "chainId",
  "identityRegistry",
  "factory",
  "gasSeedOffered",
  "paymentRequired",
  "linkTtl",
] as const satisfies readonly (keyof Extract<LegalBodyConfig, { available: true }>)[];

/** `POST /companies/customer/statement-message` request; the create adds `issuedAt` and
 *  `signature`. */
export type CustomerStatementInput = {
  /** Typed on a production deployment only: a sandbox refuses both and uses its fixed declarant. */
  declarantName?: string;
  declarantTitle?: string;
  companyName: string;
  filingNumber: string;
  synthetic?: boolean;
};
export type CustomerCompanyInput = CustomerStatementInput & {
  /** The `issuedAt` of the typed data that was signed: unix seconds, in decimal. */
  issuedAt: string;
  signature: Hex;
};

/** The statement of authority as served: `issuedAt` is a decimal string, `EIP712Domain` is
 *  declared, and a wallet that signs it as it arrives signs the digest the server checks. */
export type StatementTypedDataWire = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: {
    EIP712Domain: readonly { name: string; type: string }[];
    StatementOfAuthority: readonly { name: string; type: string }[];
  };
  primaryType: "StatementOfAuthority";
  message: {
    statement: string;
    declarantName: string;
    declarantTitle: string;
    companyName: string;
    jurisdiction: "WY";
    filingNumber: string;
    guardian: Address;
    wordingVersion: string;
    /** Unix seconds, in decimal, by the server's clock. */
    issuedAt: string;
  };
};

/** `POST /companies/customer/statement-message` answer. */
export type StatementMessageAnswer = {
  typedData: StatementTypedDataWire;
  wordingVersion: string;
  textStatus: "draft" | "approved";
};
export const STATEMENT_MESSAGE_ANSWER_KEYS = [
  "typedData",
  "wordingVersion",
  "textStatus",
] as const satisfies readonly (keyof StatementMessageAnswer)[];

/** An order as the API shows it. Times: `linkDeadline`, `deployedAt` and `pointerSeenAt` are unix
 *  SECONDS; `createdAt` is ISO 8601 in UTC, marked with a `Z`. The six facts after `createdAt`
 *  say why the order is in its state and which company it is for. */
export type LegalBodyOrderView = {
  id: string;
  publicId: string;
  companyId: string;
  state: BindingState;
  chainId: number;
  factory: Address;
  guardian: Address;
  /** Seconds. */
  amendmentDelay: number;
  agreement: { hash: Hex; version: number } | null;
  /** A uint256 in decimal. */
  agentId: string | null;
  identityOwner: Address | null;
  bodyAddress: Address | null;
  linkDeadline: number | null;
  createTxHash: Hex | null;
  deployedAt: number | null;
  pointerSeenAt: number | null;
  createdAt: string;
  /** Why the reservation closed without a body, for a `lapsed` order; null otherwise. */
  lapseReason: LapseReason | null;
  /** The reason of the latest break, for a body that is broken or was superseded after a break;
   *  the state decides what a screen does. Null otherwise. */
  brokenReason: BrokenReason | null;
  /** Whether an operator revoked the body. A revocation is never undone. */
  revoked: boolean;
  /** The order that superseded this one, for a `superseded` order; null otherwise. */
  supersededBy: string | null;
  /** The order whose body was linked in this one's place, when the latest break is `replaced`. */
  replacedBy: string | null;
  /** The company name its declaration states; null when the declaration is missing. */
  companyName: string | null;
};
export const LEGAL_BODY_ORDER_VIEW_KEYS = [
  "id",
  "publicId",
  "companyId",
  "state",
  "chainId",
  "factory",
  "guardian",
  "amendmentDelay",
  "agreement",
  "agentId",
  "identityOwner",
  "bodyAddress",
  "linkDeadline",
  "createTxHash",
  "deployedAt",
  "pointerSeenAt",
  "createdAt",
  "lapseReason",
  "brokenReason",
  "revoked",
  "supersededBy",
  "replacedBy",
  "companyName",
] as const satisfies readonly (keyof LegalBodyOrderView)[];

/** What the identity's owner should do: point the identity at its body. It holds no calldata: the
 *  client encodes the pointer and the metadata write itself. */
export type PointerIntent = {
  action: "setLegalBodyPointer";
  agentId: string;
  body: Address;
  chainId: number;
};

/** `GET /legal-body-orders/:id/binding` and the refresh's answer. The four facts after
 *  `nextCheckAt` are the order view's. */
export type BindingView = {
  state: BindingState;
  /** A uint256 in decimal. */
  agentId: string | null;
  bodyAddress: Address | null;
  /** Null where no pointer is asked for, among them a body winding down or dissolved. */
  intent: PointerIntent | null;
  /** Unix SECONDS: the sighting of the pointer that opened the latest linked stretch. */
  pointerSeenAt: number | null;
  /** Unix MILLISECONDS: the next scheduled check (a schedule, not a chain time). */
  nextCheckAt: number | null;
  /** The reason of the latest break, for a body that is broken or was superseded after a break;
   *  the state decides what a screen does. Null otherwise. */
  brokenReason: BrokenReason | null;
  revoked: boolean;
  supersededBy: string | null;
  replacedBy: string | null;
};
export const BINDING_VIEW_KEYS = [
  "state",
  "agentId",
  "bodyAddress",
  "intent",
  "pointerSeenAt",
  "nextCheckAt",
  "brokenReason",
  "revoked",
  "supersededBy",
  "replacedBy",
] as const satisfies readonly (keyof BindingView)[];

/** `GET /legal-body-orders/:id/agreement`: `keccak256(manifest) === manifestHash`. */
export type LegalBodyAgreement = {
  termsDoc: string;
  manifest: string;
  manifestHash: Hex;
  textId: string;
  textVersion: string;
  textStatus: "draft" | "approved";
};
export const LEGAL_BODY_AGREEMENT_KEYS = [
  "termsDoc",
  "manifest",
  "manifestHash",
  "textId",
  "textVersion",
  "textStatus",
] as const satisfies readonly (keyof LegalBodyAgreement)[];

/** The five link fields, in the order of the contract's type string. */
export const LINK_FIELDS = [
  { name: "agentId", type: "uint256" },
  { name: "guardian", type: "address" },
  { name: "amendmentDelay", type: "uint256" },
  { name: "operatingAgreementHash", type: "bytes32" },
  { name: "deadline", type: "uint256" },
] as const;
/** `EIP712Domain` as the backend declares it in the typed data it serves. */
export const EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** The link typed data as served: every uint256 a decimal string, `EIP712Domain` declared. */
export type LinkTypedDataWire = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: { EIP712Domain: typeof EIP712_DOMAIN_FIELDS; LegalBodyLink: typeof LINK_FIELDS };
  primaryType: "LegalBodyLink";
  message: {
    agentId: string;
    guardian: Address;
    amendmentDelay: string;
    operatingAgreementHash: Hex;
    deadline: string;
  };
};

/** `POST /legal-body-orders/:id/link-message` answer. `deadline` is unix seconds in CHAIN time. */
export type LinkMessageResult = {
  typedData: LinkTypedDataWire;
  identityOwner: Address;
  deadline: number;
};
export const LINK_MESSAGE_RESULT_KEYS = [
  "typedData",
  "identityOwner",
  "deadline",
] as const satisfies readonly (keyof LinkMessageResult)[];

/** The link door's flat 422, not the house error envelope: before the reservation the order is
 *  still `draft`, after it `lapsed`. `detail` holds hex values and the factory's error names. */
export type LinkRefusal = {
  code: string;
  message: string;
  detail: Record<string, string>;
  order: LegalBodyOrderView;
};

/** The client's own shape, not a backend one: what `POST /legal-body-orders/:id/link` answers
 *  without an error, with its status (202 while the create is not confirmed yet). */
export type LinkSubmitAnswer =
  | { status: 200 | 202; body: LegalBodyOrderView }
  | { status: 422; body: LinkRefusal };

/** The signed statement's message in its JSON form: 33 fields, in the order of its type string,
 *  every uint256 a decimal string. */
export type LegalBodyStatementJson = {
  chainId: string;
  identityRegistry: Address;
  factory: Address;
  legalBody: Address;
  agentId: string;
  /** The zero address when the agent has no wallet. */
  agentWallet: Address;
  identityOwnerAtCreation: Address;
  bindingState: "linked" | "broken";
  identityOwnerIsContract: boolean;
  agentWalletIsContract: boolean;
  standing: Standing;
  attestationState: "pending" | "active" | "revoked";
  jurisdiction: "WY";
  entityType: "LLC";
  /** "" unless the names may be shown. */
  legalName: string;
  filingNumber: string;
  source: "customer" | "novi";
  environment: "sandbox" | "production";
  controlVerified: boolean;
  /** Unix seconds; "0" when no check established the company. */
  existenceCheckedAt: string;
  filedAt: string;
  einIssued: boolean;
  filingStatus: FilingStatus;
  /** A year; "0" when no recorded report counts. */
  lastFiledPeriod: string;
  lastFiledAt: string;
  lastFiledConfirmedBy: "" | "operator";
  nextDue: string;
  oaManifestHash: Hex;
  oaManifestVersion: string;
  guardianHumanVerified: boolean;
  observedAtBlock: string;
  /** Unix seconds. */
  issuedAt: string;
  expiresAt: string;
};

/** What is served: the typed data in JSON, the signer's address and the signature. A verifier
 *  checks the signature against an attestor it took from elsewhere, never this field. */
export type SignedStatementJson = {
  domain: { name: string; version: string; chainId: number };
  primaryType: "LegalBodyStatement";
  message: LegalBodyStatementJson;
  attestor: Address;
  signature: Hex;
};

/** `GET /legal-bodies/by-agent/:agentId` (public, CORS `*`): no body, a body whose statement
 *  could not be made just now, or a body with its signed statement. */
export type LegalBodyByAgent =
  | { agentId: string; legalBody: false; standing: null; checkedAt: string }
  | {
      agentId: string;
      legalBody: true;
      standing: "unknown";
      publicId: null;
      network: "testnet" | "mainnet";
      links: { transparency: string };
      checkedAt: string;
      statement: null;
    }
  | {
      agentId: string;
      legalBody: true;
      standing: Standing;
      publicId: string;
      network: "testnet" | "mainnet";
      links: { transparency: string; statement: string };
      checkedAt: string;
      statement: SignedStatementJson;
    };

/** The public routes' flat refusal: `error` is a STRING here, not the house error envelope. */
export type PublicRefusal = {
  error: "rate_limited" | "unavailable" | "validation_error";
  message: string;
};

/** One row of `/transparency`'s legal-bodies section. */
export type TransparencyLegalBody = {
  agentId: string;
  publicId: string;
  legalBody: Address;
  chainId: number;
  legalName: string;
  filingNumber: string;
  jurisdiction: "WY";
  entityType: "LLC";
  source: "customer";
  environment: "sandbox" | "production";
  standing: "active";
  /** ISO 8601: when the binding check first saw the current link. */
  linkedSince: string;
  links: { statement: string };
};
export const TRANSPARENCY_LEGAL_BODY_KEYS = [
  "agentId",
  "publicId",
  "legalBody",
  "chainId",
  "legalName",
  "filingNumber",
  "jurisdiction",
  "entityType",
  "source",
  "environment",
  "standing",
  "linkedSince",
  "links",
] as const satisfies readonly (keyof TransparencyLegalBody)[];

/** Fails `tsc` when a view has a key its runtime list leaves out (`satisfies` checks the other way). */
type Exhaustive<Missing extends never> = Missing;
export type LegalBodyKeyListsAreExhaustive = [
  Exhaustive<Exclude<keyof LegalBodyOrderView, (typeof LEGAL_BODY_ORDER_VIEW_KEYS)[number]>>,
  Exhaustive<Exclude<keyof BindingView, (typeof BINDING_VIEW_KEYS)[number]>>,
  Exhaustive<Exclude<keyof Extract<LegalBodyConfig, { available: true }>, (typeof LEGAL_BODY_CONFIG_KEYS)[number]>>,
  Exhaustive<Exclude<keyof StatementMessageAnswer, (typeof STATEMENT_MESSAGE_ANSWER_KEYS)[number]>>,
  Exhaustive<Exclude<keyof LegalBodyAgreement, (typeof LEGAL_BODY_AGREEMENT_KEYS)[number]>>,
  Exhaustive<Exclude<keyof LinkMessageResult, (typeof LINK_MESSAGE_RESULT_KEYS)[number]>>,
  Exhaustive<Exclude<keyof TransparencyLegalBody, (typeof TRANSPARENCY_LEGAL_BODY_KEYS)[number]>>,
];
