/**
 * The paste branch's decisions, each pure: the identity is owned by another key, so the person
 * copies the link's typed data exactly as served, signs it wherever that key lives, pastes the
 * signature back, and sends the pointer transaction from that key.
 *
 * Here: what a pasted signature becomes (`parsePastedSignature`), the copy box's text
 * (`servedTypedDataText`) and the gate in front of it (`pasteCopyGate`), what one click on "Send
 * the signature" does (`pasteSubmitPlan`), how the doors' answers are read and shown on this branch
 * (`pasteErrorOutcome`, `pasteOutcomeView`), the call to send (`pointerCallText`,
 * `pointerCallRows`), the chain checks before it is shown (`pointerChecksOf`,
 * `pastePointerState`), and the timed watch of the pointer (`pointerSeen`, `pointerWatchInterval`,
 * `pointerWatchStatus`).
 *
 * The served link and the order are written out by hand for the live testnet deployment (chain
 * 5042002, its public registry and factory, agent 897126 and its body), with anvil's first
 * published account as the guardian and its second as the identity's owner.
 */
import { decodeFunctionData, encodeFunctionData, type Hex } from "viem";
import { describe, expect, test } from "vitest";
import { TIMEOUT_CODE, TIMEOUT_MESSAGE } from "@/lib/api/timeout";
import {
  ApiError,
  type Address,
  type LegalBodyOrderView,
  type LinkMessageResult,
} from "@/lib/api/types";
import { identityRegistryAbi, type CallContext } from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";
import { linkOutcomeView, type LinkStepOutcome } from "@/lib/legalBody/link";
import {
  MAX_PASTED_SIGNATURE_BYTES,
  POINTER_WATCH_MS,
  POINTER_WATCH_WINDOW_MS,
  parsePastedSignature,
  pasteCopyGate,
  pasteErrorOutcome,
  pasteOutcomeView,
  pastePointerState,
  pasteWayOn,
  pasteSubmitPlan,
  pointerCallRows,
  pointerCallText,
  pointerChecksOf,
  pointerScreen,
  pointerSeen,
  pointerWatchInterval,
  pointerWatchStatus,
  refreshErrorLine,
  servedTypedDataText,
  type ChainRead,
  type PasteOutcome,
  type PointerCallText,
  type PointerChecks,
} from "@/lib/legalBody/paste";

const P = LEGAL_BODY_COPY.paste;
const L = LEGAL_BODY_COPY.link;

/** The public testnet registry and factory, and the live test body (agent 897126). */
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const LIVE_BODY = "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE" as const;
const LIVE_AGENT = "897126";
const CHAIN = 5042002;
/** Two of anvil's published test accounts, as served (checksummed): the guardian, and the key
 *  that owns the identity elsewhere. */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
/** Anvil's third published account: an owner the identity moved to. */
const THIRD = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
/** Inventions. */
const ANOTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
const MANIFEST = `0x${"9c".repeat(32)}` as const;
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;

/** The pointer for chain 5042002 (0x4cef52) and the live body, word by word: version 1, the chain
 *  id, the body address. */
const LIVE_POINTER = ("0x" +
  "0".repeat(63) +
  "1" +
  "0".repeat(58) +
  "4cef52" +
  "0".repeat(24) +
  "5969b48ff7a3a4c6689366a9a6d7aa24b0c4b5ee") as Hex;

/** The chain's clock when the link was served, and the paste branch's six hours after it. */
const CHAIN_NOW = 1_791_000_000;
const DEADLINE = CHAIN_NOW + 21_600;
const TTL_MAX = 85_800;

const upper = (a: string) => `0x${a.slice(2).toUpperCase()}`;

type Loose = Record<string, unknown>;

/** The link door's answer for agent 897126 on the paste branch, bent by `bend` when given. */
function served(bend?: (p: { served: Loose; message: Loose }) => void): LinkMessageResult {
  const message: Loose = {
    agentId: LIVE_AGENT,
    guardian: GUARDIAN,
    amendmentDelay: "172800",
    operatingAgreementHash: MANIFEST,
    deadline: String(DEADLINE),
  };
  const out: Loose = {
    typedData: {
      domain: {
        name: "Novi LegalBodyFactory",
        version: "1",
        chainId: CHAIN,
        verifyingContract: FACTORY,
      },
      types: {
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
      },
      primaryType: "LegalBodyLink",
      message,
    },
    identityOwner: OWNER,
    deadline: DEADLINE,
  };
  bend?.({ served: out, message });
  return out as unknown as LinkMessageResult;
}

/** An order on the live deployment: a draft by default. */
const order = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_paste",
  publicId: "pub_paste",
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

/** The live order's facts once its body was created, the identity owned by another key. */
const deployed = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView =>
  order({
    state: "deployed",
    agentId: LIVE_AGENT,
    identityOwner: OWNER,
    bodyAddress: LIVE_BODY,
    linkDeadline: DEADLINE,
    createTxHash: `0x${"ab".repeat(32)}`,
    deployedAt: CHAIN_NOW + 60,
    ...over,
  });

const gateCtx = (over: Partial<Parameters<typeof pasteCopyGate>[1]> = {}) => ({
  order: order(),
  agreement: { manifestHash: MANIFEST },
  sessionAddress: GUARDIAN,
  agentId: LIVE_AGENT,
  nowSeconds: CHAIN_NOW,
  linkTtlMax: TTL_MAX,
  ...over,
});

const callConfig: CallContext["config"] = {
  chainId: CHAIN,
  identityRegistry: REGISTRY,
  factory: FACTORY,
};

const viewConfig = { chainId: CHAIN, environment: "sandbox" as const };

const apiError = (status: number, code: string, message = `the sentence of ${code}`) =>
  new ApiError(status, { code, message });

const SIG_65 = `0x${"ab".repeat(65)}`;

// ---------------------------------------------------------------------------------------------
// The pasted signature
// ---------------------------------------------------------------------------------------------

describe("parsePastedSignature", () => {
  test("spaces and a newline around a signature are trimmed, and it reads in lower case", () => {
    expect(parsePastedSignature(`  0x${"AB".repeat(65)}\n`)).toBe(SIG_65);
  });

  test("a signature pasted without 0x gets it", () => {
    expect(parsePastedSignature("ab".repeat(65))).toBe(SIG_65);
  });

  test("upper-case hex reads in lower case, whatever the prefix's case", () => {
    expect(parsePastedSignature(`0x${"CD".repeat(65)}`)).toBe(`0x${"cd".repeat(65)}`);
    expect(parsePastedSignature(`0X${"cd".repeat(65)}`)).toBe(`0x${"cd".repeat(65)}`);
    expect(parsePastedSignature("0xAbCdEf")).toBe("0xabcdef");
  });

  test("tabs, carriage returns and a no-break space at the ends are trimmed too", () => {
    expect(parsePastedSignature(`\t\r\n\u00A0${SIG_65}\u00A0\r\n`)).toBe(SIG_65);
  });

  test("an odd number of hex digits is not whole bytes", () => {
    expect(parsePastedSignature("0xabc")).toEqual({ problem: "odd_length" });
    expect(parsePastedSignature("abc")).toEqual({ problem: "odd_length" });
  });

  test("2,048 bytes pass, 2,049 bytes are too long", () => {
    expect(MAX_PASTED_SIGNATURE_BYTES).toBe(2_048);
    const most = `0x${"ab".repeat(2_048)}`;
    expect(parsePastedSignature(most)).toBe(most);
    expect(parsePastedSignature(`0x${"ab".repeat(2_049)}`)).toEqual({ problem: "too_long" });
    expect(parsePastedSignature("ab".repeat(2_049))).toEqual({ problem: "too_long" });
  });

  test.each([
    ["nothing", ""],
    ["spaces only", "   "],
    ["newlines only", "\n\n"],
  ])("%s is empty", (_name, raw) => {
    expect(parsePastedSignature(raw)).toEqual({ problem: "empty" });
  });

  test("0x alone is accepted, as the door reads it", () => {
    expect(parsePastedSignature("0x")).toBe("0x");
    expect(parsePastedSignature("  0x\n")).toBe("0x");
  });

  test.each([
    ["a letter beyond f", "0xzz"],
    ["a space inside", `0x${"ab".repeat(32)} ${"ab".repeat(33)}`],
    ["a newline inside", `0x${"ab".repeat(32)}\n${"ab".repeat(33)}`],
    ["two prefixes", `0x0x${"ab".repeat(65)}`],
    ["quotes kept from a JSON answer", `"${SIG_65}"`],
    ["a sign", `-${"ab".repeat(65)}`],
    ["full-width digits", "0x０１"],
  ])("%s is not hex", (_name, raw) => {
    expect(parsePastedSignature(raw)).toEqual({ problem: "not_hex" });
  });
});

// ---------------------------------------------------------------------------------------------
// The typed data as served, and the gate in front of the copy box
// ---------------------------------------------------------------------------------------------

describe("servedTypedDataText", () => {
  test("it is the typed data as served, with EIP712Domain present, and reads back the same", () => {
    const td = served().typedData;
    const text = servedTypedDataText(td);
    expect(text).toBe(JSON.stringify(td, null, 2));
    const back = JSON.parse(text);
    expect(back).toStrictEqual(td);
    expect(back.types.EIP712Domain).toStrictEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
  });

  test("the keys keep the order they were served in, and the numbers stay decimal strings", () => {
    const text = servedTypedDataText(served().typedData);
    expect(text.indexOf('"domain"')).toBeLessThan(text.indexOf('"types"'));
    expect(text.indexOf('"types"')).toBeLessThan(text.indexOf('"primaryType"'));
    expect(text.indexOf('"primaryType"')).toBeLessThan(text.indexOf('"message"'));
    expect(text).toContain(`"agentId": "${LIVE_AGENT}"`);
    expect(text).toContain(`"deadline": "${DEADLINE}"`);
    expect(text).toContain(`"chainId": ${CHAIN}`);
  });
});

describe("pasteCopyGate", () => {
  test("a link every field of which checks out is shown, as served", () => {
    const s = served();
    expect(pasteCopyGate(s, gateCtx())).toEqual({
      ok: true,
      text: JSON.stringify(s.typedData, null, 2),
    });
  });

  test("the identity's owner is another key by choice: it is not matched to this wallet", () => {
    expect(pasteCopyGate(served(), gateCtx()).ok).toBe(true);
  });

  test("the six hours of this branch pass under the served ceiling", () => {
    expect(pasteCopyGate(served(), gateCtx({ nowSeconds: CHAIN_NOW - 100 })).ok).toBe(true);
  });

  test.each<[string, (p: { served: Loose; message: Loose }) => void, Partial<Parameters<typeof pasteCopyGate>[1]>, string]>([
    ["another guardian", ({ message }) => (message.guardian = OWNER), {}, "guardian"],
    ["another identity", ({ message }) => (message.agentId = "897127"), {}, "agent_id"],
    ["another agreement", ({ message }) => (message.operatingAgreementHash = `0x${"7e".repeat(32)}`), {}, "agreement_hash"],
    ["another delay", ({ message }) => (message.amendmentDelay = "3600"), {}, "amendment_delay"],
    [
      "another factory",
      ({ served: s }) => ((s.typedData as Loose).domain = { name: "Novi LegalBodyFactory", version: "1", chainId: CHAIN, verifyingContract: ANOTHER_FACTORY }),
      {},
      "domain_factory",
    ],
    ["no EIP712Domain", ({ served: s }) => delete ((s.typedData as Loose).types as Loose).EIP712Domain, {}, "types_keys"],
    ["four minutes left", () => {}, { nowSeconds: DEADLINE - 240 }, "deadline_window"],
    ["a ceiling below six hours", () => {}, { linkTtlMax: 3_600 }, "deadline_window"],
  ])("%s is refused, and no text is given to copy", (_name, bend, over, problem) => {
    const gate = pasteCopyGate(served(bend), gateCtx(over));
    expect(gate).toEqual({ ok: false, problem });
    expect("text" in gate).toBe(false);
  });

  test("an answer that is not a link is refused, never a throw", () => {
    expect(pasteCopyGate(null as unknown as LinkMessageResult, gateCtx()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// One click on "Send the signature"
// ---------------------------------------------------------------------------------------------

describe("pasteSubmitPlan", () => {
  test("a signature that parses, with time left, is sent normalised", () => {
    expect(
      pasteSubmitPlan({ served: served(), raw: `  ${upper(SIG_65)}\n`, nowSeconds: CHAIN_NOW }),
    ).toEqual({ kind: "send", signature: SIG_65 });
  });

  test.each([
    ["empty", ""],
    ["not_hex", "0xzz"],
    ["odd_length", "0xabc"],
    ["too_long", `0x${"ab".repeat(2_049)}`],
  ])("a %s problem never reaches the door", (problem, raw) => {
    expect(pasteSubmitPlan({ served: served(), raw, nowSeconds: CHAIN_NOW })).toEqual({
      kind: "problem",
      problem,
    });
  });

  test("with less than five minutes left by this clock, nothing is sent: a new link is needed", () => {
    expect(pasteSubmitPlan({ served: served(), raw: SIG_65, nowSeconds: DEADLINE - 299 })).toEqual(
      { kind: "stale" },
    );
    expect(pasteSubmitPlan({ served: served(), raw: SIG_65, nowSeconds: DEADLINE - 300 }).kind).toBe(
      "send",
    );
  });

  test("a stale link is said before a field problem: fixing the field would not help", () => {
    expect(pasteSubmitPlan({ served: served(), raw: "0xzz", nowSeconds: DEADLINE + 1 })).toEqual({
      kind: "stale",
    });
  });

  test("a clock that cannot be read never sends", () => {
    expect(pasteSubmitPlan({ served: served(), raw: SIG_65, nowSeconds: Number.NaN })).toEqual({
      kind: "stale",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The doors' answers on this branch
// ---------------------------------------------------------------------------------------------

describe("pasteErrorOutcome", () => {
  test.each(["malformed_signature", "malformed_link"])(
    "%s from the link door is what was pasted, with the door's sentence",
    (code) => {
      expect(pasteErrorOutcome(apiError(400, code), "submit")).toEqual({
        kind: "pasted_not_hex",
        sentence: `the sentence of ${code}`,
      });
    },
  );

  test.each<[string, number, LinkStepOutcome]>([
    ["order_closed", 409, { kind: "back", to: "agreement", sentence: "the sentence of order_closed" }],
    ["company_not_eligible", 409, { kind: "back", to: "company", sentence: "the sentence of company_not_eligible" }],
    ["identity_not_found", 422, { kind: "back", to: "identity", sentence: "the sentence of identity_not_found" }],
    ["rate_limited", 429, { kind: "wait", sentence: "the sentence of rate_limited" }],
    ["chain_unavailable", 503, { kind: "retry", sentence: "the sentence of chain_unavailable" }],
    ["link_already_used", 409, { kind: "new_message", sentence: "the sentence of link_already_used" }],
    ["invalid_link_ttl", 400, { kind: "sentence", sentence: "the sentence of invalid_link_ttl" }],
  ])("%s is routed as on the other branch", (code, status, expected) => {
    expect(pasteErrorOutcome(apiError(status, code), "submit")).toEqual(expected);
  });

  test("a timeout or a failure that is not the API's is no answer from that door", () => {
    expect(pasteErrorOutcome(new ApiError(0, { code: TIMEOUT_CODE, message: TIMEOUT_MESSAGE }), "submit")).toEqual({
      kind: "no_answer",
      door: "submit",
    });
    expect(pasteErrorOutcome(new TypeError("offline"), "message")).toEqual({
      kind: "no_answer",
      door: "message",
    });
  });
});

describe("pasteOutcomeView", () => {
  const refused = (code: string, lapsed = false): PasteOutcome => ({
    kind: "refused",
    code,
    sentence: `the sentence of ${code}`,
    lapsed,
  });

  test.each(["bad_signature", "unsupported_signer", "guardian_mismatch", "create_would_revert"])(
    "a refused %s keeps the draft: the sentence as served, the link and the field kept",
    (code) => {
      expect(pasteOutcomeView(refused(code), viewConfig)).toEqual({
        lines: [`the sentence of ${code}`],
        fieldError: null,
        dropLink: false,
        newOrder: false,
        sendBack: null,
      });
    },
  );

  test.each(["deadline_out_of_window", "already_created"])(
    "a refused %s needs a fresh link message: the link is dropped",
    (code) => {
      const view = pasteOutcomeView(refused(code), viewConfig);
      expect(view.lines).toEqual([`the sentence of ${code}`]);
      expect(view.dropLink).toBe(true);
      expect(view.newOrder).toBe(false);
    },
  );

  test("agent_in_flight keeps everything and says the same signature can be sent in a moment", () => {
    expect(pasteOutcomeView(refused("agent_in_flight"), viewConfig)).toEqual({
      lines: ["the sentence of agent_in_flight", P.tryAgainSoon],
      fieldError: null,
      dropLink: false,
      newOrder: false,
      sendBack: null,
    });
    expect(P.tryAgainSoon).not.toContain("with Sign");
  });

  test("a lapsed order: the sentence, the way out, and the sentence carried to its closed screen", () => {
    expect(pasteOutcomeView(refused("deadline_out_of_window", true), viewConfig)).toEqual({
      lines: ["the sentence of deadline_out_of_window"],
      fieldError: null,
      dropLink: true,
      newOrder: true,
      sendBack: { to: "closed", sentence: "the sentence of deadline_out_of_window" },
    });
  });

  test("what was pasted, refused by the door, is said under the field with the door's sentence", () => {
    expect(
      pasteOutcomeView({ kind: "pasted_not_hex", sentence: "the door's own words" }, viewConfig),
    ).toEqual({
      lines: [],
      fieldError: "the door's own words",
      dropLink: false,
      newOrder: false,
      sendBack: null,
    });
  });

  test.each(["empty", "not_hex", "odd_length", "too_long"] as const)(
    "the field's own %s problem is said under it, and the draft stays",
    (problem) => {
      const view = pasteOutcomeView({ kind: "problem", problem }, viewConfig);
      expect(view.fieldError).toBe(P.problems[problem]);
      expect(view.lines).toEqual([]);
      expect(view.dropLink).toBe(false);
    },
  );

  test("a stale link drops it and says a new one is needed", () => {
    expect(pasteOutcomeView({ kind: "stale" }, viewConfig)).toMatchObject({
      lines: [P.stale],
      dropLink: true,
      newOrder: false,
    });
  });

  test("a link the gate refused is a stop with its problem word, and nothing is shown to copy", () => {
    expect(pasteOutcomeView({ kind: "stop", problem: "agent_id" }, viewConfig)).toMatchObject({
      lines: [fillCopy(P.refused, { problem: "agent_id" })],
      dropLink: true,
    });
    expect(P.refused).not.toContain("wallet was not opened");
  });

  test("a deployment whose ceiling is under six hours says so", () => {
    expect(pasteOutcomeView({ kind: "stop", problem: "ttl_above_max" }, viewConfig).lines).toEqual([
      P.ttlAboveMax,
    ]);
  });

  test("an answer that is not this order keeps everything and says to send again", () => {
    expect(pasteOutcomeView({ kind: "unreadable" }, viewConfig)).toMatchObject({
      lines: [P.unreadableAnswer],
      dropLink: false,
    });
  });

  test("a door that sends the person back carries its sentence there and drops the link", () => {
    const back: PasteOutcome = { kind: "back", to: "company", sentence: "s" };
    expect(pasteOutcomeView(back, viewConfig)).toEqual({
      lines: ["s"],
      fieldError: null,
      dropLink: true,
      newOrder: false,
      sendBack: { to: "company", sentence: "s" },
    });
  });

  test.each<[string, PasteOutcome, boolean]>([
    ["a limit", { kind: "wait", sentence: "s" }, false],
    ["nothing changed", { kind: "retry", sentence: "s" }, false],
    ["any other house refusal", { kind: "sentence", sentence: "s" }, false],
    ["a used link", { kind: "new_message", sentence: "s" }, true],
  ])("%s shows the door's sentence as served", (_name, outcome, drop) => {
    const view = pasteOutcomeView(outcome, viewConfig);
    expect(view.lines).toEqual(["s"]);
    expect(view.dropLink).toBe(drop);
  });

  test("no answer: the same sentences as the other branch, and the link kept", () => {
    const submit: PasteOutcome = { kind: "no_answer", door: "submit" };
    expect(pasteOutcomeView(submit, viewConfig).lines).toEqual(
      linkOutcomeView(submit, viewConfig).lines,
    );
    expect(pasteOutcomeView(submit, viewConfig).dropLink).toBe(false);
    expect(pasteOutcomeView({ kind: "no_answer", door: "message" }, viewConfig).lines).toEqual([
      L.noAnswerMessage,
    ]);
  });

  test("the order as it now stands: nothing to say", () => {
    expect(pasteOutcomeView({ kind: "rederive" }, viewConfig)).toEqual({
      lines: [],
      fieldError: null,
      dropLink: false,
      newOrder: false,
      sendBack: null,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The call to send
// ---------------------------------------------------------------------------------------------

describe("pointerCallText", () => {
  test("the live order's facts: the registry, the three arguments, and setMetadata's calldata", () => {
    const call = pointerCallText(callConfig, deployed());
    expect(call).toEqual({
      to: REGISTRY,
      signature: "setMetadata(uint256,string,bytes)",
      args: [LIVE_AGENT, "legalBody", LIVE_POINTER],
      calldata: encodeFunctionData({
        abi: identityRegistryAbi,
        functionName: "setMetadata",
        args: [BigInt(LIVE_AGENT), "legalBody", LIVE_POINTER],
      }),
    });
    const { calldata } = call as PointerCallText;
    expect(calldata.slice(0, 10)).toBe("0x466648da");
  });

  test("the arguments shown are the ones the calldata carries", () => {
    const { calldata, args } = pointerCallText(callConfig, deployed()) as PointerCallText;
    const decoded = decodeFunctionData({ abi: identityRegistryAbi, data: calldata });
    expect(decoded.functionName).toBe("setMetadata");
    expect(decoded.args).toEqual([BigInt(args[0]), args[1], args[2]]);
  });

  test("the value is 96 bytes", () => {
    const { args } = pointerCallText(callConfig, deployed()) as PointerCallText;
    expect((args[2].length - 2) / 2).toBe(96);
  });

  test("a body whose pointer was cleared gets the same call", () => {
    expect(
      pointerCallText(callConfig, deployed({ state: "broken", brokenReason: "not_linked" })),
    ).toEqual(pointerCallText(callConfig, deployed()));
  });

  test("a replaced order is refused: pointing back at it would break its replacement", () => {
    expect(
      pointerCallText(callConfig, deployed({ state: "broken", brokenReason: "replaced" })),
    ).toEqual({ ok: false, problem: "order_not_pointable" });
  });

  test.each<[string, Partial<LegalBodyOrderView>, string]>([
    ["superseded", { state: "superseded" }, "order_not_pointable"],
    ["revoked", { revoked: true }, "order_not_pointable"],
    ["still a draft", { state: "draft" }, "order_not_pointable"],
    ["with no body", { bodyAddress: null }, "order_has_no_body"],
    ["with no identity", { agentId: null }, "order_has_no_body"],
    ["on another factory", { factory: ANOTHER_FACTORY }, "order_on_another_deployment"],
    ["on another chain", { chainId: 5042 }, "order_on_another_deployment"],
  ])("an order %s is refused", (_name, over, problem) => {
    expect(pointerCallText(callConfig, deployed(over))).toEqual({ ok: false, problem });
  });
});

describe("pointerCallRows", () => {
  test("from the owner key, to the registry, the call, its arguments, and no value", () => {
    const call = pointerCallText(callConfig, deployed()) as PointerCallText;
    const rows = pointerCallRows(call, { owner: OWNER, body: LIVE_BODY, chainId: CHAIN });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      [P.rows.from, OWNER],
      [P.rows.to, REGISTRY],
      [P.rows.function, "setMetadata(uint256,string,bytes)"],
      [P.rows.agentId, LIVE_AGENT],
      [P.rows.key, "legalBody"],
      [P.rows.value, LIVE_POINTER],
      [P.rows.nativeValue, "0"],
    ]);
    const value = rows.find((r) => r.label === P.rows.value);
    expect(value?.note).toBe(fillCopy(P.notes.value, { chainId: String(CHAIN), body: LIVE_BODY }));
  });
});

// ---------------------------------------------------------------------------------------------
// The chain checks before the call is shown
// ---------------------------------------------------------------------------------------------

const ok = (data: unknown): ChainRead => ({ status: "success", data });
const pending: ChainRead = { status: "pending" };
const failed = (error: unknown): ChainRead => ({ status: "error", error });
/** A revert as viem names it. */
const revert = Object.assign(new Error("reverted"), { name: "ContractFunctionRevertedError" });

describe("pointerChecksOf", () => {
  test("three reads that answered", () => {
    expect(
      pointerChecksOf({ factoryPointer: ok(LIVE_POINTER), ownerOf: ok(OWNER), ownerAtCreation: ok(OWNER) }),
    ).toEqual({ factoryPointer: LIVE_POINTER, ownerOf: OWNER, ownerAtCreation: OWNER });
  });

  test("a read still on its way is null", () => {
    expect(
      pointerChecksOf({ factoryPointer: pending, ownerOf: pending, ownerAtCreation: pending }),
    ).toEqual({ factoryPointer: null, ownerOf: null, ownerAtCreation: null });
  });

  test("ownerOf reverting means no identity with this id; another failure is unreadable", () => {
    expect(pointerChecksOf({ factoryPointer: ok(LIVE_POINTER), ownerOf: failed(revert), ownerAtCreation: ok(OWNER) }).ownerOf).toBe("none");
    expect(pointerChecksOf({ factoryPointer: ok(LIVE_POINTER), ownerOf: failed(new Error("offline")), ownerAtCreation: ok(OWNER) }).ownerOf).toBe("unreadable");
    expect(pointerChecksOf({ factoryPointer: ok(LIVE_POINTER), ownerOf: ok(ZERO_ADDRESS), ownerAtCreation: ok(OWNER) }).ownerOf).toBe("none");
  });

  test("an answer of the wrong shape is unreadable, never trusted", () => {
    expect(
      pointerChecksOf({ factoryPointer: ok(42), ownerOf: ok("0x1234"), ownerAtCreation: ok(null) }),
    ).toEqual({ factoryPointer: "unreadable", ownerOf: "unreadable", ownerAtCreation: "unreadable" });
    expect(
      pointerChecksOf({ factoryPointer: failed(new Error("x")), ownerOf: ok(OWNER), ownerAtCreation: failed(revert) }),
    ).toEqual({ factoryPointer: "unreadable", ownerOf: OWNER, ownerAtCreation: "unreadable" });
  });
});

describe("pastePointerState", () => {
  const call = () => pointerCallText(callConfig, deployed());
  const checks = (over: Partial<PointerChecks> = {}): PointerChecks => ({
    factoryPointer: LIVE_POINTER,
    ownerOf: OWNER,
    ownerAtCreation: OWNER,
    ...over,
  });

  test("every check passed: the call, from the order's owner", () => {
    expect(pastePointerState({ call: call(), identityOwner: OWNER, checks: checks() })).toEqual({
      kind: "ready",
      call: call(),
      owner: OWNER,
    });
  });

  test("addresses and the pointer in another case still pass", () => {
    const state = pastePointerState({
      call: call(),
      identityOwner: OWNER.toLowerCase() as Address,
      checks: checks({ factoryPointer: upper(LIVE_POINTER) as Hex, ownerOf: upper(OWNER) as Address }),
    });
    expect(state.kind).toBe("ready");
  });

  test("the factory encoding another value is a stop", () => {
    const other = `${LIVE_POINTER.slice(0, -2)}ef` as Hex;
    expect(
      pastePointerState({ call: call(), identityOwner: OWNER, checks: checks({ factoryPointer: other }) }),
    ).toEqual({ kind: "pointer_mismatch" });
  });

  test("the identity moved since the link: no call", () => {
    expect(
      pastePointerState({ call: call(), identityOwner: OWNER, checks: checks({ ownerOf: THIRD }) }),
    ).toEqual({ kind: "moved", reason: "identity_moved" });
    expect(
      pastePointerState({ call: call(), identityOwner: OWNER, checks: checks({ ownerAtCreation: THIRD }) }),
    ).toEqual({ kind: "moved", reason: "identity_moved" });
    expect(
      pastePointerState({ call: call(), identityOwner: THIRD, checks: checks() }),
    ).toEqual({ kind: "moved", reason: "identity_moved" });
  });

  test("no identity with this id any more: no call", () => {
    expect(
      pastePointerState({ call: call(), identityOwner: OWNER, checks: checks({ ownerOf: "none" }) }),
    ).toEqual({ kind: "moved", reason: "no_identity" });
  });

  test("the guardian's wallet counts for nothing on this branch: an identity it now owns has moved", () => {
    // The order recorded another key as the owner; the guardian holding the identity now is a move,
    // and the call is not shown for it.
    expect(
      pastePointerState({
        call: call(),
        identityOwner: OWNER,
        checks: checks({ ownerOf: GUARDIAN, ownerAtCreation: OWNER }),
      }),
    ).toEqual({ kind: "moved", reason: "identity_moved" });
  });

  test("a refused call is a stop before any read counts", () => {
    const replaced = pointerCallText(callConfig, deployed({ state: "broken", brokenReason: "replaced" }));
    expect(pastePointerState({ call: replaced, identityOwner: OWNER, checks: checks() })).toEqual({
      kind: "refused",
      problem: "order_not_pointable",
    });
  });

  test("an order with no owner recorded is a stop", () => {
    expect(pastePointerState({ call: call(), identityOwner: null, checks: checks() })).toEqual({
      kind: "refused",
      problem: "no_identity_owner",
    });
  });

  test("a read on its way: loading; one that failed: unreadable", () => {
    expect(
      pastePointerState({ call: call(), identityOwner: OWNER, checks: checks({ ownerAtCreation: null }) }),
    ).toEqual({ kind: "loading" });
    expect(
      pastePointerState({ call: call(), identityOwner: OWNER, checks: checks({ factoryPointer: "unreadable" }) }),
    ).toEqual({ kind: "unreadable" });
    expect(
      pastePointerState({ call: call(), identityOwner: OWNER, checks: checks({ ownerOf: "unreadable" }) }),
    ).toEqual({ kind: "unreadable" });
  });
});

describe("pointerScreen", () => {
  test.each<[string, LegalBodyDerivation, "browser" | "paste"]>([
    ["the owner is this wallet", { phase: "pointer", branch: "browser" }, "browser"],
    ["the owner is another key", { phase: "pointer", branch: "paste" }, "paste"],
    ["no branch: never this browser's wallet", { phase: "pointer" }, "paste"],
  ])("%s", (_name, derivation, screen) => {
    expect(pointerScreen(derivation)).toBe(screen);
  });
});

// ---------------------------------------------------------------------------------------------
// The timed watch of the pointer: reads only
// ---------------------------------------------------------------------------------------------

describe("pointerSeen", () => {
  test("the identity's pointer is this body's, in any case", () => {
    expect(pointerSeen(LIVE_POINTER, LIVE_POINTER)).toBe(true);
    expect(pointerSeen(upper(LIVE_POINTER), LIVE_POINTER)).toBe(true);
  });

  test("no pointer, another value or an unreadable answer is not seen", () => {
    expect(pointerSeen("0x", LIVE_POINTER)).toBe(false);
    expect(pointerSeen(`${LIVE_POINTER.slice(0, -2)}ef`, LIVE_POINTER)).toBe(false);
    expect(pointerSeen(undefined, LIVE_POINTER)).toBe(false);
    expect(pointerSeen(42, LIVE_POINTER)).toBe(false);
  });
});

describe("pointerWatchInterval", () => {
  const START = 1_000_000;

  test("every 30 s for two minutes", () => {
    expect(POINTER_WATCH_MS).toBe(30_000);
    expect(POINTER_WATCH_WINDOW_MS).toBe(120_000);
    for (const at of [0, 30_000, 60_000, 90_000, 119_999])
      expect(pointerWatchInterval({ startedAtMs: START, nowMs: START + at, sent: false, seen: false })).toBe(30_000);
  });

  test("then it stops", () => {
    expect(pointerWatchInterval({ startedAtMs: START, nowMs: START + 120_000, sent: false, seen: false })).toBe(false);
  });

  test("it stops once I sent it is clicked, and once the pointer is seen", () => {
    expect(pointerWatchInterval({ startedAtMs: START, nowMs: START, sent: true, seen: false })).toBe(false);
    expect(pointerWatchInterval({ startedAtMs: START, nowMs: START, sent: false, seen: true })).toBe(false);
  });

  test("a clock that cannot be read stops it", () => {
    expect(pointerWatchInterval({ startedAtMs: START, nowMs: Number.NaN, sent: false, seen: false })).toBe(false);
  });
});

describe("pointerWatchStatus", () => {
  const START = 1_000_000;

  test("watching until two minutes of reads, then ended; seen whenever the pointer is there", () => {
    expect(pointerWatchStatus({ startedAtMs: START, lastReadAtMs: 0, seen: false })).toBe("watching");
    expect(pointerWatchStatus({ startedAtMs: START, lastReadAtMs: START + 90_000, seen: false })).toBe("watching");
    expect(pointerWatchStatus({ startedAtMs: START, lastReadAtMs: START + 120_000, seen: false })).toBe("ended");
    expect(pointerWatchStatus({ startedAtMs: START, lastReadAtMs: START + 120_000, seen: true })).toBe("seen");
    expect(pointerWatchStatus({ startedAtMs: START, lastReadAtMs: START, seen: true })).toBe("seen");
  });
});

describe("refreshErrorLine", () => {
  test("the door's sentence as served", () => {
    expect(refreshErrorLine(apiError(503, "chain_unavailable", "The chain could not be read."))).toBe(
      "The chain could not be read.",
    );
  });

  test("no answer otherwise", () => {
    expect(refreshErrorLine(new ApiError(0, { code: TIMEOUT_CODE, message: TIMEOUT_MESSAGE }))).toBe(
      P.refreshNoAnswer,
    );
    expect(refreshErrorLine(new TypeError("offline"))).toBe(P.refreshNoAnswer);
  });
});

// ---------------------------------------------------------------------------------------------
// The words of this branch
// ---------------------------------------------------------------------------------------------

describe("the words", () => {
  test("the signer note, word for word", () => {
    expect(fillCopy(P.signerNote, { agentId: LIVE_AGENT })).toBe(
      "sign this with the key that owns identity 897126, wherever it lives: your agent's signer, a hardware wallet, or circle wallet sign typed-data; a signer that takes whole typed data signs it as is; an ethers signer must drop types.EIP712Domain",
    );
  });

  test("the pointer's instruction and the click that ends the watch", () => {
    expect(P.sendFromOwner).toBe("send this from the owner key");
    expect(P.sent).toBe("I sent it");
  });

  test("the MCP note names the three tools and where the key is minted, and asks for none", () => {
    for (const name of ["get_link_message", "submit_link", "get_binding", "/agents/connect"])
      expect(P.mcp).toContain(name);
    expect(P.mcp).toContain("reaches further than one link");
  });

  /** Every string of this branch's copy. */
  const strings = (v: unknown): string[] =>
    typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

  test("no sentence is a command with arguments to paste in a shell", () => {
    for (const s of strings(P)) {
      expect(s).not.toMatch(/--[a-z]/);
      expect(s).not.toMatch(/\bcast\b|\bcurl\b|\bnpx\b|\$\(/);
    }
  });

  test("no sentence asks for an API key", () => {
    for (const s of strings(P))
      expect(s.toLowerCase()).not.toMatch(/(enter|paste|type) (your|an|the) api key/);
  });
});

describe("pasteWayOn: a stop no click here can lift offers a new order or a new company", () => {
  test.each([
    ["the call refused", { kind: "refused", problem: "order_not_pointable" }, true],
    ["the factory disagrees", { kind: "pointer_mismatch" }, true],
    ["the identity changed hands", { kind: "moved", reason: "identity_moved" }, true],
    ["no identity with this id any more", { kind: "moved", reason: "no_identity" }, true],
    ["loading", { kind: "loading" }, false],
    ["a read failed: Try again lifts it", { kind: "unreadable" }, false],
  ] as const)("%s", (_name, state, offered) => {
    expect(pasteWayOn(state)).toBe(offered);
  });

  test("the call shown is not a stop", () => {
    const call = pointerCallText(CONFIG_FOR_WAY_ON, deployed());
    if ("ok" in call) throw new Error("refused");
    expect(pasteWayOn({ kind: "ready", call, owner: OWNER })).toBe(false);
  });
});

const CONFIG_FOR_WAY_ON = { chainId: CHAIN, identityRegistry: REGISTRY, factory: FACTORY } as const;
