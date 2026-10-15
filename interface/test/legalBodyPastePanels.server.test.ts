/**
 * The paste branch's two panels, rendered as the server renders them, with every effect run at
 * once as the browser would run it.
 *
 * The link panel offers "Get the link" and nothing else before the click: rendering asks for no
 * link and sends nothing. The pointer panel shows the call only once the three chain reads agree
 * with the order, and rendering it, effects included, asks Novi Corpus for no check: the only
 * request it makes on its own is a read of the chain. Neither panel ever asks a wallet to sign or
 * send, and neither asks for an API key.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { encodeFunctionData, keccak256, stringToBytes, type Hex } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({
  messages: 0,
  submits: 0,
  refreshes: 0,
  allowedWrites: 0,
  signHooks: 0,
  writeHooks: 0,
  sendHooks: 0,
  refetches: 0,
}));
const agreementRead = vi.hoisted(() => ({
  current: { data: undefined, error: null } as { data: unknown; error: unknown },
}));
type Read = { status: "pending" | "error" | "success"; data?: unknown; error?: unknown; dataUpdatedAt?: number; errorUpdatedAt?: number };
const chain = vi.hoisted(() => ({
  reads: {} as Record<string, Read>,
  asked: [] as { functionName: string; query?: Record<string, unknown> }[],
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
  useLinkMessageMutation: () => ({
    mutateAsync: async () => {
      calls.messages += 1;
      throw new Error("not in this test");
    },
  }),
  useSubmitLinkMutation: () => ({
    mutateAsync: async () => {
      calls.submits += 1;
      throw new Error("not in this test");
    },
  }),
  useRefreshBindingMutation: () => ({
    mutateAsync: async () => {
      calls.refreshes += 1;
      throw new Error("not in this test");
    },
  }),
  useAllowedWrite: () => () => {
    calls.allowedWrites += 1;
    throw new Error("not in this test");
  },
  useLegalBodyAgreementQuery: () => ({
    ...agreementRead.current,
    refetch: async () => {
      calls.refetches += 1;
      return {};
    },
  }),
}));

vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useReadContract: (p: { functionName: string; query?: Record<string, unknown> }) => {
    chain.asked.push({ functionName: p.functionName, query: p.query });
    return {
      dataUpdatedAt: 0,
      errorUpdatedAt: 0,
      ...(chain.reads[p.functionName] ?? { status: "pending" }),
      refetch: async () => ({}),
    };
  },
  useSignTypedData: () => {
    calls.signHooks += 1;
    return { signTypedDataAsync: async () => "0x" };
  },
  useWriteContract: () => {
    calls.writeHooks += 1;
    return { writeContractAsync: async () => "0x" };
  },
  useSendTransaction: () => {
    calls.sendHooks += 1;
    return { sendTransactionAsync: async () => "0x" };
  },
  useConnection: () => ({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 5042002 }),
}));

import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import { PasteLinkPanel } from "@/components/legalBody/PasteLinkPanel";
import { PastePointerPanel } from "@/components/legalBody/PastePointerPanel";
import type { LegalBodyAgreement, LegalBodyConfig, LegalBodyOrderView } from "@/lib/api/types";
import { identityRegistryAbi } from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";

const P = LEGAL_BODY_COPY.paste;
const L = LEGAL_BODY_COPY.link;
const A = LEGAL_BODY_COPY.agreement;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const LIVE_BODY = "0x5969B48ff7A3a4c6689366a9a6D7AA24b0C4b5EE" as const;
const LIVE_AGENT = "897126";
/** Anvil's first three published accounts: the guardian, the identity's owner, and a key the
 *  identity moved to. */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OWNER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const THIRD = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
const LIVE_POINTER = ("0x" +
  "0".repeat(63) +
  "1" +
  "0".repeat(58) +
  "4cef52" +
  "0".repeat(24) +
  "5969b48ff7a3a4c6689366a9a6d7aa24b0c4b5ee") as Hex;
const CALLDATA = encodeFunctionData({
  abi: identityRegistryAbi,
  functionName: "setMetadata",
  args: [BigInt(LIVE_AGENT), "legalBody", LIVE_POINTER],
});

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

const utf8Hash = (s: string): Hex => keccak256(stringToBytes(s));
const TERMS = "Operating Agreement of a test company.\n\nStatus: draft.";

function agreement(): LegalBodyAgreement {
  const manifest = `${JSON.stringify({ terms: { hash: utf8Hash(TERMS), textStatus: "draft" } })}\n`;
  return {
    termsDoc: TERMS,
    manifest,
    manifestHash: utf8Hash(manifest),
    textId: "legal-body-operating-agreement",
    textVersion: "2026-10-draft-1",
    textStatus: "draft",
  };
}

const AGREEMENT = agreement();

const order = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_paste",
  publicId: "pub_paste",
  companyId: "co_test",
  state: "draft",
  chainId: 5042002,
  factory: FACTORY,
  guardian: GUARDIAN,
  amendmentDelay: 172_800,
  agreement: { hash: AGREEMENT.manifestHash, version: 1 },
  agentId: null,
  identityOwner: null,
  bodyAddress: null,
  linkDeadline: null,
  createTxHash: null,
  deployedAt: null,
  pointerSeenAt: null,
  createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

const deployed = (over: Partial<LegalBodyOrderView> = {}) =>
  order({
    state: "deployed",
    agentId: LIVE_AGENT,
    identityOwner: OWNER,
    bodyAddress: LIVE_BODY,
    linkDeadline: 1_791_021_600,
    createTxHash: `0x${"ab".repeat(32)}`,
    deployedAt: 1_791_000_060,
    ...over,
  });

const LINK: LegalBodyDerivation = { phase: "link", branch: "paste" };
const POINTER: LegalBodyDerivation = { phase: "pointer", branch: "paste" };

function kit(
  derivation: LegalBodyDerivation,
  o: LegalBodyOrderView | null,
  cfg = config(),
): LegalBodyStepKit {
  return {
    config: cfg,
    tenant: GUARDIAN,
    derivation,
    companyId: "co_test",
    orderId: o?.id ?? null,
    company: null,
    order: o,
    orders: o ? [o] : [],
    remember: vi.fn(),
    startAnother: vi.fn(),
    routeSignIn: vi.fn(() => false),
  };
}

const linkMarkup = (k: LegalBodyStepKit, agentId: string | null = LIVE_AGENT) =>
  renderToString(createElement(PasteLinkPanel, { kit: k, agentId, onSendBack: vi.fn() }));
const pointerMarkup = (k: LegalBodyStepKit) => renderToString(createElement(PastePointerPanel, { kit: k }));

/** Whether the markup holds a button labelled exactly `label`. */
function hasButton(m: string, label: string): boolean {
  return [...m.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].some(
    ([, inner]) => inner.replace(/<[^>]*>/g, "").trim() === label,
  );
}

/** The way on a stop offers: a new order on the same company, and a new declaration. */
const wayOnShown = (m: string) =>
  hasButton(m, LEGAL_BODY_COPY.closed.newOrder) && hasButton(m, LEGAL_BODY_COPY.closed.newCompany);

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

const revert = Object.assign(new Error("reverted"), { name: "ContractFunctionRevertedError" });

/** The three reads all agreeing with the live order, and no pointer yet. */
function chainAgrees() {
  chain.reads = {
    encodePointer: { status: "success", data: LIVE_POINTER },
    ownerOf: { status: "success", data: OWNER },
    identityOwnerAtCreation: { status: "success", data: OWNER },
    getMetadata: { status: "success", data: "0x", dataUpdatedAt: Date.now() },
  };
}

beforeEach(() => {
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
  agreementRead.current = { data: AGREEMENT, error: null };
  chain.reads = {};
  chain.asked = [];
});

/** Nothing was asked of a door or a wallet. */
function nothingSent() {
  expect(calls).toEqual({
    messages: 0,
    submits: 0,
    refreshes: 0,
    allowedWrites: 0,
    signHooks: 0,
    writeHooks: 0,
    sendHooks: 0,
    refetches: 0,
  });
}

describe("the link panel, before the click", () => {
  test("it says what happens and offers Get the link only", () => {
    const m = linkMarkup(kit(LINK, order()));
    const page = text(m);
    expect(page).toContain(P.title);
    expect(page).toContain(fillCopy(P.intro, { agentId: LIVE_AGENT }));
    expect(page).toContain(P.howItWorks);
    expect(page).toContain(LEGAL_BODY_COPY.wallet.neverApprove);
    expect(page).toContain(P.mcp);
    expect(hasButton(m, P.getLink)).toBe(true);
    expect(hasButton(m, P.send)).toBe(false);
    expect(hasButton(m, L.sign)).toBe(false);
  });

  test("no link, no copy box and no signature field before one is asked for", () => {
    const m = linkMarkup(kit(LINK, order()));
    const page = text(m);
    expect(page).not.toContain(P.typedDataHeading);
    expect(page).not.toContain(P.signatureLabel);
    expect(page).not.toContain(L.fieldsHeading);
    expect(m).not.toContain("<textarea");
  });

  test("rendering, effects included, asks for no link, sends nothing and prompts no wallet", () => {
    const k = kit(LINK, order());
    linkMarkup(k);
    nothingSent();
    expect(k.remember).not.toHaveBeenCalled();
    expect(k.startAnother).not.toHaveBeenCalled();
  });

  test("an agreement that is not the order's own is a stop, with nothing to click", () => {
    const k = kit(LINK, order({ agreement: { hash: `0x${"7e".repeat(32)}`, version: 1 } }));
    const m = linkMarkup(k);
    expect(text(m)).toContain(A.unverifiable);
    expect(text(m)).toContain("(order_hash)");
    expect(hasButton(m, P.getLink)).toBe(false);
  });

  test("while the agreement is read, nothing to click; one that could not be read has Try again", () => {
    agreementRead.current = { data: undefined, error: null };
    expect(text(linkMarkup(kit(LINK, order())))).toContain(A.reading);
    expect(hasButton(linkMarkup(kit(LINK, order())), P.getLink)).toBe(false);
    agreementRead.current = { data: undefined, error: new Error("offline") };
    const m = linkMarkup(kit(LINK, order()));
    expect(text(m)).toContain(A.unreadable);
    expect(hasButton(m, L.retry)).toBe(true);
    expect(hasButton(m, P.getLink)).toBe(false);
  });

  test("with no identity known for the draft, it says so and offers nothing; the MCP note stays", () => {
    const m = linkMarkup(kit(LINK, order()), null);
    expect(text(m)).toContain(L.identityUnknown);
    expect(text(m)).toContain(P.mcp);
    expect(m).not.toContain("<button");
  });
});

describe("the pointer panel", () => {
  test("while the chain is read, it says so and shows no call", () => {
    const m = pointerMarkup(kit(POINTER, deployed()));
    const page = text(m);
    expect(page).toContain(P.pointerTitle);
    expect(page).toContain(P.checking);
    expect(page).not.toContain(P.sendFromOwner);
    expect(page).not.toContain(CALLDATA);
    expect(hasButton(m, P.sent)).toBe(false);
  });

  test("the three reads agreeing: the decoded call, its calldata, the notes and I sent it", () => {
    chainAgrees();
    const m = pointerMarkup(kit(POINTER, deployed()));
    const page = text(m);
    expect(page).toContain(fillCopy(P.pointerIntro, { agentId: LIVE_AGENT }));
    expect(page).toContain(P.sendFromOwner);
    expect(page).toContain(OWNER);
    expect(page).toContain(REGISTRY);
    expect(page).toContain("setMetadata(uint256,string,bytes)");
    expect(page).toContain(LIVE_AGENT);
    expect(page).toContain(LIVE_POINTER);
    expect(page).toContain(CALLDATA);
    expect(CALLDATA.slice(0, 10)).toBe("0x466648da");
    expect(page).toContain(P.gasSandbox);
    expect(page).toContain(LEGAL_BODY_COPY.pointer.sevenDays);
    expect(page).toContain(LEGAL_BODY_COPY.wallet.neverApprove);
    expect(page).toContain(P.watching);
    expect(page).toContain(P.mcp);
    expect(hasButton(m, P.sent)).toBe(true);
  });

  test("every chain read, the watch of the pointer included, is never asked again on focus or reconnect", () => {
    chainAgrees();
    pointerMarkup(kit(POINTER, deployed()));
    const names = chain.asked.map((r) => r.functionName);
    expect(names).toContain("getMetadata");
    for (const read of chain.asked) {
      expect(read.query?.refetchOnWindowFocus).toBe(false);
      expect(read.query?.refetchOnReconnect).toBe(false);
    }
  });

  test("rendering, effects included, asks for no check and prompts no wallet", () => {
    chainAgrees();
    const k = kit(POINTER, deployed());
    pointerMarkup(k);
    nothingSent();
    expect(k.remember).not.toHaveBeenCalled();
  });

  test("the only request of its own is a read of the chain, the pointer every 30 s while watched", () => {
    chainAgrees();
    pointerMarkup(kit(POINTER, deployed()));
    expect(chain.asked.map((a) => a.functionName)).toEqual([
      "encodePointer",
      "ownerOf",
      "identityOwnerAtCreation",
      "getMetadata",
    ]);
    const watch = chain.asked[3].query ?? {};
    expect(watch.enabled).toBe(true);
    expect(watch.refetchOnWindowFocus).toBe(false);
    const interval = watch.refetchInterval as (q: { state: { data: unknown } }) => number | false;
    expect(interval({ state: { data: "0x" } })).toBe(30_000);
    expect(interval({ state: { data: LIVE_POINTER } })).toBe(false);
  });

  test("the three checks are read once: no retry, and not again on focus or on reconnect", () => {
    chainAgrees();
    pointerMarkup(kit(POINTER, deployed()));
    for (const read of chain.asked.slice(0, 3))
      expect(read.query).toEqual({ retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  });

  test("the pointer seen on the chain is said, and I sent it is still the click that checks it", () => {
    chainAgrees();
    chain.reads.getMetadata = { status: "success", data: LIVE_POINTER, dataUpdatedAt: Date.now() };
    const m = pointerMarkup(kit(POINTER, deployed()));
    expect(text(m)).toContain(P.seen);
    expect(hasButton(m, P.sent)).toBe(true);
    expect(calls.refreshes).toBe(0);
  });

  test("on production the gas note names Arc, not the testnet faucet", () => {
    chainAgrees();
    const page = text(pointerMarkup(kit(POINTER, deployed(), config({ environment: "production" }))));
    expect(page).toContain(P.gasProduction);
    expect(page).not.toContain(P.gasSandbox);
  });

  test("the factory encoding other bytes is a stop: no call, nothing to click", () => {
    chainAgrees();
    chain.reads.encodePointer = { status: "success", data: `${LIVE_POINTER.slice(0, -2)}ef` };
    const m = pointerMarkup(kit(POINTER, deployed()));
    expect(text(m)).toContain(fillCopy(P.pointerStop, { reason: LEGAL_BODY_COPY.pointer.factoryMismatch }));
    expect(text(m)).not.toContain(CALLDATA);
    expect(hasButton(m, P.sent)).toBe(false);
  });

  test("the identity moved since the link: the sentence, no call", () => {
    chainAgrees();
    chain.reads.ownerOf = { status: "success", data: THIRD };
    const m = pointerMarkup(kit(POINTER, deployed()));
    expect(text(m)).toContain(LEGAL_BODY_COPY.pointer.identityMoved);
    expect(text(m)).not.toContain(CALLDATA);
    expect(hasButton(m, P.sent)).toBe(false);
  });

  test("ownerOf reverting: no identity with this id now", () => {
    chainAgrees();
    chain.reads.ownerOf = { status: "error", error: revert };
    const page = text(pointerMarkup(kit(POINTER, deployed())));
    expect(page).toContain(fillCopy(P.noIdentity, { agentId: LIVE_AGENT }));
    expect(page).not.toContain(CALLDATA);
  });

  test("a read that failed: the chain could not be read, with Try again and no call", () => {
    chainAgrees();
    chain.reads.identityOwnerAtCreation = { status: "error", error: new Error("offline") };
    const m = pointerMarkup(kit(POINTER, deployed()));
    expect(text(m)).toContain(P.checksUnread);
    expect(hasButton(m, P.retry)).toBe(true);
    expect(text(m)).not.toContain(CALLDATA);
  });

  test("a replaced order is refused before any read: no call, nothing to send, the way on", () => {
    chainAgrees();
    const m = pointerMarkup(kit(POINTER, deployed({ state: "broken", brokenReason: "replaced" })));
    expect(text(m)).toContain(fillCopy(P.callRefused, { problem: "order_not_pointable" }));
    expect(chain.asked).toEqual([]);
    expect(hasButton(m, P.sent)).toBe(false);
    expect(wayOnShown(m)).toBe(true);
  });

  test.each([
    ["the factory encoding other bytes", () => (chain.reads.encodePointer = { status: "success", data: `${LIVE_POINTER.slice(0, -2)}ef` })],
    ["the identity moved since the link", () => (chain.reads.ownerOf = { status: "success", data: THIRD })],
    ["no identity with this id now", () => (chain.reads.ownerOf = { status: "error", error: revert })],
  ])("%s: a stop that offers the way on, and nothing to send", (_name, bend) => {
    chainAgrees();
    bend();
    const k = kit(POINTER, deployed());
    const m = pointerMarkup(k);
    expect(hasButton(m, P.sent)).toBe(false);
    expect(wayOnShown(m)).toBe(true);
    expect(k.startAnother).not.toHaveBeenCalled();
  });

  test("the call shown, or a read to try again: no way on", () => {
    chainAgrees();
    expect(wayOnShown(pointerMarkup(kit(POINTER, deployed())))).toBe(false);
    chain.reads.identityOwnerAtCreation = { status: "error", error: new Error("offline") };
    expect(wayOnShown(pointerMarkup(kit(POINTER, deployed())))).toBe(false);
  });
});

describe("after a round of checks that did not see the pointer", () => {
  const panel = () =>
    readFileSync(fileURLToPath(new URL("../src/components/legalBody/PastePointerPanel.tsx", import.meta.url)), "utf8");

  test("the panel says its own line: the watch is off, so the next check is the person's click", () => {
    expect(P.keepChecking).toContain("I sent it");
    expect(P.keepChecking).not.toContain("updates when the pointer is seen");
    expect(panel()).toContain("P.keepChecking");
    expect(panel()).not.toContain("POINTER.keepChecking");
  });
});

describe("no wallet and no API key on this branch", () => {
  const source = (name: string) =>
    readFileSync(fileURLToPath(new URL(`../src/components/legalBody/${name}`, import.meta.url)), "utf8");

  test.each(["PasteLinkPanel.tsx", "PastePointerPanel.tsx"])(
    "%s reaches for no wallet signature, no wallet write and no key",
    (name) => {
      const code = source(name);
      for (const reach of [
        "useSignTypedData",
        "signTypedData",
        "useWriteContract",
        "writeContract",
        "useSendTransaction",
        "useAllowedWrite",
        "sendAllowedCall",
        "apiKey",
        "x-api-key",
      ])
        expect(code).not.toContain(reach);
    },
  );
});
