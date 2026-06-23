import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

/** A typed API failure mapped to a stable error envelope. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: ContentfulStatusCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

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
