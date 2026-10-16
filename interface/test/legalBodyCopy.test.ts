/**
 * Every sentence the legal-body flow shows, against the claims ceiling.
 *
 * The flow keeps its words in one file, so one walk covers them all: every string of the copy
 * object, every check-reason sentence, and every notice sentence for every kind of notice on both
 * environments. None claims more than the facts behind it, none carries an em dash, "verified"
 * is said only of the person, and "Novi" stands alone only in the one approved sentence.
 */
import { describe, expect, test } from "vitest";
import {
  APPROVED_NOVI_SENTENCES,
  CHECK_REASON_SENTENCES,
  LEGAL_BODY_COPY,
  PERSON_SENTENCES,
  fillCopy,
} from "@/lib/legalBody/copy";
import { closedSentence, noticeSentence } from "@/lib/legalBody/notice";
import { LEGAL_BODY_PHASES } from "@/lib/legalBody/phases";
import type { LegalBodyNotice } from "@/lib/legalBody/flow";
import { CHECK_REASON_CODES, LAPSE_REASONS } from "@/lib/api/types";

const YES =
  "a registered legal body stands behind this agent, and Novi states its standing as active";
const BANNER =
  "Arc testnet. The company is a test declaration, its check is automatic, and the wording is a draft; nothing here is a filing.";
const MONEY = "There is no payment step on this testnet deployment.";
const NEVER_APPROVE = "Never approve or transfer anything to Novi Corpus.";

/** Every string reachable from a value, depth first. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsOf);
  return [];
}

/** One notice of every kind, with each variant its sentence depends on. */
const NOTICES: LegalBodyNotice[] = [
  { kind: "expired" },
  ...LAPSE_REASONS.map((reason) => ({ kind: "lapsed" as const, reason })),
  { kind: "lapsed", reason: null },
  { kind: "superseded", by: null },
  { kind: "superseded", by: "lbo_newer" },
  { kind: "replaced", by: null },
  { kind: "replaced", by: "lbo_newer" },
  { kind: "abandoned" },
  { kind: "order_revoked" },
  { kind: "other_deployment" },
  ...CHECK_REASON_CODES.map((reasonCode) => ({ kind: "company_failed" as const, reasonCode })),
  { kind: "company_failed", reasonCode: null },
  { kind: "company_revoked" },
  { kind: "company_awaiting_check" },
  { kind: "company_abandoned" },
  { kind: "creating" },
  { kind: "winding_down" },
  { kind: "dissolved" },
  { kind: "broken_reason_unknown" },
  { kind: "identity_taken", agentId: "897126" },
];

const ENVIRONMENTS = ["sandbox", "production"] as const;

const noticeStrings = ENVIRONMENTS.flatMap((environment) => [
  ...NOTICES.flatMap((n) => {
    const s = noticeSentence(n, environment);
    return [s.title, s.body];
  }),
  ...(() => {
    const s = closedSentence(undefined, environment);
    return [s.title, s.body];
  })(),
]);

const ALL = [
  ...stringsOf(LEGAL_BODY_COPY),
  ...stringsOf(CHECK_REASON_SENTENCES),
  ...LEGAL_BODY_PHASES.map((p) => p.label),
  ...noticeStrings,
];

describe("the claims ceiling", () => {
  test("the walk reaches a real number of sentences", () => {
    // A guard that walks nothing passes vacuously.
    expect(ALL.length).toBeGreaterThan(100);
    for (const s of ALL) expect(s.trim().length).toBeGreaterThan(0);
  });

  test.each([
    "verified company",
    "kyc",
    "licensed",
    "good standing",
    "human-backed",
    "guarantee",
    "included during the beta",
    "non-custodial",
    "autonomous legal person",
    "winds down",
    "wound down",
  ])("no sentence says %j", (forbidden) => {
    for (const s of ALL) expect(s.toLowerCase()).not.toContain(forbidden);
  });

  test("no sentence says free: the money sentence says there is no payment step", () => {
    for (const s of ALL) expect(s).not.toMatch(/\bfree\b/i);
  });

  test("no sentence carries an em dash", () => {
    for (const s of ALL) expect(s).not.toContain("\u2014");
  });

  test("'verified' is said only of the person", () => {
    const saying = ALL.filter((s) => /verified/i.test(s));
    for (const s of saying) expect(PERSON_SENTENCES).toContain(s);
    // The list is not empty by accident: the accepted human gate says it of the person.
    expect(PERSON_SENTENCES.length).toBeGreaterThan(0);
    for (const s of PERSON_SENTENCES) expect(ALL).toContain(s);
  });

  test("'Novi' stands alone only in the approved sentence; elsewhere it is Novi Corpus", () => {
    const alone = ALL.filter((s) => /\bNovi\b(?! Corpus)/.test(s));
    expect(alone.length).toBeGreaterThan(0);
    for (const s of alone) expect(APPROVED_NOVI_SENTENCES).toContain(s);
    expect(APPROVED_NOVI_SENTENCES).toEqual([YES]);
  });
});

describe("the sentences carried verbatim", () => {
  test.each([
    ["the yes sentence", YES],
    ["the sandbox banner", BANNER],
    ["the money sentence", MONEY],
    ["the never-approve sentence", NEVER_APPROVE],
    ["the deployment gate", "This deployment does not offer legal bodies on your own identity."],
    ["the declarations-off sentence", "This deployment does not take new declarations."],
    [
      "the product sentence of the human gate",
      "A legal body for your agent needs a real person on record; a waiver is not accepted for this product.",
    ],
    [
      "the smart-account sentence",
      "This wallet is a smart account. The declaration needs a plain wallet signature, so a smart account cannot be the guardian here.",
    ],
    ["the entry button", "Get a legal body for an agent you already run"],
    [
      "the rail's footer",
      "Two signatures and one or two transactions from your wallet. Never an approval or a transfer.",
    ],
  ])("%s", (_name, sentence) => {
    expect(ALL).toContain(sentence);
  });

  test("registering says it moves no funds, never that it transfers nothing: it mints a token and spends gas", () => {
    expect(LEGAL_BODY_COPY.identity.registerBody).toContain("It approves nothing and moves no funds.");
    expect(LEGAL_BODY_COPY.identity.registerBody).not.toContain("transfers nothing");
  });

  test("the page and the rail are headed the same way", () => {
    expect(LEGAL_BODY_COPY.page.title).toBe("A legal body for your agent");
    expect(LEGAL_BODY_COPY.rail.heading).toBe("A legal body for your agent");
  });

  test("every reason a check can fail has its sentence", () => {
    expect(Object.keys(CHECK_REASON_SENTENCES).sort()).toEqual([...CHECK_REASON_CODES].sort());
  });
});

describe("fillCopy", () => {
  test("fills every named value", () => {
    expect(fillCopy("Identity {agentId} of {who}", { agentId: "42", who: "you" })).toBe(
      "Identity 42 of you",
    );
  });

  test("a value it is not given stays named, never silently empty", () => {
    expect(fillCopy("Identity {agentId}", {})).toBe("Identity {agentId}");
  });

  test("no template is left half-filled in a notice", () => {
    for (const s of noticeStrings) expect(s).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});
