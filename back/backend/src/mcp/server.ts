import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { toEntityView } from "../api/views";
import type { EntityRepository } from "../persistence/entityRepository";
import type { PasskeyStore } from "../persistence/passkeyStore";
import { AgentSpecSchema } from "../policy/agentSpec";
import type { OnboardingRunner } from "../workflow/runner";

export interface McpToolDeps {
  repo: EntityRepository;
  runner: OnboardingRunner;
  passkeys: PasskeyStore;
}

/** Build a fresh, tenant-scoped MCP server. tenantId is closed over — never taken from a tool arg. */
export function buildMcpServer(tenantId: string, deps: McpToolDeps): McpServer {
  const { repo, runner } = deps;
  const server = new McpServer({ name: "project-alpha-brain", version: "1.0.0" });

  server.registerTool(
    "whoami",
    { title: "Who am I", description: "Return the authenticated tenant address." },
    async () => ({ content: [{ type: "text", text: tenantId }] }),
  );

  server.registerResource(
    "agent-spec",
    "schema://agent-spec",
    {
      title: "AgentSpec schema",
      description: "JSON-schema for onboard_agent's spec argument",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(zodToJsonSchema(AgentSpecSchema)),
        },
      ],
    }),
  );

  server.registerTool(
    "list_entities",
    { title: "List entities", description: "List the caller's agent legal bodies." },
    async () => {
      const views = repo.listByTenant(tenantId).map(toEntityView);
      return { content: [{ type: "text", text: JSON.stringify(views) }] };
    },
  );

  server.registerTool(
    "get_entity",
    {
      title: "Get entity",
      description: "Fetch one entity by id (idempotency key). Poll this after onboard_agent.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId)
        return { content: [{ type: "text", text: "entity not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(toEntityView(rec)) }] };
    },
  );

  server.registerTool(
    "fund_treasury",
    {
      title: "Fund treasury",
      description: "Fund a bound entity's treasury with atomic USDC (6 decimals).",
      inputSchema: { id: z.string(), amount: z.string() },
    },
    async ({ id, amount }) => {
      try {
        const { id: outId, status } = runner.fund({ id, tenantId, amount: BigInt(amount) });
        return { content: [{ type: "text", text: JSON.stringify({ id: outId, status }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    },
  );

  server.registerTool(
    "onboard_agent",
    {
      title: "Onboard agent",
      description:
        "Create an agent legal body. spec must match schema://agent-spec; the guardian is set " +
        "automatically to your tenant. passkeyId references a previously stored guardian passkey " +
        "(POST /passkey). Returns immediately with status 'pending' — poll get_entity until 'bound'.",
      inputSchema: {
        spec: z.record(z.unknown()),
        passkeyId: z.string(),
        idempotencyKey: z.string().optional(),
      },
    },
    async ({ spec, passkeyId, idempotencyKey }) => {
      const passkey = deps.passkeys.get(tenantId, passkeyId);
      if (!passkey)
        return { content: [{ type: "text", text: "passkey handle not found" }], isError: true };
      try {
        const raw = spec as Record<string, unknown>;
        const roles = { ...((raw.roles as object) ?? {}), guardian: tenantId };
        const parsed = AgentSpecSchema.parse({ ...raw, roles });
        const userKey = idempotencyKey && idempotencyKey.length > 0 ? idempotencyKey : parsed.name;
        const { id, status } = deps.runner.start({
          spec: parsed,
          userKey,
          tenantId,
          guardianPasskey: passkey,
        });
        return { content: [{ type: "text", text: JSON.stringify({ id, status }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    },
  );

  return server;
}
