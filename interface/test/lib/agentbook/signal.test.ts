/**
 * The signal is the one thing the client must author for itself (design v3 D8).
 *
 * The backend hands the dialog a `signal` alongside the address and nonce it claims to have built
 * it from. If the dialog trusted that field, a backend (or anything that could answer as one)
 * could put a guardian's World ID behind an address the dialog never showed them. So the dialog
 * recomputes it — and these vectors are what "recompute it CORRECTLY" means: byte-for-byte the
 * backend's `buildSignal` (back/backend/src/adapters/worldid/agentBookRegistrar.ts), 52 bytes,
 * packed, never the padded 64-byte form that encodes fine and reverts on-chain afterwards.
 */
import { describe, expect, test } from "vitest";
import { buildSignal, signalMatches } from "@/lib/agentbook/signal";

const GOLDEN = `0x${"11".repeat(20)}${"00".repeat(31)}01`;

describe("buildSignal", () => {
  test("matches the backend golden vector: address ++ uint256, packed, 52 bytes", () => {
    const sig = buildSignal("0x1111111111111111111111111111111111111111", "1");
    expect(sig).toBe(GOLDEN);
    expect((sig.length - 2) / 2).toBe(52);
  });

  test("accepts the nonce as a decimal string and normalises address case", () => {
    expect(buildSignal("0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD", "255")).toBe(
      `0x${"abcdefabcdefabcdefabcdefabcdefabcdefabcd"}${"00".repeat(31)}ff`,
    );
  });

  test("nonce 0 and a large nonce stay 32 bytes wide", () => {
    expect(buildSignal("0x1111111111111111111111111111111111111111", "0")).toBe(
      `0x${"11".repeat(20)}${"00".repeat(32)}`,
    );
    expect(buildSignal("0x1111111111111111111111111111111111111111", "256")).toBe(
      `0x${"11".repeat(20)}${"00".repeat(30)}0100`,
    );
  });

  test("is NOT the padded abi.encode form (the one that reverts on-chain)", () => {
    // The padded form would be 64 bytes and start with 12 zero bytes before the address.
    expect(buildSignal("0x1111111111111111111111111111111111111111", "1")).not.toMatch(
      /^0x0{24}11/,
    );
  });
});

describe("signalMatches", () => {
  test("true only for the signal these bytes actually commit to", () => {
    const addr = "0x1111111111111111111111111111111111111111";
    expect(signalMatches(addr, "1", GOLDEN)).toBe(true);
    expect(signalMatches(addr, "1", GOLDEN.toUpperCase().replace("0X", "0x"))).toBe(true);
    // A different nonce, a different address, and the padded form are all refusals.
    expect(signalMatches(addr, "2", GOLDEN)).toBe(false);
    expect(signalMatches("0x2222222222222222222222222222222222222222", "1", GOLDEN)).toBe(false);
    expect(signalMatches(addr, "1", `0x${"00".repeat(12)}${"11".repeat(20)}${"00".repeat(31)}01`)).toBe(
      false,
    );
  });

  test("malformed input is a refusal, not a throw", () => {
    expect(signalMatches("not-an-address", "1", GOLDEN)).toBe(false);
    expect(signalMatches("0x1111111111111111111111111111111111111111", "not-a-number", GOLDEN)).toBe(
      false,
    );
  });
});
