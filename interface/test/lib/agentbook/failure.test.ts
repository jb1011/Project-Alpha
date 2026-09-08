/**
 * "Nothing was written" is a claim about what is permanently public about a person, so it is
 * tested like one.
 *
 * The register route claims the row and signs the transaction BEFORE broadcasting, and the
 * reconciler re-broadcasts afterwards — so only the codes the route itself raises can be answered
 * with "nothing was written". A proxy 502, an `internal_error` 500, a dropped fetch or a body we
 * could not read back all mean "we do not know", and the guardian is owed §5.2's sentence instead.
 */
import { describe, expect, test } from "vitest";
import { ApiError, type ApiErrorDetail } from "@/lib/api/types";
import { FAILURE_COPY } from "@/lib/agentbook/chipState";
import {
  bridgeMessage,
  CLASSIFIED_CODES,
  failureFor,
  GENERIC_COPY,
  isRegistryMoved,
  LIMIT_COPY,
  NOT_ELIGIBLE_COPY,
  NO_POCKET_COPY,
} from "@/lib/agentbook/failure";

const SECRET = "0xdeadbeefnullifier-and-call-arguments";

function apiError(code: string, status = 400, message = SECRET, details?: ApiErrorDetail) {
  return new ApiError(status, { code, message, details });
}

describe("failureFor — route-classified codes say what did not happen", () => {
  for (const code of CLASSIFIED_CODES) {
    test(`${code} at the register step keeps a definite answer`, () => {
      const out = failureFor(apiError(code), "register");
      expect(out.unresolved).toBe(false);
      expect(out.message).not.toBe(FAILURE_COPY);
    });

    test(`${code} never leaks the server's message`, () => {
      expect(failureFor(apiError(code), "register").message).not.toContain(SECRET);
      expect(failureFor(apiError(code), "session").message).not.toContain(SECRET);
    });
  }

  test("the codes raised on the write path say outright that nothing landed", () => {
    // `not_eligible` and `limit_exceeded` are refusals BEFORE a proof is ever produced (the
    // session route), so their copy is about the refusal itself rather than about the registry.
    for (const code of ["proof_rejected", "unavailable", "conflict", "validation_error", "not_found"]) {
      expect(failureFor(apiError(code), "register").message).toMatch(
        /Nothing was (written|sent)|no longer valid/,
      );
    }
  });

  test("the specific mappings", () => {
    expect(failureFor(apiError("not_eligible", 403), "session").message).toBe(NOT_ELIGIBLE_COPY);
    expect(
      failureFor(apiError("not_ready", 409, SECRET, { reason: "no-pocket-yet" }), "session").message,
    ).toBe(NO_POCKET_COPY);
    expect(
      failureFor(apiError("not_ready", 409, SECRET, { reason: "entity-is-created" }), "session")
        .message,
    ).toMatch(/not fully on chain yet/);
    expect(failureFor(apiError("limit_exceeded", 429), "session").message).toBe(LIMIT_COPY);
    expect(failureFor(apiError("unavailable", 503), "register").message).toMatch(
      /^AgentBook is not reachable right now\. Nothing was sent\./,
    );
    expect(
      failureFor(apiError("proof_rejected", 400, SECRET, { errorName: "InvalidNullifier" }), "register")
        .message,
    ).toBe("World rejected the proof (InvalidNullifier). Nothing was written.");
    expect(failureFor(apiError("proof_rejected", 400), "register").message).toBe(
      "World rejected the proof. Nothing was written.",
    );
  });

  test("only `unavailable` and `conflict` offer a retry; nothing that ended the attempt for good", () => {
    expect(failureFor(apiError("unavailable", 503), "register").retryable).toBe(true);
    expect(failureFor(apiError("conflict", 409), "register").retryable).toBe(true);
    expect(failureFor(apiError("proof_rejected", 400), "register").retryable).toBe(false);
    expect(failureFor(apiError("limit_exceeded", 429), "register").retryable).toBe(false);
    expect(failureFor(apiError("not_eligible", 403), "register").retryable).toBe(false);
  });
});

describe("failureFor — anything the route did not classify", () => {
  const unclassified: [string, unknown][] = [
    ["a proxy 502 (client-synthesised http_error)", apiError("http_error", 502, "Bad Gateway")],
    ["a gateway 504", apiError("http_error", 504, "Gateway Timeout")],
    ["the backend's own 500", apiError("internal_error", 500, "internal error")],
    ["a code nobody has taught us", apiError("teapot", 418)],
    ["a dropped connection", new TypeError("Failed to fetch")],
    ["a body we could not read back", new TypeError("Cannot read properties of null")],
    ["something that is not an Error at all", "boom"],
  ];

  for (const [name, err] of unclassified) {
    test(`${name} after the proof was sent → §5.2's sentence, no retry`, () => {
      const out = failureFor(err, "register");
      expect(out.message).toBe(FAILURE_COPY);
      expect(out.unresolved).toBe(true);
      expect(out.retryable).toBe(false);
      // The one thing it must never say.
      expect(out.message).not.toMatch(/Nothing was/);
    });

    test(`${name} before a session existed → the plain generic, retryable`, () => {
      const out = failureFor(err, "session");
      expect(out.message).toBe(GENERIC_COPY);
      expect(out.unresolved).toBe(false);
      expect(out.retryable).toBe(true);
    });
  }
});

describe("isRegistryMoved", () => {
  test("true only for the conflict whose cause is the on-chain nonce moving", () => {
    expect(isRegistryMoved(apiError("conflict", 409, "the registry moved; start again"))).toBe(true);
    expect(isRegistryMoved(apiError("conflict", 409, "session expired; start again"))).toBe(false);
    expect(isRegistryMoved(apiError("conflict", 409, "session already used"))).toBe(false);
    expect(
      isRegistryMoved(apiError("conflict", 409, "a registration for this agent is already in flight")),
    ).toBe(false);
    expect(isRegistryMoved(apiError("unavailable", 503, "the registry moved"))).toBe(false);
    expect(isRegistryMoved(new Error("the registry moved"))).toBe(false);
  });
});

describe("bridgeMessage", () => {
  test("World App's codes map to plain sentences, and an unknown one carries the code only", () => {
    expect(bridgeMessage("verification_rejected")).toMatch(/^You declined the request/);
    expect(bridgeMessage("credential_unavailable")).toBe(NOT_ELIGIBLE_COPY);
    expect(bridgeMessage("inclusion_proof_pending")).toMatch(/still publishing your World ID/);
    expect(bridgeMessage("generic_error")).toBe(
      "World App did not complete the request (generic_error). Nothing was written.",
    );
  });

  test("every message says nothing was written, because World App declines before we submit", () => {
    for (const code of [
      "verification_rejected",
      "max_verifications_reached",
      "inclusion_proof_failed",
      "connection_failed",
    ]) {
      expect(bridgeMessage(code)).toMatch(/Nothing was written\.$/);
    }
  });
});
