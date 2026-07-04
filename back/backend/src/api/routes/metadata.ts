import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public, unauthenticated: resolve publicId -> entity -> served metadata JSON. Uniform 404 for
 *  malformed/unknown/missing-file (no existence oracle). The filename derives from the DB record's
 *  key, never raw URL input — the doc store's own containment guard is the last line of defense. */
export function mountMetadataRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/metadata/:publicId", (c) => {
    const publicId = c.req.param("publicId");
    if (!UUID.test(publicId)) throw new ApiError("not_found", 404, "metadata not found");
    const ent = deps.repo.findByPublicId(publicId);
    if (!ent) throw new ApiError("not_found", 404, "metadata not found");
    let body: string;
    try {
      body = deps.docStore.get(`meta-${ent.idempotencyKey}.json`);
    } catch {
      throw new ApiError("not_found", 404, "metadata not found");
    }
    c.header("Content-Type", "application/json");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(body);
  });
}
