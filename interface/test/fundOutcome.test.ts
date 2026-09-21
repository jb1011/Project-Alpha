import { expect, test } from "vitest";
import { ApiError } from "@/lib/api/types";
import {
  FUND_POLL_TIMEOUT_MS,
  FUND_TIMEOUT_COPY,
  answerForAttempt,
  fundPollOutcome,
  isBusyConflict,
} from "@/lib/onboarding/fundOutcome";

/**
 * The decision FundStep used to make inline, and got wrong twice in one week (2026-09-14 and
 * 2026-09-16): it watched for `funded` or `failed` and nothing else, so a fund that failed
 * without moving the status — which is every fund failure, because a fund runs on an entity that
 * is already `bound` — span forever.
 */

const t = (
  polled: { status: string; error?: string | null } | undefined,
  elapsedMs = 0,
) => fundPollOutcome(polled, elapsedMs);

test("funded with nothing wrong is confirmed", () => {
  expect(t({ status: "funded" })).toBe("confirmed");
  expect(t({ status: "funded", error: null })).toBe("confirmed");
  expect(t({ status: "funded", error: "" })).toBe("confirmed");
});

test("failed is an error, with the backend's reason where there is one", () => {
  expect(t({ status: "failed", error: "The platform funding wallet cannot cover this." })).toEqual({
    error: "The platform funding wallet cannot cover this.",
  });
});

test("failed with no reason still says something", () => {
  expect(t({ status: "failed" })).toEqual({ error: "Funding failed." });
  expect(t({ status: "failed", error: null })).toEqual({ error: "Funding failed." });
  expect(t({ status: "failed", error: "   " })).toEqual({ error: "Funding failed." });
});

test("THE 2026-09-14 CASE: an error on a still-`bound` entity is a failure", () => {
  // The fund saga ran on a `bound` entity and threw. The status is still `bound` — correctly, the
  // entity IS bound — and the only trace is the error the runner now records beside it.
  expect(t({ status: "bound", error: "on-chain fundTreasury tx reverted" })).toEqual({
    error: "on-chain fundTreasury tx reverted",
  });
});

test("a top-up that fails on an already-`funded` entity is a failure, not a confirmation", () => {
  // The error check runs BEFORE the `funded` check for this case alone: a re-fund never changes
  // the status, so `funded` + an error means the top-up failed. It is safe because the backend
  // clears a stale error at the start of every attempt, so an error seen while polling belongs to
  // the attempt being polled.
  expect(t({ status: "funded", error: "The chain RPC is rate-limiting us right now." })).toEqual({
    error: "The chain RPC is rate-limiting us right now.",
  });
});

test("a bound entity with no error yet is still in flight", () => {
  expect(t({ status: "bound" })).toBe("keep-polling");
  expect(t({ status: "bound", error: null }, 89_000)).toBe("keep-polling");
});

test("no answer yet is not an answer", () => {
  expect(t(undefined)).toBe("keep-polling");
  // …and a slow FIRST response still times out: no data is not a reason to poll forever.
  expect(t(undefined, FUND_POLL_TIMEOUT_MS + 1)).toBe("timeout");
});

test("past 90 seconds with nothing decided is a TIMEOUT, never a failure", () => {
  expect(t({ status: "bound" }, FUND_POLL_TIMEOUT_MS)).toBe("keep-polling");
  expect(t({ status: "bound" }, FUND_POLL_TIMEOUT_MS + 1)).toBe("timeout");
});

test("a decided outcome beats the clock", () => {
  // A confirmation that arrives at 91 seconds is a confirmation. Reporting a timeout over it
  // would tell somebody to go and check a transfer that has already landed.
  expect(t({ status: "funded" }, 10 * FUND_POLL_TIMEOUT_MS)).toBe("confirmed");
  expect(t({ status: "bound", error: "reverted" }, 10 * FUND_POLL_TIMEOUT_MS)).toEqual({
    error: "reverted",
  });
});

test("the timeout copy never claims the transfer failed", () => {
  // The whole point of the third outcome. We do not know, so we must not say.
  expect(FUND_TIMEOUT_COPY).toContain("may still land");
  expect(FUND_TIMEOUT_COPY.toLowerCase()).not.toContain("failed");
  expect(FUND_POLL_TIMEOUT_MS).toBe(90_000);
});

/* ── I-R1: an answer that predates the attempt is not an answer ─────────────────────────────── */

const ATTEMPT_2_AT = 2_000;
const attempt1Body = { status: "bound", error: "attempt-1 failure" };

test("I-R1 THE RETRY CASE: the previous attempt's cached body is ignored", () => {
  // Confirmed against @tanstack/query-core 5.101.1: the poll's key is the ENTITY, `enabled` only
  // gates fetching, and `invalidateQueries` does not clear data — so the instant a retry flips
  // polling back on, the effect is handed the FAILED attempt's body, 27ms stale, and reports the
  // retry as failed before a single poll of it has happened.
  expect(answerForAttempt(attempt1Body, 1_000, ATTEMPT_2_AT)).toBeUndefined();
  expect(fundPollOutcome(answerForAttempt(attempt1Body, 1_000, ATTEMPT_2_AT), 0)).toBe(
    "keep-polling",
  );
});

test("I-R1: a retry after a TIMEOUT is protected by construction, not by luck", () => {
  // As written this case was safe only because a timed-out attempt leaves the cached body with a
  // null error and a non-terminal status. The guard makes it true on purpose.
  expect(answerForAttempt({ status: "bound", error: null }, 1_000, ATTEMPT_2_AT)).toBeUndefined();
});

test("I-R1: a cross-mount stale `funded` does not confirm a transfer that has not landed", () => {
  // The dashboard polls the same key every 5s with a 5min gcTime, so arriving at the fund step
  // with a cached `funded` body is reachable — and `funded` is the one status that would have been
  // rendered as an instant success for a top-up that is still in flight.
  expect(fundPollOutcome(answerForAttempt({ status: "funded" }, 1_000, ATTEMPT_2_AT), 0)).toBe(
    "keep-polling",
  );
});

test("I-R1: an answer received at or after the attempt's start is a real answer", () => {
  expect(answerForAttempt(attempt1Body, ATTEMPT_2_AT, ATTEMPT_2_AT)).toBe(attempt1Body);
  expect(answerForAttempt(attempt1Body, ATTEMPT_2_AT + 1, ATTEMPT_2_AT)).toBe(attempt1Body);
  expect(fundPollOutcome(answerForAttempt(attempt1Body, ATTEMPT_2_AT, ATTEMPT_2_AT), 0)).toEqual({
    error: "attempt-1 failure",
  });
});

test("I-R1: no data at all reads as no answer (dataUpdatedAt is 0)", () => {
  expect(answerForAttempt(undefined, 0, ATTEMPT_2_AT)).toBeUndefined();
  // …and the clock still runs, so a poll that never answers still times out.
  expect(
    fundPollOutcome(answerForAttempt(undefined, 0, ATTEMPT_2_AT), FUND_POLL_TIMEOUT_MS + 1),
  ).toBe("timeout");
});

/* ── Minor: a retry answered "entity is busy" is still WAITING, not failed ───────────────────── */

test("a 409 `entity is busy` is recognised as the previous attempt still running", () => {
  // The common case for the retry offered at 90s: the saga that timed out is exactly why the
  // backend refuses a second one. Showing that refusal as a red error replaces an honest "may
  // still land" with a misleading failure.
  expect(
    isBusyConflict(new ApiError(409, { code: "conflict", message: "entity is busy" })),
  ).toBe(true);
});

test("…and no other conflict or error is mistaken for it", () => {
  for (const e of [
    new ApiError(409, { code: "conflict", message: 'cannot fund in status "pending"' }),
    new ApiError(400, { code: "limit_exceeded", message: "tenant treasury funding quota exhausted" }),
    new ApiError(0, { code: "timeout", message: "The server took too long to answer. Try again." }),
    new Error("entity is busy"),
    undefined,
  ])
    expect(isBusyConflict(e)).toBe(false);
});

test("an unknown status is not an outcome", () => {
  // Nothing else the backend can answer with (`pending`, `created`, a status this build predates)
  // may be read as success or failure.
  for (const status of ["pending", "provisioned", "translating", "created", "something-new"])
    expect(t({ status })).toBe("keep-polling");
});
