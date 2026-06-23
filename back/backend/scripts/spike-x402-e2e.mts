// backend/scripts/spike-x402-e2e.mts — exploratory; SPENDS TESTNET USDC only with --settle.
import "dotenv/config";
import { PocketGateway } from "../src/adapters/x402/gateway";
import { loadConfig } from "../src/config/env";

async function main() {
  const cfg = loadConfig();
  if (!cfg.pocketPrivateKey) throw new Error("POCKET_PRIVATE_KEY required");
  const gw = new PocketGateway({ pocketPrivateKey: cfg.pocketPrivateKey, rpcUrl: cfg.rpcUrl });

  let balanceLine: string;
  try {
    const available = await gw.getAvailable();
    balanceLine = `${available} USDC`;
  } catch {
    balanceLine = "(unavailable — no network/funds)";
  }
  console.log("pocket:", gw.address, "| gateway available:", balanceLine);

  if (!process.argv.includes("--settle")) {
    console.log(
      "(offline) run the vitest e2e for the buy+sell handshake; re-run with --settle to move USDC.",
    );
    return;
  }

  // --settle: governed bridge (real fundOperator if Turnkey is set) + a real settled buy.
  // 1) topUpPocket(...) using ArcAdapter(operatorWallet) + gw.deposit  (see backend/src/payments/funding.ts)
  // 2) buyWithX402(...) against a live seller URL; the pocket-signed authorization settles via Gateway batch.
  // Print the resulting mint/settlement tx hash + arcscan link (cf. spike-x402-gateway.mts Task 0.3).
  throw new Error(
    "fill in the --settle path from funding.ts + buyer.ts once a live seller URL is chosen",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
