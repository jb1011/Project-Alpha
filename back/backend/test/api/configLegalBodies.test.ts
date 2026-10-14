/**
 * `/config.legalBodies`: whether and how this deployment offers legal bodies on customer-owned
 * identities. A client reads it before sign-in to learn the chain, the identity registry and the
 * factory it will sign for, the link window it may ask for, and which doors are mounted. Public
 * facts only: the chain id and the two contract addresses every manifest and signed statement
 * already carries, and booleans.
 *
 * Also the named answers of three routes: the statement to sign, the agreement and the public
 * statement by agent. Each answers exactly the keys of its exported type, and the keys a test
 * expects are written as a record of that type, so a key the type gains or loses fails here.
 *
 * The database is real (in memory) and the chain is never called, except by the statement
 * service, which reads a fake one. Every key is one of anvil's published test accounts, every
 * other address a placeholder, and every name and filing number an invention.
 */
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type ApiDeps,
  type LegalBodyConfig,
  buildApiApp,
  legalBodyConfigOf,
} from "../../src/api/app";
import type { StatementMessageAnswer } from "../../src/api/routes/customerCompanies";
import type { LegalBodyAgreementAnswer } from "../../src/api/routes/legalBodyOrders";
import type { ByAgentAnswer } from "../../src/api/routes/legalBodyStatements";
import { COMPANY_REUSE_DISCLOSURE, PARK_COPY, SSN_COPY } from "../../src/formation";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { CustomerCompanyDeps } from "../../src/legalBody/customerCompany";
import type { GasSeedDeps } from "../../src/legalBody/gasSeed";
import type { LegalBodyOrderDeps } from "../../src/legalBody/orders";
import type { LegalBodyStatementDeps } from "../../src/legalBody/statements";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteDocumentIndexRepository } from "../../src/persistence/documentIndexRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import {
  ANVIL_ACCOUNT_3,
  SANDBOX_TYPED,
  customerCompanyDeps,
  recordHuman,
  sandboxCustomerCompanyDeps,
} from "../helpers/customerCompanyFixtures";
import { DeletableMemoryDocumentStore } from "../helpers/deletableDocumentStore";
import {
  JWT_SECRET,
  OTHER_FACTORY,
  REGISTRY,
  answerOf,
  call,
  customerCompany,
  legalBodyOrderDeps,
  sessionOf,
} from "../helpers/legalBodyFixtures";
import {
  CLOCK_MS,
  FakeStatementChain,
  type StatementStores,
  TEST_ATTESTOR,
  bodyIn,
  openStatementStores,
  passedCheck,
  readyCompany,
  statementDeps,
} from "../helpers/legalBodyStatementFixtures";

/** anvil's published account #3: a test key, never a real wallet. */
const owner = ANVIL_ACCOUNT_3;

/** The chain, factory and registry the order deps name, which differ from the API's own `chainId`
 *  and `identityRegistry` below, so the answer is shown to read the order deps. The addresses are
 *  placeholders. */
const ORDERS_CHAIN_ID = 5_042_002;
const ORDERS_FACTORY = OTHER_FACTORY;
const ORDERS_REGISTRY = REGISTRY;
const API_CHAIN_ID = 1;
const API_REGISTRY: Address = "0x00000000000000000000000000000000000A8004";

/** The keys `/config` carried before `legalBodies`, with the values the deps below give them: no
 *  formation block and no AgentBook submitter key. */
const PREVIOUS_CONFIG = {
  walletProviderDefault: "turnkey",
  circleCustodyAvailable: false,
  turnkeyCustodyAvailable: true,
  formationAvailable: false,
  formationEnvironment: null,
  formationRequired: false,
  formationPaymentRequired: false,
  formationFeeUsdc: null,
  formationCopy: { ssn: SSN_COPY, park: PARK_COPY, reuseDisclosure: COMPANY_REUSE_DISCLOSURE },
  agentBookRegistrationAvailable: false,
};

type OfferedConfig = Extract<LegalBodyConfig, { available: true }>;

/** The keys of `T`, sorted, from a record that names each of them once: the compiler refuses a
 *  record that misses a key of `T` or names one `T` does not have. */
function keysOf<T>(record: Record<keyof T, true>): string[] {
  return Object.keys(record).sort();
}

let s: StatementStores;

beforeEach(() => {
  s = openStatementStores();
  // The doors and the statement service write ops lines: kept off stdout here.
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  s.db.close();
});

/** The order deps of a sandbox deployment over this test's stores, on the chain and registry
 *  above unless told otherwise. */
function orderDeps(over: Partial<LegalBodyOrderDeps> = {}): LegalBodyOrderDeps {
  return legalBodyOrderDeps(s, {
    deployment: { chainId: ORDERS_CHAIN_ID, factory: ORDERS_FACTORY },
    identityRegistry: ORDERS_REGISTRY,
    ...over,
  });
}

/** The gas seed's door at `amountWei`. `/config` reads only the amount, so every chain member
 *  throws. */
function gasSeed(orders: LegalBodyOrderDeps, amountWei: bigint): GasSeedDeps {
  const never = (member: string) => () => {
    throw new Error(`the gas seed was asked for ${member}`);
  };
  return {
    orders,
    amountWei,
    readCode: never("readCode"),
    readBalance: never("readBalance"),
    estimateTransferGas: never("estimateTransferGas"),
    checkOutflow: never("checkOutflow"),
    prepareTransfer: never("prepareTransfer"),
    sendPrepared: never("sendPrepared"),
    recordOutflow: never("recordOutflow"),
  };
}

interface AppOptions {
  legalBodyOrders?: LegalBodyOrderDeps;
  customerCompanies?: CustomerCompanyDeps;
  legalBodyStatements?: LegalBodyStatementDeps;
  legalBodyGasSeed?: GasSeedDeps;
  now?: () => number;
}

/** The API over this test's database, with only the legal-body deps given wired. */
function makeApp(o: AppOptions = {}) {
  const documents = new SqliteDocumentIndexRepository(s.db);
  const docStore = new DeletableMemoryDocumentStore();
  const deps: Partial<ApiDeps> = {
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    chainId: API_CHAIN_ID,
    identityRegistry: API_REGISTRY,
    now: o.now,
    repo: new SqliteEntityRepository(s.db),
    companies: s.companies,
    documents,
    docStore,
    customerFacts: { declarations: s.declarations, checks: s.checks },
    customerCompanies: o.customerCompanies && { ...o.customerCompanies, documents, docStore },
    legalBodyOrders: o.legalBodyOrders,
    legalBodyGasSeed: o.legalBodyGasSeed,
    legalBodyStatements: o.legalBodyStatements,
    apiKeys: new SqliteApiKeyStore(s.db),
    passkeys: new SqlitePasskeyStore(s.db),
    jobs: new SqliteJobRepository(s.db),
    runner: {} as never,
    platformManagerAddress: "0x000000000000000000000000000000000000000A",
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: false,
    turnkeyCustodyAvailable: true,
  };
  return buildApiApp(deps as ApiDeps);
}

/** The whole `/config` body, read without a session. */
async function configOf(o: AppOptions = {}) {
  const res = await answerOf(await makeApp(o).request("/config", { method: "GET" }));
  expect(res.status).toBe(200);
  return res;
}

// ── /config.legalBodies ──────────────────────────────────────────────────────────────────────

describe("/config.legalBodies", () => {
  test("without the order deps: { available: false } and nothing else", async () => {
    const { body } = await configOf();
    expect(body.legalBodies).toEqual({ available: false });
  });

  test("with the order deps and no customer doors: offered, on the order deps' chain, registry and factory, with the served link window", async () => {
    const orders = orderDeps();
    const { body } = await configOf({ legalBodyOrders: orders });
    expect(body.legalBodies).toEqual({
      available: true,
      declarations: false,
      statements: false,
      environment: "sandbox",
      chainId: ORDERS_CHAIN_ID,
      identityRegistry: ORDERS_REGISTRY,
      factory: ORDERS_FACTORY,
      gasSeedOffered: false,
      paymentRequired: false,
      linkTtl: { min: 600, max: 85_800, default: 3_600 },
    });
  });

  test("the environment is the order deps' own", async () => {
    const { body } = await configOf({
      legalBodyOrders: orderDeps({ environment: "production" }),
    });
    expect(body.legalBodies.environment).toBe("production");
  });

  test("with customer doors that charge: declarations and paymentRequired", async () => {
    const { body } = await configOf({
      legalBodyOrders: orderDeps(),
      customerCompanies: customerCompanyDeps(s, () => Date.now()),
    });
    expect(body.legalBodies).toMatchObject({ declarations: true, paymentRequired: true });
  });

  test("with customer doors that do not charge: declarations, and no payment", async () => {
    const { body } = await configOf({
      legalBodyOrders: orderDeps(),
      customerCompanies: sandboxCustomerCompanyDeps(s, () => Date.now(), {
        paymentRequired: false,
      }),
    });
    expect(body.legalBodies).toMatchObject({ declarations: true, paymentRequired: false });
  });

  test("with the statement wired: statements, and neither its attestor nor its links in the answer", async () => {
    const { body } = await configOf({
      legalBodyOrders: orderDeps(),
      legalBodyStatements: statementDeps(s, new FakeStatementChain()),
    });
    expect(body.legalBodies.statements).toBe(true);
    const served = JSON.stringify(body.legalBodies).toLowerCase();
    expect(served).not.toContain(TEST_ATTESTOR.address.toLowerCase());
    expect(served).not.toContain("://");
    expect(served).not.toContain("example.test");
  });

  test("the gas seed is offered only above zero", async () => {
    const orders = orderDeps();
    const offered = async (o: AppOptions) => (await configOf(o)).body.legalBodies.gasSeedOffered;
    expect(await offered({ legalBodyOrders: orders })).toBe(false);
    expect(await offered({ legalBodyOrders: orders, legalBodyGasSeed: gasSeed(orders, 0n) })).toBe(
      false,
    );
    expect(await offered({ legalBodyOrders: orders, legalBodyGasSeed: gasSeed(orders, 1n) })).toBe(
      true,
    );
  });

  test("the offered answer has exactly the ten keys of its type, and the link window exactly three", async () => {
    const orders = orderDeps();
    const { body } = await configOf({
      legalBodyOrders: orders,
      customerCompanies: customerCompanyDeps(s, () => Date.now()),
      legalBodyStatements: statementDeps(s, new FakeStatementChain()),
      legalBodyGasSeed: gasSeed(orders, 1n),
    });
    const keys = Object.keys(body.legalBodies).sort();
    expect(keys).toEqual(
      keysOf<OfferedConfig>({
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
      }),
    );
    expect(keys).toHaveLength(10);
    expect(Object.keys(body.legalBodies.linkTtl).sort()).toEqual(
      keysOf<OfferedConfig["linkTtl"]>({ min: true, max: true, default: true }),
    );
  });

  test("the whole body still carries every key it carried before, and legalBodies comes after agentBookRegistrationAvailable", async () => {
    const orders = orderDeps();
    for (const o of [
      {},
      {
        legalBodyOrders: orders,
        customerCompanies: customerCompanyDeps(s, () => Date.now()),
        legalBodyStatements: statementDeps(s, new FakeStatementChain()),
        legalBodyGasSeed: gasSeed(orders, 1n),
      },
    ] satisfies AppOptions[]) {
      const { body } = await configOf(o);
      expect(body).toMatchObject(PREVIOUS_CONFIG);
      const keys = Object.keys(body);
      for (const key of Object.keys(PREVIOUS_CONFIG)) expect(keys, key).toContain(key);
      expect(keys.indexOf("legalBodies")).toBe(keys.indexOf("agentBookRegistrationAvailable") + 1);
    }
  });

  test("legalBodyConfigOf is what /config serves", async () => {
    expect(legalBodyConfigOf({})).toEqual({ available: false });
    const orders = orderDeps();
    const wired = {
      legalBodyOrders: orders,
      customerCompanies: customerCompanyDeps(s, () => Date.now()),
      legalBodyStatements: statementDeps(s, new FakeStatementChain()),
      legalBodyGasSeed: gasSeed(orders, 1n),
    };
    const { body } = await configOf(wired);
    expect(body.legalBodies).toEqual(
      legalBodyConfigOf({
        ...wired,
        customerCompanies: {
          ...wired.customerCompanies,
          documents: new SqliteDocumentIndexRepository(s.db),
          docStore: new DeletableMemoryDocumentStore(),
        },
      }),
    );
  });
});

// ── the three named answers ──────────────────────────────────────────────────────────────────

describe("each named answer carries exactly the keys of its type", () => {
  test("the statement to sign: StatementMessageAnswer", async () => {
    recordHuman(s.store, owner.address, "6001", Date.now());
    const app = makeApp({
      customerCompanies: sandboxCustomerCompanyDeps(s, () => Date.now(), {
        paymentRequired: false,
      }),
    });
    const token = await sessionOf(owner);
    const res = await answerOf(
      await call(app, "POST", "/companies/customer/statement-message", token, SANDBOX_TYPED),
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      keysOf<StatementMessageAnswer>({ typedData: true, wordingVersion: true, textStatus: true }),
    );
  });

  test("the agreement: LegalBodyAgreementAnswer", async () => {
    recordHuman(s.store, owner.address, "6002", Date.now());
    const app = makeApp({ legalBodyOrders: orderDeps() });
    const token = await sessionOf(owner);
    const companyId = customerCompany(s, owner.address);
    const placed = await answerOf(
      await call(app, "POST", "/legal-body-orders", token, { companyId }),
    );
    expect(placed.status).toBe(201);
    const res = await answerOf(
      await call(app, "GET", `/legal-body-orders/${placed.body.id}/agreement`, token),
    );
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(
      keysOf<LegalBodyAgreementAnswer>({
        termsDoc: true,
        manifest: true,
        manifestHash: true,
        textId: true,
        textVersion: true,
        textStatus: true,
      }),
    );
  });

  describe("the public statement by agent: ByAgentAnswer, arm by arm", () => {
    let chain: FakeStatementChain;
    beforeEach(() => {
      chain = new FakeStatementChain();
    });

    const byAgent = async (agentId: string) => {
      const app = makeApp({ legalBodyStatements: statementDeps(s, chain), now: () => CLOCK_MS });
      const res = await answerOf(await app.request(`/legal-bodies/by-agent/${agentId}`, {}));
      expect(res.status).toBe(200);
      return res.body;
    };

    /** A linked row of a ready company whose check passed, for agent 42, linked on chain too. */
    const linkedBody = () => {
      const companyId = readyCompany(s);
      s.checks.append(passedCheck(companyId));
      chain.link(bodyIn("linked", s, companyId, { agentId: "42" }));
    };

    test("no legal body", async () => {
      const body = await byAgent("7");
      expect(body.legalBody).toBe(false);
      expect(Object.keys(body).sort()).toEqual(
        keysOf<Extract<ByAgentAnswer, { legalBody: false }>>({
          agentId: true,
          legalBody: true,
          standing: true,
          checkedAt: true,
        }),
      );
    });

    test("a chain read that failed: unknown, unsigned", async () => {
      linkedBody();
      chain.beforeSnapshot = () => {
        throw new Error("the node did not answer");
      };
      const body = await byAgent("42");
      expect(body.standing).toBe("unknown");
      expect(Object.keys(body).sort()).toEqual(
        keysOf<Extract<ByAgentAnswer, { statement: null }>>({
          agentId: true,
          legalBody: true,
          standing: true,
          publicId: true,
          network: true,
          links: true,
          checkedAt: true,
          statement: true,
        }),
      );
    });

    test("a signed statement", async () => {
      linkedBody();
      const body = await byAgent("42");
      expect(body.statement).not.toBeNull();
      expect(Object.keys(body).sort()).toEqual(
        keysOf<Extract<ByAgentAnswer, { publicId: string }>>({
          agentId: true,
          legalBody: true,
          standing: true,
          publicId: true,
          network: true,
          links: true,
          checkedAt: true,
          statement: true,
        }),
      );
    });
  });
});
