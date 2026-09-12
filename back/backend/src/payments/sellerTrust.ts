import type { WorldStore } from "../persistence/worldStore";
import type { Address } from "../types";
import type { AgentBookReader } from "./agentBookReader";
import type { LegalBodyResolver, LegalBodyStanding } from "./legalBody";
import { readStanding } from "./legalBody";

/**
 * Buyer-side seller trust: before OUR agent pays a seller, is that seller someone we trust?
 *
 * Two trust roots, deliberately NOT a ladder (docs/design/2026-08-01-v25-batch1.md):
 *   - `verified-sellers-only`      — World's AgentBook: "a verified unique human vouches for
 *                                    this address". Cached (1 h positive / 1 min negative).
 *   - `verified-legal-bodies-only` — the Novi registry + Arc on-chain status: "this address is
 *                                    the treasury of a registered legal body in good standing".
 *                                    NEVER cached: a suspension must take effect immediately.
 * `open` skips the check entirely. The EFFECTIVE policy is resolved per entity by the caller
 * (`entity.trustPolicy ?? globalPolicy`) — the guardian's per-agent dial beats the platform
 * default in both directions.
 *
 * Failure discipline (same as #63/#65): a definitive answer may be acted on and (for AgentBook)
 * cached; a failed lookup is "unavailable" — refused fail-closed but NEVER remembered, so an RPC
 * outage cannot blacklist a legitimate seller.
 */
export type SellerTrustPolicy = "open" | "verified-sellers-only" | "verified-legal-bodies-only";

export type SellerTrustOutcome =
  | "verified"
  | "not-human-backed" // AgentBook answered: nobody vouches
  | "not-legal-body" // no Novi entity has this treasury address
  | "legal-body-inactive" // entity exists but suspended or treasury paused
  | "unavailable"; // could not verify — refuse, never cache

export interface SellerTrust {
  /** Platform default (X402_BUYER_TRUST_POLICY); overridden per entity by `entity.trustPolicy`. */
  globalPolicy: SellerTrustPolicy;
  verify(payee: string, policy: Exclude<SellerTrustPolicy, "open">): Promise<SellerTrustOutcome>;
}

/** Same TTL semantics as the seller-side gate (worldVerifier.ts): registrations are stable
 *  (1 h), "not registered" is a state a seller actively leaves (1 min). */
const POSITIVE_TTL_MS = 60 * 60_000;
const NEGATIVE_TTL_MS = 60_000;

/** The narrow slice of the entity repo + Arc reads the legal-bodies tier needs. Kept for callers
 *  that wire the two Arc reads themselves; a composition root should hand over `legalBody` (the
 *  shared resolver) instead, so every surface asks the same object the same question. */
export interface LegalBodyLookup {
  /** Local DB: the entity whose TREASURY is this address (case-insensitive), if any. */
  findByTreasury(addr: string): { proxy: string | null; treasury: string | null } | undefined;
  legalStatus(proxy: Address): Promise<number>;
  treasuryPaused(treasury: Address): Promise<boolean>;
}

/** standing -> this dial's vocabulary. The mapping is the whole refactor (design 2026-09-10 D1):
 *  "in good standing" is defined once, in payments/legalBody.ts, and named differently here. */
const STANDING_OUTCOME: Record<LegalBodyStanding, SellerTrustOutcome> = {
  active: "verified",
  inactive: "legal-body-inactive",
  unknown: "unavailable",
};

export function buildSellerTrust(opts: {
  globalPolicy: SellerTrustPolicy;
  store: WorldStore;
  reader: AgentBookReader;
  /** The shared resolver (payments/legalBody.ts) — preferred: the same instance answers the
   *  public lookup and the seller policy, so one suspension means one thing everywhere. It also
   *  matches on the PAYER address, which a seller's treasury may double as. */
  legalBody?: LegalBodyResolver;
  /** Legacy narrow wiring, treasury-keyed only. Used when no resolver is supplied; absent too ->
   *  the legal-bodies tier fails closed as "unavailable". */
  legalBodies?: LegalBodyLookup;
  now?: () => number;
}): SellerTrust {
  const now = opts.now ?? Date.now;

  async function verifyHumanBacked(payee: string): Promise<SellerTrustOutcome> {
    const cached = opts.store.getCachedLookup(payee, now(), POSITIVE_TTL_MS, NEGATIVE_TTL_MS);
    if (cached) return cached.humanId === null ? "not-human-backed" : "verified";
    let humanId: string | null;
    try {
      humanId = await opts.reader.lookupHuman(payee);
    } catch {
      return "unavailable"; // we don't know — refuse, but never remember a guess
    }
    opts.store.cacheLookup(payee, humanId, now()); // definitive either way
    return humanId === null ? "not-human-backed" : "verified";
  }

  async function verifyLegalBody(payee: string): Promise<SellerTrustOutcome> {
    // Per-payment fresh reads, NO caching in either direction (design 2026-09-10 D8, unchanged
    // from #65): a guardian suspension must bite on the very next payment, and an RPC blip must
    // not brand a body inactive. Neither path below remembers anything.
    if (opts.legalBody) {
      const r = await opts.legalBody.resolve(payee);
      return r.kind === "none" ? "not-legal-body" : STANDING_OUTCOME[r.standing];
    }
    const lb = opts.legalBodies;
    if (!lb) return "unavailable"; // tier requested but not wired — fail closed
    const rec = lb.findByTreasury(payee);
    if (!rec || !rec.proxy || !rec.treasury) return "not-legal-body";
    return STANDING_OUTCOME[await readStanding(lb, rec.proxy as Address, rec.treasury as Address)];
  }

  return {
    globalPolicy: opts.globalPolicy,
    verify(payee, policy) {
      return policy === "verified-legal-bodies-only"
        ? verifyLegalBody(payee)
        : verifyHumanBacked(payee);
    },
  };
}
