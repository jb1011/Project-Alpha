import type { Hono } from "hono";
import { getAddress } from "viem";
import type { GuardianPasskey } from "../../adapters/turnkey/provisioner";
import type { AuthVars } from "../../auth/middleware";
import { AgentSpecSchema } from "../../policy/agentSpec";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";
import { toEntityView } from "../views";

export function mountProtectedRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/onboard", async (c) => {
    const tenantId = c.get("tenantId");
    let body: { spec?: unknown; guardianPasskey?: unknown; idempotencyKey?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (!body.guardianPasskey || typeof body.guardianPasskey !== "object")
      throw new ApiError("validation_error", 400, "guardianPasskey is required");

    // Server owns the guardian + manager: force guardian to the authenticated tenant and manager
    // to the platform manager address before validation (audit fix C — the caller can't discover
    // or misconfigure the on-chain manager, which must equal the wallet the saga signs txs as).
    const rawSpec = (body.spec ?? {}) as Record<string, unknown>;
    const roles = {
      ...((rawSpec.roles as object) ?? {}),
      guardian: tenantId,
      manager: deps.platformManagerAddress,
    };
    const spec = AgentSpecSchema.parse({ ...rawSpec, roles }); // throws ZodError → 400

    const userKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey
        ? body.idempotencyKey
        : spec.name;
    const { id, status } = deps.runner.start({
      spec,
      userKey,
      tenantId: getAddress(tenantId),
      guardianPasskey: body.guardianPasskey as GuardianPasskey,
    });
    return c.json({ id, status }, 202);
  });

  app.get("/entities", (c) => c.json(deps.repo.listByTenant(c.get("tenantId")).map(toEntityView)));

  app.get("/entities/:id", (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    return c.json(toEntityView(rec));
  });

  app.post("/entities/:id/fund", async (c) => {
    let body: { amount?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (typeof body.amount !== "string" && typeof body.amount !== "number")
      throw new ApiError("validation_error", 400, "amount (atomic USDC) is required");
    const { id, status } = deps.runner.fund({
      id: c.req.param("id"),
      tenantId: c.get("tenantId"),
      amount: BigInt(body.amount),
    });
    return c.json({ id, status }, 202);
  });

  app.post("/entities/:id/fund-pocket", async (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");

    let body: { amountUsdc?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (typeof body.amountUsdc !== "string" || !/^-?\d+$/.test(body.amountUsdc))
      throw new ApiError("validation_error", 400, "amountUsdc (atomic USDC integer) is required");
    const amount = BigInt(body.amountUsdc);
    if (amount <= 0n) throw new ApiError("validation_error", 400, "amountUsdc must be positive");

    if (!deps.pocketFunding) throw new ApiError("unavailable", 503, "pocket funding unavailable");
    try {
      const txHashes = await deps.pocketFunding(rec, amount);
      return c.json({ txHashes });
    } catch (e) {
      throw new ApiError("pocket_funding_failed", 502, (e as Error).message);
    }
  });
}
