/**
 * Both shapes World's bridge is known to return, and the refusal for anything else.
 *
 * A proof we cannot parse must become `null` and stop the flow, never a best-effort array: the
 * backend spends gas simulating and submitting what we send it.
 */
import { encodeAbiParameters } from "viem";
import { describe, expect, test } from "vitest";
import { normalizeProof } from "@/lib/agentbook/proof";

/** `1n`-style literals need ES2020 and this package targets ES2017 (tsconfig.json). */
const EIGHT = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => BigInt(n)) as [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];

describe("normalizeProof", () => {
  test("a JSON array of 8 strings passes through", () => {
    const arr = Array.from({ length: 8 }, (_, i) => `0x${i + 1}`);
    expect(normalizeProof(JSON.stringify(arr))).toEqual(arr);
  });

  test("an ABI-encoded uint256[8] is decoded to 8 padded hex words", () => {
    const enc = encodeAbiParameters([{ type: "uint256[8]" }], [EIGHT]);
    const out = normalizeProof(enc);
    expect(out).toHaveLength(8);
    expect(out?.[0]).toBe(`0x${"0".repeat(63)}1`);
    expect(out?.[7]).toBe(`0x${"0".repeat(63)}8`);
  });

  test("every element the backend's zod regex accepts", () => {
    const enc = encodeAbiParameters([{ type: "uint256[8]" }], [EIGHT]);
    for (const word of normalizeProof(enc) ?? []) {
      expect(word).toMatch(/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/);
    }
  });

  test("garbage is null", () => {
    expect(normalizeProof("0xzz")).toBeNull();
    expect(normalizeProof("[1,2]")).toBeNull();
    expect(normalizeProof("[")).toBeNull();
    expect(normalizeProof("")).toBeNull();
  });

  test("a JSON array of the wrong length is null, not padded", () => {
    expect(normalizeProof(JSON.stringify(Array.from({ length: 9 }, () => "0x1")))).toBeNull();
  });
});
