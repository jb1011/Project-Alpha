import { randomBytes } from "node:crypto";
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

/** Public WebAuthn registration challenge + authed attestation storage (→ handle). */
export function mountPasskeyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/passkey/challenge", (c) =>
    c.json({ challenge: randomBytes(32).toString("base64url"), rpId: deps.passkeyRpId }),
  );

  app.post("/passkey", requireAuth(deps.jwtSecret), async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    const pk = GuardianPasskeySchema.parse(raw); // ZodError → 400 via apiOnError
    const id = deps.passkeys.store(c.get("tenantId"), pk);
    return c.json({ id }, 201);
  });
}
