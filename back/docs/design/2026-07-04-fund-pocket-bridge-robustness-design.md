# fund_pocket Bridge Robustness (PR #32) — Design

**Date:** 2026-07-04 · **Area:** `back/backend` (Hono/TS) · **Type:** tactical bug-fix (superseded by the v2 smart-account migration)

Two problems surfaced by the live fresh-agent gas-seed validation (TestGasSeed_MB1): a read-after-write RACE that fails the operator→pocket leg, and a double-pull RETRY hazard. Both are patched here for the current EOA-based flow; the v2 smart-account migration (Gas Station gas + atomic batched UserOps) structurally supersedes both and is out of scope.

## Background (grounded in the live run)

The `fund_pocket` bridge is `treasury → operator → pocket → Gateway`: `fundOperator` (operator-sent) credits the operator from the treasury; `operatorTransferUsdc` (operator-sent) forwards to the pocket; `depositToGateway` (pocket-sent) deposits to Circle Gateway. On Arc, native gas **is** the `0x3600` ERC-20 USDC (same asset, 18-dec native ⇄ 6-dec ERC-20), so PR #31's gas-seed credits the operator/pocket USDC balances.

- **`fundOperator` and `operatorTransferUsdc` already `await waitForTransactionReceipt`** (`arcAdapter.ts:253,268`). So when the forward runs, the fundOperator credit is genuinely **mined** — verified live (operator held 0.297851 = 0.2 seed + 0.1 credit − gas).
- **The failure is `operatorTransferUsdc`'s `simulateContract`** (`arcAdapter.ts:260`, an `eth_call`) hitting a **read-replica RPC node that lags the mined state** → `ERC20: transfer amount exceeds balance` even though the funds are on-chain.
- **`awaitOperatorFunded` was meant to buffer this** but the seed defeats it: it waits until `operatorUsdcBalance >= amount`, and the seed alone (0.2) satisfies that instantly → zero propagation buffer. Leg 3's 20-USDC faucet masked the race (20 ≫ any lag).
- **Double-pull:** `topUpPocket` always calls `fundOperator(amount)`, so re-running `fund_pocket` after a mid-bridge failure pulls a *second* `amount` from the treasury; a naive "is the operator funded?" check is confounded by the seed.

## Problem 1 — the read-lag race (fix: retry the forward/deposit on transient revert)

Because `fundOperator` already awaits its receipt, the funds are provably present — the only issue is a lagging `eth_call`. So wrap `operatorTransferUsdc` and `depositToGateway` in a **bounded retry** that re-attempts on a transient "insufficient/exceeds balance" revert, reusing `topUpPocket`'s existing `pollAttempts`/`pollDelayMs`/`sleep` knobs.

New helper in `src/payments/funding.ts`:

```ts
/** Retry `fn` on a transient read-after-write revert (a lagging RPC eth_call seeing stale balance).
 *  Retry is scoped to insufficient-balance reverts ONLY — those mean the tx moved no funds (a
 *  pre-write simulate revert, or a no-op on-chain revert), so a retry cannot double-spend. A tx
 *  that actually transferred never produces this message; a lost-receipt/timeout is a different
 *  error and is rethrown (not retried). */
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

`topUpPocket` wraps the forward + deposit calls in it. **Double-spend safety rests on the error-message scoping, not on re-simulation** (the seed surplus means a re-simulate could wrongly succeed): the retry fires *only* on an insufficient-balance revert, which is emitted exactly when the operation moved **no** funds — either the pre-write `simulateContract` `eth_call` reverted, or the tx reverted on-chain with no state change. A transfer that actually succeeded never produces that message; a landed-but-unconfirmed write surfaces as a timeout/other error and is **rethrown, not retried**. `awaitOperatorFunded` is left as-is (a harmless fast-path now backstopped by the retry).

## Problem 2 — retry-safety (fix: balance-aware skip guard, 2a)

`fundOperator` must run **exactly once** per `fund_pocket(amount)` (it's the governed treasury debit; the seed is platform gas, not the agent's money — so we cannot fund the pocket from the seed). To make a retry safe, **skip `fundOperator` when the operator already holds the credit**:

- In `fundPocket`, after the gas-seed, read the operator's USDC balance and compute:
  `skipFundOperator = operatorUsdcBalance >= seedTargetAtomic + amount / 2n`
  where `seedTargetAtomic = usdToUnits(cfg.gasSeedTargetUsdc)` (the 6-dec equivalent of the seed target; the operator reads at the seed target when only seeded, and at `seedTarget + amount − gas` once the credit has landed). The `amount / 2n` margin cleanly separates the two states while tolerating gas (holds for `amount > 2×fundOperator-gas`, i.e. any realistic amount ≥ ~0.01 USDC).
- Pass `skipFundOperator` into `topUpPocket` via a new opt. When true, it skips `fundOperator` + `awaitOperatorFunded` and returns `[forward, deposit]` (2 bridge hashes); otherwise `[fundOperator, forward, deposit]` (3). Seed hashes from #1 still prepend.

**Bonus:** this un-strands **TestGasSeed_MB1** — a re-run of `fund_pocket` on it will skip `fundOperator` (operator holds 0.298 ≥ 0.25) and complete the forward + deposit from the already-credited operator.

### Documented limitations (tactical patch; v2 removes them)
- Handles the "`fundOperator` done, forward pending" partial state (the common one, and our stranded case). It does **not** resolve a "forward done, deposit pending" partial (operator balance would have dropped back to ~seed, so the guard sees "not funded" and re-pulls). Rare; funds remain on the agent's own keys.
- The threshold assumes the operator carries no unrelated residual above the seed target; a stale residual could cause a false skip. Acceptable for the demo.
- **v2 supersedes both problems:** ERC-4337 smart accounts + Gas Station make gas sponsored (no seed → no balance pollution) and let `fundOperator`+forward+deposit batch into **one atomic UserOp** — no inter-leg read-lag and no partial state, so neither the race nor the double-pull can occur.

## Interfaces / files

- `src/payments/funding.ts`: add `retryOnStaleBalance`; `topUpPocket` gains `opts.skipFundOperator?: boolean`, wraps forward/deposit in the retry, and conditionally skips `fundOperator`/`awaitOperatorFunded`; returns 2 or 3 bridge hashes.
- `src/agent/liveRunner.ts` `fundPocket`: after `ensureNativeGas`, read the operator USDC balance, compute `skipFundOperator` (using `usdToUnits(cfg.gasSeedTargetUsdc)`), pass it into `topUpPocket`. Return `[...seedTxs, ...bridgeTxs]` unchanged.
- No config or schema changes; no new deps.

## Testing

- `retryOnStaleBalance` (unit): transient revert → retries then succeeds; non-transient error → rethrows immediately; exhausts attempts → rethrows last. Injected `sleep` (no wall-clock).
- `topUpPocket` (extend `funding.test.ts`): `skipFundOperator:true` → `fundOperator` NOT called, returns `[forward, deposit]`; a fake `operatorTransferUsdc` that throws "exceeds balance" once then succeeds → the forward retries and the bridge completes; existing order/amount tests unchanged.

`npx biome check src test` + `npx tsc --noEmit` clean per task.

## Non-goals / roadmap
- The v2 EOA→smart-account migration (Gas Station + batched atomic UserOps) — the structural fix; a separate post-hackathon project, gated on verifying Circle smart-account/Gas-Station/ERC-1271/EIP-3009 support on Arc.
- Full resumable-saga idempotency for all partial states (superseded by v2 batching).
- `fund_pocket` idempotency-key plumbing (not needed once #1 makes mid-bridge failure rare).
