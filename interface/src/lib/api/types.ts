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
  /** Anchored OA bundle-manifest version. null/absent = a LEGACY row whose `oaHash` commits to
   *  the operating-agreement document alone, not to the manifest — which is why the two are
   *  labelled differently. Optional for deploy-order safety: a backend that predates this field
   *  means "legacy". */
  oaManifestVersion?: number | null;
  /** Formation (doola). null/absent = stub, forever. `environment` is always present when the
   *  block is: a sandbox filing must render amber ("Demo formation"), never green. PR 1 ships
   *  the skeleton, so `status` is always "none". Never carries PII. */
  formation?: {
    provider: string;
    environment: "sandbox" | "production";
    status: "none";
  } | null;
};

/** Public deployment capabilities (GET /config, unauthenticated) — lets the wizard preselect the
 *  platform default and never offer a custody option this deployment can't serve. */
export type PublicConfig = {
  walletProviderDefault: "turnkey" | "circle";
  circleCustodyAvailable: boolean;
  /** Optional for deploy-order safety: a backend that predates this field means "available"
   *  (every legacy deployment served turnkey). Mainnet ships false — circle-only. */
  turnkeyCustodyAvailable?: boolean;
  /** doola formation. All three are optional for deploy-order safety: a backend that predates
   *  them forms nothing, which is exactly what absent should mean. `formationEnvironment` is
   *  non-null whenever formation is available — the honesty invariant. */
  formationAvailable?: boolean;
  formationRequired?: boolean;
  formationEnvironment?: "sandbox" | "production" | null;
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
