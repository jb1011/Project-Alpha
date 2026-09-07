import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { JobRecord } from "../../src/jobs/types";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";

let db: Database.Database;
let repo: SqliteEntityRepository;
let jobs: SqliteJobRepository;

const base: EntityRecord = {
  idempotencyKey: "tenant-a:agent",
  name: "PublicAgent",
  status: "funded",
  manager: "0x0000000000000000000000000000000000000001",
  guardian: "0x0000000000000000000000000000000000000002",
  operator: null,
  amendmentDelay: "0",
  ein: "12-3456789",
  formationDate: 0,
  oaHash: null,
  metadataURI: null,
  docPath: null,
  treasuryConfig: null,
  agentId: "876734",
  proxy: "0x0b92fe9A51f04784A96ed8346bF876EBE93163eE",
  treasury: "0xAD0F7d07Fe643e65dA4a6aB79560fbdB19d69A7d",
  createTxHash: null,
  bindTxHash: null,
  fundTxHash: null,
  ownerTenantId: "tenant-a",
  walletProvider: "circle",
  publicId: "22222222-2222-2222-2222-222222222222",
};

const job = (over: Partial<JobRecord>): JobRecord => ({
  jobKey: "k",
  jobId: "1",
  entityKey: base.idempotencyKey,
  ownerTenantId: "tenant-a",
  status: "reputed",
  clientAddress: "0x0000000000000000000000000000000000000003",
  evaluatorAddress: "0x0000000000000000000000000000000000000004",
  providerAddress: "0x0000000000000000000000000000000000000005",
  budgetAmount: "1000000",
  description: "demo job",
  deliverableHash: null,
  deliverablePath: null,
  createTxHash: null,
  fundTxHash: null,
  submitTxHash: null,
  completeTxHash: null,
  sweepTxHash: null,
  reputationTxHash: null,
  error: null,
  createdAt: null,
  updatedAt: null,
  ...over,
});

function app(worldId?: unknown) {
  return buildApiApp({ webOrigin: "https://app.example.com", repo, jobs, worldId } as never);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  jobs = new SqliteJobRepository(db);
});
afterEach(() => db.close());

test("serves stats + entity rows with NO auth, cacheable, and leaks no tenant/idempotency keys", async () => {
  repo.upsert(base);
  jobs.upsert(job({ jobKey: "k1", budgetAmount: "1500000", status: "reputed" }));
  jobs.upsert(job({ jobKey: "k2", budgetAmount: "500000", status: "completed" }));
  jobs.upsert(job({ jobKey: "k3", budgetAmount: "9000000", status: "funded" })); // in-flight: excluded

  const res = await app().request("/transparency");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  const body = await res.json();

  expect(body.stats).toEqual({ entities: 1, jobsSettled: 2, usdcSettledAtomic: "2000000" });
  expect(body.entities).toHaveLength(1);
  expect(body.entities[0]).toMatchObject({
    publicId: base.publicId,
    name: "PublicAgent",
    agentId: "876734",
    status: "funded",
    legalManager: base.proxy,
    treasury: base.treasury,
    walletProvider: "circle",
    humanVerified: false,
    credential: null,
    jobsSettled: 2,
    usdcSettledAtomic: "2000000",
  });
  expect(body.entities[0].createdAt).toBeTruthy();
  // The join keys encode tenant identity — the public payload must never carry them.
  const text = JSON.stringify(body);
  expect(text).not.toContain("tenant-a");
  expect(text).not.toContain("idempotency");
  expect(text).not.toContain("ownerTenantId");
});

test("lists only on-chain, completed-leg entities", async () => {
  repo.upsert(base);
  repo.upsert({ ...base, idempotencyKey: "t:pending", status: "pending", publicId: null });
  repo.upsert({ ...base, idempotencyKey: "t:failed", status: "failed", publicId: null });
  repo.upsert({ ...base, idempotencyKey: "t:offchain", agentId: null, publicId: null });
  repo.upsert({
    ...base,
    idempotencyKey: "t:bound",
    status: "bound",
    agentId: "9",
    publicId: null,
  });

  const body = await (await app().request("/transparency")).json();
  expect(body.stats.entities).toBe(2);
  expect(body.entities.map((e: { agentId: string }) => e.agentId).sort()).toEqual(["876734", "9"]);
});

test("legacy rows read as turnkey custody", async () => {
  repo.upsert({ ...base, walletProvider: null });
  const body = await (await app().request("/transparency")).json();
  expect(body.entities[0].walletProvider).toBe("turnkey");
});

test("marks the entity human-verified when the guardian holds a World verification", async () => {
  repo.upsert(base);
  const worldId = {
    cfg: { action: "guardian" },
    store: {
      findByTenant: (tenantId: string, action: string) =>
        tenantId === "tenant-a" && action === "guardian"
          ? { credential: "orb", nullifier: "0xsecret", verifiedAt: 1, environment: "production" }
          : undefined,
    },
  };
  const body = await (await app(worldId).request("/transparency")).json();
  expect(body.entities[0]).toMatchObject({ humanVerified: true, credential: "orb" });
  // The nullifier is disclosed to us alone — it must never appear on a public surface.
  expect(JSON.stringify(body)).not.toContain("0xsecret");
});

test("a guardian waiver is access, not personhood: never human-verified on the public registry", async () => {
  repo.upsert(base);
  const worldId = {
    cfg: { action: "guardian" },
    store: {
      findByTenant: (tenantId: string, action: string) =>
        tenantId === "tenant-a" && action === "guardian"
          ? {
              credential: "waiver",
              nullifier: "waiver:abc",
              verifiedAt: 1,
              environment: "production",
            }
          : undefined,
    },
  };
  const body = await (await app(worldId).request("/transparency")).json();
  // Same invariant as GET /metadata/:publicId — the two public surfaces must never disagree.
  expect(body.entities[0]).toMatchObject({ humanVerified: false, credential: "waiver" });
});

test("cross-origin OPTIONS preflight gets ACAO: *", async () => {
  const res = await app().request("/transparency", {
    method: "OPTIONS",
    headers: { Origin: "https://other.example.com", "Access-Control-Request-Method": "GET" },
  });
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
});

// ── formation (design §8) ───────────────────────────────────────────────────────────────────

/** The company a formed row is attached to. The public surface reads its ENVIRONMENT and the
 *  derived status off it, and nothing else — no EIN, no filing number, no provider reference. */
const COMPANY_KEY = "company-public";
const PUBLIC_COMPANY = {
  companyId: COMPANY_KEY,
  tenantId: "tenant-a",
  status: "ready" as const,
  provider: "doola",
  environment: "sandbox" as const,
  synthetic: false,
  nameOptions: [],
  businessPurpose: "purpose",
  industryLabel: "Software development",
  intakeSynthesized: true,
  legalNameFiled: null,
  filedAt: 1_755_600_000,
  filingNumber: "2026-123456",
  ein: "98-7654321",
  createdAt: "2026-08-21 12:00:00",
  updatedAt: "2026-08-21 12:00:00",
};

test("a legacy/stub row serves formation: null — forever, with no backfill", async () => {
  repo.upsert(base);
  const body = await (await app().request("/transparency")).json();
  expect(body.entities[0].formation).toBeNull();
});

test("a formed row serves the DERIVED status and its environment, and nothing else", async () => {
  repo.upsert({ ...base, formationProvider: "doola", formationEnvironment: "sandbox" });
  repo.attachCompany(base.idempotencyKey, COMPANY_KEY);
  const steps = () => [
    {
      companyId: COMPANY_KEY,
      step: "await_filing" as const,
      state: "confirmed" as const,
      attempt: 0,
      providerRef: "cmp_1",
      detail: null,
      error: null,
    },
  ];
  const built = buildApiApp({
    webOrigin: "https://app.example.com",
    repo,
    jobs,
    formationSteps: steps,
    company: () => PUBLIC_COMPANY,
  } as never);
  const body = await (await built.request("/transparency")).json();
  // The honesty invariant on the PUBLIC surface: a sandbox filing is labeled as one here too.
  expect(body.entities[0].formation).toEqual({ status: "filed", environment: "sandbox" });
});

test("the public surface NEVER carries the EIN, the filing number, or anything about a person", async () => {
  // The COMPANY holds every fact an authenticated owner may see…
  repo.upsert({ ...base, formationProvider: "doola", formationEnvironment: "sandbox" });
  repo.attachCompany(base.idempotencyKey, COMPANY_KEY);
  // …and a party row exists for it, with real PII in the database.
  db.prepare(
    `INSERT INTO formation_parties (party_id, entity_key, tenant_id, legal_first_name,
       legal_last_name, email, line1, city, postal_code, country)
     VALUES ('p1', ?, 'tenant-a', 'Ada', 'Lovelace', 'ada@example.com', '1 Analytical Way',
             'Cheyenne', '82001', 'USA')`,
  ).run(base.idempotencyKey);

  const text = JSON.stringify(await (await app().request("/transparency")).json());
  // The EIN is the entity owner's tax identifier: authenticated views only.
  for (const forbidden of [
    "98-7654321",
    "2026-123456",
    "Ada",
    "Lovelace",
    "ada@example.com",
    "Analytical",
    "82001",
    "p1",
  ])
    expect(text).not.toContain(forbidden);
});

test("§7 SHARING LABELS: the count of agents sharing a filing is NOT on the public surface", async () => {
  // The label reaches `EntityView.formation` and the three tenant-scoped MCP read tools, and
  // stops there. Two agents sharing a company are ALREADY publicly linkable through their
  // anchored manifests — `legal.providerCompanyId` is in every one, which is why the reuse picker
  // discloses it before a caller confirms — but the COUNT is the size of a tenant's fleet, and no
  // public surface has ever carried that.
  //
  // Structural, not incidental: `/transparency` builds its row from `formationSummary`, which is
  // the shape that is safe anywhere, and never receives the `companyAgents` dependency at all.
  // This asserts the RESULT, because a future edit could spread the authenticated block here.
  repo.upsert({ ...base, formationProvider: "doola", formationEnvironment: "sandbox" });
  repo.attachCompany(base.idempotencyKey, COMPANY_KEY);
  repo.upsert({
    ...base,
    idempotencyKey: "tenant-a:agent-2",
    publicId: "44444444-4444-4444-4444-444444444444",
    formationProvider: "doola",
    formationEnvironment: "sandbox",
  });
  repo.attachCompany("tenant-a:agent-2", COMPANY_KEY);

  const built = buildApiApp({
    webOrigin: "*",
    repo,
    jobs,
    formationSteps: () => [],
    company: () => PUBLIC_COMPANY,
    // Wired ON PURPOSE, with a real count: the guard is worthless if it passes because the
    // dependency happened to be absent.
    companyAgents: { countAgents: () => 2, countAgentsMany: () => new Map([[COMPANY_KEY, 2]]) },
  } as never);
  const body = await (await built.request("/transparency")).json();
  expect(body.entities).toHaveLength(2);
  for (const e of body.entities) {
    expect(e.formation).not.toHaveProperty("sharedWith");
    // …nor the company id it would be a count of, nor the two other owner-only fields.
    expect(e.formation).not.toHaveProperty("companyId");
    expect(e.formation).not.toHaveProperty("ein");
    expect(e.formation).not.toHaveProperty("documents");
  }
});

// ── M5: the short in-process cache ─────────────────────────────────────────────────────────

test("M5: /transparency is cached for a few seconds, and refreshes after the TTL", async () => {
  // The one surface whose request volume is not bounded by how many tenants exist. It reads every
  // public entity, every job and every formation, so a link doing the rounds used to cost one
  // full pass per request. Ten seconds is shorter than anything a human notices.
  repo.upsert(base);
  let now = 1_000_000;
  const app = buildApiApp({
    webOrigin: "*",
    repo,
    jobs,
    now: () => now,
  } as never);

  const first = await (await app.request("/transparency")).json();
  expect(first.stats.entities).toBe(1);

  // A second entity appears; within the TTL the cached body is served unchanged.
  repo.upsert({
    ...base,
    idempotencyKey: "tenant-b:agent",
    publicId: "33333333-3333-3333-3333-333333333333",
  });
  now += 5_000;
  expect((await (await app.request("/transparency")).json()).stats.entities).toBe(1);

  // Past it, the pass runs again.
  now += 6_000;
  const fresh = await (await app.request("/transparency")).json();
  expect(fresh.stats.entities).toBe(2);
  // The freshness contract advertised to intermediaries is unchanged either way.
  const res = await app.request("/transparency");
  expect(res.headers.get("cache-control")).toBe("public, max-age=300");
});
