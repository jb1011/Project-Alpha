import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { toJobView } from "../api/jobViews";
import { toEntityView } from "../api/views";
import type { JobRepository } from "../jobs/jobRepository";
import type { EntityPaymentService } from "../payments/entityPayment";
import type { VerifiedKey } from "../persistence/apiKeyStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type { PasskeyStore } from "../persistence/passkeyStore";
import { AgentSpecSchema } from "../policy/agentSpec";
import type { OnboardingRunner } from "../workflow/runner";
import { entityInScope, hasCapability } from "./scope";

export interface McpToolDeps {
  repo: EntityRepository;
  runner: OnboardingRunner;
  passkeys: PasskeyStore;
  jobs: JobRepository;
  payments?: EntityPaymentService;
}

/** Build a fresh, tenant-scoped MCP server. scope is closed over — never taken from a tool arg. */
export function buildMcpServer(scope: VerifiedKey, deps: McpToolDeps): McpServer {
  // The ACTING tools (fund_treasury/onboard_agent) enforce capability + entity scope, on top of the
  // tenant isolation shared by every tool below: fund_treasury requires "spend" capability and
  // `entityInScope`; onboard_agent requires "spend" capability AND a tenant-wide key (entityId ===
  // null), since it creates a new entity rather than acting on an existing one. The read tools
  // (get_job/list_jobs) enforce entityInScope. The P2a prerequisite (gate the acting tools before the
  // mint surface issues scoped keys) is resolved. See
  // back/docs/plans/2026-07-02-byoa-p2a-scope-and-reads.md.
  const tenantId = scope.tenantId;
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
    "treasury_status",
    {
      title: "Treasury status",
      description: "Available balance, cap, paused, allowlist for one of your entities.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
        return { content: [{ type: "text", text: "entity not found" }], isError: true };
      if (!deps.payments)
        return { content: [{ type: "text", text: "payments unavailable" }], isError: true };
      const view = await deps.payments.status(rec);
      return { content: [{ type: "text", text: JSON.stringify(view) }] };
    },
  );

  server.registerTool(
    "pay",
    {
      title: "Pay",
      description:
        "Pay an x402 resource URL with USDC (atomic, 6 decimals), within your treasury's leash.",
      inputSchema: {
        id: z.string(),
        to: z.string(),
        amountUsdc: z.string(),
        idempotencyKey: z.string(),
      },
    },
    async ({ id, to, amountUsdc, idempotencyKey }) => {
      if (!hasCapability(scope, "spend"))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      let amount: bigint;
      try {
        amount = BigInt(amountUsdc);
      } catch {
        return { content: [{ type: "text", text: "invalid amountUsdc" }], isError: true };
      }
      if (amount <= 0n)
        return { content: [{ type: "text", text: "amountUsdc must be positive" }], isError: true };
      if (!deps.payments)
        return { content: [{ type: "text", text: "payments unavailable" }], isError: true };
      const receipt = await deps.payments.pay(rec, {
        url: to,
        amountUsdc: amount,
        idempotencyKey,
        tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], isError: !receipt.ok };
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description: "Fetch one job by jobKey (owned by you).",
      inputSchema: { jobKey: z.string() },
    },
    async ({ jobKey }) => {
      const rec = deps.jobs.findByKey(jobKey);
      if (!rec || rec.ownerTenantId !== scope.tenantId || !entityInScope(scope, rec.entityKey))
        return { content: [{ type: "text", text: "job not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(toJobView(rec)) }] };
    },
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List jobs",
      description: "List jobs for one of your entities (id = entity idempotency key).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      if (!entityInScope(scope, id))
        return {
          content: [{ type: "text", text: "entity not in this key's scope" }],
          isError: true,
        };
      const views = deps.jobs
        .listByEntity(id)
        .filter((j) => j.ownerTenantId === scope.tenantId)
        .map(toJobView);
      return { content: [{ type: "text", text: JSON.stringify(views) }] };
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
      if (!hasCapability(scope, "spend"))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      if (!entityInScope(scope, id))
        return { content: [{ type: "text", text: "not found" }], isError: true };
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
      if (!hasCapability(scope, "spend") || scope.entityId !== null)
        return { content: [{ type: "text", text: "not authorized" }], isError: true };
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
