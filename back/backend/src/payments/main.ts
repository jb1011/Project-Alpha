// backend/src/payments/main.ts
import "dotenv/config";
import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { http, createPublicClient } from "viem";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { arcBatchingConfig, pocketSignerFromKey } from "../adapters/x402/pocket";
import { makeSignX402 } from "../adapters/x402/signX402";
import { chainFor } from "../chains";
import { loadConfig } from "../config/env";
import { migrate } from "../persistence/db";
import type { Address } from "../types";
import { PaymentLedger } from "./ledger";
import { buildAuthorityService } from "./service";

async function main() {
  const cfg = loadConfig();
  if (!cfg.pocketPrivateKey) throw new Error("POCKET_PRIVATE_KEY required to run the Authority");
  const treasury = (process.env.TREASURY_ADDRESS ?? "") as Address;
  if (!treasury) throw new Error("TREASURY_ADDRESS required (the live entity's AgentTreasury)");

  const pub = createPublicClient({
    chain: chainFor(cfg.chainId, cfg.rpcUrl),
    transport: http(cfg.rpcUrl),
  });

  const adapter = new ArcAdapter({
    publicClient: pub,
    // The Authority only READs the treasury — it never calls manager write methods.
    // managerWallet is structurally required by ArcAdapter but none of the read paths invoke it,
    // so we pass a sentinel here intentionally rather than thread an unnecessary live wallet.
    managerWallet: undefined as never,
    chainId: cfg.chainId,
    factory: (cfg.factoryAddress ?? "0x0") as Address,
    identityRegistry: cfg.identityRegistry,
  });

  const db = new Database(cfg.dbPath);
  migrate(db);

  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(cfg.pocketPrivateKey),
    chainId: cfg.chainId,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });

  const { app } = buildAuthorityService({
    ledger: new PaymentLedger(db),
    readTreasury: async (who) => ({
      available: await adapter.treasuryAvailable(treasury),
      paused: await adapter.treasuryPaused(treasury),
      allowlistEnabled: await adapter.treasuryAllowlistEnabled(treasury),
      isAllowed: await adapter.treasuryIsAllowed(treasury, who),
    }),
    signX402: async (req) =>
      signX402({
        payTo: req.payee,
        amount: req.amount,
        asset: req.asset,
        network: req.network,
        maxTimeoutSeconds: req.maxTimeoutSeconds,
      }),
  });

  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port });
  console.log(`Payment Authority listening on :${port} (treasury ${treasury})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
