import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Address } from "viem";
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
import { reconcileRow } from "../../workflow/agentBookReconcile";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

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

export interface AgentBookDeps {
  registrar: AgentBookRegistrar;
  repo: AgentBookRepository;
  reader: AgentBookReader;
  store: WorldStore;
  network: "testnet" | "mainnet";
  caps: { perEntityLifetime: number; perTenantPerHour: number };
  budget: TokenBucket;
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

/**
 * Is the human the contract holds the one we submitted?
 *
 * NUMERICALLY, never as strings — the same comparison `agentBookReconcile.sameHuman` makes, and
 * for the same reason: the submit route stores the nullifier exactly as World handed it over
 * (zero-padded, `0x0badf00d`) while `lookupHuman` answers with viem's MINIMAL hex for the same
 * number (`0xbadf00d`). A string compare would report every correctly-confirmed registration as
 * disputed. A stored value that is not a parseable number cannot be matched to anything on chain,
 * so it is not ours.
 */
function sameHuman(human: string, nullifier: string): boolean {
  try {
    return BigInt(human) === BigInt(nullifier);
  } catch {
    return false;
  }
}

export function mountAgentBookRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  const ab = deps.agentBook;
  const world = deps.worldId;
  if (!ab || !world) return;
  const now = ab.now ?? Date.now;
  const auth = requireAuth(deps.jwtSecret);
  const limit = bodyLimit({ maxSize: 8 * 1024 });

  const ownedEntity = (id: string, tenantId: string): EntityRecord => {
    const rec = deps.repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== tenantId)
      throw new ApiError("not_found", 404, "entity not found");
    return rec;
  };
  const requireOrb = (tenantId: string) => {
    const v = world.store.findByTenant(tenantId, world.cfg.action);
    if (!v || !v.credential || !ORB_CREDENTIALS.has(v.credential))
      throw new ApiError("not_eligible", 403, NOT_ELIGIBLE_MESSAGE, {
        credential: v?.credential ?? null,
      });
    return v;
  };
  /** The two stored facts the vouch needs: the address AgentBook will bind (never derived at read
   *  time) and the on-chain id the dialog names. Both exist from `bound` onward. */
  const requireReady = (rec: EntityRecord): { pocket: Address; agentId: string } => {
    if (!rec.pocketAddress)
      throw new ApiError("not_ready", 409, "no-pocket-yet", { reason: "no-pocket-yet" });
    if (!READY_STATUSES.has(rec.status))
      throw new ApiError("not_ready", 409, `entity is ${rec.status}`);
    if (!rec.agentId) throw new ApiError("not_ready", 409, "entity has no on-chain agent id yet");
    return { pocket: rec.pocketAddress as Address, agentId: rec.agentId };
  };
  const takeBudget = () => {
    if (!ab.budget.take())
      throw new ApiError("unavailable", 503, "AgentBook is busy; try again in a minute");
  };
  const tenantPrefix = (t: string) => t.slice(0, 10);

  app.post("/entities/:id/agentbook/session", auth, limit, async (c) => {
    const tenantId = c.get("tenantId");
    const rec = ownedEntity(c.req.param("id"), tenantId);
    requireOrb(tenantId);
    const { pocket, agentId } = requireReady(rec);
    if (ab.repo.countLifetime(rec.idempotencyKey) >= ab.caps.perEntityLifetime)
      throw new ApiError(
        "limit_exceeded",
        429,
        "this agent has reached its AgentBook registration limit",
      );
    if (ab.repo.countSessionsSince(tenantId, now() - 3_600_000) >= ab.caps.perTenantPerHour)
      throw new ApiError("limit_exceeded", 429, "too many vouch attempts this hour");
    takeBudget();
    let nonce: bigint;
    try {
      nonce = await ab.registrar.getNextNonce(pocket);
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
    const tenantId = c.get("tenantId");
    const rec = ownedEntity(c.req.param("id"), tenantId);
    requireOrb(tenantId);
    const { pocket } = requireReady(rec);
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
    takeBudget();
    let chainNonce: bigint;
    try {
      chainNonce = await ab.registrar.getNextNonce(pocket);
    } catch {
      throw new ApiError("unavailable", 503, "could not read AgentBook");
    }
    if (chainNonce !== BigInt(row.nonce))
      throw new ApiError("conflict", 409, "the registry moved; start again");
    const args = {
      agent: pocket,
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
      await ab.registrar.simulateRegister(args);
    } catch (e) {
      return refuse(e, "simulate");
    }
    // Every read on this path is a World Chain call that can simply fail, this one included — an
    // unguarded await here would turn one RPC hiccup into a 500 instead of the 503 that tells the
    // caller to try again.
    let balance: bigint;
    try {
      balance = await ab.registrar.submitterBalance();
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
      signed = await ab.registrar.signRegister(args);
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
      txHash = await ab.registrar.broadcast(signed.rawTx);
      ab.repo.setTxHash(row.sessionId, txHash);
    } catch (e) {
      // Persisted before broadcast: the reconciler re-broadcasts the same raw tx (§6 rule 4), so
      // "submitted with no hash yet" is the honest answer and NOT a failure the caller must retry.
      opsLog("agentbook_broadcast_unavailable", {
        entity: rec.idempotencyKey,
        tenantPrefix: tenantPrefix(tenantId),
        errorName: e instanceof Error ? e.name : "unknown",
      });
    }
    opsLog("agentbook_submitted", {
      entity: rec.idempotencyKey,
      tenantPrefix: tenantPrefix(tenantId),
      txHash,
    });
    return c.json({ status: "submitted" as const, txHash });
  });

  app.get("/entities/:id/agentbook", auth, async (c) => {
    const tenantId = c.get("tenantId");
    const rec = ownedEntity(c.req.param("id"), tenantId);
    if (!rec.pocketAddress)
      return c.json({
        registered: false,
        reason: "no-pocket-yet",
        outcome: "unregistered",
        disputed: false,
      });
    const address = rec.pocketAddress;
    // The budget covers this route too, and is consumed BEFORE any read: reconcile-on-read and
    // the lookup both hit World Chain. Out of budget answers `unknown` ("could not check") rather
    // than spending quota the trust dials need — never `unregistered`.
    const budgeted = ab.budget.take();
    let row = ab.repo.latestForEntity(rec.idempotencyKey);
    if (budgeted && row && (row.status === "pending" || row.status === "submitted"))
      row = await reconcileRow(row, {
        repo: ab.repo,
        registrar: ab.registrar,
        store: ab.store,
        now,
        log: opsLog,
      });
    let humanId: string | null | undefined;
    if (budgeted) {
      try {
        humanId = await ab.reader.lookupHuman(address);
      } catch {
        // A transport failure is "could not tell", which is its own outcome and never a refusal.
        humanId = undefined;
      }
    }
    const foreign =
      humanId != null &&
      row?.status === "confirmed" &&
      row.nullifier != null &&
      !sameHuman(humanId, row.nullifier);
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
