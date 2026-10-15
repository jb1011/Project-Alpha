/**
 * The browser branch's pointer step, its decisions each pure: the connected wallet owns the
 * identity, so it writes the one transaction that points the identity at its legal body.
 *
 * Here: the sentence that says what the wallet will write (`pointerSentence`); the gas line, in
 * Arc's native unit with its 18 decimals (`gasEstimateWei`, `gasLine`, `gasLines`); which screen
 * the step shows, in the order the checks run: the binding read, the allowlist, the value against
 * the factory's own encoding, then the identity's owner (`pointerStepState`,
 * `browserPointerChecks`, `browserPointerScreen`, with their sentences); what a send that did not
 * go through says (`pointerFailureLines`, `pointerRefusalSentence`); the receipt
 * (`pointerTxStage`, `pointerTxView`, `sendOffered`); the refresh's answers, a chain that could
 * not be read among them (`refreshAnswer`, `chainUnreadLine`, `bindingSettled`); the gas seed
 * (`seedOffered`, `gasSeedAnswer`, `gasSeedSuccess`); and the reads after the refresh plan ends
 * (`bindingWatchDelayMs`).
 *
 * The order and its binding are written out by hand for the live testnet deployment (chain
 * 5042002, its public registry and factory, agent 897126 and its body), with anvil's first
 * published account as the guardian, which owns the identity on this branch.
 */
import { InsufficientFundsError, formatUnits, type Hex } from "viem";
import { describe, expect, test, vi } from "vitest";
import { TIMEOUT_CODE, TIMEOUT_MESSAGE } from "@/lib/api/timeout";
import {
  ApiError,
  BINDING_STATES,
  type Address,
  type BindingState,
  type BindingView,
  type LegalBodyOrderView,
  type PointerIntent,
} from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { GAS_SEED_CODES, gasSeedOutcome } from "@/lib/legalBody/doorOutcome";
import type { PointerPreflight } from "@/lib/legalBody/flow";
import { registerSendFailure } from "@/lib/legalBody/identity";
import { noticeSentence } from "@/lib/legalBody/notice";
import { pointerCallText, type PointerCallText, type PointerChecks } from "@/lib/legalBody/paste";
import { stepLifetime, type Timers } from "@/lib/legalBody/lifetime";
import { REFRESH_RETRY_MS } from "@/lib/legalBody/polling";
import {
  BINDING_WATCH_MAX_MS,
  POINTER_RECEIPT_TIMEOUT_MS,
  bindingSettled,
  bindingWatchDelayMs,
  browserPointerChecks,
  browserPointerScreen,
  chainUnreadLine,
  gasBlocksSend,
  gasEstimateWei,
  gasLine,
  gasLines,
  gasSeedAnswer,
  gasSeedSuccess,
  intentMatchesCall,
  noIntentSentence,
  pointerFailureLines,
  pointerRefusalSentence,
  pointerSentence,
  pointerStepState,
  pointerTxStage,
  pointerTxView,
  preflightSentence,
  refreshAnswer,
  seedOffered,
  sendOffered,
} from "@/lib/legalBody/pointer";

const PT = LEGAL_BODY_COPY.pointer;
const P = LEGAL_BODY_COPY.paste;

/** The public testnet registry and factory, and the live test body (agent 897126). */
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const LIVE_BODY = "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE" as const;
const LIVE_AGENT = "897126";
const CHAIN = 5042002;
/** Anvil's first published account, as served (checksummed): the guardian, which owns the
 *  identity on this branch. */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
/** Anvil's second and third published accounts: another key, and an owner the identity moved to. */
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const THIRD = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const MANIFEST = `0x${"9c".repeat(32)}` as const;
const TX = `0x${"cd".repeat(32)}` as const;

/** The pointer for chain 5042002 (0x4cef52) and the live body, word by word. */
const LIVE_POINTER = ("0x" +
  "0".repeat(63) +
  "1" +
  "0".repeat(58) +
  "4cef52" +
  "0".repeat(24) +
  "5969b48ff7a3a4c6689366a9a6d7aa24b0c4b5ee") as Hex;

/** Wei, written as decimal digits: this target refuses a bigint literal. */
const wei = (digits: string) => BigInt(digits);
/** 10^16 wei: one hundredth of a native USDC. */
const CENT = wei("10000000000000000");

const lower = (a: string) => a.toLowerCase();
const upper = (a: string) => `0x${a.slice(2).toUpperCase()}`;

const config = {
  chainId: CHAIN,
  identityRegistry: REGISTRY,
  factory: FACTORY,
} as const;

/** The live order once its body was created, the identity owned by the guardian. */
const deployed = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_browser",
  publicId: "pub_browser",
  companyId: "co_test",
  state: "deployed",
  chainId: CHAIN,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: MANIFEST, version: 1 },
  agentId: LIVE_AGENT,
  identityOwner: GUARDIAN,
  bodyAddress: LIVE_BODY,
  linkDeadline: 1_791_003_600,
  createTxHash: `0x${"ab".repeat(32)}`,
  deployedAt: 1_791_000_060,
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

const INTENT: PointerIntent = {
  action: "setLegalBodyPointer",
  agentId: LIVE_AGENT,
  body: LIVE_BODY,
  chainId: CHAIN,
};

/** The binding as served for the live order: a pointer asked for. */
const binding = (over: Partial<BindingView> = {}): BindingView => ({
  state: "deployed",
  agentId: LIVE_AGENT,
  bodyAddress: LIVE_BODY,
  intent: INTENT,
  pointerSeenAt: null,
  nextCheckAt: 1_791_000_120_000,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  ...over,
});

/** The call the allowlist accepts for the live order. */
function liveCall(): PointerCallText {
  const call = pointerCallText(config, deployed());
  if ("ok" in call) throw new Error(`the live order's call was refused: ${call.problem}`);
  return call;
}

/** The three reads, all answered as the chain answers for the live order. */
const agreeing = (over: Partial<PointerChecks> = {}): PointerChecks => ({
  factoryPointer: LIVE_POINTER,
  ownerOf: GUARDIAN,
  ownerAtCreation: GUARDIAN,
  ...over,
});

const PENDING: PointerChecks = { factoryPointer: null, ownerOf: null, ownerAtCreation: null };

// ---------------------------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------------------------

describe("pointerSentence", () => {
  test("on sandbox: identity, body and Arc testnet, the only transaction, approving nothing", () => {
    expect(pointerSentence(INTENT, "sandbox")).toBe(
      `Your wallet will write a pointer from identity 897126 to body ${LIVE_BODY} on Arc testnet; this is the only transaction, and it approves nothing.`,
    );
  });

  test("on production: the same sentence on Arc", () => {
    expect(pointerSentence(INTENT, "production")).toBe(
      `Your wallet will write a pointer from identity 897126 to body ${LIVE_BODY} on Arc; this is the only transaction, and it approves nothing.`,
    );
  });

  test.each(["sandbox", "production"] as const)(
    "on %s it names the identity, the body and says it approves nothing",
    (environment) => {
      const s = pointerSentence(INTENT, environment);
      expect(s).toContain("identity 897126");
      expect(s).toContain(LIVE_BODY);
      expect(s).toContain("approves nothing");
      expect(s).not.toMatch(/\{[a-zA-Z]+\}/);
    },
  );

  test("the identity and body are the intent's own", () => {
    const s = pointerSentence({ ...INTENT, agentId: "42", body: THIRD }, "sandbox");
    expect(s).toContain("identity 42 ");
    expect(s).toContain(THIRD);
  });
});

// ---------------------------------------------------------------------------------------------
// The gas line
// ---------------------------------------------------------------------------------------------

describe("gasEstimateWei", () => {
  test("the gas the chain estimates times the fee per gas", () => {
    expect(gasEstimateWei({ gas: wei("50000"), maxFeePerGas: wei("200000000000") })).toBe(CENT);
  });

  test("either read missing gives no estimate", () => {
    expect(gasEstimateWei({ gas: null, maxFeePerGas: wei("1") })).toBeNull();
    expect(gasEstimateWei({ gas: wei("1"), maxFeePerGas: undefined })).toBeNull();
    expect(gasEstimateWei({ gas: undefined, maxFeePerGas: null })).toBeNull();
  });
});

describe("gasLine: Arc's native unit has 18 decimals", () => {
  test("10^16 wei reads 0.01, never the 6-decimal 10000000000", () => {
    const line = gasLine({ estimateWei: CENT, balanceWei: null });
    expect(line.amount).toBe("0.01");
    expect(line.amount).not.toBe(formatUnits(CENT, 6));
    expect(formatUnits(CENT, 6)).toBe("10000000000");
  });

  test("a balance of twice the estimate is enough", () => {
    expect(gasLine({ estimateWei: CENT, balanceWei: CENT * BigInt(2) })).toStrictEqual({
      amount: "0.01",
      balance: "0.02",
      enough: true,
    });
  });

  test("a balance of exactly the estimate is enough", () => {
    expect(gasLine({ estimateWei: CENT, balanceWei: CENT }).enough).toBe(true);
  });

  test("a balance below the estimate is not enough", () => {
    expect(gasLine({ estimateWei: CENT, balanceWei: CENT - BigInt(1) })).toStrictEqual({
      amount: "0.01",
      balance: "0.009999999999999999",
      enough: false,
    });
    expect(gasLine({ estimateWei: CENT, balanceWei: BigInt(0) })).toStrictEqual({
      amount: "0.01",
      balance: "0",
      enough: false,
    });
  });

  test("nulls give nulls", () => {
    expect(gasLine({ estimateWei: null, balanceWei: null })).toStrictEqual({
      amount: null,
      balance: null,
      enough: null,
    });
  });

  test("one side missing: what is known is shown, and enough is not known", () => {
    expect(gasLine({ estimateWei: CENT, balanceWei: null })).toStrictEqual({
      amount: "0.01",
      balance: null,
      enough: null,
    });
    expect(gasLine({ estimateWei: null, balanceWei: CENT })).toStrictEqual({
      amount: null,
      balance: "0.01",
      enough: null,
    });
  });
});

describe("gasLines", () => {
  test("sandbox: the estimate, the balance, and where testnet USDC comes from", () => {
    const view = gasLines({
      line: { amount: "0.01", balance: "0.02", enough: true },
      estimating: false,
      environment: "sandbox",
    });
    expect(view.lines).toStrictEqual([
      "Estimated gas: up to 0.01 USDC.",
      "This wallet holds 0.02 USDC.",
      "Your wallet needs a little native USDC on Arc testnet for gas; the Arc testnet faucet provides it.",
    ]);
    expect(view.tone).toBe("info");
  });

  test("production names Arc and no faucet", () => {
    const view = gasLines({
      line: { amount: "0.01", balance: "0.02", enough: true },
      estimating: false,
      environment: "production",
    });
    expect(view.lines.at(-1)).toBe(PT.gasProduction);
    expect(view.lines.join(" ")).not.toContain("faucet");
    expect(view.lines.join(" ")).not.toContain("testnet");
  });

  test("not enough: said in amber, before the faucet line", () => {
    const view = gasLines({
      line: { amount: "0.01", balance: "0", enough: false },
      estimating: false,
      environment: "sandbox",
    });
    expect(view.lines).toStrictEqual([
      fillCopy(PT.gasEstimate, { amount: "0.01" }),
      fillCopy(PT.gasBalance, { balance: "0" }),
      PT.notEnough,
      PT.gas,
    ]);
    expect(view.tone).toBe("warn");
  });

  test("while the estimate is on its way it says so, then that it could not be made", () => {
    const empty = { amount: null, balance: null, enough: null };
    expect(gasLines({ line: empty, estimating: true, environment: "sandbox" }).lines).toStrictEqual([
      PT.gasEstimating,
      PT.gas,
    ]);
    expect(gasLines({ line: empty, estimating: false, environment: "sandbox" }).lines).toStrictEqual([
      PT.gasUnread,
      PT.gas,
    ]);
  });

  test("no line is a template left half-filled", () => {
    const view = gasLines({
      line: { amount: "0.01", balance: "0.02", enough: false },
      estimating: false,
      environment: "sandbox",
    });
    for (const l of view.lines) expect(l).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});

// ---------------------------------------------------------------------------------------------
// Which screen, in the order the checks run
// ---------------------------------------------------------------------------------------------

describe("pointerStepState", () => {
  const OK: PointerPreflight = { ok: true };
  const MOVED: PointerPreflight = { ok: false, reason: "identity_moved" };
  const rows: [string, Parameters<typeof pointerStepState>[0], ReturnType<typeof pointerStepState>][] = [
    ["no binding yet", { binding: null, preflight: OK, pointerOk: true }, "loading"],
    ["no binding yet, whatever the reads say", { binding: null, preflight: MOVED, pointerOk: false }, "loading"],
    ["no intent", { binding: binding({ intent: null }), preflight: OK, pointerOk: true }, "no_intent"],
    [
      "no intent wins over a mismatch and a refusal",
      { binding: binding({ intent: null }), preflight: MOVED, pointerOk: false },
      "no_intent",
    ],
    ["the factory's encoding not read yet", { binding: binding(), preflight: OK, pointerOk: null }, "loading"],
    [
      "the factory's encoding not read yet, the owners refused: the order of the checks waits",
      { binding: binding(), preflight: MOVED, pointerOk: null },
      "loading",
    ],
    ["the pointer does not match", { binding: binding(), preflight: OK, pointerOk: false }, "pointer_mismatch"],
    [
      "a mismatch is said before the owners",
      { binding: binding(), preflight: MOVED, pointerOk: false },
      "pointer_mismatch",
    ],
    [
      "a mismatch with the owners not read yet",
      { binding: binding(), preflight: null, pointerOk: false },
      "pointer_mismatch",
    ],
    ["the owners not read yet", { binding: binding(), preflight: null, pointerOk: true }, "loading"],
    [
      "no identity",
      { binding: binding(), preflight: { ok: false, reason: "no_identity" }, pointerOk: true },
      "preflight_refused",
    ],
    ["the identity moved", { binding: binding(), preflight: MOVED, pointerOk: true }, "preflight_refused"],
    [
      "not this wallet",
      { binding: binding(), preflight: { ok: false, reason: "not_this_wallet" }, pointerOk: true },
      "preflight_refused",
    ],
    ["every check passed", { binding: binding(), preflight: OK, pointerOk: true }, "ready"],
    [
      "a broken body whose pointer was cleared, every check passed",
      { binding: binding({ state: "broken", brokenReason: "not_linked" }), preflight: OK, pointerOk: true },
      "ready",
    ],
  ];
  test.each(rows)("%s", (_name, input, expected) => {
    expect(pointerStepState(input)).toBe(expected);
  });
});

describe("browserPointerChecks: the three reads as the browser branch reads them", () => {
  const call = liveCall();
  const base = { call, identityOwner: GUARDIAN, connected: GUARDIAN as Address | null };

  test("nothing answered yet: nothing decided, nothing unreadable", () => {
    expect(browserPointerChecks({ ...base, checks: PENDING })).toStrictEqual({
      unreadable: false,
      pointerOk: null,
      preflight: null,
    });
  });

  test("everything agrees: the pointer matches and the preflight passes", () => {
    expect(browserPointerChecks({ ...base, checks: agreeing() })).toStrictEqual({
      unreadable: false,
      pointerOk: true,
      preflight: { ok: true },
    });
  });

  test("addresses and the pointer are compared in lower case", () => {
    const out = browserPointerChecks({
      ...base,
      identityOwner: upper(GUARDIAN) as Address,
      connected: lower(GUARDIAN) as Address,
      checks: agreeing({
        factoryPointer: upper(LIVE_POINTER) as Hex,
        ownerOf: lower(GUARDIAN) as Address,
        ownerAtCreation: upper(GUARDIAN) as Address,
      }),
    });
    expect(out).toStrictEqual({ unreadable: false, pointerOk: true, preflight: { ok: true } });
  });

  test("the factory encodes another value: the pointer does not match", () => {
    const another = `${LIVE_POINTER.slice(0, -40)}${"0".repeat(39)}1` as Hex;
    expect(browserPointerChecks({ ...base, checks: agreeing({ factoryPointer: another }) }).pointerOk).toBe(
      false,
    );
  });

  test("the factory's read alone answered: the pointer is decided, the owners are not", () => {
    expect(
      browserPointerChecks({ ...base, checks: { ...PENDING, factoryPointer: LIVE_POINTER } }),
    ).toStrictEqual({ unreadable: false, pointerOk: true, preflight: null });
  });

  test("one owner read answered: the preflight waits for both", () => {
    expect(
      browserPointerChecks({ ...base, checks: { ...PENDING, ownerOf: GUARDIAN } }).preflight,
    ).toBeNull();
  });

  test.each(["factoryPointer", "ownerOf", "ownerAtCreation"] as const)(
    "a %s read that failed is unreadable",
    (key) => {
      const out = browserPointerChecks({ ...base, checks: agreeing({ [key]: "unreadable" }) });
      expect(out.unreadable).toBe(true);
    },
  );

  test("ownerOf reverted: no identity", () => {
    expect(browserPointerChecks({ ...base, checks: agreeing({ ownerOf: "none" }) }).preflight).toStrictEqual({
      ok: false,
      reason: "no_identity",
    });
  });

  test("the identity moved since the link: refused", () => {
    expect(browserPointerChecks({ ...base, checks: agreeing({ ownerOf: THIRD }) }).preflight).toStrictEqual({
      ok: false,
      reason: "identity_moved",
    });
    expect(
      browserPointerChecks({ ...base, checks: agreeing({ ownerAtCreation: THIRD }) }).preflight,
    ).toStrictEqual({ ok: false, reason: "identity_moved" });
  });

  test("another wallet connected, or none: not this wallet", () => {
    expect(browserPointerChecks({ ...base, connected: OTHER, checks: agreeing() }).preflight).toStrictEqual({
      ok: false,
      reason: "not_this_wallet",
    });
    expect(browserPointerChecks({ ...base, connected: null, checks: agreeing() }).preflight).toStrictEqual({
      ok: false,
      reason: "not_this_wallet",
    });
  });
});

describe("intentMatchesCall: the sentence says what the call writes", () => {
  const call = liveCall();
  const order = deployed();

  test("the live intent matches the live call", () => {
    expect(intentMatchesCall(INTENT, call, order)).toBe(true);
  });

  test("the body is compared in lower case", () => {
    expect(intentMatchesCall({ ...INTENT, body: lower(LIVE_BODY) as Address }, call, order)).toBe(true);
  });

  test.each([
    ["another identity", { agentId: "897127" }],
    ["another body", { body: THIRD }],
    ["another chain", { chainId: 5042 }],
    ["another action", { action: "somethingElse" }],
  ])("%s does not match", (_name, over) => {
    expect(intentMatchesCall({ ...INTENT, ...over } as PointerIntent, call, order)).toBe(false);
  });
});

describe("browserPointerScreen: binding, allowlist, factory, owners, in that order", () => {
  const order = deployed();
  const call = liveCall();
  const base = {
    binding: binding() as BindingView | null,
    bindingFailed: false,
    order,
    call: call as PointerCallText | { ok: false; problem: string },
    connected: GUARDIAN as Address | null,
    checks: agreeing(),
    environment: "sandbox" as const,
  };

  test("everything agrees: ready, with the intent, the call and the owner", () => {
    expect(browserPointerScreen(base)).toStrictEqual({
      kind: "ready",
      intent: INTENT,
      call,
      owner: GUARDIAN,
    });
  });

  test("the binding on its way: loading; a binding that could not be read: say so", () => {
    expect(browserPointerScreen({ ...base, binding: null }).kind).toBe("loading");
    expect(browserPointerScreen({ ...base, binding: null, bindingFailed: true }).kind).toBe(
      "binding_unreadable",
    );
  });

  test("a binding already read stays the one used when a later read failed", () => {
    expect(browserPointerScreen({ ...base, bindingFailed: true }).kind).toBe("ready");
  });

  test("no intent: winding down or dissolved, with the notice's words, before anything else", () => {
    for (const reason of ["winding_down", "dissolved"] as const) {
      const screen = browserPointerScreen({
        ...base,
        binding: binding({ state: "broken", brokenReason: reason, intent: null }),
        call: { ok: false, problem: "order_not_pointable" },
        checks: PENDING,
      });
      const n = noticeSentence({ kind: reason }, "sandbox");
      expect(screen).toStrictEqual({ kind: "no_intent", title: n.title, body: n.body });
    }
  });

  test("a revoked order: the allowlist refuses it, so there is never a button", () => {
    const revoked = deployed({ revoked: true });
    const screen = browserPointerScreen({
      ...base,
      order: revoked,
      call: pointerCallText(config, revoked),
    });
    expect(screen).toStrictEqual({ kind: "refused", problem: "order_not_pointable" });
  });

  test("a replaced body: refused by the allowlist", () => {
    const replaced = deployed({ state: "broken", brokenReason: "replaced" });
    expect(
      browserPointerScreen({ ...base, order: replaced, call: pointerCallText(config, replaced) }),
    ).toStrictEqual({ kind: "refused", problem: "order_not_pointable" });
  });

  test("a refusal is said before any read counts", () => {
    expect(
      browserPointerScreen({ ...base, call: { ok: false, problem: "order_has_no_body" }, checks: PENDING }),
    ).toStrictEqual({ kind: "refused", problem: "order_has_no_body" });
  });

  test("an order with no identity owner is refused", () => {
    expect(browserPointerScreen({ ...base, order: deployed({ identityOwner: null }) })).toStrictEqual({
      kind: "refused",
      problem: "no_identity_owner",
    });
  });

  test("an intent that does not say what the call writes is refused", () => {
    expect(
      browserPointerScreen({ ...base, binding: binding({ intent: { ...INTENT, body: THIRD } }) }),
    ).toStrictEqual({ kind: "refused", problem: "intent_mismatch" });
  });

  test("a known mismatch is said before a read that failed: the order of the checks", () => {
    const another = `${LIVE_POINTER.slice(0, -2)}ff` as Hex;
    expect(
      browserPointerScreen({
        ...base,
        checks: agreeing({ factoryPointer: another, ownerOf: "unreadable" }),
      }),
    ).toStrictEqual({ kind: "pointer_mismatch" });
    expect(
      browserPointerScreen({ ...base, checks: agreeing({ factoryPointer: "unreadable", ownerOf: THIRD }) }),
    ).toStrictEqual({ kind: "unreadable" });
  });

  test("a read that failed: unreadable, with nothing to send", () => {
    expect(browserPointerScreen({ ...base, checks: agreeing({ ownerAtCreation: "unreadable" }) }).kind).toBe(
      "unreadable",
    );
  });

  test("reads on their way: loading", () => {
    expect(browserPointerScreen({ ...base, checks: PENDING }).kind).toBe("loading");
  });

  test("the factory encodes another value: a stop", () => {
    const another = `${LIVE_POINTER.slice(0, -2)}ff` as Hex;
    expect(browserPointerScreen({ ...base, checks: agreeing({ factoryPointer: another }) })).toStrictEqual({
      kind: "pointer_mismatch",
    });
  });

  test("the owners refuse: the reason, and nothing to send", () => {
    expect(browserPointerScreen({ ...base, checks: agreeing({ ownerOf: THIRD }) })).toStrictEqual({
      kind: "preflight_refused",
      reason: "identity_moved",
    });
    expect(browserPointerScreen({ ...base, connected: OTHER })).toStrictEqual({
      kind: "preflight_refused",
      reason: "not_this_wallet",
    });
  });
});

describe("the step's sentences", () => {
  test("no intent: the winding-down and dissolved notices; otherwise none is asked for", () => {
    expect(noIntentSentence("winding_down", "sandbox")).toStrictEqual({
      title: noticeSentence({ kind: "winding_down" }, "sandbox").title,
      body: noticeSentence({ kind: "winding_down" }, "sandbox").body,
    });
    expect(noIntentSentence("dissolved", "production").body).toBe(
      "The body reports that it is dissolved, so no pointer is offered for it.",
    );
    for (const reason of [null, "not_linked", "replaced"] as const)
      expect(noIntentSentence(reason, "sandbox")).toStrictEqual(PT.noIntent);
  });

  test("the identity changed hands: the design's sentence, word for word", () => {
    expect(preflightSentence("identity_moved", { agentId: LIVE_AGENT, owner: GUARDIAN })).toBe(
      "The identity changed hands since the link; its current owner needs a new link, which makes a new body.",
    );
  });

  test("no identity: the registry has none with this id", () => {
    expect(preflightSentence("no_identity", { agentId: LIVE_AGENT, owner: GUARDIAN })).toBe(
      fillCopy(P.noIdentity, { agentId: LIVE_AGENT }),
    );
  });

  test("not this wallet: names the identity and its owner", () => {
    const s = preflightSentence("not_this_wallet", { agentId: LIVE_AGENT, owner: GUARDIAN });
    expect(s).toBe(fillCopy(PT.notThisWallet, { agentId: LIVE_AGENT, owner: GUARDIAN }));
    expect(s).toContain(LIVE_AGENT);
    expect(s).toContain(GUARDIAN);
  });

  test("a mismatch: the factory sentence inside the stop", () => {
    expect(fillCopy(PT.stop, { reason: PT.factoryMismatch })).toBe(
      "Your wallet is not asked to send the pointer: the pointer could not be checked against the factory.",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// A send that did not go through
// ---------------------------------------------------------------------------------------------

describe("pointerFailureLines", () => {
  test("the wallet said no, with its own words", () => {
    const f = registerSendFailure({ code: 4001, message: "User rejected the request." });
    expect(pointerFailureLines(f, "sandbox")).toStrictEqual([
      "Your wallet did not send the pointer, so nothing was written. It said: User rejected the request.",
    ]);
  });

  test("the wallet said no, without words", () => {
    expect(pointerFailureLines({ kind: "rejected", message: null }, "sandbox")).toStrictEqual([PT.rejectedNoWords]);
  });

  test("any other failure: the wallet can sign but cannot send, the plain sentence", () => {
    const f = registerSendFailure(new Error("method not supported"));
    expect(f).toStrictEqual({ kind: "cannot_send" });
    expect(pointerFailureLines(f, "sandbox")).toStrictEqual([
      "Your wallet can sign but it cannot send a transaction on Arc, so it cannot write the pointer. The identity's owner must be a key that can send, or its sponsor must pay.",
    ]);
  });
});

describe("too little gas for the pointer", () => {
  test.each([
    ["sandbox", PT.gas],
    ["production", PT.gasProduction],
  ] as const)("a send viem refuses for its funds on %s: the gas sentence, never the cannot-send one", (environment, sentence) => {
    const f = registerSendFailure({ name: "TransactionExecutionError", cause: new InsufficientFundsError() });
    expect(f).toStrictEqual({ kind: "no_gas" });
    expect(pointerFailureLines(f, environment)).toStrictEqual([sentence]);
    expect(pointerFailureLines(f, environment)).not.toContain(PT.cannotSend);
  });

  test.each<[string, bigint | null, bigint | null, boolean]>([
    ["a balance known to be below the estimate", CENT, CENT - BigInt(1), true],
    ["a balance of exactly the estimate", CENT, CENT, false],
    ["a balance above the estimate", CENT, CENT * BigInt(2), false],
    ["no balance read", CENT, null, false],
    ["no estimate made", null, CENT, false],
    ["neither", null, null, false],
  ])("%s: the button is held back only on a shortfall that is known", (_name, estimateWei, balanceWei, blocked) => {
    expect(gasBlocksSend(gasLine({ estimateWei, balanceWei }))).toBe(blocked);
  });

  test("a shortfall that is known says so, and where the native USDC comes from", () => {
    const line = gasLine({ estimateWei: CENT, balanceWei: CENT - BigInt(1) });
    const view = gasLines({ line, estimating: false, environment: "sandbox" });
    expect(view.tone).toBe("warn");
    expect(view.lines).toContain(PT.notEnough);
    expect(view.lines).toContain(PT.gas);
  });
});

describe("pointerRefusalSentence", () => {
  test("a wallet on another network: switch it there, nothing was sent", () => {
    expect(pointerRefusalSentence("wallet_on_another_chain", "sandbox")).toBe(
      fillCopy(PT.otherNetwork, { network: "Arc testnet" }),
    );
    expect(pointerRefusalSentence("wallet_on_another_chain", "production")).toBe(
      fillCopy(PT.otherNetwork, { network: "Arc" }),
    );
  });

  test("a chain this site does not send to", () => {
    expect(pointerRefusalSentence("chain_not_configured", "sandbox")).toBe(
      fillCopy(PT.otherChain, { network: "Arc testnet" }),
    );
  });

  test("any other refusal names its problem", () => {
    expect(pointerRefusalSentence("order_not_pointable", "sandbox")).toBe(
      fillCopy(PT.refusedBeforeWallet, { problem: "order_not_pointable" }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------------------------

describe("the receipt", () => {
  test("the step waits three minutes for it", () => {
    expect(POINTER_RECEIPT_TIMEOUT_MS).toBe(180_000);
  });

  test("pointerTxStage: success confirmed, reverted reverted, none or unreadable not known", () => {
    expect(pointerTxStage({ status: "success" })).toBe("confirmed");
    expect(pointerTxStage({ status: "reverted" })).toBe("reverted");
    expect(pointerTxStage(null)).toBe("no_receipt");
    expect(pointerTxStage({})).toBe("no_receipt");
    expect(pointerTxStage({ status: "pending" })).toBe("no_receipt");
  });

  test("pointerTxView: one sentence per stage, in amber when it did not land", () => {
    expect(pointerTxView("waiting")).toStrictEqual({ text: PT.waiting, tone: "info" });
    expect(pointerTxView("confirmed")).toStrictEqual({ text: PT.confirmed, tone: "info" });
    expect(pointerTxView("reverted")).toStrictEqual({ text: PT.reverted, tone: "warn" });
    expect(pointerTxView("no_receipt")).toStrictEqual({ text: PT.noReceipt, tone: "warn" });
  });

  test.each([
    ["before any send", null, false, true],
    ["after a send that failed on the chain", "reverted", false, true],
    ["while the receipt is awaited", "waiting", false, false],
    ["once confirmed, even when the checks have stopped", "confirmed", false, false],
    ["once confirmed, while checked", "confirmed", true, false],
    ["with no receipt, while Novi Corpus is still asked to check", "no_receipt", true, false],
    ["with no receipt, once the checks stopped and the body is still not linked", "no_receipt", false, true],
  ] as const)("sendOffered %s: %s, checking %s -> %s", (_name, stage, checking, offered) => {
    expect(sendOffered(stage, checking)).toBe(offered);
  });
});

// ---------------------------------------------------------------------------------------------
// The refresh, and the reads after it
// ---------------------------------------------------------------------------------------------

describe("refreshAnswer", () => {
  test("503 chain_unavailable: the stored binding stays, the plan continues", () => {
    const e = new ApiError(503, {
      code: "chain_unavailable",
      message: "The chain could not be read just now, and nothing was changed: try again in a moment.",
    });
    expect(refreshAnswer(e)).toStrictEqual({ kind: "chain_unavailable" });
  });

  test("another refusal: the door's sentence as served", () => {
    const e = new ApiError(429, { code: "rate_limited", message: "Too many requests." });
    expect(refreshAnswer(e)).toStrictEqual({ kind: "line", line: "Too many requests." });
  });

  test("no answer: the no-answer sentence", () => {
    expect(refreshAnswer(new ApiError(0, { code: TIMEOUT_CODE, message: TIMEOUT_MESSAGE }))).toStrictEqual({
      kind: "line",
      line: P.refreshNoAnswer,
    });
    expect(refreshAnswer(new TypeError("Failed to fetch"))).toStrictEqual({
      kind: "line",
      line: P.refreshNoAnswer,
    });
  });
});

describe("chainUnreadLine", () => {
  test("says the chain could not be read, and the state as last read", () => {
    const s = chainUnreadLine("deployed");
    expect(s).toBe(
      "Novi Corpus could not read the chain just now, so this order stays as last read: deployed. The next check tries again.",
    );
    expect(s).toContain(PT.chainUnread);
  });
});

describe("bindingSettled", () => {
  test("only deployed and broken still wait for the pointer", () => {
    for (const state of BINDING_STATES)
      expect(bindingSettled(state)).toBe(state !== "deployed" && state !== "broken");
  });

  test("an answer with no state is not settled", () => {
    expect(bindingSettled(null)).toBe(false);
    expect(bindingSettled("something" as BindingState)).toBe(true);
  });
});

describe("bindingWatchDelayMs: reads of the binding after the plan ends", () => {
  test("every 30 seconds at first, then doubling, at most every 5 minutes", () => {
    expect([0, 1, 2, 3, 4, 5, 40].map(bindingWatchDelayMs)).toStrictEqual([
      REFRESH_RETRY_MS,
      60_000,
      120_000,
      240_000,
      BINDING_WATCH_MAX_MS,
      BINDING_WATCH_MAX_MS,
      BINDING_WATCH_MAX_MS,
    ]);
    expect(BINDING_WATCH_MAX_MS).toBe(300_000);
  });

  test("a count that cannot be read waits the first delay, never less", () => {
    expect(bindingWatchDelayMs(-1)).toBe(REFRESH_RETRY_MS);
    expect(bindingWatchDelayMs(Number.NaN)).toBe(REFRESH_RETRY_MS);
  });
});

// ---------------------------------------------------------------------------------------------
// The gas seed
// ---------------------------------------------------------------------------------------------

describe("seedOffered", () => {
  test("only where the deployment offers it", () => {
    expect(seedOffered({ gasSeedOffered: false, enough: false, final: false })).toBe(false);
    expect(seedOffered({ gasSeedOffered: true, enough: false, final: false })).toBe(true);
  });

  test("not once the balance is known to be enough", () => {
    expect(seedOffered({ gasSeedOffered: true, enough: true, final: false })).toBe(false);
    expect(seedOffered({ gasSeedOffered: true, enough: null, final: false })).toBe(true);
  });

  test("not after an answer that asking again cannot change", () => {
    expect(seedOffered({ gasSeedOffered: true, enough: false, final: true })).toBe(false);
  });
});

describe("gasSeedAnswer: routed by gasSeedOutcome, the door's sentence as served", () => {
  test.each([...GAS_SEED_CODES])("%s", (code) => {
    const e = new ApiError(409, { code, message: `the sentence for ${code}` });
    expect(gasSeedAnswer(e)).toStrictEqual({
      line: `the sentence for ${code}`,
      final: gasSeedOutcome(code).final,
    });
  });

  test("the answers after which asking again changes nothing are final", () => {
    const finals = GAS_SEED_CODES.filter(
      (code) => gasSeedAnswer(new ApiError(409, { code, message: "x" })).final,
    );
    expect(finals).toStrictEqual([
      "gas_seed_disabled",
      "gas_seed_used",
      "owner_pays_own_gas",
      "not_needed",
      "gas_seed_unconfirmed",
    ]);
  });

  test("an unknown code: its sentence, and the button again", () => {
    expect(gasSeedAnswer(new ApiError(400, { code: "brand_new", message: "Something new." }))).toStrictEqual({
      line: "Something new.",
      final: false,
    });
  });

  test("no answer: the no-answer sentence, and the button again", () => {
    expect(gasSeedAnswer(new ApiError(0, { code: TIMEOUT_CODE, message: TIMEOUT_MESSAGE }))).toStrictEqual({
      line: PT.seedNoAnswer,
      final: false,
    });
    expect(gasSeedAnswer(new Error("offline"))).toStrictEqual({ line: PT.seedNoAnswer, final: false });
  });
});

describe("gasSeedSuccess", () => {
  test("a sent seed: the sentence and its transaction", () => {
    expect(gasSeedSuccess({ status: "sent", txHash: TX })).toStrictEqual({ line: PT.seedSent, hash: TX });
  });

  test("an answer without a transaction hash: the sentence, and no link", () => {
    expect(gasSeedSuccess({ status: "sent" })).toStrictEqual({ line: PT.seedSent, hash: null });
    expect(gasSeedSuccess({ status: "sent", txHash: "0x1234" })).toStrictEqual({
      line: PT.seedSent,
      hash: null,
    });
    expect(gasSeedSuccess(null)).toStrictEqual({ line: PT.seedSent, hash: null });
  });
});

// ---------------------------------------------------------------------------------------------
// The step's lifetime: what a click starts goes on only while the step is on screen
// ---------------------------------------------------------------------------------------------

/** Timers that run only when told to, and can be told to forget a clear. */
function manualTimers(p: { clears: boolean } = { clears: true }) {
  const waiting = new Map<number, () => void>();
  let next = 1;
  const timers: Timers = {
    set: (run) => {
      const id = next;
      next += 1;
      waiting.set(id, run);
      return id;
    },
    clear: (handle) => {
      if (p.clears) waiting.delete(handle as number);
    },
  };
  /** Runs every timer still waiting, as if its time had come. */
  const fire = () => {
    const due = [...waiting];
    waiting.clear();
    for (const [, run] of due) run();
  };
  return { timers, fire, waiting: () => waiting.size };
}

describe("stepLifetime", () => {
  test("on screen from the start: a timer is set, and runs when its time comes", () => {
    const t = manualTimers();
    const life = stepLifetime(t.timers);
    let ran = 0;
    expect(life.alive()).toBe(true);
    expect(life.later(() => (ran += 1), REFRESH_RETRY_MS)).toBe(true);
    expect(t.waiting()).toBe(1);
    t.fire();
    expect(ran).toBe(1);
  });

  test("gone: every waiting timer is cleared, and nothing it held runs", () => {
    const t = manualTimers();
    const life = stepLifetime(t.timers);
    let ran = 0;
    life.later(() => (ran += 1), REFRESH_RETRY_MS);
    life.later(() => (ran += 1), BINDING_WATCH_MAX_MS);
    life.end();
    expect(life.alive()).toBe(false);
    expect(t.waiting()).toBe(0);
    t.fire();
    expect(ran).toBe(0);
  });

  test("gone: no timer is set any more, and the caller is told so", () => {
    const t = manualTimers();
    const life = stepLifetime(t.timers);
    life.end();
    let ran = 0;
    expect(life.later(() => (ran += 1), REFRESH_RETRY_MS)).toBe(false);
    expect(t.waiting()).toBe(0);
    t.fire();
    expect(ran).toBe(0);
  });

  test("a timer whose clear did not take still runs nothing once the step is gone", () => {
    const t = manualTimers({ clears: false });
    const life = stepLifetime(t.timers);
    let ran = 0;
    life.later(() => (ran += 1), REFRESH_RETRY_MS);
    life.end();
    t.fire();
    expect(ran).toBe(0);
  });

  test("on screen again after a simulated unmount (StrictMode): timers work again", () => {
    const t = manualTimers();
    const life = stepLifetime(t.timers);
    life.begin();
    life.end();
    life.begin();
    let ran = 0;
    expect(life.alive()).toBe(true);
    expect(life.later(() => (ran += 1), REFRESH_RETRY_MS)).toBe(true);
    t.fire();
    expect(ran).toBe(1);
  });

  test("a click's continuation stops after its await once the step is gone", async () => {
    // The shape the step's click follows: await the wallet, then go on only while on screen.
    const t = manualTimers();
    const life = stepLifetime(t.timers);
    const sent: string[] = [];
    let confirm: () => void = () => {};
    const wallet = new Promise<void>((resolve) => {
      confirm = resolve;
    });
    const click = (async () => {
      await wallet;
      if (!life.alive()) return;
      sent.push("refresh");
      life.later(() => sent.push("tick"), REFRESH_RETRY_MS);
    })();
    life.end();
    confirm();
    await click;
    t.fire();
    expect(sent).toStrictEqual([]);
    expect(t.waiting()).toBe(0);
  });

  test("by default it uses the browser's timers", () => {
    vi.useFakeTimers();
    try {
      const life = stepLifetime();
      let ran = 0;
      life.later(() => (ran += 1), REFRESH_RETRY_MS);
      vi.advanceTimersByTime(REFRESH_RETRY_MS - 1);
      expect(ran).toBe(0);
      vi.advanceTimersByTime(1);
      expect(ran).toBe(1);
      life.later(() => (ran += 1), REFRESH_RETRY_MS);
      life.end();
      vi.advanceTimersByTime(REFRESH_RETRY_MS);
      expect(ran).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
