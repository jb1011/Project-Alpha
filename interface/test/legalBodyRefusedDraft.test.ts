/**
 * A draft the link door refused on this visit is never offered again as a draft to continue.
 *
 * The door refuses a draft whose agreement this deployment no longer serves, or one it counts as
 * expired by its own clock, while this browser's rules still count it live. The shell sends the
 * person to the agreement for a new order and names the refused draft; the agreement step then
 * offers "Place the order" instead of continuing the draft that would meet the same refusal.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/lib/api/legalBodyHooks", () => ({
  useCreateLegalBodyOrderMutation: () => ({
    mutateAsync: async () => {
      throw new Error("not in this test");
    },
    isPending: false,
  }),
  useLegalBodyOrdersQuery: () => ({ dataUpdatedAt: 0, refetch: async () => ({}) }),
  useLegalBodyAgreementQuery: () => ({ data: undefined, error: null, refetch: async () => ({}) }),
}));

import { AgreementStep } from "@/components/legalBody/AgreementStep";
import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import type { LegalBodyConfig, LegalBodyOrderView } from "@/lib/api/types";
import { draftOffer } from "@/lib/legalBody/agreement";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";

const A = LEGAL_BODY_COPY.agreement;
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-13T12:00:00Z");
const HERE = { chainId: 5042002, factory: FACTORY };

const config: Extract<LegalBodyConfig, { available: true }> = {
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
};

/** A draft of the test company placed `ageMs` before `now`. */
const draft = (id: string, ageMs: number, now = NOW): LegalBodyOrderView => ({
  id,
  publicId: `pub_${id}`,
  companyId: "co_test",
  state: "draft",
  chainId: 5042002,
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
  createdAt: new Date(now - ageMs).toISOString(),
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
});

describe("draftOffer with a refused draft", () => {
  test("the refused draft, the only live one, is not offered: a new order is", () => {
    const refused = draft("lbo_refused", 2 * HOUR);
    expect(
      draftOffer({ orders: [refused], companyId: "co_test", where: HERE, nowMs: NOW, refused: "lbo_refused" }),
    ).toBeNull();
  });

  test("another live draft of the company is still offered", () => {
    const refused = draft("lbo_refused", HOUR);
    const other = draft("lbo_other", 3 * HOUR);
    expect(
      draftOffer({
        orders: [refused, other],
        companyId: "co_test",
        where: HERE,
        nowMs: NOW,
        refused: "lbo_refused",
      })?.order.id,
    ).toBe("lbo_other");
  });

  test("with no refused draft, or a null one, the offer is unchanged", () => {
    const live = draft("lbo_live", 2 * HOUR);
    const plain = draftOffer({ orders: [live], companyId: "co_test", where: HERE, nowMs: NOW });
    expect(plain?.order.id).toBe("lbo_live");
    expect(
      draftOffer({ orders: [live], companyId: "co_test", where: HERE, nowMs: NOW, refused: null }),
    ).toEqual(plain);
  });

  test("a refused id that is no order of the list changes nothing", () => {
    const live = draft("lbo_live", 2 * HOUR);
    expect(
      draftOffer({ orders: [live], companyId: "co_test", where: HERE, nowMs: NOW, refused: "lbo_gone" })?.order.id,
    ).toBe("lbo_live");
  });
});

describe("the agreement step after a refused draft", () => {
  function kit(orders: LegalBodyOrderView[]): LegalBodyStepKit {
    return {
      config,
      tenant: GUARDIAN,
      derivation: { phase: "agreement" },
      companyId: "co_test",
      orderId: null,
      company: null,
      order: null,
      orders,
      remember: vi.fn(),
      startAnother: vi.fn(),
      routeSignIn: vi.fn(() => false),
    };
  }

  /** The whole text of each button in the markup. */
  function buttons(refusedDraftId: string | null | undefined, orders: LegalBodyOrderView[]): string[] {
    const html = renderToString(
      createElement(AgreementStep, {
        kit: kit(orders),
        onRead: vi.fn(),
        onBackToCompany: vi.fn(),
        refusedDraftId,
      }),
    );
    return [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(([, inner]) =>
      inner.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
    );
  }

  // The step reads the clock itself: a draft placed two hours before now is live.
  const refused = () => draft("lbo_refused", 2 * HOUR, Date.now());

  test("with the refused draft named, the step offers Place the order and no Continue", () => {
    const shown = buttons("lbo_refused", [refused()]);
    expect(shown).toEqual([A.placeOrder]);
    expect(shown.some((b) => b.startsWith("Continue with the order placed"))).toBe(false);
  });

  test("without it, the same draft is offered to continue, as before", () => {
    const shown = buttons(undefined, [refused()]);
    expect(shown).toEqual(["Continue with the order placed 2 hours ago"]);
  });
});
