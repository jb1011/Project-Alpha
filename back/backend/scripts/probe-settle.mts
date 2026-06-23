// backend/scripts/probe-settle.mts
//
// Production-path settlement interop probe (exploratory; SPENDS testnet USDC only with --settle).
//
// Answers the two open unknowns from the Phase-2 review:
//   (1) Does our manual base64 X-PAYMENT envelope interoperate with Circle's real facilitator?
//   (2) Who triggers batched settlement? -> BatchFacilitatorClient.settle (Circle Gateway API).
//
// It builds the payload through OUR production code (makeSignX402 -> header -> decodeX402Header), so a
// passing `verify` proves the real transport interoperates. Payer = the PLATFORM key, which holds a
// residual Gateway balance from the Phase-0 spike (signer is cryptographically interchangeable with the
// pocket, already proven). getSupported() + verify() move NO money; only --settle calls settle().
//
// Run (no money):   cd backend && npx tsx scripts/probe-settle.mts
// Run (spends):     cd backend && npx tsx scripts/probe-settle.mts --settle

import "dotenv/config";
import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION,
} from "@circle-fin/x402-batching";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcBatchingConfig, pocketSignerFromKey } from "../src/adapters/x402/pocket";
import { decodeX402Header, makeSignX402 } from "../src/adapters/x402/signX402";

const TESTNET_URL = "https://gateway-api-testnet.circle.com"; // client appends /v1/x402/... itself
const AMOUNT = 10_000n; // 0.01 USDC (6 decimals)

function pretty(x: unknown): string {
  return JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

async function main() {
  const payerKey = process.env.PLATFORM_PRIVATE_KEY as `0x${string}`;
  if (!payerKey) throw new Error("PLATFORM_PRIVATE_KEY required");
  const payer = privateKeyToAccount(payerKey);
  const payTo = getAddress(process.env.GUARDIAN_ADDRESS ?? payer.address);
  const rpcUrl = process.env.ARC_TESTNET_RPC_URL as string;

  console.log("=== probe-settle: production-path interop (payer = PLATFORM key) ===");
  console.log(
    `payer ${payer.address} | payTo ${payTo} | amount ${AMOUNT} atomic (0.01 USDC) | facilitator ${TESTNET_URL}`,
  );

  const fac = new BatchFacilitatorClient({ url: TESTNET_URL });

  // 1) getSupported (NO money) — is Arc testnet (eip155:5042002) listed, and what verifyingContract?
  try {
    const sup = await fac.getSupported();
    console.log("\n[getSupported]\n", pretty(sup));
  } catch (e) {
    console.log("\n[getSupported] ERR", (e as Error).message);
  }

  // 2) payer Gateway balance (NO money)
  try {
    const gw = new GatewayClient({ chain: "arcTestnet", privateKey: payerKey, rpcUrl });
    const bal = await gw.getBalances();
    console.log(
      `\n[balance] gateway available ${bal.gateway.formattedAvailable} USDC | wallet ${bal.wallet.formatted} USDC`,
    );
  } catch (e) {
    console.log("\n[balance] ERR", (e as Error).message);
  }

  // 3) build the payload through OUR production code (makeSignX402 -> header -> decodeX402Header)
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(payerKey),
    chainId: 5042002,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });
  const signed = await signX402({
    payTo,
    amount: AMOUNT,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
    maxTimeoutSeconds: 600,
  });
  const basePayload = decodeX402Header(signed.header);

  // requirements matching what makeSignX402 signed against (must be consistent or verify rejects)
  const requirements = {
    scheme: CIRCLE_BATCHING_SCHEME,
    network: arcBatchingConfig.network,
    asset: arcBatchingConfig.asset,
    amount: AMOUNT.toString(),
    payTo,
    maxTimeoutSeconds: 600,
    extra: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      verifyingContract: arcBatchingConfig.verifyingContract,
    },
  };

  // FINDING (probe): Circle's facilitator requires `resource` + `accepted` on the payload (the seller, which
  // calls settle, supplies them — it knows the resource URL + the requirements the buyer accepted).
  const paymentPayload = {
    ...basePayload,
    resource: {
      url: "https://insight.local/api/insight",
      description: "governed nanopayment insight",
      mimeType: "application/json",
    },
    accepted: requirements,
  };
  console.log("\n[payload via our manual codec + seller enrichment]\n", pretty(paymentPayload));

  // 4) verify (NO money) — does Circle's facilitator accept our decoded production payload?
  try {
    // biome-ignore lint/suspicious/noExplicitAny: probing the facilitator's loosely-typed boundary
    const v = await fac.verify(paymentPayload as any, requirements as any);
    console.log("\n[verify]\n", pretty(v));
  } catch (e) {
    console.log("\n[verify] ERR", (e as Error).message);
  }

  // 5) settle (SPENDS testnet USDC) — only with --settle
  if (process.argv.includes("--settle")) {
    console.log("\n=== --settle: submitting to Circle Gateway for REAL on-chain settlement ===");
    // biome-ignore lint/suspicious/noExplicitAny: probing the facilitator's loosely-typed boundary
    const s = await fac.settle(paymentPayload as any, requirements as any);
    console.log("[settle]\n", pretty(s));
    // NB: `transaction` is a Circle Gateway transfer ID (UUID), not an on-chain hash. Settlement is
    // batched/async: poll GatewayClient.getTransferById(id) until status "received" -> "completed"
    // (~1 min on testnet); the payer's Gateway available balance is debited immediately on success.
    const id = (s as { transaction?: string }).transaction;
    if (id)
      console.log(
        "\ntransfer id:",
        id,
        "(getTransferById -> status; debits Gateway balance on success)",
      );
  } else {
    console.log("\n(no --settle -> no money moved. Re-run with --settle once verify looks right.)");
  }
}

main().catch((e) => {
  console.error("probe error:", e);
  process.exit(1);
});
