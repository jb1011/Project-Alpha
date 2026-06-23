// backend/test/payments/settle.live.test.ts
import { describe, expect, test } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { loadConfig } from "../../src/config/env";
import { makeSettle } from "../../src/payments/settle";
import "dotenv/config";

const run = process.env.LIVE_SETTLE === "1" ? describe : describe.skip;
run("live settle on Arc (spends ~0.01 USDC)", () => {
  test("settles a platform-key authorization through Circle's facilitator", async () => {
    const cfg = loadConfig();
    const payTo = cfg.guardianAddress ?? "0x00000000000000000000000000000000000000ab";
    const s = makeSignX402({
      signer: pocketSignerFromKey(cfg.platformPrivateKey),
      chainId: 5042002,
      network: arcBatchingConfig.network,
      verifyingContract: arcBatchingConfig.verifyingContract,
    });
    const { header } = await s({
      payTo: payTo as `0x${string}`,
      amount: 10_000n,
      asset: arcBatchingConfig.asset,
      network: arcBatchingConfig.network,
      maxTimeoutSeconds: 600,
    });
    const settle = makeSettle({ facilitatorUrl: cfg.gatewayFacilitatorUrl });
    const res = await settle(header, {
      scheme: "exact",
      network: arcBatchingConfig.network,
      asset: arcBatchingConfig.asset,
      amount: "10000",
      payTo: payTo as `0x${string}`,
      maxTimeoutSeconds: 600,
      extra: {
        name: "GatewayWalletBatched",
        version: "1",
        verifyingContract: arcBatchingConfig.verifyingContract,
      },
      resourceUrl: "https://insight.local/x",
    });
    expect(res.ok).toBe(true);
    expect((res as { transferId?: string }).transferId).toBeTruthy();
  }, 60_000);
});
