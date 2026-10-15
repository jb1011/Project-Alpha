/**
 * The browser branch's pointer step, rendered as the server renders it, with every effect run at
 * once as the browser would run it.
 *
 * The button is offered only once the binding asks for a pointer, the allowlist accepts the call,
 * the factory encodes the same 96 bytes, and the identity's owner now and at creation is this
 * wallet. Every other answer is its sentence, with no button. Rendering, effects included, sends
 * nothing: no wallet request, no refresh, no gas seed. The only requests it makes on its own are
 * reads of the chain and of the binding. The wallet is reached through the one allowlist alone.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { Hex } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  allowedWrites: 0,
  refreshes: 0,
  seeds: 0,
  orderReads: 0,
  balanceReads: 0,
  writeHooks: 0,
  sendHooks: 0,
}));
type Read = { status: "pending" | "error" | "success"; data?: unknown; error?: unknown };
const chain = vi.hoisted(() => ({
  reads: {} as Record<string, Read>,
  asked: [] as { functionName: string; enabled: unknown }[],
  gas: { data: undefined as bigint | undefined, enabled: undefined as unknown },
  fees: { data: undefined as { maxFeePerGas: bigint } | undefined },
  balance: { data: undefined as { value: bigint } | undefined },
  connected: undefined as string | undefined,
}));
const api = vi.hoisted(() => ({
  binding: { data: undefined, isError: false } as { data: unknown; isError: boolean },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // As the browser would: an effect runs, here at once, so whatever it does shows in the spies.
    useEffect: (effect: () => void) => {
      effect();
    },
  };
});

vi.mock("@/lib/api/legalBodyHooks", () => ({
  useAllowedWrite: () => () => {
    calls.allowedWrites += 1;
    throw new Error("not in this test");
  },
  useRefreshBindingMutation: () => ({
    mutateAsync: async () => {
      calls.refreshes += 1;
      throw new Error("not in this test");
    },
  }),
  useGasSeedMutation: () => ({
    mutateAsync: async () => {
      calls.seeds += 1;
      throw new Error("not in this test");
    },
  }),
  useLegalBodyBindingQuery: () => ({ ...api.binding, refetch: async () => ({}) }),
  useLegalBodyOrderQuery: () => ({
    data: undefined,
    refetch: async () => {
      calls.orderReads += 1;
      return {};
    },
  }),
}));

vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useReadContract: (p: { functionName: string; query?: { enabled?: unknown } }) => {
    chain.asked.push({ functionName: p.functionName, enabled: p.query?.enabled });
    return { ...(chain.reads[p.functionName] ?? { status: "pending" }), refetch: async () => ({}) };
  },
  useEstimateGas: (p: { query?: { enabled?: unknown } }) => {
    chain.gas.enabled = p.query?.enabled;
    return { data: chain.gas.data, isLoading: false, refetch: async () => ({}) };
  },
  useEstimateFeesPerGas: () => ({ data: chain.fees.data, isLoading: false }),
  useBalance: () => ({
    data: chain.balance.data,
    isFetching: false,
    refetch: async () => {
      calls.balanceReads += 1;
      return {};
    },
  }),
  usePublicClient: () => ({}),
  useConnection: () => ({ address: chain.connected, chainId: 5042002 }),
  useWriteContract: () => {
    calls.writeHooks += 1;
    return { writeContractAsync: async () => "0x" };
  },
  useSendTransaction: () => {
    calls.sendHooks += 1;
    return { sendTransactionAsync: async () => "0x" };
  },
}));

import { PointerStep, type PointerStepKit } from "@/components/legalBody/PointerStep";
import type { BindingView, LegalBodyConfig, LegalBodyOrderView } from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { noticeSentence } from "@/lib/legalBody/notice";

const PT = LEGAL_BODY_COPY.pointer;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const LIVE_BODY = "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE" as const;
const LIVE_AGENT = "897126";
/** Anvil's first three published accounts: the guardian, which owns the identity here; another
 *  wallet; and a key the identity moved to. */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OTHER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const THIRD = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const LIVE_POINTER = ("0x" +
  "0".repeat(63) +
  "1" +
  "0".repeat(58) +
  "4cef52" +
  "0".repeat(24) +
  "5969b48ff7a3a4c6689366a9a6d7aa24b0c4b5ee") as Hex;
/** 10^16 wei: one hundredth of a native USDC. */
const CENT = BigInt("10000000000000000");

const config = (
  over: Partial<Extract<LegalBodyConfig, { available: true }>> = {},
): Extract<LegalBodyConfig, { available: true }> => ({
  available: true,
  declarations: true,
  statements: true,
  environment: "sandbox",
  chainId: 5042002,
  identityRegistry: REGISTRY,
  factory: FACTORY,
  gasSeedOffered: false,
  paymentRequired: false,
  linkTtl: { min: 600, max: 85_800, default: 3_600 },
  ...over,
});

const deployed = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_browser",
  publicId: "pub_browser",
  companyId: "co_test",
  state: "deployed",
  chainId: 5042002,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: `0x${"9c".repeat(32)}`, version: 1 },
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

const binding = (over: Partial<BindingView> = {}): BindingView => ({
  state: "deployed",
  agentId: LIVE_AGENT,
  bodyAddress: LIVE_BODY,
  intent: { action: "setLegalBodyPointer", agentId: LIVE_AGENT, body: LIVE_BODY, chainId: 5042002 },
  pointerSeenAt: null,
  nextCheckAt: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  ...over,
});

const kit = (o: LegalBodyOrderView | null, cfg = config()): PointerStepKit => ({
  config: cfg,
  order: o,
  routeSignIn: vi.fn(() => false),
});

const markup = (k: PointerStepKit) => renderToString(createElement(PointerStep, { kit: k }));

/** Whether the markup holds a button labelled exactly `label`. */
function hasButton(m: string, label: string): boolean {
  return [...m.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].some(
    ([, inner]) => inner.replace(/<[^>]*>/g, "").trim() === label,
  );
}

/** The `disabled` attribute itself, not the class names that style it. */
const DISABLED = /\sdisabled=""/;

/** The attributes of the button labelled exactly `label`, or null when there is none. */
function buttonAttributes(m: string, label: string): string | null {
  for (const [, attributes, inner] of m.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g))
    if (inner.replace(/<[^>]*>/g, "").trim() === label) return attributes;
  return null;
}

/** The text a person reads: the markup's tags dropped and its escapes undone. */
function text(m: string): string {
  return m
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** The binding asks for the pointer, the three reads agree with the order, this wallet is
 *  connected, and the gas reads answer: 0.01 to spend, 0.02 held. */
function everythingAgrees() {
  api.binding = { data: binding(), isError: false };
  chain.reads = {
    encodePointer: { status: "success", data: LIVE_POINTER },
    ownerOf: { status: "success", data: GUARDIAN },
    identityOwnerAtCreation: { status: "success", data: GUARDIAN },
  };
  chain.connected = GUARDIAN;
  chain.gas.data = BigInt(50_000);
  chain.fees.data = { maxFeePerGas: BigInt(200_000_000_000) };
  chain.balance.data = { value: CENT * BigInt(2) };
}

beforeEach(() => {
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;
  chain.reads = {};
  chain.asked = [];
  chain.gas = { data: undefined, enabled: undefined };
  chain.fees = { data: undefined };
  chain.balance = { data: undefined };
  chain.connected = undefined;
  api.binding = { data: undefined, isError: false };
});

describe("the pointer step", () => {
  test("every check passed: the sentence, the gas in 18 decimals, the facts, and the button", () => {
    everythingAgrees();
    const m = markup(kit(deployed()));
    const page = text(m);
    expect(page).toContain(PT.title);
    expect(page).toContain(
      `Your wallet will write a pointer from identity 897126 to body ${LIVE_BODY} on Arc testnet; this is the only transaction, and it approves nothing.`,
    );
    expect(page).toContain("Estimated gas: up to 0.01 USDC.");
    expect(page).toContain("This wallet holds 0.02 USDC.");
    expect(page).not.toContain("10000000000");
    expect(page).toContain(PT.gas);
    expect(page).toContain(PT.sevenDays);
    expect(page).toContain(LEGAL_BODY_COPY.wallet.neverApprove);
    expect(hasButton(m, PT.send)).toBe(true);
    expect(chain.gas.enabled).toBe(true);
  });

  test("rendering, effects included, sends nothing: no wallet request, no refresh, no seed", () => {
    everythingAgrees();
    markup(kit(deployed(), config({ gasSeedOffered: true })));
    expect(calls).toStrictEqual({
      allowedWrites: 0,
      refreshes: 0,
      seeds: 0,
      orderReads: 0,
      balanceReads: 0,
      writeHooks: 0,
      sendHooks: 0,
    });
  });

  test("on production: the network is Arc, and no faucet", () => {
    everythingAgrees();
    const page = text(markup(kit(deployed(), config({ environment: "production" }))));
    expect(page).toContain(`to body ${LIVE_BODY} on Arc; this is the only transaction`);
    expect(page).toContain(PT.gasProduction);
    expect(page).not.toContain("faucet");
  });

  test("the seed button only where the deployment offers it, and not when the balance covers it", () => {
    everythingAgrees();
    expect(hasButton(markup(kit(deployed())), PT.seed)).toBe(false);
    expect(hasButton(markup(kit(deployed(), config({ gasSeedOffered: true }))), PT.seed)).toBe(false);
    chain.balance.data = { value: BigInt(0) };
    const m = markup(kit(deployed(), config({ gasSeedOffered: true })));
    expect(hasButton(m, PT.seed)).toBe(true);
    expect(text(m)).toContain(PT.notEnough);
    expect(hasButton(markup(kit(deployed())), PT.seed)).toBe(false);
  });

  test("a balance known to be short holds the button back, with the faucet sentence", () => {
    everythingAgrees();
    chain.balance.data = { value: BigInt(0) };
    const m = markup(kit(deployed()));
    expect(buttonAttributes(m, PT.send)).toMatch(DISABLED);
    expect(text(m)).toContain(PT.notEnough);
    expect(text(m)).toContain(PT.gas);
  });

  test("a short balance offers to check it again, a read the person asks for", () => {
    everythingAgrees();
    chain.balance.data = { value: BigInt(0) };
    const m = markup(kit(deployed()));
    expect(hasButton(m, PT.checkBalance)).toBe(true);
    expect(buttonAttributes(m, PT.checkBalance)).not.toMatch(DISABLED);
    expect(text(m)).toContain("the button turns on once the balance covers the gas");
    // Offering it reads nothing: the read is the click's.
    expect(calls.balanceReads).toBe(0);
  });

  test("a balance that covers the estimate, or one not read, offers no balance check", () => {
    everythingAgrees();
    expect(hasButton(markup(kit(deployed())), PT.checkBalance)).toBe(false);
    chain.balance.data = undefined;
    expect(hasButton(markup(kit(deployed())), PT.checkBalance)).toBe(false);
  });

  test("a balance that covers the estimate, or one not read, leaves the button offered", () => {
    everythingAgrees();
    expect(buttonAttributes(markup(kit(deployed())), PT.send)).not.toMatch(DISABLED);
    chain.balance.data = undefined;
    const m = markup(kit(deployed()));
    expect(buttonAttributes(m, PT.send)).not.toBeNull();
    expect(buttonAttributes(m, PT.send)).not.toMatch(DISABLED);
  });

  test("the binding on its way: it says so, and nothing is offered", () => {
    const m = markup(kit(deployed()));
    expect(text(m)).toContain(PT.loading);
    expect(m).not.toContain("<button");
  });

  test("a binding that could not be read: say so, with Try again only", () => {
    api.binding = { data: undefined, isError: true };
    const m = markup(kit(deployed()));
    expect(text(m)).toContain(PT.bindingUnread);
    expect(hasButton(m, PT.retry)).toBe(true);
    expect(hasButton(m, PT.send)).toBe(false);
  });

  test("a body winding down asks for no pointer: the notice, and no button", () => {
    everythingAgrees();
    api.binding = { data: binding({ state: "broken", brokenReason: "winding_down", intent: null }), isError: false };
    const m = markup(kit(deployed({ state: "broken", brokenReason: "winding_down" })));
    const n = noticeSentence({ kind: "winding_down" }, "sandbox");
    expect(text(m)).toContain(n.title);
    expect(text(m)).toContain(n.body);
    expect(m).not.toContain("<button");
  });

  test("a revoked order: the allowlist refuses it, no read is made and there is no button", () => {
    everythingAgrees();
    const m = markup(kit(deployed({ revoked: true })));
    expect(text(m)).toContain(fillCopy(PT.callRefused, { problem: "order_not_pointable" }));
    expect(m).not.toContain("<button");
    expect(chain.asked.length).toBeGreaterThan(0);
    for (const read of chain.asked) expect(read.enabled).toBe(false);
    expect(chain.gas.enabled).toBe(false);
  });

  test("the factory encodes another value: the stop, and no button", () => {
    everythingAgrees();
    chain.reads.encodePointer = { status: "success", data: `${LIVE_POINTER.slice(0, -2)}ff` };
    const m = markup(kit(deployed()));
    expect(text(m)).toContain(
      "Your wallet is not asked to send the pointer: the pointer could not be checked against the factory.",
    );
    expect(m).not.toContain("<button");
    expect(chain.gas.enabled).toBe(false);
  });

  test("the identity changed hands: the sentence, and no button", () => {
    everythingAgrees();
    chain.reads.ownerOf = { status: "success", data: THIRD };
    const m = markup(kit(deployed()));
    expect(text(m)).toContain(PT.identityMoved);
    expect(m).not.toContain("<button");
  });

  test("another wallet connected: the owner is named, and no button", () => {
    everythingAgrees();
    chain.connected = OTHER;
    const m = markup(kit(deployed()));
    expect(text(m)).toContain(fillCopy(PT.notThisWallet, { agentId: LIVE_AGENT, owner: GUARDIAN }));
    expect(m).not.toContain("<button");
  });

  test("a read that failed: the chain could not be read, with Try again only", () => {
    everythingAgrees();
    chain.reads.identityOwnerAtCreation = { status: "error", error: new Error("offline") };
    const m = markup(kit(deployed()));
    expect(text(m)).toContain(PT.checksUnread);
    expect(hasButton(m, PT.retry)).toBe(true);
    expect(hasButton(m, PT.send)).toBe(false);
  });

  test("the gas could not be estimated: said, and the button stays", () => {
    everythingAgrees();
    chain.gas.data = undefined;
    const m = markup(kit(deployed()));
    expect(text(m)).toContain(PT.gasUnread);
    expect(hasButton(m, PT.send)).toBe(true);
  });

  test("no order: nothing", () => {
    expect(markup(kit(null))).toBe("");
  });
});

describe("nothing outlives the step", () => {
  const code = readFileSync(
    fileURLToPath(new URL("../src/components/legalBody/PointerStep.tsx", import.meta.url)),
    "utf8",
  );

  test("every timer goes through the step's lifetime, which the effect's cleanup ends", () => {
    expect(code).not.toContain("setTimeout");
    expect(code).not.toContain("setInterval");
    expect(code).toContain("stepLifetime()");
    expect(code).toMatch(/return \(\) => \{\s*life\.end\(\);/);
  });

  test("after the wallet and after the receipt, the click goes on only while the step is on screen", () => {
    const send = code.indexOf("await send(");
    const receipt = code.indexOf("await client.waitForTransactionReceipt(");
    expect(send).toBeGreaterThan(0);
    expect(receipt).toBeGreaterThan(send);
    const afterSend = code.slice(send, receipt);
    expect(afterSend.split("if (!life.alive()) return;").length - 1).toBe(2);
    const afterReceipt = code.slice(receipt, code.indexOf("pointerTxStage(receipt)"));
    expect(afterReceipt).toContain("if (!life.alive()) return;");
  });
});

describe("the wallet only through the allowlist", () => {
  test("the step reaches for no wallet write but useAllowedWrite, no signature and no key", () => {
    const code = readFileSync(
      fileURLToPath(new URL("../src/components/legalBody/PointerStep.tsx", import.meta.url)),
      "utf8",
    );
    expect(code).toContain("useAllowedWrite");
    for (const reach of [
      "useWriteContract",
      "writeContract",
      "useSendTransaction",
      "sendTransaction",
      "useSignTypedData",
      "signTypedData",
      "sendAllowedCall",
      "apiKey",
      "x-api-key",
    ])
      expect(code).not.toContain(reach);
  });
});
