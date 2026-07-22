# S2 Interim — x402 Standing-Float Ceiling + Honest Labeling — Design

**Date:** 2026-07-20 · **Area:** `back/backend` (Hono/TS) + `interface` (dashboard copy) · **Type:** security hardening (interim; the structural fix is the Tier-0 smart-account migration)

Audit finding **S2**: the x402 payment path moves USDC out of the treasury contract's on-chain reach before it is spent, so a runaway agent could park an unbounded amount of un-clawback-able float. This spec is the **interim** mitigation — bound and honestly-label the exposure **cheaply, with no contract change**. The full close (treasury-direct signing / smart-account policy module so the on-chain allowlist + per-tx cap reach the x402 payee) is deferred to the Tier-0 migration and is explicitly out of scope here.

This design was adversarially audited against the live code; it corrects two grounding claims from the first draft (the labeling framing and the "exposure is already ~0.5" implication) and folds in a legal-status hardening Martin approved.

## Goal

Make the standing, un-clawback-able x402 exposure of any single agent **hard-bounded to a configured ceiling** (default 1.00 USDC) and make every surface — dashboard + docs — describe the real guarantees honestly. Close the one genuine software-gate omission (legal status) while we are in this file.

### Threat model (state it precisely — this is what the interim does and does NOT defend)

- **In scope:** a **runaway / buggy / prompt-injected agent** driving the MCP `fund_pocket` tool (or the liveRunner's leg-0 fund) to move far more USDC than any single payment needs into the pocket/Gateway, where the guardian's `pause`/`emergencyWithdraw` can no longer claw it back. The ceiling caps how much can be stranded this way.
- **Explicitly NOT in scope:** a **compromised backend**. A compromised backend holds `POCKET_MASTER_SEED` (finding S3) and can sign x402 payments directly from whatever Gateway balance already exists, bypassing any software check. Defending that is S3 (seed isolation) + Tier-0 (on-chain policy). The ceiling is a software guardrail against the agent, not against the operator of the software.
- The on-chain period cap + `pause` + legal-status gate on `fundOperator` (`AgentTreasury.sol:167-174`) remain the hard, compromise-resistant backstops and are unchanged.

---

## The finding, corrected

The first-draft framing ("x402 escapes the allowlist and per-tx cap") is **factually wrong** and must not be shipped as dashboard copy. The accurate finding:

**Every x402 `pay` is already governed by the same policy rules as `spend()`, enforced in software against fresh on-chain reads.** The path is `entityPayment.pay` → `buildAuthorize` → `authorizePayment` → `evaluatePolicy`:

- `authorizePayment` reads treasury state fresh per payment and only then signs (`payments/authority.ts:43-64`).
- `evaluatePolicy` enforces, in order: zero-amount, `paused`, allowlist (`allowlistEnabled && !isAllowed`), spend threshold (`amount > threshold && !isAllowed`), per-tx cap, and running-pending + amount > available (`payments/policyGate.ts:25-34`).
- The treasury state is read on-chain at authorization time: `available`, `paused`, `allowlistEnabled`, `isAllowed(payee)` (`payments/entityPayment.ts:105-110`; same closure in `agent/liveRunner.ts:338-343`).
- The pocket key is reachable **only** through this gate — the agent never holds it (`payments/entityPayment.ts:94-123`).

So allowlist, per-tx cap, threshold, and pause **do** apply to x402. What is actually true and actually the S2 risk:

1. **Software-enforced, not contract-guaranteed.** For `spend()` the contract enforces the allowlist + cap (`AgentTreasury.sol:157-164`). For x402 the identical rules are enforced by backend code against on-chain *reads* — correct against a misbehaving agent, but not a substitute for the on-chain guarantee against a compromised gate.
2. **In-flight / standing funds are beyond guardian clawback.** The x402 bridge is `treasury → fundOperator → operator EOA → forward → pocket EOA → Gateway deposit → pocket-signed payment` (`payments/funding.ts:98-126`, `agent/liveRunner.ts:167-235`). `fundOperator` is **allowlist-exempt** and has **no per-tx cap** (`AgentTreasury.sol:167-174`, contrast `spend()` at `:160`); it is bounded only by the period cap (`_useCap`, `:139-146`) + `pause` + legal status. Once moved, `pause` blocks only *future* pulls and `emergencyWithdraw` sweeps only the vault's own balance (`:201-205`). Gateway balance is readable but **not withdrawable** by us (`payments/pocketFloat.ts:11-16`); `sweepPocketToTreasury` reclaims only the pocket EOA residual (`:13-16`). **Worst case today: a single `fund_pocket` call takes an arbitrary caller-chosen amount** (`mcp/server.ts:204-222`) bounded only by remaining period cap (`funding.ts:109-110`) — i.e. the whole cap window can become standing un-clawback-able float in one call. The ceiling cuts this from period-cap-sized to ≤ ceiling.
3. **Legal-status omission in the off-chain gate.** `evaluatePolicy` checks `paused` but **not** legal status (`policyGate.ts:27`). The contract gates every spend on `ILegalManagerStatus(legalManager).status() == 0` (`AgentTreasury.sol:150-151`), but a *suspended* entity that already holds standing Gateway float can keep paying via x402 until the float drains, because the off-chain gate never re-checks legal status. (Martin-approved addition — closed in D6.)

Note on the standing exposure surface the audit widened: the **operator EOA** also holds un-clawback-able funds — in-transit `fundOperator` credits during a partial bridge (the whole `skipFundOperator` retry machinery exists because credits strand there, `funding.ts:21-44`) and job-earnings residue between/after jobs when the sweep is off or lagging (`jobs/runJob.ts:10`, step 4.5 best-effort). On Arc the gas token **is** the `0x3600` USDC (`adapters/arc/gas.ts:1-16`), so the platform-funded gas seeds to the operator + pocket EOAs (target `GAS_SEED_TARGET_USDC`, `agent/liveRunner.ts:192-207`) also sit in the very balances the exposure read must sum. The ceiling accounting must include all three balances (D2) and the config invariant must budget for the seeds (D1).

---

## Fix design (every decision concrete)

Seven deltas. D1–D5 = the float ceiling; D6 = legal-status hardening; D7 = honest labeling. No contract change; no schema/migration.

### D1 — Config: `MAX_POCKET_FLOAT_USDC` + a fail-closed invariant

`src/config/env.ts`:

- Add to `EnvSchema`: `MAX_POCKET_FLOAT_USDC: z.string().default("1.00")`.
- Add to `Config`: `maxPocketFloatUsdc: string` (stored as a decimal string, converted at use with `usdToUnits`, mirroring `fundingFloatUsdc` at `env.ts:48,121,189`). Non-secret → no `redact()` change.
- Map it in `loadConfig`'s `cfg` object: `maxPocketFloatUsdc: e.MAX_POCKET_FLOAT_USDC`.

**Exact invariant** (add next to the existing `gasSeedFloor < gasSeedTarget` check at `env.ts:235-237`, so a bad config throws at boot, not at runtime):

```ts
const ceilingAtomic = usdToUnits(cfg.maxPocketFloatUsdc);
const floatAtomic = usdToUnits(cfg.fundingFloatUsdc);
// usdToUnits treats the native 18-dec seed string as its 6-dec-USDC decimal equivalent — the same
// interpretation the existing skip-guard uses (funding robustness doc; liveRunner.ts:213). On Arc,
// native gas IS USDC, so the numeric value is the correct 6-dec equivalent.
const seedTargetAtomic = usdToUnits(cfg.gasSeedTargetUsdc);
if (ceilingAtomic < floatAtomic + 2n * seedTargetAtomic) {
  throw new Error(
    "Invalid config: MAX_POCKET_FLOAT_USDC must be >= FUNDING_FLOAT_USDC + 2×GAS_SEED_TARGET_USDC " +
      "(both EOAs are gas-seeded to the target and are counted in standing exposure, so the first " +
      "legitimate float top-up would otherwise be rejected).",
  );
}
```

**Why `k = 2`, not `1` or `2×float`.** Both the operator EOA and the pocket EOA are seeded to `GAS_SEED_TARGET_USDC` (`ensureNativeGas([operatorAddress, gateway.address], …)`, `liveRunner.ts:192`), and `readStandingExposure` (D2) counts **both** EOAs. So at the moment the ceiling is checked, standing already includes ~`2×seedTarget` of platform gas before any agent float. The invariant guarantees the first legitimate top-up (requested = `floatAtomic`) never trips the ceiling. `2×float` is the wrong shape — the seed terms, not the float, are what pre-load standing. Default check: `0.50 + 2×0.20 = 0.90 ≤ 1.00` ✓; the second float top-up (`0.90 + 0.50 = 1.40 > 1.00`) correctly rejects.

### D2 — Shared `readStandingExposure(entity)` + reuse in `treasury_status`

New module `src/payments/standingExposure.ts`. Sums the three per-agent balances outside guardian reach, in **atomic USDC (6-dec) `bigint`**, reusing `entityPayment`'s conservative floor conversion (`Math.floor(available * 1e6)`, `entityPayment.ts:84-92`) so we never round *up* into float we don't have:

```ts
import type { Address } from "../types";

export interface StandingExposure {
  operatorEoa: bigint; // operator hot EOA USDC (in-transit fundOperator credits + job residue + gas seed)
  pocketEoa: bigint;   // pocket EOA USDC (pre-deposit + gas seed + un-swept residual)
  gateway: bigint;     // pocket's Gateway balance (un-withdrawable standing float), conservative floor
  total: bigint;       // operatorEoa + pocketEoa + gateway
}

export interface StandingExposureDeps {
  usdcBalanceOf: (owner: Address) => Promise<bigint>; // atomic USDC balance of an EOA
  gatewayAvailable: () => Promise<number>;            // PocketGateway.getAvailable() — decimal USDC
  operator: Address;
  pocket: Address;
}

/** Total un-clawback-able standing exposure for one agent's pocket, atomic USDC (6 decimals). */
export async function readStandingExposure(d: StandingExposureDeps): Promise<StandingExposure> {
  const [operatorEoa, pocketEoa, gwDecimal] = await Promise.all([
    d.usdcBalanceOf(d.operator),
    d.usdcBalanceOf(d.pocket),
    d.gatewayAvailable(),
  ]);
  const gateway = BigInt(Math.floor(gwDecimal * 1e6)); // conservative floor, mirrors entityPayment.ts
  return { operatorEoa, pocketEoa, gateway, total: operatorEoa + pocketEoa + gateway };
}
```

- **Gateway pending-inclusive:** `PocketGateway.getAvailable` returns only `getBalances().gateway.formattedAvailable` (`adapters/x402/gateway.ts:28-31`) — a just-mined-but-uncredited deposit is invisible, undercounting exposure exactly during back-to-back top-ups. **If** the SDK's `getBalances()` exposes a pending/total field (verify against `@circle-fin/x402-batching/client`), add a `PocketGateway.getTotal()` that includes it and use it for the **exposure/ceiling** read. Keep the settled `getAvailable()` for the pay preflight (only settled Gateway balance can actually pay). If no pending field exists, the in-process mutex (D4) is what prevents the concurrent-undercount overshoot; document that.

**`treasury_status` (`payments/entityPayment.ts`).** Deliberate refinement of the one-line ask "`treasury_status.float` reuses it": **keep `float` = spendable Gateway balance** (what a `pay` preflight can actually use — `entityPayment.ts:30-31,142,175-187`; redefining it to mean total standing would silently break the preflight's meaning and mislead the agent about how much it can spend), and **add** a `standing` field carrying the honest total + breakdown:

- Add to `TreasuryReader` (interface at `entityPayment.ts:17-23`): nothing new — it already has `usdcBalanceOf`; the Gateway read is via the existing `readPocketFloat` seam. `readStandingExposure` is wired in `status()` from `deps.reader.usdcBalanceOf` (operator = `entity.operator`, pocket = derived pocket address) + a Gateway read.
- Add to `TreasuryStatusView`: `standing: { operatorEoa: string; pocketEoa: string; gateway: string; total: string; ceiling: string }`.
- In `status()` (`entityPayment.ts:126-154`): compute `readStandingExposure(...)` inside the existing `Promise.all`, return it stringified alongside the unchanged `available`/`cap`/`paused`/`allowlistEnabled`/`float`/`balance`; add `ceiling: usdToUnits(cfg.maxPocketFloatUsdc).toString()`. The `!entity.treasury` early-return (`:127-136`) gains a zeroed `standing`.

The pay preflight at `entityPayment.ts:175-187` is **unchanged** (still Gateway-only spendable float).

### D3 — Enforce the ceiling at the choke point (`topUpPocket`)

`topUpPocket` (`payments/funding.ts:98-126`) is the verified single choke point: `adapter.fundOperator` and `gateway.deposit` are invoked **only** through its `FundingDeps` (`liveRunner.ts:227,229`); its only caller is `fundPocket` (`liveRunner.ts:217`); `fundPocket`'s only callers are `buildPocketFunding` → MCP `fund_pocket` (`payments/pocketFunding.ts:19`, `mcp/server.ts:197`) and the liveRunner leg-0 `fund` callback (`liveRunner.ts:375`). No CLI, no REST route. Enforcing here covers everything.

- Extend `FundingDeps` (`funding.ts:5-14`):
  ```ts
  standingExposure: () => Promise<StandingExposure>; // total un-clawback-able exposure, atomic
  ceiling: bigint;                                   // MAX_POCKET_FLOAT_USDC, atomic
  ```
- In `topUpPocket`, add the check **inside the `!opts.skipFundOperator` branch, before `fundOperator`, next to the existing `available()` check** (`funding.ts:108-113`):
  ```ts
  if (!opts.skipFundOperator) {
    const available = await d.available();
    if (amount > available) throw new Error(`top-up ${amount} exceeds available ${available}`);
    const standing = await d.standingExposure();
    if (standing.total + amount > d.ceiling) {
      throw new Error(
        JSON.stringify({
          error: "float-ceiling-exceeded",
          standing: standing.total.toString(),
          breakdown: {
            operatorEoa: standing.operatorEoa.toString(),
            pocketEoa: standing.pocketEoa.toString(),
            gateway: standing.gateway.toString(),
          },
          requested: amount.toString(),
          ceiling: d.ceiling.toString(),
        }),
      );
    }
    const fundHash = await d.fundOperator(d.treasury, amount);
    // …unchanged…
  }
  ```
- **The check is skipped when `skipFundOperator` is true.** That branch completes a stranded bridge (moves already-escaped operator funds → Gateway); total exposure is unchanged, so rejecting it would strand USDC on the operator EOA (strictly worse). This is also why the operator EOA is *counted* in D2: the retry path must not raise Gateway float past the ceiling invisibly.
- **Reject, not clamp.** For the explicit MCP tool, reject is predictable and self-correctable and does not mask a runaway loop the way a silent clamp would. The structured JSON message flows out unchanged: MCP `fund_pocket` already returns `reason: (e as Error).message` (`mcp/server.ts:227-233`), so the agent receives `{standing, breakdown, requested, ceiling}` and can self-correct.

### D4 — Per-entity in-process mutex around `fundPocket`

There is no serialization anywhere in the funding path today (only `jobs/jobRunner.ts:20` has an unrelated `inFlight` set). Two concurrent `fund_pocket` calls both read standing before either deposit lands → overshoot, hard-bounded only by the on-chain period cap. This is a **single-process SQLite / single-VPS** deployment, so an in-process keyed mutex closes it completely and cheaply.

New module `src/payments/keyedMutex.ts`:

```ts
const chains = new Map<string, Promise<unknown>>();

/** Serialize async work per key within this process. Single-process only (single-VPS/SQLite);
 *  a multi-process deployment would need an on-chain/db lock — superseded by Tier-0 batching. */
export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(() => fn(), () => fn()); // run regardless of the prior task's outcome
  chains.set(key, run.then(() => undefined, () => undefined)); // stored tail never rejects
  return run;
}
```

- Wrap **the body of `fundPocket`** (`agent/liveRunner.ts:167-235`) in `withKeyedLock(entityKey, async () => { …existing body… })`. `entityKey` (= `entity.idempotencyKey`) is passed to `fundPocket` by both callers (`pocketFunding.ts:24`, `liveRunner.ts:375`), so keying on it serializes all top-ups for one agent while leaving different agents concurrent. Because the D3 ceiling check now runs inside a serialized region, the second concurrent top-up sees the first's deposit reflected and rejects if it would exceed the ceiling.
- Known limitation (document inline): the `Map` grows one entry per agent for process lifetime — negligible for the demo; a periodic prune is optional and out of scope.

### D5 — liveRunner leg-0 `fund` becomes fund-to-target (no-wedge)

`runLive` calls `d.fund(d.floatAtomic)` **unconditionally at leg 0 of every run** (`liveRunner.ts:79`), and today `fund` is `(amt) => fundPocket(cfg, treasury, amt, …)` (`liveRunner.ts:375`) — it always pulls a fresh full float. Because the post-run sweep reclaims only the pocket EOA, not Gateway (`liveRunner.ts:292-311`, `pocketFloat.ts:11-16`), Gateway float persists across runs; after ~2 low-spend runs standing ≥ ceiling and **every subsequent run's leg-0 fund would reject** despite ample spendable float — a real availability regression introduced by D3. Fix: make leg-0 **fund to target** — top up only the shortfall, and no-op when the pocket already has enough spendable float.

In `buildLiveAgentRunner`, the pocket key is already derived (`liveRunner.ts:275`); build one `PocketGateway` for the read (or reuse the sweep's `pocketAddress`). Replace the `fund` callback:

```ts
const fundGateway = new PocketGateway({ pocketPrivateKey: pocketKey, rpcUrl: cfg.rpcUrl });
// leg-0: fund the pocket UP TO floatAtomic of spendable Gateway float; no-op if already covered.
const fundToTarget = async (target: bigint): Promise<Hex[]> => {
  const availDecimal = await fundGateway.getAvailable();
  const available = BigInt(Math.floor(availDecimal * 1e6)); // spendable (settled) Gateway float
  if (available >= target) return []; // already funded — no seed, no pull, no signatures
  const shortfall = target - available;
  return fundPocket(cfg, treasury, shortfall, operatorWallet, entity.idempotencyKey);
};
// …
fund: (amt) => fundToTarget(amt),
```

- Funding the **shortfall** (not the full `floatAtomic`) is what keeps it under the ceiling when float is partially drained: e.g. available 0.30, target 0.50 → fund 0.20 → standing ≈ seeds(0.40) + Gateway(0.50) = 0.90 ≤ 1.00. Funding the full 0.50 there would push standing to 1.20 and re-wedge.
- The MCP `fund_pocket` tool keeps the **hard reject** (D3) — an explicit operator/agent action, not an implicit leg-0 top-up. Only the liveRunner's automatic leg-0 becomes fund-to-target.
- Bonus: skipping the no-op case saves the gas seed + Turnkey signatures + the bridge txs on every run where float already covers the target.

### D6 — Legal-status check in `evaluatePolicy` (Martin-approved)

Close the off-chain gap: a suspended entity (LegalManager `status() != 0`) must not keep spending its standing Gateway float via x402. The adapter read already exists: `ArcAdapter.legalStatus(proxy)` (`adapters/arc/arcAdapter.ts:372-378`), and the LegalManager proxy is on the entity record as `entity.proxy` (`types.ts:40`; it is non-null whenever `treasury` is non-null — both are set together at onboarding step 4).

- `payments/policyGate.ts`:
  - Add `legalActive: boolean` to `PolicyInput` (`:3-13`).
  - Add `"legal-not-active"` to `PolicyReason` (`:15-21`).
  - Insert the check **immediately after the `paused` check** (mirrors the on-chain order in `_requireSpendable`, `AgentTreasury.sol:150-151`):
    ```ts
    if (i.paused) return { ok: false, reason: "paused" };
    if (!i.legalActive) return { ok: false, reason: "legal-not-active" };
    ```
- `payments/authority.ts`:
  - Add `legalActive: boolean` to `TreasuryState` (`:6-11`), pass it into `evaluatePolicy` (`:48-58`).
- `payments/entityPayment.ts` — the `readTreasury` closure (`:105-110`): add `legalActive: (await deps.reader.legalStatus(entity.proxy!)) === 0`. Extend the `TreasuryReader` interface (`:17-23`) with `legalStatus(proxy: Address): Promise<number>` (ArcAdapter already implements it). `buildAuthorize` closes over `entity`, so `entity.proxy` is in scope.
- `agent/liveRunner.ts` — the mirror `readTreasury` closure (`:338-343`): add `legalActive: (await adapter.legalStatus(entity.proxy!)) === 0`.

This adds one on-chain read per authorization (acceptable — the same closure already does 4). A suspended entity now fails `pay` with `policy-denied: legal-not-active` even with standing float, matching the contract's guarantee for `spend()`.

### D7 — Honest labeling (dashboard copy + docs to correct)

**Dashboard "Active rules" card** — `interface/src/components/agents/AgentDashboard.tsx:245-272` (the `RuleRow` list). Rewrite so it distinguishes on-chain-guaranteed rules from software-enforced x402 rules and stops implying x402 is ungoverned. Exact copy to render:

- Section label (existing): **Active rules**
- Group A — **On-chain (enforced by the treasury contract):**
  - `Period cap` — `{capUsdc} USDC / {periodHours}h rolling` (existing `RuleRow`s at `:261-262`)
  - `Guardian pause` — `On` / `Off` (from `treasury.paused`)
  - `Legal status` — `Active` / `Suspended`
  - `Allowlist (direct spend)` — `{n} allowlisted` / `Off` (existing `:263-269`)
- Group B — **Software-enforced on x402 payments (backend checks each payment against fresh on-chain state; not guaranteed if the backend is compromised):**
  - `Per-tx cap` — `{perTxUsdc} USDC` / `Not set` (existing `:257-260`)
  - `Allowlist / threshold` — same rules re-asserted before every payment
  - `Pause + legal status` — re-checked before every payment
  - `Standing float ceiling` — `≤ {ceiling} USDC held in pocket/Gateway at once` (from the new `treasury_status.standing.ceiling`)
- One-line footnote under the card: **"x402 payments enforce the same allowlist, per-tx and cap rules as direct on-chain spends — in software, against live on-chain reads. The float ceiling caps how much can sit beyond the guardian's reach at once."**

Do **not** ship any copy stating the allowlist/per-tx cap "don't apply" to x402 — that is the false framing this delta corrects.

**Docs to correct:**
- `back/docs/design/2026-06-28-honest-dashboard-design.md` — update the rules-card description to the two-group framing above.
- The **V2 roadmap S2 entry** — `back/docs/Novi-Corpus-V2-Roadmap.html` (source; the `.pdf` is regenerated from it, commit `ce592bd`): correct the S2 wording from "escapes the allowlist/per-tx cap" to "same rules, enforced in software vs on-chain; the on-chain-guaranteed x402 bounds are period cap + pause + legal status + the new standing-float ceiling."
- This design doc is the canonical reference for the corrected framing.

---

## Back-compat / data flow

- **Additive config:** `MAX_POCKET_FLOAT_USDC` defaults to `1.00`; existing deployments boot unchanged **provided** `MAX_POCKET_FLOAT_USDC ≥ FUNDING_FLOAT_USDC + 2×GAS_SEED_TARGET_USDC` (true for defaults: 1.00 ≥ 0.90). A deployment that has *raised* `FUNDING_FLOAT_USDC` or `GAS_SEED_TARGET_USDC` without raising the ceiling fails **at boot** with a clear message (fail-closed, by design) — flag this in the deploy note.
- **`treasury_status`** gains a `standing` object; `float`/`balance`/`available`/`cap` are unchanged → the frontend dashboard keeps working and gains the honest breakdown. `pay`'s preflight semantics are unchanged.
- **`FundingDeps`** gains two required fields (`standingExposure`, `ceiling`); the sole production caller (`fundPocket`) and the funding tests are updated. `topUpPocket`'s return shape is unchanged.
- **`PolicyInput` / `TreasuryState`** gain `legalActive`; all callers (`entityPayment`, `liveRunner`, tests) set it. `evaluatePolicy` gains one reason string.
- **No DB migration, no contract change, no new external dep.**
- Data flow unchanged otherwise: MCP `fund_pocket` and liveRunner leg-0 both still enter `fundPocket` → `topUpPocket`; the only new behavior is the pre-`fundOperator` ceiling gate, the per-agent lock, and (liveRunner only) the fund-to-target shortcut.

## Testing (non-vacuous — name each assertion)

- **`readStandingExposure`** (unit, fakes): sums **all three** balances — a fixture with operator EOA = 0.2, pocket EOA = 0.2, Gateway = 0.5 returns `total = 0.9e6`; Gateway decimal is floored (0.4999995 → 499999, never rounded up).
- **Config invariant** (`env.test`): `MAX_POCKET_FLOAT_USDC` default `1.00`; `loadConfig` **throws** when `ceiling < float + 2×seedTarget` (e.g. ceiling 0.50, float 0.50, seed 0.20 → throw) and **passes** at exactly the boundary (`0.90`).
- **`topUpPocket` ceiling** (extend `funding.test.ts`): with `ceiling = 1.0e6` and a `standingExposure` fake returning `total = 0.7e6`, `amount = 0.2e6` **allows** (0.9 ≤ 1.0) and `fundOperator` is called; `amount = 0.4e6` **rejects** (1.1 > 1.0) with a JSON message containing `float-ceiling-exceeded` + `breakdown` + `requested` + `ceiling`, and `fundOperator` is **not** called; boundary `standing + amount == ceiling` **allows**.
- **Ceiling skip on retry** (extend `funding.test.ts`): with `skipFundOperator: true`, the standing/ceiling check is **not** consulted and the forward+deposit proceed even if `standing.total` already exceeds the ceiling (completing a stranded bridge must not be blocked).
- **TOCTOU / mutex** (`keyedMutex.test` + `funding`/`fundPocket` integration): `withKeyedLock` runs same-key tasks strictly serially (interleave-detecting fake) and different keys concurrently; a prior task rejecting does not block the next; two concurrent `fund_pocket` calls for one agent do not both pass the ceiling check (the second sees the first's raised standing and rejects).
- **liveRunner no-wedge** (extend the liveRunner/`runLive` test): with a Gateway-available fake ≥ `floatAtomic`, leg-0 `fund` returns `[]` and `fundPocket` is **not** called (no seed, no pull); with available `< floatAtomic`, it funds exactly the **shortfall** (`floatAtomic − available`), not the full float; a run after float has accumulated to just under the ceiling still succeeds (the regression this delta prevents).
- **Legal-suspension rejects x402** (extend `policyGate.test` + `entityPayment`/`authority` test): `evaluatePolicy` returns `legal-not-active` when `legalActive: false` (checked **before** allowlist/cap, **after** paused); an `entityPayment.pay` with a `legalStatus` fake returning non-zero fails with `policy-denied: legal-not-active` **even when Gateway float covers the amount**; `legalActive: true` path unchanged.
- **`treasury_status.standing`** (extend `entityPayment` service test): returns the breakdown + `total` + `ceiling`; `float`/`balance`/`available`/`cap` unchanged; no-treasury early-return yields a zeroed `standing`.

`npx biome check src test` + `npx tsc --noEmit` clean per task (CI enforces Biome + vitest + forge).

## Non-goals

- **Tier-0 structural close** — treasury-direct x402 signing / smart-account policy module so the on-chain allowlist + per-tx cap reach the off-chain-chosen payee. This interim does not touch that; the ceiling + honest labeling are the whole scope.
- **S5 aggregate outflow meter** — a cross-agent / tenant-wide ceiling, rate-limit, and alerting. The per-agent ceiling here is deliberately per-pocket; do not smuggle in an aggregate meter.
- **S3 seed isolation** — single `POCKET_MASTER_SEED` = all pockets. Out of scope; the ceiling is not a defense against seed theft (see threat model).
- **No contract change** — `AgentTreasury.sol` is untouched. `fundOperator` stays allowlist-exempt and per-tx-uncapped on-chain; the interim bounds it in software.
- Withdrawing standing Gateway balance back to the treasury (the SDK wrapper has no withdraw path today) — separate, and superseded by Tier-0.

## Open questions

1. **Operator-EOA earnings vs the ceiling.** `readStandingExposure` counts the operator EOA, which is correct (those funds are genuinely un-clawback-able) — but it couples earning to float provisioning: if large job earnings are parked on the operator EOA (sweep off, or between jobs), a legitimate `fund_pocket` could be **rejected** because standing already exceeds the ceiling. With `JOB_SWEEP_TO_TREASURY=true` (now set on prod) earnings sweep to the treasury promptly, so operator residue is normally ~dust and the k=2 headroom absorbs the gas seed — but confirm: **is transient earnings-parking blocking a top-up acceptable interim behavior** (agent waits for the sweep / uses the explicit `sweep_earnings` v2 tool), or should the ceiling exclude a known-earnings component of the operator EOA? Recommend: accept it for the interim, document it, revisit with `sweep_earnings`. Needs Martin's call.

Everything else (default 1.00, reject-not-clamp, k=2, single-process mutex, keep `float` = spendable + add `standing`) is decided above and needs no further input.
