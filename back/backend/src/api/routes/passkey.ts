import { randomBytes } from "node:crypto";
import type { Env, Hono } from "hono";
import type { ApiDeps } from "../app";

/** Issue a WebAuthn registration challenge for the browser ceremony. (Turnkey does not check
 *  freshness — the challenge just needs to be embedded consistently in clientDataJSON.) */
export function mountPasskeyRoutes<E extends Env>(app: Hono<E>, deps: ApiDeps) {
  app.get("/passkey/challenge", (c) =>
    c.json({ challenge: randomBytes(32).toString("base64url"), rpId: deps.passkeyRpId }),
  );
}
