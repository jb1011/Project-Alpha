import type { Hono } from "hono";
import { z } from "zod";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const Body = z.object({
  /** null clears the override -> the entity inherits the platform default again. */
  trustPolicy: z.enum(["open", "verified-sellers-only", "verified-legal-bodies-only"]).nullable(),
});

/**
 * Edit the per-entity buyer trust dial (docs/design/2026-08-01-v25-batch1.md item 1).
 *
 * DELIBERATELY session-only (mirrors per-tx-cap): the trust posture is a guardian/governance
 * decision, so there is NO MCP tool for it — an agent must never be able to loosen its own
 * strictness through an API key it holds.
 */
export function mountTrustPolicyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.patch("/entities/:id/trust-policy", async (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    const { trustPolicy } = Body.parse(await c.req.json());
    deps.repo.upsert({ ...rec, trustPolicy });
    return c.json({ trustPolicy });
  });
}
