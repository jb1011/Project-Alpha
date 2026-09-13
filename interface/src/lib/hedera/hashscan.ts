/** Hedera testnet explorer. Identity registrations and the float account live here, not on Arcscan. */
export const HASHSCAN_TESTNET = "https://hashscan.io/testnet";

export function hashscanTxUrl(tx: string): string {
  return `${HASHSCAN_TESTNET}/transaction/${tx}`;
}

export function hashscanAccountUrl(accountId: string): string {
  return `${HASHSCAN_TESTNET}/account/${accountId}`;
}

export function hashscanContractUrl(address: string): string {
  return `${HASHSCAN_TESTNET}/contract/${address}`;
}
