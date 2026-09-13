/**
 * Guardian pause/unpause script (task 14): the pure parts only.
 *
 * `assertGuardianMatches` and `parseArgs` are the only I/O-free pieces of this script. `main()`
 * opens a database, a wallet client and an RPC connection and is never invoked here — the
 * script's `isEntryPoint` guard keeps importing it side-effect free (same idiom as
 * `test/hedera/registerIdentity.test.ts`).
 */
import type { Address } from "viem";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  assertGuardianMatches,
  configModeFor,
  main,
  parseArgs,
} from "../../scripts/guardian-pause.mjs";

// `main()` loads dotenv before it reads anything. Stubbed so this suite never depends on an
// untracked developer `.env`, which is the same reason the script defers the load into `main()`.
vi.mock("dotenv", () => ({ default: { config: () => ({ parsed: {} }) } }));

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

describe("configModeFor", () => {
  test("--entity resolves against the local database", () => {
    expect(configModeFor(parseArgs(["pause", "--entity", "FormationE2E_1"]))).toBe("database");
  });

  test("--treasury never touches the database (task 10's --from-prod ruling, D28)", () => {
    expect(configModeFor(parseArgs(["pause", "--treasury", GUARDIAN]))).toBe("env-only");
  });
});

describe("main refuses an out-of-range DEMO_GUARDIAN_KEY without printing it", () => {
  // 64 hex characters, so the script's regex passes, but above the secp256k1 group order, so viem
  // throws — and viem's message renders the key as a decimal integer (PR 3 review, I1).
  const OUT_OF_RANGE = `0x${"f".repeat(64)}`;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("exits through usage, and nothing key-shaped reaches stderr", async () => {
    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderr.push(args.map(String).join(" "));
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit");
    }) as never);
    vi.stubEnv("DEMO_GUARDIAN_KEY", OUT_OF_RANGE);
    const argv = process.argv;
    process.argv = ["node", "guardian-pause.mts", "pause", "--treasury", GUARDIAN];

    try {
      await expect(main()).rejects.toThrow("process.exit");
    } finally {
      process.argv = argv;
    }

    expect(exit).toHaveBeenCalledWith(2);
    const printed = stderr.join("\n");
    expect(printed).toContain("DEMO_GUARDIAN_KEY is not a valid secp256k1 private key");
    expect(printed).not.toContain(OUT_OF_RANGE);
    expect(printed).not.toContain(OUT_OF_RANGE.slice(2));
    // Nothing 64-hex-shaped at all, and not the decimal rendering viem would have produced.
    expect(printed).not.toMatch(/[0-9a-fA-F]{64}/);
    expect(printed).not.toContain(BigInt(OUT_OF_RANGE).toString(10));
  });
});
