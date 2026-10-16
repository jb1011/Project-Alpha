/**
 * Where a person is in the legal-body flow, as tables: one row per state the server can be in,
 * the awkward ones included (a lapse never seen, a transfer before the pointer, a replaced body, a
 * reinstated sandbox company, several open threads, a memory that names an order the server no
 * longer lists). Every view is built from one fixed `NOW`: nothing here reads a clock.
 */
import { describe, expect, test } from "vitest";
import {
  CONTROL_UPLOAD_TYPE,
  DRAFT_LIFETIME_MS,
  deriveLegalBodyPhase,
  identityHasBody,
  isDraftExpired,
  isLiveOrder,
  pointerPreflight,
  sameAddress,
  selectLegalBodyThread,
  type LegalBodyDerivation,
  type LegalBodyFlowInput,
  type LegalBodyThread,
  type PointerPreflight,
} from "@/lib/legalBody/flow";
import type {
  Address,
  BindingState,
  CompanyView,
  FormationDocument,
  LegalBodyConfig,
  LegalBodyOrderView,
} from "@/lib/api/types";

/** Three of anvil's published test accounts, as served (checksummed). */
const GUARDIAN = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const OTHER_KEY = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const THIRD_KEY = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;
/** The public testnet factory and identity registry. */
const FACTORY = "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456" as const;
const REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
/** Inventions. */
const ANOTHER_FACTORY = "0x00000000000000000000000000000000000fac70" as const;
const BODY = "0x00000000000000000000000000000000000b0d1e" as const;
const CHAIN = 5042002;
const AGENT = "42";

/** The one clock of this file. */
const NOW = Date.parse("2026-10-12T12:00:00Z");
const NOW_S = NOW / 1000;
const HOUR = 3_600_000;
const DAY_S = 86_400;
/** As the API serves `createdAt`: ISO 8601 in UTC, whole seconds, marked with a `Z`. */
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
/** The same address in another case: a served checksum and a session's lower case must agree. */
const upper = (a: Address) => `0x${a.slice(2).toUpperCase()}` as Address;
const lower = (a: Address) => a.toLowerCase() as Address;

type AvailableConfig = Extract<LegalBodyConfig, { available: true }>;
type Verification = NonNullable<CompanyView["verification"]>;

const config = (over: Partial<AvailableConfig> = {}): AvailableConfig => ({
  available: true,
  declarations: true,
  statements: true,
  environment: "sandbox",
  chainId: CHAIN,
  identityRegistry: REGISTRY,
  factory: FACTORY,
  gasSeedOffered: false,
  paymentRequired: false,
  linkTtl: { min: 600, max: 85_800, default: 3_600 },
  ...over,
});

/** The operator's latest check; an awaiting company has no check time. */
const check = (
  state: Verification["state"],
  reasonCode: Verification["reasonCode"] = null,
): Verification => ({
  state,
  checkedAt: state === "awaiting_check" ? null : NOW_S - 60,
  reasonCode,
});

/** A customer's own company on sandbox, its check passed. */
const company = (over: Partial<CompanyView> = {}): CompanyView => ({
  companyId: "co_a",
  environment: "sandbox",
  nameOptions: [{ name: "Example Test Holdings LLC", entityTypeEnding: "", position: 1 }],
  legalNameFiled: null,
  businessPurpose: "An existing company",
  industryLabel: "An existing company",
  state: "ready",
  filedAt: null,
  filingNumber: null,
  agents: 0,
  createdAt: NOW - 2 * HOUR,
  provider: "customer",
  declared: {
    companyName: "Example Test Holdings LLC",
    filingNumber: "TEST-0001",
    wordingVersion: "1",
  },
  verification: check("verified"),
  ...over,
});

const production = (state: Verification["state"]) =>
  company({ environment: "production", verification: check(state) });

/** An order view: a live draft an hour old, unless the overrides say otherwise. */
const view = (over: Partial<LegalBodyOrderView> = {}): LegalBodyOrderView => ({
  id: "ord_1",
  publicId: "pub_1",
  companyId: "co_a",
  state: "draft",
  chainId: CHAIN,
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
  createdAt: iso(NOW - HOUR),
  lapseReason: null,
  brokenReason: null,
  revoked: false,
  supersededBy: null,
  replacedBy: null,
  companyName: "Example Test Holdings LLC",
  ...over,
});

/** The overrides of each state past the draft, the guardian owning the identity. */
const RESERVED: Partial<LegalBodyOrderView> = {
  state: "reserved",
  agentId: AGENT,
  identityOwner: GUARDIAN,
  linkDeadline: NOW_S + 3_600,
};
const DEPLOYED: Partial<LegalBodyOrderView> = {
  ...RESERVED,
  state: "deployed",
  bodyAddress: BODY,
  createTxHash: `0x${"cd".repeat(32)}`,
  deployedAt: NOW_S - 60,
};
const LINKED: Partial<LegalBodyOrderView> = {
  ...DEPLOYED,
  state: "linked",
  pointerSeenAt: NOW_S - 30,
};
const BROKEN = (brokenReason: LegalBodyOrderView["brokenReason"]): Partial<LegalBodyOrderView> => ({
  ...LINKED,
  state: "broken",
  brokenReason,
});

const upload = (type: string): FormationDocument => ({
  id: `doc_${type}`,
  type,
  name: `${type}.pdf`,
  size: 1_024,
  sha256: `0x${"ef".repeat(32)}`,
});

const flow = (over: Partial<LegalBodyFlowInput> = {}): LegalBodyFlowInput => ({
  config: config(),
  sessionAddress: GUARDIAN,
  nowMs: NOW,
  company: company(),
  documents: null,
  orders: [],
  order: null,
  ownerChoice: null,
  agentId: null,
  ...over,
});

/** A draft the person has carried to the link: both local choices made. */
const drafted = (over: Partial<LegalBodyFlowInput> = {}) =>
  flow({ order: view(), ownerChoice: "this-wallet", agentId: AGENT, ...over });

describe("the exact values", () => {
  test("a draft lives 24 hours, and a control upload is served with its own type", () => {
    expect(DRAFT_LIFETIME_MS).toBe(86_400_000);
    expect(CONTROL_UPLOAD_TYPE).toBe("evidence_control");
  });
});

describe("sameAddress: lower case on both sides", () => {
  const rows: [string, string | null | undefined, string | null | undefined, boolean][] = [
    ["the same checksummed address", GUARDIAN, GUARDIAN, true],
    ["a checksum and its lower case", GUARDIAN, lower(GUARDIAN), true],
    ["upper case and lower case", upper(GUARDIAN), lower(GUARDIAN), true],
    ["two different addresses", GUARDIAN, OTHER_KEY, false],
    ["an address and null", GUARDIAN, null, false],
    ["undefined and an address", undefined, GUARDIAN, false],
    ["null and null are not one address", null, null, false],
  ];
  test.each(rows)("%s", (_name, a, b, expected) => {
    expect(sameAddress(a, b)).toBe(expected);
  });
});

describe("isDraftExpired and isLiveOrder", () => {
  const rows: [string, LegalBodyOrderView, { expired: boolean; live: boolean }][] = [
    ["a draft an hour old", view(), { expired: false, live: true }],
    [
      "a draft one second short of 24 hours",
      view({ createdAt: iso(NOW - DRAFT_LIFETIME_MS + 1_000) }),
      { expired: false, live: true },
    ],
    [
      "a draft at exactly 24 hours",
      view({ createdAt: iso(NOW - DRAFT_LIFETIME_MS) }),
      { expired: true, live: false },
    ],
    [
      "a draft 25 hours old",
      view({ createdAt: iso(NOW - 25 * HOUR) }),
      { expired: true, live: false },
    ],
    [
      "a draft whose createdAt cannot be parsed counts as expired",
      view({ createdAt: "yesterday-ish" }),
      { expired: true, live: false },
    ],
    ["a revoked draft", view({ revoked: true }), { expired: false, live: false }],
    [
      "a reserved order two days old is not an expired draft",
      view({ ...RESERVED, createdAt: iso(NOW - 48 * HOUR) }),
      { expired: false, live: true },
    ],
    ["a deployed body", view(DEPLOYED), { expired: false, live: true }],
    [
      "a deployed body past the 7-day open window",
      view({ ...DEPLOYED, deployedAt: NOW_S - 8 * DAY_S, createdAt: iso(NOW - 9 * 24 * HOUR) }),
      { expired: false, live: true },
    ],
    ["a revoked deployed body", view({ ...DEPLOYED, revoked: true }), { expired: false, live: false }],
    [
      "a broken body whose pointer was cleared",
      view(BROKEN("not_linked")),
      { expired: false, live: true },
    ],
    [
      "a revoked broken body whose pointer was cleared",
      view({ ...BROKEN("not_linked"), revoked: true }),
      { expired: false, live: false },
    ],
    ["a broken body replaced by a newer one", view(BROKEN("replaced")), { expired: false, live: false }],
    ["a broken body winding down", view(BROKEN("winding_down")), { expired: false, live: false }],
    ["a broken body dissolved", view(BROKEN("dissolved")), { expired: false, live: false }],
    ["a broken body with no reason served", view(BROKEN(null)), { expired: false, live: false }],
    ["a linked body", view(LINKED), { expired: false, live: false }],
    [
      "a lapsed reservation",
      view({ ...RESERVED, state: "lapsed", lapseReason: "deadline_passed" }),
      { expired: false, live: false },
    ],
    [
      "a superseded order",
      view({ ...LINKED, state: "superseded", supersededBy: "ord_9" }),
      { expired: false, live: false },
    ],
    ["an abandoned draft", view({ state: "abandoned" }), { expired: false, live: false }],
  ];
  test.each(rows)("%s", (_name, order, expected) => {
    expect({ expired: isDraftExpired(order, NOW), live: isLiveOrder(order, NOW) }).toStrictEqual(
      expected,
    );
  });
});

describe("deriveLegalBodyPhase: one row per state", () => {
  const rows: [string, LegalBodyFlowInput, LegalBodyDerivation][] = [
    // ── No order: the company step ─────────────────────────────────────────────────────────
    ["no company yet: the declaration form", flow({ company: null }), { phase: "company", companyStep: "form" }],
    [
      "a company filed through formation is not a declaration: the form",
      flow({ company: company({ provider: undefined, declared: undefined, verification: undefined }) }),
      { phase: "company", companyStep: "form" },
    ],
    [
      "an abandoned company: the form again, with its notice",
      flow({ company: company({ state: "abandoned" }) }),
      { phase: "company", companyStep: "form", notice: { kind: "company_abandoned" } },
    ],
    [
      "a company whose checks could not be read: loading",
      flow({ company: company({ verification: null }) }),
      { phase: "company", companyStep: "loading" },
    ],
    ["the sandbox company, its check passed on the first read: the agreement", flow(), { phase: "agreement" }],
    [
      "a production company whose check passed: the agreement, its uploads not needed",
      flow({ company: production("verified") }),
      { phase: "agreement" },
    ],
    [
      "a production company awaiting its check, its uploads not fetched yet: loading",
      flow({ company: production("awaiting_check"), documents: null }),
      { phase: "company", companyStep: "loading" },
    ],
    [
      "a production company awaiting its check, nothing uploaded: evidence",
      flow({ company: production("awaiting_check"), documents: [] }),
      { phase: "company", companyStep: "evidence" },
    ],
    [
      "a production company awaiting its check, only an existence upload: evidence",
      flow({ company: production("awaiting_check"), documents: [upload("evidence_existence")] }),
      { phase: "company", companyStep: "evidence" },
    ],
    [
      "a production company awaiting its check, the control upload in: waiting for the operator",
      flow({
        company: production("awaiting_check"),
        documents: [upload("evidence_existence"), upload(CONTROL_UPLOAD_TYPE)],
      }),
      { phase: "company", companyStep: "waiting" },
    ],
    [
      "a sandbox company awaiting a check: waiting, never an upload, nothing to fetch",
      flow({ company: company({ verification: check("awaiting_check") }), documents: null }),
      { phase: "company", companyStep: "waiting" },
    ],
    [
      "a check that failed: failed, with its reason code",
      flow({ company: company({ verification: check("failed", "name_mismatch") }) }),
      { phase: "company", companyStep: "failed", notice: { kind: "company_failed", reasonCode: "name_mismatch" } },
    ],
    [
      "a check that failed with no reason code",
      flow({ company: company({ verification: check("failed") }) }),
      { phase: "company", companyStep: "failed", notice: { kind: "company_failed", reasonCode: null } },
    ],
    [
      "an operator revoked the sandbox company's check: revoked",
      flow({ company: company({ verification: check("revoked") }) }),
      { phase: "company", companyStep: "revoked", notice: { kind: "company_revoked" } },
    ],
    [
      "the sandbox company reinstated: its fresh automatic pass reads verified, so the agreement",
      flow({ company: company({ verification: { state: "verified", checkedAt: NOW_S, reasonCode: null } }) }),
      { phase: "agreement" },
    ],

    // ── An order made elsewhere ────────────────────────────────────────────────────────────
    [
      "an order made with another factory: closed",
      flow({ order: view({ factory: ANOTHER_FACTORY }) }),
      { phase: "closed", notice: { kind: "other_deployment" } },
    ],
    [
      "an order made on another chain: closed",
      flow({ order: view({ ...LINKED, chainId: 5042 }) }),
      { phase: "closed", notice: { kind: "other_deployment" } },
    ],
    [
      "the factory served in lower case is this deployment",
      flow({ order: view({ factory: lower(FACTORY) }) }),
      { phase: "agreement" },
    ],

    // ── A draft ────────────────────────────────────────────────────────────────────────────
    ["a live draft, the agreement not yet continued", flow({ order: view() }), { phase: "agreement" }],
    [
      "the owner choice made, no identity yet",
      flow({ order: view(), ownerChoice: "this-wallet" }),
      { phase: "identity" },
    ],
    [
      "a draft with a local agentId, this wallet signs: the link in the browser",
      drafted(),
      { phase: "link", branch: "browser" },
    ],
    [
      "a draft with a local agentId, another key signs: the link to paste",
      drafted({ ownerChoice: "elsewhere" }),
      { phase: "link", branch: "paste" },
    ],
    [
      "a revoked draft: closed",
      drafted({ order: view({ revoked: true }) }),
      { phase: "closed", notice: { kind: "order_revoked" } },
    ],
    [
      "an expired draft, not yet swept: closed",
      drafted({ order: view({ createdAt: iso(NOW - 25 * HOUR) }) }),
      { phase: "closed", notice: { kind: "expired" } },
    ],
    [
      "a draft at exactly 24 hours: closed",
      flow({ order: view({ createdAt: iso(NOW - DRAFT_LIFETIME_MS) }) }),
      { phase: "closed", notice: { kind: "expired" } },
    ],
    [
      "a draft one second short of 24 hours is still open",
      flow({ order: view({ createdAt: iso(NOW - DRAFT_LIFETIME_MS + 1_000) }) }),
      { phase: "agreement" },
    ],
    [
      "a draft whose createdAt cannot be parsed counts as expired",
      flow({ order: view({ createdAt: "2026-13-45T99:00:00Z" }) }),
      { phase: "closed", notice: { kind: "expired" } },
    ],
    [
      "a revoked draft that also expired: the revocation is named",
      flow({ order: view({ revoked: true, createdAt: iso(NOW - 25 * HOUR) }) }),
      { phase: "closed", notice: { kind: "order_revoked" } },
    ],
    [
      "an expired draft on a company that failed since: the expiry is named",
      flow({
        order: view({ createdAt: iso(NOW - 25 * HOUR) }),
        company: company({ verification: check("failed", "not_active") }),
      }),
      { phase: "closed", notice: { kind: "expired" } },
    ],
    [
      "a draft on a company that failed its check since: the company's failure",
      drafted({ company: company({ verification: check("failed", "not_active") }) }),
      { phase: "company", companyStep: "failed", notice: { kind: "company_failed", reasonCode: "not_active" } },
    ],
    [
      "a draft on a company revoked since: the company's revocation",
      drafted({ company: company({ verification: check("revoked") }) }),
      { phase: "company", companyStep: "revoked", notice: { kind: "company_revoked" } },
    ],
    [
      "a draft on a sandbox company awaiting a check: waiting, with the notice",
      drafted({ company: company({ verification: check("awaiting_check") }) }),
      { phase: "company", companyStep: "waiting", notice: { kind: "company_awaiting_check" } },
    ],
    [
      "a draft on a reinstated production company, its control upload in: waiting, with the notice",
      drafted({ company: production("awaiting_check"), documents: [upload(CONTROL_UPLOAD_TYPE)] }),
      { phase: "company", companyStep: "waiting", notice: { kind: "company_awaiting_check" } },
    ],
    [
      "a draft on a reinstated production company with nothing uploaded: evidence, with the notice",
      drafted({ company: production("awaiting_check"), documents: [] }),
      { phase: "company", companyStep: "evidence", notice: { kind: "company_awaiting_check" } },
    ],
    [
      "a draft whose company's checks could not be read: loading, with the notice",
      drafted({ company: company({ verification: null }) }),
      { phase: "company", companyStep: "loading", notice: { kind: "company_awaiting_check" } },
    ],
    [
      "a draft whose company was abandoned: the form, with the abandonment",
      drafted({ company: company({ state: "abandoned" }) }),
      { phase: "company", companyStep: "form", notice: { kind: "company_abandoned" } },
    ],

    // ── The identity step's refusal ────────────────────────────────────────────────────────
    [
      "an agentId that already has a linked body is refused",
      drafted({ orders: [view({ ...LINKED, id: "ord_0" }), view()] }),
      { phase: "identity", notice: { kind: "identity_taken", agentId: AGENT } },
    ],
    [
      "an agentId that already has a reserved order is refused",
      drafted({ orders: [view({ ...RESERVED, id: "ord_0" }), view()] }),
      { phase: "identity", notice: { kind: "identity_taken", agentId: AGENT } },
    ],
    [
      "an agentId that already has a deployed body is refused",
      drafted({ orders: [view({ ...DEPLOYED, id: "ord_0" }), view()] }),
      { phase: "identity", notice: { kind: "identity_taken", agentId: AGENT } },
    ],
    [
      "an agentId whose only other order lapsed is not refused",
      drafted({
        orders: [view({ ...RESERVED, id: "ord_0", state: "lapsed", lapseReason: "deadline_passed" }), view()],
      }),
      { phase: "link", branch: "browser" },
    ],
    [
      "another agentId's linked body does not refuse this one",
      drafted({ orders: [view({ ...LINKED, id: "ord_0", agentId: "7" }), view()] }),
      { phase: "link", branch: "browser" },
    ],

    // ── Reserved: the body on its way ──────────────────────────────────────────────────────
    [
      "a reload while reserved: the link step, the body being created, in the browser",
      flow({ order: view(RESERVED) }),
      { phase: "link", branch: "browser", notice: { kind: "creating" } },
    ],
    [
      "reserved, the identity owned by another key: the paste branch on another machine",
      flow({ order: view({ ...RESERVED, identityOwner: OTHER_KEY }) }),
      { phase: "link", branch: "paste", notice: { kind: "creating" } },
    ],
    [
      "reserved, the identity owner served in upper case: still this wallet",
      flow({ order: view({ ...RESERVED, identityOwner: upper(GUARDIAN) }) }),
      { phase: "link", branch: "browser", notice: { kind: "creating" } },
    ],
    [
      "reserved, the session address in lower case: still this wallet",
      flow({ order: view(RESERVED), sessionAddress: lower(GUARDIAN) }),
      { phase: "link", branch: "browser", notice: { kind: "creating" } },
    ],
    [
      "reserved on a company whose check failed since: the order continues",
      flow({ company: company({ verification: check("failed", "not_active") }), order: view(RESERVED) }),
      { phase: "link", branch: "browser", notice: { kind: "creating" } },
    ],

    // ── Deployed: the pointer ──────────────────────────────────────────────────────────────
    ["deployed, this wallet owns the identity: the pointer", flow({ order: view(DEPLOYED) }), { phase: "pointer", branch: "browser" }],
    [
      "deployed, the paste branch on another machine",
      flow({ order: view({ ...DEPLOYED, identityOwner: OTHER_KEY }), ownerChoice: null }),
      { phase: "pointer", branch: "paste" },
    ],
    [
      "deployed, a local owner choice left over from the draft is ignored",
      flow({ order: view({ ...DEPLOYED, identityOwner: OTHER_KEY }), ownerChoice: "this-wallet", agentId: "7" }),
      { phase: "pointer", branch: "paste" },
    ],
    [
      "deployed more than 7 days ago: still the pointer",
      flow({ order: view({ ...DEPLOYED, deployedAt: NOW_S - 8 * DAY_S, createdAt: iso(NOW - 9 * 24 * HOUR) }) }),
      { phase: "pointer", branch: "browser" },
    ],
    [
      "a revoked deployed body: closed",
      flow({ order: view({ ...DEPLOYED, revoked: true }) }),
      { phase: "closed", notice: { kind: "order_revoked" } },
    ],
    [
      "deployed on a company revoked since: still the pointer",
      flow({ company: company({ verification: check("revoked") }), order: view(DEPLOYED) }),
      { phase: "pointer", branch: "browser" },
    ],

    // ── Broken ─────────────────────────────────────────────────────────────────────────────
    [
      "broken, the pointer cleared: the pointer again",
      flow({ order: view(BROKEN("not_linked")) }),
      { phase: "pointer", branch: "browser" },
    ],
    [
      "broken, the pointer cleared, signed elsewhere: the pointer to paste",
      flow({ order: view({ ...BROKEN("not_linked"), identityOwner: OTHER_KEY }) }),
      { phase: "pointer", branch: "paste" },
    ],
    [
      "broken, the pointer cleared, the body revoked: done, with the revocation",
      flow({ order: view({ ...BROKEN("not_linked"), revoked: true }) }),
      { phase: "done", notice: { kind: "order_revoked" } },
    ],
    [
      "broken, replaced by a newer body: closed, naming it",
      flow({ order: view({ ...BROKEN("replaced"), replacedBy: "ord_2" }) }),
      { phase: "closed", notice: { kind: "replaced", by: "ord_2" } },
    ],
    [
      "broken, replaced, the newer order not served: closed",
      flow({ order: view(BROKEN("replaced")) }),
      { phase: "closed", notice: { kind: "replaced", by: null } },
    ],
    [
      "broken, the company winding down: done, with the notice",
      flow({ order: view(BROKEN("winding_down")) }),
      { phase: "done", notice: { kind: "winding_down" } },
    ],
    [
      "broken, the company dissolved: done, with the notice",
      flow({ order: view(BROKEN("dissolved")) }),
      { phase: "done", notice: { kind: "dissolved" } },
    ],
    [
      "broken with no reason served: done, never the pointer",
      flow({ order: view(BROKEN(null)) }),
      { phase: "done", notice: { kind: "broken_reason_unknown" } },
    ],
    [
      "broken while winding down, on a charging deployment with an unpaid company: done, not payment",
      flow({
        config: config({ paymentRequired: true }),
        company: company({ state: "draft" }),
        order: view(BROKEN("winding_down")),
      }),
      { phase: "done", notice: { kind: "winding_down" } },
    ],

    // ── Linked ─────────────────────────────────────────────────────────────────────────────
    ["linked on a deployment that does not charge: done", flow({ order: view(LINKED) }), { phase: "done" }],
    [
      "linked, a left-over owner choice and agentId are ignored: done",
      flow({ order: view(LINKED), ownerChoice: "elsewhere", agentId: "7" }),
      { phase: "done" },
    ],
    [
      "linked on a deployment that does not charge, the company reading draft: done",
      flow({ order: view(LINKED), company: company({ state: "draft" }) }),
      { phase: "done" },
    ],
    [
      "linked on a charging deployment, the company unpaid: payment",
      flow({ config: config({ paymentRequired: true }), company: company({ state: "draft" }), order: view(LINKED) }),
      { phase: "payment" },
    ],
    [
      "linked on a charging deployment, the payment settling: payment",
      flow({ config: config({ paymentRequired: true }), company: company({ state: "paying" }), order: view(LINKED) }),
      { phase: "payment" },
    ],
    [
      "linked on a charging deployment, the company paid: done",
      flow({ config: config({ paymentRequired: true }), order: view(LINKED) }),
      { phase: "done" },
    ],
    [
      "a revoked company with a linked body: done, with the company's revocation",
      flow({ company: company({ verification: check("revoked") }), order: view(LINKED) }),
      { phase: "done", notice: { kind: "company_revoked" } },
    ],
    [
      "a revoked company with a linked body on a charging deployment, unpaid: done, not payment",
      flow({
        config: config({ paymentRequired: true }),
        company: company({ state: "draft", verification: check("revoked") }),
        order: view(LINKED),
      }),
      { phase: "done", notice: { kind: "company_revoked" } },
    ],
    [
      "a revoked linked body: done, with the revocation",
      flow({ order: view({ ...LINKED, revoked: true }) }),
      { phase: "done", notice: { kind: "order_revoked" } },
    ],
    [
      "a revoked linked body of a revoked company: the body's revocation is named",
      flow({ company: company({ verification: check("revoked") }), order: view({ ...LINKED, revoked: true }) }),
      { phase: "done", notice: { kind: "order_revoked" } },
    ],

    // ── Closed ─────────────────────────────────────────────────────────────────────────────
    [
      "lapsed, never seen: closed, with its reason",
      flow({ order: view({ ...RESERVED, state: "lapsed", lapseReason: "deadline_passed" }) }),
      { phase: "closed", notice: { kind: "lapsed", reason: "deadline_passed" } },
    ],
    [
      "lapsed because the identity changed hands: closed, with that reason",
      flow({ order: view({ ...RESERVED, state: "lapsed", lapseReason: "owner_changed" }) }),
      { phase: "closed", notice: { kind: "lapsed", reason: "owner_changed" } },
    ],
    [
      "lapsed with no reason served",
      flow({ order: view({ ...RESERVED, state: "lapsed" }) }),
      { phase: "closed", notice: { kind: "lapsed", reason: null } },
    ],
    [
      "superseded: closed, naming the newer order",
      flow({ order: view({ ...LINKED, state: "superseded", supersededBy: "ord_3" }) }),
      { phase: "closed", notice: { kind: "superseded", by: "ord_3" } },
    ],
    [
      "superseded after a break: closed by its successor, whatever the break's reason says",
      flow({
        order: view({ ...LINKED, state: "superseded", brokenReason: "not_linked", supersededBy: "ord_3" }),
      }),
      { phase: "closed", notice: { kind: "superseded", by: "ord_3" } },
    ],
    [
      "superseded, the newer order not served",
      flow({ order: view({ ...LINKED, state: "superseded" }) }),
      { phase: "closed", notice: { kind: "superseded", by: null } },
    ],
    [
      "an abandoned draft: closed",
      flow({ order: view({ state: "abandoned" }) }),
      { phase: "closed", notice: { kind: "abandoned" } },
    ],
    [
      "a state this build does not know: closed, nothing offered",
      flow({ order: view({ ...LINKED, state: "renamed_later" as BindingState }) }),
      { phase: "closed" },
    ],
  ];

  test.each(rows)("%s", (_name, given, expected) => {
    expect(deriveLegalBodyPhase(given)).toStrictEqual(expected);
  });
});

describe("selectLegalBodyThread: which company or order the page is about", () => {
  const co = (companyId: string, state: Verification["state"] = "verified", over: Partial<CompanyView> = {}) =>
    company({ companyId, verification: check(state), ...over });
  type Selection = Parameters<typeof selectLegalBodyThread>[0];
  const pick = (over: Partial<Selection>): Selection => ({
    companies: [],
    orders: [],
    stored: null,
    nowMs: NOW,
    ...over,
  });

  const rows: [string, Selection, LegalBodyThread][] = [
    // ── Nothing remembered ─────────────────────────────────────────────────────────────────
    ["nothing at all: a new company", pick({}), { kind: "new-company" }],
    [
      "one company whose check passed, no order: that company",
      pick({ companies: [co("a")] }),
      { kind: "company", companyId: "a" },
    ],
    [
      "a company awaiting its check is a thread",
      pick({ companies: [co("a", "awaiting_check")] }),
      { kind: "company", companyId: "a" },
    ],
    [
      "a company whose check failed is a thread",
      pick({ companies: [co("a", "failed")] }),
      { kind: "company", companyId: "a" },
    ],
    ["a revoked company with no order is not a thread", pick({ companies: [co("a", "revoked")] }), { kind: "new-company" }],
    [
      "an abandoned company is not a thread",
      pick({ companies: [co("a", "verified", { state: "abandoned" })] }),
      { kind: "new-company" },
    ],
    [
      "a company filed through formation is not a thread",
      pick({ companies: [co("a", "verified", { provider: undefined, declared: undefined, verification: undefined })] }),
      { kind: "new-company" },
    ],
    [
      "a company whose checks could not be read is not a thread",
      pick({ companies: [co("a", "verified", { verification: null })] }),
      { kind: "new-company" },
    ],
    [
      "several open companies: a chooser, in the served order",
      pick({ companies: [co("a"), co("b", "awaiting_check"), co("c", "failed"), co("d", "revoked")] }),
      {
        kind: "chooser",
        threads: [
          { kind: "company", companyId: "a" },
          { kind: "company", companyId: "b" },
          { kind: "company", companyId: "c" },
        ],
      },
    ],
    [
      "a live order on one company and another company open: a chooser, the order first",
      pick({ companies: [co("a"), co("b")], orders: [view({ id: "o1", companyId: "b" })] }),
      {
        kind: "chooser",
        threads: [
          { kind: "order", companyId: "b", orderId: "o1" },
          { kind: "company", companyId: "a" },
        ],
      },
    ],
    [
      "one live draft: its order",
      pick({ companies: [co("a")], orders: [view({ id: "o1", companyId: "a" })] }),
      { kind: "order", companyId: "a", orderId: "o1" },
    ],
    [
      "a reserved order: its order",
      pick({ companies: [co("a")], orders: [view({ ...RESERVED, id: "o1", companyId: "a" })] }),
      { kind: "order", companyId: "a", orderId: "o1" },
    ],
    [
      "a deployed order past the 7-day open window stays a thread",
      pick({
        companies: [co("a")],
        orders: [view({ ...DEPLOYED, id: "o1", companyId: "a", deployedAt: NOW_S - 8 * DAY_S })],
      }),
      { kind: "order", companyId: "a", orderId: "o1" },
    ],
    [
      "a broken body waiting for its pointer again is a thread",
      pick({ companies: [co("a")], orders: [view({ ...BROKEN("not_linked"), id: "o1", companyId: "a" })] }),
      { kind: "order", companyId: "a", orderId: "o1" },
    ],
    [
      "a revoked broken body is not a thread; its company is",
      pick({
        companies: [co("a")],
        orders: [view({ ...BROKEN("not_linked"), id: "o1", companyId: "a", revoked: true })],
      }),
      { kind: "company", companyId: "a" },
    ],
    [
      "an expired draft is not a thread; its company is",
      pick({ companies: [co("a")], orders: [view({ id: "o1", companyId: "a", createdAt: iso(NOW - 30 * HOUR) })] }),
      { kind: "company", companyId: "a" },
    ],
    [
      "a revoked draft is not a thread; its company is",
      pick({ companies: [co("a")], orders: [view({ id: "o1", companyId: "a", revoked: true })] }),
      { kind: "company", companyId: "a" },
    ],
    [
      "a company whose orders all lapsed is a thread again",
      pick({
        companies: [co("a")],
        orders: [
          view({ ...RESERVED, id: "o1", companyId: "a", state: "lapsed", lapseReason: "deadline_passed" }),
          view({ ...RESERVED, id: "o2", companyId: "a", state: "lapsed", lapseReason: "owner_changed" }),
        ],
      }),
      { kind: "company", companyId: "a" },
    ],
    [
      "a company whose check passed with only linked orders: its done page, not a thread",
      pick({ companies: [co("a")], orders: [view({ ...LINKED, id: "o1", companyId: "a" })] }),
      { kind: "done", companyId: "a", orderId: "o1" },
    ],
    [
      "a linked body and a new live draft on the same company: the draft",
      pick({
        companies: [co("a")],
        orders: [view({ ...LINKED, id: "o1", companyId: "a" }), view({ id: "o2", companyId: "a" })],
      }),
      { kind: "order", companyId: "a", orderId: "o2" },
    ],
    [
      "two linked bodies and nothing open: the newest one's done page",
      pick({
        companies: [co("a"), co("b")],
        orders: [
          view({ ...LINKED, id: "o1", companyId: "a", createdAt: iso(NOW - 3 * HOUR) }),
          view({ ...LINKED, id: "o2", companyId: "b", createdAt: iso(NOW - 2 * HOUR) }),
        ],
      }),
      { kind: "done", companyId: "b", orderId: "o2" },
    ],
    [
      "a revoked company with a linked body: its done page",
      pick({ companies: [co("a", "revoked")], orders: [view({ ...LINKED, id: "o1", companyId: "a" })] }),
      { kind: "done", companyId: "a", orderId: "o1" },
    ],
    [
      "an order whose company is not among the tenant's is ignored",
      pick({ companies: [], orders: [view({ id: "o1", companyId: "z" })] }),
      { kind: "new-company" },
    ],

    // ── The memory of this browser ─────────────────────────────────────────────────────────
    [
      "the stored order picks one of several",
      pick({
        companies: [co("a"), co("b")],
        orders: [view({ id: "o1", companyId: "a" }), view({ id: "o2", companyId: "b" })],
        stored: { companyId: "b", orderId: "o2" },
      }),
      { kind: "order", companyId: "b", orderId: "o2" },
    ],
    [
      "a stored order that lapsed since, never seen: shown once, closed",
      pick({
        companies: [co("a")],
        orders: [view({ ...RESERVED, id: "o1", companyId: "a", state: "lapsed", lapseReason: "deadline_passed" })],
        stored: { companyId: "a", orderId: "o1" },
      }),
      { kind: "closed-order", companyId: "a", orderId: "o1" },
    ],
    [
      "the same lapse on another machine, with no memory: the company, ready for a new order",
      pick({
        companies: [co("a")],
        orders: [view({ ...RESERVED, id: "o1", companyId: "a", state: "lapsed", lapseReason: "deadline_passed" })],
      }),
      { kind: "company", companyId: "a" },
    ],
    [
      "a stored linked order: its done page",
      pick({
        companies: [co("a"), co("b")],
        orders: [view({ ...LINKED, id: "o1", companyId: "a" })],
        stored: { companyId: "a", orderId: "o1" },
      }),
      { kind: "done", companyId: "a", orderId: "o1" },
    ],
    [
      "a stored body broken while winding down: its done page",
      pick({
        companies: [co("a")],
        orders: [view({ ...BROKEN("winding_down"), id: "o1", companyId: "a" })],
        stored: { companyId: "a", orderId: "o1" },
      }),
      { kind: "done", companyId: "a", orderId: "o1" },
    ],
    [
      "a stored revoked broken body: its done page",
      pick({
        companies: [co("a")],
        orders: [view({ ...BROKEN("not_linked"), id: "o1", companyId: "a", revoked: true })],
        stored: { companyId: "a", orderId: "o1" },
      }),
      { kind: "done", companyId: "a", orderId: "o1" },
    ],
    [
      "a stored body broken with no reason served: its done page",
      pick({
        companies: [co("a")],
        orders: [view({ ...BROKEN(null), id: "o1", companyId: "a" })],
        stored: { companyId: "a", orderId: "o1" },
      }),
      { kind: "done", companyId: "a", orderId: "o1" },
    ],
    [
      "a stored body replaced by a newer one: closed",
      pick({
        companies: [co("a")],
        orders: [view({ ...BROKEN("replaced"), id: "o1", companyId: "a", replacedBy: "o2" })],
        stored: { companyId: "a", orderId: "o1" },
      }),
      { kind: "closed-order", companyId: "a", orderId: "o1" },
    ],
    [
      "a stored superseded order: closed",
      pick({
        companies: [co("a")],
        orders: [view({ ...LINKED, id: "o1", companyId: "a", state: "superseded", supersededBy: "o2" })],
        stored: { companyId: "a", orderId: "o1" },
      }),
      { kind: "closed-order", companyId: "a", orderId: "o1" },
    ],
    [
      "a stored draft that expired: closed",
      pick({
        companies: [co("a")],
        orders: [view({ id: "o1", companyId: "a", createdAt: iso(NOW - 30 * HOUR) })],
        stored: { companyId: "a", orderId: "o1" },
      }),
      { kind: "closed-order", companyId: "a", orderId: "o1" },
    ],
    [
      "a stored order id the server does not list falls through",
      pick({ companies: [co("a")], orders: [], stored: { companyId: null, orderId: "o_gone" } }),
      { kind: "company", companyId: "a" },
    ],
    [
      "a stored order of a company that is not the tenant's falls through",
      pick({
        companies: [co("a")],
        orders: [view({ id: "o9", companyId: "z" })],
        stored: { companyId: "z", orderId: "o9" },
      }),
      { kind: "company", companyId: "a" },
    ],
    [
      "the stored company picks one of several open companies",
      pick({ companies: [co("a"), co("b")], stored: { companyId: "b", orderId: null } }),
      { kind: "company", companyId: "b" },
    ],
    [
      "the stored company with one live order: that order",
      pick({
        companies: [co("a"), co("b")],
        orders: [view({ id: "o1", companyId: "a" }), view({ ...RESERVED, id: "o2", companyId: "b" })],
        stored: { companyId: "b", orderId: null },
      }),
      { kind: "order", companyId: "b", orderId: "o2" },
    ],
    [
      "the stored company with two live orders falls through to a chooser of the open threads",
      pick({
        companies: [co("a")],
        orders: [view({ id: "o1", companyId: "a" }), view({ ...RESERVED, id: "o2", companyId: "a" })],
        stored: { companyId: "a", orderId: null },
      }),
      {
        kind: "chooser",
        threads: [
          { kind: "order", companyId: "a", orderId: "o1" },
          { kind: "order", companyId: "a", orderId: "o2" },
        ],
      },
    ],
    [
      "the stored company with a linked body and nothing open falls through to its done page",
      pick({
        companies: [co("a")],
        orders: [view({ ...LINKED, id: "o1", companyId: "a" })],
        stored: { companyId: "a", orderId: null },
      }),
      { kind: "done", companyId: "a", orderId: "o1" },
    ],
    [
      "a stored company revoked since falls through to the other threads",
      pick({ companies: [co("a", "revoked"), co("b")], stored: { companyId: "a", orderId: null } }),
      { kind: "company", companyId: "b" },
    ],
    [
      "a stored order wins over the stored company",
      pick({
        companies: [co("a"), co("b")],
        orders: [view({ id: "o1", companyId: "a" })],
        stored: { companyId: "b", orderId: "o1" },
      }),
      { kind: "order", companyId: "a", orderId: "o1" },
    ],
  ];

  test.each(rows)("%s", (_name, given, expected) => {
    expect(selectLegalBodyThread(given)).toStrictEqual(expected);
  });
});

describe("identityHasBody: an identity with a body on its way or linked is refused", () => {
  const where = { chainId: CHAIN, factory: FACTORY };
  const rows: [string, LegalBodyOrderView[], boolean][] = [
    ["a draft for the agentId", [view({ agentId: AGENT })], false],
    ["a reserved order for the agentId", [view(RESERVED)], true],
    ["a deployed body for the agentId", [view(DEPLOYED)], true],
    ["a linked body for the agentId", [view(LINKED)], true],
    ["a broken body for the agentId", [view(BROKEN("winding_down"))], false],
    ["a live body whose pointer was cleared, for the agentId", [view(BROKEN("not_linked"))], true],
    [
      "a revoked body whose pointer was cleared, for the agentId",
      [view({ ...BROKEN("not_linked"), revoked: true })],
      false,
    ],
    ["a body replaced by a newer one, for the agentId", [view(BROKEN("replaced"))], false],
    ["a lapsed reservation for the agentId", [view({ ...RESERVED, state: "lapsed" })], false],
    ["a superseded order for the agentId", [view({ ...LINKED, state: "superseded" })], false],
    ["an abandoned order for the agentId", [view({ ...RESERVED, state: "abandoned" })], false],
    ["a linked body of another agentId", [view({ ...LINKED, agentId: "7" })], false],
    ["a linked body on another chain", [view({ ...LINKED, chainId: 5042 })], false],
    ["a linked body with another factory", [view({ ...LINKED, factory: ANOTHER_FACTORY })], false],
    ["a linked body, the factory served in lower case", [view({ ...LINKED, factory: lower(FACTORY) })], true],
    ["no order at all", [], false],
  ];
  test.each(rows)("%s", (_name, orders, refused) => {
    expect(identityHasBody(orders, AGENT, where)).toBe(refused);
  });
});

describe("pointerPreflight: the chain reads before any prompt or copy box", () => {
  type Preflight = Parameters<typeof pointerPreflight>[0];
  const base: Preflight = {
    branch: "browser",
    connected: GUARDIAN,
    identityOwner: GUARDIAN,
    ownerOf: GUARDIAN,
    ownerAtCreation: GUARDIAN,
  };
  const rows: [string, Preflight, PointerPreflight][] = [
    ["the owner is the connected wallet and the creator: go", base, { ok: true }],
    [
      "the paste branch: the connected wallet does not matter",
      {
        branch: "paste",
        connected: null,
        identityOwner: OTHER_KEY,
        ownerOf: OTHER_KEY,
        ownerAtCreation: OTHER_KEY,
      },
      { ok: true },
    ],
    ["ownerOf reverted: no such identity", { ...base, ownerOf: "none" }, { ok: false, reason: "no_identity" }],
    [
      "a deployed body after a transfer: the identity moved",
      { ...base, ownerOf: OTHER_KEY },
      { ok: false, reason: "identity_moved" },
    ],
    [
      "the creator differs from the current and recorded owner: the identity moved",
      { ...base, ownerAtCreation: THIRD_KEY },
      { ok: false, reason: "identity_moved" },
    ],
    [
      "the order's identity owner is not the chain's owner: the identity moved",
      { ...base, identityOwner: OTHER_KEY },
      { ok: false, reason: "identity_moved" },
    ],
    [
      "the wallet switched account in the browser: not this wallet",
      { ...base, connected: OTHER_KEY },
      { ok: false, reason: "not_this_wallet" },
    ],
    [
      "no wallet connected on the browser branch: not this wallet",
      { ...base, connected: null },
      { ok: false, reason: "not_this_wallet" },
    ],
    [
      "the same owner in three cases: go",
      { ...base, connected: lower(GUARDIAN), ownerOf: upper(GUARDIAN), ownerAtCreation: lower(GUARDIAN) },
      { ok: true },
    ],
  ];
  test.each(rows)("%s", (_name, given, expected) => {
    expect(pointerPreflight(given)).toStrictEqual(expected);
  });

  test("a deployed body after a transfer: the server still says pointer, the chain reads refuse it", () => {
    // The order keeps the owner recorded at creation; only the chain knows the identity moved.
    const order = view(DEPLOYED);
    expect(deriveLegalBodyPhase(flow({ order }))).toStrictEqual({ phase: "pointer", branch: "browser" });
    expect(
      pointerPreflight({
        branch: "browser",
        connected: GUARDIAN,
        identityOwner: order.identityOwner as Address,
        ownerOf: OTHER_KEY,
        ownerAtCreation: GUARDIAN,
      }),
    ).toStrictEqual({ ok: false, reason: "identity_moved" });
  });
});
