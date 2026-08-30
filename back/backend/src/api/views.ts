import {
  type FormationStatus,
  type FormationSummary,
  deriveFormationStatus,
  formationSummary,
  livePaymentLookup,
} from "../formation/status";
import type { CompanyRecord } from "../persistence/companyRepository";
import {
  type DocumentIndexRecord,
  type DocumentIndexRepository,
  documentFileName,
} from "../persistence/documentIndexRepository";
import type { FormationRequestRecord } from "../persistence/formationRepository";
import type { EntityRecord } from "../types";
import { usesManifestScheme } from "../workflow/onboarding";

/** The formation sub-saga rows of one COMPANY. A function rather than the repository so the view
 *  stays a pure projection and the caller decides where the rows come from. */
export type FormationStepsLookup = (companyId: string) => FormationRequestRecord[];

/** How a view learns the company an entity is attached to. Same shape, same reason. */
export type CompanyLookup = (companyId: string) => CompanyRecord | undefined;

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
   * The BATCHED twin, for the list routes (M5). Optional: absent, a list falls back to one
   * lookup per row, which is what every caller did before.
   */
  formationStepsMany?: (companyIds: string[]) => Map<string, FormationRequestRecord[]>;
  /**
   * The COMPANY an entity is attached to (2026-08-26 §3) — where the pin and the filing facts
   * now live. Absent, a pinned entity renders `formation: null`: the honest answer for a
   * projection that cannot read the row the facts are in, and never a half-populated block.
   */
  company?: CompanyLookup;
  companyMany?: (companyIds: string[]) => Map<string, CompanyRecord>;
  /**
   * The document index. A repository rather than a lookup, because the download route needs
   * `findOwned` from the SAME object — and a deployment that has one and not the other is the
   * split this type exists to prevent. Narrowed to the two READS a view can make, so a batched
   * stand-in satisfies it; `ApiDeps` re-declares it as the full repository.
   */
  documents?: Pick<DocumentIndexRepository, "listByCompany" | "listByEntities">;
}

/**
 * ONE row of the company list (design §7).
 *
 * `GET /companies` and MCP `list_companies` are one API-level contract — the reuse picker's
 * ordering and its labels — so they render through one function rather than two literals. The
 * agent surface had already drifted: it dropped the business purpose, the industry and both
 * filing facts.
 *
 * NO PII, exactly as everywhere else: the responsible party is not projected here and neither is
 * the filed party's name. A company's own name candidates are not personal data.
 */
export interface CompanyView {
  companyId: string;
  status: CompanyRecord["status"];
  environment: CompanyRecord["environment"];
  synthetic: boolean;
  nameOptions: CompanyRecord["nameOptions"];
  legalNameFiled: string | null;
  businessPurpose: string;
  industryLabel: string;
  /** DERIVED from the sub-saga rows; nothing about progress is stored on the company. */
  formationStatus: FormationStatus;
  /** DERIVED from `formation_payments`; nothing about payment is stored on the company either. */
  paying: boolean;
  filedAt: number | null;
  filingNumber: string | null;
  /** How many agents SHARE this filing. Authenticated surfaces only (§7 sharing labels). */
  agents: number;
  createdAt: string;
}

/** What a company list needs beyond the rows themselves. */
export interface CompanyListDeps {
  companies: import("../persistence/companyRepository").CompanyRepository;
  /** The batched steps lookup. Absent, each row falls back to its own read. */
  formationStepsMany?: (companyIds: string[]) => Map<string, FormationRequestRecord[]>;
  formationSteps?: FormationStepsLookup;
}

/**
 * A tenant's companies, NEWEST FIRST, in FOUR queries however long the page is (M5).
 *
 * Every row used to ask for its own steps, its own live-payment count and its own agent count:
 * 3N+1 queries per page view, on two authenticated surfaces. The ordering is the repository's,
 * because it is an API-level contract shared with the wizard's picker — two renderers sorting for
 * themselves is how a picker ends up disagreeing with the list behind it.
 */
export function listCompanyViews(deps: CompanyListDeps, tenantId: string): CompanyView[] {
  const rows = deps.companies.listByTenant(tenantId);
  const ids = rows.map((r) => r.companyId);
  const steps = deps.formationStepsMany?.(ids);
  const agents = deps.companies.countAgentsMany(ids);
  const paying = livePaymentLookup(deps.companies, ids);
  return rows.map((company) => ({
    companyId: company.companyId,
    status: company.status,
    environment: company.environment,
    synthetic: company.synthetic,
    nameOptions: company.nameOptions,
    legalNameFiled: company.legalNameFiled,
    businessPurpose: company.businessPurpose,
    industryLabel: company.industryLabel,
    formationStatus: deriveFormationStatus(
      steps?.get(company.companyId) ?? deps.formationSteps?.(company.companyId) ?? [],
    ),
    paying: paying(company.companyId),
    filedAt: company.filedAt,
    filingNumber: company.filingNumber,
    agents: agents.get(company.companyId) ?? 0,
    createdAt: company.createdAt,
  }));
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
        /**
         * The in-flight version's NUMBER — for DISPLAY beside the pending hash ("update pending
         * (v3)"), and for nothing else. A guardian deciding whether to veto reads the hash off
         * the chain, never off this projection (audit H4): a compromised backend that could
         * choose which hash the veto card shows could steer the veto itself.
         */
        pendingVersion: number | null;
        /**
         * Unix **SECONDS** the pending amendment becomes executable on-chain; null until the
         * schedule tx has confirmed. Seconds, like the column and like the chain — the veto card
         * multiplies by 1000 exactly once, at the edge.
         */
        amendmentExecutableAt: number | null;
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
  const companyId = r.companyId ?? null;
  const steps = companyId ? (deps.formationSteps?.(companyId) ?? []) : [];
  // ONE snapshot of the company row, used by BOTH the summary and the EIN below. Two lookups
  // meant two queries per pinned entity on every list response — and, worse, two answers: the
  // row can move between them, so a page could render a filing's status from one version of the
  // row and its EIN from another.
  const company = companyId ? deps.company?.(companyId) : undefined;
  const summary = companyId ? formationSummary(company, steps) : null;
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
          pendingVersion: r.oaManifestPendingVersion ?? null,
          amendmentExecutableAt: r.oaAmendmentExecutableAt ?? null,
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
          // The EIN now lives on the COMPANY: one filing, one EIN, however many agents share it.
          ein: company?.ein ?? null,
          documents: (companyId ? (deps.documents?.listByCompany(companyId) ?? []) : []).map(
            toDocumentView,
          ),
        }
      : null,
  };
}

/**
 * The LIST projection (M5).
 *
 * `GET /entities`, the MCP `list_entities`/`claim_connection` tools and `/transparency` all render
 * every entity a caller can see, and each row used to ask for its own formation steps and its own
 * documents — two queries per entity, per page view, on the hottest read paths in the API and on
 * an unauthenticated public surface. Here the two reads happen ONCE for the whole page.
 *
 * Only PINNED rows are looked up at all: an unpinned entity has no formation to describe, and on
 * most deployments most rows are unpinned.
 *
 * Falls back to the per-row path when the batched lookups are not wired, so every existing caller
 * keeps working with whatever it already passes.
 */
export function toEntityViews(rows: EntityRecord[], deps: EntityViewDeps = {}): EntityView[] {
  const entityKeys = rows.filter((r) => r.companyId).map((r) => r.idempotencyKey);
  // De-duplicated: under N:1 a page of ten agents may be one company, and asking for its steps
  // ten times is the N+1 this function exists to remove.
  const companyIds = [...new Set(rows.map((r) => r.companyId).filter((c): c is string => !!c))];
  if (companyIds.length === 0) return rows.map((r) => toEntityView(r, deps));

  const steps = deps.formationStepsMany?.(companyIds);
  const companies = deps.companyMany?.(companyIds);
  // Still ENTITY-shaped at this boundary: the repository joins through `entities.company_id`, so
  // two agents sharing a filing each render the same documents.
  const docs = deps.documents?.listByEntities?.(entityKeys);
  if (!steps && !docs && !companies) return rows.map((r) => toEntityView(r, deps));

  // Re-grouped by company for the per-row read below. Every entity attached to one company sees
  // the SAME rows (the join is on `company_id`), so the first non-empty answer is the answer.
  const docsByCompany = new Map<string, DocumentIndexRecord[]>();
  if (docs)
    for (const r of rows) {
      const c = r.companyId;
      if (!c || docsByCompany.get(c)?.length) continue;
      docsByCompany.set(c, docs.get(r.idempotencyKey) ?? []);
    }

  const batched: EntityViewDeps = {
    ...deps,
    formationSteps: steps ? (k) => steps.get(k) ?? [] : deps.formationSteps,
    company: companies ? (k) => companies.get(k) : deps.company,
    documents: docs
      ? { listByCompany: (c) => docsByCompany.get(c) ?? [], listByEntities: () => docs }
      : deps.documents,
  };
  return rows.map((r) => toEntityView(r, batched));
}
