/**
 * MCP ↔ REST parity for formation payments (design §6, §7's "one function, three doors").
 *
 * The failure this file exists for is the C8 one, one feature along: `list_companies` had already
 * silently drifted from `GET /companies` once, dropping the business purpose, the industry and
 * both filing facts, and nothing errored — the agent surface was simply less true than the
 * browser one. Here the stakes are a 399 USDC transfer, so the two surfaces are asserted to
 * describe the same payment with the same keys, and to refuse the same things.
 *
 * The other property, and it is a product one: on a deployment that does NOT charge, the payment
 * tools are not registered at all. An agent must not discover a tool whose every call would 404.
 */
import type Database from "better-sqlite3";
import { getAddress, verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { signSession } from "../../src/auth/session";
import type { FormationPaymentConfig } from "../../src/formation/payment";
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from "../../src/payments/transferAuthorization";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationPaymentRepository } from "../../src/persistence/formationPaymentRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { Address, Hex } from "../../src/types";
import { startMcpTestClient } from "./helpers";

const JWT_SECRET = "test-jwt-secret-that-is-long-enough-to-be-plausible";
const guardian = privateKeyToAccount(`0x${"7".repeat(64)}`);
const OWNER = getAddress(guardian.address);
const REVENUE = "0x000000000000000000000000000000000000bEEF" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;

let db: Database.Database;
let repo: SqliteEntityRepository;
let companies: SqliteCompanyRepository;
let requests: SqliteFormationRepository;
let parties: SqliteFormationPartyRepository;
let payments: SqliteFormationPaymentRepository;
let apiKeys: SqliteApiKeyStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  companies = new SqliteCompanyRepository(db);
  requests = new SqliteFormationRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  payments = new SqliteFormationPaymentRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
});
afterEach(() => db.close());

function paymentCfg(required: boolean): FormationPaymentConfig {
  return {
    required,
    feeAtomic: 399_000_000n,
    feeUsdc: 399,
    revenueAddress: REVENUE,
    quoteTtlMs: 30 * 60 * 1000,
    // Present only where the box CHARGES, exactly as the composition root builds it: the token's
    // domain is READ at boot, and a deployment that quotes nothing never reads it (finding B8).
    domain: required
      ? { name: "USDC", version: "2", chainId: 5042002, verifyingContract: USDC }
      : undefined,
    payments,
  };
}

function fakeExecutor() {
  return {
    publicClient: {
      getTransactionCount: async () => 1,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
      sendRawTransaction: async () => `0x${"cc".repeat(32)}`,
      waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({
        status: "success",
        gasUsed: 118_000n,
        transactionHash: hash,
      }),
      readContract: async () => false,
      getBlockNumber: async () => 1_000n,
      getBlock: async () => ({ number: 1_000n, timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
      getLogs: async () => [],
      // Client-bound verification (gate A6); the guardian here is an EOA, so ECDSA is the answer.
      verifyTypedData: async (args: Parameters<typeof verifyTypedData>[0]) => verifyTypedData(args),
      getCode: async () => undefined,
      // biome-ignore lint/suspicious/noExplicitAny: a stub of viem's PublicClient
    } as any,
    walletClient: {
      account: privateKeyToAccount(`0x${"9".repeat(64)}`),
      signTransaction: async () => "0x02aabb",
      // biome-ignore lint/suspicious/noExplicitAny: a two-field stub of viem's WalletClient
    } as any,
    usdc: USDC,
    chainId: 5042002,
  };
}

function app(payment: FormationPaymentConfig) {
  const companyDeps = {
    companies,
    parties,
    requests,
    pin: { provider: "doola", environment: "sandbox" },
    sandboxSyntheticPii: false,
    maxPerTenant: 3,
    dailyCeiling: 10,
    payment,
  };
  return buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    companies,
    apiKeys,
    formationSteps: (id: string) => requests.stepsOf(id),
    company: (id: string) => companies.find(id),
    companyAgents: companies,
    formation: {
      environment: "sandbox",
      required: true,
      sandboxSyntheticPii: false,
      maxPerTenant: 3,
      dailyCeiling: 10,
      maxAgentsPerCompany: 10,
      parties,
      requests,
      companies,
      pin: { provider: "doola", environment: "sandbox" },
      companyDeps,
      payment,
      feeUsdc: 399,
      paymentExecutor: fakeExecutor(),
    },
    // biome-ignore lint/suspicious/noExplicitAny: the app deps are wider than this file needs
  } as any);
}

function seedCompanyWithQuote(): { companyId: string; nonce: Hex } {
  const companyId = companies.create({
    tenantId: OWNER,
    status: "draft",
    provider: "doola",
    environment: "sandbox",
    synthetic: false,
    nameOptions: [{ name: "Acme", entityTypeEnding: "LLC", position: 1 }],
    businessPurpose: "software",
    industryLabel: "Software development",
    intakeSynthesized: false,
  });
  const nonce = `0x${"a1".repeat(32)}` as Hex;
  payments.create({
    companyId,
    product: "formation",
    amountUsdc: 399_000_000n,
    nonce,
    validBefore: Math.floor(Date.now() / 1000) + 1800,
    payTo: REVENUE,
  });
  return { companyId, nonce };
}

async function callTool(
  application: ReturnType<typeof buildApiApp>,
  capability: "read" | "provision",
  name: string,
  args: Record<string, unknown>,
) {
  const { key } = apiKeys.mint(OWNER, { capability });
  const mcp = await startMcpTestClient(application, key);
  try {
    const out = await mcp.client.callTool({ name, arguments: args });
    const content = (out as { content: { text: string }[]; isError?: boolean }).content[0]!.text;
    return { text: content, isError: Boolean((out as { isError?: boolean }).isError) };
  } finally {
    await mcp.close();
  }
}

async function listToolNames(application: ReturnType<typeof buildApiApp>): Promise<string[]> {
  const { key } = apiKeys.mint(OWNER, { capability: "read" });
  const mcp = await startMcpTestClient(application, key);
  try {
    const { tools } = await mcp.client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await mcp.close();
  }
}

test("the ACTION tools are not registered on a deployment that does not charge", async () => {
  const names = await listToolNames(app(paymentCfg(false)));
  expect(names).not.toContain("submit_company_payment");
  expect(names).not.toContain("cancel_company_payment");
  expect(names).not.toContain("requote_company_payment");
  // …but the READ is (finding B8). A box that has STOPPED charging still has to answer "what
  // happened to the fee I paid?" — rolling a flag back must not erase history.
  expect(names).toContain("get_company_payment");
  // …and the ordinary company tools are still there, so this is a payment gate rather than a
  // formation one.
  expect(names).toContain("list_companies");
});

test("⚠ B8: a SETTLED payment is still readable after the flag is rolled back", async () => {
  const { companyId } = seedCompanyWithQuote();
  const row = payments.findLive(companyId, "formation")!;
  payments.markSettling(row.paymentId, {
    payerAddress: OWNER as Address,
    signature: `0x${"11".repeat(65)}`,
  });
  payments.markSettled(row.paymentId, `0x${"cc".repeat(32)}`);

  const { text, isError } = await callTool(app(paymentCfg(false)), "read", "get_company_payment", {
    companyId,
  });
  expect(isError).toBeFalsy();
  const view = JSON.parse(text) as Record<string, unknown>;
  expect(view).toMatchObject({ status: "settled", amountUsdc: "399000000" });
  // No domain, because the token was never read on a box that does not charge — and nothing here
  // is signable anyway.
  expect(view.domain).toBeNull();
});

test("all FOUR are registered where it does — including the re-quote (finding B7)", async () => {
  // REST has four payment doors and MCP had three: an agent whose quote expired could read the
  // expiry, could not act on it, and had no described way to get a new one. "Create another
  // company" is not the answer — it spends the quota and leaves an orphan draft.
  const names = await listToolNames(app(paymentCfg(true)));
  expect(names).toEqual(
    expect.arrayContaining([
      "get_company_payment",
      "submit_company_payment",
      "cancel_company_payment",
      "requote_company_payment",
    ]),
  );
});

test("PARITY: requote_company_payment refuses while live and issues a NEW nonce once terminal", async () => {
  const { companyId, nonce } = seedCompanyWithQuote();
  const application = app(paymentCfg(true));

  const live = await callTool(application, "provision", "requote_company_payment", { companyId });
  expect(live.isError).toBe(true);

  payments.markExpired(payments.findLive(companyId, "formation")!.paymentId, "quoted");
  const { text } = await callTool(application, "provision", "requote_company_payment", {
    companyId,
  });
  const quote = JSON.parse(text) as { nonce: string; paymentId: string };
  expect(quote.nonce).not.toBe(nonce);
  // …and it is the SAME shape the REST door returns: a quote, ready to sign.
  expect(Object.keys(quote).sort()).toEqual(
    [
      "amountDisplayUsdc",
      "amountUsdc",
      "expiresAt",
      "nonce",
      "paymentId",
      "payTo",
      "typedData",
      "validAfter",
      "validBefore",
    ].sort(),
  );
});

test("the create_company description NAMES the fee, the draft state and the four tools (B7)", async () => {
  // An agent's only discovery surface. Told merely that the call "SPENDS", it reports "the
  // company was created" and leaves a guardian with an unfileable draft and an unexplained quote.
  const mcp = await startMcpTestClient(
    app(paymentCfg(true)),
    apiKeys.mint(OWNER, {
      capability: "provision",
    }).key,
  );
  try {
    const { tools } = await mcp.client.listTools();
    const description = tools.find((t) => t.name === "create_company")?.description ?? "";
    expect(description).toContain("$399 USDC");
    expect(description).toContain("draft");
    for (const tool of [
      "get_company_payment",
      "submit_company_payment",
      "cancel_company_payment",
      "requote_company_payment",
    ])
      expect(description).toContain(tool);
    // …and that only the GUARDIAN can settle it, which is the part an agent cannot do for itself.
    expect(description).toMatch(/GUARDIAN'S own wallet|GUARDIAN's own wallet/);
  } finally {
    await mcp.close();
  }
});

test("with payment OFF the same description says formation is included, and names no tools", async () => {
  const mcp = await startMcpTestClient(
    app(paymentCfg(false)),
    apiKeys.mint(OWNER, {
      capability: "provision",
    }).key,
  );
  try {
    const { tools } = await mcp.client.listTools();
    const description = tools.find((t) => t.name === "create_company")?.description ?? "";
    expect(description).toContain("included on this deployment");
    expect(description).not.toContain("submit_company_payment");
  } finally {
    await mcp.close();
  }
});

test("PARITY: get_company_payment answers exactly what GET /companies/:id/payment does", async () => {
  const { companyId } = seedCompanyWithQuote();
  const application = app(paymentCfg(true));

  const { token } = await signSession(OWNER, JWT_SECRET, 3600, Math.floor(Date.now() / 1000));
  const rest = await (
    await application.request(`/companies/${companyId}/payment`, {
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();

  const { text } = await callTool(application, "read", "get_company_payment", { companyId });
  const mcp = JSON.parse(text);

  // Key sets first: a drifted surface usually LOSES a field rather than changing one, and an
  // equality on the whole object would not say which.
  expect(Object.keys(mcp).sort()).toEqual(Object.keys(rest).sort());
  expect(mcp).toEqual(rest);
  // …and the thing that actually matters is present on both: the exact message to sign.
  expect(mcp.quote.typedData.primaryType).toBe("TransferWithAuthorization");
  expect(mcp.quote.typedData.message.to).toBe(REVENUE);
});

test("PARITY: submit_company_payment settles exactly as the REST door does", async () => {
  const { companyId } = seedCompanyWithQuote();
  const application = app(paymentCfg(true));
  const row = payments.findLive(companyId, "formation")!;
  const signature = await guardian.signTypedData({
    domain: { name: "USDC", version: "2", chainId: 5042002, verifyingContract: USDC },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: OWNER,
      to: REVENUE,
      value: row.amountUsdc,
      validAfter: 0n,
      validBefore: BigInt(row.validBefore),
      nonce: row.nonce,
    },
  });
  const { text, isError } = await callTool(application, "provision", "submit_company_payment", {
    companyId,
    signature,
    from: OWNER,
  });
  expect(isError).toBe(false);
  expect(JSON.parse(text).status).toBe("settled");
  expect(companies.find(companyId)?.status).toBe("ready");
});

test("the MCP door refuses the same things the REST door does, in its own words", async () => {
  const { companyId } = seedCompanyWithQuote();
  const application = app(paymentCfg(true));

  // Somebody else's wallet as the payer.
  const wrong = await callTool(application, "provision", "submit_company_payment", {
    companyId,
    signature: `0x${"11".repeat(65)}`,
    from: "0x000000000000000000000000000000000000000b",
  });
  expect(wrong.isError).toBe(true);
  expect(wrong.text).toMatch(/guardian wallet/);

  // An unknown company is the same uniform answer REST gives — never an existence oracle.
  const unknown = await callTool(application, "read", "get_company_payment", {
    companyId: "does-not-exist",
  });
  expect(unknown.isError).toBe(true);
  expect(unknown.text).toBe("company not found");
});

test("a READ key cannot spend: submit and cancel need the provisioning rung", async () => {
  const { companyId } = seedCompanyWithQuote();
  const application = app(paymentCfg(true));
  const denied = await callTool(application, "read", "submit_company_payment", {
    companyId,
    signature: `0x${"11".repeat(65)}`,
    from: OWNER,
  });
  expect(denied.isError).toBe(true);
});

test("NO PII rides on any payment tool — the whole surface is a handle, a signature, an address", async () => {
  const { key } = apiKeys.mint(OWNER, { capability: "read" });
  const mcp = await startMcpTestClient(app(paymentCfg(true)), key);
  try {
    const { tools } = await mcp.client.listTools();
    for (const name of [
      "get_company_payment",
      "submit_company_payment",
      "cancel_company_payment",
      "requote_company_payment",
    ]) {
      const tool = tools.find((t) => t.name === name)!;
      const fields = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      expect(fields.sort()).toEqual(
        name === "get_company_payment" || name === "requote_company_payment"
          ? ["companyId"]
          : name === "cancel_company_payment"
            ? ["companyId", "signature"]
            : ["companyId", "from", "signature"],
      );
    }
  } finally {
    await mcp.close();
  }
});
