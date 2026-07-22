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
    const zero = "0";

    // T6 added the Gateway (standingExposure) + on-chain legalStatus reads below. A Gateway/API
    // outage or RPC hiccup on either must not 500 the whole panel — the core RPC fields (balance/
    // available/paused, polled every 5s by the dashboard) still return with 200. Degrade each
    // independently to null ("unknown", rendered as "—" by the dashboard) rather than faking a
    // zero or an Active/Suspended status.
    const standingExposure = deps.standingExposure;
    const standingPromise: Promise<{
      operatorEoa: string;
      pocketEoa: string;
      gateway: string;
      total: string;
      ceiling: string;
    } | null> = standingExposure
      ? standingExposure
          .read(rec)
          .then((exposure) => ({
            operatorEoa: exposure.operatorEoa.toString(),
            pocketEoa: exposure.pocketEoa.toString(),
            gateway: exposure.gateway.toString(),
            total: exposure.total.toString(),
            ceiling: standingExposure.ceilingAtomic,
          }))
          .catch(() => null)
      : Promise.resolve({
          operatorEoa: zero,
          pocketEoa: zero,
          gateway: zero,
          total: zero,
          ceiling: zero,
        });

    const legalActivePromise: Promise<boolean | null> = deps.arc
      // entity.proxy is non-null whenever entity.treasury is non-null (both set together at
      // onboarding step 4, guarded above) — same read as entityPayment.ts's readTreasury closure.
      .legalStatus(rec.proxy as Address)
      .then((legalStatus) => legalStatus === 0)
      .catch(() => null);

    const [usdcBalance, available, paused, standing, legalActive] = await Promise.all([
      deps.arc.usdcBalanceOf(usdc, treasury),
      deps.arc.treasuryAvailable(treasury),
      deps.arc.treasuryPaused(treasury),
      standingPromise,
      legalActivePromise,
    ]);

    return c.json({
      usdcBalance: usdcBalance.toString(),
      available: available.toString(),
      cap: rec.treasuryConfig.cap.toString(),
      period: rec.treasuryConfig.period.toString(),
      paused,
      standing,
      legalActive,
    });
  });
}
