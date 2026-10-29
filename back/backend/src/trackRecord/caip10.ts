import { type Address, type Hex, getAddress, hexToString, isHex } from "viem";

/** An Ethereum mainnet account in CAIP-10 form, and nothing else: no other chain, no padding. */
const ETHEREUM_ACCOUNT = /^eip155:1:(0x[0-9a-fA-F]{40})$/;

/**
 * The locking wallet an identity names in its metadata (design section 4.1.4), or null.
 *
 * The value is UTF-8 bytes written by whoever controls the identity. Only an exact
 * `eip155:1:<40 hex>` is accepted, the chain id included: a wallet on another chain is
 * `not_linked`, never a guess. The address comes back checksummed, and it is the only part of
 * the metadata that ever reaches a URL.
 */
export function parseLockingWallet(bytes: Hex): Address | null {
  if (!isHex(bytes) || bytes === "0x") return null;
  let text: string;
  try {
    text = hexToString(bytes);
  } catch {
    return null;
  }
  const match = ETHEREUM_ACCOUNT.exec(text);
  return match ? getAddress(match[1] as string) : null;
}
