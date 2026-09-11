/**
 * Golden vectors for the hand-written Hedera `Key` protobuf decoder.
 *
 * The vectors were hand-built on 2026-09-10 from the Hedera protobuf `Key` layout and re-derived
 * in the audit. `A`, `B`, `C` are the compressed secp256k1 public keys of the private keys
 * `0x11…11`, `0x22…22`, `0x33…33`, re-derived with `@noble/curves`.
 *
 * Layout, for the reader: `2a` is field 5 (`ThresholdKey`) wire type 2; `08 01` its `threshold`;
 * `12 <len>` its `KeyList`; each `0a 23 3a 21 <33 bytes>` is one `Key` holding field 7
 * (`ECDSA_secp256k1`); `32` is field 6 (`KeyList`) at the top level.
 *
 * These constants are EXPORTED on purpose: task 5's policy tests build their scripted mirror
 * accounts from the same bytes, so the two suites can never drift apart.
 */
import { expect, test } from "vitest";
import { decodeHederaKey } from "../../src/hedera/keyDecode";

const A = "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa";
const B = "02466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const C = "023c72addb4fdf09af94f0c94d7fe92a386a7e70cf8a1d85916386bb2535c7b1b1";
const SINGLE = `3a21${A}`;
const ONE_OF_TWO = `2a4e0801124a0a233a21${A}0a233a21${B}`;
const TWO_OF_TWO = `324a0a233a21${A}0a233a21${B}`;
const ONE_OF_THREE = `2a730801126f0a233a21${A}0a233a21${B}0a233a21${C}`;
const THRESHOLD_TWO = `2a4e0802124a0a233a21${A}0a233a21${B}`;

// biome-ignore lint/suspicious/noExportsInTest: deliberate — task 5's policy tests build their scripted mirror accounts from these exact bytes, and a second copy is a second thing to get wrong.
export { A, B, C, SINGLE, ONE_OF_TWO, TWO_OF_TWO, ONE_OF_THREE, THRESHOLD_TWO };

test("single ECDSA key", () =>
  expect(decodeHederaKey(SINGLE)).toEqual({ kind: "single", keyHex: A }));

test("1-of-2 threshold", () =>
  expect(decodeHederaKey(ONE_OF_TWO)).toEqual({
    kind: "threshold",
    threshold: 1,
    keys: [
      { kind: "single", keyHex: A },
      { kind: "single", keyHex: B },
    ],
  }));

test("plain two-key list is 2-of-2", () =>
  expect(decodeHederaKey(TWO_OF_TWO)).toEqual({
    kind: "list",
    keys: [
      { kind: "single", keyHex: A },
      { kind: "single", keyHex: B },
    ],
  }));

test("1-of-3 threshold decodes with three members", () => {
  expect(decodeHederaKey(ONE_OF_THREE)).toMatchObject({ kind: "threshold", threshold: 1 });
  expect((decodeHederaKey(ONE_OF_THREE) as { keys: unknown[] }).keys).toHaveLength(3);
});

test("2-of-2 threshold decodes with threshold 2", () =>
  expect(decodeHederaKey(THRESHOLD_TWO)).toMatchObject({ kind: "threshold", threshold: 2 }));

test("an unsupported Key field number throws rather than guessing", () => {
  // Field 1 (`contractID`) is a real `Key` member this decoder deliberately does not handle:
  // a contract key is not a signing key the policy engine can reason about, and silently
  // reporting it as "no key" would read as an unsecured account.
  expect(() => decodeHederaKey("0a021234")).toThrow("unsupported key field 1");
});

test("an ed25519 key decodes as a single key, told apart by its 64-hex length", () => {
  const ed = "0".repeat(64);
  const decoded = decodeHederaKey(`1220${ed}`);
  expect(decoded).toEqual({ kind: "single", keyHex: ed });
  expect((decoded as { keyHex: string }).keyHex).toHaveLength(64);
});

test("a 0x-prefixed vector decodes the same as the bare one", () =>
  expect(decodeHederaKey(`0x${SINGLE}`)).toEqual(decodeHederaKey(SINGLE)));

test("a truncated vector throws instead of returning a half-read key", () => {
  expect(() => decodeHederaKey(SINGLE.slice(0, -4))).toThrow();
});
