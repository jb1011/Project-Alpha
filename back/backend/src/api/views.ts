import type { DoolaEnvironment } from "../adapters/doola/types";
import type { DocumentIndexRecord } from "../persistence/documentIndexRepository";
import type { FormationRequestRecord } from "../persistence/formationRepository";
import type { EntityRecord } from "../types";
import { usesManifestScheme } from "../workflow/onboarding";

/** The formation sub-saga rows of one entity. A function rather than the repository so the view
 *  stays a pure projection and the caller decides where the rows come from. */
export type FormationStepsLookup = (entityKey: string) => FormationRequestRecord[];

/** The legal documents of one entity, for the same reason and on the same terms. */
export type FormationDocumentsLookup = (entityKey: string) => DocumentIndexRecord[];

/**
 * What a tenant is told about their entity's formation (design §5/§8) — DERIVED from the sub-saga
 * rows, never stored, so it cannot drift from the rows the sweeper actually drives.
 *
 *   none         nothing has been opened (a legacy/stub entity, or a filing not yet started)
 *   in_progress  opened, nothing legally true yet — doola has the request
 *   filed        the STATE has filed it: the company legally exists
 *   complete     the EIN has been issued: the entity is fully formed
 *   failed       nothing was filed and the step that would have filed it is in error
 */
export type FormationStatus = "none" | "in_progress" | "filed" | "complete" | "failed";

/**
 * The projection, in the ONE order that keeps it honest.
 *
 * `filed` and `complete` are checked BEFORE `failed`, deliberately: an entity whose company was
 * filed but whose document fetch failed IS a filed company, and reporting it as "failed" would
 * deny a legal fact that already exists in Wyoming's records. Conversely an entity whose
 * `create_provider` failed has nothing confirmed at all, so it falls through to `failed` —
 * which is the honest answer, and the one the ops trail agrees with.
 */
export function deriveFormationStatus(steps: FormationRequestRecord[]): FormationStatus {
  if (steps.length === 0) return "none";
  const state = (step: FormationRequestRecord["step"]) => steps.find((s) => s.step === step)?.state;
  if (state("await_ein") === "confirmed") return "complete";
  if (state("await_filing") === "confirmed" || state("fetch_documents") === "confirmed")
    return "filed";
  if (steps.some((s) => s.state === "failed" || s.state === "abandoned")) return "failed";
  return "in_progress";
}

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
  /** Formation (design §2/§8). NULL = stub, forever — the shape every legacy row keeps and the
   *  shape every credential-less deployment serves. `environment` is REQUIRED whenever this is
   *  present (honesty invariant): a sandbox filing can never render as a real one by omission.
   *  NO PII is ever served here — not a name, not an address, not an email. */
  formation: {
    provider: string;
    environment: DoolaEnvironment;
    status: FormationStatus;
    /** doola's company id. An opaque provider reference — not PII, and the id an operator needs
     *  to find this entity in doola's portal. */
    providerRef: string | null;
    /** Unix seconds the STATE filed the company. Null until it has. */
    filedAt: number | null;
    filingNumber: string | null;
    /**
     * ⚠ AUTHENTICATED VIEWS ONLY. The EIN is a tax identifier: it belongs to the entity's owner
     * and to nobody else. It reaches this projection — which serves GET /entities and the MCP
     * read tools, both tenant-scoped — and it must NEVER reach `/transparency` or `/metadata`,
     * which are unauthenticated. Both of those build their own row shapes, and a test asserts
     * neither can grow this field.
     */
    ein: string | null;
  } | null;
}

/**
 * The single choke point for everything a tenant is told about an entity.
 *
 * `formationSteps` is optional so every pre-formation caller compiles unchanged; absent, a
 * record simply reports the status its own columns can prove, which is `none`.
 */
export function toEntityView(r: EntityRecord, formationSteps?: FormationStepsLookup): EntityView {
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
            status: deriveFormationStatus(formationSteps?.(r.idempotencyKey) ?? []),
            providerRef:
              formationSteps?.(r.idempotencyKey)?.find((s) => s.step === "create_provider")
                ?.providerRef ?? null,
            filedAt: r.formationFiledAt ?? null,
            filingNumber: r.formationFilingNumber ?? null,
            // The real EIN, once the IRS issues one. `r.ein` is the placeholder frozen on-chain
            // at mint and is never served as a legal fact.
            ein: r.einReal ?? null,
          }
        : null,
  };
}
