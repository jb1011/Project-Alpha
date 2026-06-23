import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { usdToUnits } from "../../policy/units";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";
import { toJobView } from "../jobViews";

export function mountJobRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/entities/:id/jobs", async (c) => {
    const tenantId = c.get("tenantId");
    const entity = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!entity || entity.ownerTenantId !== tenantId)
      throw new ApiError("not_found", 404, "entity not found");
    let body: { budget?: unknown; description?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      /* empty body ok */
    }
    const budget = typeof body.budget === "string" ? usdToUnits(body.budget) : usdToUnits("1.00");
    const description = typeof body.description === "string" ? body.description : "demo job";
    const jobKey = `${entity.idempotencyKey}:${Date.now()}-${randomUUID().slice(0, 8)}`; // entity.idempotencyKey already = `${tenantId}:${userKey}`
    const { status } = deps.jobRunner.start({
      jobKey,
      entityKey: entity.idempotencyKey,
      tenantId,
      budget,
      description,
      clientAddress: deps.jobClientAddress,
      evaluatorAddress: deps.jobEvaluatorAddress,
      providerAddress: entity.operator ?? "0x",
    });
    return c.json({ jobKey, status }, 202);
  });
  app.get("/jobs/:jobKey", (c) => {
    const rec = deps.jobs.findByKey(c.req.param("jobKey"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "job not found");
    return c.json(toJobView(rec));
  });
  // `:id` is the full entityKey (`${tenantId}:${userKey}`), exactly as in GET /entities/:id.
  app.get("/entities/:id/jobs", (c) =>
    c.json(
      deps.jobs
        .listByEntity(c.req.param("id"))
        .filter((j) => j.ownerTenantId === c.get("tenantId"))
        .map(toJobView),
    ),
  );
}
