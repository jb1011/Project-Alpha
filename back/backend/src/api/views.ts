import { type FormationStatus, type FormationSummary, formationSummary } from "../formation/status";
import {
  type DocumentIndexRecord,
  type DocumentIndexRepository,
  documentFileName,
} from "../persistence/documentIndexRepository";
import type { FormationRequestRecord } from "../persistence/formationRepository";
import type { EntityRecord } from "../types";
import { usesManifestScheme } from "../workflow/onboarding";

/** The formation sub-saga rows of one entity. A function rather than the repository so the view
 *  stays a pure projection and the caller decides where the rows come from. */
export type FormationStepsLookup = (entityKey: string) => FormationRequestRecord[];

/**
 * Everything a view needs beyond the entity row itself (C8).
 *
 * ONE object, built once in the composition root and handed to BOTH surfaces. It used to be two
 * independent optional fields plus a third for the download route, and the MCP transport passed
 * one of them and forgot the other — so `get_entity` over MCP reported an entity with no legal
 * documents while `GET /entities/:id` over REST reported the same entity with two. Nothing failed;
 * the agent surface was simply, silently, less true than the browser one.
 *
 * As one object it cannot happen: there is no partial to pass.
 */
export interface EntityViewDeps {
  /** How a view learns a record's formation progress (design §5/§8). A function rather than the
   *  repository so the view stays a pure projection and the caller decides where the rows come
   *  from. */
  formationSteps?: FormationStepsLookup;
  /**
   * The document index. A repository rather than a lookup, because the download route needs
   * `findOwned` from the SAME object — and a deployment that has one and not the other is the
   * split this type exists to prevent.
   */
  documents?: DocumentIndexRepository;
}

/**
 * The formation projection itself lives in `src/formation/status.ts` — the sweeper needs it too,
 * and a timer importing from `api/` is a layering inversion a test now forbids. Re-exported here
 * so the view module still names the type it renders.
 */
export type { FormationStatus };

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
  /**
   * Formation (design §2/§8). NULL = stub, forever — the shape every legacy row keeps and the
   * shape every credential-less deployment serves. The shared `FormationSummary` is everything
   * that is safe on ANY surface; the two fields below it are the OWNER-ONLY additions, and they
   * are spelled out here rather than in the summary so an unauthenticated surface cannot grow
   * them by spreading it. NO PII is ever served here — not a name, not an address, not an email.
   */
  formation:
    | (FormationSummary & {
        /**
         * ⚠ AUTHENTICATED VIEWS ONLY. The EIN is a tax identifier: it belongs to the entity's
         * owner and to nobody else. It reaches this projection — which serves GET /entities and
         * the MCP read tools, both tenant-scoped — and it must NEVER reach `/transparency` or
         * `/metadata`, which are unauthenticated. Both of those build their own row shapes from
         * `formationSummary`, and a test asserts neither can grow this field.
         */
        ein: string | null;
        /** The legal documents fetched so far. Metadata only — the bytes come from the download
         *  route, which re-asserts ownership of its own. */
        documents: DocumentView[];
      })
    | null;
}

/** The document metadata a tenant sees, in the ONE shape both surfaces render (M4). The bytes
 *  come from the download route, which re-asserts ownership of its own. */
export interface DocumentView {
  id: string;
  type: string;
  name: string;
  size: number;
  /** What a verifier re-computes from the downloaded bytes. */
  sha256: string;
}

/** One projection for `GET /entities/:id/documents`, the entity view, and the MCP read tools —
 *  three renderers of the same row is three chances for them to describe it differently. */
export function toDocumentView(d: DocumentIndexRecord): DocumentView {
  return {
    id: d.id,
    type: d.docType,
    // DERIVED from the doc type, never echoed from doola's `name` field.
    name: documentFileName(d.docType),
    size: d.size,
    sha256: d.sha256,
  };
}

/**
 * The single choke point for everything a tenant is told about an entity.
 *
 * `deps` is optional so every pre-formation caller compiles unchanged; absent, a record simply
 * reports the status its own columns can prove, which is `none`.
 */
export function toEntityView(r: EntityRecord, deps: EntityViewDeps = {}): EntityView {
  // Read ONCE, and only for a row that is actually pinned. The projection asks three questions
  // of the same rows (status, provider ref, required actions), and calling the lookup per
  // question meant three queries per entity on every list response — while an UNPINNED row (every
  // legacy entity, every stub deployment) needs none of them at all, and the list routes are
  // mostly unpinned rows.
  const pinned = Boolean(r.formationProvider && r.formationEnvironment);
  const steps = pinned ? (deps.formationSteps?.(r.idempotencyKey) ?? []) : [];
  const summary = pinned ? formationSummary(r, steps) : null;
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
    formation: summary
      ? {
          ...summary,
          // The real EIN, once the IRS issues one. `r.ein` is the placeholder frozen on-chain at
          // mint and is never served as a legal fact.
          ein: r.einReal ?? null,
          documents: (deps.documents?.listByEntity(r.idempotencyKey) ?? []).map(toDocumentView),
        }
      : null,
  };
}
