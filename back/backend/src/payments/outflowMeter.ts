import type Database from "better-sqlite3";
import { opsLog } from "../observability/opsLog";

/**
 * S5 — the platform-wide outflow brake and the Turnkey signature meter.
 * Spec + audit corrections: docs/design/2026-08-01-s5-outflow-observability.md.
 *
 * One meter, four paths (`fund_treasury`, `gas_seed`, `job_fund`, `cli_fund`), one rolling-window
 * SUM. Every row is 6-dec atomic USDC — callers normalize BEFORE recording (gas seeds are 18-dec
 * native wei on Arc: divide by 1e12, exact since native IS USDC). S1 caps what one tenant can
 * take; S2 caps one agent's float; this caps what the PLATFORM can bleed per window across
 * everything, because a hundred capped tenants is still an uncapped platform.
 *
 * Turnkey signatures are billable (25/month plan, then per-signature charges), so every enclave
 * signature is also metered: an opsLog line always (journald = the durable monthly trail), plus a
 * `turnkey_sigs` row for an exact in-DB count.
 */
export type OutflowPath =
  | "fund_treasury"
  | "gas_seed"
  | "job_fund"
  | "cli_fund"
  /** Tier-0: Gas Station sponsorship (billed cost+5%) — recorded from UserOp receipts so the
   *  platform brake stays sighted when gas seeds disappear on the circle path. */
  | "gas_sponsorship";

export class OutflowCeilingError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "OutflowCeilingError";
  }
}

export interface OutflowMeter {
  /** Throws OutflowCeilingError when windowSum + amount would EXCEED the ceiling (== is allowed). */
  check(amountAtomic: bigint): void;
  /** Record a successful platform outflow (6-dec atomic; normalize first). Logs it. */
  record(path: OutflowPath, amountAtomic: bigint, ref: string | null): void;
  windowSum(): bigint;
  recordTurnkeySig(kind: string): void;
  turnkeySigCountSince(epochMs: number): number;
}

export function buildOutflowMeter(
  db: Database.Database,
  cfg: { ceilingAtomic: bigint; windowMs: number; now?: () => number },
): OutflowMeter {
  const now = cfg.now ?? Date.now;
  const meter: OutflowMeter = {
    windowSum(): bigint {
      const r = db
        .prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM platform_outflows WHERE at > ?")
        .get(now() - cfg.windowMs) as { total: number | bigint };
      return BigInt(r.total);
    },
    check(amountAtomic: bigint): void {
      const sum = meter.windowSum();
      if (sum + amountAtomic > cfg.ceilingAtomic) {
        opsLog("outflow_rejected", {
          reason: "platform-outflow-ceiling",
          requested: amountAtomic.toString(),
          windowSum: sum.toString(),
          ceiling: cfg.ceilingAtomic.toString(),
        });
        throw new OutflowCeilingError(
          `platform-outflow-ceiling: window total ${sum} + ${amountAtomic} exceeds ${cfg.ceilingAtomic}`,
        );
      }
    },
    record(path: OutflowPath, amountAtomic: bigint, ref: string | null): void {
      db.prepare("INSERT INTO platform_outflows (at, path, amount, ref) VALUES (?,?,?,?)").run(
        now(),
        path,
        amountAtomic,
        ref,
      );
      opsLog("outflow_recorded", { path, amount: amountAtomic.toString(), ref });
    },
    recordTurnkeySig(kind: string): void {
      db.prepare("INSERT INTO turnkey_sigs (at, kind) VALUES (?,?)").run(now(), kind);
    },
    turnkeySigCountSince(epochMs: number): number {
      const r = db.prepare("SELECT COUNT(*) AS n FROM turnkey_sigs WHERE at >= ?").get(epochMs) as {
        n: number;
      };
      return r.n;
    },
  };
  return meter;
}

/** The three signing methods a @turnkey/viem account exposes — each call = one billable
 *  enclave signature. */
const SIGN_METHODS = ["signTransaction", "signMessage", "signTypedData"] as const;

/**
 * Wrap a Turnkey-backed viem account so every enclave signature is visible: an opsLog line
 * always, a `turnkey_sigs` row when a meter is supplied. OBSERVES, NEVER GATES — a metering
 * failure must not block a signature (the meter exists to explain the bill, not to add a new
 * way for payments to fail).
 */
export function meterTurnkeyAccount<T extends Record<string, unknown>>(
  account: T,
  kind: string,
  meter?: Pick<OutflowMeter, "recordTurnkeySig">,
): T {
  const wrapped: Record<string, unknown> = { ...account };
  for (const method of SIGN_METHODS) {
    const original = account[method];
    if (typeof original !== "function") continue;
    wrapped[method] = async (...args: unknown[]) => {
      try {
        opsLog("turnkey_sig", { kind, method, address: (account as { address?: string }).address });
        meter?.recordTurnkeySig(kind);
      } catch {
        // metering is best-effort by design
      }
      return (original as (...a: unknown[]) => unknown).apply(account, args);
    };
  }
  return wrapped as T;
}
