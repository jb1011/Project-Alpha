// backend/test/payments/funding.test.ts
import { expect, test, vi } from "vitest";
import { type FundingDeps, topUpPocket } from "../../src/payments/funding";

const treasury = `0x${"aa".repeat(20)}` as const;
const usdc = `0x${"bb".repeat(20)}` as const;
const pocket = `0x${"cc".repeat(20)}` as const;

function deps(over: Partial<FundingDeps> = {}): FundingDeps {
  return {
    treasury,
    usdc,
    pocketAddress: pocket,
    available: async () => 1_000_000n,
    fundOperator: vi.fn(async () => "0xfund" as const),
    operatorTransferUsdc: vi.fn(async () => "0xxfer" as const),
    depositToGateway: vi.fn(async () => undefined),
    ...over,
  };
}

test("a within-cap top-up runs fundOperator -> forward -> gateway deposit in order", async () => {
  const d = deps();
  await topUpPocket(d, 250_000n);
  expect(d.fundOperator).toHaveBeenCalledWith(treasury, 250_000n);
  expect(d.operatorTransferUsdc).toHaveBeenCalledWith(usdc, pocket, 250_000n);
  expect(d.depositToGateway).toHaveBeenCalledWith("0.25"); // 250000 atomic / 1e6, USDC has 6 decimals
});

test("refuses a top-up that exceeds available() and signs nothing", async () => {
  const d = deps({ available: async () => 100_000n });
  await expect(topUpPocket(d, 250_000n)).rejects.toThrow(/exceeds available/);
  expect(d.fundOperator).not.toHaveBeenCalled();
});
