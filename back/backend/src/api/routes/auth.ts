import type { Hono } from "hono";
import { signSession } from "../../auth/session";
import { verifySiwe } from "../../auth/siwe";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const NONCE_TTL_MS = 600_000; // 10 min

export function mountAuthRoutes(
  app: Hono<{ Variables: { tenantId: `0x${string}` } }>,
  deps: ApiDeps,
) {
  const now = () => (deps.now ? deps.now() : Date.now());

  app.get("/auth/nonce", (c) => c.json({ nonce: deps.nonceStore.issue(now(), NONCE_TTL_MS) }));

  app.post("/auth/verify", async (c) => {
    let body: { message?: unknown; signature?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (typeof body.message !== "string" || typeof body.signature !== "string")
      throw new ApiError("validation_error", 400, "message and signature are required");

    const address = await verifySiwe({
      message: body.message,
      signature: body.signature as `0x${string}`,
      nonceStore: deps.nonceStore,
      domain: deps.siweDomain,
      chainId: deps.chainId,
      now: now(),
    });
    const { token, expiresAt } = await signSession(
      address,
      deps.jwtSecret,
      deps.jwtTtlSec,
      Math.floor(now() / 1000),
    );
    return c.json({ token, address, expiresAt });
  });
}
