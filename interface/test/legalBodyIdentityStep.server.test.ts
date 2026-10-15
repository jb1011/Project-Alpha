/**
 * The identity step, rendered as the server renders it, with every effect run at once as the
 * browser would run it.
 *
 * The step offers three cards and nothing else until one is chosen. Rendering reads nothing and
 * sends nothing: the owner read, the orders read and the register transaction are all a click's.
 * The one effect forgets an identity the derivation refused as taken, and the refusal stays on
 * screen. A deployment on a chain this site does not read says so instead of offering the cards.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({ writes: 0, reads: 0, receipts: 0, refetches: 0, effects: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    // As the browser would: the effect runs, here at once, so whatever it does shows in the spies.
    useEffect: (effect: () => void) => {
      calls.effects += 1;
      effect();
    },
  };
});

vi.mock("@/lib/api/legalBodyHooks", () => ({
  useAllowedWrite: () => async () => {
    calls.writes += 1;
    throw new Error("not in this test");
  },
  useLegalBodyOrdersQuery: () => ({
    refetch: async () => {
      calls.refetches += 1;
      return { data: { orders: [] }, error: null };
    },
  }),
}));

vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  usePublicClient: () => ({
    readContract: async () => {
      calls.reads += 1;
      throw new Error("not in this test");
    },
    waitForTransactionReceipt: async () => {
      calls.receipts += 1;
      throw new Error("not in this test");
    },
  }),
  useConnection: () => ({ address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", chainId: 5042002 }),
}));

import { IdentityStep } from "@/components/legalBody/IdentityStep";
import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import type { LegalBodyConfig } from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";

const I = LEGAL_BODY_COPY.identity;
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

const config = (
  over: Partial<Extract<LegalBodyConfig, { available: true }>> = {},
): Extract<LegalBodyConfig, { available: true }> => ({
  available: true,
  declarations: true,
  statements: true,
  environment: "sandbox",
  chainId: 5042002,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  factory: "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456",
  gasSeedOffered: false,
  paymentRequired: false,
  linkTtl: { min: 600, max: 85_800, default: 3_600 },
  ...over,
});

const IDENTITY: LegalBodyDerivation = { phase: "identity" };

function kit(
  derivation: LegalBodyDerivation = IDENTITY,
  over: Partial<Extract<LegalBodyConfig, { available: true }>> = {},
): LegalBodyStepKit {
  return {
    config: config(over),
    tenant: GUARDIAN,
    derivation,
    companyId: "co_test",
    orderId: "lbo_draft",
    company: null,
    order: null,
    orders: [],
    remember: vi.fn(),
    startAnother: vi.fn(),
    routeSignIn: vi.fn(() => false),
  };
}

/** The text a person reads: the markup's tags dropped and its escapes undone. */
function text(k: LegalBodyStepKit): string {
  return renderToString(createElement(IdentityStep, { kit: k }))
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

beforeEach(() => {
  calls.writes = 0;
  calls.reads = 0;
  calls.receipts = 0;
  calls.refetches = 0;
  calls.effects = 0;
});

describe("the three cards", () => {
  test("each card is offered with what it does, and no form before a card is chosen", () => {
    const page = text(kit());
    expect(page).toContain(I.title);
    expect(page).toContain(fillCopy(I.intro, { network: "Arc testnet" }));
    for (const s of [I.ownCard, I.ownBody, I.registerCard, I.registerBody, I.elsewhereCard, I.elsewhereBody])
      expect(page).toContain(s);
    expect(page.split(I.choose).length - 1).toBe(3);
    expect(page).not.toContain(I.agentIdLabel);
    expect(page).not.toContain(I.uriLabel);
  });

  test("production names its own network", () => {
    expect(text(kit(IDENTITY, { environment: "production" }))).toContain(
      fillCopy(I.intro, { network: "Arc" }),
    );
  });

  test("rendering, effects included, reads nothing, sends nothing and remembers nothing", () => {
    const k = kit();
    text(k);
    expect(calls).toMatchObject({ writes: 0, reads: 0, receipts: 0, refetches: 0 });
    expect(k.remember).not.toHaveBeenCalled();
  });
});

describe("an identity the derivation refused as taken", () => {
  const TAKEN: LegalBodyDerivation = {
    phase: "identity",
    notice: { kind: "identity_taken", agentId: "897126" },
  };

  test("the refusal is on screen, and the memory forgets the identity so another is picked", () => {
    const k = kit(TAKEN);
    const page = text(k);
    expect(page).toContain(LEGAL_BODY_COPY.notices.identity_taken.title);
    expect(page).toContain(
      "Identity 897126: this identity already has a legal body; replacing it is not offered yet.",
    );
    expect(k.remember).toHaveBeenCalledTimes(1);
    expect(k.remember).toHaveBeenCalledWith({ agentId: null });
    // The cards are still there: the way on is another identity.
    expect(page).toContain(I.ownCard);
    expect(calls).toMatchObject({ writes: 0, reads: 0, receipts: 0, refetches: 0 });
  });
});

describe("a deployment on a chain this site does not read", () => {
  test("says so, and offers no card", () => {
    const page = text(kit(IDENTITY, { chainId: 5042 }));
    expect(page).toContain(fillCopy(I.otherChain, { network: "Arc testnet" }));
    expect(page).not.toContain(I.choose);
    expect(calls).toMatchObject({ writes: 0, reads: 0, receipts: 0, refetches: 0 });
  });
});
