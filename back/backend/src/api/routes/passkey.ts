import type { Hono } from "hono";
import { z } from "zod";
import { type AuthVars, requireAuth } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

export const GuardianPasskeySchema = z.object({
  authenticatorName: z.string().optional(),
  challenge: z.string().min(1),
  attestation: z.object({
    credentialId: z.string().min(1),
    clientDataJson: z.string().min(1),
    attestationObject: z.string().min(1),
    transports: z.array(z.string()),
  }),
});

/** Authed WebAuthn registration challenge issuance + authed, challenge-bound attestation storage (→ handle). */
export function mountPasskeyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/passkey/challenge", requireAuth(deps.jwtSecret), (c) => {
    const challenge = deps.challenges.issue(c.get("tenantId"), Date.now(), 10 * 60_000);
    return c.json({ challenge, rpId: deps.passkeyRpId });
  });

  app.post("/passkey", requireAuth(deps.jwtSecret), async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    const pk = GuardianPasskeySchema.parse(raw); // ZodError → 400 via apiOnError
    const tenantId = c.get("tenantId");
    if (!deps.challenges.consume(tenantId, pk.challenge, Date.now()))
      throw new ApiError("validation_error", 400, "unknown or expired passkey challenge");
    verifyClientData(pk.attestation.clientDataJson, pk.challenge, deps.passkeyRpId); // throws ApiError on mismatch
    const id = deps.passkeys.store(tenantId, pk);
    return c.json({ id }, 201);
  });

  app.get("/passkeys", requireAuth(deps.jwtSecret), (c) => {
    return c.json(deps.passkeys.list(c.get("tenantId")));
  });

  app.delete("/passkeys/:id", requireAuth(deps.jwtSecret), (c) => {
    if (!deps.passkeys.revoke(c.get("tenantId"), c.req.param("id")))
      throw new ApiError("not_found", 404, "passkey not found"); // uniform (no exists-but-not-yours leak)
    return c.body(null, 204);
  });
}

/** Defense-in-depth clientDataJSON check: type, bound challenge, and rpId-matching origin host. */
function verifyClientData(
  clientDataJsonB64: string,
  expectedChallenge: string,
  rpId: string,
): void {
  let cd: { type?: string; challenge?: string; origin?: string };
  try {
    cd = JSON.parse(Buffer.from(clientDataJsonB64, "base64url").toString("utf8"));
  } catch {
    throw new ApiError("validation_error", 400, "malformed clientDataJSON");
  }
  if (cd.type !== "webauthn.create")
    throw new ApiError("validation_error", 400, "clientDataJSON type must be webauthn.create");
  if (cd.challenge !== expectedChallenge)
    throw new ApiError("validation_error", 400, "clientDataJSON challenge mismatch");
  let host: string;
  try {
    host = new URL(cd.origin ?? "").hostname;
  } catch {
    throw new ApiError("validation_error", 400, "invalid clientDataJSON origin");
  }
  if (host !== rpId)
    throw new ApiError("validation_error", 400, "clientDataJSON origin does not match rpId");
}
