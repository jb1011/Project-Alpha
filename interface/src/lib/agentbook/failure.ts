import { ApiError, apiErrorDetail } from "@/lib/api/types";
import { FAILURE_COPY } from "@/lib/agentbook/chipState";

/**
 * What a guardian is told when a vouch does not go through — and, more importantly, WHETHER we are
 * allowed to say nothing was written.
 *
 * The register route claims the row (`claimSubmit`) and signs the transaction BEFORE it broadcasts,
 * and the reconciler re-broadcasts the same raw transaction afterwards. So a failure the route did
 * not classify — a proxy 502, an `internal_error` 500, a dropped connection, a body we could not
 * read back — says nothing at all about whether a permanent public record now exists. Telling
 * someone "nothing was written" there is a false statement about what is public about them, which
 * is the one failure mode this whole feature is built to avoid. Those cases get §5.2's sentence.
 *
 * Nothing here ever renders a server message, a revert reason, a proof or a nullifier.
 */

/* ── Copy ───────────────────────────────────────────────────────────────────── */

/** §5.3, one message for every non-Orb guardian. Byte-identical to the backend's
 *  `NOT_ELIGIBLE_MESSAGE`, so the local check and the 403 read the same. */
export const NOT_ELIGIBLE_COPY =
  "AgentBook vouching needs a World ID from an Orb. Your access here is unaffected. AgentBook is World's public registry and only accepts Orb-verified proofs. There is nothing we can substitute for that, and we will not fake it.";

/** The disabled-button reason, and the `not_ready` 409 for an agent with no pocket yet. */
export const NO_POCKET_COPY = "Available once the agent has a payment address";

export const NOT_ON_CHAIN_COPY =
  "This agent is not fully on chain yet. Vouching becomes available once it is. Nothing was sent.";

/** One code, two caps (per-agent lifetime and per-account per hour), so this has to be true of
 *  both — and the design's "then contact support" for a re-vouch after a dispute needs a home. */
export const LIMIT_COPY =
  "This agent has reached its AgentBook vouch limit, or you have started too many vouches this hour. Try again in an hour; if it persists, contact support.";

export const UNAVAILABLE_COPY =
  "AgentBook is not reachable right now. Nothing was sent. Try again in a minute.";

export const VALIDATION_COPY =
  "That proof was not in the shape the registry accepts, so it was not sent. Nothing was written.";

export const NOT_FOUND_COPY = "This agent could not be found. Nothing was written.";

export const GENERIC_COPY = "Something went wrong before anything was written. Try again.";

/** The 401 from the `auth` middleware. Reachable because the World App round trip is minutes long:
 *  the token taken before the QR can lapse before the proof comes back. */
export const UNAUTHORIZED_COPY =
  "Your sign-in expired. Nothing was sent. Sign in again and retry.";

/** hono's `bodyLimit` refusing an oversized request, above every handler. */
export const TOO_LARGE_COPY = "That request was too large to send. Nothing was sent.";

/* ── Classification ─────────────────────────────────────────────────────────── */

/**
 * Where the failure happened. `session` is before anything exists; `register` is after the proof
 * was sent, which is the only place the "did it land?" question can arise.
 */
export type VouchStage = "session" | "register";

export type VouchFailure = {
  message: string;
  /** Whether to offer "Try again". Never true when we cannot say what happened. */
  retryable: boolean;
  /** True when we do not know whether a record was written; the chip resolves it, not us. */
  unresolved: boolean;
};

/**
 * The register route's own codes, every one of them raised BEFORE `claimSubmit` — verified against
 * `back/backend/src/api/routes/agentBook.ts`: `not_eligible`/`not_ready`/`not_found` and
 * `validation_error` precede the session lookup; `unavailable` and `proof_rejected` come from
 * simulate/balance/sign, all above the claim; and the only two conflicts raised after the claim
 * (`inflight`, `lost`) mean ANOTHER submission owns the row, so this request still wrote nothing.
 * `unauthorized` is the auth middleware refusing above every handler (`auth/siwe.ts`), which is
 * further above the claim than any of them.
 * A code that is not on this list is not the route speaking, and we must not speak for it.
 */
export const CLASSIFIED_CODES = [
  "proof_rejected",
  "unavailable",
  "conflict",
  "limit_exceeded",
  "validation_error",
  "not_ready",
  "not_eligible",
  "not_found",
  "unauthorized",
] as const;

const CLASSIFIED = new Set<string>(CLASSIFIED_CODES);

/**
 * hono's `bodyLimit` refusing the request before the handler runs.
 *
 * It throws an `HTTPException`, which `api/errors.ts` turns into `{ code: "error" }` (its fallback
 * for anything carrying a status) with a 413 — so unlike every code above, this one is matched on
 * the status as well. "error" alone is not the route speaking: a 500 wearing it must keep §5.2's
 * sentence. `http_error` is the same status seen through the client's own synthesised envelope
 * (`client.ts`) when the body could not be read back.
 */
function isBodyLimit(e: ApiError): boolean {
  return e.status === 413 && (e.code === "error" || e.code === "http_error");
}

/** A conflict whose cause is the on-chain nonce having moved: someone else's vouch may have landed
 *  while the guardian was approving. Matched on the route's message, never shown. */
export function isRegistryMoved(e: unknown): boolean {
  return e instanceof ApiError && e.code === "conflict" && /registry moved/i.test(e.message);
}

const CONFLICT_COPY =
  "That request is no longer valid and nothing was written. Starting again means a fresh request in World App.";

export function failureFor(e: unknown, stage: VouchStage): VouchFailure {
  const fail = (message: string, retryable: boolean, unresolved = false): VouchFailure => ({
    message,
    retryable,
    unresolved,
  });
  const unclassified = (): VouchFailure =>
    stage === "register" ? fail(FAILURE_COPY, false, true) : fail(GENERIC_COPY, true);

  if (!(e instanceof ApiError)) return unclassified();
  if (isBodyLimit(e)) return fail(TOO_LARGE_COPY, false);
  if (!CLASSIFIED.has(e.code)) return unclassified();

  const detail = apiErrorDetail(e.details);
  switch (e.code) {
    case "not_eligible":
      return fail(NOT_ELIGIBLE_COPY, false);
    case "not_ready":
      return fail(detail?.reason === "no-pocket-yet" ? NO_POCKET_COPY : NOT_ON_CHAIN_COPY, false);
    case "limit_exceeded":
      return fail(LIMIT_COPY, false);
    case "unavailable":
      return fail(UNAVAILABLE_COPY, true);
    case "conflict":
      return fail(CONFLICT_COPY, true);
    case "validation_error":
      return fail(VALIDATION_COPY, false);
    case "not_found":
      return fail(NOT_FOUND_COPY, false);
    case "unauthorized":
      // Retryable: signing in again is the first thing a retry does, and a fresh session means a
      // fresh World App request rather than a resubmitted proof.
      return fail(UNAUTHORIZED_COPY, true);
    case "proof_rejected":
      return fail(
        detail?.errorName
          ? `World rejected the proof (${detail.errorName}). Nothing was written.`
          : "World rejected the proof. Nothing was written.",
        false,
      );
    default:
      return unclassified();
  }
}

/** World App's own refusal codes. The code is an enum value, never World App's error text. */
export function bridgeMessage(code: string): string {
  switch (code) {
    case "verification_rejected":
      return "You declined the request in World App. Nothing was written.";
    case "credential_unavailable":
      return NOT_ELIGIBLE_COPY;
    case "max_verifications_reached":
      return "Your World ID has already been used for this AgentBook action as often as World allows. Nothing was written.";
    case "inclusion_proof_pending":
    case "inclusion_proof_failed":
      return "World is still publishing your World ID to the on-chain set. Try again in a few minutes. Nothing was written.";
    default:
      return `World App did not complete the request (${code}). Nothing was written.`;
  }
}
