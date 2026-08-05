import { describe, expect, test, vi } from "vitest";
import { withCircleRateLimit } from "../../src/adapters/circle/circleRateLimit";
import type { CircleWalletsApi } from "../../src/adapters/circle/circleWallets";

function makeApi(): CircleWalletsApi & { calls: string[] } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (..._args: unknown[]) => {
      calls.push(name);
      return { data: {} };
    };
  return {
    calls,
    createWallets: record("createWallets"),
    signTypedData: record("signTypedData"),
    signMessage: record("signMessage"),
    createContractExecutionTransaction: record("createContractExecutionTransaction"),
    getTransaction: record("getTransaction"),
  } as unknown as CircleWalletsApi & { calls: string[] };
}

describe("withCircleRateLimit", () => {
  test("spaces call STARTS by the min interval, process-wide across methods", async () => {
    let t = 0;
    const waits: number[] = [];
    const api = makeApi();
    const limited = withCircleRateLimit(api, {
      minIntervalMs: 200,
      now: () => t,
      sleep: async (ms) => {
        waits.push(ms);
        t += ms; // waiting advances the clock
      },
    });
    await Promise.all([
      limited.signTypedData({ walletId: "w", data: "{}" }),
      limited.getTransaction({ id: "tx" }),
      limited.signMessage({ walletId: "w", message: "m" }),
    ]);
    // First call runs immediately; each later call waits for its slot.
    expect(waits).toEqual([200, 200]);
    expect(api.calls).toHaveLength(3);
  });

  test("a failing call does not wedge the queue", async () => {
    const api = makeApi();
    api.signMessage = vi.fn().mockRejectedValue(new Error("boom"));
    const limited = withCircleRateLimit(api, { minIntervalMs: 0 });
    await expect(limited.signMessage({ walletId: "w", message: "m" })).rejects.toThrow("boom");
    await expect(limited.getTransaction({ id: "tx" })).resolves.toBeTruthy();
  });

  test("passes inputs and results through unchanged", async () => {
    const api = makeApi();
    api.getTransaction = vi.fn(async (input: { id: string }) => ({
      data: { transaction: { id: input.id, state: "CONFIRMED" } },
    })) as CircleWalletsApi["getTransaction"];
    const limited = withCircleRateLimit(api, { minIntervalMs: 0 });
    const r = await limited.getTransaction({ id: "tx-7" });
    expect(r.data?.transaction?.id).toBe("tx-7");
  });
});
