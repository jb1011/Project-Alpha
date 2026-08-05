// backend/src/adapters/x402/gatewayRead.ts
import { GatewayClient } from "@circle-fin/x402-batching/client";

/**
 * Read a depositor's spendable Gateway balance BY ADDRESS — decimal USDC, from the SAME source as
 * `PocketGateway.getAvailable()`: Circle's Gateway facilitator API (`getBalances`), which debits a
 * spend the moment a burn intent is accepted and credits deposits only after finality. This is the
 * balance that decides whether a `pay` will settle, so preflights and exposure reads MUST use it —
 * the raw on-chain `availableBalance` view lags it in both directions (review finding H2: an
 * on-chain read would pass a preflight the facilitator is about to reject, burning the payment's
 * idempotency key on an unconfirmed receipt).
 *
 * Tier-0: the circle-path pocket has NO local private key (Circle MPC holds it), and the turnkey
 * path shouldn't need the master seed just to READ a balance. `GatewayClient.getBalances(address)`
 * takes an explicit depositor address, so the client is constructed with a throwaway key that
 * never signs anything.
 */
const THROWAWAY_READER_KEY = `0x${"01".repeat(32)}` as const;

export async function readGatewayAvailableByAddress(p: {
  rpcUrl: string;
  depositor: string;
}): Promise<number> {
  const client = new GatewayClient({
    chain: "arcTestnet",
    privateKey: THROWAWAY_READER_KEY,
    rpcUrl: p.rpcUrl,
  });
  const b = await client.getBalances(p.depositor as `0x${string}`);
  return Number(b.gateway.formattedAvailable);
}
