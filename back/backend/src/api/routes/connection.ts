import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AuthVars } from "../../auth/middleware";
import { buildSnippets } from "../../mcp/snippets";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const BodySchema = z.object({
  entityId: z.string().min(1),
  capability: z.enum(["read", "earn", "spend"]).default("spend"),
});

const BootstrapSchema = z.object({
  passkeyId: z.string().min(1),
  capability: z.enum(["read", "earn", "spend"]).default("spend"),
});

const LINK_CODE_TTL_MS = 15 * 60_000;

/** These responses carry live credentials — forbid caching and referrer leakage. */
function noStore(c: Context) {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
}

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
    noStore(c);
    return c.json({
      mcpUrl: deps.mcpPublicUrl,
      apiKey: key,
      entityId,
      capability,
      snippets: buildSnippets({ mcpUrl: deps.mcpPublicUrl, apiKey: key }),
    });
  });

  app.post("/bootstrap-connection", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    const { passkeyId, capability } = BootstrapSchema.parse(raw);
    const tenantId = c.get("tenantId");
    if (!deps.passkeys.get(tenantId, passkeyId))
      throw new ApiError("not_found", 404, "passkey not found"); // uniform (no exists-but-not-yours leak)
    const { key } = deps.apiKeys.mint(tenantId, {
      capability,
      label: `bootstrap:${passkeyId}`,
    }); // entityId omitted → tenant-wide
    const linkCode = deps.linkCodes.issue(tenantId, Date.now(), LINK_CODE_TTL_MS);
    noStore(c);
    return c.json({
      mcpUrl: deps.mcpPublicUrl,
      apiKey: key,
      passkeyId,
      capability,
      linkCode,
      snippets: buildSnippets({ mcpUrl: deps.mcpPublicUrl, apiKey: key }),
    });
  });
}
