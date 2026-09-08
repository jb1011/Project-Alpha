import type { CompanyNameOption, CompanyView, FormationRules } from "@/lib/api/types";

/**
 * THE CREATE-COMPANY FORM'S OWN RULES (design §5) — a courtesy, and honest about being one.
 *
 * The backend's `createCompany` is the authority: it canonicalizes, validates, and refuses in
 * sentences this form renders verbatim. What lives here is the subset that can be checked without
 * a round trip, so a founder fixing three name fields does it in the form rather than one 400 at
 * a time.
 *
 * ⚠ **Wyoming's restricted-word list is deliberately NOT here, and not served either.** It is ~80
 * words that the backend holds (`src/formation/wyRestrictedWords.ts`), matched on letter
 * boundaries so "Banksy" is not refused for containing "bank" — which makes the MATCHER the rule
 * rather than the data. A copy in the bundle would be a second list, and the day the two disagree
 * the form either refuses a filable name or promises a name Wyoming will not take, after the fee.
 * The server's refusal NAMES the offending word, and the form shows it.
 *
 * ⚠ **The four LIMITS are no longer mirrored either.** They used to be four constants here, each
 * with a `Mirrors …` comment naming the backend value it copied — which is a second copy with a
 * promise attached. They come from `GET /formation/rules` now, and what stays local is only the
 * three PURE CANONICALIZATION functions below: they are string transforms, they are what the
 * validator has to apply before comparing anything, and a round trip cannot canonicalize a value
 * the user is still typing.
 */

/** Mirrors `canonicalizeIntakeText`: what the backend stores is what it compares. */
export function canonicalizeIntakeText(raw: string): string {
  return raw.normalize("NFC").trim();
}

/** Mirrors `stripEntityEnding`. A name that is NOTHING but an ending strips to empty, which is
 *  what makes the ending-only check below fire rather than filing "LLC LLC". */
export function stripEntityEnding(raw: string): string {
  return raw.replace(/(^|[\s,]+)(l\.?l\.?c\.?)$/i, "").trim();
}

/** Mirrors `duplicateKey`: the form Wyoming would compare two candidates in. */
export function duplicateKey(raw: string): string {
  return raw
    .normalize("NFC")
    .trim()
    .replace(/[\s,]+(l\.?l\.?c\.?|limited\s+liability\s+company)$/i, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * THE INDUSTRY LIST, PREPARED ONCE (design §5/§7).
 *
 * 821 federal labels, and three consumers that each walked all of them per keystroke: the
 * type-ahead's filter lowercased every label on every render, its exact-match check lowercased
 * them all AGAIN on the same render, and `validateCompanyIntake` ran `includes` over the raw
 * array — which the form calls on every keystroke of every field, not only the industry one.
 *
 * One pass, built when the list arrives and not again:
 *
 *  - `lowered` is the filter's input, already folded;
 *  - `byLower` makes "is what they typed exactly a label?" an O(1) lookup, and returns the label
 *    in its CANONICAL casing — which is what must be committed, because the door accepts the
 *    labels as shipped;
 *  - `known` is the exact-match set the validator asks.
 */
export interface IndustryIndex {
  /** As served, in the order doola published it — the picker sorts nothing for itself. */
  options: readonly string[];
  lowered: readonly { label: string; lower: string }[];
  byLower: ReadonlyMap<string, string>;
  known: ReadonlySet<string>;
}

/** `undefined` (the list has not arrived) yields an EMPTY index rather than a null one, so every
 *  consumer reads the same shape and nothing is claimed about a label until the list is in. */
export function industryIndex(options: readonly string[] | undefined): IndustryIndex {
  const list = options ?? [];
  const lowered = list.map((label) => ({ label, lower: label.toLowerCase() }));
  return {
    options: list,
    lowered,
    byLower: new Map(lowered.map(({ label, lower }) => [lower, label])),
    known: new Set(list),
  };
}

export type CompanyIntakeForm = {
  /** Exactly three, in order of preference. */
  names: string[];
  businessPurpose: string;
  industryLabel: string;
};

export type CompanyIntakeErrors = {
  /** Indexed by POSITION - 1, so the message lands under the field it is about. */
  names: (string | null)[];
  businessPurpose: string | null;
  industryLabel: string | null;
};

export const emptyCompanyIntake = (): CompanyIntakeForm => ({
  names: ["", "", ""],
  businessPurpose: "",
  industryLabel: "",
});

/**
 * A stored company row → the form that edits it (design §7).
 *
 * The row keeps the three candidates SPLIT — `{ name, entityTypeEnding, position }` — because
 * that is the shape the filer sends and the shape the §5 matcher compares against. A form binds
 * to whole strings, so somebody has to rejoin them, and three screens each did it inline with
 * `[0, 1, 2].map(...)`: the intake-edit form, the SSN-decision form (which re-sends the intake
 * UNCHANGED, so a difference there is a silent rewrite of a filing's names) and the park panel.
 *
 * One function, so "what the form shows" and "what an unchanged resubmission sends" cannot drift
 * — and a company with fewer than three stored options fills the gaps with empty strings rather
 * than shortening the array, because the door requires exactly three.
 */
export function intakeFormOf(
  company: {
    nameOptions: readonly CompanyNameOption[];
    businessPurpose: string;
    industryLabel: string;
  },
  rules: IntakeRules = FALLBACK_INTAKE_RULES,
): CompanyIntakeForm {
  return {
    names: Array.from({ length: rules.nameOptionCount }, (_, i) => {
      const option = company.nameOptions[i];
      return option ? `${option.name} ${option.entityTypeEnding}`.trim() : "";
    }),
    businessPurpose: company.businessPurpose,
    industryLabel: company.industryLabel,
  };
}

/**
 * Validate the three company fields, in the ORDER a caller typed them.
 *
 * `industryLabel` is checked against the list the backend served, not against a bundled copy —
 * the picker's options and the door's accepted set are one array, fetched from
 * `GET /formation/rules`. An empty `known` set means the list has not arrived yet, and
 * nothing is claimed about the label until it does.
 *
 * A `Set` rather than an array: this function runs on every keystroke of every field, and
 * `Array.includes` over 821 labels is a linear scan each time — paid on the name inputs too,
 * which have nothing to do with industries.
 */
export function validateCompanyIntake(
  form: CompanyIntakeForm,
  rules: IntakeRules = FALLBACK_INTAKE_RULES,
  known: ReadonlySet<string> = EMPTY_KNOWN,
): CompanyIntakeErrors {
  const names: (string | null)[] = [];
  const seen = new Map<string, number>();
  const charset = charsetOf(rules.nameCharset);

  for (let i = 0; i < rules.nameOptionCount; i++) {
    const position = i + 1;
    const name = canonicalizeIntakeText(form.names[i] ?? "");
    if (!name) {
      names.push(`Enter name option ${position}. Wyoming refuses a name that is already taken, and the alternates are what let the filing proceed without a second fee.`);
      continue;
    }
    if (name.length > rules.nameMaxLength) {
      names.push(`Keep this under ${rules.nameMaxLength} characters — that is the limit Wyoming files a company name under.`);
      continue;
    }
    const illegal = [...name].find((ch) => !charset.test(ch));
    if (illegal) {
      names.push(`"${illegal}" is not a character Wyoming accepts in a company name. Letters, digits, spaces and & ' - , . ( ) + only.`);
      continue;
    }
    if (!stripEntityEnding(name)) {
      names.push('This is only an entity ending — "LLC" on its own would be filed as "LLC LLC".');
      continue;
    }
    const key = duplicateKey(name);
    if (seen.has(key)) {
      names.push("This repeats an earlier option. Three identical names give the filing no alternative if the first is taken.");
      continue;
    }
    seen.set(key, position);
    names.push(null);
  }

  const purpose = canonicalizeIntakeText(form.businessPurpose);
  const industry = canonicalizeIntakeText(form.industryLabel);
  return {
    names,
    businessPurpose: !purpose
      ? "Say what the company does. This is filed with it, and it is the company's own purpose — not your agent's description."
      : purpose.length > rules.purposeMaxLength
        ? `Keep this under ${rules.purposeMaxLength} characters.`
        : null,
    industryLabel: !industry
      ? "Choose an industry."
      : known.size > 0 && !known.has(industry)
        ? "Choose one of the listed industries — the filing agent only accepts those."
        : null,
  };
}

/** Shared so the two defaults are one object rather than an allocation per call. */
const EMPTY_KNOWN: ReadonlySet<string> = new Set();

/** The four served limits — everything `validateCompanyIntake` needs beyond the label set. */
export type IntakeRules = Pick<
  FormationRules,
  "nameOptionCount" | "nameMaxLength" | "purposeMaxLength" | "nameCharset"
>;

/**
 * What to enforce while `GET /formation/rules` is still in flight.
 *
 * A form has to validate the keystroke in front of it, and a round trip is not available for
 * that. These are the values the backend ships today, and the failure mode of a drift is the
 * benign one: the served rules replace them the moment they arrive, before any submit that
 * matters — and the DOOR is the authority either way, refusing in sentences this form renders
 * verbatim.
 */
export const FALLBACK_INTAKE_RULES: IntakeRules = {
  nameOptionCount: 3,
  nameMaxLength: 120,
  purposeMaxLength: 500,
  nameCharset: "A-Za-z0-9 &'\\-,.()+",
};

/**
 * The served class body, compiled — `^[…]$`, tested ONE CHARACTER at a time, exactly as the
 * backend's `firstIllegalNameChar` does.
 *
 * Cached by source string, because `validateCompanyIntake` runs on every keystroke of every field
 * and compiling a regex per call is the kind of cost that only shows up on somebody's older
 * laptop. A source the browser cannot compile falls back rather than throwing on a form: an
 * exception here would take the whole step down over a character class.
 */
const CHARSET_CACHE = new Map<string, RegExp>();

function charsetOf(source: string): RegExp {
  const hit = CHARSET_CACHE.get(source);
  if (hit) return hit;
  let compiled: RegExp;
  try {
    compiled = new RegExp(`^[${source}]$`);
  } catch {
    compiled = new RegExp(`^[${FALLBACK_INTAKE_RULES.nameCharset}]$`);
  }
  CHARSET_CACHE.set(source, compiled);
  return compiled;
}

/** The rules a render should use: served where the fetch has landed, bundled where it has not. */
export function intakeRulesOf(rules: FormationRules | undefined): IntakeRules {
  return rules ?? FALLBACK_INTAKE_RULES;
}

export function isCompanyIntakeValid(
  form: CompanyIntakeForm,
  rules: IntakeRules = FALLBACK_INTAKE_RULES,
  known: ReadonlySet<string> = EMPTY_KNOWN,
): boolean {
  const e = validateCompanyIntake(form, rules, known);
  return !e.businessPurpose && !e.industryLabel && e.names.every((n) => n === null);
}

/**
 * MAY AN AGENT ATTACH TO THIS COMPANY? — the picker's filter, mirroring the backend's
 * `companyAcceptsAgents`.
 *
 * Advisory, exactly as the backend's own door check is: the binding answer is a CAS inside the
 * claim transaction. What it buys is that the picker does not offer a company the onboard would
 * refuse — a `draft` that still owes its payment, an `abandoned` one, or a filing that failed.
 *
 * `state` is the backend's derived word, so this reads the answer rather than recomputing it from
 * three fields. An UNKNOWN state (a value from a newer backend) is not attachable: offering a
 * company whose condition this build cannot read is a guess, and the guess costs an onboard.
 */
export function canAttach(company: Pick<CompanyView, "state">): boolean {
  return (
    company.state === "ready" ||
    company.state === "in_progress" ||
    company.state === "filed" ||
    company.state === "complete"
  );
}

/**
 * The company's display name: the name the STATE actually filed, or the first candidate.
 *
 * `legalNameFiled` is OUR candidate string that doola's reported name matched — never doola free
 * text — and it is null until a match is made, which is what keeps the manifest honest. Falling
 * back to candidate 1 is honest too, as long as nothing calls it "the filed name", which is why
 * the two are separate fields and this function is only ever a label.
 */
export function companyLabel(company: Pick<CompanyView, "legalNameFiled" | "nameOptions">): string {
  if (company.legalNameFiled) return company.legalNameFiled;
  const first = company.nameOptions[0];
  return first ? `${first.name} ${first.entityTypeEnding}`.trim() : "Unnamed company";
}

/**
 * THE WIZARD'S LEGAL-BODY BRANCH, as one pure function (design §7).
 *
 * Three decisions the step used to make inline, which is three decisions no test could reach —
 * and the interface runner is deliberately not a component runner, so anything worth asserting
 * has to be a function a component calls:
 *
 *  1. WHICH BRANCH. Attach is the default whenever there is anything to attach to, because that
 *     is the free path and the fast one — but only once the caller has not chosen otherwise. A
 *     caller who clicked "create" stays on create even if their company list arrives afterwards,
 *     or the screen flips out from under somebody who has started typing.
 *  2. WHAT IS ATTACHABLE. `canAttach`, which mirrors the backend's own predicate.
 *  3. WHICH IS SELECTED. The FIRST attachable row, because the server orders newest first and
 *     that is the last-used company — an API-level contract shared with `list_companies`, never
 *     re-sorted here. An explicit pick wins, and a pick that is no longer attachable (the list
 *     refreshed, the company was abandoned) falls back rather than pointing at a row that is not
 *     on screen.
 *
 * ⚠ `undefined` companies means the LIST HAS NOT RESOLVED, and it is a third mode rather than an
 * empty list. It was `companies.data?.companies ?? []`, so a returning user with four companies
 * got the CREATE form first — a full intake form, an industry type-ahead and, on production, a
 * request for their Social Security Number — and then watched it be replaced by a picker the
 * moment the list arrived. Everything typed in the meantime is still in state but no longer on
 * screen, and the free path was hidden behind a fee at exactly the moment the choice was made.
 * "No companies yet" and "we have not asked yet" are different facts, and only the first is a
 * reason to show a create form.
 *
 * A mode the caller CHOSE still wins, loading or not: a click is an answer, and a list arriving
 * afterwards must not overrule it.
 */
export function legalBodyBranch(
  /** `undefined` = the list has not resolved. An empty array is a resolved answer. */
  companies: readonly CompanyView[] | undefined,
  chosenMode: "attach" | "create" | null,
  pickedCompanyId: string | null,
): { mode: "attach" | "create" | "loading"; attachable: CompanyView[]; selected: string | null } {
  const attachable = (companies ?? []).filter(canAttach);
  const picked = attachable.some((c) => c.companyId === pickedCompanyId) ? pickedCompanyId : null;
  const mode =
    chosenMode ?? (companies === undefined ? "loading" : attachable.length > 0 ? "attach" : "create");
  return { mode, attachable, selected: picked ?? attachable[0]?.companyId ?? null };
}
