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
};

/** Real on-chain treasury state (from GET /entities/:id/treasury). All USDC fields are atomic strings (6 decimals). */
export type TreasuryView = {
  usdcBalance: string;
  available: string;
  cap: string;
  period: string;
  paused: boolean;
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
