/**
 * PII intake + the formation door on MCP (design §3/§5).
 *
 * The point of this file is the MIRROR: `create_formation_party` accepts exactly what
 * `POST /formation-party` accepts, `onboard_agent` runs the SAME gate in the SAME order as
 * `POST /onboard`, and both refuse with the same single-sourced strings. An agent-first caller
 * and a wizard user must be able to reach identical outcomes — and identical refusals.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GuardianPasskey } from "../../src/adapters/turnkey/provisioner";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { ssnNotOnThisDoorMessage } from "../../src/formation";
import { createCompany, shimCompanyIntake } from "../../src/formation/company";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteCompanyRepository } from "../../src/persistence/companyRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { OnboardingRunner } from "../../src/workflow/runner";
import { TEST_FUND_CAPS } from "../helpers/fundCaps";
import { startMcpTestClient } from "./helpers";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";
const PLATFORM_MANAGER = "0x000000000000000000000000000000000000000E";

const VALID_PASSKEY: GuardianPasskey = {
  authenticatorName: "Test Key",
  challenge: "Y2hhbGxlbmdl",
  attestation: {
    credentialId: "cred-1",
    clientDataJson: "e30=",
    attestationObject: "o2M=",
    transports: ["internal"],
  },
};

const VALID_SPEC = {
  name: "TestFormationAgent",
  roles: {
    manager: "0x000000000000000000000000000000000000000C",
    guardian: "0x000000000000000000000000000000000000000C",
  },
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000000D",
    spendingCapUsdc: "100.00",
    spendingPeriod: "30d",
  },
  governance: { amendmentDelay: "24h" },
};

const REAL_PARTY = {
  legalFirstName: "Ada",
  legalLastName: "Lovelace",
  email: "ada@example.com",
  phone: "+12125550100",
  address: {
    line1: "1 Analytical Way",
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
  },
};

let db: Database.Database;
let repo: SqliteEntityRepository;
let parties: SqliteFormationPartyRepository;
let apiKeys: SqliteApiKeyStore;
let passkeys: SqlitePasskeyStore;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  passkeys = new SqlitePasskeyStore(db);
});
afterEach(() => db.close());

function buildTestApp(
  formation?: { required?: boolean; syntheticPii?: boolean; maxPerTenant?: number },
  custody: { circle?: boolean; turnkey?: boolean } = {},
) {
  const companies = new SqliteCompanyRepository(db);
  const requests = new SqliteFormationRepository(db);
  const pin = { provider: "doola" as const, environment: "sandbox" as const };
  // ONE dependency set for all three doors, exactly as the composition root builds it — only the
  // transaction differs per call site.
  const companyDeps = {
    companies,
    parties,
    requests,
    pin,
    sandboxSyntheticPii: formation?.syntheticPii ?? false,
    maxPerTenant: formation?.maxPerTenant ?? 3,
    dailyCeiling: 10,
  };
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
    // The A1 shim: a party-only onboard mints its 1:1 company inside the claim (design §10).
    formation: formation
      ? {
          companies,
          requests,
          maxAgentsPerCompany: 10,
          createCompanyForParty: (tenantId: string, intake: { partyId: string; name: string }) => {
            const result = createCompany(
              { ...companyDeps, transaction: (fn) => fn() },
              tenantId,
              // The SHARED mapping (A2), not a literal: four copies of "what the shim sends" is
              // four chances for it to mean something different on one surface.
              shimCompanyIntake(intake, formation.syntheticPii ?? false),
            );
            if ("error" in result) throw new Error(result.error);
            return result.companyId;
          },
        }
      : undefined,
  });
  return buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: "wizard.local",
    chainId: 5042002,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo,
    runner,
    passkeyRpId: "wizard.local",
    apiKeys,
    passkeys,
    jobs: new SqliteJobRepository(db),
    platformManagerAddress: PLATFORM_MANAGER,
    walletProviderDefault: "turnkey",
    circleCustodyAvailable: custody.circle ?? true,
    turnkeyCustodyAvailable: custody.turnkey ?? true,
    formation: formation
      ? {
          environment: "sandbox" as const,
          required: formation.required ?? true,
          sandboxSyntheticPii: formation.syntheticPii ?? false,
          maxPerTenant: formation.maxPerTenant ?? 3,
          dailyCeiling: 10,
          maxAgentsPerCompany: 10,
          parties,
          requests,
          companies,
          pin,
          companyDeps,
        }
      : undefined,
    companies,
  } as never);
}

async function withClient<T>(
  app: ReturnType<typeof buildApiApp>,
  key: string,
  fn: (c: Awaited<ReturnType<typeof startMcpTestClient>>["client"]) => Promise<T>,
): Promise<T> {
  const { client, close } = await startMcpTestClient(app, key);
  try {
    return await fn(client);
  } finally {
    await close();
  }
}

const textOf = (res: unknown) => (res as { content: { text: string }[] }).content[0]?.text ?? "";

// ── create_formation_party ──────────────────────────────────────────────────────────────────

test("the tool exists only where formation does, and its description carries the capability note", async () => {
  const on = buildTestApp({ required: true });
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const names = await withClient(on, key, async (c) =>
    (await c.listTools()).tools.map((t) => t.name),
  );
  expect(names).toContain("create_formation_party");
  const desc = await withClient(
    on,
    key,
    async (c) => (await c.listTools()).tools.find((t) => t.name === "onboard_agent")!.description!,
  );
  // An agent-first caller has no GET /config: the description IS its discovery surface.
  expect(desc).toMatch(/Formation is REQUIRED on this deployment \(doola, sandbox\)/);

  const off = buildTestApp(undefined);
  const { key: key2 } = apiKeys.mint(TENANT, { capability: "provision" });
  const offNames = await withClient(off, key2, async (c) =>
    (await c.listTools()).tools.map((t) => t.name),
  );
  expect(offNames).not.toContain("create_formation_party");
});

test("real PII in, an opaque handle out — and the tenant is the KEY's, never an argument", async () => {
  const app = buildTestApp({ required: true });
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const out = await withClient(app, key, async (c) =>
    textOf(await c.callTool({ name: "create_formation_party", arguments: REAL_PARTY })),
  );
  const { partyId } = JSON.parse(out);
  expect(Object.keys(JSON.parse(out))).toEqual(["partyId"]);
  expect(parties.findOwned(TENANT, partyId)).toBeDefined();
  expect(parties.findOwned(OTHER, partyId)).toBeUndefined();
});

test("C6: create_formation_party refuses a real party with no phone, exactly as REST does", async () => {
  // Both intake surfaces run the SAME `FormationPartySchema`, so a phone-less identity cannot
  // enter the table through the agent-first door either.
  const app = buildTestApp({ required: true });
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const { phone: _dropped, ...noPhone } = REAL_PARTY;
  const res = await withClient(app, key, async (c) =>
    c.callTool({ name: "create_formation_party", arguments: noPhone }),
  );
  expect((res as { isError?: boolean }).isError).toBe(true);
  expect(textOf(res)).toMatch(/phone/i);
  expect(db.prepare("SELECT COUNT(*) AS n FROM formation_parties").get()).toEqual({ n: 0 });
});

test("it needs the provision capability and a tenant-wide key (onboard_agent's rung)", async () => {
  const app = buildTestApp({ required: true });
  const { key: readKey } = apiKeys.mint(TENANT, { capability: "read" });
  const res = await withClient(app, readKey, async (c) =>
    c.callTool({ name: "create_formation_party", arguments: REAL_PARTY }),
  );
  expect((res as { isError?: boolean }).isError).toBe(true);
  expect(textOf(res)).toBe("not authorized");
});

test("the synthetic rule is refused in BOTH directions, with the REST wording", async () => {
  const sandbox = buildTestApp({ required: true, syntheticPii: true });
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const refused = await withClient(sandbox, key, async (c) =>
    c.callTool({ name: "create_formation_party", arguments: REAL_PARTY }),
  );
  expect((refused as { isError?: boolean }).isError).toBe(true);
  expect(textOf(refused)).toMatch(/FORMATION_SANDBOX_SYNTHETIC_PII/);

  const ok = await withClient(sandbox, key, async (c) =>
    textOf(await c.callTool({ name: "create_formation_party", arguments: { synthetic: true } })),
  );
  expect(parties.findOwned(TENANT, JSON.parse(ok).partyId)!.synthetic).toBe(true);

  const prod = buildTestApp({ required: true, syntheticPii: false });
  const { key: key2 } = apiKeys.mint(TENANT, { capability: "provision" });
  const prodRefused = await withClient(prod, key2, async (c) =>
    c.callTool({ name: "create_formation_party", arguments: { synthetic: true } }),
  );
  expect(textOf(prodRefused)).toMatch(/synthetic formation parties are refused/);
});

// ── the door on onboard_agent ───────────────────────────────────────────────────────────────

test("REQUIRED: onboard_agent without a partyId is refused with the REST message, nothing claimed", async () => {
  const app = buildTestApp({ required: true });
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const res = await withClient(app, key, async (c) =>
    c.callTool({ name: "onboard_agent", arguments: { spec: VALID_SPEC, passkeyId: handle } }),
  );
  expect((res as { isError?: boolean }).isError).toBe(true);
  expect(textOf(res)).toMatch(/formation is required on this deployment/);
  expect(repo.listByTenant(TENANT)).toHaveLength(0);
});

test("REQUIRED: a valid party onboards and is bound; a second use is refused", async () => {
  const app = buildTestApp({ required: true });
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  await withClient(app, key, async (c) => {
    const { partyId } = JSON.parse(
      textOf(await c.callTool({ name: "create_formation_party", arguments: REAL_PARTY })),
    );
    const out = JSON.parse(
      textOf(
        await c.callTool({
          name: "onboard_agent",
          arguments: { spec: VALID_SPEC, passkeyId: handle, partyId },
        }),
      ),
    );
    expect(out.status).toBe("pending");
    expect(parties.findByCompanyId(repo.findByIdempotencyKey(out.id)!.companyId!)!.partyId).toBe(
      partyId,
    );

    const second = await c.callTool({
      name: "onboard_agent",
      arguments: { spec: { ...VALID_SPEC, name: "Second" }, passkeyId: handle, partyId },
    });
    expect(textOf(second)).toMatch(/unknown, not yours, or already bound/);
  });
  expect(repo.listByTenant(TENANT)).toHaveLength(1);
});

test("a FOREIGN party is refused as if it did not exist", async () => {
  const app = buildTestApp({ required: true });
  const foreign = parties.create({
    tenantId: OTHER,
    legalFirstName: "Grace",
    legalLastName: "Hopper",
    email: "grace@example.com",
    phone: null,
    line1: "1 Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: "USA",
    synthetic: false,
  });
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const res = await withClient(app, key, async (c) =>
    c.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: handle, partyId: foreign },
    }),
  );
  expect(textOf(res)).toMatch(/unknown, not yours, or already bound/);
  expect(repo.listByTenant(TENANT)).toHaveLength(0);
});

test("NOT required: onboard_agent without a partyId succeeds", async () => {
  const app = buildTestApp({ required: false });
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const res = await withClient(app, key, async (c) =>
    c.callTool({ name: "onboard_agent", arguments: { spec: VALID_SPEC, passkeyId: handle } }),
  );
  expect(JSON.parse(textOf(res)).status).toBe("pending");
});

test("MIRROR: custody is refused BEFORE formation, exactly as on REST", async () => {
  // Both wrong: an unavailable custody AND no partyId. Custody is the primary error on BOTH
  // surfaces — that ordering is what makes the two doors interchangeable, and if it ever
  // diverges this test and its REST twin disagree.
  const app = buildTestApp({ required: true });
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const res = await withClient(app, key, async (c) =>
    c.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: handle, custody: "turnkey" },
    }),
  );
  expect(textOf(res)).toMatch(/formation is required on this deployment/);

  // …and with circle genuinely unavailable, the CUSTODY refusal wins over the formation one,
  // even though both would refuse. That is the order the REST route runs, verbatim.
  const noCircle = buildTestApp({ required: true }, { circle: false });
  expect(
    await withClient(noCircle, key, async (c) =>
      textOf(
        await c.callTool({
          name: "onboard_agent",
          arguments: { spec: VALID_SPEC, passkeyId: handle, custody: "circle" },
        }),
      ),
    ),
  ).toMatch(/circle custody is not available/);
});

test("the quota refuses onboard_agent before the entity is minted", async () => {
  const app = buildTestApp({ required: true, maxPerTenant: 1 });
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  await withClient(app, key, async (c) => {
    const first = JSON.parse(
      textOf(await c.callTool({ name: "create_formation_party", arguments: REAL_PARTY })),
    );
    const out = JSON.parse(
      textOf(
        await c.callTool({
          name: "onboard_agent",
          arguments: { spec: VALID_SPEC, passkeyId: handle, partyId: first.partyId },
        }),
      ),
    );
    // The COMPANY's create_provider row is what burns the door's quota since the re-key.
    db.prepare("INSERT INTO formation_requests (company_id, step, state) VALUES (?,?,?)").run(
      repo.findByIdempotencyKey(out.id)!.companyId!,
      "create_provider",
      "pending",
    );
    const second = JSON.parse(
      textOf(await c.callTool({ name: "create_formation_party", arguments: REAL_PARTY })),
    );
    const res = await c.callTool({
      name: "onboard_agent",
      arguments: {
        spec: { ...VALID_SPEC, name: "Second" },
        passkeyId: handle,
        partyId: second.partyId,
      },
    });
    expect(textOf(res)).toMatch(/formation quota exhausted/);
  });
  expect(repo.listByTenant(TENANT)).toHaveLength(1);
});

// ── COMPANIES over MCP (design 2026-08-26 §7) ───────────────────────────────────────────────

/** The company projection's key set, asserted IDENTICALLY on both surfaces (§7). Its twin lives
 *  in test/api/formationParty.routes.test.ts; a field added to one door and not the other fails
 *  whichever of the two was forgotten. */
/** The PRODUCTION intake over MCP (A2 §5) — the same three fields REST takes, minus the ssn. */
const MCP_INTAKE = {
  names: ["Acme Robotics LLC", "Acme Automata", "Acme Mechanicals"],
  businessPurpose: "Operating autonomous software agents.",
  industryLabel: "Software development",
};

const COMPANY_VIEW_KEYS = [
  "agents",
  "businessPurpose",
  "companyId",
  "createdAt",
  "environment",
  "filedAt",
  "filingNumber",
  "formationStatus",
  "industryLabel",
  "legalNameFiled",
  "nameOptions",
  "paying",
  "status",
  "synthetic",
];

test("create_company is gated on FORMATION; list_companies on the company store, like REST", async () => {
  const on = buildTestApp({ required: true });
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });
  const tools = await withClient(on, key, async (c) => (await c.listTools()).tools);
  const create = tools.find((t) => t.name === "create_company")!;
  expect(create).toBeDefined();
  expect(tools.map((t) => t.name)).toContain("list_companies");
  // The PRODUCTION intake (A2 §5). `ssn` IS declared — and declared in order to be REFUSED: an
  // undeclared field is not rejected by the SDK, it is silently STRIPPED by the tool's zod schema
  // before the handler ever sees it, so a model that helpfully passed one would have got back a
  // companyId with no indication the number had been thrown away and the slow EIN route taken —
  // while the number sat in the client's context window and its logs, which is the entire harm
  // §4.1 exists to prevent. The web form is the only place one is ever collected.
  expect(Object.keys(create.inputSchema.properties ?? {})).toEqual([
    "partyId",
    "names",
    "businessPurpose",
    "industryLabel",
    "synthetic",
    "ssn",
  ]);
  expect(create.description).toMatch(/NEVER takes an SSN/);
  expect(create.description).toMatch(/web form/);
  // The industries are NAMED in the description: an agent-first caller has no GET /config, so
  // the description is its only discovery surface for the one enumerated field.
  expect(create.description).toContain("Software development");

  const off = buildTestApp(undefined);
  const { key: key2 } = apiKeys.mint(TENANT, { capability: "provision" });
  const offNames = await withClient(off, key2, async (c) =>
    (await c.listTools()).tools.map((t) => t.name),
  );
  // Creating a company SPENDS, so it needs the filer. READING the ones you already own does not:
  // a box whose doola credentials were pulled still holds real Wyoming LLCs, and REST
  // `GET /companies` answers for them whenever a company store is wired. The agent surface must
  // not be quietly less capable than the browser one.
  expect(offNames).not.toContain("create_company");
  expect(offNames).toContain("list_companies");
});

test("an `ssn` argument is REFUSED, loudly, and NOTHING is created", async () => {
  // The bug this pins: `ssn` was not declared on the tool, and an undeclared field is not
  // rejected by the SDK — it is silently STRIPPED by the tool's zod schema before the handler
  // sees it. A model that had read "US persons should supply an SSN" on the web form and helpfully
  // passed one here would have got back a companyId, filed under the slow EIN route, with no
  // indication the field had been thrown away — and with the number still sitting in the client's
  // context window and its logs, which is the entire harm §4.1 exists to prevent.
  const app = buildTestApp({ required: true });
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });

  await withClient(app, key, async (c) => {
    const { partyId } = JSON.parse(
      textOf(await c.callTool({ name: "create_formation_party", arguments: REAL_PARTY })),
    );
    const refused = await c.callTool({
      name: "create_company",
      arguments: { partyId, ...MCP_INTAKE, ssn: "123-45-6789" },
    });
    expect(refused.isError).toBe(true);
    // It says where the field DOES belong — a refusal a caller cannot act on is a dead end.
    expect(textOf(refused)).toBe(ssnNotOnThisDoorMessage());
    // The refusal is the WHOLE answer: nothing exists afterwards to clean up, and the quota was
    // not spent. The check therefore runs before any other validation.
    expect(
      JSON.parse(textOf(await c.callTool({ name: "list_companies", arguments: {} }))).companies,
    ).toHaveLength(0);
    // …and no digits of it are anywhere in the answer.
    expect(textOf(refused)).not.toMatch(/\d{3}-\d{2}-\d{4}/);

    // The very same call WITHOUT the field is accepted, so the refusal is about the ssn alone.
    const ok = await c.callTool({
      name: "create_company",
      arguments: { partyId, ...MCP_INTAKE },
    });
    expect(JSON.parse(textOf(ok)).companyId).toBeTruthy();
  });
});

test("MCP and REST mint the SAME company — one domain function, one set of refusals", async () => {
  const app = buildTestApp({ required: true });
  const handle = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT, { capability: "provision" });

  await withClient(app, key, async (c) => {
    const { partyId } = JSON.parse(
      textOf(await c.callTool({ name: "create_formation_party", arguments: REAL_PARTY })),
    );
    const { companyId } = JSON.parse(
      textOf(await c.callTool({ name: "create_company", arguments: { partyId, ...MCP_INTAKE } })),
    );
    expect(companyId).toBeTruthy();

    // The single-use rule reaches this door too: one identity, one company.
    const reused = await c.callTool({
      name: "create_company",
      arguments: { partyId, ...MCP_INTAKE, names: ["Beta One", "Beta Two", "Beta Three"] },
    });
    expect(textOf(reused)).toMatch(/unknown, not yours, or already bound/);

    // …and the INTAKE refusals are the same function's, so MCP and REST refuse in one voice.
    const { partyId: fresh } = JSON.parse(
      textOf(await c.callTool({ name: "create_formation_party", arguments: REAL_PARTY })),
    );
    expect(
      textOf(
        await c.callTool({
          name: "create_company",
          arguments: { partyId: fresh, ...MCP_INTAKE, names: ["Acme Bank", "B Works", "C Works"] },
        }),
      ),
    ).toMatch(/restricted word "bank"/);
    expect(
      textOf(
        await c.callTool({
          name: "create_company",
          arguments: { partyId: fresh, ...MCP_INTAKE, industryLabel: "Interpretive Dance" },
        }),
      ),
    ).toMatch(/is not one of the industries we can file under/);

    // list_companies renders the same projection REST does, newest first — FIELD FOR FIELD.
    // The two are one API-level contract (the picker's ordering and its labels), and MCP was
    // silently dropping businessPurpose, industryLabel, filedAt and filingNumber: an agent
    // surface less true than the browser one, for no reason anybody chose. The counterpart
    // assertion is in test/api/formationParty.routes.test.ts — the two lists must stay identical.
    const listed = JSON.parse(textOf(await c.callTool({ name: "list_companies", arguments: {} })));
    expect(listed.companies).toHaveLength(1);
    expect(Object.keys(listed.companies[0]).sort()).toEqual(COMPANY_VIEW_KEYS);
    expect(listed.companies[0]).toMatchObject({
      companyId,
      status: "ready",
      formationStatus: "none",
      paying: false,
      agents: 0,
      businessPurpose: expect.any(String),
      industryLabel: expect.any(String),
      filedAt: null,
      filingNumber: null,
    });

    // …and onboard_agent attaches to it, free.
    const out = JSON.parse(
      textOf(
        await c.callTool({
          name: "onboard_agent",
          arguments: { spec: VALID_SPEC, passkeyId: handle, companyId },
        }),
      ),
    );
    expect(repo.findByIdempotencyKey(out.id)?.companyId).toBe(companyId);
  });
});
