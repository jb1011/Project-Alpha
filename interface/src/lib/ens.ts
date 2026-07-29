import { createPublicClient, http } from "viem";
import { mainnet, sepolia } from "viem/chains";

/**
 * ENS reverse resolution for a wallet address (its "primary name").
 *
 * Our app chain is Arc, which has no ENS, so this uses standalone clients rather than the wagmi
 * config. Mainnet is asked first because that is where a real user's name lives; Sepolia is the
 * fallback because our own ENS deployment (novicorpus.eth + the CCIP gateway) is there for the
 * hackathon, so testnet names resolve during demos.
 *
 * Every failure path is silent and returns null: a name is decoration over the address, and an
 * unreachable public RPC must never degrade the page.
 */
const RPC = {
  mainnet: process.env.NEXT_PUBLIC_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
  sepolia: process.env.NEXT_PUBLIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
};

/** Addresses rarely change their primary name mid-session; one lookup each is plenty. */
const cache = new Map<string, string | null>();

export async function lookupEnsName(address: string): Promise<string | null> {
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  for (const [chain, url] of [
    [mainnet, RPC.mainnet],
    [sepolia, RPC.sepolia],
  ] as const) {
    try {
      const client = createPublicClient({ chain, transport: http(url) });
      const name = await client.getEnsName({ address: address as `0x${string}` });
      if (name) {
        cache.set(key, name);
        return name;
      }
    } catch {
      // Unreachable RPC or no reverse registrar on that chain — try the next, then give up.
    }
  }
  cache.set(key, null);
  return null;
}
