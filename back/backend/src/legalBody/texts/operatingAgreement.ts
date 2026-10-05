import type { Address } from "../../types";
import { type LegalText, defineLegalText } from "./index";

/**
 * The operating agreement of a legal body that has no treasury: the text whose hash the legal
 * body's manifest commits to, and so the text the identity owner's link signature reaches.
 *
 * It names the company by its checked name and filing number, each between double quotes, which
 * the field rules forbid inside a field. Only string fields are placeholders: the amendment delay
 * and the chain id are carried by the manifest, beside this text's hash, and the legal body itself
 * records the delay. The final wording is counsel's: when it arrives, it is added as a new version
 * with the status `approved`.
 */
export interface AgreementFields {
  companyName: string;
  filingNumber: string;
  jurisdiction: "WY";
  guardian: Address;
  amendmentDelaySeconds: number;
  chainId: number;
  factory: Address;
  identityRegistry: Address;
}

const OPERATING_AGREEMENT_2026_10_DRAFT_1 = defineLegalText<AgreementFields>({
  id: "legal-body-operating-agreement",
  version: "2026-10-draft-1",
  status: "draft",
  template: [
    '# Operating Agreement of "{companyName}"',
    "",
    "Status: draft. This wording is not yet approved for use with a real company.",
    "",
    "## 1. The Company",
    "",
    '"{companyName}" (the "Company") is a Wyoming limited liability company with filing number "{filingNumber}". This agreement sets out who manages the Company and how its legal body is recorded on chain.',
    "",
    "## 2. The Manager",
    "",
    'The Company is managed by its Manager. The Manager is the guardian of the Legal Body: the person who controls the wallet {guardian} (the "Guardian Wallet"). An act of the Manager under this agreement that is recorded on chain is made by a signature of the Guardian Wallet.',
    "",
    "## 3. The Legal Body",
    "",
    'The Company\'s legal body (the "Legal Body") is a contract created on chain by the factory contract at {factory} (the "Factory"). The Factory records that it created the Legal Body. The Legal Body records the Guardian Wallet, the amendment delay, the agent identity it was created for, and the hash of a manifest that commits to the hash of this agreement.',
    "",
    "The agent identity is held in the identity registry at {identityRegistry}. The Legal Body is linked to that identity when the identity's owner writes a pointer to the Legal Body in the identity's metadata.",
    "",
    "## 4. Amendments",
    "",
    "This agreement is amended only when all of the following hold:",
    "",
    "- (a) the Manager has signed the amendment with the Guardian Wallet;",
    "- (b) the amendment has been scheduled on chain through the Factory; and",
    "- (c) the amendment delay recorded in the Legal Body has passed since it was scheduled, without a veto by the Manager.",
    "",
    "The amendment delay is at least forty-eight hours and at most thirty days. The Factory cannot amend this agreement without the Manager's signature, and it cannot dissolve the Legal Body or move any asset held by it.",
    "",
    "## 5. No treasury",
    "",
    "The Legal Body has no treasury and no spending policy. This agreement gives no person, wallet or contract a right to hold, spend or move funds for the Company through the Legal Body.",
    "",
  ].join("\n"),
});

/**
 * Every version of the agreement, oldest first. A changed text is a NEW entry at the end. An entry
 * is never edited or removed: a stored agreement names the version it was made under.
 */
export const LEGAL_BODY_OPERATING_AGREEMENT_VERSIONS: readonly LegalText<AgreementFields>[] =
  Object.freeze([OPERATING_AGREEMENT_2026_10_DRAFT_1]);

/** The version new agreements are made under: the newest. */
export const LEGAL_BODY_OPERATING_AGREEMENT: LegalText<AgreementFields> =
  OPERATING_AGREEMENT_2026_10_DRAFT_1;
