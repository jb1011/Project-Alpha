import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { signSession } from "../../src/auth/session";
import { SqliteAgentBookRepository } from "../../src/persistence/agentBookRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { EntityRecord } from "../../src/types";

/**
 * GET /entities/:id/agentbook must read the entity's POCKET address.
 *
 * AgentBook binds a human to the address that signs AgentKit challenges — the pocket EOA. The
 * operator SCA never signs one, so reading it could only ever answer "unregistered", and the
 * `npx … register <operator>` hint this route used to emit would have written a PERMANENT
 * binding (AgentBook has no deregistration) to an address no seller will ever query.
 *
 * The route now sits on `ApiDeps.agentBook` and reads through `createAgentBookReader`, whose
 * transport failures THROW rather than answering `null` — so "could not check" is its own
 * outcome (`unknown`) and never renders as "not registered" (design v3 §4.5).
 */

// requireAuth sets the CHECKSUMMED address as tenantId, so the fixture must match that casing.
const TENANT = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const JWT_SECRET = "s";
const OPERATOR = "0x1111111111111111111111111111111111111111";
const POCKET = "0x2222222222222222222222222222222222222222";

let db: Database.Database;
let repo: SqliteEntityRepository;
let world: SqliteWorldStore;
let abRepo: SqliteAgentBookRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  world = new SqliteWorldStore(db);
  abRepo = new SqliteAgentBookRepository(db);
});
afterEach(() => db.close());

const base = (over: Partial<EntityRecord> = {}): EntityRecord =>
  ({
    idempotencyKey: "agent-1",
    name: "AgentBookAgent",
    status: "funded",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: TENANT,
    operator: OPERATOR,
    pocketAddress: POCKET,
    amendmentDelay: "0",
    ein: "12-3456789",
    formationDate: 0,
    oaHash: null,
    metadataURI: null,
    docPath: null,
    treasuryConfig: null,
    agentId: "900001",
    proxy: null,
    treasury: null,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    ownerTenantId: TENANT,
    walletProvider: "circle",
    publicId: "33333333-3333-3333-3333-333333333333",
    ...over,
  }) as EntityRecord;

/** The READ side only — no registrar, no write budget. That is the shape a deployment without a
 *  submitter key serves, and the status route must work on exactly it. */
function makeApp(
  reader?: { lookupHuman(a: string): Promise<string | null> },
  readBudget = new TokenBucket(100, 100),
) {
  return buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    // Present but irrelevant to this route: the Orb gate is the WRITE routes' business.
    worldId: {
      cfg: {
        appId: "app_x",
        rpId: "rp_x",
        rpSigningKey: `0x${"1".repeat(64)}`,
        action: "guardian-verification",
        environment: "staging" as const,
      },
      store: world,
      requireGuardian: false,
    },
    agentBook: {
      repo: abRepo,
      reader: reader ?? { lookupHuman: async () => null },
      store: world,
      network: "testnet",
      caps: { perEntityLifetime: 3, perTenantPerHour: 5 },
      readBudget,
    },
  } as never);
}

/**
 * A vouch of OUR OWN, confirmed. Needed wherever a test means "registered": the route answers
 * "did WE vouch, and does the registry still agree?" (§3 precondition 5), so a lookup with no row
 * behind it is `disputed` — someone else's vouch — however valid the id is.
 */
function vouched(humanId: string) {
  abRepo.createSession({
    sessionId: "s1",
    entityKey: "agent-1",
    tenantId: TENANT,
    address: POCKET,
    nonce: "0",
    expiresAt: Date.now() + 60_000,
  });
  abRepo.claimSubmit("s1", { nullifier: humanId, rawTx: "0x02raw", submitterNonce: 0 });
  abRepo.transition("s1", "submitted", "confirmed");
}

const token = async () =>
  (await signSession(TENANT, JWT_SECRET, 3600, Math.floor(Date.now() / 1000))).token;

const get = async (app: ReturnType<typeof buildApiApp>) =>
  await (
    await app.request("/entities/agent-1/agentbook", {
      headers: { authorization: `Bearer ${await token()}` },
    })
  ).json();

test("reports the human registered against the POCKET address", async () => {
  repo.upsert(base());
  vouched("0xdeadbeef");
  const app = makeApp({ lookupHuman: async (a) => (a === POCKET ? "0xdeadbeef" : null) });
  const body = await get(app);
  expect(body).toMatchObject({
    registered: true,
    humanId: "0xdeadbeef",
    address: POCKET,
    outcome: "registered",
  });
});

test("a human bound to the pocket by SOMEONE ELSE is disputed, never registered (FR-A)", async () => {
  repo.upsert(base());
  const app = makeApp({ lookupHuman: async () => "0xdeadbeef" });
  const body = await get(app);
  expect(body).toMatchObject({
    registered: false,
    outcome: "disputed",
    disputed: true,
    humanId: "0xdeadbeef",
  });
});

test("a registration on the OPERATOR address is not reported — that address is never looked up", async () => {
  repo.upsert(base());
  const app = makeApp({ lookupHuman: async (a) => (a === OPERATOR ? "0xdeadbeef" : null) });
  const body = await get(app);
  expect(body.registered).toBe(false);
  expect(body.outcome).toBe("unregistered");
  expect(JSON.stringify(body)).not.toContain("0xdeadbeef");
});

test("never emits registration instructions — a wrong registration cannot be undone", async () => {
  repo.upsert(base());
  const app = makeApp();
  const body = await get(app);
  expect(JSON.stringify(body)).not.toContain("agentkit-cli");
  expect(body.register).toBeUndefined();
});

test("an entity with no pocket address yet says so, and reveals no other address", async () => {
  repo.upsert(base({ pocketAddress: null }));
  const app = makeApp();
  const body = await get(app);
  expect(body).toMatchObject({ registered: false, reason: "no-pocket-yet" });
  expect(JSON.stringify(body)).not.toContain(OPERATOR);
});

test("an RPC failure is 'unknown', never 'not registered'", async () => {
  repo.upsert(base());
  const app = makeApp({
    lookupHuman: async () => {
      throw new Error("rpc down");
    },
  });
  const body = await get(app);
  expect(body).toMatchObject({ registered: false, outcome: "unknown" });
});

test("an exhausted READ budget is 'unknown' too, and costs no RPC call", async () => {
  repo.upsert(base());
  let calls = 0;
  const app = makeApp(
    {
      lookupHuman: async () => {
        calls += 1;
        return "0xdeadbeef";
      },
    },
    new TokenBucket(0, 0),
  );
  const body = await get(app);
  expect(body).toMatchObject({ registered: false, outcome: "unknown" });
  expect(calls).toBe(0);
});

test("a cached positive lookup answers without touching the reader OR the budget", async () => {
  repo.upsert(base());
  vouched("0xdeadbeef");
  world.cacheLookup(POCKET, "0xdeadbeef", Date.now());
  let calls = 0;
  const app = makeApp(
    {
      lookupHuman: async () => {
        calls += 1;
        return "0xdeadbeef";
      },
    },
    // Empty on purpose: a cache hit must not need a token, so this bucket proves the hit.
    new TokenBucket(0, 0),
  );
  const body = await get(app);
  expect(body).toMatchObject({ registered: true, humanId: "0xdeadbeef", outcome: "registered" });
  expect(calls).toBe(0);
});

test("a fresh lookup is written back to the cache, so the second read is free", async () => {
  repo.upsert(base());
  vouched("0xdeadbeef");
  let calls = 0;
  const app = makeApp({
    lookupHuman: async () => {
      calls += 1;
      return "0xdeadbeef";
    },
  });
  expect((await get(app)).outcome).toBe("registered");
  expect((await get(app)).outcome).toBe("registered");
  expect(calls).toBe(1);
});

test("an outage is never cached: the next read asks again instead of serving a stale refusal", async () => {
  repo.upsert(base());
  let calls = 0;
  const app = makeApp({
    lookupHuman: async () => {
      calls += 1;
      if (calls === 1) throw new Error("rpc down");
      return "0xdeadbeef";
    },
  });
  expect((await get(app)).outcome).toBe("unknown");
  // Asked again rather than serving a stale refusal. `disputed` and not `registered` because this
  // agent has no vouch of ours behind it (FR-A) — what matters here is that the second read
  // reached the contract at all.
  expect((await get(app)).outcome).toBe("disputed");
});

test("the status route works on a deployment with NO registrar — reading needs no submitter key", async () => {
  repo.upsert(base());
  vouched("0xdeadbeef");
  const app = makeApp({ lookupHuman: async () => "0xdeadbeef" });
  expect(await get(app)).toMatchObject({ registered: true, outcome: "registered" });
  // …and such a deployment says so, rather than offering a dialog it cannot finish.
  const cfg = await (await app.request("/config")).json();
  expect(cfg.agentBookRegistrationAvailable).toBe(false);
});
