import type { Address, Hex } from "../types";

export interface GasSeedDeps {
  /** Native balance (18-dec wei) of an address. */
  getBalance: (addr: Address) => Promise<bigint>;
  /** Send `value` native (18-dec wei) from the platform wallet to `to`; returns the tx hash. */
  sendNative: (to: Address, value: bigint) => Promise<Hex>;
  /** Top up an address whose native balance is below this. */
  floor: bigint;
  /** Bring a topped-up address up to this native balance. */
  target: bigint;
}

/**
 * Ensure each target EOA has native gas: for any target below `floor`, send `target - balance`
 * from the platform wallet. Returns the seed tx hashes (empty when nothing needed topping up).
 * Chain-injected (getBalance/sendNative) so it unit-tests without a node.
 */
export async function ensureNativeGas(targets: Address[], d: GasSeedDeps): Promise<Hex[]> {
  const hashes: Hex[] = [];
  for (const to of targets) {
    const balance = await d.getBalance(to);
    if (balance >= d.floor) continue;
    hashes.push(await d.sendNative(to, d.target - balance));
  }
  return hashes;
}
