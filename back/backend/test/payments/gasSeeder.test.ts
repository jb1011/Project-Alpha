import { expect, test, vi } from "vitest";
import { ensureNativeGas } from "../../src/payments/gasSeeder";
import type { Address } from "../../src/types";

const A = `0x${"a".repeat(40)}` as Address;
const B = `0x${"b".repeat(40)}` as Address;
const floor = 50_000_000_000_000_000n; // 0.05e18
const target = 200_000_000_000_000_000n; // 0.2e18

test("tops up an EOA below floor to target, confirms the seed, and returns the hash", async () => {
  const sendNative = vi.fn(async () => "0xseedA" as const);
  const confirm = vi.fn(async () => undefined);
  const getBalance = vi.fn(async () => 0n);
  const hashes = await ensureNativeGas([A], { getBalance, sendNative, confirm, floor, target });
  expect(sendNative).toHaveBeenCalledWith(A, target); // 0.2e18 - 0
  expect(confirm).toHaveBeenCalledWith("0xseedA");
  expect(hashes).toEqual(["0xseedA"]);
});

test("awaits confirm for the seeded hash before ensureNativeGas returns", async () => {
  const order: string[] = [];
  const sendNative = vi.fn(async () => {
    order.push("sendNative");
    return "0xseedA" as const;
  });
  const confirm = vi.fn(async (hash: `0x${string}`) => {
    order.push(`confirm:${hash}`);
  });
  const getBalance = vi.fn(async () => 0n);
  await ensureNativeGas([A], { getBalance, sendNative, confirm, floor, target });
  expect(order).toEqual(["sendNative", "confirm:0xseedA"]);
});

test("skips an EOA at/above floor, sends nothing, and never calls confirm", async () => {
  const sendNative = vi.fn(async () => "0xseed" as const);
  const confirm = vi.fn(async () => undefined);
  const getBalance = vi.fn(async () => floor); // exactly at floor -> skip
  const hashes = await ensureNativeGas([A], { getBalance, sendNative, confirm, floor, target });
  expect(sendNative).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  expect(hashes).toEqual([]);
});

test("handles multiple targets independently, confirms only the seeded one, and sends target - balance", async () => {
  const balances: Record<string, bigint> = { [A]: 0n, [B]: 100_000_000_000_000_000n }; // B at 0.1 (below floor? no, >= floor -> skip)
  const sendNative = vi.fn(async (to: Address) => `0xseed-${to}` as const as `0x${string}`);
  const confirm = vi.fn(async () => undefined);
  const getBalance = vi.fn(async (addr: Address) => balances[addr] ?? 0n);
  const hashes = await ensureNativeGas([A, B], { getBalance, sendNative, confirm, floor, target });
  expect(sendNative).toHaveBeenCalledTimes(1);
  expect(sendNative).toHaveBeenCalledWith(A, target); // only A below floor
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm).toHaveBeenCalledWith(`0xseed-${A}`);
  expect(hashes).toEqual([`0xseed-${A}`]);
});

test("confirms each seeded target once, in order, when multiple are below floor", async () => {
  const sendNative = vi.fn(async (to: Address) => `0xseed-${to}` as const as `0x${string}`);
  const confirmed: string[] = [];
  const confirm = vi.fn(async (hash: `0x${string}`) => {
    confirmed.push(hash);
  });
  const getBalance = vi.fn(async () => 0n); // both below floor
  const hashes = await ensureNativeGas([A, B], { getBalance, sendNative, confirm, floor, target });
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(confirmed).toEqual([`0xseed-${A}`, `0xseed-${B}`]);
  expect(hashes).toEqual([`0xseed-${A}`, `0xseed-${B}`]);
});
