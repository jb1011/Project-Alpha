import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * A typed API failure mapped to a stable error envelope.
 *
 * It lives at the ROOT rather than under `src/api/` because the workflow layer throws it too —
 * `OnboardingRunner.start` refuses a 409 conflict and a 400 party refusal long before any HTTP
 * handler is involved. With the class defined under `api/`, `src/workflow` imported from
 * `src/api`, which is the layering inversion a test now forbids (a saga must not depend on a
 * transport). `src/api/errors.ts` re-exports it, so every existing importer is unchanged and
 * `instanceof` still identifies the one class.
 */
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
