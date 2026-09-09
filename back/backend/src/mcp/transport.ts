import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Hono } from "hono";
import type { ApiDeps } from "../api/app";
import type { AuthVars } from "../auth/middleware";
import { resolveKey } from "./auth";
import { MCP_TOOL_DEP_KEYS, type McpToolDeps, buildMcpServer } from "./server";

/**
 * The MCP slice of the composition root's ONE dependency object — COPIED, never picked by hand.
 *
 * This was a hand-written object literal naming each field, and it dropped two of them without a
 * sound. First the document index: `get_entity` over MCP described an entity with no legal
 * documents while `GET /entities/:id` described the same entity with two, and nothing failed —
 * the agent surface was simply, silently, less true than the browser one. `EntityViewDeps` was
 * made one object to stop that, which stopped the object being PARTIAL but not this pick being a
 * SUBSET of it, so A3's `sharedWith` reached REST and not MCP the same way. Then `now`: the
 * injectable clock every REST surface honours, which the MCP tools could not be frozen for.
 *
 * A hand-written pick is a subset by default, and the field it omits is always the one added
 * last. The loop copies whatever `MCP_TOOL_DEP_KEYS` names, and that list is compile-checked
 * against `McpToolDeps` beside the interface itself — where a field is actually added.
 *
 * ⚠ `ens` is the ONE exception, and it is a narrowing rather than an omission: `ApiDeps["ens"]`
 * carries the gateway's SIGNING ACCOUNT, and `resolve_agent` needs four scalars off it. Copying
 * it whole would hand a private key to a layer that has no use for one, so it is constructed —
 * and the exhaustiveness check excludes it by name, so the decision is written down.
 */
export function mcpToolDepsOf(deps: ApiDeps): McpToolDeps {
  const out: Record<string, unknown> = {};
  for (const key of MCP_TOOL_DEP_KEYS) out[key] = deps[key];
  return {
    // The loop is index-typed, so the cast is where the key list's compile-time guarantee is
    // handed back to the type system — which is exactly what `MCP_TOOL_DEP_KEYS` exists to make
    // safe: it cannot omit a key without failing to compile beside the interface.
    ...(out as unknown as McpToolDeps),
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
  };
}

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

    const server = buildMcpServer(scope, mcpToolDepsOf(deps));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);

    return transport.handleRequest(c.req.raw);
  });
}
