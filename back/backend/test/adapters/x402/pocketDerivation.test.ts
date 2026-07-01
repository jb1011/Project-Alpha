import { expect, test } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { derivePocketKey } from "../../../src/adapters/x402/pocketDerivation";

const seed = `0x${"11".repeat(32)}` as const;

test("is deterministic for the same entityKey", () => {
  expect(derivePocketKey(seed, "agent-A")).toBe(derivePocketKey(seed, "agent-A"));
});

test("differs per entityKey (no commingling)", () => {
  expect(derivePocketKey(seed, "agent-A")).not.toBe(derivePocketKey(seed, "agent-B"));
});

test("differs per seed", () => {
  const seed2 = `0x${"22".repeat(32)}` as const;
  expect(derivePocketKey(seed, "agent-A")).not.toBe(derivePocketKey(seed2, "agent-A"));
});

test("yields a valid 32-byte private key usable by viem", () => {
  const k = derivePocketKey(seed, "agent-A");
  expect(k).toMatch(/^0x[0-9a-f]{64}$/);
  expect(privateKeyToAccount(k).address).toMatch(/^0x[0-9a-fA-F]{40}$/);
});
