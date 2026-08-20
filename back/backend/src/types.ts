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
  /** Off-chain per-transaction USDC cap in base units (6 decimals). null = no cap. */
  perTxCap?: bigint | null;
  /** Per-entity buyer trust dial; null/undefined = inherit the global X402_BUYER_TRUST_POLICY.
   *  Guardian-set only (session route) — never writable through an agent API key. */
  trustPolicy?: "open" | "verified-sellers-only" | "verified-legal-bodies-only" | null;
  /** WebAuthn credentialId of the guardian passkey registered at onboarding (v2.5 item 4) —
   *  the bookkeeping future "same guardian?" re-verification stands on. Owner-visible only. */
  rootPasskeyId?: string | null;
  /** Custody provider for the hot layer; null/undefined = "turnkey" (every pre-Tier-0 agent). */
  walletProvider?: "turnkey" | "circle" | null;
  circleWalletSetId?: string | null;
  circleOperatorWalletId?: string | null;
  circlePocketWalletId?: string | null;
  /** Stored (not derived) pocket address — lets read paths stop touching POCKET_MASTER_SEED. */
  pocketAddress?: string | null;
  /** Rotation forensics: where old money may still land after setOperator (audit item 7). */
  previousOperator?: string | null;
  operatorRotatedAt?: number | null;
  /** Opaque public slug; the on-chain metadataURI is METADATA_BASE_URL/metadata/<publicId>. */
  publicId?: string | null;
  // ── doola formation (design 2026-08-19 §3). Every field is additive and nullable; null
  //    `formationProvider` means legacy/stub and is never backfilled.
  /** "doola" | null. Persisted at CLAIM from config (custody-twin rule) and immutable after. */
  formationProvider?: string | null;
  /** The provider environment this entity is PINNED to. A mainnet flip can never route an
   *  in-flight sandbox company at the production host. */
  formationEnvironment?: "sandbox" | "production" | null;
  /** The real EIN once the IRS issues one. `ein` stays the value frozen on-chain at mint. */
  einReal?: string | null;
  /** Unix seconds the entity was actually filed (distinct from the on-chain `formationDate`). */
  formationFiledAt?: number | null;
  formationFilingNumber?: string | null;
  /** Manifest version currently ANCHORED on-chain. null = legacy doc-hash scheme (§4). */
  oaManifestVersion?: number | null;
  oaManifestAnchoredHash?: Hex | null;
  /** The single in-flight version's hash (single-pending rule). Cleared when it anchors. */
  oaManifestPendingHash?: Hex | null;
  /** Unix seconds the pending amendment becomes executable (feeds the guardian veto countdown). */
  oaAmendmentExecutableAt?: number | null;
}
