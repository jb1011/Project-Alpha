/**
 * On a sandbox deployment the operator's check of the LLC is automatic and examines nothing, so
 * the public page a third party reads must say so wherever a sandbox statement could pass for a
 * checked company: in the standing table's `active` row, in the `attestationState` and
 * `controlVerified` rows, and in a note naming every field that rests on that check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { LEGAL_BODY_STATEMENT_TYPE_STRING } from "../../src/legalBody/publicStatement";

/** The page, found from this file: back/backend/test/docs, up to the repository's docs/identity. */
const PAGE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "identity",
  "legal-body-statement.md",
);

const page = (): string => readFileSync(PAGE, "utf8");

/** The words of the sandbox note. */
const AUTOMATIC = "the operator's check is automatic and checks nothing";

/** The fields the note names: those a sandbox's automatic check fills. */
const RESTING_ON_THE_CHECK = [
  "controlVerified",
  "existenceCheckedAt",
  "filedAt",
  "filingStatus",
  "lastFiledPeriod",
  "lastFiledAt",
  "nextDue",
];

/** The names of the statement's fields, in the order the type string gives them. */
const STATEMENT_FIELDS = LEGAL_BODY_STATEMENT_TYPE_STRING.slice(
  LEGAL_BODY_STATEMENT_TYPE_STRING.indexOf("(") + 1,
  -1,
)
  .split(",")
  .map((field) => field.split(" ")[1]);

/** The one table row of the page whose first cell is `name`, written as code. */
function rowOf(text: string, name: string): string {
  const rows = text.split("\n").filter((line) => line.startsWith(`| \`${name}\` |`));
  expect(rows, name).toHaveLength(1);
  return rows[0] as string;
}

/** The one paragraph of the page that holds `words`. */
function paragraphWith(text: string, words: string): string {
  const paragraphs = text.split(/\n[ \t]*\n/).filter((paragraph) => paragraph.includes(words));
  expect(paragraphs, words).toHaveLength(1);
  return paragraphs[0] as string;
}

test("the page says that on a sandbox the operator's check is automatic and checks nothing", () => {
  expect(page()).toContain(AUTOMATIC);
});

test("the standing table's active row, and the attestationState and controlVerified rows, each speak of the sandbox", () => {
  const text = page();
  for (const name of ["active", "attestationState", "controlVerified"])
    expect(rowOf(text, name), name).toContain("sandbox");
});

test("the sandbox note names the seven fields that rest on the check, each a field of the statement", () => {
  const note = paragraphWith(page(), AUTOMATIC);
  for (const field of RESTING_ON_THE_CHECK) {
    expect(note, field).toContain(`\`${field}\``);
    expect(STATEMENT_FIELDS, field).toContain(field);
  }
});
