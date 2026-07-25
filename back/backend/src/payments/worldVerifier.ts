import { randomBytes } from "node:crypto";
import {
  createAgentBookVerifier,
  declareAgentkitExtension,
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
} from "@worldcoin/agentkit";
import type { WorldStore } from "../persistence/worldStore";

/**
 * Seller-side "is this agent backed by a real, unique human?" check.
 *
 * FRAMING (matters for how this is presented): this is an AUTHORIZATION / execution-rights
 * control inside the legal-body governance flow — a seller decides *whether an agent may act*
 * and *how much it may do before settlement is required*. It is NOT a discount, perk, or
 * loyalty benefit for verified humans.
 *
 * Chain separation: the AgentBook lookup always resolves on World Chain (SDK guarantee), while
 * the paid route and settlement stay on Arc. The two never mix.
 */

const CACHE_TTL_MS = 60 * 60_000; // 1h — positive lookups only

export interface AgentkitSellerConfig {
  /** Hostname ONLY (no port): validateAgentkitMessage compares against URL.hostname. */
  domain: string;
  /** Full public resource URL (through the proxy) — must match what the client signed. */
  resourceUrl: string;
  /** CAIP-2 of the paid route's chain (Arc), advertised in supportedChains. */
  network: string;
  store: WorldStore;
  /** Per-human authorization allowance for this resource before settlement is required. */
  allowancePerHuman: number;
  /** World Chain RPC for the AgentBook read (optional; SDK default is the public endpoint). */
  worldChainRpc?: string;
  /** AgentBook address (optional; SDK default is the canonical World Chain deployment). */
  agentBookAddress?: string;
  /** RPC overrides for signature verification, keyed by CAIP-2 (e.g. Arc). */
  rpcUrls?: Record<string, string>;
  /** Test seam: inject a verifier instead of hitting World Chain. */
  agentBook?: { lookupHuman(address: string): Promise<string | null> };
  /** Window for the per-human counter; absent -> lifetime (legacy). */
  rateWindowMs?: number;
  now?: () => number;
}

/** The `extensions.agentkit` block for our 402 body. The SDK does NOT fill nonce/issuedAt/
 *  expirationTime (the hooks pipeline normally would), so we hand-mint them per response —
 *  without them the client's isAgentkitExtension check rejects the challenge. */
export function mintAgentkitExtension(cfg: {
  domain: string;
  resourceUrl: string;
  network: string;
  allowancePerHuman: number;
}) {
  const ext = declareAgentkitExtension({
    domain: cfg.domain,
    resourceUri: cfg.resourceUrl,
    network: cfg.network,
    statement:
      "Prove this agent is backed by a verified unique human to be authorized on this resource",
  }) as unknown as { agentkit: { info: Record<string, unknown> } };
  const info = ext.agentkit.info;
  // MUST be alphanumeric: the client builds an EIP-4361 SIWE message from these fields, and SIWE
  // rejects non-alphanumeric nonces ("Nonce size smaller then 8 characters or is not alphanumeric").
  // randomUUID() looks like the obvious choice but its hyphens make createHeader throw a SiweError,
  // which the client swallows as `agentkit_skipped` — i.e. a silent, un-authorized fallthrough.
  info.nonce = randomBytes(16).toString("hex");
  info.issuedAt = new Date().toISOString();
  info.expirationTime = new Date(Date.now() + 5 * 60_000).toISOString();
  return ext;
}

export type AgentkitOutcome =
  | { authorized: true; humanId: string; agentAddress: string; used: number; limit: number }
  | { authorized: false; reason: string; humanId?: string; used?: number; limit?: number };

/**
 * Verify an inbound `agentkit` header and decide authorization.
 *
 * FAIL-CLOSED: any parse/validation/signature/RPC problem returns `authorized: false`, which
 * makes the caller fall through to the normal 402 payment path. A World Chain outage can never
 * grant access — at worst the agent pays, which is the pre-World behavior.
 */
export async function verifyAgentkitRequest(
  header: string,
  cfg: AgentkitSellerConfig,
): Promise<AgentkitOutcome> {
  const now = cfg.now ?? Date.now;
  try {
    const payload = parseAgentkitHeader(header);

    const validation = await validateAgentkitMessage(payload, cfg.resourceUrl, {
      // Single-use nonce (SQLite) — replay of a captured header is refused.
      checkNonce: async (nonce: string) => cfg.store.consumeNonce(nonce, now()),
      // biome-ignore lint/suspicious/noExplicitAny: options typing varies across SDK versions.
    } as any);
    if (!validation.valid)
      return { authorized: false, reason: `invalid-message:${validation.error ?? "unknown"}` };

    const sig = await verifyAgentkitSignature(
      payload,
      // biome-ignore lint/suspicious/noExplicitAny: options accept string | { rpcUrls }.
      (cfg.rpcUrls ? { rpcUrls: cfg.rpcUrls } : undefined) as any,
    );
    if (!sig.valid || !sig.address)
      return { authorized: false, reason: `invalid-signature:${sig.error ?? "unknown"}` };
    const agentAddress = sig.address;

    // AgentBook lookup (World Chain), cached. The SDK swallows RPC errors into `null`, so a
    // null is ambiguous (unregistered OR outage) — either way we refuse, i.e. fail closed.
    let humanId = cfg.store.getCachedHuman(agentAddress, now(), CACHE_TTL_MS);
    if (!humanId) {
      const verifier =
        cfg.agentBook ??
        createAgentBookVerifier({
          ...(cfg.worldChainRpc ? { rpcUrl: cfg.worldChainRpc } : {}),
          ...(cfg.agentBookAddress ? { contractAddress: cfg.agentBookAddress } : {}),
          // biome-ignore lint/suspicious/noExplicitAny: options typing varies across SDK versions.
        } as any);
      const looked = await verifier.lookupHuman(agentAddress);
      if (!looked || /^0x0*$/.test(looked) || looked === "0")
        return { authorized: false, reason: "not-human-backed", humanId: undefined };
      humanId = looked;
      cfg.store.cacheHuman(agentAddress, humanId, now()); // positive results only
    }

    const { allowed, used } = cfg.store.tryIncrementUsage(
      humanId,
      cfg.resourceUrl,
      cfg.allowancePerHuman,
      now(),
      cfg.rateWindowMs,
    );
    if (!allowed)
      return {
        authorized: false,
        reason: "allowance-exhausted",
        humanId,
        used,
        limit: cfg.allowancePerHuman,
      };

    return { authorized: true, humanId, agentAddress, used, limit: cfg.allowancePerHuman };
  } catch (e) {
    return { authorized: false, reason: `error:${(e as Error).message}` };
  }
}
