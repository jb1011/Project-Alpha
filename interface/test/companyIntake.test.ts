/**
 * The create-company form's own rules (design §5) — and, more importantly, the boundary between
 * them and the server's.
 *
 * The backend is the authority. What this module holds is the subset checkable without a round
 * trip, so a founder fixing three name fields does it in the form rather than one 400 at a time.
 * Every rule below therefore has a twin in `back/backend/src/formation/{intake,company}.ts`, and
 * the risk this file exists for is DRIFT — a form that promises a name Wyoming will not take, or
 * refuses one it would.
 *
 * The one rule that is deliberately absent is Wyoming's restricted-word list: ~80 words of data
 * the backend holds, whose client copy would be a second list. A test asserting its absence is
 * what stops somebody adding it back "for the nicer error message".
 */
import { expect, test } from "vitest";
import {
  NAME_MAX_LENGTH,
  PURPOSE_MAX_LENGTH,
  canAttach,
  companyLabel,
  duplicateKey,
  emptyCompanyIntake,
  isCompanyIntakeValid,
  industryIndex,
  intakeFormOf,
  legalBodyBranch,
  stripEntityEnding,
  validateCompanyIntake,
} from "@/lib/formation/companyIntake";
import type { CompanyState, CompanyView } from "@/lib/api/types";

/** The picker's options and the door's accepted set are one list — held as a SET since A3,
 *  because the validator runs on every keystroke of every field. */
const KNOWN = new Set(["Software development", "Consulting"]);
const VALID = {
  names: ["Acme Robotics", "Acme Automata", "Acme Mechanicals"],
  businessPurpose: "Operating autonomous software agents.",
  industryLabel: "Software development",
};

test("the happy path passes, and an empty form does not", () => {
  expect(isCompanyIntakeValid(VALID, KNOWN)).toBe(true);
  expect(isCompanyIntakeValid(emptyCompanyIntake(), KNOWN)).toBe(false);
});

test("all THREE candidates are required, and each error lands under its own field", () => {
  // Wyoming refuses a name that is already taken, and a retry is a second fee — the alternates
  // are the whole reason the form asks for three.
  const errors = validateCompanyIntake({ ...VALID, names: ["Acme Robotics", "", "  "] }, KNOWN);
  expect(errors.names[0]).toBeNull();
  expect(errors.names[1]).toMatch(/Enter name option 2/);
  expect(errors.names[2]).toMatch(/Enter name option 3/);
});

test("the charset NAMES the character it refused", () => {
  // The asymmetry: a name we refuse that Wyoming would have taken is an annoyance, and the
  // message is what makes it a fixable one. A name Wyoming refuses costs a fee.
  const errors = validateCompanyIntake({ ...VALID, names: ["Café Robotics", "B", "C"] }, KNOWN);
  expect(errors.names[0]).toContain('"é"');
});

test("a name that is ONLY an entity ending is refused — it would be filed as \"LLC LLC\"", () => {
  for (const only of ["LLC", "l.l.c.", "  LLC  "])
    expect(validateCompanyIntake({ ...VALID, names: [only, "B", "C"] }, KNOWN).names[0], only).toMatch(
      /entity ending/,
    );
  // …and the helper it rests on, which is the backend's `stripEntityEnding` behaviour: a bare
  // ending strips to EMPTY rather than handing the ending back as the name.
  expect(stripEntityEnding("LLC")).toBe("");
  expect(stripEntityEnding("Acme Robotics LLC")).toBe("Acme Robotics");
});

test("DUPLICATES are caught in the form Wyoming would compare them in", () => {
  // "Acme Robotics", "Acme Robotics LLC" and "Acme  Robotics" are ONE candidate to the state, and
  // three candidates that are really one leave the filing with no fallback at all.
  const errors = validateCompanyIntake(
    { ...VALID, names: ["Acme Robotics", "Acme Robotics LLC", "Acme  Robotics"] },
    KNOWN,
  );
  expect(errors.names[0]).toBeNull();
  expect(errors.names[1]).toMatch(/repeats an earlier option/);
  expect(errors.names[2]).toMatch(/repeats an earlier option/);
  expect(duplicateKey("Acme  Robotics LLC")).toBe(duplicateKey("acme robotics"));
});

test("the length bounds are the backend's, and they are checked after the blank check", () => {
  expect(
    validateCompanyIntake({ ...VALID, names: ["A".repeat(NAME_MAX_LENGTH + 1), "B", "C"] }, KNOWN)
      .names[0],
  ).toContain(String(NAME_MAX_LENGTH));
  expect(
    validateCompanyIntake({ ...VALID, businessPurpose: "x".repeat(PURPOSE_MAX_LENGTH + 1) }, KNOWN)
      .businessPurpose,
  ).toContain(String(PURPOSE_MAX_LENGTH));
});

test("the industry is checked against the SERVED list, and nothing is claimed before it arrives", () => {
  // The picker's options and the door's accepted set are ONE array, fetched from
  // `GET /formation/industries`. An unlisted label reaches doola and comes back rejected on a
  // real fee, so the form refuses it — but only once it knows what the list is.
  expect(validateCompanyIntake({ ...VALID, industryLabel: "Interpretive Dance" }, KNOWN).industryLabel)
    .toMatch(/listed industries/);
  expect(validateCompanyIntake({ ...VALID, industryLabel: "" }, KNOWN).industryLabel).toMatch(
    /Choose an industry/,
  );
  // Empty list = the fetch has not landed. Refusing here would refuse every label on a slow box.
  expect(
    validateCompanyIntake({ ...VALID, industryLabel: "Anything" }, new Set()).industryLabel,
  ).toBeNull();
});

test("Wyoming's RESTRICTED WORDS are deliberately not checked here", () => {
  // ~80 words of data the backend holds, matched on letter boundaries so "Banksy" is not refused
  // for containing "bank". A copy in this bundle would be a second list, and the day the two
  // disagree the form either refuses a filable name or promises one Wyoming will not take — after
  // the fee. The server's refusal names the offending word, and the form renders it.
  expect(validateCompanyIntake({ ...VALID, names: ["Acme Bank", "B Works", "C Works"] }, KNOWN)
    .names[0]).toBeNull();
});

/* ── the picker's filter ─────────────────────────────────────────────────── */

const company = (over: Partial<CompanyView> = {}): CompanyView =>
  ({
    companyId: "c1",
    status: "ready",
    environment: "sandbox",
    synthetic: false,
    nameOptions: [{ name: "Acme Robotics", entityTypeEnding: "LLC", position: 1 }],
    legalNameFiled: null,
    businessPurpose: "p",
    industryLabel: "Software development",
    formationStatus: "none",
    paying: false,
    state: "ready",
    filedAt: null,
    filingNumber: null,
    agents: 0,
    createdAt: "2026-09-07 12:00:00",
    ...over,
  }) as CompanyView;

test("canAttach mirrors the backend's predicate, and an UNKNOWN state is not attachable", () => {
  for (const state of ["ready", "in_progress", "filed", "complete"] as CompanyState[])
    expect(canAttach(company({ state })), state).toBe(true);
  // A draft still owes its payment, an abandoned one is over, and a failed filing will not happen.
  for (const state of ["draft", "paying", "failed", "abandoned"] as CompanyState[])
    expect(canAttach(company({ state })), state).toBe(false);
  // A value from a newer backend: offering a company whose condition this build cannot read is a
  // guess, and the guess costs an onboard.
  expect(canAttach({ state: "quantum_superposition" as CompanyState })).toBe(false);
});

test("the picker's label prefers the FILED name, and never invents one", () => {
  expect(companyLabel(company())).toBe("Acme Robotics LLC");
  expect(companyLabel(company({ legalNameFiled: "Acme Robotics" }))).toBe("Acme Robotics");
  // A company whose candidates are unreadable gets a placeholder rather than an empty string —
  // and it is not called a filed name anywhere, which is why the two are separate fields.
  expect(companyLabel(company({ nameOptions: [] }))).toBe("Unnamed company");
});

/* ── the wizard's branch ─────────────────────────────────────────────────── */

test("BRANCH: attach is the default when there is anything to attach to, create when there is not", () => {
  expect(legalBodyBranch([], null, null).mode).toBe("create");
  expect(legalBodyBranch([company()], null, null).mode).toBe("attach");
  // A company nobody can attach to is not something to attach to.
  expect(legalBodyBranch([company({ state: "draft" })], null, null).mode).toBe("create");
});

test("BRANCH: an explicit choice WINS, even when the list arrives afterwards", () => {
  // The screen must not flip out from under somebody who clicked "create" and started typing —
  // which is exactly what happens if the default is recomputed as the query resolves.
  expect(legalBodyBranch([company()], "create", null).mode).toBe("create");
  expect(legalBodyBranch([], "attach", null).mode).toBe("attach");
});

test("BRANCH: the default selection is the FIRST attachable row — the server's ordering", () => {
  // `GET /companies` is newest-first, which is an API-level contract shared with the picker's
  // "last used" default. Re-sorting here is how a picker disagrees with the list behind it.
  const rows = [company({ companyId: "newest" }), company({ companyId: "older" })];
  expect(legalBodyBranch(rows, null, null).selected).toBe("newest");
  expect(legalBodyBranch(rows, null, "older").selected).toBe("older");
});

test("BRANCH: unattachable rows are filtered OUT, and never selected by default", () => {
  const rows = [
    company({ companyId: "draft", state: "draft" }),
    company({ companyId: "abandoned", state: "abandoned" }),
    company({ companyId: "usable", state: "filed" }),
  ];
  const branch = legalBodyBranch(rows, null, null);
  expect(branch.attachable.map((c) => c.companyId)).toEqual(["usable"]);
  expect(branch.selected).toBe("usable");
});

test("BRANCH: a pick that is no longer attachable FALLS BACK rather than pointing at nothing", () => {
  // The list refreshed and the company was abandoned in between. Keeping the id would leave the
  // confirm button pointing at a row that is not on screen — and the onboard would be refused.
  const rows = [company({ companyId: "usable" })];
  expect(legalBodyBranch(rows, null, "gone").selected).toBe("usable");
  expect(legalBodyBranch([], null, "gone").selected).toBeNull();
});

test("BRANCH: an UNRESOLVED list is `loading` — never the create form", () => {
  // The bug: the step passed `companies.data?.companies ?? []`, so a returning user with four
  // companies got the CREATE form first — a full intake, an industry type-ahead and, on
  // production, a request for their Social Security Number — and watched it be replaced by a
  // picker the moment the list arrived. "No companies yet" and "we have not asked yet" are
  // different facts, and only the first is a reason to show a create form.
  expect(legalBodyBranch(undefined, null, null).mode).toBe("loading");
  // An EMPTY list is a resolved answer, and it does mean create.
  expect(legalBodyBranch([], null, null).mode).toBe("create");
});

test("BRANCH: a mode the caller CHOSE sticks, loading or not — a click is an answer", () => {
  expect(legalBodyBranch(undefined, "create", null).mode).toBe("create");
  expect(legalBodyBranch(undefined, "attach", null).mode).toBe("attach");
});

test("BRANCH: an unresolved list offers nothing to attach to and selects nothing", () => {
  const branch = legalBodyBranch(undefined, null, "some-company");
  expect(branch.attachable).toEqual([]);
  expect(branch.selected).toBeNull();
});

/* ── the industry index (§5/§7) ────────────────────────────────────────────── */

test("INDEX: one pass over the list gives the filter, the lookup and the validator's set", () => {
  // Three consumers used to walk all 821 labels per keystroke — the filter, the exact-match hint
  // and `onChange` — each lowercasing every one of them, for a list that changes on a deploy.
  const index = industryIndex(["Software development", "Consulting", "Coffee shops"]);
  expect(index.options).toHaveLength(3);
  expect(index.lowered.map((l) => l.lower)).toEqual([
    "software development",
    "consulting",
    "coffee shops",
  ]);
  expect(index.known.has("Consulting")).toBe(true);
  expect(index.known.has("consulting")).toBe(false);
});

test("INDEX: the lookup is case-insensitive and returns the CANONICAL casing", () => {
  // What is committed must be the label as SHIPPED: the create door accepts exactly those, so a
  // lower-cased near-miss would reach doola and come back rejected on a real fee.
  const index = industryIndex(["Software development"]);
  expect(index.byLower.get("software development")).toBe("Software development");
  expect(index.byLower.get("SOFTWARE DEVELOPMENT".toLowerCase())).toBe("Software development");
  expect(index.byLower.get("software")).toBeUndefined();
});

test("INDEX: an unarrived list is an EMPTY index, not a null one", () => {
  const index = industryIndex(undefined);
  expect(index.options).toEqual([]);
  expect(index.known.size).toBe(0);
  // …and nothing is claimed about a label until it arrives.
  expect(
    validateCompanyIntake({ ...VALID, industryLabel: "Anything" }, index.known).industryLabel,
  ).toBeNull();
});

test("INTAKE FORM: a stored row becomes exactly three whole-string candidates", () => {
  // The row keeps candidates SPLIT (`{name, entityTypeEnding, position}`), which is the shape the
  // filer sends and the §5 matcher compares against; a form binds to whole strings. Three screens
  // rejoined them inline, and one of those three re-sends the intake UNCHANGED — so a difference
  // between the copies would be a silent rewrite of a filing's names.
  const form = intakeFormOf({
    nameOptions: [
      { name: "Acme Robotics", entityTypeEnding: "LLC", position: 1 },
      { name: "Acme Automata", entityTypeEnding: "LLC", position: 2 },
      { name: "Acme Mechanicals", entityTypeEnding: "LLC", position: 3 },
    ],
    businessPurpose: "Operating autonomous software agents.",
    industryLabel: "Software development",
  });
  expect(form.names).toEqual(["Acme Robotics LLC", "Acme Automata LLC", "Acme Mechanicals LLC"]);
  expect(form.businessPurpose).toBe("Operating autonomous software agents.");
  expect(form.industryLabel).toBe("Software development");
  // …and it round-trips: what the form shows is a body the door accepts.
  expect(isCompanyIntakeValid(form, new Set(["Software development"]))).toBe(true);
});

test("INTAKE FORM: a row with fewer than three options fills the gaps, never shortens", () => {
  // The door requires exactly three, so a short array would render two inputs and submit a body
  // refused for its shape rather than its content.
  const form = intakeFormOf({
    nameOptions: [{ name: "Only One", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "p",
    industryLabel: "Software development",
  });
  expect(form.names).toEqual(["Only One LLC", "", ""]);
});
