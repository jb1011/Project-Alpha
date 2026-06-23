import { describe, expect, test } from "vitest";
import { mockReputationRegistryAbi, reputationRegistryAbi } from "../../src/abis/generated";

describe("reputation ABIs", () => {
  test("reputationRegistryAbi exposes giveFeedback", () => {
    const names = reputationRegistryAbi.filter((x) => x.type === "function").map((x) => x.name);
    expect(names).toContain("giveFeedback");
  });

  test("mockReputationRegistryAbi exposes giveFeedback", () => {
    const names = mockReputationRegistryAbi.filter((x) => x.type === "function").map((x) => x.name);
    expect(names).toContain("giveFeedback");
  });
});
