import { http, type PublicClient, createPublicClient, toHex } from "viem";
import type { Address } from "../types";

/**
 * AgentBook `lookupHuman` read that distinguishes "not registered" from "could not tell".
 *
 * WHY NOT THE SDK. `@worldcoin/agentkit-core`'s `createAgentBookVerifier().lookupHuman` wraps its
 * `readContract` in `try { ... } catch { return null }`, so a rate-limited or unreachable World
 * Chain RPC returns exactly what an unregistered agent returns: `null`. The seller then refuses
 * either way (fail-closed, correct) — but the two outcomes must NOT be treated alike downstream:
 * a definitive "unregistered" is safe to cache, while an outage cached as a refusal would lock out
 * a legitimately registered agent for the whole TTL, and would turn one bad minute of RPC into an
 * hour of wrongly-refused commerce.
 *
 * So we do the same single `view` call ourselves and let transport errors propagate:
 *   - returns `0`      -> `null`   : the contract answered; nobody vouches for this address
 *   - returns non-zero -> hex id   : registered
 *   - throws           -> throws   : we do not know, and must not pretend we do
 *
 * The ABI is one function and the address is already in our own config (`WORLD_AGENTBOOK_ADDRESS`,
 * same canonical World Chain deployment the SDK defaults to), so this duplicates nothing we were
 * not already carrying.
 */
const AGENT_BOOK_ABI = [
  {
    inputs: [{ internalType: "address", name: "agent", type: "address" }],
    name: "lookupHuman",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface AgentBookReaderOptions {
  /** Injected in tests; built from `rpcUrl` in production. */
  client?: PublicClient;
  /** World Chain RPC (ignored when `client` is supplied). */
  rpcUrl?: string;
  contractAddress: Address;
}

export interface AgentBookReader {
  /** `null` = definitively unregistered. THROWS when the lookup could not be completed. */
  lookupHuman(address: string): Promise<string | null>;
}

export function createAgentBookReader(opts: AgentBookReaderOptions): AgentBookReader {
  const client = opts.client ?? createPublicClient({ transport: http(opts.rpcUrl) });
  return {
    async lookupHuman(address: string): Promise<string | null> {
      const humanId = (await client.readContract({
        address: opts.contractAddress,
        abi: AGENT_BOOK_ABI,
        functionName: "lookupHuman",
        args: [address as Address],
      })) as bigint;
      return humanId === 0n ? null : toHex(humanId);
    },
  };
}
