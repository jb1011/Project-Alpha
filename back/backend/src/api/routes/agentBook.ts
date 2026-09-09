import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type Address, getAddress, toHex } from "viem";
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

/** A uint256 as World sends it: 0x-hex or decimal. The hex branch is bounded by its 64-nibble cap;
 *  the decimal one is not (2^256−1 is itself 78 digits), so the range check is what stops a
 *  too-large decimal from reaching viem and coming back as a misleading 503 (§4.7 makes the schema
 *  the shape gate). */
const uint = z
  .string()
  .regex(/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/)
  .refine((s) => BigInt(s) < 2n ** 256n, { message: "value exceeds uint256" });
const RegisterBody = z.object({
  sessionId: z.string().uuid(),
  root: uint,
  nonce: uint,
  nullifierHash: uint,
  proof: z.array(uint).length(8),
});

/**
 * A stored nullifier in the spelling every OTHER writer of the lookup cache uses.
 *
 * The submit route stores the nullifier exactly as World sent it (zero-padded, `0x0badf00d`),
 * while `lookupHuman` — and therefore `sellerTrust`, `worldVerifier` and the reconciler's
 * `disputed` branch — writes viem's minimal hex for the same number (`0xbadf00d`). That cached
 * value is not just displayed: `worldVerifier` uses it as the ALLOWANCE KEY
 * (`tryIncrementUsage(humanId, …)`), so two spellings of one human would be two buckets and twice
 * the allowance. `null` when the stored value is not a number we can canonicalise, which routes
 * the caller to a fresh lookup rather than poisoning the cache with a guess.
 */
function asHumanId(nullifier: string | null): string | null {
  if (nullifier === null) return null;
  try {
    return toHex(BigInt(nullifier));
  } catch {
    return null;
  }
}

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
     * `simulateRegister` and `submitRegister` both raise `ContractRevertError` for a deterministic
     * revert — the second is where a state change since the simulation shows up (its gas estimate
     * runs against a later block), and it is every bit as certain as the first, so it gets the same
     * 400 rather than a 500. Everything else is transport and says nothing about the proof.
     *
     * NOTHING but the error NAME may leave here: a viem contract error prints the call arguments,
     * the call arguments are `agent, root, nonce, nullifierHash, proof[8]`, and a failed attempt's
     * nullifier is not public (§4.7). Never `e.message`, never `e.cause`, never `String(e)`.
     */
    const refuse = (e: unknown, stage: "simulate" | "balance" | "sign"): never => {
      if (e instanceof ContractRevertError) {
        const errorName = e.errorName ?? "revert";
        // FR-B: the contract has DECIDED, and a World proof is not replayable — this session can
        // never succeed. It ends here as `failed` carrying the diagnostic rather than sitting
        // `pending` for the rest of its TTL, where the chip would keep calling it an open session
        // and the guardian would keep waiting on a QR that is already spent. `bumpAttempt` first,
        // so the row records both the count and the last-attempt code.
        ab.repo.bumpAttempt(row.sessionId, errorName);
        ab.repo.transition(row.sessionId, "pending", "failed", { errorCode: errorName });
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
      // TRANSPORT, which says nothing about the proof: NOTHING is written (FR-B). No attempt bump
      // either — the count is a record of what the CONTRACT rejected (§4.1), and spending it on a
      // bad minute at the RPC would burn a retry the guardian still has. The row stays `pending`,
      // the proof stays usable, and the caller is told to try again.
      const errorName = e instanceof Error ? e.name : "unknown";
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
    // SIGN → PERSIST → BROADCAST, all three inside the registrar's submitter lock (FR-C, §4.1).
    // The persist step is handed in rather than run here because the EVM nonce is only unique
    // while nothing else signs or sends on the submitter account: with the claim outside the lock,
    // two guardians vouching at once prepare on the same nonce and one of the two proofs — which
    // cannot be re-created — is thrown away.
    let submitted: Awaited<ReturnType<typeof registrar.submitRegister>>;
    try {
      submitted = await registrar.submitRegister(args, (signed) =>
        // VERBATIM, exactly the hex the guardian's proof carried: the reconciler compares it with
        // `lookupHuman` numerically, and re-encoding it here would only lose the padding World
        // sent.
        ab.repo.claimSubmit(row.sessionId, {
          nullifier: body.nullifierHash,
          rawTx: signed.rawTx,
          submitterNonce: signed.submitterNonce,
        }),
      );
    } catch (e) {
      return refuse(e, "sign");
    }
    if (submitted.claim === "inflight")
      throw new ApiError("conflict", 409, "a registration for this agent is already in flight");
    if (submitted.claim === "lost") throw new ApiError("conflict", 409, "session already used");
    const txHash: string | null = submitted.txHash;
    if (submitted.broadcastErrorName)
      // The raw tx is persisted, so the reconciler re-broadcasts it (§6 rule 4): "submitted with
      // no hash yet" is the honest answer and NOT a failure the caller must retry.
      opsLog("agentbook_broadcast_unavailable", {
        entity: rec.idempotencyKey,
        tenantPrefix: tenantPrefix(tenantId),
        errorName: submitted.broadcastErrorName,
      });
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
        // NOT "unregistered": there is no address to be unregistered AT. We never asked the
        // contract anything, so the honest value is the union's "could not check" (§3.2).
        outcome: "unknown",
        disputed: false,
      });
    // EIP-55, like the session route's `pocketAddress` (:169). The dialog puts the two side by
    // side and asks the guardian to compare the address with the one that paid on Arcscan (D8), so
    // one lowercase and one checksummed spelling of the same address reads as a discrepancy that
    // is not one. Every equality downstream is case-insensitive: the lookup cache lowercases its
    // key (`worldStore.cacheLookup`) and viem accepts either.
    const address = getAddress(rec.pocketAddress);
    // The IN-FLIGHT row if there is one, not simply the newest (§5.2): a second session that
    // expired after the first was submitted must not shadow a transaction still on its way.
    let row = ab.repo.currentForEntity(rec.idempotencyKey);
    // Two things can cost an RPC call here: reconciling an in-flight row, and a lookup the cache
    // cannot answer. Either one spends ONE read token, taken BEFORE the call — a dashboard full
    // of chips must never be able to drain the World Chain quota the trust dials share. Out of
    // budget the answer is `unknown` ("could not check"), never `unregistered`.
    const cached = ab.store.getCachedLookup(
      address,
      now(),
      LOOKUP_POSITIVE_TTL_MS,
      LOOKUP_NEGATIVE_TTL_MS,
    );
    // Reconcile needs the registrar; a read-only deployment serves the row exactly as stored.
    const registrar = ab.registrar;
    const needsReconcile =
      Boolean(registrar) && (row?.status === "pending" || row?.status === "submitted");
    const budgeted = needsReconcile || !cached ? ab.readBudget.take() : false;
    let reconciled = false;
    if (registrar && needsReconcile && budgeted && row) {
      row = await reconcileRow(row, {
        repo: ab.repo,
        registrar,
        store: ab.store,
        now,
        log: opsLog,
      });
      reconciled = true;
    }
    /**
     * EVERY VOUCH THIS ENTITY EVER PUT ON THE WIRE, newest first, read AFTER the reconcile above so
     * a row it just confirmed is in the set.
     *
     * `row` alone cannot answer the two questions below (re-review R1). It is the newest row once
     * nothing is in flight, and the newest row is a nullifier-less abandoned session whenever a
     * guardian opened the dialog twice — which turned our own registry entry into a stranger's and
     * hid the confirmation the transaction link is built from.
     */
    const vouched = ab.repo.rowsWithNullifierForEntity(rec.idempotencyKey);
    /**
     * A CONFIRMED ROW OF OUR OWN OUTRANKS A CACHED NEGATIVE (FR-D).
     *
     * The reconciler now writes the cache on `confirmed` as well as `disputed`, but the confirming
     * sweep may have run in the background (or in an older process), leaving the `null` this route
     * cached on a previous poll (60s TTL) to be served beside `status: "confirmed"` — one body
     * saying both "we vouched" and "not in AgentBook". A positive cache entry is used as it stands:
     * it can disagree with our row, and that disagreement is exactly the `disputed` case below.
     *
     * The entity's newest VERDICT row when it is confirmed, not `row`'s own status: an abandoned
     * session opened after the confirmation is the newest row and carries nothing, and letting it
     * hide the confirmation would serve exactly the poisoned negative this rule exists to discard
     * (R1).
     */
    // A `disputed` row is written only when the reconciler READ a stranger's id, so a newer one
    // overrules the older confirmation; rows that answered nothing never suppress it (R1-b).
    const verdict = vouched.find((r) => r.status === "confirmed" || r.status === "disputed");
    const confirmedId = verdict?.status === "confirmed" ? asHumanId(verdict.nullifier) : null;
    const usableCache = cached && (cached.humanId !== null || confirmedId === null) ? cached : null;
    let humanId: string | null | undefined;
    /** Did OUR ROW answer, rather than the cache or a fresh read? Only then is the cache written
     *  below. */
    let rowAnswered = false;
    // A reconcile that just confirmed is strictly fresher than anything cached, and it read the
    // contract itself at `safe` to get there. The row THIS request reconciled, deliberately not
    // `confirmedId`: an older confirmation of ours says nothing about a submission still in flight,
    // and answering with it would skip the read that would notice a stranger overwriting us.
    const reconciledId =
      reconciled && row?.status === "confirmed" ? asHumanId(row.nullifier) : null;
    if (reconciledId !== null) {
      humanId = reconciledId;
      rowAnswered = true;
    } else if (!reconciled && usableCache) humanId = usableCache.humanId;
    else if (budgeted) {
      // Reconciled to something other than `confirmed`, or nothing usable cached: ask the
      // contract. When a reconcile ran, the read token was already spent on it and this costs no
      // further budget.
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
    // A read we could not make must not turn a vouch we confirmed into "could not tell". A FRESH
    // definitive `null` is left alone: the contract is the authority on its own state.
    if (humanId === undefined && confirmedId !== null) {
      humanId = confirmedId;
      rowAnswered = true;
    }
    // Refresh the cache when OUR ROW is what answered, in the minimal-hex spelling every other
    // writer uses — `worldVerifier` keys its per-human allowance off this value, so two spellings
    // of one human would be two buckets and twice the allowance. Not when the CACHE answered
    // (re-review R2): re-stamping a positive on every dashboard poll would hold it past its TTL for
    // as long as anyone is looking, and the contract read that TTL exists to force — the one that
    // would notice a stranger overwriting us — would never happen.
    if (rowAnswered && humanId != null) ab.store.cacheLookup(address, humanId, now());
    /**
     * IS THIS VOUCH OURS? (§3 precondition 5, FR-A, re-review R1)
     *
     * Not "is this address registered": a non-null lookup we did not write means SOMEONE ELSE
     * vouched, which is `disputed` — the state that keeps the vouch button open — and never a
     * finished "registered" that would lock the guardian out of overwriting a stranger's binding
     * (§8 HIGH-2). `ours` deliberately does not require a `confirmed` row: a `failed` or `expired`
     * row whose nullifier the registry now holds IS our vouch, mined after we gave up on it, and
     * the registry outranks our record of it.
     *
     * Asked of EVERY row of ours that carries a nullifier, never of the current one alone (R1): a
     * nullifier-less session from a second tab matches nothing, and asking it turned our own entry
     * into "someone else has replaced the vouch" for good — re-opening the button over an entry
     * that is already ours, for a second on-chain write that would spend gas and one of the three
     * lifetime slots. Numerically, via `sameHuman`, like every other comparison of these two
     * spellings.
     */
    const registryId = humanId ?? null;
    const ours = vouched.some((r) => sameHuman(registryId, r.nullifier));
    const foreign = humanId != null && !ours;
    /**
     * WHICH ROW THE BODY DESCRIBES.
     *
     * 1. The in-flight one if there is one — `currentForEntity` puts it first for §5.2's reason: no
     *    terminal answer over a transaction still on its way.
     * 2. Otherwise, when the vouch is ours, the CONFIRMED row whose nullifier the registry holds.
     *    The chip builds the link to the guardian's own transaction out of
     *    `status === "confirmed" && txHash`, so an abandoned session standing in its place costs
     *    them that link and shows a session's status as the agent's registry status.
     * 3. Otherwise the newest row, which is what everything above reconciled and read.
     */
    const inFlight = row?.status === "submitted" ? row : undefined;
    const confirmedOurs = ours
      ? vouched.find((r) => r.status === "confirmed" && sameHuman(registryId, r.nullifier))
      : undefined;
    const shown = inFlight ?? confirmedOurs ?? row;
    // `shown`, not the newest row: a `disputed` row records the id the registry held when the
    // reconciler looked. If the registry holds a nullifier of ours again — a re-vouch that landed
    // after that verdict — `shown` is the confirmed row it belongs to and the honest answer is
    // "registered": the entry moved BACK to us. Reading the newest row here would keep the stale
    // verdict on screen for good, which is the same shape of permanent falsehood as R1.
    const disputed = shown?.status === "disputed" || foreign;
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
      ...(shown ? { status: shown.status, txHash: shown.txHash } : {}),
      // The last-attempt diagnostic is only meaningful on a failed row (agentBookRepository.ts).
      ...(shown?.status === "failed" && shown.errorCode ? { errorCode: shown.errorCode } : {}),
      // The same two values the session route returns, so the dialog can render §5.1's conditional
      // lines (the testnet-permanence sentence, the "you have vouched for N agents" line) from the
      // status it already polls, without opening a session first (FR-F).
      network: ab.network,
      priorVouches: ab.repo.countConfirmedForTenant(c.get("tenantId")),
    });
  });
}
