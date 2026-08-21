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

test("E5: the published schema no longer ADVERTISES legal.ein, and additional keys are refused", async () => {
  const res = await buildApiApp({ webOrigin: "*" } as never).request("/schema/agent-spec.json");
  const schema = await res.json();
  const printed = JSON.stringify(schema);
  // The EIN is issued by the IRS and carried by the OA bundle manifest (design §4). A schema
  // that still listed it would keep telling every generated client — and the MCP tool surface —
  // to collect a legal fact the system refuses.
  expect(printed).not.toContain('"ein"');
  // The rest of the legal block is intact, and the object is closed.
  expect(printed).toContain('"formationDate"');
  const legal = (schema.definitions?.AgentSpec?.properties?.legal ?? schema.properties?.legal) as {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
  };
  expect(legal.additionalProperties).toBe(false);
  expect(Object.keys(legal.properties ?? {})).toEqual(["formationDate"]);
});
