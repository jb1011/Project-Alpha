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
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
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
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
    fundCaps: TEST_FUND_CAPS,
    parties,
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
          parties,
          requests: new SqliteFormationRepository(db),
        }
      : undefined,
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
    expect(parties.findByEntityKey(out.id)!.partyId).toBe(partyId);

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
    db.prepare("INSERT INTO formation_requests (entity_key, step, state) VALUES (?,?,?)").run(
      out.id,
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
