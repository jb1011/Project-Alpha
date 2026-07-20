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
};

/** Real on-chain treasury state (from GET /entities/:id/treasury). All USDC fields are atomic strings (6 decimals). */
export type TreasuryView = {
  usdcBalance: string;
  available: string;
  cap: string;
  period: string;
  paused: boolean;
  /** Honest total un-clawback-able standing exposure (operator EOA + pocket EOA + Gateway), atomic
   *  USDC, plus the configured ceiling. See back/docs/design/2026-07-20-s2-interim-float-ceiling-design.md. */
  standing: {
    operatorEoa: string;
    pocketEoa: string;
    gateway: string;
    total: string;
    ceiling: string;
  };
  /** true when the entity's on-chain legal status is Active (LegalManager status() === 0). */
  legalActive: boolean;
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

export type Capability = "read" | "earn" | "spend";

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
