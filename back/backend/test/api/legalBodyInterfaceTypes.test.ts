/**
 * Drift guard: the interface's copies of the legal-body views against this backend's own types.
 *
 * The interface never imports backend code, so it carries its own copy of every union and view the
 * legal-body flow reads: the order, its binding, the link message, the statement message, the
 * agreement, `/config.legalBodies` and the transparency rows. Beside each copy it keeps a runtime
 * list, its members or its keys, written `as const` so this guard has something unambiguous to
 * read. Nothing in either compiler ties the two packages together: a state added here would still
 * build and render there, with no branch for it.
 *
 * Each union and each view is written out ONCE below as an exhaustive record. A
 * `Record<Union, true>` or a `Record<keyof View, true>` cannot be short a key, nor carry one too
 * many: changing the backend's type fails to compile here until the record follows, and the record
 * is then compared with the interface's list, so the change fails CI until the interface's copy
 * follows too.
 *
 * Text-parsed rather than imported, like `formationStatusUnion.test.ts`: the interface package has
 * its own tsconfig and module resolution.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { LegalBodyConfig } from "../../src/api/app";
import type { StatementMessageAnswer } from "../../src/api/routes/customerCompanies";
import type { LegalBodyAgreementAnswer } from "../../src/api/routes/legalBodyOrders";
import type { VerificationState } from "../../src/legalBody/attestation";
import type { BindingView } from "../../src/legalBody/binding";
import type { FilingStatus } from "../../src/legalBody/filings";
import { LINK_FIELDS } from "../../src/legalBody/link";
import type { LinkMessageResult } from "../../src/legalBody/linkDoor";
import type { LegalBodyOrderView } from "../../src/legalBody/orders";
import type { Standing } from "../../src/legalBody/standing";
import type { TransparencyLegalBody } from "../../src/legalBody/statements";
import type { CheckReasonCode } from "../../src/persistence/companyCheckRepository";
import type {
  BindingState,
  BrokenReason,
  LapseReason,
} from "../../src/persistence/legalBodyRepository";

const INTERFACE_TYPES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "interface",
  "src",
  "lib",
  "api",
  "types.ts",
);

// ---------------------------------------------------------------------------------------------
// This backend's unions, each written out once.
// ---------------------------------------------------------------------------------------------

const VERIFICATION_STATES: Record<VerificationState, true> = {
  awaiting_check: true,
  verified: true,
  failed: true,
  revoked: true,
};

const CHECK_REASON_CODES: Record<CheckReasonCode, true> = {
  name_mismatch: true,
  filing_not_found: true,
  not_active: true,
  control_not_shown: true,
  other: true,
};

const BINDING_STATES: Record<BindingState, true> = {
  draft: true,
  reserved: true,
  deployed: true,
  linked: true,
  broken: true,
  lapsed: true,
  superseded: true,
  abandoned: true,
};

const LAPSE_REASONS: Record<LapseReason, true> = {
  deadline_passed: true,
  foreign_body: true,
  owner_changed: true,
  refused_before_send: true,
};

const BROKEN_REASONS: Record<BrokenReason, true> = {
  not_linked: true,
  winding_down: true,
  dissolved: true,
  replaced: true,
};

const STANDINGS: Record<Standing, true> = {
  pending: true,
  active: true,
  unknown: true,
  inactive: true,
};

const FILING_STATUSES: Record<FilingStatus, true> = {
  not_yet_due: true,
  filed: true,
  past_due_unverified: true,
  unverified: true,
};

// ---------------------------------------------------------------------------------------------
// This backend's views, each written out once by its keys.
// ---------------------------------------------------------------------------------------------

const ORDER_VIEW_KEYS: Record<keyof LegalBodyOrderView, true> = {
  id: true,
  publicId: true,
  companyId: true,
  state: true,
  chainId: true,
  factory: true,
  guardian: true,
  amendmentDelay: true,
  agreement: true,
  agentId: true,
  identityOwner: true,
  bodyAddress: true,
  linkDeadline: true,
  createTxHash: true,
  deployedAt: true,
  pointerSeenAt: true,
  createdAt: true,
  lapseReason: true,
  brokenReason: true,
  revoked: true,
  supersededBy: true,
  replacedBy: true,
  companyName: true,
};

const BINDING_VIEW_KEYS: Record<keyof BindingView, true> = {
  state: true,
  agentId: true,
  bodyAddress: true,
  intent: true,
  pointerSeenAt: true,
  nextCheckAt: true,
  brokenReason: true,
  revoked: true,
  supersededBy: true,
  replacedBy: true,
};

/** The answer of a deployment that offers legal bodies: the other arm is `{ available: false }`. */
type AvailableLegalBodyConfig = Extract<LegalBodyConfig, { available: true }>;

const LEGAL_BODY_CONFIG_KEYS: Record<keyof AvailableLegalBodyConfig, true> = {
  available: true,
  declarations: true,
  statements: true,
  environment: true,
  chainId: true,
  identityRegistry: true,
  factory: true,
  gasSeedOffered: true,
  paymentRequired: true,
  linkTtl: true,
};

const STATEMENT_MESSAGE_ANSWER_KEYS: Record<keyof StatementMessageAnswer, true> = {
  typedData: true,
  wordingVersion: true,
  textStatus: true,
};

const LEGAL_BODY_AGREEMENT_KEYS: Record<keyof LegalBodyAgreementAnswer, true> = {
  termsDoc: true,
  manifest: true,
  manifestHash: true,
  textId: true,
  textVersion: true,
  textStatus: true,
};

const LINK_MESSAGE_RESULT_KEYS: Record<keyof LinkMessageResult, true> = {
  typedData: true,
  identityOwner: true,
  deadline: true,
};

const TRANSPARENCY_LEGAL_BODY_KEYS: Record<keyof TransparencyLegalBody, true> = {
  agentId: true,
  publicId: true,
  legalBody: true,
  chainId: true,
  legalName: true,
  filingNumber: true,
  jurisdiction: true,
  entityType: true,
  source: true,
  environment: true,
  standing: true,
  linkedSince: true,
  links: true,
};

// ---------------------------------------------------------------------------------------------
// The interface's lists, read as text.
// ---------------------------------------------------------------------------------------------

/** The text between `export const NAME = [` and the `] as const` that closes it. */
function interfaceListBody(name: string): string {
  const source = readFileSync(INTERFACE_TYPES, "utf8");
  const opening = `export const ${name} = [`;
  const start = source.indexOf(opening);
  expect(start, `${name} must exist in ${INTERFACE_TYPES}`).toBeGreaterThan(-1);
  expect(source.indexOf(opening, start + 1), `${name} must be declared once`).toBe(-1);
  const end = source.indexOf("] as const", start);
  expect(end, `${name} must close with "] as const"`).toBeGreaterThan(start);
  return source.slice(start + opening.length, end);
}

/** The quoted words of an interface list, in their order. */
function interfaceList(name: string): string[] {
  return [...interfaceListBody(name).matchAll(/"([A-Za-z0-9_]+)"/g)].map((m) => m[1] ?? "");
}

/** The `{ name, type }` entries of an interface list, in their order. */
function interfaceFields(name: string): { name: string; type: string }[] {
  return [
    ...interfaceListBody(name).matchAll(
      /\{\s*name:\s*"([A-Za-z0-9_]+)",\s*type:\s*"([A-Za-z0-9_]+)",?\s*\}/g,
    ),
  ].map((m) => ({ name: m[1] ?? "", type: m[2] ?? "" }));
}

/** Compared sorted, so a duplicate on either side fails too. */
const sorted = (words: Iterable<string>): string[] => [...words].sort();

test("the interface's types module is where this guard expects it", () => {
  // If this fails the module moved, and the assertions below would fail for the wrong reason.
  expect(existsSync(INTERFACE_TYPES), INTERFACE_TYPES).toBe(true);
});

describe("each union the interface copies has exactly this backend's members", () => {
  const unions: [list: string, backend: Record<string, true>][] = [
    ["VERIFICATION_STATES", VERIFICATION_STATES],
    ["CHECK_REASON_CODES", CHECK_REASON_CODES],
    ["BINDING_STATES", BINDING_STATES],
    ["LAPSE_REASONS", LAPSE_REASONS],
    ["BROKEN_REASONS", BROKEN_REASONS],
    ["STANDINGS", STANDINGS],
    ["FILING_STATUSES", FILING_STATUSES],
  ];
  test.each(unions)("%s", (list, backend) => {
    expect(sorted(interfaceList(list))).toEqual(sorted(Object.keys(backend)));
  });
});

describe("each view the interface copies has exactly this backend's keys", () => {
  const views: [list: string, backend: Record<string, true>][] = [
    ["LEGAL_BODY_ORDER_VIEW_KEYS", ORDER_VIEW_KEYS],
    ["BINDING_VIEW_KEYS", BINDING_VIEW_KEYS],
    ["LEGAL_BODY_CONFIG_KEYS", LEGAL_BODY_CONFIG_KEYS],
    ["STATEMENT_MESSAGE_ANSWER_KEYS", STATEMENT_MESSAGE_ANSWER_KEYS],
    ["LEGAL_BODY_AGREEMENT_KEYS", LEGAL_BODY_AGREEMENT_KEYS],
    ["LINK_MESSAGE_RESULT_KEYS", LINK_MESSAGE_RESULT_KEYS],
    ["TRANSPARENCY_LEGAL_BODY_KEYS", TRANSPARENCY_LEGAL_BODY_KEYS],
  ];
  test.each(views)("%s", (list, backend) => {
    expect(sorted(interfaceList(list))).toEqual(sorted(Object.keys(backend)));
  });
});

test("the interface's link fields are this backend's, by name and type, in order", () => {
  // The order is the contract's type string: a field moved changes the digest a wallet signs.
  expect(interfaceFields("LINK_FIELDS")).toEqual(
    LINK_FIELDS.map(({ name, type }) => ({ name, type })),
  );
});
