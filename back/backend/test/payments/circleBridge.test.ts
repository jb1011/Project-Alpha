import Database from "better-sqlite3";
import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, test, vi } from "vitest";
import { deterministicIdempotencyKey } from "../../src/adapters/circle/circleExec";
import { BridgeInFlightError, runCircleBridge } from "../../src/payments/circleBridge";
import type { CircleBridgeDeps } from "../../src/payments/circleBridge";
import { SqliteBridgeLegRepository } from "../../src/persistence/bridgeLegRepository";
import { migrate } from "../../src/persistence/db";
import type { Address } from "../../src/types";

const TREASURY = "0x1000000000000000000000000000000000000001" as Address;
const USDC = "0x2000000000000000000000000000000000000002" as Address;
const GATEWAY = "0x3000000000000000000000000000000000000003" as Address;
const POCKET = "0x4000000000000000000000000000000000000004" as Address;

function makeLegs() {
  const db = new Database(":memory:");
  migrate(db);
  return new SqliteBridgeLegRepository(db);
}

/** Fake Circle API: every submit returns tx-{n}; getTransaction confirms immediately with a hash
 *  derived from the tx id. Records every call for assertions. */
function makeApi(overrides?: {
  states?: Record<string, string[]>; // per-txId sequence of states to serve
}) {
  let n = 0;
  const submits: {
    contractAddress: string;
    callData: `0x${string}`;
    idempotencyKey: string;
  }[] = [];
  const polls: string[] = [];
  const served = new Map<string, number>();
  const api = {
    createContractExecutionTransaction: vi.fn(async (input: (typeof submits)[number]) => {
      submits.push(input);
      n += 1;
      return { data: { id: `tx-${n}`, state: "INITIATED" } };
    }),
    getTransaction: vi.fn(async ({ id }: { id: string }) => {
      polls.push(id);
      const seq = overrides?.states?.[id];
      const i = served.get(id) ?? 0;
      served.set(id, i + 1);
      const state = seq ? seq[Math.min(i, seq.length - 1)]! : "CONFIRMED";
      return {
        data: {
          transaction: {
            id,
            state,
            txHash: state === "CONFIRMED" || state === "COMPLETE" ? `0xhash-${id}` : undefined,
            networkFee: "0.001",
            errorReason: state === "FAILED" ? "boom" : undefined,
          },
        },
      };
    }),
    submits,
    polls,
  };
  return api;
}

function makeDeps(
  api: ReturnType<typeof makeApi>,
  legs: SqliteBridgeLegRepository,
  overrides?: Partial<CircleBridgeDeps>,
): CircleBridgeDeps {
  return {
    api,
    legs,
    entityKey: "e:1",
    operatorWalletId: "op-wallet-1",
    treasury: TREASURY,
    usdc: USDC,
    gatewayWallet: GATEWAY,
    pocketAddress: POCKET,
    available: async () => 10_000_000n,
    standingExposure: async () => ({ operatorEoa: 0n, pocketEoa: 0n, gateway: 0n, total: 0n }),
    ceiling: 5_000_000n,
    confirm: { pollDelayMs: 0, timeoutMs: 1_000, sleep: async () => {} },
    newBridgeKey: () => "b1",
    ...overrides,
  };
}

describe("runCircleBridge", () => {
  test("happy path: three legs in order, real calldata, confirmed hashes returned", async () => {
    const legs = makeLegs();
    const api = makeApi();
    const hashes = await runCircleBridge(makeDeps(api, legs), 1_000_000n);

    expect(hashes).toEqual(["0xhash-tx-1", "0xhash-tx-2", "0xhash-tx-3"]);
    expect(api.submits.map((s) => s.contractAddress)).toEqual([TREASURY, USDC, GATEWAY]);

    // Leg calldata is REAL abi-encoded calldata, not a fabrication.
    const fund = decodeFunctionData({
      abi: parseAbi(["function fundOperator(uint256 amount)"]),
      data: api.submits[0]!.callData,
    });
    expect(fund.args).toEqual([1_000_000n]);
    const approve = decodeFunctionData({
      abi: parseAbi(["function approve(address spender, uint256 amount)"]),
      data: api.submits[1]!.callData,
    });
    expect(approve.args).toEqual([GATEWAY, 1_000_000n]); // EXACT-amount approve policy
    const deposit = decodeFunctionData({
      abi: parseAbi(["function depositFor(address token, address depositor, uint256 value)"]),
      data: api.submits[2]!.callData,
    });
    expect(deposit.args).toEqual([USDC, POCKET, 1_000_000n]);

    // Saga rows all confirmed with hashes.
    const rows = legs.legsOf("e:1:b1");
    expect(rows.map((r) => r.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
    expect(rows.map((r) => r.txHash)).toEqual(["0xhash-tx-1", "0xhash-tx-2", "0xhash-tx-3"]);
  });

  test("idempotency keys are deterministic per bridgeKey:leg:attempt and UUID-shaped", async () => {
    const legs = makeLegs();
    const api = makeApi();
    await runCircleBridge(makeDeps(api, legs), 1_000_000n);
    const expected = [
      deterministicIdempotencyKey("e:1:b1:fund_operator:0"),
      deterministicIdempotencyKey("e:1:b1:approve:0"),
      deterministicIdempotencyKey("e:1:b1:deposit_for:0"),
    ];
    expect(api.submits.map((s) => s.idempotencyKey)).toEqual(expected);
    for (const k of expected)
      expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Distinct across legs, stable across processes (pure function of the seed).
    expect(new Set(expected).size).toBe(3);
  });

  test("resume: confirmed legs are NOT re-submitted; the bridge completes from where it stopped", async () => {
    const legs = makeLegs();
    // First run: deposit_for leg times out (stays submitted).
    const api1 = makeApi({ states: { "tx-3": ["INITIATED"] } });
    const deps1 = makeDeps(api1, legs, {
      confirm: { pollDelayMs: 0, timeoutMs: 0, sleep: async () => {} }, // instant timeout
    });
    // fund+approve confirm instantly; deposit stays INITIATED → timeout error.
    await expect(runCircleBridge(deps1, 1_000_000n)).rejects.toThrow(/not confirmed within/);
    expect(legs.legsOf("e:1:b1").map((r) => r.state)).toEqual([
      "confirmed",
      "confirmed",
      "submitted",
    ]);

    // Second run (same amount): only the third leg is re-submitted — with the SAME deterministic
    // key (attempt unchanged), so Circle replays the original tx rather than firing a new one.
    const api2 = makeApi();
    const deps2 = makeDeps(api2, legs, {
      available: async () => {
        throw new Error("resume must not re-run the cap checks");
      },
      standingExposure: async () => {
        throw new Error("resume must not re-run the ceiling checks");
      },
    });
    const hashes = await runCircleBridge(deps2, 1_000_000n);
    expect(api2.submits).toHaveLength(1);
    expect(api2.submits[0]!.idempotencyKey).toBe(
      deterministicIdempotencyKey("e:1:b1:deposit_for:0"),
    );
    expect(hashes).toHaveLength(3); // stored hashes for legs 1+2, fresh for leg 3
  });

  test("in-flight bridge with a DIFFERENT amount refuses with a structured error", async () => {
    const legs = makeLegs();
    const api1 = makeApi({ states: { "tx-1": ["INITIATED"] } });
    await expect(
      runCircleBridge(
        makeDeps(api1, legs, { confirm: { pollDelayMs: 0, timeoutMs: 0, sleep: async () => {} } }),
        1_000_000n,
      ),
    ).rejects.toThrow(/not confirmed/);

    const api2 = makeApi();
    await expect(runCircleBridge(makeDeps(api2, legs), 2_000_000n)).rejects.toThrow(
      BridgeInFlightError,
    );
    await expect(runCircleBridge(makeDeps(api2, legs), 2_000_000n)).rejects.toThrow(
      /bridge-in-flight/,
    );
    expect(api2.submits).toHaveLength(0); // nothing moved
  });

  test("FAILED leg is marked failed; the retry bumps the attempt and derives a FRESH key", async () => {
    const legs = makeLegs();
    const api1 = makeApi({ states: { "tx-1": ["FAILED"] } });
    await expect(runCircleBridge(makeDeps(api1, legs), 1_000_000n)).rejects.toThrow(
      /terminal state FAILED/,
    );
    expect(legs.legsOf("e:1:b1")[0]!.state).toBe("failed");

    const api2 = makeApi();
    await runCircleBridge(makeDeps(api2, legs), 1_000_000n);
    // First submit on retry must carry attempt 1 (the attempt-0 key is burned by the FAILED tx).
    expect(api2.submits[0]!.idempotencyKey).toBe(
      deterministicIdempotencyKey("e:1:b1:fund_operator:1"),
    );
    expect(legs.legsOf("e:1:b1").map((r) => r.state)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
    ]);
  });

  test("new bridge refuses over-available and over-ceiling requests before anything moves", async () => {
    const legs = makeLegs();
    const api = makeApi();
    await expect(
      runCircleBridge(makeDeps(api, legs, { available: async () => 10n }), 1_000_000n),
    ).rejects.toThrow(/exceeds available/);
    await expect(
      runCircleBridge(
        makeDeps(api, legs, {
          standingExposure: async () => ({
            operatorEoa: 4_500_000n,
            pocketEoa: 0n,
            gateway: 0n,
            total: 4_500_000n,
          }),
        }),
        1_000_000n,
      ),
    ).rejects.toThrow(/float-ceiling-exceeded/);
    expect(api.submits).toHaveLength(0);
    expect(legs.findIncomplete("e:1")).toBeUndefined(); // no orphan saga rows
  });

  test("records gas_sponsorship from confirmed-tx network fees (observes, never gates)", async () => {
    const legs = makeLegs();
    const api = makeApi();
    const recorded: { path: string; amount: bigint; ref: string | null }[] = [];
    await runCircleBridge(
      makeDeps(api, legs, {
        outflows: {
          record: (path, amount, ref) => {
            recorded.push({ path, amount, ref });
          },
        },
      }),
      1_000_000n,
    );
    // networkFee "0.001" USDC → 1000 atomic, one per leg.
    expect(recorded).toEqual([
      { path: "gas_sponsorship", amount: 1_000n, ref: "tx-1" },
      { path: "gas_sponsorship", amount: 1_000n, ref: "tx-2" },
      { path: "gas_sponsorship", amount: 1_000n, ref: "tx-3" },
    ]);
  });
});
