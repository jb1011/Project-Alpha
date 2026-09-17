/**
 * HashScan, Hedera's block explorer. Identity registrations and the linked account live here, not
 * on Arcscan.
 *
 * THE NETWORK SEGMENT IS DERIVED, never assumed. It comes from the chain id of the registration
 * the link belongs to (295 mainnet, 296 testnet), because `/testnet/...` built for a mainnet id
 * does not fail loudly: it resolves to a page about a different thing, or about nothing, while
 * the row around it says the link is this company's proof. An unknown chain builds NO link, which
 * renders as plain text — the same silence as a fact we were never told.
 */
export type HederaNetwork = "mainnet" | "testnet";

/** Hedera's EVM chain ids, as CAIP-2 spells them (`eip155:<chainId>`). */
const NETWORK_BY_CHAIN_ID: Record<string, HederaNetwork> = {
  "295": "mainnet",
  "296": "testnet",
};

/** The Hedera network a chain id names, or null for any id that is not Hedera's. */
export function hederaNetworkOfChainId(
  chainId: string | number | null | undefined,
): HederaNetwork | null {
  if (chainId === null || chainId === undefined) return null;
  return NETWORK_BY_CHAIN_ID[String(chainId)] ?? null;
}

function hashscanBase(network: HederaNetwork | null | undefined): string | null {
  return network ? `https://hashscan.io/${network}` : null;
}

/**
 * THE SHAPES, checked before anything is interpolated into a url.
 *
 * Every one of these values reaches the page from a public JSON document. A value of the wrong
 * shape is not a formatting problem: pasted into a HashScan path it produces a link that 404s, or
 * points at a different kind of object, under a label that says it is this company's proof. So an
 * unrecognised value builds no url and the caller renders it as plain text.
 */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const ACCOUNT_ID = /^\d+\.\d+\.\d+$/;

export function hashscanTxUrl(
  network: HederaNetwork | null | undefined,
  tx: string | null | undefined,
): string | undefined {
  const base = hashscanBase(network);
  if (!base || !tx || !TX_HASH.test(tx)) return undefined;
  return `${base}/transaction/${tx}`;
}

export function hashscanAccountUrl(
  network: HederaNetwork | null | undefined,
  accountId: string | null | undefined,
): string | undefined {
  const base = hashscanBase(network);
  if (!base || !accountId || !ACCOUNT_ID.test(accountId)) return undefined;
  return `${base}/account/${accountId}`;
}
