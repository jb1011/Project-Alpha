import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import type { ApiDeps } from "../api/app";
import type { AuthVars } from "../auth/middleware";
import { resolveKey } from "./auth";
import { buildMcpServer } from "./server";

/** Mount the stateless Streamable-HTTP MCP endpoint. A fresh server+transport per request,
 *  closing over the authenticated key scope (tenantId + entityId + capability).
 *
 *  Uses the SDK's web-standard transport (`handleRequest(Request): Promise<Response>`) so the
 *  Hono handler stays fully fetch-based (`c.req.raw` in, `Response` out) — no raw Node req/res
 *  and no `RESPONSE_ALREADY_SENT` sentinel. This avoids the Node-transport's internal dependency
 *  on its own (v1) copy of `@hono/node-server`, which double-writes the response under our v2
 *  adaptor (ERR_HTTP_HEADERS_SENT). See task-5-report.md. */
export function mountMcpRoute(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.all("/mcp", async (c) => {
    const scope = resolveKey(c.req.header("authorization"), deps.apiKeys);
    if (!scope) return c.json({ error: { code: "unauthorized", message: "invalid api key" } }, 401);

    const server = buildMcpServer(scope, {
      repo: deps.repo,
      runner: deps.runner,
      passkeys: deps.passkeys,
      walletProviderDefault: deps.walletProviderDefault,
      circleCustodyAvailable: deps.circleCustodyAvailable,
      turnkeyCustodyAvailable: deps.turnkeyCustodyAvailable,
      platformManagerAddress: deps.platformManagerAddress,
      jobs: deps.jobs,
      payments: deps.payments,
      pocketFunding: deps.pocketFunding,
      jobRunner: deps.jobRunner,
      jobClientAddress: deps.jobClientAddress,
      jobEvaluatorAddress: deps.jobEvaluatorAddress,
      maxJobBudget: deps.maxJobBudget,
      maxInflightJobsPerTenant: deps.maxInflightJobsPerTenant,
      linkCodes: deps.linkCodes,
      arc: deps.arc,
      worldId: deps.worldId,
      formation: deps.formation,
      // The view dependencies, taken from the SAME object the REST routes read (C8). This line
      // used to name them one by one and forgot the document index, so `get_entity` over MCP
      // described an entity with no legal documents while REST described the same entity with
      // two. `EntityViewDeps` is now inherited by both dep types, so the pick cannot be partial.
      formationSteps: deps.formationSteps,
      documents: deps.documents,
      ens: deps.ens
        ? {
            parentName: deps.ens.parentName,
            identityRegistry: deps.ens.identityRegistry,
            chainId: deps.ens.chainId,
            // Without this, resolve_agent cannot resolve a vanity name the CCIP gateway serves
            // happily — e.g. demo.novicorpus.eth resolved over ENS but was "unknown agent" here.
            labelAliases: deps.ens.labelAliases,
          }
        : undefined,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);

    return transport.handleRequest(c.req.raw);
  });
}
