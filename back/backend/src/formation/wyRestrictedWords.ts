import { canonicalizeIntakeText } from "./intake";

/**
 * Wyoming's RESTRICTED words for an LLC name, as DATA (design 2026-08-26 §5).
 *
 * A restricted word is one Wyoming will not file without evidence of a licence, a charter or a
 * consent we do not have and cannot obtain on a caller's behalf — banking, insurance, the
 * licensed professions, a handful of federally protected marks. Sending one costs a real filing
 * fee and comes back as a doola `rejected`, which burns an attempt and puts the company in front
 * of a human. Refusing it at intake costs nothing and names the offending word.
 *
 * It is a DATA MODULE for two reasons the review will care about:
 *
 *  - the list is a legal fact about Wyoming, not a behaviour of ours, and it changes when
 *    Wyoming changes it. A list is editable by whoever reads the statute; a chain of `if`s is
 *    not;
 *  - it is deliberately CONSERVATIVE, and being conservative has to be cheap to correct. The two
 *    errors are not symmetric: refusing a name a caller could legitimately have filed is an
 *    annoyance with a clear message, while accepting one Wyoming refuses spends a fee and parks
 *    the filing. So a word stays on the list unless somebody removes it deliberately.
 *
 * Sources (W.S. 17-29-108 and the Secretary of State's published name standards, plus the
 * federal marks that are restricted in every state):
 *  - banking / trust: W.S. 13-1-102 reserves these to chartered institutions;
 *  - insurance: W.S. 26-3-101;
 *  - the licensed professions (engineering, architecture, surveying, law, medicine, pharmacy):
 *    a professional entity needs the board's consent, and an agent has no board;
 *  - "Olympic" (36 U.S.C. §220506), the federal-agency marks (18 U.S.C. §709) and "Realtor"
 *    (a registered trademark of the National Association of Realtors).
 *
 * ⚠ NOT a completeness claim. It is the set we refuse; Wyoming may still refuse a name that is
 * not on it, which is exactly what the `rejected` → edit-and-retry path (§4.7) is for.
 */

/**
 * The restricted terms, lower-cased, in the form they are matched.
 *
 * A multi-word entry is matched as a PHRASE with the whitespace between its words allowed to be
 * any run of separators — "credit union" must catch "Credit  Union" and "credit-union".
 */
export const WY_RESTRICTED_WORDS: readonly string[] = [
  // ── banking, trust and lending (W.S. 13-1-102) ────────────────────────────────────────────
  "bank",
  "banc",
  "banker",
  "bankers",
  "banking",
  "bancorp",
  "trust",
  "trustee",
  "credit union",
  "savings and loan",
  "building and loan",
  "thrift",
  "fiduciary",
  // ── insurance (W.S. 26-3-101) ─────────────────────────────────────────────────────────────
  "insurance",
  "insurer",
  "assurance",
  "casualty",
  "surety",
  "indemnity",
  "underwriter",
  "underwriters",
  "reinsurance",
  // ── the licensed professions ──────────────────────────────────────────────────────────────
  "engineer",
  "engineers",
  "engineering",
  "architect",
  "architects",
  "architecture",
  "surveyor",
  "surveying",
  "attorney",
  "attorneys",
  "lawyer",
  "lawyers",
  "law office",
  "law offices",
  "legal aid",
  "physician",
  "doctor",
  "dentist",
  "dentistry",
  "pharmacy",
  "pharmacist",
  "chiropractic",
  "chiropractor",
  "nursing",
  "veterinary",
  "veterinarian",
  "accountancy",
  "cpa",
  // ── federally protected marks ─────────────────────────────────────────────────────────────
  "olympic",
  "olympics",
  "olympiad",
  "realtor",
  "realtors",
  "red cross",
  "little league",
  "boy scouts",
  "girl scouts",
  "fbi",
  "cia",
  "secret service",
  "federal bureau",
  "united states government",
  "federal reserve",
  "department of treasury",
  "treasury department",
  "social security administration",
];

/**
 * The FIRST restricted word this name contains, or null.
 *
 * Matched on WORD BOUNDARIES, and that is the whole subtlety: a substring match refuses
 * "Banksy Robotics" for containing "bank" and "Trustworthy Systems" for containing "trust",
 * which is a refusal a caller cannot act on. A boundary is any non-letter/non-digit character or
 * the ends of the string, so "Bank-of-Agents" still matches while "Banksy" does not.
 *
 * The name is compared in a Unicode-normalized, case-folded form. It is NOT stripped of its
 * entity ending first: an ending is "LLC", which is on no list, and stripping would be one more
 * transformation to keep in step with the storage shape.
 */
export function findRestrictedWord(name: string): string | null {
  const haystack = canonicalizeIntakeText(name).toLowerCase();
  for (const [word, pattern] of TERM_PATTERNS) if (pattern.test(haystack)) return word;
  return null;
}

/**
 * The list, COMPILED ONCE at module load.
 *
 * It used to build a `RegExp` per word per call: eighty-odd compiles for every candidate, three
 * candidates per create, and again on every §4.7 edit. The patterns are a function of the list
 * alone, so nothing about them can change between calls — and the list is only going to get
 * longer, since a word joins it whenever Wyoming says so and never leaves.
 *
 * NOT `/g`: a global regex carries `lastIndex` across calls, so a shared instance would answer
 * differently on the second name it was asked about. `test` with no `/g` is stateless.
 */
const TERM_PATTERNS: readonly (readonly [string, RegExp])[] = WY_RESTRICTED_WORDS.map((word) => {
  const pattern = word.split(/\s+/).map(escapeRegExp).join("[^\\p{L}\\p{N}]+");
  // \p{L}\p{N} rather than \w: an accented letter is a letter, and `\w` would treat "Banké" as
  // a boundary after "Bank" and refuse it.
  return [word, new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "u")] as const;
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
