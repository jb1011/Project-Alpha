import type { Hono } from "hono";
import { getAddress } from "viem";
import type { GuardianPasskey } from "../../adapters/turnkey/provisioner";
import type { AuthVars } from "../../auth/middleware";
import { custodyUnavailableMessage } from "../../custody";
import {
  createFormationParty,
  formationDoorRefusal,
  formationUnavailableMessage,
  truncateTenant,
} from "../../formation";
import { opsLog } from "../../observability/opsLog";
import { AgentSpecSchema, FormationPartySchema } from "../../policy/agentSpec";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";
import { toEntityView } from "../views";
import { assertGuardianAllowed } from "./worldId";

export function mountProtectedRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/onboard", async (c) => {
    const tenantId = c.get("tenantId");
    let body: {
      spec?: unknown;
      guardianPasskey?: unknown;
      idempotencyKey?: unknown;
      custody?: unknown;
      partyId?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (!body.guardianPasskey || typeof body.guardianPasskey !== "object")
      throw new ApiError("validation_error", 400, "guardianPasskey is required");

    // Tier-0 custody choice: optional; absent -> the platform default (turnkey until P4). A
    // circle request on a deployment without Circle provisioning is refused HERE, before any
    // claim — the saga would only fail it asynchronously.
    if (body.custody !== undefined && body.custody !== "turnkey" && body.custody !== "circle")
      throw new ApiError("validation_error", 400, 'custody must be "turnkey" or "circle"');
    const custody = (body.custody ?? deps.walletProviderDefault) as "turnkey" | "circle";
    if (custody === "circle" && !deps.circleCustodyAvailable)
      throw new ApiError("validation_error", 400, custodyUnavailableMessage("circle"));
    if (custody === "turnkey" && !deps.turnkeyCustodyAvailable)
      throw new ApiError("validation_error", 400, custodyUnavailableMessage("turnkey"));

    // Formation gate (design §2/§5): AFTER custody, BEFORE the World gate. The order is mirrored
    // exactly by the MCP onboard_agent tool, and the checks themselves live in ONE function so
    // the two surfaces cannot drift — see src/formation.ts. Everything it refuses is refused
    // BEFORE the claim: formation is real money in production, and an entity must never be left
    // live with a mandatory formation that can never happen.
    if (body.partyId !== undefined && typeof body.partyId !== "string")
      throw new ApiError("validation_error", 400, "partyId must be a string");
    const partyId = body.partyId as string | undefined;
    const formationRefusal = formationDoorRefusal(deps, { tenantId, partyId });
    if (formationRefusal) throw new ApiError("validation_error", 400, formationRefusal);

    // Proof-of-personhood gate: the guardian is the legally accountable natural person, so when
    // enforcement is on they must be a World-ID-verified unique human under the per-human cap.
    // No-op when World isn't configured / WORLD_REQUIRE_GUARDIAN is false.
    assertGuardianAllowed(deps.worldId, tenantId);

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
      custody,
      partyId,
    });
    return c.json({ id, status }, 202);
  });

  /**
   * PII intake (design §3/§5). The ONE place a legal identity enters the system.
   *
   * It is a separate call, not a field on /onboard, because PII must never ride in `spec`
   * (spec_json is persisted and rendered) and must never travel as an MCP tool argument in the
   * same shape as the agent's public configuration. The caller gets back an opaque handle and
   * passes THAT to onboard.
   *
   * The response carries the partyId and nothing else — echoing the stored identity back would
   * put PII in a response body, a log, and any client that persists API responses.
   */
  app.post("/formation-party", async (c) => {
    const tenantId = c.get("tenantId");
    if (!deps.formation) throw new ApiError("unavailable", 503, formationUnavailableMessage());

    let body: { synthetic?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }

    // The synthetic shortcut carries no PII at all, so it is never parsed as a party body.
    const parsed = body.synthetic === true ? undefined : FormationPartySchema.parse(body); // ZodError -> 400
    const result = createFormationParty(
      { parties: deps.formation.parties, sandboxSyntheticPii: deps.formation.sandboxSyntheticPii },
      tenantId,
      { synthetic: body.synthetic, parsed },
    );
    if ("error" in result) throw new ApiError("validation_error", 400, result.error);

    // The ONLY trail this leaves: which tenant created which handle. No name, no address, no
    // email — not here, not in any view, not in the manifest.
    opsLog("formation_party_created", {
      tenantId: truncateTenant(tenantId),
      partyId: result.partyId,
    });
    return c.json({ partyId: result.partyId }, 201);
  });

  app.get("/entities", (c) =>
    c.json(deps.repo.listByTenant(c.get("tenantId")).map((r) => toEntityView(r, deps))),
  );

  app.get("/entities/:id", (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    return c.json(toEntityView(rec, deps));
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
