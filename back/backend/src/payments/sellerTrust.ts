import type { WorldStore } from "../persistence/worldStore";
import type { AgentBookReader } from "./agentBookReader";

/**
 * Buyer-side seller trust: before OUR agent pays a seller, is that seller's address vouched for
 * by a verified unique human in AgentBook?
 *
 * This is the buyer half of the trust-policy dials (docs/design/2026-07-30-trust-policy-dials.md):
 * the seller half refuses anonymous BUYERS; this refuses unverified SELLERS — which is where the
 * buyer's money is actually at risk (we pay first and hope for delivery). `open` (the default)
 * changes nothing; `verified-sellers-only` is the mainnet-vision behavior, opt-in until the
 * x402 ecosystem is dense enough that strict buying doesn't just mean empty shops.
 *
 * Three outcomes, deliberately not two — same 3-state discipline as `agentBookReader`:
 *   - "verified"     the contract answered with a human id           (cached, 1 h)
 *   - "unregistered" the contract answered "nobody vouches"          (cached, 1 min)
 *   - "unavailable"  the lookup itself failed                        (NEVER cached)
 * Caching an outage as a refusal would blacklist a legitimately registered seller for the whole
 * negative TTL — the exact bug class PR #63 removed from the seller side.
 */
export type SellerTrustPolicy = "open" | "verified-sellers-only";
export type SellerTrustOutcome = "verified" | "unregistered" | "unavailable";

export interface SellerTrust {
  policy: SellerTrustPolicy;
  verify(payee: string): Promise<SellerTrustOutcome>;
}

/** Same TTL semantics as the seller-side gate (worldVerifier.ts): registrations are stable
 *  (1 h), "not registered" is a state a seller actively leaves (1 min). */
const POSITIVE_TTL_MS = 60 * 60_000;
const NEGATIVE_TTL_MS = 60_000;

export function buildSellerTrust(opts: {
  policy: SellerTrustPolicy;
  store: WorldStore;
  reader: AgentBookReader;
  now?: () => number;
}): SellerTrust {
  const now = opts.now ?? Date.now;
  return {
    policy: opts.policy,
    async verify(payee: string): Promise<SellerTrustOutcome> {
      const cached = opts.store.getCachedLookup(payee, now(), POSITIVE_TTL_MS, NEGATIVE_TTL_MS);
      if (cached) return cached.humanId === null ? "unregistered" : "verified";
      let humanId: string | null;
      try {
        humanId = await opts.reader.lookupHuman(payee);
      } catch {
        return "unavailable"; // we don't know — refuse (caller decides), but never remember a guess
      }
      opts.store.cacheLookup(payee, humanId, now()); // definitive either way
      return humanId === null ? "unregistered" : "verified";
    },
  };
}
