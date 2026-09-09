import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getAddress } from "viem";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import type { SubmitClaim } from "../../src/adapters/worldid/agentBookRegistrar";
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
/** The status route's plain-lookup path. A spy, so a test can prove it was NOT consulted. */
let reader: { lookupHuman: ReturnType<typeof vi.fn> };
let logs: string[];

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  world = new SqliteWorldStore(db);
  abRepo = new SqliteAgentBookRepository(db);
  reader = { lookupHuman: vi.fn(async () => null) };
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

/**
 * The registrar stub. `submitRegister` is spelled out rather than mocked flat because it is the
 * locked sign → persist → broadcast entry point (FR-C) and the route's behaviour depends on the
 * ORDER of those three: this fake performs them in the real order, delegating to the `signRegister`
 * and `broadcast` spies so a test can still make either one fail or assert it was never reached.
 */
const registrar = () => {
  const r = {
    address: "0x9999999999999999999999999999999999999999",
    getNextNonce: vi.fn(async () => 0n),
    lookupHuman: vi.fn(async (): Promise<string | null> => null),
    simulateRegister: vi.fn(async () => {}),
    signRegister: vi.fn(async (_args: unknown) => ({
      rawTx: "0x02raw" as const,
      submitterNonce: 1,
    })),
    broadcast: vi.fn(async (_rawTx: string) => "0xtxhash" as const),
    receiptStatus: vi.fn(async (): Promise<"success" | "reverted" | null> => null),
    submitterNonce: vi.fn(async () => 1),
    submitterBalance: vi.fn(async () => 10n ** 16n),
    submitRegister: vi.fn(
      async (
        args: unknown,
        persist: (s: { rawTx: `0x${string}`; submitterNonce: number }) => SubmitClaim,
      ) => {
        const signed = await r.signRegister(args);
        const claim = await persist(signed);
        if (claim !== "won") return { signed, claim, txHash: null };
        try {
          return { signed, claim, txHash: await r.broadcast(signed.rawTx) };
        } catch (e) {
          return {
            signed,
            claim,
            txHash: null,
            broadcastErrorName: e instanceof Error ? e.name : "unknown",
          };
        }
      },
    ),
  };
  return r;
};

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
      reader,
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
  // The fixture is shaped like the REAL leak vector (backend F5): viem's contract errors print the
  // call arguments, and the call arguments are `agent, root, nonce, nullifierHash, proof[8]`. So
  // both the message and the cause chain of this one carry the nullifier and a proof word — the
  // three negative assertions below are vacuous against an error that contains neither.
  const leaky = new Error(
    `The contract function "register" reverted.\n\nArgs: (${POCKET}, 0x1, 0, ${NULLIFIER}, [${PROOF.join(", ")}])`,
  );
  reg.simulateRegister.mockRejectedValue(
    new ContractRevertError("AgentBook.register reverted: InvalidNonce", "InvalidNonce", {
      cause: leaky,
    }),
  );
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", proofBody(sessionId));
  expect(res.status).toBe(400);
  const text = await res.text();
  expect(text).toContain("InvalidNonce");
  expect(text).not.toContain(NULLIFIER);
  expect(text).not.toContain(PROOF[3]);
  expect(text).not.toContain("reverted.");
  expect(logs.join("\n")).not.toContain(NULLIFIER);
  expect(logs.join("\n")).not.toContain(PROOF[3]);
  // FR-B: the contract decided, and the proof cannot be replayed — the session ends `failed` with
  // the diagnostic rather than staying open until it expires.
  expect(abRepo.findBySession(sessionId)).toMatchObject({
    status: "failed",
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
    status: "failed",
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
  // FR-B: nothing was decided, so NOTHING is written — not even the attempt counter. That count is
  // a record of what the contract rejected (§4.1); spending it on a bad minute at the RPC would
  // burn one of the guardian's three lifetime attempts for free. The proof is still good.
  expect(abRepo.findBySession(sessionId)).toMatchObject({
    status: "pending",
    attempt: 0,
    errorCode: null,
  });
  expect(logs.join("\n")).toContain("agentbook_write_unavailable");
});

test("register: a transport failure at SIMULATE writes nothing either (FR-B)", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  reg.simulateRegister.mockRejectedValue(new Error("HTTP 429 Too Many Requests"));
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  expect((await call(app, "/register", proofBody(sessionId))).status).toBe(503);
  expect(abRepo.findBySession(sessionId)).toMatchObject({
    status: "pending",
    attempt: 0,
    errorCode: null,
  });
  expect(reg.signRegister).not.toHaveBeenCalled();
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

test("a confirming reconcile beats the negative the previous poll cached", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  await call(app, "/register", proofBody(sessionId));

  // Poll 1: still in flight, nobody registered yet. This caches `null` for 60 seconds — the
  // entry that used to be served BESIDE a confirmed row for the rest of that minute.
  const first = await (await call(app, "")).json();
  expect(first).toMatchObject({ status: "submitted", registered: false, outcome: "unregistered" });

  // Poll 2: the chain has moved, and lookupHuman answers with OUR nullifier (minimal hex for the
  // padded value we stored — the reconciler compares numerically).
  reg.getNextNonce.mockResolvedValue(1n);
  reg.lookupHuman.mockResolvedValue("0xbadf00d");
  const second = await (await call(app, "")).json();
  expect(second).toMatchObject({
    status: "confirmed",
    registered: true,
    outcome: "registered",
    humanId: "0xbadf00d",
    disputed: false,
  });
  // The reader was consulted ONCE — by poll 1. Poll 2 answered from the reconciled row and
  // refreshed the cache on the way past instead of reading it.
  expect(reader.lookupHuman).toHaveBeenCalledTimes(1);
  // Cached in the SAME spelling every other writer uses (minimal hex), because worldVerifier
  // keys its per-human allowance off this value.
  expect(world.getCachedLookup(POCKET, Date.now(), 600_000, 60_000)).toEqual({
    humanId: "0xbadf00d",
  });
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

/**
 * Whose vouch is it? (design §3 precondition 5, §8 HIGH-2, ruling FR-A)
 *
 * The question the status route answers is NOT "is this address registered". A non-null lookup we
 * did not write means someone else vouched — `disputed`, the state that keeps the vouch button
 * open — and never a finished "registered" that would lock the guardian out of overwriting a
 * stranger's binding. The mirror image matters just as much: a `failed` row whose nullifier the
 * registry now holds IS our vouch, mined after we gave up on it.
 */
const seedRow = (
  status: "submitted" | "failed" | "confirmed" | "disputed",
  nullifier: string,
  over: { txHash?: string } = {},
) => {
  const sessionId = randomUUID();
  abRepo.createSession({
    sessionId,
    entityKey: "agent-1",
    tenantId: TENANT,
    address: POCKET,
    nonce: "0",
    expiresAt: Date.now() + 60_000,
  });
  abRepo.claimSubmit(sessionId, { nullifier, rawTx: "0x02raw", submitterNonce: 0 });
  if (over.txHash) abRepo.setTxHash(sessionId, over.txHash);
  // `claimSubmit` already left the row `submitted`; anything else is one CAS move past it.
  if (status !== "submitted")
    abRepo.transition(
      sessionId,
      "submitted",
      status,
      status === "failed" ? { errorCode: "reverted" } : {},
    );
  return sessionId;
};

/**
 * A session opened and abandoned: the dialog wrote the row, no proof was ever submitted, so it
 * carries NO nullifier — and it is the newest row from the moment it exists.
 */
const seedAbandoned = (status: "pending" | "expired") => {
  const sessionId = randomUUID();
  abRepo.createSession({
    sessionId,
    entityKey: "agent-1",
    tenantId: TENANT,
    address: POCKET,
    nonce: "0",
    expiresAt: Date.now() + 60_000,
  });
  if (status === "expired") abRepo.transition(sessionId, "pending", "expired");
  return sessionId;
};

test("FR-A: a stranger's vouch with NO row of ours is disputed, not registered", async () => {
  repo.upsert(entity());
  reader.lookupHuman.mockResolvedValue("0x5714a9e7");
  const b = await (await call(makeApp(), "")).json();
  // The lock-out §8 HIGH-2 describes: outcome "registered" here would render "Vouched in AgentBook"
  // and disable the button with "Already vouched", over a binding that points at a stranger.
  expect(b).toMatchObject({
    registered: false,
    outcome: "disputed",
    disputed: true,
    humanId: "0x5714a9e7",
  });
  expect(b.status).toBeUndefined();
});

test("FR-A: a failed row and a DIFFERENT nullifier on chain is disputed", async () => {
  repo.upsert(entity());
  seedRow("failed", NULLIFIER);
  reader.lookupHuman.mockResolvedValue("0x5714a9e7");
  const b = await (await call(makeApp(), "")).json();
  expect(b).toMatchObject({
    registered: false,
    outcome: "disputed",
    disputed: true,
    status: "failed",
    errorCode: "reverted",
  });
});

test("FR-A: a failed row whose nullifier the registry now holds is REGISTERED — the registry outranks our record", async () => {
  repo.upsert(entity());
  seedRow("failed", NULLIFIER, { txHash: "0xh" });
  // Minimal hex for the padded value the row stores: the same human, as the contract spells it.
  reader.lookupHuman.mockResolvedValue("0xbadf00d");
  const b = await (await call(makeApp(), "")).json();
  expect(b).toMatchObject({
    registered: true,
    outcome: "registered",
    disputed: false,
    humanId: "0xbadf00d",
    status: "failed",
  });
});

test("FR-A: a CONFIRMED row and a different nullifier on chain is disputed (someone overwrote us)", async () => {
  repo.upsert(entity());
  seedRow("confirmed", NULLIFIER);
  reader.lookupHuman.mockResolvedValue("0x5714a9e7");
  const b = await (await call(makeApp(), "")).json();
  expect(b).toMatchObject({
    registered: false,
    outcome: "disputed",
    disputed: true,
    humanId: "0x5714a9e7",
    status: "confirmed",
  });
});

test("FR-A: a reconcile that lands on someone else's nullifier reports disputed at the route", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  await call(app, "/register", proofBody(sessionId));
  // The chain moved, and the human it now names is not the one our proof carried: the reconciler
  // writes `disputed` and caches the foreign id so the trust dials stop serving ours.
  reg.getNextNonce.mockResolvedValue(1n);
  reg.lookupHuman.mockResolvedValue("0x5714a9e7");
  reader.lookupHuman.mockResolvedValue("0x5714a9e7");
  const b = await (await call(app, "")).json();
  expect(b).toMatchObject({
    registered: false,
    status: "disputed",
    outcome: "disputed",
    disputed: true,
  });
  expect(abRepo.findBySession(sessionId)?.status).toBe("disputed");
});

/**
 * AN ABANDONED SESSION MUST NOT SHADOW A CONFIRMED VOUCH (re-review R1)
 *
 * `currentForEntity` answers with the NEWEST row once nothing is in flight, and a session opened
 * in a second tab and never finished carries no nullifier — so it can match nothing on chain.
 * Asking "is this vouch ours?" of that row alone answered "no" about an entry we wrote ourselves:
 * a permanent "Someone else has replaced the vouch", with the button re-opened for a second,
 * pointless on-chain write. The question belongs to the ENTITY.
 */
test("R1: a newer EXPIRED session does not shadow our confirmed vouch", async () => {
  repo.upsert(entity());
  seedRow("confirmed", NULLIFIER, { txHash: "0xh" });
  seedAbandoned("expired");
  reader.lookupHuman.mockResolvedValue("0xbadf00d");
  const b = await (await call(makeApp(null), "")).json();
  expect(b).toMatchObject({
    registered: true,
    outcome: "registered",
    disputed: false,
    humanId: "0xbadf00d",
    // The CONFIRMED row is what the body describes, not the abandoned one: the chip builds the
    // link to the guardian's own transaction out of `status === "confirmed" && txHash`
    // (chipState.explorerHref), and falls back to the contract page without it.
    status: "confirmed",
    txHash: "0xh",
  });
});

test("R1: with a newer expired session, a registry that holds SOMEONE ELSE's id is still disputed", async () => {
  repo.upsert(entity());
  seedRow("confirmed", NULLIFIER, { txHash: "0xh" });
  seedAbandoned("expired");
  reader.lookupHuman.mockResolvedValue("0x5714a9e7");
  const b = await (await call(makeApp(null), "")).json();
  expect(b).toMatchObject({
    registered: false,
    outcome: "disputed",
    disputed: true,
    humanId: "0x5714a9e7",
  });
});

test("R1: a newer PENDING session does not shadow our confirmed vouch either", async () => {
  repo.upsert(entity());
  seedRow("confirmed", NULLIFIER, { txHash: "0xh" });
  seedAbandoned("pending");
  reader.lookupHuman.mockResolvedValue("0xbadf00d");
  const b = await (await call(makeApp(null), "")).json();
  // Not `status: "pending"`: a session waiting in a second tab is not what this agent's AgentBook
  // entry is, and the chip would drop the transaction link on it.
  expect(b).toMatchObject({
    registered: true,
    outcome: "registered",
    disputed: false,
    status: "confirmed",
    txHash: "0xh",
  });
});

test("R1: a pending session with no vouch of ours behind it is disputed, as before", async () => {
  repo.upsert(entity());
  seedAbandoned("pending");
  reader.lookupHuman.mockResolvedValue("0x5714a9e7");
  const b = await (await call(makeApp(null), "")).json();
  // The entity has never written a nullifier, so the id on chain really is a stranger's.
  expect(b).toMatchObject({
    registered: false,
    outcome: "disputed",
    disputed: true,
    humanId: "0x5714a9e7",
    status: "pending",
  });
});

test("R1: an in-flight submitted row still outranks an older confirmed one (§5.2)", async () => {
  repo.upsert(entity());
  seedRow("confirmed", NULLIFIER, { txHash: "0xold" });
  seedRow("submitted", NULLIFIER, { txHash: "0xnew" });
  reader.lookupHuman.mockResolvedValue("0xbadf00d");
  const b = await (await call(makeApp(null), "")).json();
  // The displayed row is the one still on its way, not the older confirmation it will replace.
  expect(b).toMatchObject({
    status: "submitted",
    txHash: "0xnew",
    outcome: "registered",
    disputed: false,
  });
});

test("FR-D: a confirmed row beats a cached negative — the sweep can confirm without this request", async () => {
  repo.upsert(entity());
  seedRow("confirmed", NULLIFIER, { txHash: "0xh" });
  // What the previous poll cached while the row was still in flight, and what the background
  // reconciler's confirmation does not reach: 60 seconds of "not in AgentBook" over our own vouch,
  // which our seller gate and buyer dial read out of the same cache.
  world.cacheLookup(POCKET, null, Date.now());
  const b = await (await call(makeApp(null), "")).json();
  expect(b).toMatchObject({
    registered: true,
    outcome: "registered",
    humanId: "0xbadf00d",
    status: "confirmed",
  });
  expect(reader.lookupHuman).not.toHaveBeenCalled();
  // …and the poisoned entry is replaced on the way past, in the spelling worldVerifier keys its
  // per-human allowance off.
  expect(world.getCachedLookup(POCKET, Date.now(), 600_000, 60_000)).toEqual({
    humanId: "0xbadf00d",
  });
});

test("R2: a poll that only read the CACHE does not re-stamp it", async () => {
  repo.upsert(entity());
  seedRow("confirmed", NULLIFIER, { txHash: "0xh" });
  // Nine minutes into the ten-minute life of a positive a real contract read established.
  world.cacheLookup(POCKET, "0xbadf00d", Date.now() - 9 * 60_000);
  const b = await (await call(makeApp(null), "")).json();
  expect(b).toMatchObject({ registered: true, outcome: "registered", status: "confirmed" });
  expect(reader.lookupHuman).not.toHaveBeenCalled();
  // It still ages out on its ORIGINAL stamp: re-stamping a positive on every dashboard poll would
  // hold it past its TTL for as long as anyone is looking, and the contract read that TTL exists to
  // force — the one that would notice a stranger overwriting us — would never be made.
  expect(world.getCachedLookup(POCKET, Date.now() + 2 * 60_000, 600_000, 60_000)).toBeUndefined();
});

test("FR-F: the status body carries network and priorVouches on both the registered and the unregistered branch", async () => {
  repo.upsert(entity());
  const unregistered = await (await call(makeApp(null), "")).json();
  // The dialog renders §5.1's testnet-permanence line and the "you have vouched for N agents" line
  // off the status it already polls, without having to open a session first.
  expect(unregistered).toMatchObject({
    outcome: "unregistered",
    network: "testnet",
    priorVouches: 0,
  });
  seedRow("confirmed", NULLIFIER);
  reader.lookupHuman.mockResolvedValue("0xbadf00d");
  const registered = await (await call(makeApp(null), "")).json();
  expect(registered).toMatchObject({
    outcome: "registered",
    network: "testnet",
    priorVouches: 1,
  });
});

test("an agent with no pocket says 'could not check', never 'not registered'", async () => {
  repo.upsert(entity({ pocketAddress: null }));
  const b = await (await call(makeApp(null), "")).json();
  // There is no address to be unregistered AT: we asked the contract nothing (§3.2).
  expect(b).toEqual({
    registered: false,
    reason: "no-pocket-yet",
    outcome: "unknown",
    disputed: false,
  });
});

test("the status address is EIP-55 checksummed, like the session route's", async () => {
  // Circle stores a pocket exactly as it returns it (lowercase); the dialog shows the GET's address
  // beside the session's and asks the guardian to compare both with Arcscan (D8).
  const lower = "0x4bbeeb066ed09b7aed07bf39eee0460dfa261520";
  repo.upsert(entity({ pocketAddress: lower }));
  const b = await (await call(makeApp(null), "")).json();
  expect(b.address).toBe(getAddress(lower));
  expect(b.address).not.toBe(lower);
});

test("a decimal uint above 2^256-1 is a validation error, not a 503 from the RPC path", async () => {
  repo.upsert(entity());
  verifyGuardian();
  const reg = registrar();
  const app = makeApp(reg);
  const { sessionId } = await (await call(app, "/session", {})).json();
  const res = await call(app, "/register", proofBody(sessionId, { root: "9".repeat(78) }));
  expect(res.status).toBe(400);
  expect(reg.simulateRegister).not.toHaveBeenCalled();
});
