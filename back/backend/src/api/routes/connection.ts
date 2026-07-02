import type { Hono } from "hono";
import { z } from "zod";
import type { AuthVars } from "../../auth/middleware";
import { buildSnippets } from "../../mcp/snippets";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const BodySchema = z.object({
  entityId: z.string().min(1),
  capability: z.enum(["read", "earn", "spend"]).default("spend"),
});

export function mountConnectionRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/connection-package", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    const { entityId, capability } = BodySchema.parse(raw);
    const tenantId = c.get("tenantId");
    const ent = deps.repo.findByIdempotencyKey(entityId);
    if (!ent || ent.ownerTenantId !== tenantId)
      throw new ApiError("not_found", 404, "entity not found"); // uniform (no exists-but-not-yours leak)
    const { key } = deps.apiKeys.mint(tenantId, {
      entityId,
      capability,
      label: `connect:${entityId}`,
    });
    return c.json({
      mcpUrl: deps.mcpPublicUrl,
      apiKey: key,
      entityId,
      capability,
      snippets: buildSnippets({ mcpUrl: deps.mcpPublicUrl, apiKey: key }),
    });
  });
}
