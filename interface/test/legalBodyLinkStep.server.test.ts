/**
 * The link step, rendered as the server renders it, with every effect run at once as the browser
 * would run it.
 *
 * Before the click the step says what will be signed and offers "Sign": rendering asks for no
 * link, opens no wallet and sends nothing, so React's double effects in development can never
 * spend a door's token or prompt a wallet. The link is checked against the order's agreement, so
 * an agreement that does not check is a stop with no Sign. While the body is being created the
 * step says so and offers nothing. The paste branch is not this step's.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { keccak256, stringToBytes, type Hex } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({ messages: 0, submits: 0, signs: 0, refetches: 0, effects: 0 }));
const read = vi.hoisted(() => ({
  current: { data: undefined, error: null } as { data: unknown; error: unknown },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // As the browser would: an effect runs, here at once, so whatever it does shows in the spies.
    useEffect: (effect: () => void) => {
      calls.effects += 1;
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
  useLegalBodyAgreementQuery: () => ({
    ...read.current,
    refetch: async () => {
      calls.refetches += 1;
      return {};
    },
  }),
}));

vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useSignTypedData: () => ({
    signTypedDataAsync: async () => {
      calls.signs += 1;
      throw new Error("not in this test");
    },
  }),
  useConnection: () => ({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 5042002 }),
}));

import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import { LinkStep } from "@/components/legalBody/LinkStep";
import type { LegalBodyAgreement, LegalBodyConfig, LegalBodyOrderView } from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";

const L = LEGAL_BODY_COPY.link;
const A = LEGAL_BODY_COPY.agreement;
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const LIVE_AGENT = "897126";

const config = (
  over: Partial<Extract<LegalBodyConfig, { available: true }>> = {},
): Extract<LegalBodyConfig, { available: true }> => ({
  available: true,
  declarations: true,
  statements: true,
  environment: "sandbox",
  chainId: 5042002,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
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
  id: "lbo_draft",
  publicId: "pub_draft",
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

const SIGN: LegalBodyDerivation = { phase: "link", branch: "browser" };
const CREATING: LegalBodyDerivation = { phase: "link", branch: "browser", notice: { kind: "creating" } };

function kit(derivation: LegalBodyDerivation = SIGN, o: LegalBodyOrderView | null = order()): LegalBodyStepKit {
  return {
    config: config(),
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

function markup(k: LegalBodyStepKit, agentId: string | null = LIVE_AGENT): string {
  return renderToString(createElement(LinkStep, { kit: k, agentId, onSendBack: vi.fn() }));
}

/** Whether the markup holds a button labelled exactly `label`. */
function hasButton(m: string, label: string): boolean {
  return [...m.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].some(
    ([, inner]) => inner.replace(/<[^>]*>/g, "").trim() === label,
  );
}

/** The text a person reads: the markup's tags dropped and its escapes undone. */
function text(k: LegalBodyStepKit, agentId: string | null = LIVE_AGENT): string {
  return markup(k, agentId)
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

beforeEach(() => {
  calls.messages = 0;
  calls.submits = 0;
  calls.signs = 0;
  calls.refetches = 0;
  calls.effects = 0;
  read.current = { data: AGREEMENT, error: null };
});

describe("before the click", () => {
  test("the step says what will be signed, that nothing is approved, and offers Sign", () => {
    const page = text(kit());
    expect(page).toContain(L.title);
    expect(page).toContain(fillCopy(L.intro, { agentId: LIVE_AGENT }));
    expect(page).toContain(L.howItWorks);
    expect(page).toContain(LEGAL_BODY_COPY.wallet.neverApprove);
    expect(hasButton(markup(kit()), L.sign)).toBe(true);
    expect(hasButton(markup(kit()), L.retry)).toBe(false);
  });

  test("no link is shown before one is asked for", () => {
    const page = text(kit());
    expect(page).not.toContain(L.fieldsHeading);
    expect(page).not.toContain(L.theOneYouRead);
    expect(page).not.toContain(L.fields.agreementHash);
  });

  test("rendering, effects included, asks for no link, opens no wallet and sends nothing", () => {
    const k = kit();
    text(k);
    text(kit(CREATING, order({ state: "reserved" })));
    expect(calls).toEqual({ messages: 0, submits: 0, signs: 0, refetches: 0, effects: 0 });
    expect(k.remember).not.toHaveBeenCalled();
    expect(k.startAnother).not.toHaveBeenCalled();
  });
});

describe("the agreement the link signs", () => {
  test("an agreement that is not the order's own is a stop, with no Sign", () => {
    const page = text(kit(SIGN, order({ agreement: { hash: `0x${"7e".repeat(32)}`, version: 1 } })));
    expect(page).toContain(A.unverifiable);
    expect(page).toContain("(order_hash)");
    expect(page).not.toContain(L.howItWorks);
    expect(hasButton(markup(kit(SIGN, order({ agreement: { hash: `0x${"7e".repeat(32)}`, version: 1 } }))), L.sign)).toBe(false);
  });

  test("while it is read, the step says so and offers nothing", () => {
    read.current = { data: undefined, error: null };
    const page = text(kit());
    expect(page).toContain(A.reading);
    expect(page).not.toContain(L.howItWorks);
  });

  test("one that could not be read says so, with Try again", () => {
    read.current = { data: undefined, error: new Error("offline") };
    const page = text(kit());
    expect(page).toContain(A.unreadable);
    expect(hasButton(markup(kit()), L.retry)).toBe(true);
    expect(hasButton(markup(kit()), L.sign)).toBe(false);
    expect(page).not.toContain(L.howItWorks);
  });
});

describe("the other screens of the phase", () => {
  test("while the body is created: the notice, and nothing to click", () => {
    const k = kit(CREATING, order({ state: "reserved", agentId: LIVE_AGENT }));
    const page = text(k);
    expect(page).toContain(L.creating);
    expect(page).toContain(LEGAL_BODY_COPY.notices.creating.body);
    expect(page).not.toContain(L.howItWorks);
    expect(markup(k)).not.toContain("<button");
  });

  test("the paste branch is not this step's: it renders nothing", () => {
    expect(text(kit({ phase: "link", branch: "paste" }))).toBe("");
  });

  test("with no identity known for the draft, the step says so and offers no Sign", () => {
    const page = text(kit(), null);
    expect(page).toContain(L.identityUnknown);
    expect(page).not.toContain(L.howItWorks);
    expect(markup(kit(), null)).not.toContain("<button");
  });
});

describe("the agent id, where a person looks for it", () => {
  const line = (agentId: string) => `${LEGAL_BODY_COPY.identity.yourIdentity} ${agentId}`;

  test("on the draft, the identity picked for it, near the top of the step", () => {
    const page = text(kit());
    expect(page).toContain(line(LIVE_AGENT));
    expect(page.indexOf(line(LIVE_AGENT))).toBeLessThan(page.indexOf(L.howItWorks));
  });

  test("the order's own identity once it has one, over the one picked in this browser", () => {
    const page = text(kit(SIGN, order({ agentId: "897353" })), LIVE_AGENT);
    expect(page).toContain(line("897353"));
    expect(page).not.toContain(line(LIVE_AGENT));
  });

  test("while the body is created, the order's identity", () => {
    const page = text(kit(CREATING, order({ state: "reserved", agentId: "897353" })), null);
    expect(page).toContain(line("897353"));
  });

  test("no identity known: no line", () => {
    expect(text(kit(), null)).not.toContain(LEGAL_BODY_COPY.identity.yourIdentity);
  });
});
