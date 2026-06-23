import { Hono } from "hono";
import type { GuardianPasskey } from "../adapters/turnkey/provisioner";
import type { AgentSpec } from "../policy/agentSpec";
import type { EntityRecord } from "../types";

/**
 * Injected dependencies for the onboarding HTTP app. The test supplies a fake `runOnboarding`;
 * the live composition root wires the real saga (provision + signerForEntity from Tasks 3/4/5).
 *
 * real wiring: see composition root
 *   cfg → buildTurnkeyProvisionDeps(cfg) → provisionAgentVault(deps, params)
 *   cfg → TurnkeySigner.forEntity(cfg, entity)
 *   runOnboarding = (spec, passkey, idempotencyKey) => onboarding.runOnboarding({ spec, guardianPasskey: passkey, provision, signerForEntity, ... })
 */
export interface OnboardingAppDeps {
  /**
   * Drive the full onboarding saga for a given spec + guardian passkey + idempotency key.
   * Returns the persisted EntityRecord on success (must carry turnkeySubOrgId + turnkeyWalletId
   * when a guardianPasskey was provided).
   */
  runOnboarding: (
    spec: AgentSpec,
    guardianPasskey: GuardianPasskey,
    idempotencyKey: string,
  ) => Promise<EntityRecord>;
}

/**
 * The onboarding wizard's HTTP face: a single `POST /onboard` route. The frontend posts the
 * guardian's WebAuthn attestation + agent spec here; the route drives the provisioning saga and
 * returns the vault ids. Thin by design — all logic lives in the injected runOnboarding.
 *
 * Success  200  { subOrgId, walletId, operator, status }
 * Validation error  400  { error }
 * Saga / provision error  502  { error }
 */
export function buildOnboardingApp(deps: OnboardingAppDeps) {
  const app = new Hono();

  app.post("/onboard", async (c) => {
    let body: { spec?: unknown; guardianPasskey?: unknown; idempotencyKey?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    if (!body.spec || typeof body.spec !== "object") {
      return c.json({ error: "missing or invalid field: spec" }, 400);
    }
    if (!body.guardianPasskey || typeof body.guardianPasskey !== "object") {
      return c.json({ error: "missing or invalid field: guardianPasskey" }, 400);
    }

    const spec = body.spec as AgentSpec;
    const passkey = body.guardianPasskey as GuardianPasskey;
    const hasPasskey = true; // guardianPasskey was present in request (validated above)

    // idempotencyKey: caller-supplied or defaults to spec.name
    const idempotencyKey =
      typeof body.idempotencyKey === "string" && body.idempotencyKey
        ? body.idempotencyKey
        : spec.name;

    let record: EntityRecord;
    try {
      record = await deps.runOnboarding(spec, passkey, idempotencyKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: `provisioning failed: ${message}` }, 502);
    }

    // Route guard: when a guardianPasskey was sent, the saga MUST have produced vault ids.
    // If either is missing, provisioning did not complete — surface as 502 rather than a
    // silent success with null vault ids.
    if (hasPasskey && (!record.turnkeySubOrgId || !record.turnkeyWalletId)) {
      return c.json({ error: "provisioning did not complete" }, 502);
    }

    return c.json(
      {
        subOrgId: record.turnkeySubOrgId ?? null,
        walletId: record.turnkeyWalletId ?? null,
        operator: record.operator,
        status: record.status,
      },
      200,
    );
  });

  return app;
}
