import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import { buildApiApp } from "../../src/api/app";
import { TokenBucket } from "../../src/api/routes/agentBook";
import { signSession } from "../../src/auth/session";
import { SqliteAgentBookRepository } from "../../src/persistence/agentBookRepository";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqliteWorldStore } from "../../src/persistence/worldStore";
import type { EntityRecord } from "../../src/types";

/**
 * The two write routes (design 2026-08-25 v3 §4.5, §4.7).
 *
 * The invariants under test are the ones a human pays for when they break: only an Orb credential
 * may vouch, the caps bite before any World Chain read, the raw transaction is PERSISTED before it
 * is broadcast, and neither the 4xx body nor the ops log ever carries the proof or the nullifier —
 * a viem contract error prints the call arguments, and the call arguments are the proof.
 */

const TENANT = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const JWT_SECRET = "s";
const POCKET = "0x2222222222222222222222222222222222222222";
const ACTION = "guardian-verification";
const NULLIFIER = "0x0badf00d";
const PROOF = Array.from({ length: 8 }, (_, i) => `0x${(i + 1).toString(16)}`);

let db: Database.Database;
let repo: SqliteEntityRepository;
let world: SqliteWorldStore;
let abRepo: SqliteAgentBookRepository;
let logs: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  world = new SqliteWorldStore(db);
  abRepo = new SqliteAgentBookRepository(db);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a) => {
    logs.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation((...a) => {
    logs.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const entity = (over: Partial<EntityRecord> = {}): EntityRecord =>
  ({
    idempotencyKey: "agent-1",
    name: "A",
    status: "funded",
    manager: "0x000000000000000000000000000000000000000A",
    guardian: TENANT,
    operator: "0x1111111111111111111111111111111111111111",
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

function verifyGuardian(credential = "proof_of_human") {
  // The same call the World verify route makes after a successful proof (routes/worldId.ts:184).
  world.recordVerification({
    nullifier: "0xguardian",
    action: ACTION,
    tenantId: TENANT,
    issuerSchemaId: null,
    credential,
    environment: "staging",
    verifiedAt: Date.now(),
    expiresAtMin: null,
  });
}

const registrar = () => ({
  address: "0x9999999999999999999999999999999999999999",
  getNextNonce: vi.fn(async () => 0n),
  lookupHuman: vi.fn(async (): Promise<string | null> => null),
  simulateRegister: vi.fn(async () => {}),
  signRegister: vi.fn(async () => ({ rawTx: "0x02raw" as const, submitterNonce: 1 })),
  broadcast: vi.fn(async () => "0xtxhash" as const),
  receiptStatus: vi.fn(async (): Promise<"success" | "reverted" | null> => null),
  submitterNonce: vi.fn(async () => 1),
  submitterBalance: vi.fn(async () => 10n ** 16n),
});

/** `reg: null` builds the READ-ONLY deployment shape — no submitter key, so no write half.
 *  (`undefined` cannot mean that: it is what a default parameter fills in.) */
function makeApp(
  reg: ReturnType<typeof registrar> | null = registrar(),
  caps = { perEntityLifetime: 3, perTenantPerHour: 5 },
  budget = new TokenBucket(100, 100),
) {
  return buildApiApp({
    webOrigin: "*",
    jwtSecret: JWT_SECRET,
    repo,
    worldId: {
      cfg: {
        appId: "app_x",
        rpId: "rp_x",
        rpSigningKey: `0x${"1".repeat(64)}`,
        action: ACTION,
        environment: "staging" as const,
      },
      store: world,
      requireGuardian: false,
    },
    agentBook: {
      repo: abRepo,
      reader: { lookupHuman: async () => null },
      store: world,
      network: "testnet",
      caps,
      readBudget: new TokenBucket(100, 100),
      registrar: reg ?? undefined,
      budget: reg ? budget : undefined,
    },
  } as never);
}

const token = async () =>
  (await signSession(TENANT, JWT_SECRET, 3600, Math.floor(Date.now() / 1000))).token;
const callEntity = async (
  app: ReturnType<typeof buildApiApp>,
  entityId: string,
  path: string,
  body?: unknown,
) =>
  app.request(`/entities/${entityId}/agentbook${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const call = (app: ReturnType<typeof buildApiApp>, path: string, body?: unknown) =>
  callEntity(app, "agent-1", path, body);

const proofBody = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId,
  root: "0x1",
  nonce: "0",
  nullifierHash: NULLIFIER,
  proof: PROOF,
  ...over,
});

test("session: Orb guardian gets signal, nonce, address, agent id, network", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const res = await call(makeApp(), "/session", {});
  expect(res.status).toBe(200);
  const b = await res.json();
  expect(b).toMatchObject({
    appId: "app_a7c3e2b6b83927251a0db5345bd7146a",
    action: "agentbook-registration",
    nonce: "0",
    pocketAddress: POCKET,
    agentId: "900001",
    network: "testnet",
    priorVouches: 0,
  });
  expect(b.signal).toBe(`0x${"22".repeat(20)}${"00".repeat(32)}`);
  expect(abRepo.findBySession(b.sessionId)?.status).toBe("pending");
});

test("session: a passport guardian is refused with not_eligible and the Orb message", async () => {
  repo.upsert(entity());
  verifyGuardian("passport");
  const res = await call(makeApp(), "/session", {});
  expect(res.status).toBe(403);
  const b = await res.json();
  expect(b.error.code).toBe("not_eligible");
  expect(b.error.message).toContain("World ID from an Orb");
});

test("session: waiver guardian refused; no pocket -> not_ready; status below bound -> not_ready", async () => {
  repo.upsert(entity());
  verifyGuardian("waiver");
  expect((await call(makeApp(), "/session", {})).status).toBe(403);
  verifyGuardian();
  repo.upsert(entity({ pocketAddress: null }));
  expect((await call(makeApp(), "/session", {})).status).toBe(409);
  repo.upsert(entity({ status: "created" }));
  expect((await call(makeApp(), "/session", {})).status).toBe(409);
});

test("session: an agent with no on-chain id yet is not_ready — the dialog cannot name it", async () => {
  repo.upsert(entity({ agentId: null }));
  verifyGuardian();
  const res = await call(makeApp(), "/session", {});
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe("not_ready");
});

test("caps: the tenant window and the entity lifetime cap return 429; the budget returns 503 before any RPC", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg, { perEntityLifetime: 3, perTenantPerHour: 2 });
  expect((await call(app, "/session", {})).status).toBe(200);
  expect((await call(app, "/session", {})).status).toBe(200);
  expect((await call(app, "/session", {})).status).toBe(429);
  const starved = makeApp(registrar(), undefined, new TokenBucket(0, 0));
  const res = await call(starved, "/session", {});
  expect(res.status).toBe(503);
  expect(reg.getNextNonce).toHaveBeenCalledTimes(2);
});

test("caps: three lifetime rows close the door on a fourth session", async () => {
  repo.upsert(entity());
  verifyGuardian();
  for (let i = 0; i < 3; i++) {
    const row = abRepo.createSession({
      sessionId: randomUUID(),
      entityKey: "agent-1",
      tenantId: TENANT,
      address: POCKET,
      nonce: "0",
      expiresAt: Date.now() + 60_000,
    });
    abRepo.claimSubmit(row.sessionId, { nullifier: NULLIFIER, rawTx: "0x02", submitterNonce: i });
    abRepo.transition(row.sessionId, "submitted", "confirmed");
  }
  const reg = registrar();
  const res = await call(makeApp(reg), "/session", {});
  expect(res.status).toBe(429);
  expect((await res.json()).error.code).toBe("limit_exceeded");
  expect(reg.getNextNonce).not.toHaveBeenCalled();
});

test("register: happy path claims, persists before broadcast, broadcasts, stores the hash", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", proofBody(sessionId));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "submitted", txHash: "0xtxhash" });
  const row = abRepo.findBySession(sessionId);
  expect(row).toMatchObject({
    status: "submitted",
    nullifier: NULLIFIER,
    rawTx: "0x02raw",
    submitterNonce: 1,
    txHash: "0xtxhash",
  });
  expect(reg.simulateRegister).toHaveBeenCalledOnce();
  expect(reg.signRegister.mock.invocationCallOrder[0]).toBeLessThan(
    reg.broadcast.mock.invocationCallOrder[0] as number,
  );
});

test("register: a nonce that moved is a 409 and nothing is signed", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  reg.getNextNonce.mockResolvedValue(1n);
  const res = await call(app, "/register", proofBody(sessionId));
  expect(res.status).toBe(409);
  expect(reg.signRegister).not.toHaveBeenCalled();
});

test("register: a deterministic revert is proof_rejected with the error NAME only; the log and body never carry the proof or the nullifier", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  reg.simulateRegister.mockRejectedValue(
    new ContractRevertError("AgentBook.register reverted: InvalidNonce", "InvalidNonce"),
  );
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", proofBody(sessionId));
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(text).toContain("InvalidNonce");
  expect(text).not.toContain(NULLIFIER);
  expect(text).not.toContain(PROOF[3]);
  expect(logs.join("\n")).not.toContain(NULLIFIER);
  expect(abRepo.findBySession(sessionId)).toMatchObject({
    status: "pending",
    attempt: 1,
    errorCode: "InvalidNonce",
  });
});

test("register: a revert raised by the SIGNING estimate is proof_rejected too, not a 500", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  reg.signRegister.mockRejectedValue(
    new ContractRevertError("AgentBook.register reverted: AlreadyRegistered", "AlreadyRegistered"),
  );
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", proofBody(sessionId));
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatchObject({
    code: "proof_rejected",
    details: { errorName: "AlreadyRegistered" },
  });
  expect(reg.broadcast).not.toHaveBeenCalled();
  expect(abRepo.findBySession(sessionId)).toMatchObject({
    status: "pending",
    attempt: 1,
    errorCode: "AlreadyRegistered",
  });
});

test("register: a transport failure while signing is 503, and the session stays usable", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  reg.signRegister.mockRejectedValue(new Error("socket hang up"));
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", proofBody(sessionId));
  expect(res.status).toBe(503);
  expect((await res.json()).error.code).toBe("unavailable");
  expect(abRepo.findBySession(sessionId)).toMatchObject({ status: "pending", attempt: 1 });
});

test("register: a submitter balance that cannot be read is 503, never a 500", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  reg.submitterBalance.mockRejectedValue(new Error("rpc down"));
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", proofBody(sessionId));
  expect(res.status).toBe(503);
  expect((await res.json()).error.code).toBe("unavailable");
  expect(reg.signRegister).not.toHaveBeenCalled();
});

test("register: input validation rejects 7 proof elements and a malformed session id; an unknown session is a 409", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const app = makeApp();
  const { sessionId } = await (await call(app, "/session", {})).json();
  expect(
    (await call(app, "/register", proofBody(sessionId, { proof: PROOF.slice(0, 7) }))).status,
  ).toBe(400);
  expect((await call(app, "/register", proofBody("nope"))).status).toBe(400);
  // Well-formed but not ours: the session simply does not exist, which is a state conflict.
  expect((await call(app, "/register", proofBody(randomUUID()))).status).toBe(409);
});

test("register: the transaction is signed over the SESSION's address, not the entity's current one", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  // The guardian's proof carries `buildSignal(POCKET, 0)`. Moving the entity's pocket afterwards
  // must not move what we sign: the proof would be spent on a certain revert.
  repo.upsert(entity({ pocketAddress: "0x4444444444444444444444444444444444444444" }));
  expect((await call(app, "/register", proofBody(sessionId))).status).toBe(200);
  expect(reg.simulateRegister).toHaveBeenCalledWith(
    expect.objectContaining({ agent: getAddress(POCKET) }),
  );
  expect(reg.signRegister).toHaveBeenCalledWith(
    expect.objectContaining({ agent: getAddress(POCKET) }),
  );
});

test("register: a broadcast that fails is still 200 — the raw tx is stored and the reconciler owns it", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  reg.broadcast.mockRejectedValue(new Error("mempool unreachable"));
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", proofBody(sessionId));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "submitted", txHash: null });
  expect(abRepo.findBySession(sessionId)).toMatchObject({
    status: "submitted",
    rawTx: "0x02raw",
    txHash: null,
  });
});

test("register: another submission already in flight for this agent is a 409, and nothing is broadcast", async () => {
  repo.upsert(entity());
  verifyGuardian();
  // The partial unique index on `submitted` is the atomic in-flight claim.
  const other = abRepo.createSession({
    sessionId: randomUUID(),
    entityKey: "agent-1",
    tenantId: TENANT,
    address: POCKET,
    nonce: "0",
    expiresAt: Date.now() + 60_000,
  });
  abRepo.claimSubmit(other.sessionId, {
    nullifier: NULLIFIER,
    rawTx: "0x01raw",
    submitterNonce: 0,
  });
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", proofBody(sessionId));
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe("conflict");
  expect(reg.broadcast).not.toHaveBeenCalled();
});

test("register: losing the claim race is a 409, and nothing is broadcast", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  vi.spyOn(abRepo, "claimSubmit").mockReturnValue("lost");
  const res = await call(app, "/register", proofBody(sessionId));
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe("conflict");
  expect(reg.broadcast).not.toHaveBeenCalled();
});

test("both write routes answer 404 for an entity that is not this tenant's", async () => {
  repo.upsert(entity());
  repo.upsert(
    entity({
      idempotencyKey: "agent-2",
      ownerTenantId: getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      publicId: "44444444-4444-4444-4444-444444444444",
    }),
  );
  verifyGuardian();
  const app = makeApp();
  expect((await callEntity(app, "agent-2", "/session", {})).status).toBe(404);
  expect((await callEntity(app, "agent-2", "/register", proofBody(randomUUID()))).status).toBe(404);
  expect((await callEntity(app, "no-such-agent", "/session", {})).status).toBe(404);
});

test("a deployment with no submitter key refuses both write routes with 503 and advertises false", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const app = makeApp(null);
  for (const path of ["/session", "/register"]) {
    const res = await call(app, path, path === "/session" ? {} : proofBody(randomUUID()));
    expect(res.status).toBe(503);
    const b = await res.json();
    expect(b.error.code).toBe("unavailable");
    expect(b.error.message).toBe("AgentBook registration is not configured on this deployment");
  }
  // No session row was created: the refusal lands before any cap or repository work.
  expect(abRepo.countSessionsSince(TENANT, 0)).toBe(0);
  const cfg = await (await app.request("/config")).json();
  expect(cfg.agentBookRegistrationAvailable).toBe(false);
});

test("an exhausted WRITE budget stops a vouch but never blinds the status chip", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const app = makeApp(registrar(), undefined, new TokenBucket(0, 0));
  expect((await call(app, "/session", {})).status).toBe(503);
  // The two budgets are separate: the status read has its own allowance and still answers.
  const res = await call(app, "");
  expect(res.status).toBe(200);
  expect((await res.json()).outcome).toBe("unregistered");
});

test("a deployment WITH a submitter key advertises the vouch dialog", async () => {
  const cfg = await (await makeApp().request("/config")).json();
  expect(cfg.agentBookRegistrationAvailable).toBe(true);
});

test("GET after submit reconciles and reports the row", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  await call(app, "/register", proofBody(sessionId));
  reg.getNextNonce.mockResolvedValue(1n);
  reg.lookupHuman.mockResolvedValue(NULLIFIER);
  const b = await (await call(app, "")).json();
  expect(b).toMatchObject({
    status: "confirmed",
    txHash: "0xtxhash",
    disputed: false,
    address: POCKET,
  });
  expect(b.errorCode).toBeUndefined();
});
