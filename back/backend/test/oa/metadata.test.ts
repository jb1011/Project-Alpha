import { expect, test } from "vitest";
import { renderMetadata } from "../../src/oa/generator";
import type { AgentSpec } from "../../src/policy/agentSpec";

const spec = {
  name: "A",
  jurisdiction: "WY",
  metadata: { description: "d", agentType: "t", capabilities: ["x"], version: "1" },
} as unknown as AgentSpec;
const r = {
  legal: { ein: "12-3456789", formationDate: 1700000000 },
} as never;

test("rendered metadata legalBody has no ein", () => {
  const meta = renderMetadata(spec, r, "0xabc" as `0x${string}`);
  expect(meta.legalBody).not.toHaveProperty("ein");
  expect(meta.legalBody).toMatchObject({
    jurisdiction: "WY",
    formationDate: 1700000000,
    oaHash: "0xabc",
  });
});
