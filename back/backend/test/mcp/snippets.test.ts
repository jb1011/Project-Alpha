import { expect, test } from "vitest";
import { buildSnippets } from "../../src/mcp/snippets";

const p = { mcpUrl: "https://api.example/mcp", apiKey: "mcp_abc" };

test("emits a snippet for every main agent, each embedding url + key", () => {
  const s = buildSnippets(p);
  for (const k of ["claudeCode", "cursor", "codex", "openclaw", "gemini", "generic"] as const) {
    expect(s[k]).toContain("https://api.example/mcp");
    expect(s[k]).toContain("mcp_abc");
  }
});

test("claude code snippet is the documented CLI form", () => {
  expect(buildSnippets(p).claudeCode).toBe(
    'claude mcp add legalbody --transport http https://api.example/mcp --header "Authorization: Bearer mcp_abc"',
  );
});

test("cursor + generic snippets are valid JSON", () => {
  const s = buildSnippets(p);
  expect(() => JSON.parse(s.cursor)).not.toThrow();
  expect(() => JSON.parse(s.generic)).not.toThrow();
});
