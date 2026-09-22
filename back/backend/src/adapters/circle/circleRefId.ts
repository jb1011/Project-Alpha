/**
 * ONE rule, ONE place: a Circle `refId` is at most 100 characters.
 *
 * MEASURED, not guessed (2026-09-22, sandbox, an unowned wallet id so nothing could execute, same
 * body, only the refId varying):
 *
 *   19, 88, 100 chars → "Cannot find target wallet in the system…"  (body VALIDATED, lookup failed)
 *   101, 116 chars    → "API parameter invalid"                     (body REFUSED, no field named)
 *
 * So the ceiling is exactly 100 and Circle will not say which field it disliked. The docs do not
 * state the limit. This is the SECOND undocumented Circle length limit to cost a day — the first
 * was a wallet metadata NAME (2026-08-13, see `provisionCircleWallets`) — which is why the rule
 * now lives in one function that every refId goes through.
 *
 * IT THROWS, IT NEVER TRUNCATES. Two reasons:
 *
 *  - A truncated refId can COLLIDE, and Circle now lets us filter transactions by refId, so a
 *    refId is a lookup key. A colliding lookup key is worse than a refused request: it is a
 *    wrong answer instead of an error.
 *  - The value is DETERMINISTIC. If a refId is too long once it is too long always, so throwing
 *    locally is not a runtime gamble — a test catches it before Circle ever sees it, which is
 *    exactly what the guard tests do.
 */

/** Circle's undocumented ceiling, measured against the sandbox on 2026-09-22. */
export const CIRCLE_REF_ID_MAX = 100;

export class CircleRefIdTooLongError extends Error {
  constructor(
    readonly length: number,
    readonly refId: string,
  ) {
    super(
      `circle refId is ${length} characters; Circle accepts at most ${CIRCLE_REF_ID_MAX} and refuses anything longer with a bare "API parameter invalid" that names no field. Shorten the parts — a refId is a lookup key, so it is never truncated. Offending refId: ${refId}`,
    );
    this.name = "CircleRefIdTooLongError";
  }
}

/** The length rule on its own — the guard at the exit, where a hand-rolled refId is caught. */
export function assertCircleRefId(refId: string): string {
  if (refId.length > CIRCLE_REF_ID_MAX) throw new CircleRefIdTooLongError(refId.length, refId);
  return refId;
}

/**
 * Build a `refId` from its parts, joined with `:`, or throw.
 *
 * An empty part is refused too: a blank segment makes `a::b` and `a:b:` collide with their
 * neighbours, and a refId that can collide is no longer a key.
 */
export function circleRefId(parts: readonly string[]): string {
  if (parts.length === 0 || parts.some((p) => p === ""))
    throw new Error(
      `circle refId parts must all be non-empty (got ${parts.length} part(s): ${JSON.stringify(parts)}) — an empty segment collides with its neighbours`,
    );
  return assertCircleRefId(parts.join(":"));
}
