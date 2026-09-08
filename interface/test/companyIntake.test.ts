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
  stripEntityEnding,
  validateCompanyIntake,
} from "@/lib/formation/companyIntake";
import type { CompanyState, CompanyView } from "@/lib/api/types";

const KNOWN = ["Software development", "Consulting"];
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
  expect(validateCompanyIntake({ ...VALID, industryLabel: "Anything" }, []).industryLabel).toBeNull();
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
