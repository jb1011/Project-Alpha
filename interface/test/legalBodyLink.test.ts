/**
 * The link step's decisions, each pure: what is asked for, how the served link is shown, the gate
 * that alone hands the wallet typed data, how every answer of the two link doors is read, and what
 * the next click does.
 *
 * The served link is written out by hand for the live testnet deployment (chain 5042002, its
 * public factory, agent 897126) with anvil's first published account as the guardian and the
 * identity's owner. A spy stands in for the wallet's `signTypedDataAsync`: typed data the gate
 * refused never reaches it.
 */
import { describe, expect, test, vi } from "vitest";
import {
  ApiError,
  type Hex,
  type LegalBodyOrderView,
  type LinkMessageResult,
  type LinkSubmitAnswer,
} from "@/lib/api/types";
import { TIMEOUT_CODE, TIMEOUT_MESSAGE } from "@/lib/api/timeout";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";
import {
  PASTE_LINK_TTL_SECONDS,
  afterOrderRefused,
  decodeLinkFields,
  identityOwnerCheck,
  keepsSignedLink,
  linkAnswerOutcome,
  linkClickPlan,
  linkErrorOutcome,
  linkFieldRows,
  linkOutcomeView,
  linkRequestFor,
  linkScreen,
  type LinkStepOutcome,
  type SignedLink,
} from "@/lib/legalBody/link";
import { linkSignGate, signThroughGate, type LinkGateContext } from "@/lib/legalBody/signGate";
import { toWagmiLinkTypedData, type WagmiLinkTypedData } from "@/lib/legalBody/typedData";

const L = LEGAL_BODY_COPY.link;

/** The public testnet factory and the live test body's identity. */
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const LIVE_AGENT = "897126";
const CHAIN = 5042002;
/** Two of anvil's published test accounts, as served (checksummed). */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OTHER_WALLET = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
/** Inventions. */
const ANOTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
const MANIFEST = `0x${"9c".repeat(32)}` as const;
const OTHER_HASH = `0x${"7e".repeat(32)}` as const;
const SIGNATURE = `0x${"ab".repeat(65)}` as Hex;
/** The chain's clock when the link was served. */
const CHAIN_NOW = 1_791_000_000;
/** One hour after it: the server's default link life. */
const DEADLINE = CHAIN_NOW + 3_600;
const TTL_MAX = 85_800;

type Loose = Record<string, unknown>;
type Parts = { served: Loose; domain: Loose; message: Loose };

/** The link door's answer for agent 897126, bent by `bend` when given. */
function served(bend?: (p: Parts) => void, deadline = DEADLINE): LinkMessageResult {
  const domain: Loose = {
    name: "Novi LegalBodyFactory",
    version: "1",
    chainId: CHAIN,
    verifyingContract: FACTORY,
  };
  const message: Loose = {
    agentId: LIVE_AGENT,
    guardian: GUARDIAN,
    amendmentDelay: "172800",
    operatingAgreementHash: MANIFEST,
    deadline: String(deadline),
  };
  const types = {
    EIP712Domain: [
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ],
    LegalBodyLink: [
      { name: "agentId", type: "uint256" },
      { name: "guardian", type: "address" },
      { name: "amendmentDelay", type: "uint256" },
      { name: "operatingAgreementHash", type: "bytes32" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const out: Loose = {
    typedData: { domain, types, primaryType: "LegalBodyLink", message },
    identityOwner: GUARDIAN,
    deadline,
  };
  bend?.({ served: out, domain, message });
  return out as unknown as LinkMessageResult;
}

/** A draft order on the live deployment, before its reservation. */
const order = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_draft",
  publicId: "pub_draft",
  companyId: "co_test",
  state: "draft",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: MANIFEST, version: 1 },
  agentId: null,
  identityOwner: null,
  bodyAddress: null,
  linkDeadline: null,
  createTxHash: null,
  deployedAt: null,
  pointerSeenAt: null,
  createdAt: "2026-10-12T10:00:00Z",
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

const ctx = (over: Partial<LinkGateContext> = {}): LinkGateContext => ({
  order: order(),
  agreement: { manifestHash: MANIFEST },
  sessionAddress: GUARDIAN,
  agentId: LIVE_AGENT,
  nowSeconds: CHAIN_NOW,
  linkTtlMax: TTL_MAX,
  branch: "browser",
  ...over,
});

const config = (max = TTL_MAX) => ({ linkTtl: { min: 600, max, default: 3_600 } });

/** A wallet that signs whatever it is handed. */
const wallet = () => vi.fn<(typedData: WagmiLinkTypedData) => Promise<Hex>>(async () => SIGNATURE);

const apiError = (status: number, code: string, message = `the sentence of ${code}`) =>
  new ApiError(status, { code, message });

// ---------------------------------------------------------------------------------------------
// What is asked for
// ---------------------------------------------------------------------------------------------

describe("linkRequestFor", () => {
  test("the paste branch asks for six hours", () => {
    expect(PASTE_LINK_TTL_SECONDS).toBe(21_600);
  });

  test("the browser branch asks for no lifetime: the server's default applies", () => {
    const asked = linkRequestFor("browser", config());
    expect(asked).toEqual({});
    expect("ttlSeconds" in asked).toBe(false);
  });

  test("the paste branch asks for 21600 s under the served ceiling of 85800 s", () => {
    expect(linkRequestFor("paste", config())).toEqual({ ttlSeconds: 21_600 });
  });

  test("with a smaller served ceiling, the browser branch still asks for none", () => {
    expect(linkRequestFor("browser", config(3_600))).toEqual({});
  });

  test("with a served ceiling below six hours, the paste branch is refused before any door", () => {
    expect(linkRequestFor("paste", config(3_600))).toEqual({ problem: "ttl_above_max" });
    expect(linkRequestFor("paste", config(21_599))).toEqual({ problem: "ttl_above_max" });
  });

  test("a ceiling of exactly six hours takes six hours", () => {
    expect(linkRequestFor("paste", config(21_600))).toEqual({ ttlSeconds: 21_600 });
  });

  test("a ceiling that cannot be read refuses the paste branch", () => {
    expect(linkRequestFor("paste", config(Number.NaN))).toEqual({ problem: "ttl_above_max" });
  });
});

// ---------------------------------------------------------------------------------------------
// The served link, shown decoded
// ---------------------------------------------------------------------------------------------

describe("decodeLinkFields", () => {
  test("the five fields and the domain, decoded", () => {
    const d = decodeLinkFields(served().typedData, CHAIN_NOW);
    expect(d).toEqual({
      agentId: LIVE_AGENT,
      guardian: GUARDIAN,
      amendmentDelay: "48 hours",
      agreementHash: MANIFEST,
      deadlineIso: "2026-10-03T05:00:00.000Z",
      minutesLeft: 60,
      domain: { name: "Novi LegalBodyFactory", version: "1", chainId: CHAIN, verifyingContract: FACTORY },
    });
  });

  test.each([
    ["172800", "48 hours"],
    ["3600", "1 hour"],
    ["5400", "90 minutes"],
    ["60", "1 minute"],
    ["61", "61 seconds"],
  ])("an amendment delay of %s s reads %j", (seconds, words) => {
    const td = served(({ message }) => (message.amendmentDelay = seconds)).typedData;
    expect(decodeLinkFields(td, CHAIN_NOW).amendmentDelay).toBe(words);
  });

  test.each([
    [3_600, 60],
    [3_595, 59],
    [3_540, 59],
    [3_539, 58],
    [300, 5],
    [60, 1],
    [59, 0],
    [0, 0],
    [-30, 0],
  ])("%i s before the deadline is %i whole minutes: rounded down, never below zero", (left, minutes) => {
    expect(decodeLinkFields(served().typedData, DEADLINE - left).minutesLeft).toBe(minutes);
  });

  test("a clock that cannot be read leaves no minutes, never NaN", () => {
    expect(decodeLinkFields(served().typedData, Number.NaN).minutesLeft).toBe(0);
  });

  test("the deadline in ISO 8601, in UTC, is the deadline's own second", () => {
    const { deadlineIso } = decodeLinkFields(served().typedData, CHAIN_NOW);
    expect(deadlineIso.endsWith("Z")).toBe(true);
    expect(Date.parse(deadlineIso)).toBe(DEADLINE * 1000);
  });

  test("a deadline no date can hold reads as no date, never a throw", () => {
    const td = served(({ message }) => (message.deadline = "9".repeat(30))).typedData;
    expect(decodeLinkFields(td, CHAIN_NOW).deadlineIso).toBe("");
  });
});

describe("linkFieldRows", () => {
  const rows = (nowSeconds = DEADLINE - 3_595) =>
    linkFieldRows(decodeLinkFields(served().typedData, nowSeconds));

  test("one row per field, then the domain, each with its decoded value", () => {
    expect(rows()).toEqual([
      { label: L.fields.agentId, value: LIVE_AGENT, note: null },
      { label: L.fields.guardian, value: GUARDIAN, note: L.yourWallet },
      { label: L.fields.amendmentDelay, value: "48 hours", note: null },
      { label: L.fields.agreementHash, value: MANIFEST, note: L.theOneYouRead },
      { label: L.fields.deadline, value: "2026-10-03 05:00 UTC", note: "in 59 minutes" },
      {
        label: L.fields.domain,
        value: `Novi LegalBodyFactory, version 1, chain ${CHAIN}, verifying contract ${FACTORY}`,
        note: null,
      },
    ]);
  });

  test("the words beside the values: guardian = your wallet, hash = the one you read, deadline in N minutes", () => {
    const r = rows();
    expect(r[1].note).toBe("your wallet");
    expect(r[3].note).toBe("the one you read");
    expect(r[4].note).toBe("in 59 minutes");
  });

  test("one minute, and less than one", () => {
    expect(rows(DEADLINE - 61)[4].note).toBe("in 1 minute");
    expect(rows(DEADLINE - 30)[4].note).toBe("in less than a minute");
  });

  test.each([
    [21_600, "in 6 hours"],
    [21_540, "in 5 hours"],
    [7_200, "in 2 hours"],
    [3_600, "in 1 hour"],
    [3_599, "in 59 minutes"],
    [61, "in 1 minute"],
    [30, "in less than a minute"],
  ])("on the paste branch %i s before the deadline reads %j: whole hours, minutes under one", (left, note) => {
    const sixHours = served(undefined, CHAIN_NOW + 21_600);
    const at = CHAIN_NOW + 21_600 - left;
    expect(linkFieldRows(decodeLinkFields(sixHours.typedData, at), "paste")[4].note).toBe(note);
  });

  test("the browser branch keeps minutes, as before", () => {
    const sixHours = served(undefined, CHAIN_NOW + 21_600);
    expect(linkFieldRows(decodeLinkFields(sixHours.typedData, CHAIN_NOW + 60), "browser")[4].note).toBe(
      "in 359 minutes",
    );
    expect(linkFieldRows(decodeLinkFields(sixHours.typedData, CHAIN_NOW + 60))[4].note).toBe("in 359 minutes");
  });

  test("no row is left with a template unfilled", () => {
    for (const r of rows()) {
      expect(r.value).not.toMatch(/\{[a-zA-Z]+\}/);
      if (r.note !== null) expect(r.note).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The identity's owner, on the browser branch
// ---------------------------------------------------------------------------------------------

describe("identityOwnerCheck", () => {
  test("on the browser branch the served owner must be the wallet in session, in any case", () => {
    expect(identityOwnerCheck(served(), { branch: "browser", sessionAddress: GUARDIAN })).toEqual({ ok: true });
    expect(
      identityOwnerCheck(served(), {
        branch: "browser",
        sessionAddress: GUARDIAN.toLowerCase() as `0x${string}`,
      }),
    ).toEqual({ ok: true });
  });

  test("another owner on the browser branch is a stop with its problem word", () => {
    const s = served(({ served: out }) => (out.identityOwner = OTHER_WALLET));
    expect(identityOwnerCheck(s, { branch: "browser", sessionAddress: GUARDIAN })).toEqual({
      ok: false,
      problem: "identity_owner",
    });
  });

  test.each([
    ["missing", undefined],
    ["null", null],
    ["a number", 42],
  ])("a served owner that is %s is a stop of its own on the browser branch, not a moved identity", (_name, value) => {
    const s = served(({ served: out }) => (out.identityOwner = value));
    expect(identityOwnerCheck(s, { branch: "browser", sessionAddress: GUARDIAN })).toEqual({
      ok: false,
      problem: "no_identity_owner",
    });
  });

  test("the paste branch is another key by choice: its owner is not the session's to match", () => {
    const s = served(({ served: out }) => (out.identityOwner = OTHER_WALLET));
    expect(identityOwnerCheck(s, { branch: "paste", sessionAddress: GUARDIAN })).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------------------------
// The gate: refused typed data never reaches the wallet
// ---------------------------------------------------------------------------------------------

describe("linkSignGate", () => {
  test("a link that passes comes out converted for wagmi", () => {
    const s = served();
    const gate = linkSignGate(s, ctx());
    expect(gate).toEqual({ ok: true, typedData: toWagmiLinkTypedData(s.typedData) });
    if (!gate.ok) throw new Error("unreachable");
    expect(gate.typedData.message.deadline).toBe(BigInt(DEADLINE));
    expect(Object.keys(gate.typedData.types)).toEqual(["LegalBodyLink"]);
  });

  const refusals: [string, LinkMessageResult, LinkGateContext, string][] = [
    ["another verifying contract", served(({ domain }) => (domain.verifyingContract = ANOTHER_FACTORY)), ctx(), "domain_factory"],
    ["another chain", served(({ domain }) => (domain.chainId = 5042)), ctx(), "domain_chain"],
    ["another guardian", served(({ message }) => (message.guardian = OTHER_WALLET)), ctx(), "guardian"],
    ["another identity than the one picked", served(({ message }) => (message.agentId = "1")), ctx(), "agent_id"],
    ["another agreement hash", served(({ message }) => (message.operatingAgreementHash = OTHER_HASH)), ctx(), "agreement_hash"],
    ["an agreement other than the one read", served(), ctx({ agreement: { manifestHash: OTHER_HASH } }), "agreement_hash"],
    ["another amendment delay", served(({ message }) => (message.amendmentDelay = "86400")), ctx(), "amendment_delay"],
    ["four minutes left", served(), ctx({ nowSeconds: DEADLINE - 240 }), "deadline_window"],
    ["an identity owned by another key", served(({ served: out }) => (out.identityOwner = OTHER_WALLET)), ctx(), "identity_owner"],
    ["no answer at all", null as unknown as LinkMessageResult, ctx(), "primary_type"],
  ];

  test.each(refusals)("%s: the refusal, and the wallet is never called", async (_name, s, context, problem) => {
    const gate = linkSignGate(s, context);
    expect(gate).toEqual({ ok: false, problem });
    const sign = wallet();
    expect(await signThroughGate(gate, sign)).toEqual({ kind: "refused", problem });
    expect(sign).not.toHaveBeenCalled();
  });

  test("the field checks come before the owner check", () => {
    const s = served(({ served: out, domain }) => {
      out.identityOwner = OTHER_WALLET;
      domain.verifyingContract = ANOTHER_FACTORY;
    });
    expect(linkSignGate(s, ctx())).toEqual({ ok: false, problem: "domain_factory" });
  });

  test("a link that passes reaches the wallet once, exactly as converted", async () => {
    const s = served();
    const sign = wallet();
    const outcome = await signThroughGate(linkSignGate(s, ctx()), sign);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(sign.mock.calls[0][0]).toEqual(toWagmiLinkTypedData(s.typedData));
    expect(outcome).toEqual({ kind: "signed", typedData: toWagmiLinkTypedData(s.typedData), signature: SIGNATURE });
  });

  test("the owner check is the browser branch's: on the paste branch another owner passes", async () => {
    const s = served(({ served: out }) => (out.identityOwner = OTHER_WALLET));
    const gate = linkSignGate(s, ctx({ branch: "paste" }));
    expect(gate.ok).toBe(true);
  });

  test("a wallet that does not sign is a decline, after one call", async () => {
    const sign = vi.fn<(typedData: WagmiLinkTypedData) => Promise<Hex>>(async () => {
      throw new Error("User rejected the request.");
    });
    expect(await signThroughGate(linkSignGate(served(), ctx()), sign)).toEqual({ kind: "declined" });
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Which screen
// ---------------------------------------------------------------------------------------------

describe("linkScreen", () => {
  const rows: [string, LegalBodyDerivation, ReturnType<typeof linkScreen>][] = [
    ["a draft signed in this browser", { phase: "link", branch: "browser" }, "sign"],
    ["a draft signed elsewhere", { phase: "link", branch: "paste" }, "paste"],
    ["the body being created, from this wallet", { phase: "link", branch: "browser", notice: { kind: "creating" } }, "creating"],
    ["the body being created, from another key", { phase: "link", branch: "paste", notice: { kind: "creating" } }, "creating"],
    ["no branch: never this browser's wallet", { phase: "link" }, "paste"],
  ];
  test.each(rows)("%s", (_name, derivation, screen) => {
    expect(linkScreen(derivation)).toBe(screen);
  });
});

// ---------------------------------------------------------------------------------------------
// The link door's answers
// ---------------------------------------------------------------------------------------------

describe("linkAnswerOutcome", () => {
  const ID = "lbo_draft";

  test.each([
    ["200 with the body created", { status: 200, body: order({ state: "deployed" }) }],
    ["202 while it is created", { status: 202, body: order({ state: "reserved" }) }],
    ["200 with a body read broken", { status: 200, body: order({ state: "broken" }) }],
  ] as [string, LinkSubmitAnswer][])("%s: the derivation decides", (_name, answer) => {
    expect(linkAnswerOutcome(answer, ID)).toEqual({ kind: "rederive" });
  });

  test.each([
    ["null", null],
    ["a string", "ok"],
    ["an array", [order()]],
    ["an object with no id", { state: "reserved" }],
    ["an object with no state", { id: ID }],
    ["a state that is not a string", { id: ID, state: 1 }],
    ["another order", order({ id: "lbo_other", state: "reserved" })],
  ])("a 200 or 202 whose body is %s is not read as an order", (_name, body) => {
    for (const status of [200, 202] as const)
      expect(linkAnswerOutcome({ status, body } as unknown as LinkSubmitAnswer, ID)).toEqual({
        kind: "unreadable",
      });
  });

  test("a 422 before the reservation: the sentence verbatim, the draft kept", () => {
    const sentence = "The link's deadline has passed: a link message with a new deadline is needed.";
    const answer: LinkSubmitAnswer = {
      status: 422,
      body: { code: "deadline_out_of_window", message: sentence, detail: {}, order: order() },
    };
    expect(linkAnswerOutcome(answer, ID)).toEqual({
      kind: "refused",
      code: "deadline_out_of_window",
      sentence,
      lapsed: false,
    });
  });

  test("a 422 after the reservation: the order lapsed", () => {
    const answer: LinkSubmitAnswer = {
      status: 422,
      body: { code: "order_lapsed", message: "lapsed", detail: {}, order: order({ state: "lapsed" }) },
    };
    expect(linkAnswerOutcome(answer, ID)).toEqual({
      kind: "refused",
      code: "order_lapsed",
      sentence: "lapsed",
      lapsed: true,
    });
  });

  test("a 422 whose order is not this order's is not read either", () => {
    const answer = {
      status: 422,
      body: { code: "bad_signature", message: "no", detail: {}, order: { id: "lbo_other", state: "draft" } },
    } as unknown as LinkSubmitAnswer;
    expect(linkAnswerOutcome(answer, ID)).toEqual({ kind: "unreadable" });
  });
});

describe("linkErrorOutcome", () => {
  test.each([
    ["order_expired", 409, { kind: "back", to: "agreement" }],
    ["order_closed", 409, { kind: "back", to: "agreement" }],
    ["agreement_outdated", 409, { kind: "back", to: "agreement" }],
    ["order_revoked", 409, { kind: "back", to: "agreement" }],
    ["other_deployment", 409, { kind: "back", to: "agreement" }],
    ["company_not_eligible", 409, { kind: "back", to: "company" }],
    ["identity_not_found", 422, { kind: "back", to: "identity" }],
    ["rate_limited", 429, { kind: "wait" }],
    ["legal_body_attempts", 429, { kind: "wait" }],
    ["busy", 503, { kind: "wait" }],
    ["chain_unavailable", 503, { kind: "retry" }],
    ["internal_error", 500, { kind: "retry" }],
    ["agreement_unreadable", 500, { kind: "retry" }],
    ["link_already_used", 409, { kind: "new_message" }],
    ["invalid_agent_id", 400, { kind: "sentence" }],
  ] as [string, number, Partial<LinkStepOutcome>][])(
    "%s routes as the house table says, with the sentence as served",
    (code, status, expected) => {
      for (const door of ["message", "submit"] as const) {
        const outcome = linkErrorOutcome(apiError(status, code), door);
        expect(outcome).toEqual({ ...expected, sentence: `the sentence of ${code}` });
      }
    },
  );

  test.each(["malformed_link", "malformed_signature"])(
    "%s in the browser is ours: the page built the link",
    (code) => {
      expect(linkErrorOutcome(apiError(400, code), "submit")).toEqual({ kind: "bug" });
    },
  );

  test("a timeout is no answer, said for the door it came from", () => {
    const timeout = new ApiError(0, { code: TIMEOUT_CODE, message: TIMEOUT_MESSAGE });
    expect(linkErrorOutcome(timeout, "submit")).toEqual({ kind: "no_answer", door: "submit" });
    expect(linkErrorOutcome(timeout, "message")).toEqual({ kind: "no_answer", door: "message" });
  });

  test("a failure that is not the API's is no answer", () => {
    expect(linkErrorOutcome(new TypeError("Failed to fetch"), "submit")).toEqual({
      kind: "no_answer",
      door: "submit",
    });
    expect(linkErrorOutcome(undefined, "message")).toEqual({ kind: "no_answer", door: "message" });
  });
});

describe("afterOrderRefused: the order read again decides where a refused order goes", () => {
  test("still a draft (its agreement outdated, or expired by the server's clock): a new order, from the agreement", () => {
    expect(afterOrderRefused(order())).toBe("new_order");
  });

  test.each(["reserved", "deployed", "linked", "lapsed", "abandoned", "superseded", "broken"] as const)(
    "an order now %s is shown where it is: the derivation decides, and no new order is offered here",
    (state) => {
      expect(afterOrderRefused(order({ state }))).toBe("rederive");
    },
  );

  test("an order that could not be read again goes by the door's table: a new order", () => {
    expect(afterOrderRefused(undefined)).toBe("new_order");
    expect(afterOrderRefused(null)).toBe("new_order");
  });
});

// ---------------------------------------------------------------------------------------------
// The next click
// ---------------------------------------------------------------------------------------------

describe("the next click: a fresh link, or the same signed link sent again", () => {
  const signed: SignedLink = { served: served(), signature: SIGNATURE };
  const refused = (code: string, lapsed = false): LinkStepOutcome => ({
    kind: "refused",
    code,
    sentence: "s",
    lapsed,
  });

  test("Sign always asks for a fresh link: it never signs or sends an old one", () => {
    expect(linkClickPlan({ click: "sign", held: null, nowSeconds: CHAIN_NOW })).toEqual({ kind: "fresh" });
    expect(linkClickPlan({ click: "sign", held: signed, nowSeconds: CHAIN_NOW })).toEqual({ kind: "fresh" });
  });

  test("after a refused deadline_out_of_window, nothing is kept and the next click asks for a fresh link", () => {
    const outcome = refused("deadline_out_of_window");
    expect(keepsSignedLink(outcome)).toBe(false);
    const held = keepsSignedLink(outcome) ? signed : null;
    for (const click of ["sign", "retry"] as const)
      expect(linkClickPlan({ click, held, nowSeconds: CHAIN_NOW })).toEqual({ kind: "fresh" });
  });

  test.each([
    ["a link already used", { kind: "new_message", sentence: "s" }],
    ["agent_in_flight: Sign is the retry", refused("agent_in_flight")],
    ["a lapsed order", refused("order_lapsed", true)],
    ["a bad signature", refused("bad_signature")],
    ["an answer that is not an order", { kind: "unreadable" }],
    ["the derivation decides", { kind: "rederive" }],
    ["back to the agreement", { kind: "back", to: "agreement", sentence: "s" }],
    ["a page bug", { kind: "bug" }],
    ["a sentence", { kind: "sentence", sentence: "s" }],
    ["no answer from the message door", { kind: "no_answer", door: "message" }],
  ] as [string, LinkStepOutcome][])("%s keeps no signed link", (_name, outcome) => {
    expect(keepsSignedLink(outcome)).toBe(false);
  });

  test.each([
    ["a limit reached", { kind: "wait", sentence: "s" }],
    ["nothing changed, try again", { kind: "retry", sentence: "s" }],
    ["no answer from the link door", { kind: "no_answer", door: "submit" }],
  ] as [string, LinkStepOutcome][])("%s keeps the signed link for Try again", (_name, outcome) => {
    expect(keepsSignedLink(outcome)).toBe(true);
  });

  test("Try again sends the same signed link while it still has five minutes", () => {
    expect(linkClickPlan({ click: "retry", held: signed, nowSeconds: DEADLINE - 300 })).toEqual({
      kind: "resubmit",
      link: signed,
    });
  });

  test("Try again asks for a fresh link once the signed one has less than five minutes", () => {
    expect(linkClickPlan({ click: "retry", held: signed, nowSeconds: DEADLINE - 299 })).toEqual({ kind: "fresh" });
    expect(linkClickPlan({ click: "retry", held: signed, nowSeconds: DEADLINE + 10 })).toEqual({ kind: "fresh" });
  });

  test("Try again with nothing kept, or with a clock that cannot be read, asks for a fresh link", () => {
    expect(linkClickPlan({ click: "retry", held: null, nowSeconds: CHAIN_NOW })).toEqual({ kind: "fresh" });
    expect(linkClickPlan({ click: "retry", held: signed, nowSeconds: Number.NaN })).toEqual({ kind: "fresh" });
  });
});

// ---------------------------------------------------------------------------------------------
// What the step says and offers after each outcome
// ---------------------------------------------------------------------------------------------

describe("linkOutcomeView", () => {
  type ViewConfig = Parameters<typeof linkOutcomeView>[1];
  const sandbox: ViewConfig = { chainId: CHAIN, environment: "sandbox" };
  const view = (o: LinkStepOutcome, c: ViewConfig = sandbox) => linkOutcomeView(o, c);

  test("the derivation decides: nothing to say", () => {
    expect(view({ kind: "rederive" })).toEqual({ lines: [], action: "sign", sendBack: null });
  });

  test("an answer that is not an order: a plain sentence, and Sign", () => {
    expect(view({ kind: "unreadable" })).toEqual({ lines: [L.unreadableAnswer], action: "sign", sendBack: null });
  });

  test("a refusal before the reservation: the sentence verbatim, the draft kept, Sign again", () => {
    expect(view({ kind: "refused", code: "deadline_out_of_window", sentence: "door words", lapsed: false })).toEqual({
      lines: ["door words"],
      action: "sign",
      sendBack: null,
    });
  });

  test("a lapsed order: the sentence verbatim and the way out, carried to the order's closed screen", () => {
    expect(view({ kind: "refused", code: "order_lapsed", sentence: "door words", lapsed: true })).toEqual({
      lines: ["door words"],
      action: "new_order",
      sendBack: { to: "closed", sentence: "door words" },
    });
  });

  test("agent_in_flight: the sentence, then try again in a moment, with Sign as the retry", () => {
    const v = view({ kind: "refused", code: "agent_in_flight", sentence: "door words", lapsed: false });
    expect(v).toEqual({ lines: ["door words", L.tryAgainSoon], action: "sign", sendBack: null });
    expect(L.tryAgainSoon).toContain("try again in a moment");
  });

  test.each(["agreement", "company", "identity"] as const)("back to the %s, with the sentence", (to) => {
    expect(view({ kind: "back", to, sentence: "door words" })).toEqual({
      lines: ["door words"],
      action: "sign",
      sendBack: { to, sentence: "door words" },
    });
  });

  test.each(["wait", "retry"] as const)("%s: the sentence and Try again, never a loop", (kind) => {
    expect(view({ kind, sentence: "door words" })).toEqual({ lines: ["door words"], action: "retry", sendBack: null });
  });

  test("a link already used: the sentence, and Sign asks for a fresh one", () => {
    expect(view({ kind: "new_message", sentence: "door words" })).toEqual({
      lines: ["door words"],
      action: "sign",
      sendBack: null,
    });
  });

  test("a link the door cannot read: something went wrong building the link", () => {
    expect(view({ kind: "bug" })).toEqual({ lines: [L.buildFailed], action: "sign", sendBack: null });
    expect(L.buildFailed.toLowerCase()).toContain("something went wrong building the link");
  });

  test("any other refusal: its sentence as served", () => {
    expect(view({ kind: "sentence", sentence: "door words" })).toEqual({
      lines: ["door words"],
      action: "sign",
      sendBack: null,
    });
  });

  test("no answer: said for each door, with Try again", () => {
    expect(view({ kind: "no_answer", door: "message" })).toEqual({
      lines: [L.noAnswerMessage],
      action: "retry",
      sendBack: null,
    });
    expect(view({ kind: "no_answer", door: "submit" })).toEqual({
      lines: [L.noAnswerSubmit],
      action: "retry",
      sendBack: null,
    });
  });

  test("the gate's stop names its problem, and says the wallet was not opened", () => {
    expect(view({ kind: "stop", problem: "deadline_window" })).toEqual({
      lines: [fillCopy(L.refused, { problem: "deadline_window" })],
      action: "sign",
      sendBack: null,
    });
  });

  test("an identity owned by another key now goes back to the identity step, where another is picked", () => {
    expect(view({ kind: "stop", problem: "identity_owner" })).toEqual({
      lines: [L.ownerMoved],
      action: "sign",
      sendBack: { to: "identity", sentence: L.ownerMoved },
    });
  });

  test("a link served without its owner: a plain sentence of its own, and the identity is kept", () => {
    expect(view({ kind: "stop", problem: "no_identity_owner" })).toEqual({
      lines: [L.ownerMissing],
      action: "sign",
      sendBack: null,
    });
    expect(L.ownerMissing).not.toBe(L.ownerMoved);
  });

  test("a decline on the link's network, and on another", () => {
    expect(view({ kind: "declined", walletChainId: CHAIN }).lines).toEqual([L.declined]);
    expect(view({ kind: "declined", walletChainId: undefined }).lines).toEqual([L.declined]);
    expect(view({ kind: "declined", walletChainId: 1 }).lines).toEqual([
      fillCopy(L.declinedOtherNetwork, { network: "Arc testnet" }),
    ]);
    expect(view({ kind: "declined", walletChainId: 1 }, { chainId: CHAIN, environment: "production" }).lines).toEqual([
      fillCopy(L.declinedOtherNetwork, { network: "Arc" }),
    ]);
  });

  test("a wallet not connected here", () => {
    expect(view({ kind: "not_connected" })).toEqual({ lines: [L.notConnected], action: "sign", sendBack: null });
  });

  test("no line of any outcome is left with a template unfilled", () => {
    const all: LinkStepOutcome[] = [
      { kind: "unreadable" },
      { kind: "bug" },
      { kind: "no_answer", door: "message" },
      { kind: "no_answer", door: "submit" },
      { kind: "stop", problem: "deadline_window" },
      { kind: "stop", problem: "identity_owner" },
      { kind: "stop", problem: "no_identity_owner" },
      { kind: "declined", walletChainId: 1 },
      { kind: "declined", walletChainId: CHAIN },
      { kind: "not_connected" },
      { kind: "refused", code: "agent_in_flight", sentence: "s", lapsed: false },
    ];
    for (const o of all) for (const line of view(o).lines) expect(line).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});
