# fund_pocket Bridge Robustness (PR #32) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `fund_pocket` bridge survive the read-after-write RPC race the gas-seed exposed, and make a retry safe (no double-pull) for the current EOA flow.

**Architecture:** Two tactical fixes in `src/payments/funding.ts` + `src/agent/liveRunner.ts`: (1) retry the forward/deposit legs on transient insufficient-balance reverts; (2) skip `fundOperator` when the operator already holds the credit. Superseded post-hackathon by the v2 smart-account migration.

**Tech Stack:** TypeScript, viem, vitest, Biome. Backend at `back/backend` (no build; `tsx`). No config/schema/dependency changes.

## Global Constraints

- **Retry is scoped to insufficient-balance reverts ONLY** — match `/exceeds balance|insufficient|transfer amount exceeds/i`. Those errors mean the tx moved **no** funds (pre-write simulate revert or a no-op on-chain revert), so a retry cannot double-spend; a real transfer never emits them, and a lost-receipt/timeout is a different error → rethrown, not retried.
- Retry reuses `topUpPocket`'s existing `pollAttempts` / `pollDelayMs` / `sleep` knobs (defaults 12 / 1500ms).
- **`fundOperator` runs exactly once per `fund_pocket(amount)`** (it's the governed treasury debit; the seed is platform gas, not the agent's money). Skip it only when the operator already holds the credit: `operatorUsdcBalance >= usdToUnits(cfg.gasSeedTargetUsdc) + amount / 2n`.
- On skip: `topUpPocket` skips `fundOperator` **and** the `available`/cap check **and** `awaitOperatorFunded`, and returns `[forward, deposit]` (2 hashes); otherwise `[fundOperator, forward, deposit]` (3). `fundPocket` still returns `[...seedTxs, ...bridgeTxs]`.
- Run `npx biome check src test` + `npx tsc --noEmit` clean per task. TDD; commit per task.

---

## File Structure

- `src/payments/funding.ts` (modify) — Task 1: `retryOnStaleBalance` + wrap forward/deposit; Task 2: `TopUpOptions.skipFundOperator` + conditional fundOperator.
- `src/agent/liveRunner.ts` (modify) — Task 2: `fundPocket` computes `skipFundOperator` and passes it.
- `test/payments/funding.test.ts` (modify) — both tasks.

Task order: **1 (race retry) → 2 (skip guard)**.

---

### Task 1: retry the forward/deposit on a stale-balance revert

**Files:**
- Modify: `src/payments/funding.ts` (`topUpPocket` at 55-74)
- Test: `test/payments/funding.test.ts`

**Interfaces:**
- Produces: `retryOnStaleBalance<T>(fn: () => Promise<T>, opts: { attempts: number; delayMs: number; sleep: (ms: number) => Promise<void> }): Promise<T>` (exported); `topUpPocket` unchanged signature/return (`Promise<Hex[]>` = 3 hashes), now retry-wrapped on the forward + deposit.

- [ ] **Step 1: Write the failing tests**

Append to `test/payments/funding.test.ts` (it already imports `topUpPocket`; add `retryOnStaleBalance` to that import from `../../src/payments/funding`):

```ts
test("retryOnStaleBalance retries a stale-balance revert then returns", async () => {
  let n = 0;
  const r = await retryOnStaleBalance(
    async () => {
      n++;
      if (n < 3) throw new Error("ERC20: transfer amount exceeds balance");
      return "ok";
    },
    { attempts: 5, delayMs: 1, sleep: noSleep },
  );
  expect(r).toBe("ok");
  expect(n).toBe(3);
});

test("retryOnStaleBalance rethrows a non-transient error immediately", async () => {
  let n = 0;
  await expect(
    retryOnStaleBalance(
      async () => {
        n++;
        throw new Error("nonce too low");
      },
      { attempts: 5, delayMs: 1, sleep: noSleep },
    ),
  ).rejects.toThrow(/nonce too low/);
  expect(n).toBe(1);
});

test("retryOnStaleBalance rethrows after exhausting attempts", async () => {
  let n = 0;
  await expect(
    retryOnStaleBalance(
      async () => {
        n++;
        throw new Error("exceeds balance");
      },
      { attempts: 3, delayMs: 1, sleep: noSleep },
    ),
  ).rejects.toThrow(/exceeds balance/);
  expect(n).toBe(3);
});

test("topUpPocket retries the forward when it transiently reverts on a stale-balance read", async () => {
  let calls = 0;
  const d = deps({
    operatorTransferUsdc: vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("ERC20: transfer amount exceeds balance");
      return "0xxfer" as const;
    }),
  });
  const hashes = await topUpPocket(d, 250_000n, { sleep: noSleep });
  expect(calls).toBe(2);
  expect(hashes).toEqual(["0xfund", "0xxfer", "0xdeposit"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd back/backend && npx vitest run test/payments/funding.test.ts`
Expected: FAIL — `retryOnStaleBalance` is not exported; the topUpPocket retry test throws on the first forward call (no retry yet).

- [ ] **Step 3: Implement `retryOnStaleBalance`**

In `src/payments/funding.ts`, add after the `defaultSleep` const (line 25):

```ts
/** Retry `fn` on a transient read-after-write revert (a lagging RPC eth_call seeing stale balance).
 *  Retry is scoped to insufficient-balance reverts ONLY — those mean the tx moved no funds (a
 *  pre-write simulate revert, or a no-op on-chain revert), so a retry cannot double-spend. A tx that
 *  actually transferred never produces this message; a lost-receipt/timeout is a different error and
 *  is rethrown (not retried). */
export async function retryOnStaleBalance<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; delayMs: number; sleep: (ms: number) => Promise<void> },
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      const transient = /exceeds balance|insufficient|transfer amount exceeds/i.test(msg);
      if (!transient || i === opts.attempts - 1) throw e;
      await opts.sleep(opts.delayMs);
    }
  }
  throw last;
}
```

- [ ] **Step 4: Wrap the forward + deposit in `topUpPocket`**

Replace the tail of `topUpPocket` (lines 63-73) — keep `fundOperator` + `awaitOperatorFunded` unchanged, wrap the forward + deposit:

```ts
  const attempts = opts.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const delayMs = opts.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const fundHash = await d.fundOperator(d.treasury, amount);
  await awaitOperatorFunded(d.operatorUsdcBalance, amount, attempts, delayMs, sleep);
  const forwardHash = await retryOnStaleBalance(
    () => d.operatorTransferUsdc(d.usdc, d.pocketAddress, amount),
    { attempts, delayMs, sleep },
  );
  const depositHash = await retryOnStaleBalance(
    () => d.depositToGateway(formatUnits(amount, 6)),
    { attempts, delayMs, sleep },
  );
  return [fundHash, forwardHash, depositHash];
```

(The `if (amount <= 0n)` and `available`/cap guards at 60-62 stay above this, unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd back/backend && npx vitest run test/payments/funding.test.ts`
Expected: PASS (existing order/amount tests + the 4 new ones).

- [ ] **Step 6: Verify types + lint**

Run: `cd back/backend && npx tsc --noEmit && npx biome check src test`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd back/backend && git add src/payments/funding.ts test/payments/funding.test.ts
git commit -m "fix(fund_pocket): retry the forward/deposit on transient stale-balance reverts (#32)"
```

---

### Task 2: skip fundOperator when the operator already holds the credit

**Files:**
- Modify: `src/payments/funding.ts` (`TopUpOptions` at 17-21, `topUpPocket` at 55-74)
- Modify: `src/agent/liveRunner.ts` (`fundPocket`, after the gas-seed at ~206, the `topUpPocket` call at ~208)
- Test: `test/payments/funding.test.ts`

**Interfaces:**
- Consumes: `retryOnStaleBalance` + retry-wrapped `topUpPocket` from Task 1; `usdToUnits(s: string): bigint` from `src/policy/units.ts`; `Config.gasSeedTargetUsdc: string`; `ArcAdapter.usdcBalanceOf`.
- Produces: `TopUpOptions.skipFundOperator?: boolean`; `topUpPocket` returns `[forward, deposit]` (2) when skipping, `[fundOperator, forward, deposit]` (3) otherwise.

- [ ] **Step 1: Write the failing test**

Append to `test/payments/funding.test.ts`:

```ts
test("skipFundOperator skips the treasury pull + cap check and returns [forward, deposit]", async () => {
  const d = deps({ fundOperator: vi.fn(async () => "0xfund" as const) });
  const hashes = await topUpPocket(d, 250_000n, { sleep: noSleep, skipFundOperator: true });
  expect(d.fundOperator).not.toHaveBeenCalled();
  expect(d.operatorTransferUsdc).toHaveBeenCalledWith(usdc, pocket, 250_000n);
  expect(hashes).toEqual(["0xxfer", "0xdeposit"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back/backend && npx vitest run test/payments/funding.test.ts`
Expected: FAIL — `fundOperator` is still called and the return has 3 hashes.

- [ ] **Step 3: Add the option + conditional in `topUpPocket`**

In `src/payments/funding.ts`, add to `TopUpOptions` (after `sleep?` at line 20):

```ts
  /** When true, the operator already holds the fundOperator credit (a retry completing a partial
   *  bridge) — skip fundOperator + the cap check + awaitOperatorFunded so the treasury isn't
   *  double-pulled. Returns [forward, deposit] (2 hashes) instead of [fundOperator, forward, deposit]. */
  skipFundOperator?: boolean;
```

Rewrite `topUpPocket`'s body (lines 60-73) so the fund leg is conditional:

```ts
  if (amount <= 0n) throw new Error("top-up amount must be positive");
  const attempts = opts.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  const delayMs = opts.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const bridge: Hex[] = [];
  if (!opts.skipFundOperator) {
    const available = await d.available();
    if (amount > available) throw new Error(`top-up ${amount} exceeds available ${available}`);
    const fundHash = await d.fundOperator(d.treasury, amount);
    await awaitOperatorFunded(d.operatorUsdcBalance, amount, attempts, delayMs, sleep);
    bridge.push(fundHash);
  }
  const forwardHash = await retryOnStaleBalance(
    () => d.operatorTransferUsdc(d.usdc, d.pocketAddress, amount),
    { attempts, delayMs, sleep },
  );
  const depositHash = await retryOnStaleBalance(
    () => d.depositToGateway(formatUnits(amount, 6)),
    { attempts, delayMs, sleep },
  );
  bridge.push(forwardHash, depositHash);
  return bridge;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back/backend && npx vitest run test/payments/funding.test.ts`
Expected: PASS (skip test + all Task 1 tests + existing tests).

- [ ] **Step 5: Compute + pass `skipFundOperator` in `fundPocket`**

In `src/agent/liveRunner.ts`, add the `usdToUnits` import (with the other `../policy/...` imports):

```ts
import { usdToUnits } from "../policy/units";
```

In `fundPocket`, after the `ensureNativeGas(...)` call returns `seedTxs` (~line 206) and before the `topUpPocket(...)` call, compute the skip flag:

```ts
  // Retry-safety (#32): if the operator already holds the fundOperator credit (a re-run completing a
  // partial bridge), skip re-pulling from the treasury. The gas-seed lands the operator at
  // gasSeedTarget; a landed credit pushes it to ~gasSeedTarget + amount (minus small gas), so the
  // amount/2 margin cleanly distinguishes "seeded only" from "seeded + credit".
  const seedTargetAtomic = usdToUnits(cfg.gasSeedTargetUsdc);
  const operatorBalance = await adapter.usdcBalanceOf(cfg.usdc, operatorAddress);
  const skipFundOperator = operatorBalance >= seedTargetAtomic + floatAtomic / 2n;
```

Then add `{ skipFundOperator }` as the third argument to the `topUpPocket(...)` call. The call currently ends `}, floatAtomic);` — change it to `}, floatAtomic, { skipFundOperator });`.

- [ ] **Step 6: Verify everything**

Run: `cd back/backend && npx vitest run test/payments/funding.test.ts && npx tsc --noEmit && npx biome check src test`
Expected: pass, tsc clean, biome clean.

- [ ] **Step 7: Commit**

```bash
cd back/backend && git add src/payments/funding.ts src/agent/liveRunner.ts test/payments/funding.test.ts
git commit -m "fix(fund_pocket): skip fundOperator when operator already holds the credit (retry-safe) (#32)"
```

---

## Post-implementation (controller)

Full suite once: `cd back/backend && npx vitest run && npx tsc --noEmit && npx biome check src test`. Then deploy to the VPS + re-run `fund_pocket` on TestGasSeed_MB1 (its operator holds 0.298 ≥ 0.25 → skips fundOperator, retries ride out any lag → completes the stranded bridge).

## Self-Review

**Spec coverage:** race retry → Task 1 ✓; skip guard + fundPocket compute → Task 2 ✓; message-scoped safety → Task 1 constant + Global Constraints ✓; skip threshold `usdToUnits(gasSeedTarget) + amount/2` → Task 2 ✓; 2-vs-3 hash return → Task 2 ✓.

**Placeholder scan:** none — complete code + exact commands per step.

**Type consistency:** `retryOnStaleBalance<T>(fn, {attempts, delayMs, sleep})` identical in Task 1 impl, its use in `topUpPocket`, and the tests. `TopUpOptions.skipFundOperator?: boolean` matches the `topUpPocket` conditional and the `fundPocket` call site. `usdToUnits(cfg.gasSeedTargetUsdc)` (6-dec) compared against `operatorUsdcBalance` (6-dec) + `floatAtomic/2n` — all 6-dec atomic bigints. `topUpPocket` return stays `Promise<Hex[]>` (2 or 3 entries).
