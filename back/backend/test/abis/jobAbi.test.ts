import { describe, expect, test } from "vitest";
import { iErc8183JobAbi, mockErc8183JobAbi } from "../../src/abis/generated";

describe("job ABIs", () => {
  test("expose createJob and complete", () => {
    const iNames = iErc8183JobAbi.filter((x) => x.type === "function").map((x) => x.name);
    const mNames = mockErc8183JobAbi.filter((x) => x.type === "function").map((x) => x.name);
    expect(iNames).toContain("createJob");
    expect(iNames).toContain("complete");
    expect(mNames).toContain("createJob");
    expect(mNames).toContain("complete");
  });
});
