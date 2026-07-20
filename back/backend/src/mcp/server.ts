import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { toJobView } from "../api/jobViews";
import { toEntityView } from "../api/views";
import type { JobRepository } from "../jobs/jobRepository";
import type { JobRunner } from "../jobs/jobRunner";
import type { EntityPaymentService } from "../payments/entityPayment";
import type { PocketFundingFn } from "../payments/pocketFunding";
import type { VerifiedKey } from "../persistence/apiKeyStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type { PasskeyStore } from "../persistence/passkeyStore";
import { AgentSpecSchema } from "../policy/agentSpec";
import { usdToUnits } from "../policy/units";
import type { OnboardingRunner } from "../workflow/runner";
import { entityInScope, hasCapability } from "./scope";

export interface McpToolDeps {
  repo: EntityRepository;
  runner: OnboardingRunner;
  passkeys: PasskeyStore;
  /** Audit fix C: the platform/manager account address, force-set into `roles.manager` on
   *  onboard_agent so an agent-first caller never needs to know or guess it. */
  platformManagerAddress: string;
  jobs: JobRepository;
  payments?: EntityPaymentService;
  /** Explicit treasury->pocket Gateway top-up (fund_pocket). Optional — mirrors `payments`:
   *  deployments without POCKET_MASTER_SEED/Turnkey configured leave this undefined and the tool
   *  reports "pocket funding unavailable" instead of the server failing to boot. */
  pocketFunding?: PocketFundingFn;
  jobRunner: JobRunner;
  jobClientAddress: string;
  jobEvaluatorAddress: string;
  /** Audit fix A: caps on run_job to stop an earn-capability agent from draining the platform's
   *  job-funding wallet via a loop of large-budget or many-in-flight jobs. */
  maxJobBudget: bigint;
  maxInflightJobsPerTenant: number;
  linkCodes: import("../persistence/linkCodeStore").LinkCodeStore;
}

/** Build a fresh, tenant-scoped MCP server. scope is closed over — never taken from a tool arg. */
export function buildMcpServer(scope: VerifiedKey, deps: McpToolDeps): McpServer {
  // The ACTING tools (fund_treasury/onboard_agent) enforce capability + entity scope, on top of the
  // tenant isolation shared by every tool below: fund_treasury requires "provision" capability and
  // `entityInScope`; onboard_agent requires "provision" capability AND a tenant-wide key (entityId ===
  // null), since it creates a new entity rather than acting on an existing one. "provision" is the top
  // rung of the capability ladder (read < earn < spend < provision) — these two tools move PLATFORM
  // funds / provision platform resources, a strictly higher privilege than "spend" (which only moves an
  // entity's own treasury funds). See back/docs/design/2026-07-20-s1-fund-treasury-authorization.md.
  // The read tools (get_job/list_jobs) enforce entityInScope. The P2a prerequisite (gate the acting
  // tools before the mint surface issues scoped keys) is resolved. See
  // back/docs/plans/2026-07-02-byoa-p2a-scope-and-reads.md.
  const tenantId = scope.tenantId;
  const { repo, runner } = deps;
  const server = new McpServer({ name: "project-alpha-brain", version: "1.0.0" });

  server.registerTool(
    "whoami",
    { title: "Who am I", description: "Return the authenticated tenant address." },
    async () => ({ content: [{ type: "text", text: tenantId }] }),
  );

  server.registerTool(
    "claim_connection",
    {
      title: "Claim connection",
      description:
        "Confirm this agent was intentionally linked to your legal body: submit the one-time link code from " +
        "the bootstrap page. Returns your tenant + entities (a binding confirmation, not a key).",
      inputSchema: { linkCode: z.string() },
    },
    async ({ linkCode }) => {
      // No capability gate: the tenant-scoped single-use consume IS the gate (a wrong-tenant
      // attempt fails uniformly and never burns the owner's code).
      if (!deps.linkCodes.consume(scope.tenantId, linkCode, Date.now()))
        return { content: [{ type: "text", text: "invalid or expired link code" }], isError: true };
      const entities = repo.listByTenant(scope.tenantId).map(toEntityView);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ tenantId: scope.tenantId, entities, bound: true }),
          },
        ],
      };
    },
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
      const views = repo
        .listByTenant(tenantId)
        .filter((e) => entityInScope(scope, e.idempotencyKey)) // an entity-scoped key lists only its entity
        .map(toEntityView);
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
      if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
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
      // Decimal integers only — rejects hex ("0x10"), whitespace (" 100 "), exponential ("1e6"),
      // and decimals ("1.5") that BigInt() would otherwise silently accept. A leading "-" is still
      // allowed through so a negative amount reaches the <= 0n check below and gets the more
      // specific "must be positive" message rather than a generic format error.
      if (!/^-?\d+$/.test(amountUsdc))
        return { content: [{ type: "text", text: "invalid amountUsdc" }], isError: true };
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
    "fund_pocket",
    {
      title: "Fund pocket",
      description:
        "Top up your treasury's spending float (treasury -> operator -> pocket -> Gateway) so " +
        "`pay` can settle. Explicit only — never auto-triggered by pay. Costs on-chain gas + " +
        "Turnkey signatures. amountUsdc is atomic USDC (6 decimals).",
      inputSchema: { id: z.string(), amountUsdc: z.string() },
    },
    async ({ id, amountUsdc }) => {
      if (!hasCapability(scope, "spend"))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      // Same decimal-integer + positive validation as `pay` (atomic USDC, 6 decimals).
      if (!/^-?\d+$/.test(amountUsdc))
        return { content: [{ type: "text", text: "invalid amountUsdc" }], isError: true };
      let amount: bigint;
      try {
        amount = BigInt(amountUsdc);
      } catch {
        return { content: [{ type: "text", text: "invalid amountUsdc" }], isError: true };
      }
      if (amount <= 0n)
        return { content: [{ type: "text", text: "amountUsdc must be positive" }], isError: true };
      if (!deps.pocketFunding)
        return { content: [{ type: "text", text: "pocket funding unavailable" }], isError: true };
      try {
        const txHashes = await deps.pocketFunding(rec, amount);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, txHashes }) }] };
      } catch (e) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: false, reason: (e as Error).message }) },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "run_job",
    {
      title: "Run job",
      description:
        "Have your agent earn USDC + reputation by running an ERC-8183 job (self-contained v1: the platform " +
        "stands in for the client + evaluator). Returns immediately with status 'pending'; poll get_job(jobKey).",
      inputSchema: { id: z.string(), budgetUsdc: z.string().optional() },
    },
    async ({ id, budgetUsdc }) => {
      if (!hasCapability(scope, "earn"))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      const raw = budgetUsdc ?? "1.00";
      // At most 6 decimals (USDC precision): rejecting here keeps the error message uniform instead of
      // letting usdToUnits throw a different one deeper in.
      if (!/^\d+(\.\d{1,6})?$/.test(raw))
        return { content: [{ type: "text", text: "invalid budgetUsdc" }], isError: true };
      const budget = usdToUnits(raw);
      if (budget <= 0n)
        return { content: [{ type: "text", text: "budgetUsdc must be positive" }], isError: true };
      // Audit fix A: escrow is funded from the platform wallet (JOB_CLIENT_PRIVATE_KEY) and swept to
      // the caller's treasury — without these caps a loop of big-budget jobs drains platform USDC.
      if (budget > deps.maxJobBudget)
        return {
          content: [{ type: "text", text: "budgetUsdc exceeds the max job budget" }],
          isError: true,
        };
      const inflight = deps.jobs
        .listByTenant(tenantId)
        .filter((j) => !["completed", "reputed", "failed"].includes(j.status)).length;
      if (inflight >= deps.maxInflightJobsPerTenant)
        return {
          content: [{ type: "text", text: "too many jobs in flight, try again later" }],
          isError: true,
        };
      const jobKey = `${rec.idempotencyKey}:${Date.now()}-${randomUUID().slice(0, 8)}`;
      const { status } = deps.jobRunner.start({
        jobKey,
        entityKey: rec.idempotencyKey,
        tenantId,
        budget,
        description: "agent job (mcp)",
        clientAddress: deps.jobClientAddress,
        evaluatorAddress: deps.jobEvaluatorAddress,
        providerAddress: rec.operator ?? "0x",
      });
      return { content: [{ type: "text", text: JSON.stringify({ jobKey, status }) }] };
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
      description:
        "Fund a bound entity's treasury with atomic USDC (6 decimals), from the PLATFORM wallet. " +
        "Requires the provision capability.",
      inputSchema: { id: z.string(), amount: z.string() },
    },
    async ({ id, amount }) => {
      if (!hasCapability(scope, "provision"))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      if (!entityInScope(scope, id))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      // Same decimal-integer + positive validation as `pay`/`fund_pocket` (atomic USDC, 6 decimals).
      // Rejects hex ("0x10") and a negative amount before it ever reaches runner.fund.
      if (!/^-?\d+$/.test(amount))
        return { content: [{ type: "text", text: "invalid amount" }], isError: true };
      let parsedAmount: bigint;
      try {
        parsedAmount = BigInt(amount);
      } catch {
        return { content: [{ type: "text", text: "invalid amount" }], isError: true };
      }
      if (parsedAmount <= 0n)
        return { content: [{ type: "text", text: "amount must be positive" }], isError: true };
      try {
        const { id: outId, status } = runner.fund({ id, tenantId, amount: parsedAmount });
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
        "automatically to your tenant and the manager is set automatically to the platform " +
        "manager account — you don't need to know or supply either. passkeyId references a " +
        "previously stored guardian passkey (POST /passkey). Returns immediately with status " +
        "'pending' — poll get_entity until 'bound'. Requires the provision capability and a " +
        "tenant-wide key.",
      inputSchema: {
        spec: z.record(z.unknown()),
        passkeyId: z.string(),
        idempotencyKey: z.string().optional(),
      },
    },
    async ({ spec, passkeyId, idempotencyKey }) => {
      if (!hasCapability(scope, "provision") || scope.entityId !== null)
        return { content: [{ type: "text", text: "not authorized" }], isError: true };
      const passkey = deps.passkeys.get(tenantId, passkeyId);
      if (!passkey)
        return { content: [{ type: "text", text: "passkey handle not found" }], isError: true };
      try {
        const raw = spec as Record<string, unknown>;
        const roles = {
          ...((raw.roles as object) ?? {}),
          guardian: tenantId,
          manager: deps.platformManagerAddress,
        };
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
