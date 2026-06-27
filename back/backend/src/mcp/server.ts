import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EntityRepository } from "../persistence/entityRepository";
import type { PasskeyStore } from "../persistence/passkeyStore";
import type { OnboardingRunner } from "../workflow/runner";

export interface McpToolDeps {
  repo: EntityRepository;
  runner: OnboardingRunner;
  passkeys: PasskeyStore;
}

/** Build a fresh, tenant-scoped MCP server. tenantId is closed over — never taken from a tool arg. */
export function buildMcpServer(tenantId: string, _deps: McpToolDeps): McpServer {
  const server = new McpServer({ name: "project-alpha-brain", version: "1.0.0" });

  server.registerTool(
    "whoami",
    { title: "Who am I", description: "Return the authenticated tenant address." },
    async () => ({ content: [{ type: "text", text: tenantId }] }),
  );

  return server;
}
