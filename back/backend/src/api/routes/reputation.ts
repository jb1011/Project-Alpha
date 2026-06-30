import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

/** The agent's track record: a local aggregate of its ERC-8183 jobs (the registry has no on-chain read). */
export function mountReputationRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/entities/:id/reputation", (c) => {
    const id = c.req.param("id");
    const rec = deps.repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    const jobs = deps.jobs.listByEntity(id).filter((j) => j.ownerTenantId === c.get("tenantId"));
    const totalJobs = jobs.length;
    const reputed = jobs.filter((j) => j.status === "reputed").length;
    const completed = jobs.filter((j) => j.status === "completed" || j.status === "reputed").length;
    return c.json({ reputation: { totalJobs, completed, reputed } });
  });
}
