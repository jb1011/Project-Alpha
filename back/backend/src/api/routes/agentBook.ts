import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type Address, getAddress } from "viem";
import { z } from "zod";
import { ContractRevertError } from "../../adapters/arc/relay";
import {
  AGENTBOOK_ACTION,
  AGENTBOOK_APP_ID,
  type AgentBookRegistrar,
  buildSignal,
} from "../../adapters/worldid/agentBookRegistrar";
import { type AuthVars, requireAuth } from "../../auth/middleware";
import { opsLog } from "../../observability/opsLog";
import type { AgentBookReader } from "../../payments/agentBookReader";
import type { AgentBookRepository } from "../../persistence/agentBookRepository";
import type { WorldStore } from "../../persistence/worldStore";
import type { EntityRecord } from "../../types";
import { reconcileRow, sameHuman } from "../../workflow/agentBookReconcile";
import type { ApiDeps } from "../app";
import { ApiError, requireOwnedEntity } from "../errors";

/** Process-wide budget on World Chain calls made by these routes (design v3 §4.7, D13).
 *
 *  Process-wide and not per-tenant on purpose: the drain being braked is the SHARED
 *  `WORLD_CHAIN_RPC` quota, which the buyer and seller trust dials read through too — a throttled
 *  reader makes those dials refuse (`sellerTrust.ts`), so vouching must never be able to spend the
 *  quota that commerce depends on. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((now - this.last) / 1000) * this.refillPerSecond,
    );
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * The read side is always present; the WRITE side is the optional half.
 *
 * A deployment reads AgentBook with nothing but an RPC URL — the seller and buyer trust dials
 * already do — while WRITING one needs a funded submitter key and the World portal block. Making
 * `registrar`/`budget` optional is what keeps a credential-less box able to answer "is this agent
 * human-backed?" instead of 404-ing the question because it cannot register anyone.
 */
export interface AgentBookDeps {
  repo: AgentBookRepository;
  reader: AgentBookReader;
  store: WorldStore;
  network: "testnet" | "mainnet";
  caps: { perEntityLifetime: number; perTenantPerHour: number };
  /** Budget for the STATUS route's World Chain reads. Separate from `budget` on purpose: a burst
   *  of dashboard opens must not be able to spend the allowance a guardian's vouch needs, and a
   *  registration storm must not blind the status chip. */
  readBudget: TokenBucket;
  /** Present iff this deployment can WRITE (canRegisterAgentBook). */
  registrar?: AgentBookRegistrar;
  /** Budget for the two WRITE routes' World Chain calls. Travels with `registrar`. */
  budget?: TokenBucket;
  /** Injectable clock (ms) for tests; defaults to Date.now. */
  now?: () => number;
}

/** World's own naming for an Orb proof has both spellings in the wild; a passport or a waiver is
 *  neither, and AgentBook accepts neither (design v3 §5.1). */
const ORB_CREDENTIALS = new Set(["orb", "proof_of_human"]);
const SESSION_TTL_MS = 5 * 60_000;
/** The agent must already own an on-chain identity and a pocket before anything can vouch for it:
 *  `bound` is the first status at which both are true. */
const READY_STATUSES = new Set<EntityRecord["status"]>(["bound", "funded"]);
/** Cache TTLs for the status read. The positive one matches what the route this replaced used
 *  (`getCachedHuman(address, …, 10 * 60_000)`); the negative one is far shorter because an
 *  unregistered agent is something a guardian actively fixes and should be picked up promptly. */
const LOOKUP_POSITIVE_TTL_MS = 10 * 60_000;
const LOOKUP_NEGATIVE_TTL_MS = 60_000;
const NOT_ELIGIBLE_MESSAGE =
  "AgentBook vouching needs a World ID from an Orb. Your access here is unaffected. AgentBook is World's public registry and only accepts Orb-verified proofs. There is nothing we can substitute for that, and we will not fake it.";

const uint = z.string().regex(/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/);
const RegisterBody = z.object({
  sessionId: z.string().uuid(),
  root: uint,
  nonce: uint,
  nullifierHash: uint,
  proof: z.array(uint).length(8),
});

export function mountAgentBookRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  const ab = deps.agentBook;
  if (!ab) return;
  const now = ab.now ?? Date.now;
  const auth = requireAuth(deps.jwtSecret);
  const limit = bodyLimit({ maxSize: 8 * 1024 });

  /**
   * The write half, or a 503 — checked before any cap, any repository count and any RPC.
   *
   * `registrar`, `budget` and the World portal block travel together (`canRegisterAgentBook`
   * requires `cfg.world`), so ONE guard narrows all three and no write path below has to ask
   * again whether this deployment can write.
   */
  const writeSide = () => {
    const registrar = ab.registrar;
    const budget = ab.budget;
    const world = deps.worldId;
    if (!registrar || !budget || !world)
      throw new ApiError(
        "unavailable",
        503,
        "AgentBook registration is not configured on this deployment",
      );
    return { registrar, budget, world };
  };
  const requireOrb = (world: NonNullable<ApiDeps["worldId"]>, tenantId: string): void => {
    const v = world.store.findByTenant(tenantId, world.cfg.action);
    if (!v || !v.credential || !ORB_CREDENTIALS.has(v.credential))
      throw new ApiError("not_eligible", 403, NOT_ELIGIBLE_MESSAGE, {
        credential: v?.credential ?? null,
      });
  };
  /** The two stored facts the vouch needs: the address AgentBook will bind (never derived at read
   *  time) and the on-chain id the dialog names. Both exist from `bound` onward. */
  const requireReady = (rec: EntityRecord): { pocket: Address; agentId: string } => {
    if (!rec.pocketAddress)
      throw new ApiError("not_ready", 409, "this agent has no payment address yet", {
        reason: "no-pocket-yet",
      });
    if (!READY_STATUSES.has(rec.status))
      throw new ApiError("not_ready", 409, "this agent is not on chain yet", {
        reason: `entity-is-${rec.status}`,
      });
    if (!rec.agentId)
      throw new ApiError("not_ready", 409, "this agent has no on-chain id yet", {
        reason: "no-agent-id-yet",
      });
    return { pocket: getAddress(rec.pocketAddress), agentId: rec.agentId };
  };
  const tenantPrefix = (t: string) => t.slice(0, 10);

  app.post("/entities/:id/agentbook/session", auth, limit, async (c) => {
    const { registrar, budget, world } = writeSide();
    const tenantId = c.get("tenantId");
    const rec = requireOwnedEntity(deps, c);
    requireOrb(world, tenantId);
    const { pocket, agentId } = requireReady(rec);
    if (ab.repo.countLifetime(rec.idempotencyKey) >= ab.caps.perEntityLifetime)
      throw new ApiError(
        "limit_exceeded",
        429,
        "this agent has reached its AgentBook registration limit",
      );
    if (ab.repo.countSessionsSince(tenantId, now() - 3_600_000) >= ab.caps.perTenantPerHour)
      throw new ApiError("limit_exceeded", 429, "too many vouch attempts this hour");
    if (!budget.take())
      throw new ApiError("unavailable", 503, "AgentBook is busy; try again in a minute");
    let nonce: bigint;
    try {
      nonce = await registrar.getNextNonce(pocket);
    } catch (e) {
      opsLog("agentbook_session_unavailable", {
        entity: rec.idempotencyKey,
        tenantPrefix: tenantPrefix(tenantId),
        errorName: e instanceof Error ? e.name : "unknown",
      });
      throw new ApiError("unavailable", 503, "could not read AgentBook");
    }
    const sessionId = randomUUID();
    const row = ab.repo.createSession({
      sessionId,
      entityKey: rec.idempotencyKey,
      tenantId,
      address: pocket,
      nonce: nonce.toString(),
      expiresAt: now() + SESSION_TTL_MS,
    });
    // Per TENANT, not per human: the guardian's World ID pseudonym for OUR action differs from
    // their AgentBook pseudonym, so this is the only count we can honestly claim.
    const priorVouches = ab.repo.countConfirmedForTenant(tenantId);
    return c.json({
      sessionId,
      appId: AGENTBOOK_APP_ID,
      action: AGENTBOOK_ACTION,
      signal: buildSignal(pocket, nonce),
      nonce: nonce.toString(),
      pocketAddress: pocket,
      agentId,
      expiresAt: row.expiresAt,
      network: ab.network,
      priorVouches,
    });
  });

  app.post("/entities/:id/agentbook/register", auth, limit, async (c) => {
    const { registrar, budget, world } = writeSide();
    const tenantId = c.get("tenantId");
    const rec = requireOwnedEntity(deps, c);
    requireOrb(world, tenantId);
    requireReady(rec);
    const body = RegisterBody.parse(await c.req.json());
    const row = ab.repo.findBySession(body.sessionId);
    if (
      !row ||
      row.tenantId !== tenantId ||
      row.entityKey !== rec.idempotencyKey ||
      row.status !== "pending"
    )
      throw new ApiError("conflict", 409, "no open session for this agent; start again");
    if (row.expiresAt < now()) {
      ab.repo.transition(row.sessionId, "pending", "expired");
      throw new ApiError("conflict", 409, "session expired; start again");
    }
    if (BigInt(body.nonce) !== BigInt(row.nonce))
      throw new ApiError("conflict", 409, "nonce mismatch; start again");
    // THE SESSION ROW'S address, never the entity's current one: the guardian proved over
    // `buildSignal(row.address, row.nonce)`, so that address is baked into the proof. Registering
    // anything else — an entity whose pocket moved mid-session, say — would burn gas on a certain
    // revert, and a proof is not replayable. Re-checksummed because the row stores it lowercased.
    const agent = getAddress(row.address);
    if (!budget.take())
      throw new ApiError("unavailable", 503, "AgentBook is busy; try again in a minute");
    let chainNonce: bigint;
    try {
      chainNonce = await registrar.getNextNonce(agent);
    } catch {
      throw new ApiError("unavailable", 503, "could not read AgentBook");
    }
    if (chainNonce !== BigInt(row.nonce))
      throw new ApiError("conflict", 409, "the registry moved; start again");
    const args = {
      agent,
      root: BigInt(body.root),
      nonce: BigInt(body.nonce),
      nullifierHash: BigInt(body.nullifierHash),
      proof: body.proof.map((p) => BigInt(p)),
    };
    /**
     * The ONE place a write-path failure is turned into an answer.
     *
     * `simulateRegister` and `signRegister` both raise `ContractRevertError` for a deterministic
     * revert — the second is where a state change since the simulation shows up, and it is every
     * bit as certain as the first, so it gets the same 400 rather than a 500. Everything else is
     * transport and says nothing about the proof.
     *
     * NOTHING but the error NAME may leave here: a viem contract error prints the call arguments,
     * the call arguments are `agent, root, nonce, nullifierHash, proof[8]`, and a failed attempt's
     * nullifier is not public (§4.7). Never `e.message`, never `e.cause`, never `String(e)`.
     */
    const refuse = (e: unknown, stage: "simulate" | "balance" | "sign"): never => {
      if (e instanceof ContractRevertError) {
        const errorName = e.errorName ?? "revert";
        ab.repo.bumpAttempt(row.sessionId, errorName);
        opsLog("agentbook_proof_rejected", {
          entity: rec.idempotencyKey,
          tenantPrefix: tenantPrefix(tenantId),
          stage,
          errorName,
        });
        throw new ApiError("proof_rejected", 400, "AgentBook rejected the registration", {
          errorName,
        });
      }
      const errorName = e instanceof Error ? e.name : "unavailable";
      ab.repo.bumpAttempt(row.sessionId, errorName);
      opsLog("agentbook_write_unavailable", {
        entity: rec.idempotencyKey,
        tenantPrefix: tenantPrefix(tenantId),
        stage,
        errorName,
      });
      throw new ApiError("unavailable", 503, "could not submit the registration");
    };
    try {
      await registrar.simulateRegister(args);
    } catch (e) {
      return refuse(e, "simulate");
    }
    // Every read on this path is a World Chain call that can simply fail, this one included — an
    // unguarded await here would turn one RPC hiccup into a 500 instead of the 503 that tells the
    // caller to try again.
    let balance: bigint;
    try {
      balance = await registrar.submitterBalance();
    } catch (e) {
      return refuse(e, "balance");
    }
    if (balance === 0n) {
      opsLog("agentbook_submitter_low", {
        entity: rec.idempotencyKey,
        tenantPrefix: tenantPrefix(tenantId),
      });
      throw new ApiError("unavailable", 503, "registrations are paused");
    }
    let signed: { rawTx: `0x${string}`; submitterNonce: number };
    try {
      signed = await registrar.signRegister(args);
    } catch (e) {
      return refuse(e, "sign");
    }
    // VERBATIM, exactly the hex the guardian's proof carried: the reconciler compares it with
    // `lookupHuman` numerically, and re-encoding it here would only lose the padding World sent.
    const claim = ab.repo.claimSubmit(row.sessionId, {
      nullifier: body.nullifierHash,
      rawTx: signed.rawTx,
      submitterNonce: signed.submitterNonce,
    });
    if (claim === "inflight")
      throw new ApiError("conflict", 409, "a registration for this agent is already in flight");
    if (claim === "lost") throw new ApiError("conflict", 409, "session already used");
    let txHash: string | null = null;
    try {
      txHash = await registrar.broadcast(signed.rawTx);
    } catch (e) {
      // Persisted before broadcast: the reconciler re-broadcasts the same raw tx (§6 rule 4), so
      // "submitted with no hash yet" is the honest answer and NOT a failure the caller must retry.
      opsLog("agentbook_broadcast_unavailable", {
        entity: rec.idempotencyKey,
        tenantPrefix: tenantPrefix(tenantId),
        errorName: e instanceof Error ? e.name : "unknown",
      });
    }
    if (txHash !== null) {
      // OUTSIDE the broadcast try: a local write that fails here must not be mistaken for a
      // broadcast that failed. The transaction is on the wire either way, and the caller gets its
      // hash — only our record of it is missing, which the reconciler repairs from `raw_tx`.
      try {
        ab.repo.setTxHash(row.sessionId, txHash);
      } catch {
        opsLog("agentbook_txhash_unrecorded", {
          entity: rec.idempotencyKey,
          tenantPrefix: tenantPrefix(tenantId),
        });
      }
    }
    opsLog("agentbook_submitted", {
      entity: rec.idempotencyKey,
      tenantPrefix: tenantPrefix(tenantId),
      txHash,
    });
    return c.json({ status: "submitted" as const, txHash });
  });

  app.get("/entities/:id/agentbook", auth, async (c) => {
    const rec = requireOwnedEntity(deps, c);
    if (!rec.pocketAddress)
      return c.json({
        registered: false,
        reason: "no-pocket-yet",
        outcome: "unregistered",
        disputed: false,
      });
    const address = rec.pocketAddress;
    let row = ab.repo.latestForEntity(rec.idempotencyKey);
    // Two things can cost an RPC call here: reconciling an in-flight row, and a lookup the cache
    // cannot answer. Either one spends ONE read token, taken BEFORE the call — a dashboard full
    // of chips must never be able to drain the World Chain quota the trust dials share. Out of
    // budget the answer is `unknown` ("could not check"), never `unregistered`.
    const cacheProbe = () =>
      ab.store.getCachedLookup(address, now(), LOOKUP_POSITIVE_TTL_MS, LOOKUP_NEGATIVE_TTL_MS);
    // Reconcile needs the registrar; a read-only deployment serves the row exactly as stored.
    const registrar = ab.registrar;
    const needsReconcile =
      Boolean(registrar) && (row?.status === "pending" || row?.status === "submitted");
    const budgeted = needsReconcile || !cacheProbe() ? ab.readBudget.take() : false;
    if (registrar && needsReconcile && budgeted && row)
      row = await reconcileRow(row, {
        repo: ab.repo,
        registrar,
        store: ab.store,
        now,
        log: opsLog,
      });
    // Probed AGAIN after the reconcile: its `disputed` branch writes a fresh `cacheLookup`, and
    // reading that here saves a second round trip for the answer it just fetched.
    const cached = cacheProbe();
    let humanId: string | null | undefined;
    if (cached) humanId = cached.humanId;
    else if (budgeted) {
      try {
        humanId = await ab.reader.lookupHuman(address);
        // Only a DEFINITIVE answer is cached — `lookupHuman` throws rather than returning null on
        // an outage, so nothing below this line can cache an outage as a refusal.
        ab.store.cacheLookup(address, humanId, now());
      } catch {
        // A transport failure is "could not tell", which is its own outcome and never a refusal.
        humanId = undefined;
      }
    }
    const foreign =
      humanId != null && row?.status === "confirmed" && !sameHuman(humanId, row.nullifier);
    const disputed = row?.status === "disputed" || foreign;
    const outcome = disputed
      ? "disputed"
      : humanId === undefined
        ? "unknown"
        : humanId === null
          ? "unregistered"
          : "registered";
    return c.json({
      registered: outcome === "registered",
      ...(humanId ? { humanId } : {}),
      address,
      outcome,
      disputed,
      ...(row ? { status: row.status, txHash: row.txHash } : {}),
      // The last-attempt diagnostic is only meaningful on a failed row (agentBookRepository.ts).
      ...(row?.status === "failed" && row.errorCode ? { errorCode: row.errorCode } : {}),
    });
  });
}
