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
import {
  type DoolaApi,
  DoolaApiError,
  DoolaTimeoutError,
} from "../../src/adapters/doola/doolaClient";
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

  // Idempotency-Key on the two CREATES and nothing else — one key per attempt, and one per
  // ENDPOINT (C1): two different bodies under one key is the shape that produces doola's own
  // `E_IDEMPOTENCY_KEY_REUSED`, and it costs nothing to make it unrepresentable.
  expect(calls.map((c) => [c.method, c.idempotencyKey])).toEqual([
    ["createCustomer", `formation:${KEY}:create_provider:0:customer`],
    ["createCompany", `formation:${KEY}:create_provider:0:company`],
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
  // C1: the attempt is NOT burned. A 500 is not a verdict — doola may hold a committed company
  // and the answer was simply lost. Bumping would rotate the idempotency key, and the retry
  // would file a SECOND real Wyoming LLC.
  expect(row.attempt).toBe(0);
  expect(row.error).toMatch(/may have COMMITTED/);
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

test("RETRY after a REFUSAL: the row re-enters `submitted`, so the company id is still persisted", async () => {
  bindParty();
  const arc = makeFakeArc();

  // First pass: doola REFUSES the body (a 4xx validation failure). That is a verdict — nothing
  // committed and the key is released — so it is the one kind of failure that burns an attempt.
  const broken = makeFakeDoola({
    createCompany: vi.fn(async () => {
      throw new DoolaApiError("E_VALIDATION_FAILED", 400, "one or more fields are invalid");
    }) as never,
  });
  await runOnboarding(baseDeps(arc, broken.api));
  expect(requests.find(KEY, "create_provider")).toMatchObject({ state: "failed", attempt: 1 });

  // Second pass (what the sweeper will do): doola is back. The row must move OUT of `failed`
  // before the create, or every persist below it CASes on `submitted`, writes nothing, and the
  // company id is lost — the exact crash-window hole this step exists to close.
  const fixed = makeFakeDoola();
  await runOnboarding(baseDeps(arc, fixed.api));

  const row = requests.find(KEY, "create_provider")!;
  expect(row.state).toBe("confirmed");
  expect(row.providerRef).toBe(COMPANY);
  expect(row.error).toBeNull();
  // A FRESH idempotency key: doola released the refused one, and reusing it with a corrected
  // body returns 409 E_IDEMPOTENCY_KEY_REUSED (verified live).
  expect(fixed.calls.find((c) => c.method === "createCompany")!.idempotencyKey).toBe(
    `formation:${KEY}:create_provider:1:company`,
  );
  // The customer survived the failure, so the retry reuses it and looks first.
  expect(fixed.calls.map((c) => c.method)).toEqual(["listCompanies", "createCompany"]);
});

test("ADOPT wins over the body preconditions: a filed company is adopted even if the party degrades", async () => {
  bindParty();
  const arc = makeFakeArc();
  const first = makeFakeDoola();
  await runOnboarding(baseDeps(arc, first.api));
  db.prepare(
    "UPDATE formation_requests SET state = 'submitted' WHERE entity_key = ? AND step = 'create_provider'",
  ).run(KEY);
  // The phone disappears (an erasure, a correction, a bad edit). The company still exists in
  // Wyoming's queue and its id is ours: adopting it is the only safe answer.
  db.prepare("UPDATE formation_parties SET phone = NULL WHERE entity_key = ?").run(KEY);

  const second = makeFakeDoola();
  await runOnboarding(baseDeps(arc, second.api));
  expect(second.calls.map((c) => c.method)).toEqual(["getCompany"]);
  expect(requests.find(KEY, "create_provider")!.state).toBe("confirmed");
});

// ── C1: a LOST answer must never become a second company ────────────────────────────────────
//
// The most expensive failure this integration can have. Behind `POST /companies` is a real
// Wyoming LLC and a real fee, and the `Idempotency-Key` is the only thing standing between a
// retry and a second one. Rotating that key is a CLAIM — "the last request definitely did not
// commit" — and a timeout, a 5xx or a torn socket cannot make it.

test("C1: a TIMEOUT on the company create parks the row WITHOUT burning the attempt", async () => {
  bindParty();
  const { api } = makeFakeDoola({
    createCompany: vi.fn(async () => {
      throw new DoolaTimeoutError("/v1/partner/companies", 30_000);
    }) as never,
  });
  await runOnboarding(baseDeps(makeFakeArc(), api));

  const row = requests.find(KEY, "create_provider")!;
  expect(row.state).toBe("failed");
  expect(row.attempt).toBe(0); // the key is NOT rotated
  expect(row.error).toMatch(/no usable answer/);
  // The marker that makes the next pass safe: a create went out under attempt 0.
  expect(detailOf().companySentAttempt).toBe(0);
  // Parked rows carry their own schedule, because `attempt` can no longer express one.
  const backoff = JSON.parse(row.detail ?? "{}") as { nextRetryAt?: number };
  expect(backoff.nextRetryAt).toBeGreaterThan(0);
});

test("C1: timeout then retry — the SAME key is re-sent and doola's replay is adopted, once", async () => {
  bindParty();
  const arc = makeFakeArc();

  // Pass 1: doola COMMITTED the company and the answer was lost on the way back.
  const filed = { doolaCompanyId: COMPANY, formationSubmissionStatus: "PENDING" };
  const committed: (typeof filed)[] = [];
  const lost = makeFakeDoola({
    createCompany: vi.fn(async () => {
      committed.push(filed); // this is the real Wyoming LLC
      throw new DoolaTimeoutError("/v1/partner/companies", 30_000);
    }) as never,
  });
  await runOnboarding(baseDeps(arc, lost.api));
  expect(committed).toHaveLength(1);

  // Pass 2 (the sweeper's retry): doola is healthy and REPLAYS the committed response for the
  // same key — which is exactly what an idempotency key is for. Its list is still eventually
  // consistent, so the pre-create lookup finds nothing and must not be read as "nothing filed".
  const replayKeys: string[] = [];
  const replay = makeFakeDoola({
    listCompanies: vi.fn(async () => []) as never,
    createCompany: vi.fn(async (_body: unknown, key: string) => {
      replayKeys.push(key);
      return filed; // the replay: the SAME company, not a new one
    }) as never,
  });
  await runOnboarding(baseDeps(arc, replay.api));

  // THE assertion: the same key, so doola replays instead of filing.
  expect(replayKeys).toEqual([`formation:${KEY}:create_provider:0:company`]);
  expect(committed).toHaveLength(1); // no second company, no second fee
  const row = requests.find(KEY, "create_provider")!;
  expect([row.state, row.providerRef, row.attempt]).toEqual(["confirmed", COMPANY, 0]);
});

test("C1: timeout then retry — a lookup that DOES find the company adopts it, with no create", async () => {
  bindParty();
  const arc = makeFakeArc();
  const lost = makeFakeDoola({
    createCompany: vi.fn(async () => {
      throw new DoolaTimeoutError("/v1/partner/companies", 30_000);
    }) as never,
  });
  await runOnboarding(baseDeps(arc, lost.api));

  const second = makeFakeDoola({
    listCompanies: vi.fn(async () => [
      {
        doolaCompanyId: COMPANY,
        name: "Formation Agent LLC",
        formationSubmissionStatus: "SUBMITTED",
      },
    ]) as never,
  });
  await runOnboarding(baseDeps(arc, second.api));
  // Adopt-only: the lookup answered, so nothing is created at all.
  expect(second.calls.map((c) => c.method)).toEqual([]);
  expect(requests.find(KEY, "create_provider")).toMatchObject({
    state: "confirmed",
    providerRef: COMPANY,
    attempt: 0,
  });
  expect(detailOf().adopted).toBe(true);
});

test("C1: a lost CUSTOMER create keeps its key too — the retry replays rather than duplicating", async () => {
  bindParty();
  const arc = makeFakeArc();
  const lost = makeFakeDoola({
    createCustomer: vi.fn(async () => {
      throw new DoolaApiError("E_INTERNAL", 503, "upstream unavailable");
    }) as never,
  });
  await runOnboarding(baseDeps(arc, lost.api));
  expect(requests.find(KEY, "create_provider")).toMatchObject({ state: "failed", attempt: 0 });

  const fixed = makeFakeDoola();
  await runOnboarding(baseDeps(arc, fixed.api));
  expect(fixed.calls.map((c) => [c.method, c.idempotencyKey])).toEqual([
    ["createCustomer", `formation:${KEY}:create_provider:0:customer`],
    ["createCompany", `formation:${KEY}:create_provider:0:company`],
  ]);
});

test("C1: E_IDEMPOTENCY_KEY_REUSED never re-keys — it adopts, and otherwise asks for a human", async () => {
  bindParty();
  const arc = makeFakeArc();

  // A 409 says SOMETHING exists under this key and it is not what we just asked for. Blindly
  // re-keying would file a second company beside it.
  const conflicted = makeFakeDoola({
    createCompany: vi.fn(async () => {
      throw new DoolaApiError("E_IDEMPOTENCY_KEY_REUSED", 409, "key already used");
    }) as never,
  });
  await runOnboarding(baseDeps(arc, conflicted.api));
  const parked = requests.find(KEY, "create_provider")!;
  expect(parked.state).toBe("failed");
  expect(parked.attempt).toBe(0); // NOT re-keyed
  expect(parked.error).toMatch(/NOT re-keying/);
  // It looked before it parked: the lookup is the adopt path a conflict is supposed to resolve.
  expect(conflicted.calls.map((c) => c.method)).toContain("listCompanies");

  // Once doola's list catches up, the conflict resolves itself by adoption.
  const resolved = makeFakeDoola({
    listCompanies: vi.fn(async () => [
      {
        doolaCompanyId: COMPANY,
        name: "Formation Agent LLC",
        formationSubmissionStatus: "SUBMITTED",
      },
    ]) as never,
  });
  await runOnboarding(baseDeps(arc, resolved.api));
  expect(requests.find(KEY, "create_provider")).toMatchObject({
    state: "confirmed",
    providerRef: COMPANY,
    attempt: 0,
  });
});

test("C1: an environment-pin mismatch does NOT count toward abandonment (C7)", async () => {
  bindParty();
  const { api, calls } = makeFakeDoola();
  // Eight passes with the deployment pointed at the wrong environment.
  for (let i = 0; i < 8; i++) await runOnboarding(baseDeps(makeFakeArc(), api, "production"));
  const row = requests.find(KEY, "create_provider")!;
  expect(calls).toHaveLength(0);
  // A config error is not a formation going badly: the attempt never moves, so the sweeper's
  // max-attempt verdict — which is what erases the party's data — can never be reached by it.
  expect(row.attempt).toBe(0);
  expect(row.state).toBe("failed");
  expect(row.error).toMatch(/environment pin mismatch/);
});
