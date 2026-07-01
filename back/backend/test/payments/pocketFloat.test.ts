import { expect, test, vi } from "vitest";
import { sweepPocketToTreasury } from "../../src/payments/pocketFloat";

const treasury = `0x${"aa".repeat(20)}` as const;
const usdc = `0x${"bb".repeat(20)}` as const;

function deps(balance: bigint) {
  return {
    treasury,
    usdc,
    dust: 10_000n, // 0.01 USDC floor
    pocketUsdcBalance: vi.fn(async () => balance),
    transferToTreasury: vi.fn(async () => "0xswept" as const),
  };
}

test("sweeps the full residual when above the dust floor", async () => {
  const d = deps(250_000n);
  const h = await sweepPocketToTreasury(d);
  expect(d.transferToTreasury).toHaveBeenCalledWith(treasury, 250_000n);
  expect(h).toBe("0xswept");
});

test("no-ops at/below the dust floor (leaves gas)", async () => {
  const d = deps(10_000n);
  const h = await sweepPocketToTreasury(d);
  expect(d.transferToTreasury).not.toHaveBeenCalled();
  expect(h).toBeNull();
});
