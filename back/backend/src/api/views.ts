import type { EntityRecord } from "../types";

/** Secret-free projection of an EntityRecord for API responses. */
export interface EntityView {
  id: string;
  name: string;
  status: EntityRecord["status"];
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
  /** Off-chain per-transaction cap in atomic USDC (6 decimals), or null if unset. */
  perTxCap: string | null;
  /** Per-entity buyer trust dial; null = inherits the platform default. */
  trustPolicy: "open" | "verified-sellers-only" | "verified-legal-bodies-only" | null;
  /** WebAuthn credentialId of the guardian passkey registered at onboarding. Owner-visible only. */
  rootPasskeyId: string | null;
  /** Tier-0 custody provider; null = legacy pre-Tier-0 row (behaves as "turnkey"). */
  walletProvider: "turnkey" | "circle" | null;
  /** Anchored OA bundle-manifest version. NULL = a LEGACY row whose `oaHash` is the doc hash,
   *  which is why surfaces must render the two differently ("OA anchor (v1)" vs "OA hash") —
   *  same field, different meaning, and a reader has to be able to tell. */
  oaManifestVersion: number | null;
  /** Formation (design §2). NULL = stub, forever — the shape every legacy row keeps and the
   *  shape every credential-less deployment serves. `environment` is REQUIRED whenever this is
   *  present (honesty invariant): a sandbox filing can never render as a real one by omission.
   *  PR 1 ships the skeleton only, so `status` is always "none"; PR 2 fills it from the
   *  formation sub-saga. NO PII is ever served here. */
  formation: {
    provider: string;
    environment: "sandbox" | "production";
    status: "none";
  } | null;
}

export function toEntityView(r: EntityRecord): EntityView {
  return {
    id: r.idempotencyKey,
    name: r.name,
    status: r.status,
    agentId: r.agentId,
    proxy: r.proxy,
    treasury: r.treasury,
    operator: r.operator,
    manager: r.manager,
    guardian: r.guardian,
    oaHash: r.oaHash,
    metadataURI: r.metadataURI,
    createTxHash: r.createTxHash,
    bindTxHash: r.bindTxHash,
    fundTxHash: r.fundTxHash,
    error: r.error ?? null,
    perTxCap: r.perTxCap?.toString() ?? null,
    trustPolicy: r.trustPolicy ?? null,
    rootPasskeyId: r.rootPasskeyId ?? null,
    // Tier-0 custody badge: null (legacy pre-Tier-0 rows) reads as "turnkey" downstream.
    walletProvider: r.walletProvider ?? null,
    oaManifestVersion: r.oaManifestVersion ?? null,
    // Both halves or neither: an entity pinned to a provider is always pinned to an environment
    // too (they are written together at the claim), so a half-populated formation block would be
    // a bug — and rendering one without the other is exactly the deception §2 forbids.
    formation:
      r.formationProvider && r.formationEnvironment
        ? {
            provider: r.formationProvider,
            environment: r.formationEnvironment,
            status: "none",
          }
        : null,
  };
}
