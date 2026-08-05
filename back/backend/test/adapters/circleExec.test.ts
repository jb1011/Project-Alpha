import { describe, expect, test, vi } from "vitest";
import {
  CircleTxFailedError,
  CircleTxTimeoutError,
  deterministicIdempotencyKey,
  submitAndConfirm,
} from "../../src/adapters/circle/circleExec";

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
