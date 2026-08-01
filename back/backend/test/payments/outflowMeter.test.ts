import Database from "better-sqlite3";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildOutflowMeter, meterTurnkeyAccount } from "../../src/payments/outflowMeter";
import { migrate } from "../../src/persistence/db";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
});

const HOUR = 3_600_000;

describe("platform outflow meter", () => {
  test("windowSum counts only rows inside the rolling window (boundary exact)", () => {
    let now = 100 * HOUR;
    const m = buildOutflowMeter(db, {
      ceilingAtomic: 200_000_000n,
      windowMs: 24 * HOUR,
      now: () => now,
    });
    m.record("fund_treasury", 10_000_000n, "tx1");
    now += 24 * HOUR; // the first row is now EXACTLY window-old -> out
    m.record("gas_seed", 400_000n, "tx2");
    expect(m.windowSum()).toBe(400_000n);
  });

  test("check refuses when amount would cross the ceiling, allows at exactly the ceiling", () => {
    const m = buildOutflowMeter(db, {
      ceilingAtomic: 1_000_000n,
      windowMs: 24 * HOUR,
      now: () => 0,
    });
    m.record("fund_treasury", 600_000n, null);
    expect(() => m.check(400_000n)).not.toThrow(); // 600k + 400k == ceiling: allowed
    m.record("fund_treasury", 400_000n, null);
    expect(() => m.check(1n)).toThrow(/platform-outflow-ceiling/);
  });

  test("all four paths land in one table with 6-dec atomic amounts", () => {
    const m = buildOutflowMeter(db, {
      ceilingAtomic: 200_000_000n,
      windowMs: 24 * HOUR,
      now: () => 0,
    });
    for (const p of ["fund_treasury", "gas_seed", "job_fund", "cli_fund"] as const)
      m.record(p, 1_000n, null);
    expect(m.windowSum()).toBe(4_000n);
  });
});

describe("meterTurnkeyAccount — every enclave signature is billable and must be visible", () => {
  function fakeAccount() {
    return {
      address: "0xE38cA1e5D5ac9d9A609eA1ed20e70d60F6AcAb55",
      signTransaction: vi.fn(async (_tx?: unknown) => "0xsigTx"),
      signMessage: vi.fn(async (_m?: unknown) => "0xsigMsg"),
      signTypedData: vi.fn(async (_d?: unknown) => "0xsigTyped"),
    };
  }

  test("each sign call records one turnkey_sigs row and still returns the signature", async () => {
    const m = buildOutflowMeter(db, { ceilingAtomic: 1n, windowMs: HOUR, now: () => 1_700_000 });
    const acc = fakeAccount();
    const wrapped = meterTurnkeyAccount(acc as never, "delegated", m) as unknown as ReturnType<
      typeof fakeAccount
    >;
    expect(await wrapped.signTransaction({} as never)).toBe("0xsigTx");
    expect(await wrapped.signMessage({} as never)).toBe("0xsigMsg");
    expect(m.turnkeySigCountSince(0)).toBe(2);
    expect(acc.signTransaction).toHaveBeenCalledTimes(1);
  });

  test("a metering failure NEVER blocks the signature (the meter observes, it does not gate)", async () => {
    const broken = {
      record: () => {
        throw new Error("db locked");
      },
      recordTurnkeySig: () => {
        throw new Error("db locked");
      },
    };
    const acc = fakeAccount();
    const wrapped = meterTurnkeyAccount(
      acc as never,
      "root",
      broken as never,
    ) as unknown as ReturnType<typeof fakeAccount>;
    expect(await wrapped.signTransaction({} as never)).toBe("0xsigTx"); // signature survives
  });

  test("logs each signature (the journald trail is the durable monthly record)", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const m = buildOutflowMeter(db, { ceilingAtomic: 1n, windowMs: HOUR, now: () => 0 });
    const wrapped = meterTurnkeyAccount(
      fakeAccount() as never,
      "delegated",
      m,
    ) as unknown as ReturnType<typeof fakeAccount>;
    await wrapped.signTransaction({} as never);
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("turnkey_sig"));
    expect(line).toBeTruthy();
    expect(line).toContain("delegated");
    spy.mockRestore();
  });
});
