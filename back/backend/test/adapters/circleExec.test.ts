import { describe, expect, test, vi } from "vitest";
import { CircleRequestError } from "../../src/adapters/circle/circleError";
import {
  CircleTxFailedError,
  CircleTxTimeoutError,
  deterministicIdempotencyKey,
  submitAndConfirm,
} from "../../src/adapters/circle/circleExec";
import { publicErrorMessage } from "../../src/workflow/publicError";

const INPUT = {
  walletId: "w1",
  contractAddress: "0x1000000000000000000000000000000000000001",
  callData: "0xdeadbeef" as const,
  idempotencySeed: "seed:1",
};

describe("deterministicIdempotencyKey", () => {
  test("UUID-v4-shaped, deterministic, and seed-sensitive", () => {
    const a = deterministicIdempotencyKey("x");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicIdempotencyKey("x")).toBe(a); // stable
    expect(deterministicIdempotencyKey("y")).not.toBe(a); // seed-sensitive
  });
});

describe("submitAndConfirm", () => {
  test("submits with the derived key, polls to CONFIRMED, returns the on-chain hash", async () => {
    const create = vi.fn(async (_input: Record<string, unknown>) => ({
      data: { id: "tx-1", state: "INITIATED" },
    }));
    const states = ["INITIATED", "SENT", "CONFIRMED"];
    let i = 0;
    const get = vi.fn(async () => ({
      data: {
        transaction: {
          id: "tx-1",
          state: states[Math.min(i++, states.length - 1)]!,
          txHash: i > 2 ? "0xabc" : undefined,
        },
      },
    }));
    const r = await submitAndConfirm(
      { createContractExecutionTransaction: create, getTransaction: get },
      INPUT,
      { pollDelayMs: 0, sleep: async () => {} },
    );
    expect(r).toEqual({ circleTxId: "tx-1", txHash: "0xabc" });
    expect(create.mock.calls[0]![0]).toMatchObject({
      walletId: "w1",
      callData: "0xdeadbeef",
      idempotencyKey: deterministicIdempotencyKey("seed:1"),
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    expect(get).toHaveBeenCalledTimes(3);
  });

  test("terminal FAILED/DENIED throws CircleTxFailedError with the state named", async () => {
    const api = {
      createContractExecutionTransaction: vi.fn(async () => ({ data: { id: "tx-9" } })),
      getTransaction: vi.fn(async () => ({
        data: { transaction: { id: "tx-9", state: "DENIED", errorReason: "policy" } },
      })),
    };
    await expect(
      submitAndConfirm(api, INPUT, { pollDelayMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(CircleTxFailedError);
    await expect(
      submitAndConfirm(api, INPUT, { pollDelayMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/DENIED/);
  });

  test("hard timeout throws CircleTxTimeoutError carrying the tx id (still in flight)", async () => {
    let t = 0;
    const api = {
      createContractExecutionTransaction: vi.fn(async () => ({ data: { id: "tx-5" } })),
      getTransaction: vi.fn(async () => ({
        data: { transaction: { id: "tx-5", state: "QUEUED" } },
      })),
    };
    const err = await submitAndConfirm(api, INPUT, {
      pollDelayMs: 10,
      timeoutMs: 25,
      sleep: async () => {},
      now: () => {
        t += 10;
        return t;
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CircleTxTimeoutError);
    expect((err as CircleTxTimeoutError).circleTxId).toBe("tx-5");
  });

  test("onNetworkFee observes the confirmed fee in atomic USDC and never gates on failure", async () => {
    const api = {
      createContractExecutionTransaction: vi.fn(async () => ({ data: { id: "tx-2" } })),
      getTransaction: vi.fn(async () => ({
        data: { transaction: { id: "tx-2", state: "COMPLETE", txHash: "0xh", networkFee: "0.25" } },
      })),
    };
    const fees: bigint[] = [];
    const r = await submitAndConfirm(api, INPUT, {
      pollDelayMs: 0,
      sleep: async () => {},
      onNetworkFee: (fee) => {
        fees.push(fee);
        throw new Error("observer blew up"); // must NOT fail the call
      },
    });
    expect(fees).toEqual([250_000n]);
    expect(r.txHash).toBe("0xh");
  });

  test("missing tx id from the submit fails loudly", async () => {
    const api = {
      createContractExecutionTransaction: vi.fn(async () => ({ data: {} })),
      getTransaction: vi.fn(),
    };
    await expect(
      submitAndConfirm(api, INPUT, { pollDelayMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/no tx id/);
    expect(api.getTransaction).not.toHaveBeenCalled();
  });
});

/**
 * A SYNCHRONOUS rejection: Circle refused the request, so no transaction exists and nothing can
 * have moved. Distinct from the two terminal/in-flight errors above, which are about a
 * transaction Circle accepted — their semantics are untouched by this.
 */
describe("submitAndConfirm — a refusal says why", () => {
  const FAKE_BEARER = "fake-bearer-AAAAAAAAAAAAAAAAAAAAAAAA";

  function refusingApi() {
    const rejection = new Error("Request failed with status code 400") as Error &
      Record<string, unknown>;
    rejection.response = {
      status: 400,
      data: {
        code: 2,
        message: "API parameter invalid",
        errors: [{ location: "refId", message: "must be at most 100 characters" }],
      },
    };
    // The config the SDK hangs on every axios error — api key and entity secret included.
    rejection.config = { headers: { Authorization: `Bearer ${FAKE_BEARER}` } };
    return {
      createContractExecutionTransaction: vi.fn(async () => {
        throw rejection;
      }),
      getTransaction: vi.fn(),
    };
  }

  test("carries the status, code, message and errors[], plus our own field lengths", async () => {
    const api = refusingApi();
    const err = await submitAndConfirm(
      api,
      { ...INPUT, refId: "r".repeat(101) },
      { pollDelayMs: 0, sleep: async () => {} },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(CircleRequestError);
    expect(err.message).toContain("createContractExecutionTransaction");
    expect(err.message).toContain("HTTP 400");
    expect(err.message).toContain("code 2");
    expect(err.message).toContain("API parameter invalid");
    expect(err.message).toContain("[refId] must be at most 100 characters");
    expect(err.message).toContain("walletId w1");
    expect(err.message).toMatch(/refId 101 chars/);
    expect(err.message).toMatch(/callData 10 chars/);
    // Refused ⇒ no transaction to poll.
    expect(api.getTransaction).not.toHaveBeenCalled();
  });

  test("never the api key, and the operator's sentence survives publicErrorMessage intact", async () => {
    const api = refusingApi();
    const err = await submitAndConfirm(api, INPUT, {
      pollDelayMs: 0,
      sleep: async () => {},
    }).catch((e) => e);
    expect(err.message).not.toContain(FAKE_BEARER);
    expect(err.message).not.toContain("Bearer");
    const shown = publicErrorMessage(err);
    expect(shown).toContain("API parameter invalid");
    expect(shown).toContain("[refId] must be at most 100 characters");
  });

  test("is NOT a CircleTxFailedError: nothing was accepted, so no key was burned", async () => {
    const api = refusingApi();
    const err = await submitAndConfirm(api, INPUT, {
      pollDelayMs: 0,
      sleep: async () => {},
    }).catch((e) => e);
    expect(err).not.toBeInstanceOf(CircleTxFailedError);
    expect(err).not.toBeInstanceOf(CircleTxTimeoutError);
  });
});
