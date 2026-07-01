import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";

export function mountApiKeyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/api-keys", async (c) => {
    let body: { label?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const label = typeof body.label === "string" ? body.label : undefined;
    const { id, key } = deps.apiKeys.mint(c.get("tenantId"), { label });
    return c.json({ id, key, label: label ?? null }, 201);
  });

  app.get("/api-keys", (c) => c.json(deps.apiKeys.list(c.get("tenantId"))));

  app.delete("/api-keys/:id", (c) => {
    const ok = deps.apiKeys.revoke(c.get("tenantId"), c.req.param("id"));
    if (!ok) return c.json({ error: { code: "not_found", message: "api key not found" } }, 404);
    return c.body(null, 204);
  });
}
