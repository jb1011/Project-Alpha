# Payment / Funding Hardening — Design

**Date:** 2026-07-04 · **Area:** `back/backend` (Hono/TS) · **Type:** hardening batch (4 fixes)

Four follow-ups surfaced by the live Leg 3 smoke test, all in the existing payment/funding path. No new subsystems; one small new module (`gasSeeder.ts`). (#2 — the Vercel proxy stripping `X-PAYMENT` — already shipped in PR #30, out of scope here.)

## Goal

Make a fresh agent able to fund its pocket and pay end-to-end without manual intervention, and make the payment/treasury tools report the truth.

---

## #1 — Auto gas-seed the operator + pocket EOAs (the real gap)

**Problem.** On Arc, native gas *is* USDC. A fresh agent's operator EOA (sends `fundOperator` + `operatorTransferUsdc`) and pocket EOA (sends the Gateway deposit) start with **0 native**, so `fund_pocket`'s bridge reverts pre-broadcast (`gas required exceeds allowance (0)`). `fund_treasury` fills the treasury *contract* but never seeds these EOAs. (Chosen fix: auto-seed from the platform wallet now; Gas Station / smart-account migration is a separate roadmap item.)

**Design.** New module `src/payments/gasSeeder.ts`, chain-injected so it unit-tests without a node:

```ts
export interface GasSeedDeps {
  getBalance: (addr: Address) => Promise<bigint>;      // native balance (18-dec wei)
  sendNative: (to: Address, value: bigint) => Promise<Hex>;
  floor: bigint;   // top up if native < floor
  target: bigint;  // top up to this native balance
}
/** For each target below `floor`, send `target - balance` native from the platform wallet.
 *  Returns the seed tx hashes (empty when nothing needed seeding). */
export async function ensureNativeGas(targets: Address[], d: GasSeedDeps): Promise<Hex[]>;
```

Logic: for each `to` in `targets`, read balance; if `>= floor` skip; else `sendNative(to, target - balance)` and collect the hash.

**Wiring in `fundPocket` (`src/agent/liveRunner.ts`).** After the pocket (`gateway.address`) and `operatorAddress` are resolved and before `topUpPocket`, call:

```ts
const managerWallet = managerWalletClient(cfg); // platform = manager account
const seedTxs = await ensureNativeGas([operatorAddress, gateway.address], {
  getBalance: (addr) => pub.getBalance({ address: addr }),
  sendNative: (to, value) => managerWallet.sendTransaction({ to, value }),
  floor: parseEther(cfg.gasSeedFloorUsdc),
  target: parseEther(cfg.gasSeedTargetUsdc),
});
txs.push(...seedTxs);
```

The returned `Hex[]` becomes `[...seedTxs, ...bridgeTxs]` (seed hashes first, then the 3 bridge hashes from #5).

**Config (`src/config/env.ts`).** `GAS_SEED_FLOOR_USDC` default `"0.05"`, `GAS_SEED_TARGET_USDC` default `"0.2"` — **native, 18-dec**, `parseEther` at the wiring above. Validate each parses via `parseEther` and `floor < target`. Stored as strings on `Config` (`gasSeedFloorUsdc`, `gasSeedTargetUsdc`); non-secret, no `redact()` change.

**Scope / non-goals.** Only `fundPocket` — the sole place the operator/pocket send on-chain txs (fund_treasury is platform-sent, `pay` is an off-chain signature). Documented known limitation: two concurrent `fund_pocket` calls could double-seed or nonce-race the platform wallet — acceptable for the single-VPS demo; the Gas-Station/smart-account migration supersedes it. If the platform wallet itself lacks native, `sendNative` throws → `fund_pocket` returns `{ ok:false, reason }` (surfaces the condition clearly).

---

## #3 — `treasury_status` reports the on-chain balance, not just the leash

**Problem.** `status()` returns `available` = the treasury's policy leash and `cap`; neither reflects the actual on-chain USDC balance, so an empty treasury still showed `available:"5000000"`.

**Design (`src/payments/entityPayment.ts`).** Additive:
- Add `usdcBalanceOf(usdc: Address, owner: Address): Promise<bigint>` to the `TreasuryReader` interface — `ArcAdapter` already implements it.
- Add `balance: string` to `TreasuryStatusView`.
- In `status()`, read `deps.reader.usdcBalanceOf(cfg.usdc, treasury)` inside the existing `Promise.all` and return `balance: balance.toString()`. The `!entity.treasury` early-return also gains `balance: "0"`.

`available`/`cap`/`float` are unchanged → non-breaking for the frontend dashboard, which now also gets a truthful `balance`.

---

## #4 — `pay` surfaces the real settlement id

**Problem.** `pay` returns `txOrTransferId: null` on success. The buyer reads the id from the `X-PAYMENT-RESPONSE` response header (`extractSettlementId`), but the demo seller (`buildPaywall`) settles and never emits it, so the ledger records the `"settled"` fallback.

**Design (`src/payments/seller.ts`).** `settleWith` already returns `{ ok:true, transferId }`. In `buildPaywall`, when `cfg.settle` succeeds with a `transferId`, set the response header before serving:

```ts
const r = await cfg.settle(header, { ... });
if (!r.ok) return c.json({ ...buildRequirements(cfg), error: `settle-failed:${r.reason ?? ""}` }, 402);
if (r.transferId) c.header("X-PAYMENT-RESPONSE", r.transferId);
```

The header carries the raw facilitator transaction id (opaque string; the buyer treats it as such). #30 already forwards `x-payment-response` through the proxy → `pay` returns the real id and `ledger.markSettled` records it. When the facilitator returns no `transaction`, the header is omitted and `txOrTransferId` legitimately stays null (unchanged behavior).

---

## #5 — `fund_pocket` returns the deposit tx hash (3, not 2)

**Problem.** `fundPocket` collects `fundOperator` + `operatorTransferUsdc` hashes but drops the Gateway deposit hash.

**Design.**
- `src/adapters/x402/gateway.ts`: the SDK's `client.deposit` returns `{ depositTxHash: Hex, ... }`. Make `PocketGateway.deposit` return it: `async deposit(amountUsdc: string): Promise<Hex> { return (await this.client.deposit(amountUsdc)).depositTxHash; }`.
- `src/agent/liveRunner.ts`: `fundPocket`'s `depositToGateway` closure captures and pushes the hash, mirroring the other two legs:
  ```ts
  depositToGateway: async (amt) => { const h = await gateway.deposit(amt); txs.push(h); return h; },
  ```
`topUpPocket` is unchanged (it discards the return; the push happens in the closure). `FundingDeps.depositToGateway` return type tightens from `Promise<unknown>` to `Promise<Hex>`.

---

## Testing

- **`gasSeeder`** (unit, fakes): below-floor → sends `target − balance` to that address; at/above-floor → no send; multiple targets handled independently; returns the hashes.
- **`fundPocket`** (extend existing funding test): deposit closure pushes the 3rd hash; when both EOAs below floor, seed hashes precede the bridge hashes.
- **`buildPaywall`** (extend `seller*.test.ts`): on a settle that returns `transferId`, the 200 response carries `X-PAYMENT-RESPONSE`; no `transferId` → header absent.
- **`status()`** (extend `entityPayment`/`service` test with a fake `TreasuryReader.usdcBalanceOf`): returns `balance`; `available`/`cap`/`float` unchanged; no-treasury path returns `balance:"0"`.
- **config**: `GAS_SEED_FLOOR_USDC`/`GAS_SEED_TARGET_USDC` defaults + `floor < target` validation.

`npx biome check src test` + `npx tsc --noEmit` clean per task (CI enforces Biome).

## Out of scope / roadmap

- Circle Gas Station / smart-account operators (the "later" path for #1).
- Backfilling the 3 existing `file://` demo agents' metadata (separate).
- Removing the `ENABLE_X402_DEMO` route (separate cleanup, user's call).
