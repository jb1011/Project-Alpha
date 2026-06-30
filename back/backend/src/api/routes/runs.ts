import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

/** The agent's real x402 commerce: a feed of per-run job receipts + their payments. */
export function mountRunsRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/entities/:id/runs", (c) => {
    const id = c.req.param("id");
    const rec = deps.repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    return c.json({ runs: deps.agentRuns.listByEntity(id) });
  });
}
