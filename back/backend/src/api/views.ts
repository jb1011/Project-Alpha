import type { DoolaEnvironment } from "../adapters/doola/types";
import type { EntityRecord } from "../types";
import { usesManifestScheme } from "../workflow/onboarding";

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
  /**
   * What `oaHash` COMMITS to — as a discriminated union, not a version number a surface has to
   * interpret.
   *
   * `oaManifestVersion: number | null` made every renderer re-derive the scheme from "is it
   * null?", which is the same guess in three places and one of them will get it wrong: a
   * manifest entity whose v1 has not confirmed yet ALSO has a null version, and rendering that
   * as "OA hash" would describe a bundle anchor as a document hash. The scheme is decided once,
   * here, by the SAME predicate the saga derives the anchor with.
   */
  oaAnchor:
    | { scheme: "legacy"; hash: string | null }
    | {
        scheme: "manifest";
        hash: string | null;
        /** Anchored version; null while v1 is still in flight. */
        version: number | null;
        /** The single in-flight version's hash, or null when nothing is pending. */
        pendingHash: string | null;
      };
  /** Formation (design §2). NULL = stub, forever — the shape every legacy row keeps and the
   *  shape every credential-less deployment serves. `environment` is REQUIRED whenever this is
   *  present (honesty invariant): a sandbox filing can never render as a real one by omission.
   *  PR 1 ships the skeleton only, so `status` is always "none"; PR 2 fills it from the
   *  formation sub-saga. NO PII is ever served here. */
  formation: {
    provider: string;
    environment: DoolaEnvironment;
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
    // ONE predicate, imported from the saga that derives the anchor: a surface that decided the
    // scheme for itself could describe an entity differently from the code that anchored it.
    oaAnchor: usesManifestScheme(r)
      ? {
          scheme: "manifest" as const,
          hash: r.oaHash ?? null,
          version: r.oaManifestVersion ?? null,
          pendingHash: r.oaManifestPendingHash ?? null,
        }
      : { scheme: "legacy" as const, hash: r.oaHash ?? null },
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
