import type { Hono } from "hono";
import { getAddress } from "viem";
import type { GuardianPasskey } from "../../adapters/turnkey/provisioner";
import type { AuthVars } from "../../auth/middleware";
import { custodyUnavailableMessage } from "../../custody";
import {
  companyNamesRequiredMessage,
  createFormationParty,
  formationDoorRefusal,
  formationUnavailableMessage,
  truncateTenant,
} from "../../formation";
import { createCompany, updateCompanyIntake } from "../../formation/company";
import { deriveFormationStatus, hasLivePayment } from "../../formation/status";
import { opsLog } from "../../observability/opsLog";
import { AgentSpecSchema, FormationPartySchema } from "../../policy/agentSpec";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";
import { listCompanyViews, toEntityView, toEntityViews } from "../views";
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
      companyId?: unknown;
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
    if (body.companyId !== undefined && typeof body.companyId !== "string")
      throw new ApiError("validation_error", 400, "companyId must be a string");
    const partyId = body.partyId as string | undefined;
    const companyId = body.companyId as string | undefined;
    const formationRefusal = formationDoorRefusal(deps, { tenantId, partyId, companyId });
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
      companyId,
    });
    return c.json({ id, status }, 202);
  });

  /**
   * COMPANIES (design 2026-08-26 §7) — the legal body an agent is filed under.
   *
   * `POST /companies` is where the money is spent, so it carries the whole gate: the World-ID
   * personhood check, the per-tenant quota, the platform daily ceiling, the synthetic-PII
   * refusals and the party bind. All of it lives in `createCompany`, which MCP's `create_company`
   * and the A1 onboard shim call too — one function, so the three doors cannot disagree about
   * what a company costs.
   *
   * It takes the PRODUCTION intake (§5): three ranked name candidates, the company's own
   * business purpose, an industry from the shipped reference list — and, on a production
   * deployment only, the responsible party's SSN. Everything is validated inside
   * `createCompany`, so the two doors refuse the same things in the same words; this handler
   * only decides what is a well-formed HTTP body.
   *
   * **This is the ONLY door that takes an SSN** (§4.1), and it takes it on THIS request because
   * the AAD it is encrypted under is `party_id || company_id` — the company id does not exist
   * until the create mints it. Never echoed back, never logged, never in a view.
   */
  app.post("/companies", async (c) => {
    const tenantId = c.get("tenantId");
    if (!deps.formation) throw new ApiError("unavailable", 503, formationUnavailableMessage());

    let body: {
      partyId?: unknown;
      names?: unknown;
      businessPurpose?: unknown;
      industryLabel?: unknown;
      ssn?: unknown;
      synthetic?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (typeof body.partyId !== "string" || !body.partyId)
      throw new ApiError("validation_error", 400, "partyId is required");
    // TYPE checks only — the CONTENT rules (length, charset, restricted words, duplicates, the
    // industry list, the SSN format) all live in `createCompany`, where MCP meets them too.
    if (body.names !== undefined && !Array.isArray(body.names))
      throw new ApiError("validation_error", 400, companyNamesRequiredMessage());
    for (const [field, value] of [
      ["businessPurpose", body.businessPurpose],
      ["industryLabel", body.industryLabel],
      ["ssn", body.ssn],
    ] as const)
      if (value !== undefined && typeof value !== "string")
        throw new ApiError("validation_error", 400, `${field} must be a string`);

    const result = createCompany(
      // The composition root's ONE dependency set; this door supplies only its transaction.
      { ...deps.formation.companyDeps, transaction: (fn) => deps.repo.transaction(fn) },
      tenantId,
      {
        partyId: body.partyId,
        names: body.names as string[] | undefined,
        businessPurpose: body.businessPurpose as string | undefined,
        industryLabel: body.industryLabel as string | undefined,
        ssn: body.ssn as string | undefined,
        synthetic: body.synthetic === true ? true : undefined,
      },
    );
    if ("error" in result) throw new ApiError("validation_error", 400, result.error);
    // The companyId and nothing else. Echoing the intake back would put the SSN in a response
    // body, in any client that persists responses, and in any proxy log along the way.
    return c.json({ companyId: result.companyId }, 201);
  });

  /**
   * EDIT-AND-RETRY (design §4.7) — re-open a frozen intake, with a fresh SSN capture.
   *
   * REST only, and for the same reason `POST /companies` is: this is the door that may carry an
   * SSN, and an SSN never travels as an MCP tool argument. There is no MCP twin, deliberately.
   *
   * The freeze itself is a property of the ROW (`companies.updateIntake`'s WHERE clause), not of
   * this handler: three surfaces can reach a company, and a route-level check is a check one more
   * door can forget. This handler decides only what is a well-formed HTTP body.
   */
  app.patch("/companies/:companyId", async (c) => {
    const tenantId = c.get("tenantId");
    if (!deps.formation) throw new ApiError("unavailable", 503, formationUnavailableMessage());

    let body: {
      names?: unknown;
      businessPurpose?: unknown;
      industryLabel?: unknown;
      ssn?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (body.names !== undefined && !Array.isArray(body.names))
      throw new ApiError("validation_error", 400, companyNamesRequiredMessage());
    for (const [field, value] of [
      ["businessPurpose", body.businessPurpose],
      ["industryLabel", body.industryLabel],
      ["ssn", body.ssn],
    ] as const)
      if (value !== undefined && typeof value !== "string")
        throw new ApiError("validation_error", 400, `${field} must be a string`);

    const result = updateCompanyIntake(
      { ...deps.formation.companyDeps, transaction: (fn) => deps.repo.transaction(fn) },
      tenantId,
      c.req.param("companyId"),
      {
        names: body.names as string[] | undefined,
        businessPurpose: body.businessPurpose as string | undefined,
        industryLabel: body.industryLabel as string | undefined,
        ssn: body.ssn as string | undefined,
      },
    );
    if ("error" in result) throw new ApiError("validation_error", 400, result.error);
    // The id and nothing else — the same rule the create follows, for the same reason.
    return c.json({ companyId: result.companyId });
  });

  /**
   * The tenant's companies, NEWEST FIRST.
   *
   * The ordering is an API-level contract shared with MCP `list_companies` and with the wizard's
   * reuse picker, whose default is the last-used company: two renderers sorting for themselves is
   * how a picker ends up disagreeing with the list behind it.
   *
   * NO PII, exactly as everywhere else: the responsible party is not projected here, and neither
   * is the filed party's name. The company's own name candidates are not personal data.
   */
  app.get("/companies", (c) => {
    const tenantId = c.get("tenantId");
    if (!deps.companies) return c.json({ companies: [] });
    // ONE projection, shared with MCP `list_companies`, in four queries however long the page is.
    return c.json({
      companies: listCompanyViews({ ...deps, companies: deps.companies }, tenantId),
    });
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

  // The batched projection: one formation-steps read and one documents read for the whole page,
  // instead of two per entity (M5).
  app.get("/entities", (c) =>
    c.json(toEntityViews(deps.repo.listByTenant(c.get("tenantId")), deps)),
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
