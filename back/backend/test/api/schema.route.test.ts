import { expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";

test("GET /schema/agent-spec.json serves the AgentSpec JSON schema", async () => {
  const res = await buildApiApp({ webOrigin: "*" } as never).request("/schema/agent-spec.json");
  expect(res.status).toBe(200);
  const schema = await res.json();
  expect(schema.$schema).toMatch(/json-schema/);
  // The schema must describe the agent spec's required-ish fields.
  expect(JSON.stringify(schema)).toContain("spendingCapUsdc");
});
