/**
 * The agreement step's decisions, each pure: the live draft offered instead of a second order, the
 * frozen agreement checked against its hash, the facts beside it (the draft's expiry, the
 * amendment delay) in words, the terms as paragraphs, what a refusal of the order door means, and
 * the in-memory flag that moves an order whose agreement was read on to the identity step.
 *
 * The manifests here are built with viem's own `keccak256` over UTF-8 bytes, never with the code
 * under test. Every view is built from one fixed `NOW`: nothing here reads a clock.
 */
import { keccak256, stringToBytes, type Hex } from "viem";
import { describe, expect, test } from "vitest";
import {
  ApiError,
  type Address,
  type CompanyView,
  type LegalBodyAgreement,
  type LegalBodyConfig,
  type LegalBodyOrderView,
} from "@/lib/api/types";
import {
  agreementFacts,
  agreementOnScreen,
  agreementReadAfterJump,
  agreementReadSentence,
  continueDraftLabel,
  delayLine,
  draftOffer,
  durationWords,
  expiryLine,
  hoursWords,
  liveDraftFor,
  orderRefusalOutcome,
  placedOrder,
  sentenceOnArrival,
  termsParagraphs,
  utcMinute,
  verifyAgreement,
  withAgreementRead,
} from "@/lib/legalBody/agreement";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { deriveLegalBodyPhase, type LegalBodyDerivation } from "@/lib/legalBody/flow";

const A = LEGAL_BODY_COPY.agreement;

/** Anvil's first published test account, as served (checksummed). */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
/** The public testnet factory and identity registry. */
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
/** An invention. */
const ANOTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
const CHAIN = 5042002;
const HERE = { chainId: CHAIN, factory: FACTORY };

/** The one clock of this file. */
const NOW = Date.parse("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** As the API serves `createdAt`: ISO 8601 in UTC, whole seconds, marked with a `Z`. */
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const order = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_draft",
  publicId: "lb_public",
  companyId: "co_test",
  state: "draft",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"ab".repeat(32)}`, version: 1 },
  agentId: null,
  identityOwner: null,
  bodyAddress: null,
  linkDeadline: null,
  createTxHash: null,
  deployedAt: null,
  pointerSeenAt: null,
  createdAt: iso(NOW - 2 * HOUR),
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

/* ── The agreement, built here with viem ─────────────────────────────────────────────────────── */

const utf8Hash = (s: string): Hex => keccak256(stringToBytes(s));

const TERMS = [
  '# Operating Agreement of "Example Test Holdings LLC"',
  "",
  "Status: draft. This wording is not yet approved for use with a real company.",
  "",
  "## 1. The Company",
  "",
  "A company with a name in two scripts: Société Exemple, 例.",
  "",
].join("\n");

/** A manifest of the served shape: canonical-looking JSON with one trailing newline. */
function manifestOf(termsHash: string, over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    amendmentDelay: 172_800,
    schema: "novi.legal-body-manifest/1",
    terms: {
      hash: termsHash,
      textId: "legal-body-operating-agreement",
      textStatus: "draft",
      textVersion: "2026-10-draft-1",
    },
    version: 1,
    ...over,
  })}\n`;
}

function agreement(over: Partial<LegalBodyAgreement> = {}): LegalBodyAgreement {
  const termsDoc = over.termsDoc ?? TERMS;
  const manifest = over.manifest ?? manifestOf(utf8Hash(termsDoc));
  return {
    termsDoc,
    manifest,
    manifestHash: over.manifestHash ?? utf8Hash(manifest),
    textId: "legal-body-operating-agreement",
    textVersion: "2026-10-draft-1",
    textStatus: "draft",
    ...over,
  };
}

/** An agreement whose manifest is `manifest` and whose hash is that manifest's own, so only the
 *  later checks can refuse it. */
const withManifest = (manifest: string, termsDoc = TERMS) =>
  agreement({ termsDoc, manifest, manifestHash: utf8Hash(manifest) });

// ---------------------------------------------------------------------------------------------
// The live draft
// ---------------------------------------------------------------------------------------------

describe("liveDraftFor: a draft under 24 hours for this company, newest first", () => {
  test("a draft placed two hours ago is offered", () => {
    const draft = order();
    expect(liveDraftFor([draft], "co_test", NOW)).toBe(draft);
  });

  test("a draft one millisecond short of 24 hours is still offered", () => {
    const draft = order({ createdAt: new Date(NOW - DAY + 1).toISOString() });
    expect(liveDraftFor([draft], "co_test", NOW)).toBe(draft);
  });

  test.each([
    ["exactly 24 hours old", { createdAt: iso(NOW - DAY) }],
    ["25 hours old", { createdAt: iso(NOW - 25 * HOUR) }],
    ["with a createdAt that cannot be read", { createdAt: "yesterday" }],
    ["revoked", { revoked: true }],
    ["of another company", { companyId: "co_other" }],
    ["reserved", { state: "reserved" as const }],
    ["deployed", { state: "deployed" as const }],
    ["linked", { state: "linked" as const }],
    ["lapsed", { state: "lapsed" as const }],
  ])("an order %s is not offered", (_name, over) => {
    expect(liveDraftFor([order(over)], "co_test", NOW)).toBeNull();
  });

  test("of several live drafts, the newest", () => {
    const older = order({ id: "lbo_older", createdAt: iso(NOW - 5 * HOUR) });
    const newest = order({ id: "lbo_newest", createdAt: iso(NOW - HOUR) });
    const middle = order({ id: "lbo_middle", createdAt: iso(NOW - 3 * HOUR) });
    expect(liveDraftFor([older, newest, middle], "co_test", NOW)).toBe(newest);
  });

  test("no order, no offer", () => {
    expect(liveDraftFor([], "co_test", NOW)).toBeNull();
  });
});

describe("draftOffer: the live draft of this deployment, with its label", () => {
  test("offers the draft with the label of its age", () => {
    const draft = order({ createdAt: iso(NOW - 5 * HOUR) });
    expect(draftOffer({ orders: [draft], companyId: "co_test", where: HERE, nowMs: NOW })).toEqual({
      order: draft,
      label: "Continue with the order placed 5 hours ago",
    });
  });

  test("a draft placed under another factory or chain is not offered: it cannot move here", () => {
    const elsewhere = [
      order({ factory: ANOTHER_FACTORY }),
      order({ chainId: 5042 }),
    ];
    expect(draftOffer({ orders: elsewhere, companyId: "co_test", where: HERE, nowMs: NOW })).toBeNull();
  });

  test("a factory served in another letter case is the same factory", () => {
    const draft = order({ factory: FACTORY.toLowerCase() as Address });
    expect(draftOffer({ orders: [draft], companyId: "co_test", where: HERE, nowMs: NOW })?.order).toBe(
      draft,
    );
  });

  test("the newest live draft here wins over a newer one elsewhere", () => {
    const here = order({ id: "lbo_here", createdAt: iso(NOW - 4 * HOUR) });
    const elsewhere = order({ id: "lbo_elsewhere", factory: ANOTHER_FACTORY, createdAt: iso(NOW - HOUR) });
    expect(
      draftOffer({ orders: [elsewhere, here], companyId: "co_test", where: HERE, nowMs: NOW })?.order,
    ).toBe(here);
  });
});

describe("continueDraftLabel: the age in whole hours, said the way a person says it", () => {
  test.each([
    [0, "Continue with the order placed less than an hour ago"],
    [59 * 60_000, "Continue with the order placed less than an hour ago"],
    [HOUR, "Continue with the order placed 1 hour ago"],
    [2 * HOUR - 1, "Continue with the order placed 1 hour ago"],
    [2 * HOUR, "Continue with the order placed 2 hours ago"],
    [23 * HOUR, "Continue with the order placed 23 hours ago"],
  ])("placed %d ms ago", (ageMs, label) => {
    expect(continueDraftLabel(order({ createdAt: new Date(NOW - ageMs).toISOString() }), NOW)).toBe(label);
  });

  test("from two hours on it is the copy's own sentence, filled", () => {
    expect(continueDraftLabel(order({ createdAt: iso(NOW - 7 * HOUR) }), NOW)).toBe(
      fillCopy(A.continueDraft, { hours: "7" }),
    );
  });

  test("a draft whose clock runs ahead of this browser's was placed less than an hour ago", () => {
    expect(continueDraftLabel(order({ createdAt: iso(NOW + 5 * 60_000) }), NOW)).toBe(
      A.continueDraftRecent,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The frozen agreement against its hash
// ---------------------------------------------------------------------------------------------

describe("verifyAgreement: the manifest hashes to manifestHash, and the terms to terms.hash", () => {
  test("an agreement built with viem passes", () => {
    expect(verifyAgreement(agreement())).toEqual({ ok: true });
  });

  test("the hashes are over UTF-8 bytes: terms outside ASCII pass when hashed that way", () => {
    expect(TERMS).toMatch(/[^\x00-\x7f]/);
    expect(verifyAgreement(agreement())).toEqual({ ok: true });
  });

  test("a hash's letter case is not information", () => {
    const a = agreement();
    const upper = `0x${a.manifestHash.slice(2).toUpperCase()}` as Hex;
    expect(verifyAgreement({ ...a, manifestHash: upper })).toEqual({ ok: true });
    const termsUpper = `0x${utf8Hash(TERMS).slice(2).toUpperCase()}`;
    expect(verifyAgreement(withManifest(manifestOf(termsUpper)))).toEqual({ ok: true });
  });

  describe("manifest_hash", () => {
    test("a manifest changed by one byte (its trailing newline dropped)", () => {
      const a = agreement();
      expect(verifyAgreement({ ...a, manifest: a.manifest.trimEnd() })).toEqual({
        ok: false,
        problem: "manifest_hash",
      });
    });

    test("the hash of another manifest", () => {
      const other = manifestOf(utf8Hash(TERMS), { amendmentDelay: 259_200 });
      expect(verifyAgreement({ ...agreement(), manifestHash: utf8Hash(other) })).toEqual({
        ok: false,
        problem: "manifest_hash",
      });
    });

    test.each([
      ["too short", "0x1234"],
      ["without 0x", utf8Hash("x").slice(2)],
      ["not hex", `0x${"zz".repeat(32)}`],
      ["empty", ""],
    ])("a manifestHash that is not 32 bytes of hex (%s)", (_name, manifestHash) => {
      expect(verifyAgreement({ ...agreement(), manifestHash: manifestHash as Hex })).toEqual({
        ok: false,
        problem: "manifest_hash",
      });
    });

    test("an answer whose manifest is not a string is refused, never a throw", () => {
      const a = { ...agreement(), manifest: null } as unknown as LegalBodyAgreement;
      expect(verifyAgreement(a)).toEqual({ ok: false, problem: "manifest_hash" });
    });
  });

  describe("manifest_json", () => {
    test.each([
      ["not JSON", "this is not json\n"],
      ["a JSON string", '"terms"\n'],
      ["a JSON array", "[1, 2]\n"],
      ["JSON null", "null\n"],
      ["an object without terms", manifestOf(utf8Hash(TERMS), { terms: undefined })],
      ["terms that are not an object", manifestOf(utf8Hash(TERMS), { terms: "a hash" })],
      ["terms without a hash", manifestOf(utf8Hash(TERMS), { terms: { textId: "x" } })],
      ["a terms hash that is a number", manifestOf(utf8Hash(TERMS), { terms: { hash: 42 } })],
      ["a terms hash that is not 32 bytes", manifestOf("0x1234")],
      ["terms only under __proto__", `{"__proto__":{"terms":{"hash":"${utf8Hash(TERMS)}"}}}\n`],
    ])("a manifest that hashes right but is %s", (_name, manifest) => {
      expect(verifyAgreement(withManifest(manifest))).toEqual({ ok: false, problem: "manifest_json" });
    });
  });

  describe("terms_hash", () => {
    test("terms changed by one character", () => {
      const a = agreement();
      expect(verifyAgreement({ ...a, termsDoc: a.termsDoc.replace("draft.", "draft!") })).toEqual({
        ok: false,
        problem: "terms_hash",
      });
    });

    test("the bytes as served, never a normalised reading: the same text decomposed is refused", () => {
      const a = agreement();
      const decomposed = a.termsDoc.normalize("NFD");
      expect(decomposed).not.toBe(a.termsDoc);
      expect(verifyAgreement({ ...a, termsDoc: decomposed })).toEqual({
        ok: false,
        problem: "terms_hash",
      });
    });

    test("terms the manifest does not commit to", () => {
      expect(verifyAgreement(withManifest(manifestOf(utf8Hash("other terms"))))).toEqual({
        ok: false,
        problem: "terms_hash",
      });
    });

    test("terms that are not a string are refused, never a throw", () => {
      const a = { ...agreement(), termsDoc: 7 } as unknown as LegalBodyAgreement;
      expect(verifyAgreement(a)).toEqual({ ok: false, problem: "terms_hash" });
    });
  });
});

describe("agreementOnScreen: the wording's version, and the draft badge", () => {
  test("a draft wording carries the badge", () => {
    expect(agreementOnScreen(agreement())).toEqual({ wordingVersion: "wording 2026-10-draft-1", draft: true });
  });

  test("an approved wording goes without it", () => {
    expect(agreementOnScreen(agreement({ textStatus: "approved" })).draft).toBe(false);
  });

  test("a status this build does not know reads as a draft", () => {
    const a = { ...agreement(), textStatus: "pending" } as unknown as LegalBodyAgreement;
    expect(agreementOnScreen(a).draft).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The facts beside the agreement
// ---------------------------------------------------------------------------------------------

describe("agreementFacts: the expiry and the amendment delay", () => {
  test.each([
    [172_800, "48 hours"],
    [259_200, "72 hours"],
  ])("an amendment delay of %d s is %j", (amendmentDelay, words) => {
    expect(agreementFacts(order({ amendmentDelay }), NOW).delayWords).toBe(words);
  });

  test("a draft expires 24 hours after it was placed", () => {
    const createdAt = iso(NOW - 2 * HOUR);
    expect(agreementFacts(order({ createdAt }), NOW).expiresAtMs).toBe(Date.parse(createdAt) + DAY);
  });

  test.each([
    ["just placed", NOW, 24],
    ["placed 23 hours ago: one whole hour left", NOW - 23 * HOUR, 1],
    ["one millisecond less than an hour left", NOW - 23 * HOUR - 1, 0],
    ["at the expiry", NOW - DAY, 0],
    ["past the expiry", NOW - 25 * HOUR, 0],
    ["placed by a clock two hours ahead of this browser's", NOW + 2 * HOUR, 24],
  ])("hours left: %s", (_name, createdMs, hoursLeft) => {
    expect(agreementFacts(order({ createdAt: new Date(createdMs).toISOString() }), NOW).hoursLeft).toBe(
      hoursLeft,
    );
  });

  test("a createdAt that cannot be read leaves no hour and no expiry time", () => {
    const facts = agreementFacts(order({ createdAt: "yesterday" }), NOW);
    expect(facts.hoursLeft).toBe(0);
    expect(Number.isNaN(facts.expiresAtMs)).toBe(true);
    expect(expiryLine(facts)).toBeNull();
  });
});

describe("durationWords and hoursWords", () => {
  test.each([
    [3_600, "1 hour"],
    [7_200, "2 hours"],
    [172_800, "48 hours"],
    [2_592_000, "720 hours"],
    [5_400, "90 minutes"],
    [60, "1 minute"],
    [61, "61 seconds"],
    [1, "1 second"],
    [0, "0 seconds"],
  ])("%d seconds is %j", (seconds, words) => {
    expect(durationWords(seconds)).toBe(words);
  });

  test.each([
    [0, "less than an hour"],
    [1, "1 hour"],
    [23, "23 hours"],
  ])("%d whole hours is %j", (hours, words) => {
    expect(hoursWords(hours)).toBe(words);
  });
});

describe("the two lines beside the agreement", () => {
  test("the expiry: the time in UTC and the hours left", () => {
    const facts = agreementFacts(order({ createdAt: iso(NOW - 2 * HOUR) }), NOW);
    expect(expiryLine(facts)).toBe(
      fillCopy(A.expiry, { time: "2026-10-13 10:00 UTC", left: "22 hours" }),
    );
  });

  test("the expiry with less than an hour left", () => {
    const facts = agreementFacts(order({ createdAt: iso(NOW - DAY + 30 * 60_000) }), NOW);
    expect(expiryLine(facts)).toBe(
      fillCopy(A.expiry, { time: "2026-10-12 12:30 UTC", left: "less than an hour" }),
    );
  });

  test("the amendment delay in words", () => {
    expect(delayLine(agreementFacts(order(), NOW))).toBe(fillCopy(A.delay, { delay: "48 hours" }));
    expect(delayLine(agreementFacts(order(), NOW))).toContain("48 hours");
  });

  test("utcMinute writes a moment to the minute, in UTC, and nothing for a moment it cannot read", () => {
    expect(utcMinute(Date.parse("2026-10-13T09:05:59Z"))).toBe("2026-10-13 09:05 UTC");
    expect(utcMinute(Number.NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The terms as paragraphs
// ---------------------------------------------------------------------------------------------

describe("termsParagraphs: split on blank lines, as text", () => {
  test("one paragraph per block between blank lines", () => {
    expect(termsParagraphs("# Title\n\nFirst.\n\nSecond.")).toEqual(["# Title", "First.", "Second."]);
  });

  test("a single line break stays inside its paragraph", () => {
    expect(termsParagraphs("Holds when:\n\n- (a) one;\n- (b) two.")).toEqual([
      "Holds when:",
      "- (a) one;\n- (b) two.",
    ]);
  });

  test("runs of blank lines, blank lines holding spaces, CRLF, and blank edges leave no empty paragraph", () => {
    expect(termsParagraphs("\n\nOne.\r\n\r\n\r\nTwo.\n  \t\nThree.\n\n")).toEqual(["One.", "Two.", "Three."]);
  });

  test("markup is text: nothing is parsed, nothing is dropped", () => {
    expect(termsParagraphs("<b>bold</b>\n\n<script>alert(1)</script>")).toEqual([
      "<b>bold</b>",
      "<script>alert(1)</script>",
    ]);
  });

  test("no text, no paragraph", () => {
    expect(termsParagraphs("")).toEqual([]);
    expect(termsParagraphs("\n\n  \n")).toEqual([]);
  });

  test("the served shape: headings and sentences, in order", () => {
    expect(termsParagraphs(TERMS)).toEqual([
      '# Operating Agreement of "Example Test Holdings LLC"',
      "Status: draft. This wording is not yet approved for use with a real company.",
      "## 1. The Company",
      "A company with a name in two scripts: Société Exemple, 例.",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The order door's answer
// ---------------------------------------------------------------------------------------------

describe("placedOrder: the door's answer, read as the draft it should be", () => {
  test("a draft of this company", () => {
    const placed = order();
    expect(placedOrder(placed, "co_test")).toBe(placed);
  });

  test.each([
    ["an order of another company", order({ companyId: "co_other" })],
    ["an order past the draft", order({ state: "reserved" })],
    ["an order without an id", { ...order(), id: "" }],
    ["an id that is not a string", { ...order(), id: 7 }],
    ["null", null],
    ["an array", [order()]],
    ["a string", "lbo_draft"],
  ])("%s is not read as a placed order", (_name, answer) => {
    expect(placedOrder(answer, "co_test")).toBeNull();
  });
});

describe("orderRefusalOutcome: what the screen does after the order door refused", () => {
  const refusal = (status: number, code: string, message: string) =>
    new ApiError(status, { code, message });

  test("company_not_eligible goes back to the company step, with the sentence as served", () => {
    const e = refusal(409, "company_not_eligible", "This company cannot stand behind a legal body.");
    expect(orderRefusalOutcome(e)).toEqual({
      kind: "company",
      sentence: "This company cannot stand behind a legal body.",
    });
  });

  test.each([
    [409, "legal_body_cap", "You already hold as many open legal-body orders as you may at once."],
    [429, "legal_body_orders", "You have placed as many legal-body orders in the last 24 hours as you may."],
    [503, "legal_text_not_approved", "This deployment does not take legal-body orders yet."],
    [404, "not_found", "Nothing with this id belongs to you."],
    [429, "rate_limited", "Too many requests: wait a few seconds and try again."],
    [0, "timeout", "The server did not answer in time."],
  ])("a %d %s is its sentence, as served", (status, code, message) => {
    expect(orderRefusalOutcome(refusal(status, code, message))).toEqual({ kind: "sentence", sentence: message });
  });

  test("anything that is not the API's answer: whether the order was placed is not known", () => {
    expect(orderRefusalOutcome(new TypeError("Failed to fetch"))).toEqual({ kind: "no_answer" });
    expect(orderRefusalOutcome("lost")).toEqual({ kind: "no_answer" });
  });
});

describe("agreementReadSentence: a read of the agreement that failed", () => {
  test("the API's sentence as served", () => {
    const e = new ApiError(503, {
      code: "agreement_unreadable",
      message: "This order's stored agreement no longer reads back as the agreement it was frozen with.",
    });
    expect(agreementReadSentence(e)).toBe(e.message);
  });

  test("no answer: the step's own sentence", () => {
    expect(agreementReadSentence(new TypeError("Failed to fetch"))).toBe(A.unreadable);
  });

  test("a refusal that means sign in: its message is never shown", () => {
    const e = new ApiError(401, { code: "unauthorized", message: "sign-in required" });
    expect(agreementReadSentence(e)).toBe(A.unreadable);
  });
});

// ---------------------------------------------------------------------------------------------
// The hand-offs to the shell
// ---------------------------------------------------------------------------------------------

describe("withAgreementRead: an agreement read on this visit moves its order on to the identity step", () => {
  const AGREEMENT: LegalBodyDerivation = { phase: "agreement" };
  const draft = order();

  test("the order whose agreement was read: the identity step", () => {
    expect(withAgreementRead(AGREEMENT, { order: draft, readFor: draft.id })).toEqual({ phase: "identity" });
  });

  test.each([
    ["nothing was read", null],
    ["another order's agreement was read", "lbo_another"],
  ])("still the agreement when %s", (_name, readFor) => {
    expect(withAgreementRead(AGREEMENT, { order: draft, readFor })).toBe(AGREEMENT);
  });

  test("no order yet (the company's own thread): still the agreement", () => {
    expect(withAgreementRead(AGREEMENT, { order: null, readFor: "lbo_draft" })).toBe(AGREEMENT);
  });

  test("an order past the draft is never moved by the flag", () => {
    const reserved = order({ state: "reserved" });
    expect(withAgreementRead(AGREEMENT, { order: reserved, readFor: reserved.id })).toBe(AGREEMENT);
  });

  test.each<LegalBodyDerivation>([
    { phase: "company", companyStep: "failed", notice: { kind: "company_failed", reasonCode: null } },
    { phase: "identity", notice: { kind: "identity_taken", agentId: "42" } },
    { phase: "link", branch: "browser" },
    { phase: "closed", notice: { kind: "expired" } },
  ])("any other phase is the derivation's: %j", (derivation) => {
    expect(withAgreementRead(derivation, { order: draft, readFor: draft.id })).toBe(derivation);
  });

  test("with the derivation: the flag counts only until an owner choice decides by itself", () => {
    type AvailableConfig = Extract<LegalBodyConfig, { available: true }>;
    const config: AvailableConfig = {
      available: true,
      declarations: true,
      statements: true,
      environment: "sandbox",
      chainId: CHAIN,
      identityRegistry: REGISTRY,
      factory: FACTORY,
      gasSeedOffered: false,
      paymentRequired: false,
      linkTtl: { min: 600, max: 85_800, default: 3_600 },
    };
    const company = {
      companyId: "co_test",
      environment: "sandbox",
      state: "ready",
      provider: "customer",
      verification: { state: "verified", checkedAt: 1_791_000_000, reasonCode: null },
    } as unknown as CompanyView;
    const derive = (ownerChoice: "this-wallet" | null, agentId: string | null) =>
      deriveLegalBodyPhase({
        config,
        sessionAddress: GUARDIAN,
        nowMs: NOW,
        company,
        documents: null,
        orders: [draft],
        order: draft,
        ownerChoice,
        agentId,
      });
    const read = { order: draft, readFor: draft.id };
    expect(derive(null, null)).toEqual({ phase: "agreement" });
    expect(withAgreementRead(derive(null, null), read)).toEqual({ phase: "identity" });
    expect(withAgreementRead(derive("this-wallet", "42"), read)).toEqual({ phase: "link", branch: "browser" });
  });
});

describe("agreementReadAfterJump: the rail's jump to the agreement forgets the read", () => {
  test("a jump to the agreement shows it again", () => {
    expect(agreementReadAfterJump("agreement", "lbo_draft")).toBeNull();
  });

  test.each(["signin", "human", "company", "identity"] as const)("a jump to %s keeps it", (target) => {
    expect(agreementReadAfterJump(target, "lbo_draft")).toBe("lbo_draft");
  });
});

describe("sentenceOnArrival: a door's sentence carried back to the step it sends the person to", () => {
  const carried = { to: "company" as const, sentence: "This company cannot stand behind a legal body." };

  test("shown on the step it names", () => {
    expect(sentenceOnArrival(carried, "company")).toBe(carried.sentence);
  });

  test.each(["agreement", "identity", "signin", "human"] as const)("not on %s", (current) => {
    expect(sentenceOnArrival(carried, current)).toBeNull();
  });

  test("nothing carried, nothing shown", () => {
    expect(sentenceOnArrival(null, "company")).toBeNull();
  });
});
