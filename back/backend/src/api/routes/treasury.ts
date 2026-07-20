import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { Address } from "../../types";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

/** Real on-chain treasury state for the dashboard: actual USDC balance, available-vs-cap, paused. */
export function mountTreasuryRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/entities/:id/treasury", async (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    if (!rec.treasury || !rec.treasuryConfig)
      throw new ApiError("not_ready", 409, "treasury not deployed yet");

    const treasury = rec.treasury as Address;
    const usdc = rec.treasuryConfig.usdc;
    const [usdcBalance, available, paused, legalStatus, exposure] = await Promise.all([
      deps.arc.usdcBalanceOf(usdc, treasury),
      deps.arc.treasuryAvailable(treasury),
      deps.arc.treasuryPaused(treasury),
      // entity.proxy is non-null whenever entity.treasury is non-null (both set together at
      // onboarding step 4, guarded above) — same read as entityPayment.ts's readTreasury closure.
      deps.arc.legalStatus(rec.proxy as Address),
      deps.standingExposure ? deps.standingExposure.read(rec) : Promise.resolve(null),
    ]);
    const zero = "0";

    return c.json({
      usdcBalance: usdcBalance.toString(),
      available: available.toString(),
      cap: rec.treasuryConfig.cap.toString(),
      period: rec.treasuryConfig.period.toString(),
      paused,
      standing: exposure
        ? {
            operatorEoa: exposure.operatorEoa.toString(),
            pocketEoa: exposure.pocketEoa.toString(),
            gateway: exposure.gateway.toString(),
            total: exposure.total.toString(),
            ceiling: deps.standingExposure?.ceilingAtomic ?? zero,
          }
        : { operatorEoa: zero, pocketEoa: zero, gateway: zero, total: zero, ceiling: zero },
      legalActive: legalStatus === 0,
    });
  });
}
