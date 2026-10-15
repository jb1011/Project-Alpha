/**
 * The agreement step, rendered as the server renders it.
 *
 * Before the click the step offers one thing: the live draft of this company when there is one,
 * else "Place the order and read the agreement". Rendering places nothing and registers no
 * effect, so React's double effects in development can never place two orders. Once the order
 * exists, its frozen agreement is shown only if it checks against its hash: the terms as text,
 * the hash with what it is for, the draft badge, the delay and the expiry, and a Continue that
 * the checkbox gates. An agreement that does not check is a stop.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { keccak256, stringToBytes, type Hex } from "viem";
import { beforeEach, describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({ requests: 0, effects: 0 }));
const read = vi.hoisted(() => ({
  id: undefined as string | null | undefined,
  current: { data: undefined, error: null } as { data: unknown; error: unknown },
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (...args: Parameters<typeof actual.useEffect>) => {
      calls.effects += 1;
      return actual.useEffect(...args);
    },
    useLayoutEffect: (...args: Parameters<typeof actual.useLayoutEffect>) => {
      calls.effects += 1;
      return actual.useLayoutEffect(...args);
    },
  };
});

vi.mock("@/lib/api/legalBodyHooks", () => ({
  useCreateLegalBodyOrderMutation: () => ({
    mutateAsync: async () => {
      calls.requests += 1;
      throw new Error("not in this test");
    },
    mutate: () => {
      calls.requests += 1;
    },
    isPending: false,
  }),
  useLegalBodyOrdersQuery: () => ({
    // As the hook reports a list not read yet: the step's clock is then its own mount time.
    dataUpdatedAt: 0,
    refetch: async () => {
      calls.requests += 1;
      return {};
    },
  }),
  useLegalBodyAgreementQuery: (id: string | null | undefined) => {
    read.id = id;
    return {
      ...read.current,
      refetch: async () => {
        calls.requests += 1;
        return {};
      },
    };
  },
}));

import { AgreementStep } from "@/components/legalBody/AgreementStep";
import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import {
  ApiError,
  type CompanyView,
  type LegalBodyAgreement,
  type LegalBodyConfig,
  type LegalBodyOrderView,
} from "@/lib/api/types";
import { utcMinute } from "@/lib/legalBody/agreement";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";

const A = LEGAL_BODY_COPY.agreement;
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

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

const company = {
  companyId: "co_test",
  environment: "sandbox",
  state: "ready",
  provider: "customer",
  declared: { companyName: "Example Test Holdings LLC", filingNumber: "TEST-0001", wordingVersion: "2026-10-draft-1" },
  verification: { state: "verified", checkedAt: 1_791_000_000, reasonCode: null },
} as unknown as CompanyView;

/** A draft placed `ageMs` before this test's clock: the step reads the clock itself. */
const draft = (ageMs: number, over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "lbo_draft",
  publicId: "lb_public",
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
  createdAt: iso(Date.now() - ageMs),
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

const utf8Hash = (s: string): Hex => keccak256(stringToBytes(s));

const TERMS = [
  '# Operating Agreement of "Example Test Holdings LLC"',
  "",
  "Status: draft. This wording is not yet approved for use with a real company.",
  "",
  "## 4. Amendments",
  "",
  "- (a) the Manager has signed the amendment;\n- (b) it was scheduled on chain.",
  "",
].join("\n");

function agreement(termsDoc = TERMS, over: Partial<LegalBodyAgreement> = {}): LegalBodyAgreement {
  const manifest = `${JSON.stringify({ terms: { hash: utf8Hash(termsDoc), textStatus: "draft" } })}\n`;
  return {
    termsDoc,
    manifest,
    manifestHash: utf8Hash(manifest),
    textId: "legal-body-operating-agreement",
    textVersion: "2026-10-draft-1",
    textStatus: "draft",
    ...over,
  };
}

const AGREEMENT: LegalBodyDerivation = { phase: "agreement" };

function kit(order: LegalBodyOrderView | null, orders: LegalBodyOrderView[] = []): LegalBodyStepKit {
  return {
    config,
    tenant: GUARDIAN,
    derivation: AGREEMENT,
    companyId: "co_test",
    orderId: order?.id ?? null,
    company,
    order,
    orders: order ? [order, ...orders] : orders,
    remember: vi.fn(),
    startAnother: vi.fn(),
    routeSignIn: vi.fn(() => false),
  };
}

function markup(k: LegalBodyStepKit): string {
  return renderToString(
    createElement(AgreementStep, { kit: k, onRead: vi.fn(), onBackToCompany: vi.fn() }),
  );
}

/** The text a person reads: the markup's tags dropped and its escapes undone. */
function text(k: LegalBodyStepKit): string {
  return markup(k)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** The attributes of the button whose whole text is `label`, or null when there is none. */
function buttonAttributes(html: string, label: string): string | null {
  for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
    const inner = m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    if (inner === label) return m[1];
  }
  return null;
}

beforeEach(() => {
  read.id = undefined;
  read.current = { data: undefined, error: null };
});

describe("before the click", () => {
  test("one button places the order; nothing is read or placed by rendering", () => {
    const page = text(kit(null));
    expect(page).toContain(A.placeOrder);
    expect(page).toContain(A.introBefore);
    expect(page).not.toContain(A.readCheckbox);
    expect(read.id ?? null).toBeNull();
  });

  test("a live draft of this company is offered instead of a new order", () => {
    const page = text(kit(null, [draft(5 * HOUR + 60_000)]));
    expect(page).toContain("Continue with the order placed 5 hours ago");
    expect(page).toContain(A.draftOffered);
    expect(page).not.toContain(A.placeOrder);
  });

  test("a draft placed under another factory is not offered: a new order is", () => {
    const page = text(kit(null, [draft(HOUR, { factory: "0x00000000000000000000000000000000000fac70" })]));
    expect(page).toContain(A.placeOrder);
    expect(page).not.toContain("Continue with the order placed");
  });

  test("an expired draft is not offered", () => {
    const page = text(kit(null, [draft(DAY + 60_000)]));
    expect(page).toContain(A.placeOrder);
    expect(page).not.toContain("Continue with the order placed");
  });
});

describe("the agreement of the order", () => {
  test("checked against its hash, then shown with every fact, and Continue gated by the checkbox", () => {
    const order = draft(2 * HOUR);
    const a = agreement();
    read.current = { data: a, error: null };
    const html = markup(kit(order));
    const page = text(kit(order));

    expect(read.id).toBe(order.id);
    expect(page).toContain(A.introAfter);
    expect(page).toContain('# Operating Agreement of "Example Test Holdings LLC"');
    expect(page).toContain("Status: draft. This wording is not yet approved for use with a real company.");
    expect(page).toContain("- (a) the Manager has signed the amendment;");
    expect(page).toContain(a.manifestHash);
    expect(page).toContain(A.hashNote);
    expect(page).toContain(A.draftWording);
    expect(page).toContain("wording 2026-10-draft-1");
    expect(page).toContain(fillCopy(A.delay, { delay: "48 hours" }));
    expect(page).toContain(utcMinute(Date.parse(order.createdAt) + DAY) ?? "no expiry");
    expect(page).toContain(A.readCheckbox);
    expect(page).not.toContain(A.placeOrder);

    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).not.toMatch(/<input[^>]*type="checkbox"[^>]*checked/);
    const continueButton = buttonAttributes(html, A.continue);
    expect(continueButton).not.toBeNull();
    expect(continueButton).toContain("disabled");
  });

  test("each paragraph is its own block, its line breaks kept", () => {
    read.current = { data: agreement(), error: null };
    const html = markup(kit(draft(HOUR)));
    expect(html).toContain("- (a) the Manager has signed the amendment;\n- (b) it was scheduled on chain.");
  });

  test("an approved wording goes without the draft badge", () => {
    read.current = { data: agreement(TERMS, { textStatus: "approved" }), error: null };
    expect(text(kit(draft(HOUR)))).not.toContain(A.draftWording);
  });

  test("markup in the terms is shown as text, never parsed", () => {
    read.current = { data: agreement("Plain.\n\n<script>alert(1)</script>\n"), error: null };
    const html = markup(kit(draft(HOUR)));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("an agreement that does not check against its hash is a stop: no checkbox, no Continue", () => {
    const a = agreement();
    read.current = { data: { ...a, termsDoc: a.termsDoc.replace("draft.", "draft!") }, error: null };
    const html = markup(kit(draft(HOUR)));
    const page = text(kit(draft(HOUR)));
    expect(page).toContain(A.unverifiable);
    expect(page).toContain("terms_hash");
    expect(page).not.toContain(A.readCheckbox);
    expect(page).not.toContain("Status: draft.");
    expect(buttonAttributes(html, A.continue)).toBeNull();
  });

  test("while it is read, the step says so", () => {
    expect(text(kit(draft(HOUR)))).toContain(A.reading);
  });

  test("a read that failed shows the API's sentence and a retry", () => {
    read.current = {
      data: undefined,
      error: new ApiError(503, {
        code: "agreement_unreadable",
        message: "This order's stored agreement no longer reads back as the agreement it was frozen with.",
      }),
    };
    const page = text(kit(draft(HOUR)));
    expect(page).toContain("This order's stored agreement no longer reads back as the agreement it was frozen with.");
    expect(page).toContain(A.retry);
    expect(page).not.toContain(A.readCheckbox);
  });
});

describe("rendering writes nothing", () => {
  test("no order is placed, nothing is read again, and no effect is registered, in any state", () => {
    calls.requests = 0;
    calls.effects = 0;
    text(kit(null));
    text(kit(null, [draft(HOUR)]));
    read.current = { data: agreement(), error: null };
    text(kit(draft(HOUR)));
    read.current = { data: { ...agreement(), manifestHash: utf8Hash("other") }, error: null };
    text(kit(draft(HOUR)));
    expect(calls.requests).toBe(0);
    expect(calls.effects).toBe(0);
  });
});
