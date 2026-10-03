import type { Address } from "../../types";
import { type LegalText, defineLegalText } from "./index";

/**
 * The statement of authority: the sentence a guardian signs to declare an existing Wyoming LLC as
 * the company behind a legal body.
 *
 * Each field stands between double quotes, which the field rules forbid inside a field, so a name
 * can never be mistaken for the sentence's own words. The final wording is counsel's: when it
 * arrives, it is added as a new version with the status `approved`.
 */
export interface StatementFields {
  declarantName: string;
  declarantTitle: string;
  companyName: string;
  jurisdiction: "WY";
  filingNumber: string;
  guardian: Address;
}

const STATEMENT_2026_10_DRAFT_1 = defineLegalText<StatementFields>({
  id: "statement-of-authority",
  version: "2026-10-draft-1",
  status: "draft",
  template:
    'I, "{declarantName}", "{declarantTitle}" of "{companyName}", a Wyoming limited liability company with filing number "{filingNumber}", declare that I am authorised to bind that company, and that the wallet {guardian} acts as its guardian for this legal body.',
});

/**
 * Every version of the statement, oldest first. A changed sentence is a NEW entry at the end. An
 * entry is never edited or removed: a stored declaration names the version it was made under.
 */
export const STATEMENT_OF_AUTHORITY_VERSIONS: readonly LegalText<StatementFields>[] = Object.freeze(
  [STATEMENT_2026_10_DRAFT_1],
);

/** The version new declarations are made under: the newest. */
export const STATEMENT_OF_AUTHORITY: LegalText<StatementFields> = STATEMENT_2026_10_DRAFT_1;
