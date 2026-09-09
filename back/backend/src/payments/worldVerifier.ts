import { randomBytes } from "node:crypto";
import type { WorldStore } from "../persistence/worldStore";
import type { Address } from "../types";
import { AGENT_BOOK_ADDRESS, AGENT_BOOK_CAIP2, createAgentBookReader } from "./agentBookReader";

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

/** Lazily load @worldcoin/agentkit so its import cost is paid on the FIRST World-layer request,
 *  not at boot by every deployment. Measured on the api import chain under tsx: 209.1 -> 201.2 MB
 *  RSS (~8 MB marginal — much of the SDK's dep tree is shared with viem; the audit's ~29.5 MB was
 *  the full-boot estimate). Cached promise = loaded exactly once. */
let agentkitMod: Promise<typeof import("@worldcoin/agentkit")> | undefined;
const loadAgentkit = () => {
  agentkitMod ??= import("@worldcoin/agentkit");
  return agentkitMod;
};

const CACHE_TTL_MS = 60 * 60_000; // 1h — a registration is stable once made
/** Deliberately much shorter than the positive TTL: "not registered" is a state the agent is
 *  actively trying to leave, so a stale negative is a bad checkout experience. Long enough to
 *  absorb a retry storm from one unregistered agent, short enough that registering feels instant. */
const NEGATIVE_CACHE_TTL_MS = 60_000; // 1 min

/** Our own AgentBook read, NOT the SDK's — see agentBookReader.ts for why the difference matters. */
function defaultAgentBook(cfg: AgentkitSellerConfig) {
  return createAgentBookReader({
    ...(cfg.worldChainRpc ? { rpcUrl: cfg.worldChainRpc } : {}),
    // ONE constant for the whole codebase (§4.1): the registrar writes to it, the reader and this
    // seller check read it. Three hand-copied literals is how a redeployment ends up confirming
    // every vouch in a registry no seller looks the agent up in.
    contractAddress: (cfg.agentBookAddress ?? AGENT_BOOK_ADDRESS) as Address,
  });
}

export interface AgentkitSellerConfig {
  /** Hostname ONLY (no port): validateAgentkitMessage compares against URL.hostname. */
  domain: string;
  /** Full public resource URL (through the proxy) — must match what the client signed. */
  resourceUrl: string;
  /** CAIP-2 of the paid route's chain (Arc); World Chain is always advertised beside it because
   *  every AgentKit client in the wild signs for `eip155:480` (design v3 D10). */
  network: string;
  store: WorldStore;
  /** Per-human authorization allowance for this resource before settlement is required. */
  allowancePerHuman: number;
  /** World Chain RPC for the AgentBook read (optional; SDK default is the public endpoint). */
  worldChainRpc?: string;
  /** AgentBook address (optional; SDK default is the canonical World Chain deployment). */
  agentBookAddress?: string;
  /** RPC URLs for signature verification, keyed by CAIP-2. The verifier takes ONE url — the one
   *  for the chain the inbound payload names — so this needs an entry per chain we advertise.
   *  EIP-191 needs none (the address is recovered locally); ERC-1271 needs the url for the chain
   *  the smart account lives on, because verification is a contract call there. */
  rpcUrls?: Record<string, string>;
  /** Test seam: inject a verifier instead of hitting World Chain. */
  agentBook?: { lookupHuman(address: string): Promise<string | null> };
  /** Window for the per-human counter; absent -> lifetime (legacy). */
  rateWindowMs?: number;
  /** Key the per-human budget is charged against; defaults to `resourceUrl`. The /proof demo
   *  overrides it so replaying the demo cannot exhaust the allowance real buyers depend on —
   *  the SIWE message still references `resourceUrl`, so proof semantics are unchanged. */
  rateKey?: string;
  now?: () => number;
}

/** The `extensions.agentkit` block for our 402 body. The SDK does NOT fill nonce/issuedAt/
 *  expirationTime (the hooks pipeline normally would), so we hand-mint them per response —
 *  without them the client's isAgentkitExtension check rejects the challenge. */
export async function mintAgentkitExtension(cfg: {
  domain: string;
  resourceUrl: string;
  network: string;
  allowancePerHuman: number;
}) {
  const { declareAgentkitExtension } = await loadAgentkit();
  const ext = declareAgentkitExtension({
    domain: cfg.domain,
    resourceUri: cfg.resourceUrl,
    // Two chains, deliberately (design v3 D10). Settlement is on Arc, but AgentBook lives on
    // World Chain and every AgentKit client in the wild signs its challenge for `eip155:480` —
    // advertising only Arc makes those clients skip the proof. The SDK accepts a string or an
    // array here (`declareAgentkitExtension`, agentkit/dist/cjs/index.js) and emits one
    // {chainId, type} entry per signature scheme for each `eip155:*` network.
    network: [cfg.network, AGENT_BOOK_CAIP2],
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
    const { parseAgentkitHeader, validateAgentkitMessage, verifyAgentkitSignature } =
      await loadAgentkit();
    const payload = parseAgentkitHeader(header);

    const validation = await validateAgentkitMessage(payload, cfg.resourceUrl, {
      // Single-use nonce (SQLite) — replay of a captured header is refused.
      checkNonce: async (nonce: string) => cfg.store.consumeNonce(nonce, now()),
      // biome-ignore lint/suspicious/noExplicitAny: options typing varies across SDK versions.
    } as any);
    if (!validation.valid)
      return { authorized: false, reason: `invalid-message:${validation.error ?? "unknown"}` };

    // ONE url, for the chain THIS payload names — the SDK's second parameter is
    // `rpcUrl?: string` (agentkit-core `verifyAgentkitSignature`, re-exported unchanged by
    // `@worldcoin/agentkit`), and it goes straight into viem's `http()`. Passing the whole map
    // (which we did until this was caught) made that transport unusable: EIP-191 still passed
    // because viem's verifyMessage falls back to local ECDSA recovery when the call fails, but
    // ERC-1271 — a contract call on the account's own chain — could never succeed. Undefined is
    // fine and means "use viem's default endpoint for this chain".
    const sig = await verifyAgentkitSignature(payload, cfg.rpcUrls?.[payload.chainId]);
    if (!sig.valid || !sig.address)
      return { authorized: false, reason: `invalid-signature:${sig.error ?? "unknown"}` };
    const agentAddress = sig.address;

    // AgentBook lookup (World Chain), cached. Our reader lets transport errors PROPAGATE, so a
    // `null` here means the contract itself answered "nobody vouches for this address" — unlike
    // the SDK's lookupHuman, which catches and returns null for an outage too. That distinction
    // is what makes it safe to cache a negative at all: a cached outage would refuse a
    // legitimately registered agent for the whole TTL. A throw is caught by the outer handler and
    // refused WITHOUT being cached (fail-closed, but we ask again next time).
    const cached = cfg.store.getCachedLookup(
      agentAddress,
      now(),
      CACHE_TTL_MS,
      NEGATIVE_CACHE_TTL_MS,
    );
    let humanId = cached?.humanId ?? undefined;
    if (cached?.humanId === null)
      return { authorized: false, reason: "not-human-backed", humanId: undefined };
    if (!humanId) {
      const verifier = cfg.agentBook ?? defaultAgentBook(cfg);
      const looked = await verifier.lookupHuman(agentAddress);
      if (!looked || /^0x0*$/.test(looked) || looked === "0") {
        cfg.store.cacheLookup(agentAddress, null, now()); // definitive: the contract said nobody
        return { authorized: false, reason: "not-human-backed", humanId: undefined };
      }
      humanId = looked;
      cfg.store.cacheLookup(agentAddress, humanId, now());
    }

    const { allowed, used } = cfg.store.tryIncrementUsage(
      humanId,
      cfg.rateKey ?? cfg.resourceUrl,
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
