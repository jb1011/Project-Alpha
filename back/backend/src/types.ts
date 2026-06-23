import type { Address, Hex } from "viem";

export type { Address, Hex };

/** Mirror of LegalManagerFactory.TreasuryConfig (encoded into createEntity). */
export interface TreasuryConfig {
  usdc: Address;
  payoutAddress: Address;
  cap: bigint;
  period: bigint;
  allowlistEnabled: boolean;
}

/** Onboarding status. Forward order: pending < provisioned < translating < created < bound < funded. `failed` is a terminal-error state. */
export type EntityStatus =
  | "pending"
  | "provisioned"
  | "translating"
  | "created"
  | "bound"
  | "funded"
  | "failed";

/** One persisted legal-body record. agentId/proxy/treasury are null until step 4 (created). */
export interface EntityRecord {
  idempotencyKey: string;
  name: string;
  status: EntityStatus;
  manager: Address;
  guardian: Address;
  operator: Address | null;
  amendmentDelay: string; // bigint serialized as decimal string
  ein: string;
  formationDate: number; // unix seconds (uint64)
  oaHash: Hex | null;
  metadataURI: string | null;
  docPath: string | null;
  treasuryConfig: TreasuryConfig | null;
  agentId: string | null; // uint256 as decimal string
  proxy: Address | null;
  treasury: Address | null;
  createTxHash: Hex | null;
  bindTxHash: Hex | null;
  fundTxHash: Hex | null;
  turnkeySubOrgId?: string;
  turnkeyWalletId?: string;
  /** Owning tenant (controller wallet address). Set for API-created entities. */
  ownerTenantId?: string;
  /** Failure message when status === "failed". */
  error?: string | null;
  /** Validated AgentSpec JSON, persisted so the reconciler/fund can re-run the saga. */
  specJson?: string | null;
}
