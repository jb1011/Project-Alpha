# S2 Interim Float-Ceiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hard-bound each agent's un-clawback-able x402 standing float to a configured ceiling (default 1.00 USDC), close the legal-status gap in the off-chain payment gate, and correct the dashboard/doc framing — all with no contract change.

**Architecture:** Enforce a per-agent standing-exposure ceiling (operator EOA + pocket EOA + Gateway) at the single funding choke point `topUpPocket`, backed by a new config var + boot-time invariant and a shared `readStandingExposure` reader; serialize per-agent top-ups with an in-process keyed mutex; make the liveRunner's leg-0 fund "fund-to-target" so the ceiling can't wedge it; add a legal-status check to `evaluatePolicy`; and rewrite the dashboard "Active rules" copy honestly. Full source: `back/docs/design/2026-07-20-s2-interim-float-ceiling-design.md`.

**Tech Stack:** TypeScript, viem, vitest, Biome, Zod. Backend at `back/backend` (no build; run via `tsx`; tests `npx vitest run`). Frontend (Next.js/React) at `interface`. No new dependency; no DB migration; no Solidity change.

**Model tiers & review:** Every implementation task is mechanical → **Sonnet** implementer + a per-task **Sonnet** review. After the whole branch is green, one **Opus** final whole-branch review. CI enforces `npx biome check src test` + `npx tsc --noEmit` + `npx vitest run` on every push/PR; each task must leave all three clean.

## Global Constraints

Copied verbatim from the spec — every task's requirements implicitly include these:

- **Config default:** `MAX_POCKET_FLOAT_USDC` defaults to `"1.00"`.
- **Boot invariant (fail-closed):** `ceiling ≥ FUNDING_FLOAT_USDC + 2×GAS_SEED_TARGET_USDC`, computed in atomic USDC via `usdToUnits`. `k = 2` because both the operator EOA and the pocket EOA are gas-seeded to `GAS_SEED_TARGET_USDC` and `readStandingExposure` counts both. `loadConfig` throws if violated.
- **Atomic bigint everywhere:** all balances, ceilings, and comparisons are atomic USDC (6-decimal) `bigint`. Gateway's decimal `getAvailable()` is converted with the conservative floor `BigInt(Math.floor(available * 1e6))` (mirrors `entityPayment.ts`) — never round up into float we don't have.
- **Reject, not clamp:** the MCP `fund_pocket` path (via `topUpPocket`) rejects an over-ceiling top-up with a structured error `{error:"float-ceiling-exceeded", standing, breakdown, requested, ceiling}`; it never silently clamps. Only the liveRunner's automatic leg-0 fund becomes fund-to-target.
- **Enforce ONLY in the `!skipFundOperator` branch:** the ceiling check runs before `fundOperator`, next to the existing `available()` check; it is skipped on the `skipFundOperator` retry path (completing a stranded bridge moves already-escaped funds and does not raise total exposure).
- **Single-process mutex:** the per-agent lock is in-process only (single-VPS / SQLite deployment). Not a cross-process lock.
- **No contract change, no DB migration.** `AgentTreasury.sol` is untouched; `fundOperator` stays allowlist-exempt / per-tx-uncapped on-chain and is bounded here in software.
- `treasury_status.float` stays = spendable Gateway balance (what `pay` preflights); the honest total is surfaced as a **new** `standing` field. Do not redefine `float`.

---

## File Structure

**Create:**
- `back/backend/src/payments/standingExposure.ts` — `StandingExposure` type + `readStandingExposure(deps)`; sums operator EOA + pocket EOA + Gateway to atomic total. (T1)
- `back/backend/src/payments/keyedMutex.ts` — `withKeyedLock(key, fn)`; serializes async work per key in-process. (T2)
- `back/backend/test/config/floatCeiling.test.ts` — config default + invariant-throw tests. (T1)
- `back/backend/test/payments/standingExposure.test.ts` — sum/floor tests. (T1)
- `back/backend/test/payments/keyedMutex.test.ts` — serialization tests. (T2)

**Modify:**
- `back/backend/src/config/env.ts` — add `MAX_POCKET_FLOAT_USDC` env + `maxPocketFloatUsdc` Config field + boot invariant. (T1)
- `back/backend/src/payments/entityPayment.ts` — `TreasuryStatusView.standing` + injectable `readExposure` seam + `TreasuryReader.legalStatus` + `legalActive` in the `readTreasury` closure. (T1 for `standing`; T4 for `legalStatus`/`legalActive`)
- `back/backend/src/payments/funding.ts` — `FundingDeps` gains `standingExposure` + `ceiling`; `topUpPocket` adds the ceiling gate in the `!skipFundOperator` branch. (T3)
- `back/backend/src/agent/liveRunner.ts` — `fundPocket` wraps its body in `withKeyedLock` and wires `standingExposure`/`ceiling` into `topUpPocket`; `buildLiveAgentRunner` uses new exported `fundToTarget` for leg-0. (T3); `readTreasury` closure gains `legalActive`. (T4)
- `back/backend/src/payments/authority.ts` — `TreasuryState.legalActive` passed to `evaluatePolicy`. (T4)
- `back/backend/src/payments/policyGate.ts` — `PolicyInput.legalActive` + `"legal-not-active"` reason + the check. (T4)
- `back/backend/test/payments/funding.test.ts` — extend `deps()` + ceiling tests. (T3)
- `back/backend/test/agent/liveRunner.test.ts` — `fundToTarget` tests. (T3)
- `back/backend/test/payments/policyGate.test.ts` — `legalActive` in `base` + legal tests. (T4)
- `back/backend/test/payments/authority.test.ts` — `legalActive:true` in the `readTreasury` default. (T4)
- `back/backend/test/payments/entityPayment.test.ts` — Config fixture `maxPocketFloatUsdc`; `makeReader` gains `legalStatus`; `standing` + legal-suspension tests. (T1 + T4)
- `back/backend/test/jobs/composition.test.ts` — Config fixture gains `maxPocketFloatUsdc`. (T1)
- `interface/src/components/agents/AgentDashboard.tsx` — rewrite the "Active rules" card. (T5)
- `back/docs/design/2026-06-28-honest-dashboard-design.md`, `back/docs/Novi-Corpus-V2-Roadmap.html` — corrected framing. (T5)

**Task order (by dependency):** T1 (foundation: config + exposure reader + status) → T2 (mutex utility) → T3 (ceiling gate + fund-to-target; consumes T1 type + T2 lock) → T4 (legal-status gate) → T5 (copy + docs).

---

### Task 1: Config var + boot invariant + `readStandingExposure` + `treasury_status.standing` (spec §D1, §D2)

**Files:**
- Create: `back/backend/src/payments/standingExposure.ts`
- Create: `back/backend/test/payments/standingExposure.test.ts`
- Create: `back/backend/test/config/floatCeiling.test.ts`
- Modify: `back/backend/src/config/env.ts` (EnvSchema ~48, `Config` ~95-143, `loadConfig` `cfg` object ~171-212, invariant block after ~237)
- Modify: `back/backend/src/payments/entityPayment.ts` (`TreasuryStatusView` 25-34, `EntityPaymentDeps` 48-57, `buildEntityPaymentService` 78-154)
- Modify: `back/backend/test/payments/entityPayment.test.ts` (`makeConfig` literal ~19-63; new `standing` test)
- Modify: `back/backend/test/jobs/composition.test.ts` (Config literal — add one field)

**Interfaces:**
- Produces:
  - `interface StandingExposure { operatorEoa: bigint; pocketEoa: bigint; gateway: bigint; total: bigint }`
  - `interface StandingExposureDeps { usdcBalanceOf: (owner: Address) => Promise<bigint>; gatewayAvailable: () => Promise<number>; operator: Address; pocket: Address }`
  - `readStandingExposure(d: StandingExposureDeps): Promise<StandingExposure>`
  - `Config.maxPocketFloatUsdc: string` (decimal string; env `MAX_POCKET_FLOAT_USDC`, default `"1.00"`)
  - `TreasuryStatusView.standing: { operatorEoa: string; pocketEoa: string; gateway: string; total: string; ceiling: string }`
  - `EntityPaymentDeps.readExposure?: (entity: EntityRecord) => Promise<StandingExposure>`
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing `readStandingExposure` test**

Create `back/backend/test/payments/standingExposure.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { readStandingExposure } from "../../src/payments/standingExposure";
import type { Address } from "../../src/types";

const OPERATOR = `0x${"b".repeat(40)}` as Address;
const POCKET = `0x${"c".repeat(40)}` as Address;

test("sums operator EOA + pocket EOA + Gateway into an atomic total", async () => {
  const balances: Record<string, bigint> = { [OPERATOR]: 200_000n, [POCKET]: 200_000n };
  const s = await readStandingExposure({
    usdcBalanceOf: async (owner) => balances[owner] ?? 0n,
    gatewayAvailable: async () => 0.5, // decimal USDC
    operator: OPERATOR,
    pocket: POCKET,
  });
  expect(s).toEqual({
    operatorEoa: 200_000n,
    pocketEoa: 200_000n,
    gateway: 500_000n,
    total: 900_000n,
  });
});

test("floors the Gateway decimal conservatively (never rounds up)", async () => {
  const s = await readStandingExposure({
    usdcBalanceOf: async () => 0n,
    gatewayAvailable: async () => 0.4999995, // would be 499999.5 atomic
    operator: OPERATOR,
    pocket: POCKET,
  });
  expect(s.gateway).toBe(499_999n);
  expect(s.total).toBe(499_999n);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd back/backend && npx vitest run test/payments/standingExposure.test.ts`
Expected: FAIL — cannot find module `../../src/payments/standingExposure`.

- [ ] **Step 3: Implement `standingExposure.ts` per spec §D2**

Create `back/backend/src/payments/standingExposure.ts` with the exact module in spec §D2 (the `StandingExposure`/`StandingExposureDeps` interfaces + `readStandingExposure`, `Promise.all` of the three reads, `gateway = BigInt(Math.floor(gwDecimal * 1e6))`, `total = operatorEoa + pocketEoa + gateway`).

- [ ] **Step 4: Run it — verify it passes**

Run: `cd back/backend && npx vitest run test/payments/standingExposure.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing config test**

Create `back/backend/test/config/floatCeiling.test.ts`:

```ts
import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const PK = `0x${"1".repeat(64)}` as const;
const baseEnv = { ARC_TESTNET_RPC_URL: "http://localhost:8545", PLATFORM_PRIVATE_KEY: PK };

test("MAX_POCKET_FLOAT_USDC defaults to 1.00", () => {
  expect(loadConfig(baseEnv).maxPocketFloatUsdc).toBe("1.00");
});

test("default config satisfies ceiling >= float + 2*seedTarget (0.9 <= 1.0)", () => {
  expect(() => loadConfig(baseEnv)).not.toThrow();
});

test("throws when ceiling < float + 2*seedTarget", () => {
  // float 0.9 + 2*0.2 = 1.3 > ceiling 1.0 -> throw
  expect(() =>
    loadConfig({
      ...baseEnv,
      FUNDING_FLOAT_USDC: "0.9",
      GAS_SEED_TARGET_USDC: "0.2",
      MAX_POCKET_FLOAT_USDC: "1.0",
    }),
  ).toThrow(/MAX_POCKET_FLOAT_USDC/);
});

test("passes at the exact boundary (ceiling == float + 2*seedTarget)", () => {
  // 0.9 + 0.4 = 1.3 == ceiling 1.3
  expect(() =>
    loadConfig({
      ...baseEnv,
      FUNDING_FLOAT_USDC: "0.9",
      GAS_SEED_TARGET_USDC: "0.2",
      MAX_POCKET_FLOAT_USDC: "1.3",
    }),
  ).not.toThrow();
});
```

- [ ] **Step 6: Run it — verify it fails**

Run: `cd back/backend && npx vitest run test/config/floatCeiling.test.ts`
Expected: FAIL — `maxPocketFloatUsdc` is `undefined`; no invariant throws.

- [ ] **Step 7: Implement the config var + invariant per spec §D1**

In `back/backend/src/config/env.ts`:
- Add to `EnvSchema` (near line 48): `MAX_POCKET_FLOAT_USDC: z.string().default("1.00"),`
- Add to the `Config` interface (near line 121): `maxPocketFloatUsdc: string;`
- Add to the `cfg` object in `loadConfig` (near line 189): `maxPocketFloatUsdc: e.MAX_POCKET_FLOAT_USDC,`
- After the existing `gasSeedFloor < gasSeedTarget` check (line ~235-237), add the exact invariant block from spec §D1 (`ceilingAtomic = usdToUnits(cfg.maxPocketFloatUsdc)`, `floatAtomic = usdToUnits(cfg.fundingFloatUsdc)`, `seedTargetAtomic = usdToUnits(cfg.gasSeedTargetUsdc)`, throw when `ceilingAtomic < floatAtomic + 2n * seedTargetAtomic`). `usdToUnits` is already imported at the top of the file.

`maxPocketFloatUsdc` is non-secret → no `redact()` change.

- [ ] **Step 8: Run it — verify it passes**

Run: `cd back/backend && npx vitest run test/config/floatCeiling.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 9: Update the two full-Config test fixtures**

The two literal `Config` fixtures must add the new field or `tsc` fails:
- `back/backend/test/payments/entityPayment.test.ts` — in `makeConfig` (the object literal ~19-63), add `maxPocketFloatUsdc: "1.00",`.
- `back/backend/test/jobs/composition.test.ts` — in its Config literal, add `maxPocketFloatUsdc: "1.00",`.

- [ ] **Step 10: Write the failing `treasury_status.standing` test**

Append to `back/backend/test/payments/entityPayment.test.ts` (imports already present; add `type StandingExposure` if referenced — it is not, the fake returns an inline object):

```ts
test("status surfaces the standing exposure breakdown + ceiling", async () => {
  const { reader } = makeReader();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    readPocketFloat: SUFFICIENT_FLOAT,
    readExposure: async () => ({
      operatorEoa: 200_000n,
      pocketEoa: 200_000n,
      gateway: 500_000n,
      total: 900_000n,
    }),
  });
  const view = await svc.status(seedEntity());
  expect(view.standing).toEqual({
    operatorEoa: "200000",
    pocketEoa: "200000",
    gateway: "500000",
    total: "900000",
    ceiling: "1000000", // usdToUnits("1.00")
  });
  // float stays the spendable Gateway balance, NOT the standing total
  expect(view.float).toBe((1_000_000_000n).toString());
});
```

- [ ] **Step 11: Run it — verify it fails**

Run: `cd back/backend && npx vitest run test/payments/entityPayment.test.ts -t "standing exposure breakdown"`
Expected: FAIL — `readExposure` is not a known dep and `view.standing` is `undefined`.

- [ ] **Step 12: Implement `standing` + `readExposure` in `entityPayment.ts` per spec §D2**

In `back/backend/src/payments/entityPayment.ts`:
- Import `usdToUnits` from `../policy/units`, and `readStandingExposure` + `type StandingExposure` from `./standingExposure`.
- Add `standing` to `TreasuryStatusView` (25-34): `standing: { operatorEoa: string; pocketEoa: string; gateway: string; total: string; ceiling: string };`
- Add `readExposure?: (entity: EntityRecord) => Promise<StandingExposure>;` to `EntityPaymentDeps` (48-57).
- In `buildEntityPaymentService`, next to the existing `readPocketFloat` default (85-92), add the `readExposure` default from spec §D2 (derive `pocketKey`, build a `PocketGateway`, call `readStandingExposure` with `usdcBalanceOf: (owner) => deps.reader.usdcBalanceOf(entity.treasuryConfig?.usdc ?? cfg.usdc, owner)`, `gatewayAvailable: () => gateway.getAvailable()`, `operator: entity.operator as Address`, `pocket: gateway.address`).
- In `status()` (126-154): add `readExposure(entity)` to the `Promise.all`, and return `standing: { operatorEoa: exposure.operatorEoa.toString(), pocketEoa: exposure.pocketEoa.toString(), gateway: exposure.gateway.toString(), total: exposure.total.toString(), ceiling: usdToUnits(cfg.maxPocketFloatUsdc).toString() }`. In the `!entity.treasury` early-return (127-136), add `standing: { operatorEoa: "0", pocketEoa: "0", gateway: "0", total: "0", ceiling: usdToUnits(cfg.maxPocketFloatUsdc).toString() }`.

The pay preflight (175-187) is unchanged.

- [ ] **Step 13: Update the three existing `status()` tests (the new `standing` field + real `readExposure` default break them)**

In `back/backend/test/payments/entityPayment.test.ts`:
- **"status: reads the four treasury fields plus the entity's configured cap"** (~313): add `readExposure: async () => ({ operatorEoa: 0n, pocketEoa: 0n, gateway: 0n, total: 0n }),` to the `buildEntityPaymentService` deps (so it does not make a live Gateway call), and add to its `expect(status).toEqual({...})` object the field `standing: { operatorEoa: "0", pocketEoa: "0", gateway: "0", total: "0", ceiling: "1000000" }`.
- **"status: sources the balance read from the entity's own treasury USDC..."** (~338): add the same `readExposure: async () => ({ operatorEoa: 0n, pocketEoa: 0n, gateway: 0n, total: 0n }),` to its deps (its assertion is only on `status.balance`, so no expectation change).
- **"status: an entity with no treasury reads as zeroed-out/not-paused"** (~506): this hits the `!entity.treasury` early return (no `readExposure` call), but its `expect(status).toEqual({...})` must gain `standing: { operatorEoa: "0", pocketEoa: "0", gateway: "0", total: "0", ceiling: "1000000" }`.

(`"1000000"` = `usdToUnits("1.00")`, the ceiling from `makeConfig()`'s `maxPocketFloatUsdc: "1.00"`.)

- [ ] **Step 14: Run the full entityPayment + config suites — verify pass**

Run: `cd back/backend && npx vitest run test/payments/entityPayment.test.ts test/payments/standingExposure.test.ts test/config/floatCeiling.test.ts`
Expected: PASS (all, incl. the three updated status tests).

- [ ] **Step 15: Lint + typecheck + commit**

Run: `cd back/backend && npx biome check src test && npx tsc --noEmit`
Expected: clean.

```bash
git add back/backend/src/payments/standingExposure.ts back/backend/src/config/env.ts \
  back/backend/src/payments/entityPayment.ts back/backend/test/payments/standingExposure.test.ts \
  back/backend/test/config/floatCeiling.test.ts back/backend/test/payments/entityPayment.test.ts \
  back/backend/test/jobs/composition.test.ts
git commit -m "feat(s2): MAX_POCKET_FLOAT_USDC config + invariant + readStandingExposure + treasury_status.standing"
```

---

### Task 2: `withKeyedLock` in-process keyed mutex (spec §D4)

**Files:**
- Create: `back/backend/src/payments/keyedMutex.ts`
- Create: `back/backend/test/payments/keyedMutex.test.ts`

**Interfaces:**
- Produces: `withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T>` — runs same-`key` tasks strictly serially, different keys concurrently; a prior task's rejection does not block the next; the caller receives `fn`'s real result/rejection.
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

Create `back/backend/test/payments/keyedMutex.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { withKeyedLock } from "../../src/payments/keyedMutex";

const tick = () => new Promise((r) => setTimeout(r, 1));

test("same-key tasks run strictly serially (no interleave)", async () => {
  const events: string[] = [];
  const task = (id: string) =>
    withKeyedLock("agentA", async () => {
      events.push(`${id}-start`);
      await tick();
      events.push(`${id}-end`);
    });
  await Promise.all([task("1"), task("2")]);
  expect(events).toEqual(["1-start", "1-end", "2-start", "2-end"]);
});

test("different keys run concurrently", async () => {
  const events: string[] = [];
  const task = (key: string, id: string) =>
    withKeyedLock(key, async () => {
      events.push(`${id}-start`);
      await tick();
      events.push(`${id}-end`);
    });
  await Promise.all([task("A", "a"), task("B", "b")]);
  // both start before either ends
  expect(events.slice(0, 2).sort()).toEqual(["a-start", "b-start"]);
});

test("a prior task's rejection does not block the next same-key task", async () => {
  await expect(
    withKeyedLock("agentA", async () => {
      throw new Error("boom");
    }),
  ).rejects.toThrow(/boom/);
  const r = await withKeyedLock("agentA", async () => "ok");
  expect(r).toBe("ok");
});

test("returns the wrapped function's resolved value", async () => {
  const r = await withKeyedLock("k", async () => 42);
  expect(r).toBe(42);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd back/backend && npx vitest run test/payments/keyedMutex.test.ts`
Expected: FAIL — cannot find module `../../src/payments/keyedMutex`.

- [ ] **Step 3: Implement `keyedMutex.ts` per spec §D4**

Create `back/backend/src/payments/keyedMutex.ts` with the exact module from spec §D4 (module-level `chains = new Map<string, Promise<unknown>>()`; `withKeyedLock` chains on the prior tail with `prev.then(() => fn(), () => fn())`, stores a never-rejecting tail `run.then(() => undefined, () => undefined)`, returns `run`).

- [ ] **Step 4: Run it — verify it passes**

Run: `cd back/backend && npx vitest run test/payments/keyedMutex.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Lint + typecheck + commit**

Run: `cd back/backend && npx biome check src test && npx tsc --noEmit`
Expected: clean.

```bash
git add back/backend/src/payments/keyedMutex.ts back/backend/test/payments/keyedMutex.test.ts
git commit -m "feat(s2): add withKeyedLock in-process per-key mutex"
```

---

### Task 3: Ceiling gate in `topUpPocket` + liveRunner fund-to-target (spec §D3, §D5)

These land together: §D3 introduces the ceiling that would wedge the liveRunner's unconditional leg-0 fund; §D5's fund-to-target is the no-wedge fix. Shipping one without the other regresses the runner.

**Files:**
- Modify: `back/backend/src/payments/funding.ts` (`FundingDeps` 5-14; `topUpPocket` 98-126)
- Modify: `back/backend/src/agent/liveRunner.ts` (`fundPocket` 167-235; `buildLiveAgentRunner` fund callback ~369-405; add exported `fundToTarget`)
- Modify: `back/backend/test/payments/funding.test.ts` (`deps()` helper 13-27; new ceiling tests)
- Modify: `back/backend/test/agent/liveRunner.test.ts` (import `fundToTarget` + `Hex`; new tests)

**Interfaces:**
- Consumes: `StandingExposure` + `readStandingExposure` from Task 1 (`src/payments/standingExposure.ts`); `withKeyedLock` from Task 2 (`src/payments/keyedMutex.ts`).
- Produces:
  - `FundingDeps` gains `standingExposure: () => Promise<StandingExposure>` and `ceiling: bigint`.
  - `topUpPocket(d, amount, opts)` unchanged signature; in the `!opts.skipFundOperator` branch it now throws `Error(JSON.stringify({error:"float-ceiling-exceeded", standing, breakdown, requested, ceiling}))` when `standing.total + amount > d.ceiling`, before calling `fundOperator`.
  - `fundToTarget(target: bigint, d: { readGatewayAtomic: () => Promise<bigint>; fund: (shortfall: bigint) => Promise<Hex[]> }): Promise<Hex[]>` (exported from `src/agent/liveRunner.ts`) — returns `[]` when `available >= target`, else `d.fund(target - available)`.

- [ ] **Step 1: Extend the `deps()` helper + write the failing ceiling tests**

In `back/backend/test/payments/funding.test.ts`, add two fields to the `deps()` helper's returned object (so existing tests still satisfy `FundingDeps`), then append the ceiling tests:

```ts
// inside deps()'s returned object, alongside the existing fields:
    ceiling: 1_000_000_000n, // high default so existing tests are unaffected
    standingExposure: async () => ({
      operatorEoa: 0n,
      pocketEoa: 0n,
      gateway: 0n,
      total: 0n,
    }),
```

```ts
test("rejects a top-up that would push standing over the ceiling (fundOperator not called)", async () => {
  const d = deps({
    ceiling: 1_000_000n,
    standingExposure: async () => ({
      operatorEoa: 200_000n,
      pocketEoa: 200_000n,
      gateway: 300_000n,
      total: 700_000n,
    }),
  });
  await expect(topUpPocket(d, 400_000n, { sleep: noSleep })).rejects.toThrow(
    /float-ceiling-exceeded/,
  );
  expect(d.fundOperator).not.toHaveBeenCalled();
});

test("allows a top-up when standing + amount exactly equals the ceiling (boundary)", async () => {
  const d = deps({
    ceiling: 1_000_000n,
    standingExposure: async () => ({
      operatorEoa: 200_000n,
      pocketEoa: 200_000n,
      gateway: 200_000n,
      total: 600_000n,
    }),
  });
  const hashes = await topUpPocket(d, 400_000n, { sleep: noSleep });
  expect(d.fundOperator).toHaveBeenCalledWith(treasury, 400_000n);
  expect(hashes).toEqual(["0xfund", "0xxfer", "0xdeposit"]);
});

test("does NOT consult the ceiling on the skipFundOperator retry path", async () => {
  const standingExposure = vi.fn(async () => ({
    operatorEoa: 0n,
    pocketEoa: 0n,
    gateway: 2_000_000n,
    total: 2_000_000n, // already over the ceiling
  }));
  const d = deps({ ceiling: 1_000_000n, standingExposure });
  const hashes = await topUpPocket(d, 400_000n, { sleep: noSleep, skipFundOperator: true });
  expect(standingExposure).not.toHaveBeenCalled();
  expect(d.fundOperator).not.toHaveBeenCalled();
  expect(hashes).toEqual(["0xxfer", "0xdeposit"]);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd back/backend && npx vitest run test/payments/funding.test.ts`
Expected: FAIL — `topUpPocket` does not enforce a ceiling (the reject test resolves instead of rejecting; `fundOperator` is called). (TS may also error that `standingExposure`/`ceiling` are not on `FundingDeps` until Step 3.)

- [ ] **Step 3: Add the ceiling gate to `topUpPocket` per spec §D3**

In `back/backend/src/payments/funding.ts`:
- Import `type { StandingExposure }` from `./standingExposure`.
- Add to `FundingDeps` (5-14): `standingExposure: () => Promise<StandingExposure>;` and `ceiling: bigint;`.
- In `topUpPocket`, inside the existing `if (!opts.skipFundOperator) { ... }` block, **after** the `available` check and **before** `d.fundOperator(...)` (lines 108-113), insert the exact ceiling check from spec §D3 (`const standing = await d.standingExposure(); if (standing.total + amount > d.ceiling) throw new Error(JSON.stringify({ error: "float-ceiling-exceeded", standing: standing.total.toString(), breakdown: { operatorEoa, pocketEoa, gateway }, requested: amount.toString(), ceiling: d.ceiling.toString() }));`).

- [ ] **Step 4: Run it — verify the funding suite passes**

Run: `cd back/backend && npx vitest run test/payments/funding.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Write the failing `fundToTarget` tests**

In `back/backend/test/agent/liveRunner.test.ts`, add `fundToTarget` to the existing import from `../../src/agent/liveRunner`, add `import type { Hex } from "../../src/types";`, then append:

```ts
test("fundToTarget no-ops when Gateway float already covers the target", async () => {
  const fund = vi.fn(async () => ["0xa"] as Hex[]);
  const hashes = await fundToTarget(500_000n, {
    readGatewayAtomic: async () => 500_000n,
    fund,
  });
  expect(hashes).toEqual([]);
  expect(fund).not.toHaveBeenCalled();
});

test("fundToTarget funds only the shortfall when float is partially drained", async () => {
  const fund = vi.fn(async () => ["0xa", "0xb", "0xc"] as Hex[]);
  const hashes = await fundToTarget(500_000n, {
    readGatewayAtomic: async () => 300_000n,
    fund,
  });
  expect(fund).toHaveBeenCalledWith(200_000n);
  expect(hashes).toEqual(["0xa", "0xb", "0xc"]);
});
```

- [ ] **Step 6: Run it — verify it fails**

Run: `cd back/backend && npx vitest run test/agent/liveRunner.test.ts -t fundToTarget`
Expected: FAIL — `fundToTarget` is not exported.

- [ ] **Step 7: Implement `fundToTarget` + wire it + the mutex + ceiling deps per spec §D3/§D5**

In `back/backend/src/agent/liveRunner.ts`:
- Add the imports: `import { withKeyedLock } from "../payments/keyedMutex";` and `import { readStandingExposure } from "../payments/standingExposure";`.
- Add the exported `fundToTarget` helper from spec §D5 (reads `readGatewayAtomic`; `if (available >= target) return []`; else `return d.fund(target - available)`).
- In `fundPocket` (167-235): wrap the existing body in `return withKeyedLock(entityKey, async () => { ...existing body... });`. Add the two new `topUpPocket` deps in the object at 217-233: `standingExposure: () => readStandingExposure({ usdcBalanceOf: (owner) => adapter.usdcBalanceOf(cfg.usdc, owner), gatewayAvailable: () => gateway.getAvailable(), operator: operatorAddress, pocket: gateway.address }),` and `ceiling: usdToUnits(cfg.maxPocketFloatUsdc),`. (`usdToUnits` is already imported at 26; `gateway` and `operatorAddress` are already in scope.)
- In `buildLiveAgentRunner`, build one Gateway reader from the already-derived `pocketKey` (275) and replace the `fund` callback (375) with the fund-to-target wiring from spec §D5: `fund: (amt) => fundToTarget(amt, { readGatewayAtomic: async () => BigInt(Math.floor((await fundGateway.getAvailable()) * 1e6)), fund: (shortfall) => fundPocket(cfg, treasury, shortfall, operatorWallet, entity.idempotencyKey) })`, where `const fundGateway = new PocketGateway({ pocketPrivateKey: pocketKey, rpcUrl: cfg.rpcUrl });` is declared once near the other pocket wiring (285-291). (`PocketGateway` is already imported at 9.)

- [ ] **Step 8: Run the agent + funding suites — verify pass**

Run: `cd back/backend && npx vitest run test/agent/liveRunner.test.ts test/payments/funding.test.ts`
Expected: PASS (existing + new `fundToTarget` + ceiling tests).

- [ ] **Step 9: Lint + typecheck + commit**

Run: `cd back/backend && npx biome check src test && npx tsc --noEmit`
Expected: clean.

```bash
git add back/backend/src/payments/funding.ts back/backend/src/agent/liveRunner.ts \
  back/backend/test/payments/funding.test.ts back/backend/test/agent/liveRunner.test.ts
git commit -m "feat(s2): enforce standing-float ceiling in topUpPocket + fund-to-target leg-0 (no wedge) + per-agent mutex"
```

---

### Task 4: Legal-status gate in `evaluatePolicy` (spec §D6)

**Files:**
- Modify: `back/backend/src/payments/policyGate.ts` (`PolicyInput` 3-13; `PolicyReason` 15-21; check in `evaluatePolicy` 25-34)
- Modify: `back/backend/src/payments/authority.ts` (`TreasuryState` 6-11; the `evaluatePolicy` call 48-58)
- Modify: `back/backend/src/payments/entityPayment.ts` (`TreasuryReader` 17-23; `readTreasury` closure 105-110)
- Modify: `back/backend/src/agent/liveRunner.ts` (`readTreasury` closure 338-343)
- Modify: `back/backend/test/payments/policyGate.test.ts` (`base` fixture + legal tests)
- Modify: `back/backend/test/payments/authority.test.ts` (ALL five `readTreasury` literals: lines 15, 64, 85, 105, 147)
- Modify: `back/backend/test/agent/liveRunner.test.ts` (`readTreasury` fake ~80 gains `legalActive: true`)
- Modify: `back/backend/test/payments/entityPayment.test.ts` (`makeReader` + suspension test)

> Note: `test/api/treasury.routes.test.ts` and `test/api/policy.routes.test.ts` build their arc fake via `as unknown as ArcAdapter`, so widening `TreasuryReader` with `legalStatus` does NOT reach them (the cast defeats structural checking and the real `ArcAdapter` already has `legalStatus`) — no edit needed there. The `/treasury` route reads three values directly and never calls `entityPayment.status()`, so T1's `readExposure` change also leaves them untouched.

**Interfaces:**
- Consumes: nothing from earlier tasks (independent; `ArcAdapter.legalStatus(proxy)` already exists at `adapters/arc/arcAdapter.ts:372-378`).
- Produces:
  - `PolicyInput` gains `legalActive: boolean`; `PolicyReason` gains `"legal-not-active"`; the check is inserted immediately after `paused`.
  - `TreasuryState` gains `legalActive: boolean`.
  - `TreasuryReader` gains `legalStatus(proxy: Address): Promise<number>`.

- [ ] **Step 1: Write the failing policyGate tests**

In `back/backend/test/payments/policyGate.test.ts`, add `legalActive: true,` to the `base` object, then append:

```ts
test("denies when the legal body is not Active", () => {
  expect(evaluatePolicy({ ...base, legalActive: false })).toEqual({
    ok: false,
    reason: "legal-not-active",
  });
});

test("legal-not-active is checked before the allowlist (mirrors on-chain _requireSpendable order)", () => {
  expect(evaluatePolicy({ ...base, legalActive: false, isAllowed: false })).toEqual({
    ok: false,
    reason: "legal-not-active",
  });
});

test("paused still wins over legal-not-active (pause is checked first)", () => {
  expect(evaluatePolicy({ ...base, paused: true, legalActive: false })).toEqual({
    ok: false,
    reason: "paused",
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd back/backend && npx vitest run test/payments/policyGate.test.ts`
Expected: FAIL — no `legal-not-active` branch (the `legalActive:false` cases fall through to `{ ok: true }`). (TS also flags `legalActive` unknown on `PolicyInput` until Step 3.)

- [ ] **Step 3: Implement the check per spec §D6**

In `back/backend/src/payments/policyGate.ts`:
- Add `legalActive: boolean;` to `PolicyInput` (3-13).
- Add `"legal-not-active"` to the `PolicyReason` union (15-21).
- In `evaluatePolicy`, immediately after `if (i.paused) return { ok: false, reason: "paused" };` add `if (!i.legalActive) return { ok: false, reason: "legal-not-active" };`.

- [ ] **Step 4: Run it — verify it passes**

Run: `cd back/backend && npx vitest run test/payments/policyGate.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Wire `legalActive` through the callers (make authority + entityPayment compile)**

- `back/backend/src/payments/authority.ts`: add `legalActive: boolean;` to `TreasuryState` (6-11); in the `evaluatePolicy({...})` call (48-58) pass `legalActive: t.legalActive,`.
- `back/backend/src/payments/entityPayment.ts`: add `legalStatus(proxy: Address): Promise<number>;` to the `TreasuryReader` interface (17-23); in the `readTreasury` closure (105-110) add `legalActive: (await deps.reader.legalStatus(entity.proxy as Address)) === 0,`.
- `back/backend/src/agent/liveRunner.ts`: in the `readTreasury` closure (338-343) add `legalActive: (await adapter.legalStatus(entity.proxy as Address)) === 0,`.

- [ ] **Step 6: Update every `TreasuryState`/`TreasuryReader` test fake (or `tsc` fails)**

Widening `TreasuryState` and `TreasuryReader` breaks every fake literal — update all of them:
- `back/backend/test/payments/authority.test.ts`: add `legalActive: true,` to the returned object of **all five** `readTreasury` literals (lines 15, 64, 85, 105, 147 — each returns `{ available, paused, allowlistEnabled, isAllowed }`).
- `back/backend/test/agent/liveRunner.test.ts`: add `legalActive: true,` to the `readTreasury` fake (~line 80, the `{ available, paused, allowlistEnabled, isAllowed }` object in the `authorityDeps`).
- Do NOT edit `test/api/treasury.routes.test.ts` / `test/api/policy.routes.test.ts` — their arc fakes are `as unknown as ArcAdapter` casts, so the widened `TreasuryReader` does not require them to add `legalStatus`. The full-suite `tsc` in Step 9 confirms no other construction site was missed.

- [ ] **Step 7: Write the failing entityPayment suspension test + update `makeReader`**

In `back/backend/test/payments/entityPayment.test.ts`:
- In `makeReader`, add `legalStatus?: number;` to the `over` param type, and add `legalStatus: async () => over.legalStatus ?? 0,` to the returned `reader`.
- Append:

```ts
test("pay denies when the legal body is suspended, even with sufficient float", async () => {
  const { reader } = makeReader({ legalStatus: 1 }); // non-zero = suspended
  const { fn } = fakeFetch();
  const svc = buildEntityPaymentService(makeConfig(), {
    reader,
    ledger,
    idempotency,
    fetchImpl: fn as unknown as typeof fetch,
    readPocketFloat: SUFFICIENT_FLOAT,
  });
  const receipt = await svc.pay(seedEntity(), {
    url: "https://vendor.example/resource",
    amountUsdc: 1000n,
    idempotencyKey: "k-legal",
    tenantId: "tenantA",
  });
  expect(receipt).toMatchObject({ ok: false, reason: "legal-not-active" });
  expect(fn).toHaveBeenCalledTimes(1); // only the 402 probe, no retry
});
```

- [ ] **Step 8: Run the affected suites — verify pass**

Run: `cd back/backend && npx vitest run test/payments/policyGate.test.ts test/payments/authority.test.ts test/payments/entityPayment.test.ts`
Expected: PASS (all, incl. the new suspension test — `buyer.ts:63` throws `policy-denied: legal-not-active`, which `pay` surfaces as `reason: "legal-not-active"`).

- [ ] **Step 9: Full backend suite + lint + typecheck + commit**

Run: `cd back/backend && npx vitest run && npx biome check src test && npx tsc --noEmit`
Expected: clean (confirms no other `PolicyInput`/`TreasuryState`/`TreasuryReader` construction site was missed).

```bash
git add back/backend/src/payments/policyGate.ts back/backend/src/payments/authority.ts \
  back/backend/src/payments/entityPayment.ts back/backend/src/agent/liveRunner.ts \
  back/backend/test/payments/policyGate.test.ts back/backend/test/payments/authority.test.ts \
  back/backend/test/payments/entityPayment.test.ts
git commit -m "feat(s2): add on-chain legal-status gate to evaluatePolicy so a suspended entity cannot spend standing float via x402"
```

---

### Task 5: Honest labeling — dashboard "Active rules" copy + docs (spec §D7)

Copy + docs only; no backend logic. The "test cycle" here is a frontend typecheck/build + a render check, since static copy has no meaningful unit test.

**Files:**
- Modify: `interface/src/components/agents/AgentDashboard.tsx` (the "Active rules" `Card`, 245-272)
- Modify: `back/docs/design/2026-06-28-honest-dashboard-design.md`
- Modify: `back/docs/Novi-Corpus-V2-Roadmap.html` (the S2 entry)

**Interfaces:**
- Consumes: `treasury_status.standing.ceiling` from Task 1 (available on the status payload the dashboard already fetches) for the "Standing float ceiling" row value.
- Produces: no code interface.

- [ ] **Step 1: Rewrite the "Active rules" card per spec §D7**

In `interface/src/components/agents/AgentDashboard.tsx`, replace the single `RuleRow` list (257-270) with the two labeled groups from spec §D7:
- **On-chain (enforced by the treasury contract):** `Period cap` (existing `capUsdc` / `periodHours`), `Guardian pause` (`treasury.paused` → `On`/`Off`), `Legal status` (`Active`/`Suspended`), `Allowlist (direct spend)` (existing recipients row).
- **Software-enforced on x402 payments (backend checks each payment against fresh on-chain state; not guaranteed if the backend is compromised):** `Per-tx cap` (existing `perTxUsdc`), `Allowlist / threshold`, `Pause + legal status`, `Standing float ceiling` = `≤ {ceiling} USDC held in pocket/Gateway at once` (from `treasury_status.standing.ceiling`, formatted with the existing `formatUsdc`).
- Add the footnote from spec §D7 under the card: "x402 payments enforce the same allowlist, per-tx and cap rules as direct on-chain spends — in software, against live on-chain reads. The float ceiling caps how much can sit beyond the guardian's reach at once."

Do not ship any copy stating the allowlist/per-tx cap "don't apply" to x402. Reuse the existing `RuleRow` component and Tailwind classes; add a small group-label element (same muted style as the "Active rules" label at 248) for each group.

- [ ] **Step 2: Typecheck/build the interface — verify clean**

Run: `cd interface && npx tsc --noEmit` (or `npm run lint` if that is the configured gate).
Expected: clean — no type errors introduced by the new rows.

- [ ] **Step 3: Correct the docs**

- `back/docs/design/2026-06-28-honest-dashboard-design.md`: update the rules-card description to the two-group framing (on-chain-guaranteed vs software-enforced-on-x402), matching spec §D7.
- `back/docs/Novi-Corpus-V2-Roadmap.html`: in the S2 entry, replace any "x402 escapes the allowlist / per-tx cap" wording with "same rules, enforced in software vs on-chain; the on-chain-guaranteed x402 bounds are period cap + pause + legal status + the standing-float ceiling." (The `.pdf` is regenerated from this `.html`; regenerating it is out of scope — note it in the commit body.)

- [ ] **Step 4: Commit**

```bash
git add interface/src/components/agents/AgentDashboard.tsx \
  back/docs/design/2026-06-28-honest-dashboard-design.md back/docs/Novi-Corpus-V2-Roadmap.html
git commit -m "docs(s2): honest 'Active rules' framing (on-chain vs software-enforced x402) + float-ceiling row"
```

---

## Final review (after all tasks green)

- [ ] **Whole-branch Opus review.** Dispatch an Opus reviewer over the full diff (all 5 commits) against the spec `back/docs/design/2026-07-20-s2-interim-float-ceiling-design.md`: confirm the ceiling is enforced only in the `!skipFundOperator` branch, atomic-bigint throughout, reject-not-clamp on the MCP path, fund-to-target prevents the wedge, legal-status ordering matches the contract, and no `float` semantics changed.
- [ ] **Full green gate.** `cd back/backend && npx vitest run && npx biome check src test && npx tsc --noEmit` all clean; `cd interface && npx tsc --noEmit` clean.

## Notes / open item carried from the spec

- **Operator-EOA earnings vs the ceiling** (spec Open Question 1): counting the operator EOA is correct, but transient large job-earnings parked there could reject a legitimate `fund_pocket`. Accepted for the interim (with `JOB_SWEEP_TO_TREASURY=true`, operator residue is normally dust); do **not** add exclusion logic in this plan. Revisit with the v2 `sweep_earnings` tool. No task here.
- Non-goals (unchanged): Tier-0 structural close, S5 aggregate meter, S3 seed isolation, any `AgentTreasury.sol` change.
