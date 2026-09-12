/**
 * Guardian pause/unpause script (task 14): the pure parts only.
 *
 * `assertGuardianMatches` and `parseArgs` are the only I/O-free pieces of this script. `main()`
 * opens a database, a wallet client and an RPC connection and is never invoked here — the
 * script's `isEntryPoint` guard keeps importing it side-effect free (same idiom as
 * `test/hedera/registerIdentity.test.ts`).
 */
import type { Address } from "viem";
import { describe, expect, test } from "vitest";
import { assertGuardianMatches, parseArgs } from "../../scripts/guardian-pause.mjs";

const GUARDIAN = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;

describe("assertGuardianMatches", () => {
  test("does not throw when the key address equals the on-chain guardian", () => {
    expect(() => assertGuardianMatches(GUARDIAN, GUARDIAN)).not.toThrow();
  });

  test("throws the named error when the key address does not match", () => {
    expect(() => assertGuardianMatches(GUARDIAN, OTHER)).toThrow(
      "guardian key does not match on-chain guardian",
    );
  });

  test("matches regardless of case", () => {
    const mixedCase = `0x${GUARDIAN.slice(2).toUpperCase()}` as Address;
    expect(() => assertGuardianMatches(GUARDIAN, mixedCase)).not.toThrow();
    expect(() => assertGuardianMatches(mixedCase, GUARDIAN)).not.toThrow();
  });
});

describe("parseArgs", () => {
  test("parses pause with --entity", () => {
    expect(parseArgs(["pause", "--entity", "FormationE2E_1"])).toEqual({
      mode: "pause",
      entity: "FormationE2E_1",
      treasury: undefined,
    });
  });

  test("parses unpause with --treasury", () => {
    expect(parseArgs(["unpause", "--treasury", GUARDIAN])).toEqual({
      mode: "unpause",
      entity: undefined,
      treasury: GUARDIAN,
    });
  });

  test("rejects a first argument that is not pause or unpause", () => {
    expect(() => parseArgs(["toggle", "--entity", "x"])).toThrow(/must be "pause" or "unpause"/);
    expect(() => parseArgs([])).toThrow(/must be "pause" or "unpause"/);
  });

  test("rejects when neither --entity nor --treasury is given", () => {
    expect(() => parseArgs(["pause"])).toThrow(
      "one of --entity <name|key> or --treasury <address> is required",
    );
  });

  test("rejects when both --entity and --treasury are given (mutually exclusive)", () => {
    expect(() => parseArgs(["pause", "--entity", "x", "--treasury", GUARDIAN])).toThrow(
      "--entity and --treasury are mutually exclusive",
    );
  });

  test("rejects a --treasury value that is not a 20-byte address", () => {
    expect(() => parseArgs(["pause", "--treasury", "not-an-address"])).toThrow(
      /--treasury must be/,
    );
  });

  test("rejects a flag with no value following it", () => {
    expect(() => parseArgs(["pause", "--entity"])).toThrow("--entity needs a value");
  });
});
