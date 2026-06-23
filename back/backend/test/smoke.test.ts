import { keccak256, toHex } from "viem";
import { expect, test } from "vitest";

test("toolchain is wired (viem importable, keccak works)", () => {
  expect(keccak256(toHex("legal body"))).toMatch(/^0x[0-9a-f]{64}$/);
});
