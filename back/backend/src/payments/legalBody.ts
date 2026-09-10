import type { Address, EntityRecord, EntityStatus } from "../types";

/**
 * "Is this address the payment address of a Novi legal body in good standing?"
 *
 * ONE definition of standing for every surface (design 2026-09-10 D1): the buyer-side dial
 * (`payments/sellerTrust.ts`), the public lookup and the `legal-bodies-only` seller policy all
 * resolve through this module, so a suspension can never mean one thing to a seller we pay and
 * another to a seller who checks us.
 *
 * Two keys (D2), because the two callers hold different halves of the same entity: an AgentKit
 * proof carries the agent's PAYER address (the pocket, which is what AgentBook registers), the
 * buyer dial carries the seller's TREASURY. Both name the same legal body.
 *
 * Failure discipline (D8): a definitive on-chain answer is `active`/`inactive`; a read that threw
 * is `unknown` — never a guess, and NOTHING here is cached in either direction. A guardian
 * suspension has to bite on the very next question, and an RPC blip must never be able to brand a
 * live body inactive. Callers that need to survive a page refresh do their own bounded memo of
 * DEFINITIVE answers only (the lookup route, D3); this module remembers nothing at all.
 */

export type LegalBodyStanding =
  | "active" // legalStatus === 0 AND the treasury is not paused — read fresh, just now
  | "inactive" // a definitive negative: suspended, or the treasury is paused
  | "unknown"; // a read failed — we do not know, and we will not pretend

export type LegalBodyResolution =
  | { kind: "none" }
  | {
      kind: "body";
      entity: EntityRecord;
      standing: LegalBodyStanding;
      /** Which index matched — the payer address or the treasury. Surfaced so a caller can say
       *  what it actually verified about the address it was handed. */
      matchedBy: "pocket" | "treasury";
    };

/** The two Arc reads standing is made of. Same signatures as `ArcAdapter`'s. */
export interface LegalBodyChainReads {
  legalStatus(proxy: Address): Promise<number>;
  treasuryPaused(treasury: Address): Promise<boolean>;
}

export interface LegalBodyDeps extends LegalBodyChainReads {
  /** Local DB: the entity whose PAYER (pocket) address is this address, if any. */
  findByPocketAddress(a: string): EntityRecord | undefined;
  /** Local DB: the entity whose TREASURY is this address, if any. */
  findByTreasury(a: string): EntityRecord | undefined;
}

export interface LegalBodyResolver {
  resolve(address: string): Promise<LegalBodyResolution>;
}

/**
 * The statuses that make an entity PUBLIC ON CHAIN — the same set `listPublicOnChain` serves to
 * `/transparency` (entityRepository.ts). An entity below `created` has no proxy and no treasury to
 * read, and `failed` is deliberately excluded: an entity we do not list publicly is not one we
 * will vouch for either.
 */
const PUBLIC_ON_CHAIN_STATUSES: ReadonlySet<EntityStatus> = new Set<EntityStatus>([
  "created",
  "bound",
  "funded",
]);

/** A record only counts as a legal body once the chain can actually be asked about it. */
export function isPublicOnChain(e: EntityRecord): boolean {
  return Boolean(e.proxy) && Boolean(e.treasury) && PUBLIC_ON_CHAIN_STATUSES.has(e.status);
}

/**
 * The single comparison form. Addresses reach us in whatever spelling the caller has — EIP-55
 * from a wallet, lowercase from a URL — and the stored spelling varies by custody provider too
 * (viem checksums what it derives, Circle does not), so nothing anywhere may compare raw strings.
 */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The rule itself, in one place: both reads in parallel, `active` only when the chain says so.
 * Exported because `sellerTrust.ts` reaches it through its own narrower dependency shape.
 */
export async function readStanding(
  reads: LegalBodyChainReads,
  proxy: Address,
  treasury: Address,
): Promise<LegalBodyStanding> {
  try {
    const [status, paused] = await Promise.all([
      reads.legalStatus(proxy),
      reads.treasuryPaused(treasury),
    ]);
    return status === 0 && !paused ? "active" : "inactive";
  } catch {
    return "unknown";
  }
}

export function createLegalBodyResolver(deps: LegalBodyDeps): LegalBodyResolver {
  return {
    async resolve(address: string): Promise<LegalBodyResolution> {
      const key = normalizeAddress(address);
      if (!key) return { kind: "none" };
      // Payer first (D2): it is the address an AgentKit proof carries, so it is the hot key. A
      // pocket hit never touches the treasury index — one address is never both.
      const byPocket = deps.findByPocketAddress(key);
      const entity = byPocket ?? deps.findByTreasury(key);
      if (!entity || !isPublicOnChain(entity)) return { kind: "none" };
      const standing = await readStanding(
        deps,
        entity.proxy as Address,
        entity.treasury as Address,
      );
      return { kind: "body", entity, standing, matchedBy: byPocket ? "pocket" : "treasury" };
    },
  };
}
