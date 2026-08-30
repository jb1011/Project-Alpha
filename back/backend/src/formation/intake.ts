import type { DoolaEnvironment } from "../adapters/doola/types";

/**
 * The company INTAKE vocabulary (design 2026-08-26 §2/§5) — the facts a filing is made of, in
 * the one shape the whole system stores them in.
 *
 * It lives here rather than in `workflow/formationProvider` because three layers now need it and
 * one of them is the DATABASE MIGRATION: `db.ts` synthesizes a `companies` row for every entity
 * that predates the table, and it has to synthesize the SAME shape the live intake writes. A
 * persistence module reaching into the workflow layer to borrow a constant would be the wrong
 * direction; the filer re-exports these instead, so nothing above it changed its imports.
 */

/**
 * We form Wyoming LLCs. Both are constants rather than caller fields on purpose: the jurisdiction
 * is a product decision, and a caller-chosen state would file into a legal regime the OA, the
 * treasury contracts and the compliance calendar were not written for.
 */
export const FORMATION_STATE = "WY";
export const FORMATION_ENTITY_TYPE = "LLC";

/** A NAICS `industry` label from `GET /v1/partner/references/naics-codes` (verified live
 *  2026-08-21; maps to 541511). `industry` or `naicsCode` is REQUIRED by the create, and doola
 *  has DEPRECATED the code — the wire wants the label, which is why no code is stored. */
export const DEFAULT_INDUSTRY = "Software development";

/** `description` is REQUIRED by the create. The caller's own purpose wins when they wrote one;
 *  this is the fallback, and it is deliberately a true statement about the entity. */
export const DEFAULT_DESCRIPTION =
  "An autonomous software agent operating under an on-chain governed operating agreement.";

/**
 * ONE stored shape for name candidates: `[{name, entityTypeEnding, position}]`.
 *
 * The migration, the A1 shim and (from A2) the real three-name form all produce it through this
 * function, because three producers of three shapes is how a matcher ends up guessing. `name` is
 * the bare company name WITHOUT its entity ending — `entityTypeEnding` carries that — so a
 * trailing "LLC" in the agent's name is not filed as "Acme LLC LLC", and doola's list item (which
 * reports the accepted name without its ending) can be compared against it directly.
 */
export interface CompanyNameOption {
  name: string;
  entityTypeEnding: string;
  position: number;
}

export function companyNameOptions(...names: string[]): CompanyNameOption[] {
  return names.map((raw, i) => ({
    name: stripEntityEnding(raw),
    entityTypeEnding: FORMATION_ENTITY_TYPE,
    position: i + 1,
  }));
}

/**
 * Strip a trailing `LLC` / `L.L.C.` — the ending is a separate field on the wire.
 *
 * A name that is NOTHING BUT an ending strips to the EMPTY STRING, deliberately. The old version
 * anchored on `[\s,]+`, so a bare `"LLC"` never matched, and its `|| raw.trim()` fallback then
 * handed the ending back as the name — which made the ending-only guard in `createCompany`
 * unreachable and would have filed a Wyoming LLC called "LLC LLC". Returning empty is what lets
 * that guard fire.
 */
export function stripEntityEnding(raw: string): string {
  return raw.replace(/(^|[\s,]+)(l\.?l\.?c\.?)$/i, "").trim();
}

/**
 * The comparison form for "is this the name the state accepted?" (§5).
 *
 * BOTH sides are normalized — ours and doola's — because doola reports the accepted name as free
 * text and the only safe use of it is as a KEY into our own candidates. Trim, NFC, drop a
 * trailing ending in any of its spellings, casefold.
 */
export function normalizeCompanyName(raw: string): string {
  return raw
    .normalize("NFC")
    .trim()
    .replace(/[\s,]+(l\.?l\.?c\.?|limited\s+liability\s+company)$/i, "")
    .trim()
    .toLowerCase();
}

/** The intake a company row is minted from. A1 synthesizes it; A2 collects it. */
export interface CompanyIntake {
  nameOptions: CompanyNameOption[];
  businessPurpose: string;
  industryLabel: string;
  /** True = the values above were DERIVED (the migration or the A1 shim), not typed by a human. */
  synthesized: boolean;
}

/**
 * The A1 intake: one name candidate derived from the agent's name, the default purpose and the
 * default industry, marked `synthesized` on the ROW (never as a key inside `name_options`, which
 * keeps exactly one shape).
 */
export function synthesizeIntake(agentName: string, description?: string | null): CompanyIntake {
  return {
    nameOptions: companyNameOptions(agentName),
    businessPurpose: description?.trim() || DEFAULT_DESCRIPTION,
    industryLabel: DEFAULT_INDUSTRY,
    synthesized: true,
  };
}

/** What the company row pins a filing to. Written from the DEPLOYMENT, never from caller input. */
export interface CompanyPin {
  provider: string;
  environment: DoolaEnvironment;
}
