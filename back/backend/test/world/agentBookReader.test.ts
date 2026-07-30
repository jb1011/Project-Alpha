import { describe, expect, test } from "vitest";
import { createAgentBookReader } from "../../src/payments/agentBookReader";
import type { Address } from "../../src/types";

const AGENT = "0x1111111111111111111111111111111111111111" as Address;
const BOOK = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" as Address;

/** Minimal stand-in for the one viem call the reader makes. */
function clientReturning(value: bigint) {
  return { readContract: async () => value } as unknown as Parameters<
    typeof createAgentBookReader
  >[0]["client"];
}
function clientThrowing(err: Error) {
  return {
    readContract: async () => {
      throw err;
    },
  } as unknown as Parameters<typeof createAgentBookReader>[0]["client"];
}

describe("createAgentBookReader — the three states the SDK collapses into null", () => {
  test("a registered agent returns its human id as hex", async () => {
    const reader = createAgentBookReader({
      client: clientReturning(0x51dbn),
      contractAddress: BOOK,
    });
    expect(await reader.lookupHuman(AGENT)).toBe("0x51db");
  });

  test("humanId 0 means DEFINITIVELY unregistered -> null", async () => {
    const reader = createAgentBookReader({ client: clientReturning(0n), contractAddress: BOOK });
    expect(await reader.lookupHuman(AGENT)).toBeNull();
  });

  test("an RPC failure THROWS instead of masquerading as unregistered", async () => {
    // This is the whole point. @worldcoin/agentkit-core's lookupHuman catches and returns null,
    // so a rate-limited RPC is indistinguishable from "no human vouches for this agent" — the
    // caller cannot tell a refusal from an outage, and must never cache the answer.
    const reader = createAgentBookReader({
      client: clientThrowing(new Error("HTTP 429 Too Many Requests")),
      contractAddress: BOOK,
    });
    await expect(reader.lookupHuman(AGENT)).rejects.toThrow("429");
  });
});
