import { describe, expect, test } from "vitest";
import { CircleRequestError, circleRequestError } from "../../src/adapters/circle/circleError";

/** Two strings that must never reach a message. Fake, and shaped like the real thing so the
 *  redaction bar is honest: 20+ characters of credential alphabet. */
const FAKE_BEARER = "fake-bearer-AAAAAAAAAAAAAAAAAAAAAAAA";
const FAKE_CIPHERTEXT = "fake-ciphertext-BBBBBBBBBBBBBBBBBBBBBBBB";

/**
 * An axios-shaped rejection exactly as the DevC SDK surfaces one — INCLUDING the request config,
 * which carries the API-key header and the entity-secret ciphertext of the body we just sent.
 * That config is the reason nobody ever printed these errors whole.
 */
function fakeSdkError(data: unknown, status = 400): Error {
  const e = new Error("Request failed with status code 400") as Error & Record<string, unknown>;
  e.response = { status, data };
  e.config = {
    headers: { Authorization: `Bearer ${FAKE_BEARER}`, "x-api-key": FAKE_BEARER },
    data: JSON.stringify({ entitySecretCiphertext: FAKE_CIPHERTEXT }),
  };
  e.request = { _header: `Authorization: Bearer ${FAKE_BEARER}` };
  return e;
}

const FIELDS = {
  call: "createContractExecutionTransaction",
  walletId: "wal-1",
  refId: "r".repeat(101),
  callData: "0xdeadbeef",
};

describe("circleRequestError", () => {
  test("carries Circle's whole answer: status, code, message", () => {
    const err = circleRequestError(
      fakeSdkError({ code: 2, message: "API parameter invalid" }),
      FIELDS,
    );
    expect(err).toBeInstanceOf(CircleRequestError);
    expect(err.name).toBe("CircleRequestError");
    expect(err.message).toContain("createContractExecutionTransaction");
    expect(err.message).toContain("400");
    expect(err.message).toContain("2");
    expect(err.message).toContain("API parameter invalid");
    expect(err.status).toBe(400);
    expect(err.circleCode).toBe("2");
  });

  test("carries the errors[] array, where Circle sometimes names the field", () => {
    const err = circleRequestError(
      fakeSdkError({
        code: 2,
        message: "API parameter invalid",
        errors: [{ message: "must be at most 100 characters", location: "refId" }],
      }),
      FIELDS,
    );
    expect(err.message).toContain("refId");
    expect(err.message).toContain("must be at most 100 characters");
  });

  test("names OUR fields that could be at fault: walletId, refId length, callData length", () => {
    const err = circleRequestError(
      fakeSdkError({ code: 2, message: "API parameter invalid" }),
      FIELDS,
    );
    expect(err.message).toContain("wal-1");
    expect(err.message).toMatch(/refId 101 chars/);
    expect(err.message).toMatch(/callData 10 chars/);
  });

  test("NEVER the api key, the bearer header or the entity-secret ciphertext", () => {
    const err = circleRequestError(
      fakeSdkError({
        code: 2,
        message: "API parameter invalid",
        // Circle echoes the offending value back in `invalidValue` — for a Circle call that is
        // OUR request body, ciphertext included. It is never quoted.
        errors: [
          { message: "bad", location: "entitySecretCiphertext", invalidValue: FAKE_CIPHERTEXT },
        ],
      }),
      FIELDS,
    );
    expect(err.message).not.toContain(FAKE_BEARER);
    expect(err.message).not.toContain(FAKE_CIPHERTEXT);
    expect(err.message).not.toContain("Bearer");
    // The whole error object is never stringified, so nothing can ride along on it later.
    expect(JSON.stringify({ message: err.message, cause: err.cause })).not.toContain(FAKE_BEARER);
    expect(err.cause).toBeUndefined();
  });

  test("a rejection with no HTTP shape at all still says what was called and what we sent", () => {
    const err = circleRequestError(new Error("socket hang up"), FIELDS);
    expect(err.message).toContain("createContractExecutionTransaction");
    expect(err.message).toContain("socket hang up");
    expect(err.message).toMatch(/refId 101 chars/);
    expect(err.status).toBeUndefined();
  });

  test("a string body is used as the message; a non-error throw does not crash the describer", () => {
    expect(circleRequestError(fakeSdkError("API parameter invalid"), FIELDS).message).toContain(
      "API parameter invalid",
    );
    expect(circleRequestError("boom", FIELDS).message).toContain(
      "createContractExecutionTransaction",
    );
  });

  test("an already-described rejection is never wrapped twice", () => {
    const first = circleRequestError(
      fakeSdkError({ code: 2, message: "API parameter invalid" }),
      FIELDS,
    );
    expect(circleRequestError(first, FIELDS)).toBe(first);
  });

  test("optional fields are omitted rather than printed empty", () => {
    const err = circleRequestError(fakeSdkError({ message: "nope" }), { call: "createWallets" });
    expect(err.message).toContain("createWallets");
    expect(err.message).not.toContain("refId");
    expect(err.message).not.toContain("walletId");
  });
});
