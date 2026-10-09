/**
 * The public page a third party reads to check a legal-body statement must give the type and the
 * domain exactly as the code signs them: a verifier copies them from there. A change to either, in
 * the code or on the page, fails here until the two agree again.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  LEGAL_BODY_STATEMENT_TYPE_STRING,
  PUBLIC_STATEMENT_DOMAIN_NAME,
  PUBLIC_STATEMENT_DOMAIN_VERSION,
} from "../../src/legalBody/publicStatement";

/** The page, found from this file: back/backend/test/docs, up to the repository's docs/identity. */
const PAGE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "docs",
  "identity",
  "legal-body-statement.md",
);

const page = (): string => readFileSync(PAGE, "utf8");

test("the page carries the exact EIP-712 type string, and every type string on it is that one", () => {
  const text = page();
  expect(text).toContain(LEGAL_BODY_STATEMENT_TYPE_STRING);
  // The page may write the type more than once (beside the fields, in an example): each copy is
  // the code's, so a reader can take any of them.
  for (const written of text.match(/LegalBodyStatement\([^)]*\)/g) ?? [])
    expect(written).toBe(LEGAL_BODY_STATEMENT_TYPE_STRING);
});

test("the page writes the domain as the code builds it: its name, its version, the chain id and no contract", () => {
  expect(page()).toContain(
    `{ name: "${PUBLIC_STATEMENT_DOMAIN_NAME}", version: "${PUBLIC_STATEMENT_DOMAIN_VERSION}", chainId }`,
  );
});
