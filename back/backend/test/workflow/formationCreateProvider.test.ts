/**
 * The `create_provider` step (design §5, audit H5 / M5, completeness 9).
 *
 * Four properties carry real money or real legal consequence, and each has a test that fails
 * loudly if it regresses:
 *   1. it is NON-FATAL — funding and ENS still run when doola is down, and the saga still returns;
 *   2. an entity pinned to one environment is NEVER routed at the other, and no call is made;
 *   3. a persisted company id is ADOPTED, never re-created — a second create is a second real
 *      Wyoming LLC and a second real fee;
 *   4. the expedited EIN is offered only to a non-US applicant (§9), and `Idempotency-Key` rides
 *      on the two creates and nothing else.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { type DoolaApi, DoolaApiError } from "../../src/adapters/doola/doolaClient";
import type { OperatorSigner } from "../../src/adapters/turnkey/signer";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteFormationPartyRepository } from "../../src/persistence/formationPartyRepository";
import { SqliteFormationRepository } from "../../src/persistence/formationRepository";
import type { AgentSpec } from "../../src/policy/agentSpec";
import type { CreateProviderDetail } from "../../src/workflow/formationProvider";
import { runOnboarding } from "../../src/workflow/onboarding";

const TENANT = "0x000000000000000000000000000000000000000A";
const KEY = "form-A";
const COMPANY = "cmp_live_1";
const CUSTOMER = "cus_live_1";

const spec = {
  name: "Formation Agent LLC",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: {
    manager: "0x000000000000000000000000000000000000aAaa",
    guardian: "0x000000000000000000000000000000000000bBbb",
    operator: "0x000000000000000000000000000000000000cCcc",
  },
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000dDdd",
    spendingCapUsdc: "100.00",
    spendingPeriod: "24h",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
  legal: {},
  metadata: { description: "A test agent." },
} as unknown as AgentSpec;

const sharedSigner = {
  address: "0x000000000000000000000000000000000000cCcc",
  signWalletSet: async () => "0xsharedsig",
} as unknown as OperatorSigner;

function makeFakeArc() {
  const arc = {
    chainId: 31337,
    identityRegistry: "0x0000000000000000000000000000000000000001" as const,
    broadcastCreateEntity: vi.fn(async () => "0xcreate" as `0x${string}`),
    confirmCreateEntity: vi.fn(async (txHash: string) => ({
      agentId: 7n,
      proxy: "0x0000000000000000000000000000000000000abc" as const,
      treasury: "0x0000000000000000000000000000000000000def" as const,
      txHash: txHash as `0x${string}`,
    })),
    setAgentWallet: vi.fn(async () => "0xbind" as const),
    walletSetDeadline: vi.fn(async () => 9_999_999_999n),
    eip712Domain: vi.fn(async () => ({ name: "Reg", version: "1" })),
    fundTreasury: vi.fn(async () => "0xfund" as `0x${string}`),
    getAgentMetadata: vi.fn(async () => "0x" as `0x${string}`),
    setAgentMetadata: vi.fn(async () => "0xens" as `0x${string}`),
  };
  return arc as unknown as ArcAdapter & typeof arc;
}

interface DoolaCall {
  method: string;
  idempotencyKey?: string;
  body?: unknown;
}

function makeFakeDoola(over: Partial<DoolaApi> = {}) {
  const calls: DoolaCall[] = [];
  const api = {
    createCustomer: vi.fn(async (body: unknown, idempotencyKey: string) => {
      calls.push({ method: "createCustomer", idempotencyKey, body });
      return { doolaCustomerId: CUSTOMER };
    }),
    createCompany: vi.fn(async (body: unknown, idempotencyKey: string) => {
      calls.push({ method: "createCompany", idempotencyKey, body });
      return { doolaCompanyId: COMPANY, formationSubmissionStatus: "PENDING" };
    }),
    getCompany: vi.fn(async (id: string) => {
      calls.push({ method: "getCompany", body: id });
      return { doolaCompanyId: id, formationSubmissionStatus: "SUBMITTED" };
    }),
    listCompanies: vi.fn(async (id: string) => {
      calls.push({ method: "listCompanies", body: id });
      return [];
    }),
    listDocuments: vi.fn(async () => []),
    getDocumentDownloadUrl: vi.fn(),
    listRequiredActions: vi.fn(async () => []),
    getComplianceCalendar: vi.fn(async () => []),
    playgroundCompleteFormation: vi.fn(),
    playgroundCompleteEin: vi.fn(),
    ...over,
  } as unknown as DoolaApi & { createCustomer: ReturnType<typeof vi.fn> };
  return { api, calls };
}

let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;
let requests: SqliteFormationRepository;
let parties: SqliteFormationPartyRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  requests = new SqliteFormationRepository(db);
  parties = new SqliteFormationPartyRepository(db);
  docStore = new FileDocumentStore(`/tmp/legalbody-formation-${Math.floor(performance.now())}`);
});
afterEach(() => db.close());

function bindParty(over: { country?: string; phone?: string | null } = {}): string {
  const id = parties.create({
    tenantId: TENANT,
    legalFirstName: "Ada",
    legalLastName: "Lovelace",
    email: "ada@example.com",
    phone: over.phone === undefined ? "+12125550100" : over.phone,
    line1: "1 Analytical Way",
    line2: null,
    city: "Cheyenne",
    region: "WY",
    postalCode: "82001",
    country: over.country ?? "USA",
    synthetic: false,
  });
  parties.bind(id, KEY, TENANT);
  return id;
}

function baseDeps(
  arc: ArcAdapter,
  doola: DoolaApi,
  environment: "sandbox" | "production" = "sandbox",
) {
  return {
    spec,
    idempotencyKey: KEY,
    repo,
    docStore,
    arc,
    operatorSigner: sharedSigner,
    usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
    ownerTenantId: TENANT,
    specJson: JSON.stringify(spec),
    metadataBaseUrl: "https://host.example/backend",
    formation: { provider: "doola" as const, environment: "sandbox" as const },
    doola,
    formationRequests: requests,
    formationParties: parties,
    doolaEnvironment: environment,
  };
}

const detailOf = (): CreateProviderDetail =>
  JSON.parse(requests.find(KEY, "create_provider")!.detail ?? "{}");

// ── happy path ──────────────────────────────────────────────────────────────────────────────

test("files the company, claims all four steps, and confirms create_provider", async () => {
  bindParty();
  const { api, calls } = makeFakeDoola();
  const rec = await runOnboarding(baseDeps(makeFakeArc(), api));

  expect(rec.status).toBe("bound");
  // The bridge-legs pattern: all four rows exist up front, so "is a formation in flight?" is a
  // query over rows that provably exist rather than a guess about which a crash created.
  expect(requests.stepsOf(KEY).map((r) => [r.step, r.state])).toEqual([
    ["create_provider", "confirmed"],
    ["await_filing", "pending"],
    ["fetch_documents", "pending"],
    ["await_ein", "pending"],
  ]);

  const row = requests.find(KEY, "create_provider")!;
  expect(row.providerRef).toBe(COMPANY);
  expect(detailOf()).toMatchObject({
    customerId: CUSTOMER,
    companyId: COMPANY,
    submissionStatus: "PENDING",
    expedited: false,
  });

  // The legal facts stay NULL: doola accepted a REQUEST, the state has filed nothing yet and
  // the IRS has issued nothing. Fabricating either is the failure class this design forbids.
  const stored = repo.findByIdempotencyKey(KEY)!;
  expect([
    stored.einReal ?? null,
    stored.formationFiledAt ?? null,
    stored.formationFilingNumber ?? null,
  ]).toEqual([null, null, null]);

  // Idempotency-Key on the two CREATES and nothing else, one key per attempt.
  expect(calls.map((c) => [c.method, c.idempotencyKey])).toEqual([
    ["createCustomer", `formation:${KEY}:create_provider:0`],
    ["createCompany", `formation:${KEY}:create_provider:0`],
  ]);
});

test("the company body: WY LLC, registered-agent addresses, one 100% member, name without its ending", async () => {
  bindParty();
  const { api, calls } = makeFakeDoola();
  await runOnboarding(baseDeps(makeFakeArc(), api));

  const body = calls.find((c) => c.method === "createCompany")!.body as Record<string, unknown>;
  expect(body).toMatchObject({
    doolaCustomerId: CUSTOMER,
    entityType: "LLC",
    state: "WY",
    industry: "Software development",
    description: "A test agent.",
  });
  // "Formation Agent LLC" would otherwise be filed as "Formation Agent LLC LLC".
  expect(body.nameOptions).toEqual([
    { name: "Formation Agent", entityTypeEnding: "LLC", position: 1 },
  ]);
  // An AGENT has no premises: doola's registered agent provides both addresses, which is the
  // difference between a filing that can be served and one that cannot.
  expect(body.addresses).toEqual([
    { provider: "registeredAgent", type: "mailing" },
    { provider: "registeredAgent", type: "business" },
  ]);
  expect(body.members).toEqual([
    {
      legalFirstName: "Ada",
      legalLastName: "Lovelace",
      isNaturalPerson: true,
      address: {
        line1: "1 Analytical Way",
        line2: undefined,
        city: "Cheyenne",
        state: "WY", // our `region` column, doola's `state` field
        postalCode: "82001",
        country: "USA",
        phone: "+12125550100",
      },
      ownershipPercent: 100,
    },
  ]);
  // The customer carries a country of residence, never an address.
  const customer = calls.find((c) => c.method === "createCustomer")!.body as Record<
    string,
    unknown
  >;
  expect(customer).toEqual({
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    countryOfResidence: "USA",
    phoneNumber: "+12125550100",
  });
});

test("§9: the expedited EIN is requested for a NON-US party and for nobody else", async () => {
  bindParty({ country: "FRA" });
  const { api, calls } = makeFakeDoola();
  await runOnboarding(baseDeps(makeFakeArc(), api));
  const body = calls.find((c) => c.method === "createCompany")!.body as Record<string, unknown>;
  expect(body.requestedServices).toEqual([{ service: "EinCreation", variant: "Expedite" }]);
  expect(detailOf().expedited).toBe(true);
});

test("§9: a US party gets NO requestedServices — as a default it would break every US filing", async () => {
  bindParty({ country: "USA" });
  const { api, calls } = makeFakeDoola();
  await runOnboarding(baseDeps(makeFakeArc(), api));
  const body = calls.find((c) => c.method === "createCompany")!.body as Record<string, unknown>;
  expect(body.requestedServices).toBeUndefined();
});

// ── non-fatal ───────────────────────────────────────────────────────────────────────────────

test("NON-FATAL: doola throwing leaves funding and ENS untouched and the saga returning", async () => {
  bindParty();
  const arc = makeFakeArc();
  const { api } = makeFakeDoola({
    createCompany: vi.fn(async () => {
      throw new DoolaApiError("E_INTERNAL", 500, "doola is down", "req_z");
    }) as never,
  });

  const rec = await runOnboarding({
    ...baseDeps(arc, api),
    fundAmount: 1_000_000n,
    ensParentName: "novicorpus.eth",
  });

  // The onboarding completed in full: money moved, ENS was written, the record is `funded`.
  expect(rec.status).toBe("funded");
  expect(arc.fundTreasury).toHaveBeenCalledTimes(1);
  expect(arc.setAgentMetadata).toHaveBeenCalledTimes(1);

  // …and the failure is recorded rather than swallowed.
  const row = requests.find(KEY, "create_provider")!;
  expect(row.state).toBe("failed");
  expect(row.error).toMatch(/E_INTERNAL/);
  // The attempt is BURNED: doola released the key, so a retry must derive a fresh one — reusing
  // it with a corrected body returns 409 E_IDEMPOTENCY_KEY_REUSED (verified live).
  expect(row.attempt).toBe(1);
  expect(repo.listEvents(KEY).some((e) => e.step === "formationCreate")).toBe(true);
});

test("a validation failure is recorded with doola's code, and the customer id is kept", async () => {
  bindParty();
  const { api } = makeFakeDoola({
    createCompany: vi.fn(async () => {
      throw new DoolaApiError("E_VALIDATION_FAILED", 400, "one or more fields are invalid");
    }) as never,
  });
  await runOnboarding(baseDeps(makeFakeArc(), api));
  const row = requests.find(KEY, "create_provider")!;
  expect(row.state).toBe("failed");
  expect(row.error).toMatch(/E_VALIDATION_FAILED/);
  // The customer survives the failure — it is what the retry and the pre-create lookup reuse.
  expect(detailOf().customerId).toBe(CUSTOMER);
});

// ── refusals that never call doola ──────────────────────────────────────────────────────────

test("ENVIRONMENT PINNING (M5): a sandbox-pinned entity is never routed at production", async () => {
  bindParty();
  const { api, calls } = makeFakeDoola();
  // The deployment has flipped to production while this entity is pinned to sandbox.
  await runOnboarding(baseDeps(makeFakeArc(), api, "production"));

  const row = requests.find(KEY, "create_provider")!;
  expect(row.state).toBe("failed");
  expect(row.error).toMatch(/environment pin mismatch/);
  expect(row.error).toMatch(/refusing to call doola/);
  expect(calls).toHaveLength(0); // not one call — the refusal is BEFORE the network
});

test("no bound party: refused with a named error, and doola is never called", async () => {
  const { api, calls } = makeFakeDoola(); // no bindParty()
  await runOnboarding(baseDeps(makeFakeArc(), api));
  expect(requests.find(KEY, "create_provider")!.error).toMatch(/no formation party is bound/);
  expect(calls).toHaveLength(0);
});

test("a party with no phone is refused HERE, not by a body doola would 400", async () => {
  bindParty({ phone: null });
  const { api, calls } = makeFakeDoola();
  await runOnboarding(baseDeps(makeFakeArc(), api));
  expect(requests.find(KEY, "create_provider")!.error).toMatch(/has no phone number/);
  expect(calls).toHaveLength(0);
});

test("a legacy/stub entity files nothing at all", async () => {
  bindParty();
  const { api, calls } = makeFakeDoola();
  // No `formation` pin: the row is a stub, forever, and the step does not run.
  const deps = baseDeps(makeFakeArc(), api);
  await runOnboarding({ ...deps, formation: null });
  expect(calls).toHaveLength(0);
  expect(requests.stepsOf(KEY)).toHaveLength(0);
});

test("a deployment with no doola client files nothing, whatever the pin says", async () => {
  bindParty();
  const arc = makeFakeArc();
  await runOnboarding({ ...baseDeps(arc, makeFakeDoola().api), doola: undefined });
  expect(requests.stepsOf(KEY)).toHaveLength(0);
});

// ── the crash window ────────────────────────────────────────────────────────────────────────

test("ADOPT ON RESUME: a persisted provider_ref is never re-created", async () => {
  bindParty();
  const arc = makeFakeArc();

  // First pass files the company, then the process "crashes" — simulated by resetting the row to
  // `submitted` while keeping the provider_ref, which is exactly the state a crash between the
  // create response and the confirm leaves behind.
  const first = makeFakeDoola();
  await runOnboarding(baseDeps(arc, first.api));
  db.prepare(
    "UPDATE formation_requests SET state = 'submitted' WHERE entity_key = ? AND step = 'create_provider'",
  ).run(KEY);

  const second = makeFakeDoola();
  await runOnboarding(baseDeps(arc, second.api));

  // Not one create. A second create is a second real Wyoming LLC and a second real fee.
  expect(second.calls.map((c) => c.method)).toEqual(["getCompany"]);
  const row = requests.find(KEY, "create_provider")!;
  expect(row.state).toBe("confirmed");
  expect(row.providerRef).toBe(COMPANY);
  expect(detailOf()).toMatchObject({ adopted: true, submissionStatus: "SUBMITTED" });
});

test("a CONFIRMED row is left alone on every later pass", async () => {
  bindParty();
  const arc = makeFakeArc();
  await runOnboarding(baseDeps(arc, makeFakeDoola().api));
  const again = makeFakeDoola();
  await runOnboarding(baseDeps(arc, again.api));
  expect(again.calls).toHaveLength(0);
});

test("PRE-CREATE LOOKUP: a resumed row with a customer but no company adopts what doola holds", async () => {
  bindParty();
  // The state a crash between the customer create and the company create leaves: `submitted`,
  // a customer id in `detail`, no provider_ref.
  requests.claimAllSteps(KEY);
  db.prepare(
    `UPDATE formation_requests SET state = 'submitted', detail = ?
      WHERE entity_key = ? AND step = 'create_provider'`,
  ).run(JSON.stringify({ customerId: CUSTOMER }), KEY);

  const listCompanies = vi.fn(async () => [
    {
      doolaCompanyId: COMPANY,
      name: "Formation Agent LLC",
      formationSubmissionStatus: "SUBMITTED",
    },
  ]);
  const { api, calls } = makeFakeDoola({ listCompanies: listCompanies as never });
  await runOnboarding(baseDeps(makeFakeArc(), api));

  // The lookup adopted it: no createCustomer (we had one), and no createCompany at all.
  expect(listCompanies).toHaveBeenCalledWith(CUSTOMER);
  expect(calls.map((c) => c.method)).toEqual([]);
  const row = requests.find(KEY, "create_provider")!;
  expect([row.state, row.providerRef]).toEqual(["confirmed", COMPANY]);
  expect(detailOf().adopted).toBe(true);
});

test("PRE-CREATE LOOKUP: an EMPTY result never blocks the create (the list is eventually consistent)", async () => {
  bindParty();
  requests.claimAllSteps(KEY);
  db.prepare(
    `UPDATE formation_requests SET state = 'submitted', detail = ?
      WHERE entity_key = ? AND step = 'create_provider'`,
  ).run(JSON.stringify({ customerId: CUSTOMER }), KEY);

  const { api, calls } = makeFakeDoola(); // listCompanies -> []
  await runOnboarding(baseDeps(makeFakeArc(), api));
  expect(calls.map((c) => c.method)).toEqual(["listCompanies", "createCompany"]);
  expect(requests.find(KEY, "create_provider")!.providerRef).toBe(COMPANY);
});

test("the lookup is skipped on a FIRST attempt — there is nothing to have lost yet", async () => {
  bindParty();
  const { api, calls } = makeFakeDoola();
  await runOnboarding(baseDeps(makeFakeArc(), api));
  expect(calls.map((c) => c.method)).toEqual(["createCustomer", "createCompany"]);
});
