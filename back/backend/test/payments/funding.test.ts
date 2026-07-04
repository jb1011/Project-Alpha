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
    operatorUsdcBalance: vi.fn(async () => 1_000_000n), // operator already shows the float by default
    operatorTransferUsdc: vi.fn(async () => "0xxfer" as const),
    depositToGateway: vi.fn(async () => "0xdeposit" as const),
    ...over,
  };
}

// no-op sleep so the polling tests don't spend real wall-clock
const noSleep = (_ms: number) => Promise.resolve();

test("a within-cap top-up runs fundOperator -> forward -> gateway deposit in order", async () => {
  const d = deps();
  await topUpPocket(d, 250_000n, { sleep: noSleep });
  expect(d.fundOperator).toHaveBeenCalledWith(treasury, 250_000n);
  expect(d.operatorTransferUsdc).toHaveBeenCalledWith(usdc, pocket, 250_000n);
  expect(d.depositToGateway).toHaveBeenCalledWith("0.25"); // 250000 atomic / 1e6, USDC has 6 decimals
});

test("returns the fundOperator, forward, and deposit tx hashes in order", async () => {
  const d = deps();
  const hashes = await topUpPocket(d, 250_000n, { sleep: noSleep });
  expect(hashes).toEqual(["0xfund", "0xxfer", "0xdeposit"]);
});

test("refuses a top-up that exceeds available() and signs nothing", async () => {
  const d = deps({ available: async () => 100_000n });
  await expect(topUpPocket(d, 250_000n, { sleep: noSleep })).rejects.toThrow(/exceeds available/);
  expect(d.fundOperator).not.toHaveBeenCalled();
});

test("waits for the operator's funded balance to propagate before forwarding (RPC read-after-write)", async () => {
  // Operator balance lags: 0 on the first two reads, then reflects the float. The forward must not
  // fire until the balance is visible — otherwise its simulate reverts "transfer amount exceeds balance".
  const balances = [0n, 0n, 250_000n];
  const operatorUsdcBalance = vi.fn(async () => balances.shift() ?? 250_000n);
  const order: string[] = [];
  const fundOperator = vi.fn(async () => {
    order.push("fund");
    return "0xfund" as const;
  });
  const operatorTransferUsdc = vi.fn(async () => {
    order.push("forward");
    return "0xxfer" as const;
  });
  const d = deps({ operatorUsdcBalance, fundOperator, operatorTransferUsdc });

  await topUpPocket(d, 250_000n, { sleep: noSleep, pollAttempts: 5 });

  expect(operatorUsdcBalance).toHaveBeenCalledTimes(3); // polled until balance >= amount
  expect(order).toEqual(["fund", "forward"]); // forward only after funding is visible
  expect(operatorTransferUsdc).toHaveBeenCalledWith(usdc, pocket, 250_000n);
});

test("throws loudly (without forwarding) if the funded balance never propagates", async () => {
  const operatorUsdcBalance = vi.fn(async () => 0n); // never reflects the deposit
  const d = deps({ operatorUsdcBalance });
  await expect(topUpPocket(d, 250_000n, { sleep: noSleep, pollAttempts: 3 })).rejects.toThrow(
    /did not reach/,
  );
  expect(d.fundOperator).toHaveBeenCalledOnce(); // funding still happened on-chain
  expect(d.operatorTransferUsdc).not.toHaveBeenCalled(); // but we never forward a doomed tx
  expect(operatorUsdcBalance).toHaveBeenCalledTimes(3);
});
