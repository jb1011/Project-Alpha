/**
 * The hand-written Hedera `Key` protobuf decoder, against the golden vectors.
 *
 * The vectors themselves live in `test/helpers/hederaKeys.ts`, because task 5's policy tests build
 * their scripted mirror accounts from the same bytes and the two suites have to agree byte for
 * byte. Their layout is documented there.
 */
import { expect, test } from "vitest";
import { decodeHederaKey } from "../../src/hedera/keyDecode";
import {
  A,
  B,
  C,
  ONE_OF_THREE,
  ONE_OF_TWO,
  SINGLE,
  THRESHOLD_TWO,
  TWO_OF_TWO,
} from "../helpers/hederaKeys";

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

// A malformed ThresholdKey is the one shape this decoder must never hand on intact: both of these
// read as "satisfied" to a consumer that trusts the struct. A real consensus node emits neither.
const NO_THRESHOLD = `2a4c124a0a233a21${A}0a233a21${B}`; // KeyList present, threshold field omitted
const NO_KEYLIST = "2a020801"; // threshold 1, no KeyList at all

test("a ThresholdKey with no threshold throws rather than decoding to threshold 0", () => {
  expect(() => decodeHederaKey(NO_THRESHOLD)).toThrow("threshold key with threshold 0");
});

test("a ThresholdKey demanding more signatures than it lists throws", () => {
  expect(() => decodeHederaKey(NO_KEYLIST)).toThrow("threshold key with threshold 1 over 0 keys");
});

test("an empty KeyList still decodes — it is how Hedera encodes an unmodifiable account", () => {
  expect(decodeHederaKey("3200")).toEqual({ kind: "list", keys: [] });
});
