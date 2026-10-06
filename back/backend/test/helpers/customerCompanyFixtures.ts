import type Database from "better-sqlite3";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type WorldIdDeps, buildWorldIdDeps } from "../../src/api/routes/worldId";
import type {
  CustomerCompanyDeps,
  CustomerStatementInput,
} from "../../src/legalBody/customerCompany";
import type { LegalText } from "../../src/legalBody/texts/index";
import {
  STATEMENT_OF_AUTHORITY,
  type StatementFields,
} from "../../src/legalBody/texts/statementOfAuthority";
import type { CompanyCheckRepository } from "../../src/persistence/companyCheckRepository";
import type { CompanyDeclarationRepository } from "../../src/persistence/companyDeclarationRepository";
import type { CompanyRepository } from "../../src/persistence/companyRepository";
import type { SqliteWorldStore } from "../../src/persistence/worldStore";

/**
 * The fixtures every test of a customer's own company shares: the guardians' keys, the
 * deployment's constants, the approved wording, a verified human, World ID, and the dependencies of
 * the customer company doors on a production or a sandbox deployment.
 *
 * Every key is one of anvil's published test accounts, never a real wallet, and every name,
 * company and filing number is an invention.
 */

/** anvil's published accounts #2, #3 and #4: test keys, never real wallets. */
export const ANVIL_ACCOUNT_2 = privateKeyToAccount(
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
);
export const ANVIL_ACCOUNT_3 = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
export const ANVIL_ACCOUNT_4 = privateKeyToAccount(
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
);
export type Signer = typeof ANVIL_ACCOUNT_2;

/** The legal-body factory the statement's domain names, and the chain it lives on. */
export const FACTORY = "0x00000000000000000000000000000000000fAc70" as Address;
export const CHAIN_ID = 31_337;
/** The World ID action a guardian's verification is recorded under. */
export const ACTION = "guardian-verification";
/** Any provider but `customer` is a company filed through formation. */
export const FORMATION_PROVIDER = "example-formation-provider";

/** The draft wording, approved: what a production deployment serves once the wording is final. */
export const APPROVED: LegalText<StatementFields> = {
  ...STATEMENT_OF_AUTHORITY,
  status: "approved",
};

/** A declaration as a sandbox caller sends it: the synthetic flag, and no declarant. */
export const SANDBOX_TYPED: CustomerStatementInput = {
  companyName: "Example Holdings LLC",
  filingNumber: "TEST-0001",
  synthetic: true,
};

/** The stores the customer company doors read and write, over one test database. */
export interface CustomerStores {
  db: Database.Database;
  companies: CompanyRepository;
  declarations: CompanyDeclarationRepository;
  checks: CompanyCheckRepository;
  store: SqliteWorldStore;
}

/** A verification row, recorded as the verify route records one. `verifiedAt` is milliseconds. */
export function recordHuman(
  store: SqliteWorldStore,
  tenantId: Address,
  nullifier: string,
  verifiedAt: number,
  credential = "proof_of_human",
): void {
  const recorded = store.recordVerification({
    nullifier,
    action: ACTION,
    tenantId,
    issuerSchemaId: 1,
    credential,
    environment: "production",
    verifiedAt,
    expiresAtMin: null,
  });
  if (!recorded) throw new Error("the verification row was not recorded");
}

/** World ID wired through its one builder. Enforcement is off on purpose: a declaration needs a
 *  real human whatever that switch says. */
export function worldFor(
  store: SqliteWorldStore,
  opts: { environment?: "production" | "staging"; maxCompaniesPerHuman?: number } = {},
): WorldIdDeps {
  return buildWorldIdDeps(
    {
      appId: "app_test",
      rpId: "rp_test",
      rpSigningKey: `0x${"1".repeat(64)}`,
      action: ACTION,
      environment: opts.environment ?? "production",
      attestMinAge: 18,
      maxCompaniesPerHuman: opts.maxCompaniesPerHuman,
      requireGuardian: false,
    },
    store,
  );
}

/** The doors of a production deployment that charges, serving the approved wording, on the
 *  test's clock (milliseconds). */
export function customerCompanyDeps(
  s: CustomerStores,
  now: () => number,
  over: Partial<CustomerCompanyDeps> = {},
): CustomerCompanyDeps {
  return {
    companies: s.companies,
    declarations: s.declarations,
    checks: s.checks,
    world: worldFor(s.store),
    chainId: CHAIN_ID,
    factory: FACTORY,
    environment: "production",
    text: APPROVED,
    maxOpenPerTenant: 3,
    paymentRequired: true,
    hasOpenLegalBody: () => false,
    transaction: (fn) => s.db.transaction(fn)(),
    now,
    ...over,
  };
}

/** The doors of a sandbox deployment: the draft wording, and a World configuration that is not
 *  production. */
export function sandboxCustomerCompanyDeps(
  s: CustomerStores,
  now: () => number,
  over: Partial<CustomerCompanyDeps> = {},
): CustomerCompanyDeps {
  return customerCompanyDeps(s, now, {
    environment: "sandbox",
    text: STATEMENT_OF_AUTHORITY,
    world: worldFor(s.store, { environment: "staging" }),
    ...over,
  });
}
