import { expect, test, vi } from "vitest";
import { readStandingExposure } from "../../src/payments/standingExposure";
import type { Address } from "../../src/types";

const OPERATOR = `0x${"b".repeat(40)}` as Address;
const POCKET = `0x${"c".repeat(40)}` as Address;

test("sums operator EOA + pocket EOA + Gateway into an atomic total", async () => {
  const balances: Record<string, bigint> = { [OPERATOR]: 200_000n, [POCKET]: 200_000n };
  const s = await readStandingExposure({
    usdcBalanceOf: async (owner) => balances[owner] ?? 0n,
    gatewayAvailable: async () => 0.5, // decimal USDC
    operator: OPERATOR,
    pocket: POCKET,
  });
  expect(s).toEqual({
    operatorEoa: 200_000n,
    pocketEoa: 200_000n,
    gateway: 500_000n,
    total: 900_000n,
  });
});

test("floors the Gateway decimal conservatively (never rounds up)", async () => {
  const s = await readStandingExposure({
    usdcBalanceOf: async () => 0n,
    gatewayAvailable: async () => 0.4999995, // would be 499999.5 atomic
    operator: OPERATOR,
    pocket: POCKET,
  });
  expect(s.gateway).toBe(499_999n);
  expect(s.total).toBe(499_999n);
});
