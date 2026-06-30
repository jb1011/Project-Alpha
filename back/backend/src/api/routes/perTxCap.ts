import type { Hono } from "hono";
import { z } from "zod";
import type { AuthVars } from "../../auth/middleware";
import { usdToUnits } from "../../policy/units";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const Body = z.object({
  perTxCapUsdc: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/)
    .refine((v) => Number(v) > 0, "perTxCapUsdc must be greater than 0 (use null to clear)")
    .nullable(),
});

/** Edit the off-chain per-transaction cap (instant; no timelock). Tenant-scoped. */
export function mountPerTxCapRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.patch("/entities/:id/per-tx-cap", async (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    const { perTxCapUsdc } = Body.parse(await c.req.json());
    const perTxCap = perTxCapUsdc === null ? null : usdToUnits(perTxCapUsdc);
    deps.repo.upsert({ ...rec, perTxCap });
    return c.json({ perTxCap: perTxCap === null ? null : perTxCap.toString() });
  });
}
