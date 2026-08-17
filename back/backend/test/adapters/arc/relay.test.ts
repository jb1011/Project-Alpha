/**
 * NoviController relay encoding (design/2026-08-13-novi-controller-design.md §3/§5).
 *
 * A manager call to target T with calldata D becomes a raw tx TO the controller with
 * `data = D ++ T` (T = the 20 raw address bytes, appended last). The controller strips the
 * trailing 20 bytes, checks the selector role, and `call`s the target with the prefix.
 * These tests pin the byte layout exactly — an off-by-one here relays the wrong target.
 */
import { type Address, type Hex, encodeFunctionData, size, slice } from "viem";
import { expect, test } from "vitest";
import { appendRelayTarget } from "../../../src/adapters/arc/relay";

const TARGET = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
const CONTROLLER = "0x4819000000000000000000000000000000000000" as Address;

test("appends the target as the final 20 raw bytes, leaving the calldata prefix untouched", () => {
  const data = "0x12345678" as Hex;
  const out = appendRelayTarget(data, TARGET);
  expect(size(out)).toBe(size(data) + 20);
  expect(slice(out, 0, size(data))).toBe(data);
  expect(slice(out, size(out) - 20)).toBe(TARGET.toLowerCase());
  // Whole-string layout, spelled out: no separator, no padding, target last.
  expect(out).toBe(`0x12345678${TARGET.slice(2).toLowerCase()}`);
});

test("a bare zero-arg selector produces exactly the 24-byte minimum the controller requires", () => {
  const data = encodeFunctionData({
    abi: [{ type: "function", name: "acceptOwnership", inputs: [], outputs: [] }] as const,
    functionName: "acceptOwnership",
  });
  expect(size(data)).toBe(4);
  const out = appendRelayTarget(data, TARGET);
  expect(size(out)).toBe(24); // 4 selector + 20 target == fallback's `msg.data.length < 24` floor
  expect(slice(out, 0, 4)).toBe(data);
});

test("real ABI calldata: the target rides behind the encoded args, prefix byte-identical", () => {
  const abi = [
    {
      type: "function",
      name: "setMetadata",
      stateMutability: "nonpayable",
      inputs: [
        { name: "agentId", type: "uint256" },
        { name: "key", type: "string" },
        { name: "value", type: "bytes" },
      ],
      outputs: [],
    },
  ] as const;
  const data = encodeFunctionData({
    abi,
    functionName: "setMetadata",
    args: [876734n, "ens", "0x616263"],
  });
  const out = appendRelayTarget(data, TARGET);
  expect(slice(out, 0, size(data))).toBe(data);
  expect(slice(out, size(out) - 20)).toBe(TARGET.toLowerCase());
});

test("case-insensitive on input, deterministic (lowercase) on output", () => {
  const upper = TARGET.toUpperCase().replace("0X", "0x") as Address;
  expect(appendRelayTarget("0xdeadbeef", upper)).toBe(appendRelayTarget("0xdeadbeef", TARGET));
});

test("fuzz-ish: any well-formed calldata length round-trips (prefix + exact 20-byte suffix)", () => {
  for (let words = 0; words <= 8; words++) {
    const data = `0xaabbccdd${"11".repeat(words * 32)}` as Hex;
    const addr = `0x${(words + 1).toString(16).padStart(2, "0").repeat(20)}` as Address;
    const out = appendRelayTarget(data, addr);
    expect(size(out)).toBe(4 + words * 32 + 20);
    expect(slice(out, 0, size(data))).toBe(data);
    expect(slice(out, size(out) - 20)).toBe(addr.toLowerCase());
  }
});

test("rejects malformed calldata rather than relaying to a garbage target", () => {
  expect(() => appendRelayTarget("0x1234" as Hex, TARGET)).toThrow(/at least a 4-byte selector/);
  expect(() => appendRelayTarget("0x123456789" as Hex, TARGET)).toThrow(/whole bytes|hex/i);
  expect(() => appendRelayTarget("1234567890" as Hex, TARGET)).toThrow(/hex/i);
  expect(() => appendRelayTarget("0x12345678", "0xnope" as Address)).toThrow(/target/i);
});
