/**
 * The company step, rendered as the server renders it.
 *
 * On a sandbox the step says out loud what a test declaration is: the label, the hint under the
 * name that it must say it is a test, the hint under the number, and the sentence that the check
 * is automatic and checks nothing. Production asks for the four fields and says none of that. The
 * sub-screens say what the check's state says, with the way back it offers. Rendering sends
 * nothing: every request of the step is a click's.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

const calls = vi.hoisted(() => ({ requests: 0, signs: 0 }));

vi.mock("@/lib/api/legalBodyHooks", () => {
  const mutation = () => ({
    mutateAsync: async () => {
      calls.requests += 1;
      throw new Error("not in this test");
    },
    isPending: false,
  });
  return {
    useStatementMessageMutation: mutation,
    useCreateCustomerCompanyMutation: mutation,
    useAbandonCompanyMutation: mutation,
  };
});

vi.mock("@/lib/api/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/hooks")>()),
  useCompaniesQuery: () => ({
    data: { companies: [] },
    refetch: async () => {
      calls.requests += 1;
      return { data: { companies: [] } };
    },
  }),
}));

vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useSignTypedData: () => ({
    signTypedDataAsync: async () => {
      calls.signs += 1;
      return "0x";
    },
  }),
  useConnection: () => ({ chainId: 5042002 }),
}));

import { CompanyStep } from "@/components/legalBody/CompanyStep";
import type { LegalBodyStepKit } from "@/components/legalBody/LegalBodyFlow";
import type { CompanyView, LegalBodyConfig } from "@/lib/api/types";
import { CHECK_REASON_SENTENCES, LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";

const C = LEGAL_BODY_COPY.company;
const N = LEGAL_BODY_COPY.notices;
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;

const config = (environment: "sandbox" | "production"): Extract<LegalBodyConfig, { available: true }> => ({
  available: true,
  declarations: true,
  statements: true,
  environment,
  chainId: 5042002,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  factory: "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456",
  gasSeedOffered: false,
  paymentRequired: false,
  linkTtl: { min: 600, max: 85_800, default: 3_600 },
});

const company = (over: Partial<CompanyView> = {}): CompanyView => ({
  companyId: "co_test",
  environment: "sandbox",
  nameOptions: [{ name: "Example Test Holdings LLC", entityTypeEnding: "", position: 1 }],
  legalNameFiled: null,
  businessPurpose: "not applicable: an existing company",
  industryLabel: "not applicable: an existing company",
  state: "ready",
  filedAt: null,
  filingNumber: null,
  agents: 0,
  createdAt: 1_791_000_000_000,
  provider: "customer",
  declared: { companyName: "Example Test Holdings LLC", filingNumber: "TEST-0001", wordingVersion: "2026-10-draft-1" },
  verification: { state: "verified", checkedAt: 1_791_000_000, reasonCode: null },
  ...over,
});

function kit(
  environment: "sandbox" | "production",
  derivation: LegalBodyDerivation,
  theCompany: CompanyView | null = null,
): LegalBodyStepKit {
  return {
    config: config(environment),
    tenant: GUARDIAN,
    derivation,
    companyId: theCompany?.companyId ?? null,
    orderId: null,
    company: theCompany,
    order: null,
    orders: [],
    remember: vi.fn(),
    startAnother: vi.fn(),
    routeSignIn: vi.fn(() => false),
  };
}

function markup(k: LegalBodyStepKit): string {
  return renderToString(createElement(CompanyStep, { kit: k }));
}

/** The text a person reads: the markup's tags dropped and its escapes undone. */
function text(k: LegalBodyStepKit): string {
  return markup(k)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const FORM: LegalBodyDerivation = { phase: "company", companyStep: "form" };

describe("the form", () => {
  test("a sandbox says out loud that this is a test declaration", () => {
    const page = text(kit("sandbox", FORM));
    expect(page).toContain(C.testLabel);
    expect(page).toContain(C.nameHintSandbox);
    expect(page).toContain(C.numberHintSandbox);
    expect(page).toContain(C.sandboxCheck);
    expect(page).toContain(C.labels.companyName);
    expect(page).toContain(C.labels.filingNumber);
    expect(page).toContain(C.sign);
    // A sandbox names its own declarant: nobody types a name there.
    expect(page).not.toContain(C.labels.declarantName);
    expect(page).not.toContain(C.labels.declarantTitle);
  });

  test("production asks for the four fields and says nothing of a test", () => {
    const page = text(kit("production", FORM));
    for (const label of Object.values(C.labels)) expect(page).toContain(label);
    expect(page).not.toContain(C.testLabel);
    expect(page).not.toContain(C.nameHintSandbox);
    expect(page).not.toContain(C.numberHintSandbox);
    expect(page).not.toContain(C.sandboxCheck);
  });

  test("an abandoned company's notice stands above a new form", () => {
    const page = text(kit("sandbox", { ...FORM, notice: { kind: "company_abandoned" } }, company({ state: "abandoned" })));
    expect(page).toContain(N.company_abandoned.title);
    expect(page).toContain(N.company_abandoned.body);
    expect(page).toContain(C.sign);
  });

  test("no statement is shown before one was asked for and checked", () => {
    const page = text(kit("sandbox", FORM));
    expect(page).not.toContain(C.statementHeading);
    expect(page).not.toContain(C.draftWording);
  });
});

describe("the sub-screens", () => {
  test("failed: the reason's sentence, the way back, a new declaration and abandon", () => {
    const page = text(
      kit(
        "sandbox",
        { phase: "company", companyStep: "failed", notice: { kind: "company_failed", reasonCode: "filing_not_found" } },
        company({ verification: { state: "failed", checkedAt: 1, reasonCode: "filing_not_found" } }),
      ),
    );
    expect(page).toContain(N.company_failed.title);
    expect(page).toContain(CHECK_REASON_SENTENCES.filing_not_found);
    expect(page).toContain(N.company_failed.wayBackSandbox);
    expect(page).toContain(C.newDeclaration);
    expect(page).toContain(C.abandon);
    expect(page).not.toContain(C.sign);
  });

  test("failed on production: the way back names the evidence, which is not on this screen yet", () => {
    const page = text(
      kit(
        "production",
        { phase: "company", companyStep: "failed", notice: { kind: "company_failed", reasonCode: "control_not_shown" } },
        company({ environment: "production", verification: { state: "failed", checkedAt: 1, reasonCode: "control_not_shown" } }),
      ),
    );
    expect(page).toContain(N.company_failed.wayBackProduction);
    expect(page).toContain(C.evidenceUnavailable);
  });

  test("revoked: the API's word, a new declaration and abandon", () => {
    const k = kit(
      "sandbox",
      { phase: "company", companyStep: "revoked", notice: { kind: "company_revoked" } },
      company({ verification: { state: "revoked", checkedAt: 1, reasonCode: null } }),
    );
    const page = text(k);
    expect(page).toContain(N.company_revoked.title);
    // The API's word, in the state-word pill: the title alone would also contain it.
    expect(markup(k)).toMatch(/<span class="rounded-full[^"]*font-mono[^"]*">revoked<\/span>/);
    expect(page).toContain(C.newDeclaration);
    expect(page).toContain(C.abandon);
  });

  test("waiting on production: an operator, a person, not instant; nothing to click", () => {
    const page = text(
      kit(
        "production",
        { phase: "company", companyStep: "waiting" },
        company({ environment: "production", verification: { state: "awaiting_check", checkedAt: null, reasonCode: null } }),
      ),
    );
    expect(page).toContain(C.waiting);
    expect(page).not.toContain(C.abandon);
    expect(page).not.toContain(C.newDeclaration);
  });

  test("evidence on production: the upload is not on this screen yet", () => {
    const page = text(
      kit(
        "production",
        { phase: "company", companyStep: "evidence" },
        company({ environment: "production", verification: { state: "awaiting_check", checkedAt: null, reasonCode: null } }),
      ),
    );
    expect(page).toContain(C.evidenceUnavailable);
  });
});

test("rendering sends nothing and opens no wallet", () => {
  calls.requests = 0;
  calls.signs = 0;
  text(kit("sandbox", FORM));
  text(kit("production", FORM));
  text(kit("sandbox", { phase: "company", companyStep: "revoked", notice: { kind: "company_revoked" } }, company()));
  expect(calls).toEqual({ requests: 0, signs: 0 });
});
