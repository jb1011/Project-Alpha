import { awaitsSsnDecision } from "../formation/freeze";
import {
  type CompanyState,
  type FormationStatus,
  type FormationSummary,
  companyState,
  deriveFormationStatus,
  formationSummary,
  hasLivePayment,
  livePaymentLookup,
  providerRefOf,
  requiredActionCodesOf,
} from "../formation/status";
import type { CompanyRecord } from "../persistence/companyRepository";
import {
  type DocumentIndexRecord,
  type DocumentIndexRepository,
  documentFileName,
} from "../persistence/documentIndexRepository";
import { parseDetail } from "../persistence/formationRepository";
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
  documents?: Pick<DocumentIndexRepository, "listByCompany"> &
    Partial<Pick<DocumentIndexRepository, "listByCompanies">>;
  /**
   * How many agents share each company — the §7 SHARING LABEL's one input.
   *
   * Narrowed to the two counting reads, batched twin included, because a page of ten agents may
   * be one company and asking ten times is the N+1 `toEntityViews` exists to remove.
   *
   * ⚠ AUTHENTICATED SURFACES ONLY, and structurally so: this dependency reaches `EntityView`,
   * which serves `GET /entities` and the three tenant-scoped MCP read tools. `/transparency` and
   * `/metadata` build their row shapes from `formationSummary` and never see this object at all.
   */
  companyAgents?: Pick<
    import("../persistence/companyRepository").CompanyRepository,
    "countAgents" | "countAgentsMany"
  >;
}

/**
 * EVERY KEY OF `EntityViewDeps`, as a runtime list — and a COMPILE ERROR if one is missing.
 *
 * `EntityViewDeps` was made one object because the MCP transport used to enumerate the view
 * dependencies by hand and forgot the document index: `get_entity` over MCP described an entity
 * with no legal documents while REST described the same entity with two, and nothing failed.
 * The type stopped the object from being PARTIAL; it did not stop a second surface from picking
 * a subset of it, and the transport went on doing exactly that — so A3's sharing label reached
 * REST and not MCP, and the bug reappeared field-for-field.
 *
 * This is the fix that closes the class rather than the instance. `entityViewDepsOf` copies the
 * whole set, the list lives NEXT TO the interface where a field is actually added, and
 * `_assertEveryEntityViewDepListed` below fails to COMPILE if a new key is not added to it.
 */
export const ENTITY_VIEW_DEP_KEYS = [
  "formationSteps",
  "formationStepsMany",
  "company",
  "companyMany",
  "documents",
  "companyAgents",
] as const satisfies readonly (keyof EntityViewDeps)[];

/** Fails to compile the moment `EntityViewDeps` grows a key the list above does not name. */
type MissingEntityViewDep = Exclude<keyof EntityViewDeps, (typeof ENTITY_VIEW_DEP_KEYS)[number]>;
const _assertEveryEntityViewDepListed: MissingEntityViewDep extends never ? true : never = true;
void _assertEveryEntityViewDepListed;

/** The view slice of a larger dependency object — the ONE way a second surface takes it. */
export function entityViewDepsOf(deps: EntityViewDeps): EntityViewDeps {
  const out: Record<string, unknown> = {};
  for (const key of ENTITY_VIEW_DEP_KEYS) out[key] = deps[key];
  return out as EntityViewDeps;
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
  /**
   * The three facts above, combined into the ONE word §7's Companies section renders.
   *
   * Kept BESIDE its inputs rather than replacing them: a picker filtering for "attachable" wants
   * the raw `status`, and the honesty invariant is asserted against `environment`. The
   * combination is what three renderers would otherwise each do for themselves.
   */
  state: CompanyState;
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
  return rows.map((company) => {
    // ONE steps read and ONE payment read per row, named once each: `formationStatus` and
    // `state` are two projections of the same rows, and asking twice is two queries AND two
    // possibly-different answers.
    const rowSteps =
      steps?.get(company.companyId) ?? deps.formationSteps?.(company.companyId) ?? [];
    const rowPaying = paying(company.companyId);
    return {
      companyId: company.companyId,
      status: company.status,
      environment: company.environment,
      synthetic: company.synthetic,
      nameOptions: company.nameOptions,
      legalNameFiled: company.legalNameFiled,
      businessPurpose: company.businessPurpose,
      industryLabel: company.industryLabel,
      formationStatus: deriveFormationStatus(rowSteps),
      paying: rowPaying,
      state: companyState(company, rowSteps, rowPaying),
      filedAt: company.filedAt,
      filingNumber: company.filingNumber,
      agents: agents.get(company.companyId) ?? 0,
      createdAt: company.createdAt,
    };
  });
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
         * OUR company id — the key the legal documents, the compliance calendar and the company
         * detail page are all addressed by (§7, A3). ⚠ AUTHENTICATED VIEWS ONLY, like the two
         * fields below it: it is an opaque handle, but it is a handle to the tenant's own
         * filing, and the public surfaces publish doola's `providerRef` instead.
         *
         * It is here because the document routes moved to `/companies/:companyId/documents/:id`:
         * without it a dashboard holding an entity view could not build the URL for a document
         * the same view had just listed.
         */
        companyId: string;
        /**
         * HOW MANY AGENTS SHARE THIS FILING, including this one (§7 sharing labels).
         *
         * `1` means not shared. The total rather than "others" deliberately: an off-by-one that
         * lives in the FIELD is an off-by-one every renderer inherits, whereas a UI that wants
         * "shared with 2 others" subtracts once, at the edge, where the sentence is written.
         *
         * ⚠ AUTHENTICATED VIEWS ONLY, exactly like the EIN below. Two agents sharing a company
         * are already publicly linkable through their anchored manifests (`legal.providerCompanyId`
         * is in every one of them) — which is a fact the reuse picker DISCLOSES before a caller
         * confirms — but publishing the COUNT on `/transparency` would hand a stranger the size
         * of a tenant's fleet, which no public surface has ever carried.
         *
         * `null` = this surface did not count, never "not shared": an attached entity always has
         * at least itself, so a 0 here would be a lie and a 1 would be a guess.
         */
        sharedWith: number | null;
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
          // Non-null by construction: `summary` is null unless `companyId` is set.
          companyId: companyId as string,
          sharedWith: companyId ? (deps.companyAgents?.countAgents(companyId) ?? null) : null,
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
  // De-duplicated: under N:1 a page of ten agents may be one company, and asking for its steps
  // ten times is the N+1 this function exists to remove.
  const companyIds = [...new Set(rows.map((r) => r.companyId).filter((c): c is string => !!c))];
  if (companyIds.length === 0) return rows.map((r) => toEntityView(r, deps));

  const steps = deps.formationStepsMany?.(companyIds);
  const companies = deps.companyMany?.(companyIds);
  // COMPANY-keyed, like everything else on this path. It used to go entity → `entities.company_id`
  // → documents and back through a join, which is a round trip to recover a key the caller was
  // already holding — and one that cannot answer for a company with no agent attached.
  const docs = deps.documents?.listByCompanies?.(companyIds);
  // ONE grouped scan for the whole page's sharing labels, for the reason every other lookup here
  // is batched: under N:1 a page of ten agents may be one company.
  const shared = deps.companyAgents?.countAgentsMany(companyIds);
  if (!steps && !docs && !companies && !shared) return rows.map((r) => toEntityView(r, deps));

  const batched: EntityViewDeps = {
    ...deps,
    formationSteps: steps ? (k) => steps.get(k) ?? [] : deps.formationSteps,
    company: companies ? (k) => companies.get(k) : deps.company,
    // Only `listByCompany` — the one read `toEntityView` makes. The old shape also carried a
    // `listByEntities: () => docs` stub that ignored its argument entirely, which is a lie in the
    // type system's own terms and would have answered any caller with the whole page's rows.
    documents: docs ? { listByCompany: (c) => docs.get(c) ?? [] } : deps.documents,
    companyAgents: shared
      ? {
          // A company absent from the map has no rows, which is a count of zero — but a company
          // an ENTITY is attached to always has at least that entity, so this branch is reached
          // only for a page whose row set and count set disagree, and `?? 0` is the honest
          // arithmetic rather than a guess.
          countAgents: (c) => shared.get(c) ?? 0,
          countAgentsMany: () => shared,
        }
      : deps.companyAgents,
  };
  return rows.map((r) => toEntityView(r, batched));
}

/**
 * ONE COMPANY, in full (design §7) — what the Companies section's detail page renders, and what
 * MCP `get_company` answers with.
 *
 * It EXTENDS the list row rather than restating it, so the two cannot describe the same company
 * differently, and adds the four things a list has no room for: the documents, the agents sharing
 * the filing, the open required actions, and — the reason this view exists at all — the PARK
 * STATE.
 *
 * **The park state is the product decision here.** A2 gave a filing three ways to stop and wait
 * for a human, all of them correct and none of them visible: a rejected intake
 * (`awaitingIntakeEdit`), a rejected responsible party (`awaitingPartyEdit`), and an SSN the
 * seven-day clock erased before the first send (§4.6a). To the owner all three looked identical —
 * a company that had simply stopped — and two of the three have an exit they alone can take. So
 * the view says which one it is, and the section renders the sentence and the form that clears it.
 *
 * NO PII, exactly as everywhere else. `awaitingPartyEdit` says a party field was refused; it does
 * not say WHICH, because doola's rejection prose is free text their operators write and can name
 * the responsible party. The SSN park is read through `parties.ssnState`, which selects an enum
 * and a NULL-check and no personal column at all.
 */
export interface CompanyDetailView extends CompanyView {
  /** True = the intake was DERIVED by the migration, not typed by a human. The section says so:
   *  a company nobody described is one whose names are worth checking before it files. */
  intakeSynthesized: boolean;
  /** doola's company id, once the create has returned one. An opaque provider reference. */
  providerRef: string | null;
  /** The real EIN, once the IRS issues one. ⚠ Owner-scoped surfaces only, like `EntityView`'s. */
  ein: string | null;
  /** Open required-action CODES only — never doola's free-text reason (see `FormationSummary`). */
  requiredActions: string[];
  /** The legal documents fetched so far. Metadata only; the bytes come from the download route,
   *  which re-asserts ownership of its own. */
  documents: DocumentView[];
  /** The agents attached to this filing. `agents` (inherited) is this array's length. */
  attachedAgents: { id: string; name: string; status: EntityRecord["status"] }[];
  /** What stopped this filing and who can restart it. All three are false on a healthy company. */
  park: {
    /** A doola-rejected INTAKE. Exit: `PATCH /companies/:companyId` with new names/purpose/
     *  industry — one edit buys one retry. */
    awaitingIntakeEdit: boolean;
    /** A doola-rejected responsible PARTY. Exit: `PATCH /formation-party/:partyId`. */
    awaitingPartyEdit: boolean;
    /** The §4.6a clock erased an SSN before the filing was ever sent. Exit:
     *  `PATCH /companies/:companyId` with a fresh `ssn`, or `proceedWithoutSsn: true`. */
    awaitingSsnDecision: boolean;
  };
}

/**
 * What a company detail needs beyond the company row — shaped so that the SHARED dependency
 * object both doors already hold satisfies it structurally.
 *
 * That is the parity mechanism, and it is the `EntityViewDeps` lesson applied one view along:
 * REST `GET /companies/:companyId` and MCP `get_company` are handed the same object, so a field
 * cannot be wired on one surface and forgotten on the other. `parties` sits under `formation`
 * because that is where the composition root puts it, and it is optional because a box that
 * merely DESCRIBES old filings has no PII surface at all — such a company simply reports no SSN
 * park, which is the truth.
 */
export interface CompanyDetailDeps {
  companies: import("../persistence/companyRepository").CompanyRepository;
  formationSteps?: FormationStepsLookup;
  documents?: Pick<DocumentIndexRepository, "listByCompany">;
  repo: Pick<import("../persistence/entityRepository").EntityRepository, "listByCompany">;
  formation?: {
    parties: Pick<
      import("../persistence/formationPartyRepository").FormationPartyRepository,
      "ssnState"
    >;
  };
}

export function toCompanyDetailView(
  deps: CompanyDetailDeps,
  company: CompanyRecord,
): CompanyDetailView {
  const steps = deps.formationSteps?.(company.companyId) ?? [];
  const attachedAgents = deps.repo.listByCompany(company.companyId).map((e) => ({
    id: e.idempotencyKey,
    name: e.name,
    status: e.status,
  }));
  const create = steps.find((s) => s.step === "create_provider");
  const detail = parseDetail<{ awaitingIntakeEdit?: boolean; awaitingPartyEdit?: boolean }>(
    create?.detail ?? null,
  );
  const paying = hasLivePayment(deps.companies, company.companyId);
  return {
    companyId: company.companyId,
    status: company.status,
    environment: company.environment,
    synthetic: company.synthetic,
    nameOptions: company.nameOptions,
    legalNameFiled: company.legalNameFiled,
    businessPurpose: company.businessPurpose,
    industryLabel: company.industryLabel,
    formationStatus: deriveFormationStatus(steps),
    paying,
    state: companyState(company, steps, paying),
    filedAt: company.filedAt,
    filingNumber: company.filingNumber,
    // The list's own field, and this page's `attachedAgents.length` — one number, counted from
    // the rows it names rather than from a second query that could disagree with them.
    agents: attachedAgents.length,
    createdAt: company.createdAt,
    intakeSynthesized: company.intakeSynthesized,
    providerRef: providerRefOf(steps),
    ein: company.ein,
    requiredActions: requiredActionCodesOf(steps),
    documents: (deps.documents?.listByCompany(company.companyId) ?? []).map(toDocumentView),
    attachedAgents,
    park: {
      awaitingIntakeEdit: detail.awaitingIntakeEdit === true,
      awaitingPartyEdit: detail.awaitingPartyEdit === true,
      // The SHARED predicate — the filer asks the same question of the same row, and two
      // spellings of "is this waiting for the owner?" is one spelling too many.
      awaitingSsnDecision: awaitsSsnDecision(
        create,
        deps.formation?.parties.ssnState(company.companyId),
      ),
    },
  };
}
