import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Agent-side AgentKit: prove to a seller that this agent is backed by a verified unique human.
 *
 * The signature is a plain EIP-191 personal_sign over a SIWE-style message — no funds move and
 * no chain state changes. `agentkit.fetch` only reacts to 402 responses that carry an
 * `extensions.agentkit` block; every other response passes through untouched, so wrapping our
 * payment fetch is safe for all existing sellers.
 *
 * We sign with the entity's POCKET key: it is already the agent's operational identity for x402,
 * and it is the address that WOULD be registered in AgentBook. (Audit-corrected 2026-08-03: no
 * agent pocket is actually registered today — only the standalone /proof demo key is; a proof
 * from an unregistered pocket simply fails the seller's lookup and falls through to payment.)
 * Registration binds an address to a human — it never grants spending power, so using the
 * pocket key here adds no custody risk.
 */
export interface AgentkitSigner {
  address: string;
  /** CAIP-2 — must match a `supportedChains` entry in the seller's 402 extension. */
  chainId: string;
  type: "eip191";
  signMessage(message: string): Promise<string>;
}

export function agentkitSignerFromKey(pocketKey: Hex, chainId: number): AgentkitSigner {
  const account = privateKeyToAccount(pocketKey);
  return {
    address: account.address,
    chainId: `eip155:${chainId}`,
    type: "eip191",
    signMessage: (message: string) => account.signMessage({ message }),
  };
}

/**
 * Wrap a fetch so AgentKit-enabled 402s are answered with a human-backing proof and retried once.
 * Returns the ORIGINAL fetch unchanged if the client can't be constructed — the payment path must
 * never break because the World layer is unavailable.
 */
export function wrapFetchWithAgentkit(
  baseFetch: typeof fetch,
  signer: AgentkitSigner,
): typeof fetch {
  // Lazy: the SDK (~8 MB marginal RSS measured; see worldVerifier.ts) loads on the FIRST
  // wrapped call, not at composition time —
  // buildEntityPaymentService wraps a fetch on every pay() even when the seller has no World
  // gate. Cached promise = one load per wrapper. Failure semantics unchanged: if the client
  // cannot be constructed the ORIGINAL fetch serves every call — the payment path never breaks
  // because the World layer is unavailable.
  let wrapped: Promise<typeof fetch> | undefined;
  const init = async (): Promise<typeof fetch> => {
    try {
      const { createAgentkitClient } = await import("@worldcoin/agentkit");
      const client = createAgentkitClient({
        signer,
        fetch: baseFetch,
        // biome-ignore lint/suspicious/noExplicitAny: client options typing varies across SDK versions.
      } as any) as { fetch: typeof fetch };
      return client.fetch ?? baseFetch;
    } catch {
      return baseFetch;
    }
  };
  return (async (input: RequestInfo | URL, initArg?: RequestInit) => {
    wrapped ??= init();
    return (await wrapped)(input, initArg);
  }) as typeof fetch;
}
