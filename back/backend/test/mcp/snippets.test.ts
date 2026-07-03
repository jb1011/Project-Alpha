import { expect, test } from "vitest";
import { buildSnippets } from "../../src/mcp/snippets";

const p = { mcpUrl: "https://api.example/mcp", apiKey: "mcp_abc" };

test("emits a snippet for every supported agent, each embedding url + key", () => {
  const s = buildSnippets(p);
  for (const k of [
    "claudeCode",
    "cursor",
    "codex",
    "openclaw",
    "gemini",
    "windsurf",
    "cline",
    "vscode",
    "claudeDesktop",
    "generic",
  ] as const) {
    expect(s[k]).toContain("https://api.example/mcp");
    expect(s[k]).toContain("mcp_abc");
  }
});

test("claude code snippet is the documented CLI form", () => {
  expect(buildSnippets(p).claudeCode).toBe(
    'claude mcp add legalbody --transport http https://api.example/mcp --header "Authorization: Bearer mcp_abc"',
  );
});

test("every JSON-form snippet is valid JSON (only claudeCode is a CLI string)", () => {
  const s = buildSnippets(p);
  for (const k of [
    "cursor",
    "codex",
    "openclaw",
    "gemini",
    "windsurf",
    "cline",
    "vscode",
    "claudeDesktop",
    "generic",
  ] as const) {
    expect(() => JSON.parse(s[k]), k).not.toThrow();
  }
});

test("vscode uses the `servers` key (not mcpServers) with an explicit http type", () => {
  const vs = JSON.parse(buildSnippets(p).vscode);
  expect(vs.servers.legalbody.type).toBe("http");
  expect(vs.servers.legalbody.url).toBe(p.mcpUrl);
});
