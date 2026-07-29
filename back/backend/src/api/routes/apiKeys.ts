import type { Hono } from "hono";
import { z } from "zod";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";

const BodySchema = z.object({
  label: z.string().optional(),
  capability: z.enum(["read", "earn", "spend", "provision"]).default("spend"),
});

export function mountApiKeyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/api-keys", async (c) => {
    let raw: unknown = {};
    try {
      raw = await c.req.json();
    } catch {
      raw = {};
    }
    const { label, capability } = BodySchema.parse(raw);
    const { id, key } = deps.apiKeys.mint(c.get("tenantId"), { label, capability });
    return c.json({ id, key, label: label ?? null, capability }, 201);
  });

  app.get("/api-keys", (c) => c.json(deps.apiKeys.list(c.get("tenantId"))));

  app.delete("/api-keys/:id", (c) => {
    const ok = deps.apiKeys.revoke(c.get("tenantId"), c.req.param("id"));
    if (!ok) return c.json({ error: { code: "not_found", message: "api key not found" } }, 404);
    return c.body(null, 204);
  });
}
