import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { ApiError } from "../errors";

/** The typed API failure. DEFINED at `src/errors.ts` — the workflow layer throws it too, and
 *  `src/workflow` may not import from `src/api` — and re-exported here so every route, tool and
 *  test that already imports it from this module is unchanged. */
export { ApiError };

/** Hono onError: ApiError → its status; ZodError → 400; AuthError (status prop) → its status; else 500. */
export function apiOnError(err: Error, c: Context) {
  if (err instanceof ApiError) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status,
    );
  }
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return c.json(
      { error: { code: "validation_error", message: "invalid request", details: issues } },
      400,
    );
  }
  const maybe = err as { code?: string; status?: number };
  if (typeof maybe.status === "number") {
    return c.json(
      { error: { code: maybe.code ?? "error", message: err.message } },
      maybe.status as ContentfulStatusCode,
    );
  }
  return c.json({ error: { code: "internal_error", message: "internal error" } }, 500);
}

/**
 * Entity-or-404, the house ownership idiom (M4).
 *
 * Look the entity up by key, compare `ownerTenantId`, and answer a UNIFORM 404 for
 * unknown-and-not-yours alike. Distinguishing them would turn every entity route into an
 * existence oracle over other tenants' ids, which is the reason the two cases share one answer.
 *
 * Extracted for the DOCUMENT routes, which are the ones that hand back bytes: the other routes
 * keep their own inline copies deliberately, because rewriting a dozen working handlers to prove
 * a point is a bigger change than the one being reviewed.
 */
export function requireOwnedEntity(
  deps: { repo: import("../persistence/entityRepository").EntityRepository },
  c: { req: { param(k: string): string }; get(k: "tenantId"): string },
): import("../types").EntityRecord {
  const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
  if (!rec || rec.ownerTenantId !== c.get("tenantId"))
    throw new ApiError("not_found", 404, "entity not found");
  return rec;
}

/**
 * Company-or-404, the same idiom one key along (design §7, A3).
 *
 * The document routes moved from `/entities/:id/documents` to
 * `/companies/:companyId/documents` when the store was re-keyed: documents belong to the FILING,
 * a company can have them before any agent attaches, and asking for them through an entity was a
 * round trip to recover a key the caller already held.
 *
 * `findOwned` answers undefined for unknown AND for not-yours, and this turns both into the same
 * 404 — for the reason `requireOwnedEntity` does: distinguishing them would make the route an
 * existence oracle over other tenants' company ids.
 */
export function requireOwnedCompany(
  deps: { companies?: import("../persistence/companyRepository").CompanyRepository },
  c: { req: { param(k: string): string }; get(k: "tenantId"): string },
): import("../persistence/companyRepository").CompanyRecord {
  // A deployment with no company store cannot own a company, so every id is a 404 — the same
  // answer a real store gives for an id it does not hold, and never a 500.
  const rec = deps.companies?.findOwned(c.get("tenantId"), c.req.param("companyId"));
  if (!rec) throw new ApiError("not_found", 404, "company not found");
  return rec;
}
