import type { MiddlewareHandler } from "hono";
import { verifySession } from "./session";
import { AuthError } from "./siwe";

/** Hono context vars set by requireAuth. */
export type AuthVars = { tenantId: `0x${string}` };

/** Require a valid Bearer session; sets c.get("tenantId"). Throws AuthError (401) otherwise. */
export function requireAuth(secret: string): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) throw new AuthError("missing Bearer token");
    const { tenantId } = await verifySession(token, secret);
    c.set("tenantId", tenantId);
    await next();
  };
}
