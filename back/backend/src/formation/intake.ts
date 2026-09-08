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

// ── canonicalization + limits (design §5, A2) ───────────────────────────────────────────────

/**
 * CANONICALIZE, once, at the door: NFC then trim, and nothing else.
 *
 * Two forms of one string must not become two candidates, and the stored value must be the value
 * SENT — the filer forwards `name_options` verbatim, and the §5 matcher compares doola's reported
 * name against exactly these rows. Any further transformation here would be a value the caller
 * did not type being filed with the state.
 */
export function canonicalizeIntakeText(raw: string): string {
  return raw.normalize("NFC").trim();
}

/** Exactly three candidates (§5). Wyoming refuses a taken name and a retry is a second fee. */
export const NAME_OPTION_COUNT = 3;
/** The stored/sent length bound, matching A1's single-name limit. */
export const NAME_MAX_LENGTH = 120;
/** doola requires a description and does not document a maximum; this keeps the body sane and
 *  the filed purpose readable. */
export const PURPOSE_MAX_LENGTH = 500;

/**
 * The characters Wyoming accepts in an entity name — deliberately NARROW.
 *
 * ASCII letters, digits, spaces and `& ' - , . ( ) +`. The two errors are not symmetric: a name
 * we refuse that Wyoming would have accepted is an annoyance with a message naming the character,
 * while a name Wyoming refuses costs a filing fee, parks the company and needs a human. Widening
 * this set later is one line and a test; narrowing it after a caller has filed is not.
 *
 * Accented letters are OUT for the same reason — the Secretary of State's published standard is
 * English letters and Arabic numerals, and a canonicalized "Café" would be filed as typed.
 */
/**
 * The class body, as a SOURCE STRING — so `GET /formation/rules` can serve it and the browser can
 * compile the same rule rather than keeping a second copy of it (§5/§7).
 *
 * A string rather than the `RegExp` because a regex does not survive JSON, and the CLASS BODY
 * rather than a whole pattern because the client must not be handed an anchor, a flag set or a
 * quantifier it did not choose: it compiles `^[…]$` around this and tests one character at a
 * time, exactly as `firstIllegalNameChar` does below.
 */
export const NAME_CHARSET_SOURCE = "A-Za-z0-9 &'\\-,.()+";

const NAME_CHARSET = new RegExp(`^[${NAME_CHARSET_SOURCE}]*$`);

/** The first character the charset refuses, or null. Returned rather than a boolean so the
 *  refusal can name it. */
export function firstIllegalNameChar(name: string): string | null {
  for (const ch of name) if (!NAME_CHARSET.test(ch)) return ch;
  return null;
}

/**
 * The DUPLICATE comparison form.
 *
 * `normalizeCompanyName` plus a whitespace collapse: "Acme  Robotics" and "Acme Robotics LLC" are
 * one candidate as far as Wyoming is concerned, and three candidates that are really one leave
 * the filing with no fallback at all. The collapse lives HERE and not in the stored value,
 * because storage must stay the string the caller typed (see `canonicalizeIntakeText`).
 */
export function duplicateKey(name: string): string {
  return normalizeCompanyName(name).replace(/\s+/g, " ");
}

/** The intake a company row is minted from. A1 synthesizes it; A2 collects it. */
export interface CompanyIntake {
  nameOptions: CompanyNameOption[];
  businessPurpose: string;
  industryLabel: string;
  /** True = the values above were DERIVED (the migration or the A1 shim), not typed by a human. */
  synthesized: boolean;
}

/** What the company row pins a filing to. Written from the DEPLOYMENT, never from caller input. */
export interface CompanyPin {
  provider: string;
  environment: DoolaEnvironment;
}
