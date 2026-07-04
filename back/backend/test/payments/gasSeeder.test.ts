import { expect, test, vi } from "vitest";
import { ensureNativeGas } from "../../src/payments/gasSeeder";
import type { Address } from "../../src/types";

const A = `0x${"a".repeat(40)}` as Address;
const B = `0x${"b".repeat(40)}` as Address;
const floor = 50_000_000_000_000_000n; // 0.05e18
const target = 200_000_000_000_000_000n; // 0.2e18

test("tops up an EOA below floor to target and returns the hash", async () => {
  const sendNative = vi.fn(async () => "0xseedA" as const);
  const getBalance = vi.fn(async () => 0n);
  const hashes = await ensureNativeGas([A], { getBalance, sendNative, floor, target });
  expect(sendNative).toHaveBeenCalledWith(A, target); // 0.2e18 - 0
  expect(hashes).toEqual(["0xseedA"]);
});

test("skips an EOA at/above floor and sends nothing", async () => {
  const sendNative = vi.fn(async () => "0xseed" as const);
  const getBalance = vi.fn(async () => floor); // exactly at floor -> skip
  const hashes = await ensureNativeGas([A], { getBalance, sendNative, floor, target });
  expect(sendNative).not.toHaveBeenCalled();
  expect(hashes).toEqual([]);
});

test("handles multiple targets independently and sends target - balance", async () => {
  const balances: Record<string, bigint> = { [A]: 0n, [B]: 100_000_000_000_000_000n }; // B at 0.1 (below floor? no, >= floor -> skip)
  const sendNative = vi.fn(async (to: Address) => `0xseed-${to}` as const as `0x${string}`);
  const getBalance = vi.fn(async (addr: Address) => balances[addr] ?? 0n);
  const hashes = await ensureNativeGas([A, B], { getBalance, sendNative, floor, target });
  expect(sendNative).toHaveBeenCalledTimes(1);
  expect(sendNative).toHaveBeenCalledWith(A, target); // only A below floor
  expect(hashes).toEqual([`0xseed-${A}`]);
});
