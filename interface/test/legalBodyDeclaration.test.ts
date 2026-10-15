/**
 * The company step's decisions: the field rules of the declaration doors, mirrored so that a field
 * the door would refuse stops under the field before any door is spent; the request each
 * environment sends; what the screen does after a door's refusal, the gate's refusal and the
 * wallet's; the offer to continue with a company of the tenant's own that already declared the
 * number; and which sub-screen each state of the check shows.
 *
 * Company names and numbers are inventions, and on a sandbox they say "test".
 */
import { describe, expect, test } from "vitest";
import {
  ApiError,
  CHECK_REASON_CODES,
  type CompanyView,
  type StatementMessageAnswer,
} from "@/lib/api/types";
import { CHECK_REASON_SENTENCES, LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import {
  abandonRefusalSentence,
  ALREADY_DECLARED,
  CHECK_REASON_SENTENCES as REEXPORTED_REASONS,
  companyScreen,
  declarationInput,
  declinedSentence,
  gateRefusalOutcome,
  isAlreadyDeclared,
  ownCompanyWithNumber,
  statementOnScreen,
  statementSubmitOutcome,
  stopSentence,
  validateDeclaration,
  type DeclarationForm,
  type StatementSubmitOutcome,
} from "@/lib/legalBody/declaration";

const C = LEGAL_BODY_COPY.company;
const P = C.problems;
const N = LEGAL_BODY_COPY.notices;
const length = (min: number, max: number) =>
  fillCopy(P.length, { min: String(min), max: String(max) });

const SANDBOX: DeclarationForm = {
  companyName: "Example Test Holdings LLC",
  filingNumber: "TEST-0001",
  declarantName: "",
  declarantTitle: "",
};
const PRODUCTION: DeclarationForm = {
  companyName: "Example Invented Holdings LLC",
  filingNumber: "EXAMPLE-0001",
  declarantName: "Example Declarant",
  declarantTitle: "Manager",
};

const sandbox = (over: Partial<DeclarationForm>) =>
  validateDeclaration({ ...SANDBOX, ...over }, "sandbox");
const production = (over: Partial<DeclarationForm>) =>
  validateDeclaration({ ...PRODUCTION, ...over }, "production");

// ---------------------------------------------------------------------------------------------
// The field rules
// ---------------------------------------------------------------------------------------------

describe("validateDeclaration: the doors' field rules, mirrored", () => {
  test("a sandbox test declaration and a production declaration pass as typed", () => {
    expect(validateDeclaration(SANDBOX, "sandbox")).toEqual({});
    expect(validateDeclaration(PRODUCTION, "production")).toEqual({});
  });

  const sandboxNames: [string, string, string | undefined][] = [
    ["a name that does not say test", "Example Invented Holdings LLC", P.nameTest],
    ["test inside another word", "Contest LLC", P.nameTest],
    ["test as the start of another word", "Testing Holdings LLC", P.nameTest],
    ["test in capitals", "EXAMPLE TEST HOLDINGS LLC", undefined],
    ["test after a hyphen", "Example-Test LLC", undefined],
    ["the word test alone", "Test", undefined],
    ["one character", "T", length(2, 200)],
    ["nothing typed", "", P.required],
    ["spaces only", "   ", P.required],
    ["200 characters", `Test ${"A".repeat(195)}`, undefined],
    ["201 characters", `Test ${"A".repeat(196)}`, length(2, 200)],
    ["201 typed with a doubled space, 200 once collapsed", `Test  ${"A".repeat(195)}`, undefined],
    ["doubled spaces and spaces at the ends", "  Example  Test   Holdings LLC ", undefined],
    ["an accented letter", "Café Test LLC", C.nameCharset],
    ["an accented letter typed as two code points", "Café Test LLC", C.nameCharset],
    ["a character outside the charset", "Test@Holdings LLC", C.nameCharset],
    ["every character of the charset", "Test & Co's (Holdings) - A, B. + 9", undefined],
    ["a double quote", 'Example "Test" LLC', P.doubleQuote],
    ["a tab", "Example\tTest LLC", P.control],
    ["a line break", "Example\nTest LLC", P.control],
    ["a zero-width space", "Example​Test LLC", P.control],
    ["a non-breaking space", "Example Test LLC", P.otherSpace],
    ["an ideographic space", "Example　Test LLC", P.otherSpace],
  ];
  test.each(sandboxNames)("sandbox name: %s", (_name, companyName, problem) => {
    expect(sandbox({ companyName }).companyName).toBe(problem);
  });

  const sandboxNumbers: [string, string, string | undefined][] = [
    ["a test number", "TEST-0001", undefined],
    ["a test number with a space at the end", "TEST-0001 ", undefined],
    ["three digits after TEST-", "TEST-001", P.numberTest],
    ["a test number in lower case", "test-0001", P.numberTest],
    ["lower case after TEST-", "TEST-abcd", P.numberTest],
    ["a number without TEST-", "EXAMPLE-0001", P.numberTest],
    ["a space inside", "TEST 0001", P.numberCharset],
    ["three characters", "TES", length(4, 32)],
    ["32 characters", `TEST-${"A".repeat(27)}`, undefined],
    ["33 characters", `TEST-${"A".repeat(28)}`, length(4, 32)],
    ["nothing typed", "", P.required],
  ];
  test.each(sandboxNumbers)("sandbox number: %s", (_name, filingNumber, problem) => {
    expect(sandbox({ filingNumber }).filingNumber).toBe(problem);
  });

  test("a production name need not say test", () => {
    expect(production({ companyName: "Example Invented Holdings LLC" })).toEqual({});
    expect(production({ companyName: "AB" })).toEqual({});
    expect(production({ companyName: "A" }).companyName).toBe(length(2, 200));
    expect(production({ companyName: "Café Invented Holdings LLC" }).companyName).toBe(C.nameCharset);
  });

  const productionNumbers: [string, string, string | undefined][] = [
    ["four digits", "1234", undefined],
    ["three digits", "123", length(4, 32)],
    ["32 characters", "A".repeat(32), undefined],
    ["33 characters", "A".repeat(33), length(4, 32)],
    ["a space inside", "12 34", P.numberCharset],
    ["an underscore", "EXAMPLE_0001", P.numberCharset],
    ["a test number, which production also takes", "TEST-0001", undefined],
  ];
  test.each(productionNumbers)("production number: %s", (_name, filingNumber, problem) => {
    expect(production({ filingNumber }).filingNumber).toBe(problem);
  });

  const declarants: [string, Partial<DeclarationForm>, keyof DeclarationForm, string | undefined][] = [
    ["a name with letters, an apostrophe, a hyphen and a full stop", { declarantName: "Ann-Marie O'Example Jr." }, "declarantName", undefined],
    ["a name with an accented letter", { declarantName: "Zoë Example" }, "declarantName", undefined],
    ["a name with a digit", { declarantName: "Example 2" }, "declarantName", P.declarantNameCharset],
    ["a name of one letter", { declarantName: "É" }, "declarantName", length(2, 120)],
    ["120 letters typed as two code points each", { declarantName: "é".repeat(120) }, "declarantName", undefined],
    ["121 letters typed as two code points each", { declarantName: "é".repeat(121) }, "declarantName", length(2, 120)],
    ["a name with a tab", { declarantName: "Example\tDeclarant" }, "declarantName", P.control],
    ["a title with digits, a slash, an ampersand and a comma", { declarantTitle: "Manager/Member 1, R&D" }, "declarantTitle", undefined],
    ["a title with a hash", { declarantTitle: "Manager #1" }, "declarantTitle", P.declarantTitleCharset],
    ["a title of 80 characters", { declarantTitle: "M".repeat(80) }, "declarantTitle", undefined],
    ["a title of 81 characters", { declarantTitle: "M".repeat(81) }, "declarantTitle", length(2, 80)],
    ["a title with a double quote", { declarantTitle: 'The "Manager"' }, "declarantTitle", P.doubleQuote],
  ];
  test.each(declarants)("production declarant: %s", (_name, over, field, problem) => {
    expect(production(over)[field]).toBe(problem);
  });

  test("the declarant is required on production only", () => {
    expect(production({ declarantName: "", declarantTitle: "" })).toEqual({
      declarantName: P.required,
      declarantTitle: P.required,
    });
    // A sandbox names its own declarant, so whatever sits in these fields is not read.
    expect(sandbox({ declarantName: "", declarantTitle: "" })).toEqual({});
    expect(sandbox({ declarantName: "Example\t2", declarantTitle: 'A "B"' })).toEqual({});
  });

  test("every bad field is named at once", () => {
    const bad: DeclarationForm = {
      companyName: "Café",
      filingNumber: "x",
      declarantName: "",
      declarantTitle: "M#",
    };
    expect(validateDeclaration(bad, "production")).toEqual({
      companyName: C.nameCharset,
      filingNumber: length(4, 32),
      declarantName: P.required,
      declarantTitle: P.declarantTitleCharset,
    });
    expect(Object.keys(validateDeclaration(bad, "sandbox")).sort()).toEqual([
      "companyName",
      "filingNumber",
    ]);
  });

  test("the sentences are the backend's own problems", () => {
    expect(C.nameCharset).toBe(
      "may hold only the characters a Wyoming entity name takes: A-Z, a-z, 0-9, spaces and & ' - , . ( ) +",
    );
    expect(P.nameTest).toBe("must say it is a test on this deployment");
    expect(P.numberTest).toBe(
      "must be a test number on this deployment: TEST- then 4 to 27 of A-Z, 0-9 and hyphens",
    );
    expect(P.numberCharset).toBe("may hold only A-Z, a-z, 0-9 and hyphens");
    expect(P.control).toBe("holds a control or invisible character");
    expect(P.otherSpace).toBe("holds a space other than a plain space");
    expect(P.doubleQuote).toBe("holds a double quote");
    expect(P.required).toBe("is required");
    expect(length(2, 200)).toBe("must be 2 to 200 characters long");
  });
});

// ---------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------

describe("declarationInput", () => {
  test("a sandbox sends the name and the number, normalised, and synthetic: true; never a declarant", () => {
    const input = declarationInput(
      {
        companyName: "  Example  Test Holdings LLC ",
        filingNumber: "TEST-0001 ",
        declarantName: "Example Declarant",
        declarantTitle: "Manager",
      },
      "sandbox",
    );
    expect(input).toEqual({
      companyName: "Example Test Holdings LLC",
      filingNumber: "TEST-0001",
      synthetic: true,
    });
    expect(Object.keys(input).sort()).toEqual(["companyName", "filingNumber", "synthetic"]);
  });

  test("production sends the four fields, normalised, and no synthetic key", () => {
    const input = declarationInput(
      { ...PRODUCTION, declarantName: " Example  Declarant ", companyName: "Example  Invented Holdings LLC" },
      "production",
    );
    expect(input).toEqual({
      declarantName: "Example Declarant",
      declarantTitle: "Manager",
      companyName: "Example Invented Holdings LLC",
      filingNumber: "EXAMPLE-0001",
    });
    expect(Object.keys(input).sort()).toEqual([
      "companyName",
      "declarantName",
      "declarantTitle",
      "filingNumber",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// After a door's refusal
// ---------------------------------------------------------------------------------------------

const FIELDS_MESSAGE = "some fields of the declaration are not valid";

describe("statementSubmitOutcome", () => {
  test("statement_stale asks for a new statement", () => {
    const e = new ApiError(400, {
      code: "statement_stale",
      message:
        "the statement was issued too long ago, or too far ahead of the server's clock: ask for a new one and sign it",
    });
    expect(statementSubmitOutcome(e)).toEqual({ kind: "refetch" });
  });

  test("a validation_error with two fields puts each problem under its field, as served", () => {
    const e = new ApiError(400, {
      code: "validation_error",
      message: FIELDS_MESSAGE,
      details: [
        { field: "companyName", problem: "must say it is a test on this deployment" },
        {
          field: "filingNumber",
          problem: "is already declared on this deployment: choose another test number",
        },
      ] as unknown as ApiError["details"],
    });
    expect(statementSubmitOutcome(e)).toEqual({
      kind: "fields",
      problems: {
        companyName: "must say it is a test on this deployment",
        filingNumber: "is already declared on this deployment: choose another test number",
      },
    });
  });

  test("a validation_error naming no field of the form is its sentence", () => {
    const signature = new ApiError(400, {
      code: "validation_error",
      message: FIELDS_MESSAGE,
      details: [{ field: "signature", problem: "is required" }] as unknown as ApiError["details"],
    });
    expect(statementSubmitOutcome(signature)).toEqual({ kind: "sentence", sentence: FIELDS_MESSAGE });
    const noDetails = new ApiError(400, { code: "validation_error", message: "invalid JSON body" });
    expect(statementSubmitOutcome(noDetails)).toEqual({ kind: "sentence", sentence: "invalid JSON body" });
    const inherited = new ApiError(400, {
      code: "validation_error",
      message: FIELDS_MESSAGE,
      details: [{ field: "constructor", problem: "x" }, { field: "toString", problem: 1 }] as unknown as ApiError["details"],
    });
    expect(statementSubmitOutcome(inherited)).toEqual({ kind: "sentence", sentence: FIELDS_MESSAGE });
  });

  test("a field named twice keeps its first problem", () => {
    const e = new ApiError(400, {
      code: "validation_error",
      message: FIELDS_MESSAGE,
      details: [
        { field: "filingNumber", problem: "first" },
        { field: "filingNumber", problem: "second" },
      ] as unknown as ApiError["details"],
    });
    expect(statementSubmitOutcome(e)).toEqual({ kind: "fields", problems: { filingNumber: "first" } });
  });

  const sentences: [string, ApiError][] = [
    [
      "customer_company_cap",
      new ApiError(409, {
        code: "customer_company_cap",
        message: "this tenant already has 3 declared companies open (max 3)",
      }),
    ],
    [
      "guardian_company_cap",
      new ApiError(403, {
        code: "guardian_company_cap",
        message: "this human already controls 5 companies (max 5)",
      }),
    ],
    [
      "legal_text_not_approved",
      new ApiError(503, {
        code: "legal_text_not_approved",
        message: "the statement of authority wording is a draft and cannot be served here",
      }),
    ],
    ["a 503 unavailable", new ApiError(503, { code: "unavailable", message: "the service is unavailable" })],
    [
      "statement_not_valid",
      new ApiError(400, {
        code: "statement_not_valid",
        message: "the signature is not the guardian's over this statement",
      }),
    ],
    ["a timeout", new ApiError(0, { code: "timeout", message: "The server did not answer in time." })],
  ];
  test.each(sentences)("%s is its sentence, as served", (_name, e) => {
    expect(statementSubmitOutcome(e)).toEqual({ kind: "sentence", sentence: e.message });
  });

  test("anything that is not an ApiError is a stop: no answer came back", () => {
    expect(statementSubmitOutcome(new TypeError("Failed to fetch"))).toEqual({
      kind: "stop",
      problem: "no_answer",
    });
    expect(statementSubmitOutcome("boom")).toEqual({ kind: "stop", problem: "no_answer" });
    expect(statementSubmitOutcome(undefined)).toEqual({ kind: "stop", problem: "no_answer" });
  });
});

describe("gateRefusalOutcome", () => {
  test("a statement just served that the gate refuses is a stop with the problem word", () => {
    expect(gateRefusalOutcome("company_name", false)).toEqual({ kind: "stop", problem: "company_name" });
    expect(gateRefusalOutcome("issued_at_window", false)).toEqual({
      kind: "stop",
      problem: "issued_at_window",
    });
  });

  test("a statement already on screen, past its window at the click, is asked for again", () => {
    expect(gateRefusalOutcome("issued_at_window", true)).toEqual({ kind: "refetch" });
    // Any other rule broken is a stop even then: the statement on screen passed it once.
    expect(gateRefusalOutcome("guardian", true)).toEqual({ kind: "stop", problem: "guardian" });
  });
});

describe("the sentences of a stop and of a wallet that did not sign", () => {
  test("a refusal of the gate names its problem; no answer says so", () => {
    expect(stopSentence("company_name")).toBe(fillCopy(C.refused, { problem: "company_name" }));
    expect(stopSentence("company_name")).toContain("(company_name)");
    expect(stopSentence("no_answer")).toBe(C.noAnswer);
  });

  test("a wallet on another network is told which network the statement is for", () => {
    const sandboxConfig = { chainId: 5042002, environment: "sandbox" as const };
    expect(declinedSentence(5042002, sandboxConfig)).toBe(C.declined);
    expect(declinedSentence(undefined, sandboxConfig)).toBe(C.declined);
    expect(declinedSentence(1, sandboxConfig)).toBe(
      fillCopy(C.declinedOtherNetwork, { network: LEGAL_BODY_COPY.pointer.networkSandbox }),
    );
    expect(declinedSentence(1, { chainId: 5042, environment: "production" })).toBe(
      fillCopy(C.declinedOtherNetwork, { network: LEGAL_BODY_COPY.pointer.networkProduction }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The number already declared by one of the tenant's own companies
// ---------------------------------------------------------------------------------------------

const company = (over: Partial<CompanyView> = {}): CompanyView => ({
  companyId: "co_own",
  environment: "sandbox",
  nameOptions: [{ name: "Example Test Holdings LLC", entityTypeEnding: "", position: 1 }],
  legalNameFiled: null,
  businessPurpose: "not applicable: an existing company",
  industryLabel: "not applicable: an existing company",
  state: "ready",
  filedAt: null,
  filingNumber: null,
  agents: 0,
  createdAt: 1_791_000_000_000,
  provider: "customer",
  declared: {
    companyName: "Example Test Holdings LLC",
    filingNumber: "TEST-0001",
    wordingVersion: "2026-10-draft-1",
  },
  verification: { state: "verified", checkedAt: 1_791_000_000, reasonCode: null },
  ...over,
});

const alreadyDeclared: StatementSubmitOutcome = {
  kind: "fields",
  problems: {
    filingNumber: "is already declared on this deployment: choose another test number",
  },
};

describe("a number one of the tenant's own companies already declared", () => {
  test("the door's sentence starts with the words matched", () => {
    expect(ALREADY_DECLARED).toBe("is already declared on this deployment");
    expect(isAlreadyDeclared(alreadyDeclared)).toBe(true);
    expect(isAlreadyDeclared({ kind: "fields", problems: { filingNumber: P.numberTest } })).toBe(false);
    expect(
      isAlreadyDeclared({
        kind: "fields",
        problems: { companyName: "is already declared on this deployment: choose another test number" },
      }),
    ).toBe(false);
    expect(isAlreadyDeclared({ kind: "refetch" })).toBe(false);
    expect(isAlreadyDeclared({ kind: "sentence", sentence: ALREADY_DECLARED })).toBe(false);
  });

  test("the tenant's own company that declared the number is offered", () => {
    expect(ownCompanyWithNumber(alreadyDeclared, "TEST-0001", [company()])).toBe("co_own");
  });

  test("the numbers are compared after the backend's normalisation", () => {
    expect(ownCompanyWithNumber(alreadyDeclared, " TEST-0001  ", [company()])).toBe("co_own");
    const typedWithSpaces = company({
      declared: { companyName: "Example Test LLC", filingNumber: "TEST-0001 ", wordingVersion: "w" },
    });
    expect(ownCompanyWithNumber(alreadyDeclared, "TEST-0001", [typedWithSpaces])).toBe("co_own");
  });

  test("the first matching company of the list, which the API serves newest first", () => {
    const companies = [
      company({ companyId: "co_other", declared: { companyName: "Other Test LLC", filingNumber: "TEST-0002", wordingVersion: "w" } }),
      company({ companyId: "co_newer" }),
      company({ companyId: "co_older" }),
    ];
    expect(ownCompanyWithNumber(alreadyDeclared, "TEST-0001", companies)).toBe("co_newer");
  });

  const none: [string, StatementSubmitOutcome, string, CompanyView[]][] = [
    ["no company of the tenant has the number", alreadyDeclared, "TEST-0002", [company()]],
    ["the tenant has no company", alreadyDeclared, "TEST-0001", []],
    ["the company with the number is abandoned", alreadyDeclared, "TEST-0001", [company({ state: "abandoned" })]],
    ["a formation company", alreadyDeclared, "TEST-0001", [company({ provider: undefined })]],
    ["a company whose declaration could not be read", alreadyDeclared, "TEST-0001", [company({ declared: null })]],
    ["a company with no declaration key", alreadyDeclared, "TEST-0001", [company({ declared: undefined })]],
    [
      "another refusal of the number",
      { kind: "fields", problems: { filingNumber: P.numberTest } },
      "TEST-0001",
      [company()],
    ],
    ["not a refusal of the fields", { kind: "sentence", sentence: "x" }, "TEST-0001", [company()]],
  ];
  test.each(none)("nothing is offered: %s", (_name, outcome, typed, companies) => {
    expect(ownCompanyWithNumber(outcome, typed, companies)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Which sub-screen
// ---------------------------------------------------------------------------------------------

test("the check-reason sentences are the copy's own map", () => {
  expect(REEXPORTED_REASONS).toBe(CHECK_REASON_SENTENCES);
});

describe("companyScreen", () => {
  test("the form, with the derivation's notice when there is one", () => {
    expect(companyScreen({ step: "form", environment: "sandbox", verificationState: null })).toEqual({
      kind: "form",
      notice: null,
    });
    expect(
      companyScreen({
        step: "form",
        notice: { kind: "company_abandoned" },
        environment: "sandbox",
        verificationState: null,
      }),
    ).toEqual({
      kind: "form",
      notice: { title: N.company_abandoned.title, body: N.company_abandoned.body, wayOut: "new_company" },
    });
  });

  test("loading", () => {
    expect(companyScreen({ step: "loading", environment: "production", verificationState: null })).toEqual({
      kind: "loading",
    });
  });

  test("waiting: an operator, by a person, and no number of days", () => {
    const production = companyScreen({ step: "waiting", environment: "production", verificationState: "awaiting_check" });
    expect(production).toEqual({
      kind: "status",
      title: N.company_awaiting_check.title,
      lines: [C.waiting],
      stateWord: null,
      newDeclaration: false,
      abandon: false,
    });
    expect(C.waiting).toBe(
      "A Novi Corpus operator checks the declaration against the registry and your document. This is done by a person; it is not instant.",
    );
    expect(C.waiting).not.toMatch(/[0-9]/);
    // Nobody uploads on a sandbox: its waiting sentence says so instead.
    const onSandbox = companyScreen({ step: "waiting", environment: "sandbox", verificationState: "awaiting_check" });
    expect(onSandbox).toMatchObject({ kind: "status", lines: [N.company_awaiting_check.sandbox] });
  });

  test("evidence on production: the upload is not on this screen yet", () => {
    expect(companyScreen({ step: "evidence", environment: "production", verificationState: "awaiting_check" })).toEqual({
      kind: "status",
      title: C.evidenceTitle,
      lines: [C.evidenceUnavailable],
      stateWord: null,
      newDeclaration: false,
      abandon: false,
    });
  });

  test.each(CHECK_REASON_CODES)("failed with %s: the reason's sentence and the way back", (reasonCode) => {
    const notice = { kind: "company_failed" as const, reasonCode };
    expect(companyScreen({ step: "failed", notice, environment: "sandbox", verificationState: "failed" })).toEqual({
      kind: "status",
      title: N.company_failed.title,
      lines: [`${CHECK_REASON_SENTENCES[reasonCode]} ${N.company_failed.wayBackSandbox}`],
      stateWord: null,
      newDeclaration: true,
      abandon: true,
    });
    expect(companyScreen({ step: "failed", notice, environment: "production", verificationState: "failed" })).toEqual({
      kind: "status",
      title: N.company_failed.title,
      lines: [`${CHECK_REASON_SENTENCES[reasonCode]} ${N.company_failed.wayBackProduction}`, C.evidenceUnavailable],
      stateWord: null,
      newDeclaration: true,
      abandon: true,
    });
  });

  test("failed with no reason recorded, or no notice, still says so", () => {
    const expected = `${N.company_failed.noReason} ${N.company_failed.wayBackSandbox}`;
    const withNull = companyScreen({
      step: "failed",
      notice: { kind: "company_failed", reasonCode: null },
      environment: "sandbox",
      verificationState: "failed",
    });
    expect(withNull).toMatchObject({ lines: [expected] });
    const without = companyScreen({ step: "failed", environment: "sandbox", verificationState: "failed" });
    expect(without).toMatchObject({ lines: [expected] });
  });

  test("revoked with no word served: no word is invented", () => {
    expect(companyScreen({ step: "revoked", environment: "sandbox", verificationState: null })).toMatchObject({
      stateWord: null,
      newDeclaration: true,
    });
  });

  test("revoked: the API's word, and a new declaration", () => {
    expect(companyScreen({ step: "revoked", environment: "sandbox", verificationState: "revoked" })).toEqual({
      kind: "status",
      title: N.company_revoked.title,
      lines: [N.company_revoked.body],
      stateWord: "revoked",
      newDeclaration: true,
      abandon: true,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The statement on screen, and the abandon door's refusal
// ---------------------------------------------------------------------------------------------

describe("statementOnScreen", () => {
  const answer = (textStatus: string): StatementMessageAnswer =>
    ({
      typedData: { message: { statement: "I declare.", wordingVersion: "2026-10-draft-1" } },
      wordingVersion: "2026-10-draft-1",
      textStatus,
    }) as unknown as StatementMessageAnswer;

  test("the sentence, its wording version, and the draft badge on a draft wording", () => {
    expect(statementOnScreen(answer("draft"))).toEqual({
      sentence: "I declare.",
      wordingVersion: fillCopy(C.wordingVersion, { version: "2026-10-draft-1" }),
      draft: true,
    });
  });

  test("no badge on an approved wording only: a status this build does not know reads as a draft", () => {
    expect(statementOnScreen(answer("approved")).draft).toBe(false);
    expect(statementOnScreen(answer("pending_counsel")).draft).toBe(true);
  });
});

describe("abandonRefusalSentence", () => {
  test("the door's refusal as served", () => {
    const e = new ApiError(409, { code: "conflict", message: "a checked company cannot be abandoned" });
    expect(abandonRefusalSentence(e)).toBe("a checked company cannot be abandoned");
  });

  test("no answer says so, about the abandon", () => {
    expect(abandonRefusalSentence(new TypeError("Failed to fetch"))).toBe(C.abandonNoAnswer);
  });
});
