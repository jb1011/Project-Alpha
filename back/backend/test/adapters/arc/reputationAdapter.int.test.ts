import { describe, expect, test } from "vitest";
import { mockReputationRegistryAbi } from "../../../src/abis/generated";
import { ReputationAdapter } from "../../../src/adapters/arc/reputationAdapter";
import { deployMockReputation } from "../../helpers/anvilJob";

test("record increments the registry feedback count", async () => {
  const env = await deployMockReputation();
  try {
    const r = new ReputationAdapter({
      publicClient: env.publicClient,
      recorderWallet: env.evaluatorWallet,
      registry: env.registryAddr,
    });
    await r.record({ agentId: 656785n, value: 5, feedbackHash: `0x${"ab".repeat(32)}` });
    const count = await env.publicClient.readContract({
      address: env.registryAddr,
      abi: mockReputationRegistryAbi,
      functionName: "count",
      args: [656785n],
    });
    expect(count).toBe(1n);
  } finally {
    await env.stop();
  }
});
