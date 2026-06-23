// backend/scripts/spike-agent-live.mts — needs ANTHROPIC_API_KEY; --settle spends testnet USDC.
import "dotenv/config";
import { buildLiveAgentRunner } from "../src/agent/liveRunner";
import { loadConfig } from "../src/config/env";

async function main() {
  const cfg = loadConfig();
  if (!cfg.anthropicApiKey) {
    console.log("set ANTHROPIC_API_KEY in backend/.env to run the live agent");
    return;
  }
  if (!process.argv.includes("--settle")) {
    console.log(
      "pass --settle to run the live settled cycle (funds the pocket + buys + sells; spends testnet USDC)",
    );
    return;
  }
  const query =
    process.argv.slice(2).find((a) => !a.startsWith("--")) ??
    "How is agent-economy sentiment trending?";
  const run = await buildLiveAgentRunner(cfg);
  const r = await run(query);
  console.log(`\n=== answer ===\n${r.answer}`);
  console.log("\npurchases:", r.purchases.map((p) => `${p.id} (${p.cost})`).join(", ") || "(none)");
  if (r.denied.length)
    console.log("denied:", r.denied.map((x) => `${x.id}: ${x.reason}`).join(", "));
  console.log(`\ncost=${r.totalCost} price=${r.price} P&L=${r.pnl} (atomic USDC)`);
  console.log("sold:", r.sold, "| customer:", r.customer, "| vendorPayout:", r.vendorPayout);
  console.log("funding txs:", r.fundingTxs.join(", ") || "(none)");
  console.log("settled transfer ids:", r.settleTransferIds.join(", ") || "(none)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
