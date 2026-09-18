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

/**
 * A TRANSACTION WAS BROADCAST AND WE DO NOT KNOW WHAT HAPPENED TO IT.
 *
 * The single most dangerous thing this system can get wrong about money, and until the 2026-09-17
 * review it got it wrong by default. `ArcAdapter.fundTreasury` sends the transfer and THEN awaits
 * the receipt, and viem rejects a receipt-poll failure verbatim — so the very same
 * `HttpRequestError{status:429}` that means "the broadcast was refused" also arrives *after* a
 * successful broadcast. The old public message said "Nothing was sent" in both worlds, and with
 * the wizard's new Retry button that invited a SECOND transfer of platform funds (uncounted by the
 * S5 ceiling, because `outflows.record` sits after the await).
 *
 * So the adapter now says which world it is in, because it is the only layer that knows: a failure
 * raised once a hash exists is wrapped in this type, carrying the hash. Everything above keys off
 * the TYPE rather than off the text — the public sentence names the hash and forbids a retry, and
 * the saga reconciles the hash by receipt before it ever sends again.
 *
 * Lives here, beside `ApiError`, for the same layering reason: the adapter throws it and both
 * `src/workflow` (saga, sanitiser) and `src/api` need `instanceof` on it.
 *
 * The precedent and the wording are `CircleTxTimeoutError`'s ("still in flight; retry resumes it",
 * `src/adapters/circle/circleExec.ts`) — this is that honesty applied to the Arc path.
 */
export class BroadcastUnconfirmedError extends Error {
  constructor(
    readonly txHash: `0x${string}`,
    /** The operation, for the operator diagnostic: "fundTreasury", "createEntity", … */
    readonly operation: string,
    options?: { cause?: unknown },
  ) {
    super(
      `${operation}: broadcast as ${txHash} but the receipt could not be read — the transaction may be mined; do not re-send`,
      options,
    );
    this.name = "BroadcastUnconfirmedError";
  }
}

/**
 * A PREVIOUS broadcast is still unresolved, so this request deliberately did nothing.
 *
 * Thrown by the saga's step 7 when it finds a `fundTreasury`/`unconfirmed` event whose receipt it
 * still cannot read: neither mined nor reverted, so neither finalising nor re-sending is honest.
 * Refusing is the only safe answer, and the message has to say that the refusal is not a failure.
 */
export class PriorTransferUnconfirmedError extends Error {
  constructor(
    readonly txHash: `0x${string}`,
    options?: { cause?: unknown },
  ) {
    super(
      `a previous fundTreasury broadcast (${txHash}) is still unconfirmed — refusing to send a second transfer`,
      options,
    );
    this.name = "PriorTransferUnconfirmedError";
  }
}
