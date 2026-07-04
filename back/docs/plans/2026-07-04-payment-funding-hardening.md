# Payment / Funding Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land four independent payment/funding fixes surfaced by the live Leg 3 smoke test so a fresh agent can fund + pay unattended and the tools report the truth.

**Architecture:** All changes live in the existing payment/funding path (`src/payments/*`, `src/adapters/x402/gateway.ts`, `src/agent/liveRunner.ts`, `src/config/env.ts`) plus one new module (`src/payments/gasSeeder.ts`). Each fix is independent; they land in one branch, task-ordered so the two `fundPocket`-touching tasks are adjacent (the tx-hash refactor before the gas-seed wiring).

**Tech Stack:** TypeScript, Hono, viem, `@circle-fin/x402-batching`, zod (config), vitest, Biome. Backend at `back/backend` (no build step; `tsx`).

## Global Constraints

- **#3 is additive:** `available` (leash) and `cap` in `TreasuryStatusView` keep their current meaning; add a `balance` field (on-chain USDC via `usdcBalanceOf`). Do not change `available`.
- **#4:** `buildPaywall` sets `X-PAYMENT-RESPONSE` to the **raw** `transferId` string, and only when settle succeeds **and** `transferId` is present; omit the header otherwise (a null `txOrTransferId` then stays valid).
- **#5:** `fund_pocket`/`fundPocket` returns the Gateway **deposit** tx hash too (3 bridge hashes). Implemented by having `topUpPocket` collect and **return** `[fundOperator, operatorTransfer, deposit]` hashes (not the old closure-push).
- **#1:** gas-seed only in `fundPocket`. Defaults `GAS_SEED_FLOOR_USDC="0.05"`, `GAS_SEED_TARGET_USDC="0.2"` — **native, 18-dec** (`parseEther`), require `floor < target`. Seed an EOA only when its native balance `< floor`, sending `target − balance` from the platform/manager wallet. Seed hashes precede the bridge hashes in the returned array.
- Amounts: ERC-20 USDC is atomic 6-dec (`usdToUnits`); **native gas is 18-dec (`parseEther`)** — do not mix.
- Run `npx biome check src test` and `npx tsc --noEmit` before every commit (CI enforces Biome). TDD; commit per task.

---

## File Structure

- `src/payments/entityPayment.ts` (modify) — Task 1 (#3): `TreasuryReader` + `TreasuryStatusView` + `status()`.
- `src/payments/seller.ts` (modify) — Task 2 (#4): `buildPaywall` emits `X-PAYMENT-RESPONSE`.
- `src/payments/funding.ts` (modify) + `src/adapters/x402/gateway.ts` (modify) + `src/agent/liveRunner.ts` (modify) — Task 3 (#5): `topUpPocket` returns hashes; `PocketGateway.deposit` returns its hash; `fundPocket` uses the return.
- `src/config/env.ts` (modify) + `src/payments/gasSeeder.ts` (create) + `src/agent/liveRunner.ts` (modify) — Task 4 (#1): config + gas seeder + `fundPocket` wiring.

Task order: **1 (#3) → 2 (#4) → 3 (#5) → 4 (#1)**.

---

### Task 1: `treasury_status` reports on-chain balance (#3)

**Files:**
- Modify: `src/payments/entityPayment.ts` (`TreasuryReader` at 17-22, `TreasuryStatusView` at 24-31, `status()` at 123-142)
- Test: `test/payments/entityPayment.test.ts` (`makeReader` at 120-140, status test at ~314-322)

**Interfaces:**
- Consumes: `ArcAdapter.usdcBalanceOf(usdc: Address, owner: Address): Promise<bigint>` (already implemented).
- Produces: `TreasuryReader.usdcBalanceOf`, `TreasuryStatusView.balance: string`.

- [ ] **Step 1: Update the failing test**

In `test/payments/entityPayment.test.ts`, extend `makeReader`'s `over` type and body to script a balance, and assert `balance` in the status test.

In `makeReader` (line 121-140), add `balance` to the `over` param type and add `usdcBalanceOf` to the returned `reader`:

```ts
function makeReader(
  over: Partial<{
    available: bigint;
    paused: boolean;
    allowlistEnabled: boolean;
    isAllowed: boolean;
    balance: bigint;
  }> = {},
) {
  const isAllowedCalls: Address[] = [];
  const reader: TreasuryReader = {
    treasuryAvailable: async () => over.available ?? 1_000_000n,
    treasuryPaused: async () => over.paused ?? false,
    treasuryAllowlistEnabled: async () => over.allowlistEnabled ?? false,
    treasuryIsAllowed: async (_t, who) => {
      isAllowedCalls.push(who);
      return over.isAllowed ?? true;
    },
    usdcBalanceOf: async () => over.balance ?? 0n,
  };
  return { reader, isAllowedCalls };
}
```

In the status test (the `expect(status).toEqual({...})` around line 316), the reader for that test is built via `makeReader({ available: 42000n, paused: true, allowlistEnabled: true })` — add `balance: 123n` to that call and add `balance: "123"` to the expected object:

```ts
// where the status test builds its reader, add balance: 123n to the makeReader({...}) call, then:
  expect(status).toEqual({
    available: "42000",
    cap: "5000000",
    paused: true,
    allowlistEnabled: true,
    float: "250000",
    balance: "123",
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back/backend && npx vitest run test/payments/entityPayment.test.ts`
Expected: FAIL — `TreasuryReader` has no `usdcBalanceOf` (tsc/type error in the fake) and `status` lacks `balance`.

- [ ] **Step 3: Implement**

In `src/payments/entityPayment.ts`, add to the `TreasuryReader` interface (after `treasuryIsAllowed` at line 21):

```ts
  usdcBalanceOf(usdc: Address, owner: Address): Promise<bigint>;
```

Add to `TreasuryStatusView` (after `float: string;` at line 30):

```ts
  /** Actual on-chain USDC balance of the treasury (atomic, 6 decimals) — distinct from the policy `available` leash. */
  balance: string;
```

In `status()`, update the no-treasury early return (line 125) to include `balance: "0"`:

```ts
        return { available: "0", cap: "0", paused: false, allowlistEnabled: false, float: "0", balance: "0" };
```

And the main path (line 128-141): add the balance read to the `Promise.all` and the return:

```ts
      const [available, paused, allowlistEnabled, float, balance] = await Promise.all([
        deps.reader.treasuryAvailable(treasury),
        deps.reader.treasuryPaused(treasury),
        deps.reader.treasuryAllowlistEnabled(treasury),
        readPocketFloat(entity),
        deps.reader.usdcBalanceOf(cfg.usdc, treasury),
      ]);
      const cap = entity.treasuryConfig?.cap ?? 0n;
      return {
        available: available.toString(),
        cap: cap.toString(),
        paused,
        allowlistEnabled,
        float: float.toString(),
        balance: balance.toString(),
      };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back/backend && npx vitest run test/payments/entityPayment.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify types + lint**

Run: `cd back/backend && npx tsc --noEmit && npx biome check src test`
Expected: clean. (`ArcAdapter` already satisfies the widened `TreasuryReader`; if any other `TreasuryReader` literal exists it must gain `usdcBalanceOf` — tsc will flag it.)

- [ ] **Step 6: Commit**

```bash
cd back/backend && git add src/payments/entityPayment.ts test/payments/entityPayment.test.ts
git commit -m "fix(treasury_status): add on-chain balance field alongside leash/cap (#3)"
```

---

### Task 2: `pay` surfaces the settlement id (#4)

**Files:**
- Modify: `src/payments/seller.ts` (`buildPaywall`, the settle block at 117-134)
- Test: `test/payments/sellerSettle.test.ts`

**Interfaces:**
- Consumes: `SettleFn` returning `{ ok: true; transferId?: string } | { ok: false; reason?: string }` (from `settle.ts`, unchanged).
- Produces: on a successful settle with a `transferId`, the 200 response carries header `X-PAYMENT-RESPONSE: <transferId>`.

- [ ] **Step 1: Write the failing test**

Append to `test/payments/sellerSettle.test.ts`:

```ts
test("a successful settle surfaces the transferId in X-PAYMENT-RESPONSE", async () => {
  const settle = vi.fn(async () => ({ ok: true as const, transferId: "0xabc-transfer" }));
  const app = new Hono();
  app.route("/", buildPaywall({ ...cfgBase, settle, resourceUrl: "https://insight.local/x" }));
  const res = await app.request("/api/insight", { headers: { "X-PAYMENT": await header(50n) } });
  expect(res.status).toBe(200);
  expect(res.headers.get("X-PAYMENT-RESPONSE")).toBe("0xabc-transfer");
});

test("a settle with no transferId omits the header", async () => {
  const settle = vi.fn(async () => ({ ok: true as const }));
  const app = new Hono();
  app.route("/", buildPaywall({ ...cfgBase, settle, resourceUrl: "https://insight.local/x" }));
  const res = await app.request("/api/insight", { headers: { "X-PAYMENT": await header(50n) } });
  expect(res.status).toBe(200);
  expect(res.headers.get("X-PAYMENT-RESPONSE")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back/backend && npx vitest run test/payments/sellerSettle.test.ts`
Expected: FAIL — `X-PAYMENT-RESPONSE` is null (header never set).

- [ ] **Step 3: Implement**

In `src/payments/seller.ts` `buildPaywall`, the settle block currently (lines 117-134) does the settle then falls through to `return c.json(...)`. Capture the result and set the header on success. Replace:

```ts
    if (cfg.settle) {
      const r = await cfg.settle(header, {
        scheme: CIRCLE_BATCHING_SCHEME,
        network: cfg.network,
        asset: cfg.asset,
        amount: cfg.price.toString(),
        payTo: cfg.payTo,
        maxTimeoutSeconds: 60,
        extra: {
          name: CIRCLE_BATCHING_NAME,
          version: CIRCLE_BATCHING_VERSION,
          verifyingContract: arcBatchingConfig.verifyingContract,
        },
        resourceUrl: cfg.resourceUrl ?? cfg.resource ?? "/api/insight",
      });
      if (!r.ok)
        return c.json({ ...buildRequirements(cfg), error: `settle-failed:${r.reason ?? ""}` }, 402);
      if (r.transferId) c.header("X-PAYMENT-RESPONSE", r.transferId);
    }
```

(Only the final `if (r.transferId) ...` line is added; the rest is unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back/backend && npx vitest run test/payments/sellerSettle.test.ts`
Expected: PASS (all tests, including the two new ones).

- [ ] **Step 5: Verify types + lint**

Run: `cd back/backend && npx tsc --noEmit && npx biome check src test`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd back/backend && git add src/payments/seller.ts test/payments/sellerSettle.test.ts
git commit -m "fix(seller): emit X-PAYMENT-RESPONSE with the settle transferId so pay surfaces it (#4)"
```

---

### Task 3: `fund_pocket` returns the deposit tx hash (#5)

**Files:**
- Modify: `src/payments/funding.ts` (`FundingDeps.depositToGateway` at 13, `topUpPocket` at 55-73)
- Modify: `src/adapters/x402/gateway.ts` (`PocketGateway.deposit` at 24-26)
- Modify: `src/agent/liveRunner.ts` (`fundPocket` at 164-210, the `txs`/closures/return at 187-209)
- Test: `test/payments/funding.test.ts` (`deps` fake at ~10-20, and a new return-value assertion)

**Interfaces:**
- Consumes: `GatewayClient.deposit(amount)` returns `{ depositTxHash: Hex, ... }` (SDK).
- Produces: `topUpPocket(...)` returns `Promise<Hex[]>` = `[fundOperatorHash, operatorTransferHash, depositHash]`; `PocketGateway.deposit(amountUsdc): Promise<Hex>`; `FundingDeps.depositToGateway: (amountUsdc: string) => Promise<Hex>`; `fundPocket(...)` still returns `Promise<Hex[]>` (now including the deposit hash). Task 4 relies on `fundPocket` returning the bridge hashes so it can prepend seed hashes.

- [ ] **Step 1: Update the failing test**

In `test/payments/funding.test.ts`, change the `depositToGateway` fake to return a hash and add a test asserting `topUpPocket` returns all three:

Change the `deps()` fake's deposit line from `depositToGateway: vi.fn(async () => undefined),` to:

```ts
    depositToGateway: vi.fn(async () => "0xdeposit" as const),
```

Add a new test:

```ts
test("returns the fundOperator, forward, and deposit tx hashes in order", async () => {
  const d = deps();
  const hashes = await topUpPocket(d, 250_000n, { sleep: noSleep });
  expect(hashes).toEqual(["0xfund", "0xxfer", "0xdeposit"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back/backend && npx vitest run test/payments/funding.test.ts`
Expected: FAIL — `topUpPocket` returns `undefined` (declared `Promise<void>`), and the fake's new `Hex` return type conflicts with `depositToGateway: Promise<unknown>`.

- [ ] **Step 3: Implement — `funding.ts`**

In `src/payments/funding.ts`, tighten the deposit dep type (line 13):

```ts
  depositToGateway: (amountUsdc: string) => Promise<Hex>; // pocket-signed (free)
```

Change `topUpPocket` (55-73) to collect and return the hashes:

```ts
export async function topUpPocket(
  d: FundingDeps,
  amount: bigint,
  opts: TopUpOptions = {},
): Promise<Hex[]> {
  if (amount <= 0n) throw new Error("top-up amount must be positive");
  const available = await d.available();
  if (amount > available) throw new Error(`top-up ${amount} exceeds available ${available}`);
  const fundHash = await d.fundOperator(d.treasury, amount);
  await awaitOperatorFunded(
    d.operatorUsdcBalance,
    amount,
    opts.pollAttempts ?? DEFAULT_POLL_ATTEMPTS,
    opts.pollDelayMs ?? DEFAULT_POLL_DELAY_MS,
    opts.sleep ?? defaultSleep,
  );
  const forwardHash = await d.operatorTransferUsdc(d.usdc, d.pocketAddress, amount);
  const depositHash = await d.depositToGateway(formatUnits(amount, 6));
  return [fundHash, forwardHash, depositHash];
}
```

- [ ] **Step 4: Implement — `gateway.ts`**

In `src/adapters/x402/gateway.ts`, make `deposit` return the tx hash (24-26):

```ts
  /** Deposit `amountUsdc` (decimal string, e.g. "0.5") from the pocket EOA into its Gateway balance.
   *  Returns the on-chain deposit tx hash. */
  async deposit(amountUsdc: string): Promise<Hex> {
    return (await this.client.deposit(amountUsdc)).depositTxHash;
  }
```

- [ ] **Step 5: Implement — `fundPocket` in `liveRunner.ts`**

In `src/agent/liveRunner.ts` `fundPocket`, replace the `txs`/closure-push/`topUpPocket`/`return txs` block (187-209) with a version that uses `topUpPocket`'s return (closures no longer push):

```ts
  const bridgeTxs = await topUpPocket(
    {
      treasury,
      usdc: cfg.usdc,
      pocketAddress: gateway.address,
      available: () => adapter.treasuryAvailable(treasury),
      operatorUsdcBalance: () => adapter.usdcBalanceOf(cfg.usdc, operatorAddress),
      fundOperator: (t, a) => adapter.fundOperator(t, a),
      operatorTransferUsdc: (u, to, a) => adapter.operatorTransferUsdc(u, to, a),
      depositToGateway: (amt) => gateway.deposit(amt),
    },
    floatAtomic,
  );
  return bridgeTxs;
```

(Remove the now-unused `const txs: Hex[] = [];`. `Hex` may become an unused import — if so, drop it from the import line; tsc/biome will tell you.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd back/backend && npx vitest run test/payments/funding.test.ts`
Expected: PASS (existing tests + the new return assertion).

- [ ] **Step 7: Verify types + lint**

Run: `cd back/backend && npx tsc --noEmit && npx biome check src test`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd back/backend && git add src/payments/funding.ts src/adapters/x402/gateway.ts src/agent/liveRunner.ts test/payments/funding.test.ts
git commit -m "fix(fund_pocket): collect + return the Gateway deposit tx hash (3 hashes) (#5)"
```

---

### Task 4: auto gas-seed the operator + pocket EOAs (#1)

**Files:**
- Modify: `src/config/env.ts` (schema, `Config`, `loadConfig`)
- Create: `src/payments/gasSeeder.ts`
- Modify: `src/agent/liveRunner.ts` (`fundPocket`, before `topUpPocket`)
- Test: `test/payments/gasSeeder.test.ts` (create), `test/config/gasSeed.test.ts` (create), and the full-`Config` test literals (see Step 7)

**Interfaces:**
- Consumes: `managerWalletClient(cfg): WalletClient` from `src/adapters/arc/clients.ts` (platform = manager account); `parseEther` from viem; `Config.gasSeedFloorUsdc`/`gasSeedTargetUsdc` (strings); `fundPocket`'s `bridgeTxs` from Task 3.
- Produces: `ensureNativeGas(targets: Address[], deps: GasSeedDeps): Promise<Hex[]>`; `fundPocket` returns `[...seedTxs, ...bridgeTxs]`.

- [ ] **Step 1: Write the failing test (gasSeeder unit)**

Create `test/payments/gasSeeder.test.ts`:

```ts
import { expect, test, vi } from "vitest";
import { ensureNativeGas } from "../../src/payments/gasSeeder";
import type { Address } from "../../src/types";

const A = `0x${"a".repeat(40)}` as Address;
const B = `0x${"b".repeat(40)}` as Address;
const floor = 50_000_000_000_000_000n; // 0.05e18
const target = 200_000_000_000_000_000n; // 0.2e18

test("tops up an EOA below floor to target and returns the hash", async () => {
  const sendNative = vi.fn(async () => "0xseedA" as const);
  const getBalance = vi.fn(async () => 0n);
  const hashes = await ensureNativeGas([A], { getBalance, sendNative, floor, target });
  expect(sendNative).toHaveBeenCalledWith(A, target); // 0.2e18 - 0
  expect(hashes).toEqual(["0xseedA"]);
});

test("skips an EOA at/above floor and sends nothing", async () => {
  const sendNative = vi.fn(async () => "0xseed" as const);
  const getBalance = vi.fn(async () => floor); // exactly at floor -> skip
  const hashes = await ensureNativeGas([A], { getBalance, sendNative, floor, target });
  expect(sendNative).not.toHaveBeenCalled();
  expect(hashes).toEqual([]);
});

test("handles multiple targets independently and sends target - balance", async () => {
  const balances: Record<string, bigint> = { [A]: 0n, [B]: 100_000_000_000_000_000n }; // B at 0.1 (below floor? no, >= floor -> skip)
  const sendNative = vi.fn(async (to: Address) => (`0xseed-${to}` as const) as `0x${string}`);
  const getBalance = vi.fn(async (addr: Address) => balances[addr] ?? 0n);
  const hashes = await ensureNativeGas([A, B], { getBalance, sendNative, floor, target });
  expect(sendNative).toHaveBeenCalledTimes(1);
  expect(sendNative).toHaveBeenCalledWith(A, target); // only A below floor
  expect(hashes).toEqual([`0xseed-${A}`]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back/backend && npx vitest run test/payments/gasSeeder.test.ts`
Expected: FAIL — cannot find module `src/payments/gasSeeder`.

- [ ] **Step 3: Implement the module**

Create `src/payments/gasSeeder.ts`:

```ts
import type { Address, Hex } from "../types";

export interface GasSeedDeps {
  /** Native balance (18-dec wei) of an address. */
  getBalance: (addr: Address) => Promise<bigint>;
  /** Send `value` native (18-dec wei) from the platform wallet to `to`; returns the tx hash. */
  sendNative: (to: Address, value: bigint) => Promise<Hex>;
  /** Top up an address whose native balance is below this. */
  floor: bigint;
  /** Bring a topped-up address up to this native balance. */
  target: bigint;
}

/**
 * Ensure each target EOA has native gas: for any target below `floor`, send `target - balance`
 * from the platform wallet. Returns the seed tx hashes (empty when nothing needed topping up).
 * Chain-injected (getBalance/sendNative) so it unit-tests without a node.
 */
export async function ensureNativeGas(targets: Address[], d: GasSeedDeps): Promise<Hex[]> {
  const hashes: Hex[] = [];
  for (const to of targets) {
    const balance = await d.getBalance(to);
    if (balance >= d.floor) continue;
    hashes.push(await d.sendNative(to, d.target - balance));
  }
  return hashes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back/backend && npx vitest run test/payments/gasSeeder.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing config test**

Create `test/config/gasSeed.test.ts`:

```ts
import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const PK = `0x${"1".repeat(64)}` as const;
const baseEnv = { ARC_TESTNET_RPC_URL: "http://localhost:8545", PLATFORM_PRIVATE_KEY: PK };

test("gas-seed floor/target default to 0.05/0.2", () => {
  const cfg = loadConfig(baseEnv);
  expect(cfg.gasSeedFloorUsdc).toBe("0.05");
  expect(cfg.gasSeedTargetUsdc).toBe("0.2");
});

test("rejects floor >= target", () => {
  expect(() =>
    loadConfig({ ...baseEnv, GAS_SEED_FLOOR_USDC: "0.3", GAS_SEED_TARGET_USDC: "0.2" }),
  ).toThrow(/GAS_SEED_FLOOR_USDC/);
});

test("rejects a non-ether floor value", () => {
  expect(() => loadConfig({ ...baseEnv, GAS_SEED_FLOOR_USDC: "abc" })).toThrow();
});
```

- [ ] **Step 6: Run config test to verify it fails**

Run: `cd back/backend && npx vitest run test/config/gasSeed.test.ts`
Expected: FAIL — `cfg.gasSeedFloorUsdc` is undefined.

- [ ] **Step 7: Implement config**

In `src/config/env.ts`, add the `parseEther` import to the existing viem import line:

```ts
import { getAddress, isAddress, parseEther } from "viem";
```

Add a reusable ether-string schema near `addressSchema` (after line 14):

```ts
const etherSchema = z.string().refine(
  (v) => {
    try {
      return parseEther(v) > 0n;
    } catch {
      return false;
    }
  },
  { message: "must be a positive decimal amount (e.g. 0.05)" },
);
```

Add to `EnvSchema` (after `METADATA_BASE_URL`, before the closing `})`):

```ts
  GAS_SEED_FLOOR_USDC: etherSchema.default("0.05"),
  GAS_SEED_TARGET_USDC: etherSchema.default("0.2"),
```

Add to the `Config` interface (after `metadataBaseUrl: string;`):

```ts
  gasSeedFloorUsdc: string;
  gasSeedTargetUsdc: string;
```

Add to the `cfg` object literal in `loadConfig` (after `metadataBaseUrl: e.METADATA_BASE_URL,`):

```ts
    gasSeedFloorUsdc: e.GAS_SEED_FLOOR_USDC,
    gasSeedTargetUsdc: e.GAS_SEED_TARGET_USDC,
```

Add a cross-field check just before `return cfg;` (after the `NODE_ENV === "production"` block):

```ts
  if (parseEther(cfg.gasSeedFloorUsdc) >= parseEther(cfg.gasSeedTargetUsdc)) {
    throw new Error("Invalid config: GAS_SEED_FLOOR_USDC must be less than GAS_SEED_TARGET_USDC");
  }
```

No `redact()` change (both are non-secret strings). Then fix the two pre-existing full-`Config` test literals that will fail `tsc` (they build a complete `Config`): in `test/jobs/composition.test.ts` and `test/payments/entityPayment.test.ts`, add `gasSeedFloorUsdc: "0.05", gasSeedTargetUsdc: "0.2",` to each `Config` literal (mirror the existing default-value style; place beside `metadataBaseUrl`).

- [ ] **Step 8: Wire the gas-seed into `fundPocket`**

In `src/agent/liveRunner.ts`, add the import:

```ts
import { managerWalletClient } from "../adapters/arc/clients";
import { ensureNativeGas } from "../payments/gasSeeder";
```

and add `parseEther` to the existing viem import (`import { http, type WalletClient, createPublicClient, createWalletClient, parseEther } from "viem";`).

In `fundPocket`, after `operatorAddress` is resolved (line 185-186) and before the `topUpPocket` call from Task 3, seed gas and prepend the hashes:

```ts
  const managerWallet = managerWalletClient(cfg);
  const seedTxs = await ensureNativeGas([operatorAddress, gateway.address], {
    getBalance: (addr) => pub.getBalance({ address: addr }),
    sendNative: (to, value) => managerWallet.sendTransaction({ to, value, account: managerWallet.account!, chain: managerWallet.chain }),
    floor: parseEther(cfg.gasSeedFloorUsdc),
    target: parseEther(cfg.gasSeedTargetUsdc),
  });
```

Change the final `return bridgeTxs;` (from Task 3) to:

```ts
  return [...seedTxs, ...bridgeTxs];
```

- [ ] **Step 9: Verify everything**

Run: `cd back/backend && npx vitest run test/payments/gasSeeder.test.ts test/config/gasSeed.test.ts test/config.test.ts test/config && npx tsc --noEmit && npx biome check src test`
Expected: all pass, tsc clean, biome clean.

- [ ] **Step 10: Commit**

```bash
cd back/backend && git add src/config/env.ts src/payments/gasSeeder.ts src/agent/liveRunner.ts test/payments/gasSeeder.test.ts test/config/gasSeed.test.ts test/jobs/composition.test.ts test/payments/entityPayment.test.ts
git commit -m "feat(fund_pocket): auto gas-seed operator + pocket EOAs from the platform wallet (#1)"
```

---

## Self-Review

**Spec coverage:** #3 → Task 1 ✓ · #4 → Task 2 ✓ · #5 → Task 3 ✓ · #1 → Task 4 ✓. (#2 shipped in PR #30, out of scope.)

**Deviation from spec (flag to human):** the spec's #5 note said "`topUpPocket` unchanged (push happens in the closure)". This plan instead **refactors `topUpPocket` to return the three hashes** and drops the closure-push, so #5 is unit-testable at `topUpPocket` (funding.test.ts) rather than only at the integration level. Same external outcome (`fund_pocket` returns 3 hashes). If you'd rather keep `topUpPocket` untouched, say so and I'll revert Task 3 to the closure-push form.

**Placeholder scan:** none — every step has complete code and exact commands.

**Type consistency:** `TreasuryReader.usdcBalanceOf(usdc, owner)` matches `ArcAdapter`'s signature. `topUpPocket → Promise<Hex[]>`, `PocketGateway.deposit → Promise<Hex>`, `FundingDeps.depositToGateway → Promise<Hex>` are consistent across Tasks 3-4. `GasSeedDeps`/`ensureNativeGas` names match between the module and its test. `Config.gasSeedFloorUsdc`/`gasSeedTargetUsdc` (strings) match the wiring's `parseEther(...)` in Task 4.
