import type { CompanyView } from "@/lib/api/types";

/**
 * THE CREATE-COMPANY FORM'S OWN RULES (design §5) — a courtesy, and honest about being one.
 *
 * The backend's `createCompany` is the authority: it canonicalizes, validates, and refuses in
 * sentences this form renders verbatim. What lives here is the subset that can be checked without
 * a round trip, so a founder fixing three name fields does it in the form rather than one 400 at
 * a time.
 *
 * ⚠ **Wyoming's restricted-word list is deliberately NOT here.** It is ~80 words of data that the
 * backend holds (`src/formation/wyRestrictedWords.ts`), matched on letter boundaries so "Banksy"
 * is not refused for containing "bank". A copy in the bundle would be a second list, and the day
 * the two disagree the form either refuses a filable name or promises a name Wyoming will not
 * take — after the fee. The server's refusal NAMES the offending word, and the form shows it.
 *
 * The other rules are structural and cannot drift in the same way: three candidates, non-blank,
 * a length, a charset, an ending that is not the whole name, and no duplicates.
 */

/** Mirrors `NAME_OPTION_COUNT`. Wyoming refuses a taken name, and a retry is a second fee. */
export const NAME_OPTION_COUNT = 3;
/** Mirrors `NAME_MAX_LENGTH`. */
export const NAME_MAX_LENGTH = 120;
/** Mirrors `PURPOSE_MAX_LENGTH`. */
export const PURPOSE_MAX_LENGTH = 500;

/**
 * Mirrors the backend's `NAME_CHARSET`: ASCII letters, digits, space and `& ' - , . ( ) +`.
 *
 * Narrow on purpose, and the asymmetry is the reason: a name we refuse that Wyoming would have
 * taken is an annoyance with a message naming the character, while one Wyoming refuses costs a
 * fee and parks the company. Accented letters are out — the Secretary of State's published
 * standard is English letters and Arabic numerals.
 */
const NAME_CHARSET = /^[A-Za-z0-9 &'\-,.()+]$/;

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
 * Validate the three company fields, in the ORDER a caller typed them.
 *
 * `industryLabel` is checked against the list the backend served, not against a bundled copy —
 * the picker's options and the door's accepted set are one array, fetched from
 * `GET /formation/industries`. An empty `known` list means the list has not arrived yet, and
 * nothing is claimed about the label until it does.
 */
export function validateCompanyIntake(
  form: CompanyIntakeForm,
  known: readonly string[] = [],
): CompanyIntakeErrors {
  const names: (string | null)[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < NAME_OPTION_COUNT; i++) {
    const position = i + 1;
    const name = canonicalizeIntakeText(form.names[i] ?? "");
    if (!name) {
      names.push(`Enter name option ${position}. Wyoming refuses a name that is already taken, and the alternates are what let the filing proceed without a second fee.`);
      continue;
    }
    if (name.length > NAME_MAX_LENGTH) {
      names.push(`Keep this under ${NAME_MAX_LENGTH} characters — that is the limit Wyoming files a company name under.`);
      continue;
    }
    const illegal = [...name].find((ch) => !NAME_CHARSET.test(ch));
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
      : purpose.length > PURPOSE_MAX_LENGTH
        ? `Keep this under ${PURPOSE_MAX_LENGTH} characters.`
        : null,
    industryLabel: !industry
      ? "Choose an industry."
      : known.length > 0 && !known.includes(industry)
        ? "Choose one of the listed industries — the filing agent only accepts those."
        : null,
  };
}

export function isCompanyIntakeValid(
  form: CompanyIntakeForm,
  known: readonly string[] = [],
): boolean {
  const e = validateCompanyIntake(form, known);
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
