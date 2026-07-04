# x402 Demo Seller (Leg 3 smoke target) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose our existing x402 seller (`buildPaywall`) as a flag-gated, public, Arc-settling HTTP route so the BYOA "Leg 3 — pay x402" smoke test has a real endpoint to pay.

**Architecture:** Add three config vars, a small factory + mount function that instantiates the *existing* `buildPaywall(...)` with `settle` wired to Circle's Arc facilitator, and thread an optional dep through `buildApiApp`/`main.ts`. No new payment logic — the buyer, pocket signing, self-verify, replay guard, and facilitator settle already exist and are tested.

**Tech Stack:** TypeScript, Hono, viem, `@circle-fin/x402-batching`, zod (config), vitest, Biome. Backend at `back/backend` (no build step; `tsx`).

## Global Constraints

- Feature is **OFF by default**, gated by `ENABLE_X402_DEMO` (`"1"` or `"true"` → on). When off, the route is not mounted at all (→ 404).
- Route path is exactly `GET /x402-demo/quote`.
- Payment network is exactly `eip155:5042002` (Arc testnet), built as `eip155:${cfg.chainId}`; asset is `cfg.usdc` (USDC_ADDRESS); scheme comes from `buildRequirements` unchanged.
- Price default `"0.01"` USDC; must be `> 0` and `<= 1.0` USDC (≤ `1_000_000n` atomic at 6 decimals — keeps it under the 1 USDC `perTxCap` default). Convert with `usdToUnits` (from `src/policy/units`).
- `payTo` default is the **platform account address** derived from `PLATFORM_PRIVATE_KEY`; overridable via `X402_DEMO_PAYTO`.
- `settle` is wired via `makeSettle({ facilitatorUrl: cfg.gatewayFacilitatorUrl })` (default `https://gateway-api-testnet.circle.com`) so a paid request actually settles USDC. Self-verify stays local (no Circle API key on testnet) — `buildPaywall` already does this.
- Reuse `buildPaywall` / `buildRequirements` / `makeSettle` verbatim. Do not re-implement 402/verify/settle.
- No secrets in the served JSON body (static string payload only).
- Run `npx biome check src test` before every commit (CI enforces Biome). TDD; commit per task.

---

## File Structure

- `src/config/env.ts` (modify) — add `ENABLE_X402_DEMO`, `X402_DEMO_PAYTO`, `X402_DEMO_PRICE_USDC` to the zod schema + `Config` + `loadConfig`. Owns config parsing/validation + payTo default derivation.
- `src/api/routes/x402Demo.ts` (create) — owns the seller route: `X402DemoDeps` type, `buildX402DemoDeps(cfg)` factory (returns `undefined` when the flag is off), `mountX402DemoRoutes(app, deps)` that builds the paywall + settle and mounts it.
- `src/api/app.ts` (modify) — add optional `x402Demo?` to `ApiDeps`; mount it when present.
- `src/api/main.ts` (modify) — build the deps from `cfg` via `buildX402DemoDeps` and pass them in; log a warning when enabled.
- `test/config/x402Demo.test.ts` (create) — config parsing/defaults/validation.
- `test/api/x402Demo.route.test.ts` (create) — factory gating + route behavior (404 off, 402 requirements, 402 malformed).

Two tasks: **Task 1 = config**, **Task 2 = route module + wiring + tests**.

---

### Task 1: Config vars for the demo seller

**Files:**
- Modify: `src/config/env.ts` (schema at lines 18-60, `Config` at 62-105, `loadConfig` body at 133-168)
- Test: `test/config/x402Demo.test.ts`

**Interfaces:**
- Consumes: existing `loadConfig(env?)`, `usdToUnits` (already imported at `env.ts:3`), `addressSchema` (`env.ts:6`), `Address`/`Hex` types.
- Produces (later tasks rely on these `Config` fields):
  - `enableX402Demo: boolean`
  - `x402DemoPayTo: Address` (defaults to the `PLATFORM_PRIVATE_KEY` account address)
  - `x402DemoPriceUsdc: string` (human USD string, validated `0 < x ≤ 1.0`)

- [ ] **Step 1: Write the failing test**

Create `test/config/x402Demo.test.ts` (mirrors the focused style of `test/config/metadataUrl.test.ts`):

```ts
import { privateKeyToAccount } from "viem/accounts";
import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

const PK = `0x${"1".repeat(64)}` as const;
const baseEnv = { ARC_TESTNET_RPC_URL: "http://localhost:8545", PLATFORM_PRIVATE_KEY: PK };

test("x402 demo is off by default with a 0.01 price", () => {
  const cfg = loadConfig(baseEnv);
  expect(cfg.enableX402Demo).toBe(false);
  expect(cfg.x402DemoPriceUsdc).toBe("0.01");
});

test("ENABLE_X402_DEMO accepts '1' and 'true'", () => {
  expect(loadConfig({ ...baseEnv, ENABLE_X402_DEMO: "1" }).enableX402Demo).toBe(true);
  expect(loadConfig({ ...baseEnv, ENABLE_X402_DEMO: "true" }).enableX402Demo).toBe(true);
  expect(loadConfig({ ...baseEnv, ENABLE_X402_DEMO: "no" }).enableX402Demo).toBe(false);
});

test("payTo defaults to the platform account address, overridable", () => {
  const cfg = loadConfig(baseEnv);
  expect(cfg.x402DemoPayTo).toBe(privateKeyToAccount(PK).address);
  const override = "0x00000000000000000000000000000000000000ab";
  expect(loadConfig({ ...baseEnv, X402_DEMO_PAYTO: override }).x402DemoPayTo.toLowerCase()).toBe(
    override,
  );
});

test("price must be > 0 and <= 1.0 USDC", () => {
  expect(() => loadConfig({ ...baseEnv, X402_DEMO_PRICE_USDC: "0" })).toThrow(/1.0 USDC/);
  expect(() => loadConfig({ ...baseEnv, X402_DEMO_PRICE_USDC: "2" })).toThrow(/1.0 USDC/);
  expect(loadConfig({ ...baseEnv, X402_DEMO_PRICE_USDC: "0.05" }).x402DemoPriceUsdc).toBe("0.05");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back/backend && npx vitest run test/config/x402Demo.test.ts`
Expected: FAIL — `cfg.enableX402Demo` is `undefined` (property not on `Config` yet).

- [ ] **Step 3: Add the import**

At the top of `src/config/env.ts`, add the account helper (leave existing imports):

```ts
import { privateKeyToAccount } from "viem/accounts";
```

- [ ] **Step 4: Add the three schema fields**

Inside `EnvSchema` (add after `METADATA_BASE_URL` at `env.ts:59`, before the closing `})`):

```ts
  ENABLE_X402_DEMO: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  X402_DEMO_PAYTO: addressSchema.optional(),
  X402_DEMO_PRICE_USDC: z
    .string()
    .default("0.01")
    .refine(
      (v) => {
        try {
          const n = usdToUnits(v);
          return n > 0n && n <= 1_000_000n;
        } catch {
          return false;
        }
      },
      { message: "must be > 0 and <= 1.0 USDC (max 6 decimals)" },
    ),
```

- [ ] **Step 5: Add the `Config` fields**

In the `Config` interface (after `metadataBaseUrl: string;` at `env.ts:104`):

```ts
  enableX402Demo: boolean;
  x402DemoPayTo: Address;
  x402DemoPriceUsdc: string;
```

- [ ] **Step 6: Populate them in `loadConfig`**

In the `cfg` object literal (after `metadataBaseUrl: e.METADATA_BASE_URL,` at `env.ts:167`):

```ts
    enableX402Demo: e.ENABLE_X402_DEMO,
    x402DemoPayTo: e.X402_DEMO_PAYTO ?? (privateKeyToAccount(e.PLATFORM_PRIVATE_KEY).address as Address),
    x402DemoPriceUsdc: e.X402_DEMO_PRICE_USDC,
```

Note: no `redact()` change is needed — all three fields are JSON-safe and non-secret (bool, public address, plain string).

- [ ] **Step 7: Run test to verify it passes**

Run: `cd back/backend && npx vitest run test/config/x402Demo.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 8: Guard against regressions + lint**

Run: `cd back/backend && npx vitest run test/config.test.ts test/config && npx tsc --noEmit && npx biome check src test`
Expected: all pass, tsc clean, biome clean.

- [ ] **Step 9: Commit**

```bash
cd back/backend && git add src/config/env.ts test/config/x402Demo.test.ts
git commit -m "feat(x402-demo): config vars ENABLE_X402_DEMO/X402_DEMO_PAYTO/X402_DEMO_PRICE_USDC"
```

---

### Task 2: Seller route module + app wiring

**Files:**
- Create: `src/api/routes/x402Demo.ts`
- Modify: `src/api/app.ts` (`ApiDeps` at 22-62, `buildApiApp` at 65-99)
- Modify: `src/api/main.ts` (buildApiApp deps object at 111-138)
- Test: `test/api/x402Demo.route.test.ts`

**Interfaces:**
- Consumes:
  - `Config` fields from Task 1: `enableX402Demo`, `x402DemoPayTo`, `x402DemoPriceUsdc`, plus existing `usdc`, `chainId`, `gatewayFacilitatorUrl`, `metadataBaseUrl`.
  - `buildPaywall(cfg: PaywallConfig)` from `src/payments/seller.ts` — `PaywallConfig = { price: bigint; payTo: Address; asset: Address; network: string; resource?: string; resourceUrl?: string; settle?: SettleFn; serve: (req) => unknown }`; registers `GET {resource}`.
  - `makeSettle({ facilitatorUrl: string }): SettleFn` from `src/payments/settle.ts`.
  - `usdToUnits(s: string): bigint` from `src/policy/units.ts`.
- Produces (Task 3 / app wiring relies on these):
  - `interface X402DemoDeps { payTo: Address; asset: Address; network: string; price: bigint; facilitatorUrl: string; resourceUrl: string }`
  - `buildX402DemoDeps(cfg): X402DemoDeps | undefined` — `undefined` when `!cfg.enableX402Demo`.
  - `mountX402DemoRoutes(app: Hono, deps: X402DemoDeps): void`.

- [ ] **Step 1: Write the failing test**

Create `test/api/x402Demo.route.test.ts`:

```ts
import { Hono } from "hono";
import { expect, test } from "vitest";
import type { Config } from "../../src/config/env";
import { buildX402DemoDeps, mountX402DemoRoutes } from "../../src/api/routes/x402Demo";

const DEPS = {
  payTo: "0x00000000000000000000000000000000000000ab",
  asset: "0x3600000000000000000000000000000000000000",
  network: "eip155:5042002",
  price: 10000n,
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  resourceUrl: "https://example.test/backend/x402-demo/quote",
} as const;

test("no X-PAYMENT -> 402 with well-formed Arc requirements", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, DEPS);
  const res = await app.request("/x402-demo/quote");
  expect(res.status).toBe(402);
  const body = (await res.json()) as { accepts: Array<Record<string, unknown>> };
  expect(body.accepts[0]).toMatchObject({
    network: "eip155:5042002",
    asset: DEPS.asset,
    payTo: DEPS.payTo,
    maxAmountRequired: "10000",
  });
});

test("malformed X-PAYMENT -> 402 malformed", async () => {
  const app = new Hono();
  mountX402DemoRoutes(app, DEPS);
  const res = await app.request("/x402-demo/quote", { headers: { "X-PAYMENT": "not-valid!!" } });
  expect(res.status).toBe(402);
  const body = (await res.json()) as { error?: string };
  expect(body.error).toBe("malformed X-PAYMENT");
});

test("buildX402DemoDeps returns undefined when the flag is off", () => {
  const cfg = { enableX402Demo: false } as unknown as Config;
  expect(buildX402DemoDeps(cfg)).toBeUndefined();
});

test("buildX402DemoDeps builds Arc deps from config when on", () => {
  const cfg = {
    enableX402Demo: true,
    x402DemoPayTo: DEPS.payTo,
    usdc: DEPS.asset,
    chainId: 5042002,
    x402DemoPriceUsdc: "0.01",
    gatewayFacilitatorUrl: DEPS.facilitatorUrl,
    metadataBaseUrl: "https://example.test/backend",
  } as unknown as Config;
  const deps = buildX402DemoDeps(cfg);
  expect(deps).toBeDefined();
  expect(deps?.price).toBe(10000n);
  expect(deps?.network).toBe("eip155:5042002");
  expect(deps?.resourceUrl).toBe("https://example.test/backend/x402-demo/quote");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd back/backend && npx vitest run test/api/x402Demo.route.test.ts`
Expected: FAIL — cannot find module `src/api/routes/x402Demo`.

- [ ] **Step 3: Create the route module**

Create `src/api/routes/x402Demo.ts`:

```ts
import type { Hono } from "hono";
import type { Config } from "../../config/env";
import { usdToUnits } from "../../policy/units";
import { buildPaywall } from "../../payments/seller";
import { makeSettle } from "../../payments/settle";
import type { Address } from "../../types";

/** Everything the demo seller route needs, resolved from config. */
export interface X402DemoDeps {
  payTo: Address; // where the 0.01 USDC settles (a demo address we control)
  asset: Address; // USDC on Arc
  network: string; // "eip155:5042002"
  price: bigint; // atomic USDC (6 decimals)
  facilitatorUrl: string; // Circle Gateway facilitator (settle)
  resourceUrl: string; // public URL recorded in the settle payload
}

/**
 * Resolve the demo-seller deps from config, or `undefined` when the flag is off.
 * Only reads the fields it needs so it stays trivially unit-testable.
 */
export function buildX402DemoDeps(
  cfg: Pick<
    Config,
    | "enableX402Demo"
    | "x402DemoPayTo"
    | "usdc"
    | "chainId"
    | "x402DemoPriceUsdc"
    | "gatewayFacilitatorUrl"
    | "metadataBaseUrl"
  >,
): X402DemoDeps | undefined {
  if (!cfg.enableX402Demo) return undefined;
  return {
    payTo: cfg.x402DemoPayTo,
    asset: cfg.usdc,
    network: `eip155:${cfg.chainId}`,
    price: usdToUnits(cfg.x402DemoPriceUsdc),
    facilitatorUrl: cfg.gatewayFacilitatorUrl,
    resourceUrl: `${cfg.metadataBaseUrl}/x402-demo/quote`,
  };
}

/**
 * Mount the flag-gated public x402 demo seller at GET /x402-demo/quote.
 * Reuses buildPaywall: no header -> 402; valid X-PAYMENT -> self-verify -> settle
 * via Circle's facilitator -> serve a trivial static quote.
 */
export function mountX402DemoRoutes(app: Hono, deps: X402DemoDeps): void {
  const settle = makeSettle({ facilitatorUrl: deps.facilitatorUrl });
  const paywall = buildPaywall({
    price: deps.price,
    payTo: deps.payTo,
    asset: deps.asset,
    network: deps.network,
    resource: "/x402-demo/quote",
    resourceUrl: deps.resourceUrl,
    settle,
    serve: () => ({ quote: "BYOA x402 demo quote", resource: "/x402-demo/quote" }),
  });
  app.route("/", paywall);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd back/backend && npx vitest run test/api/x402Demo.route.test.ts`
Expected: PASS (4 tests). (The settle path is not exercised — no valid payment — so no network call; `buildPaywall`'s verify/settle internals are already covered by `test/payments/seller*.test.ts`.)

- [ ] **Step 5: Add the optional dep to `ApiDeps` + mount it**

In `src/api/app.ts`, add the import near the other route imports (after line 11 `mountMetadataRoutes`):

```ts
import { mountX402DemoRoutes } from "./routes/x402Demo";
```

Add to the `ApiDeps` interface (after `pocketFunding?` at `app.ts:61`):

```ts
  /** Optional flag-gated x402 demo seller (Leg 3 smoke target). Present only when
   *  ENABLE_X402_DEMO is set; absent -> route not mounted (404). */
  x402Demo?: import("./routes/x402Demo").X402DemoDeps;
```

In `buildApiApp`, mount it with the other public routes — add right after `mountMetadataRoutes(app, deps);` (`app.ts:77`):

```ts
  if (deps.x402Demo) mountX402DemoRoutes(app, deps.x402Demo);
```

- [ ] **Step 6: Wire composition in `main.ts`**

In `src/api/main.ts`, add the import (after line 27 `import { buildApiApp } from "./app";`):

```ts
import { buildX402DemoDeps } from "./routes/x402Demo";
```

Before the `const app = buildApiApp({` call (`main.ts:111`), build the deps:

```ts
  const x402Demo = buildX402DemoDeps(cfg);
  if (x402Demo)
    console.warn(`⚠ x402 demo seller ENABLED at /x402-demo/quote (payTo ${x402Demo.payTo})`);
```

Add `x402Demo,` to the `buildApiApp({ ... })` deps object (e.g. after `pocketFunding,` at `main.ts:137`):

```ts
    x402Demo,
```

- [ ] **Step 7: Verify the whole suite + types + lint**

Run: `cd back/backend && npx vitest run test/api/x402Demo.route.test.ts test/config/x402Demo.test.ts && npx tsc --noEmit && npx biome check src test`
Expected: route + config tests pass, tsc clean, biome clean.

- [ ] **Step 8: Commit**

```bash
cd back/backend && git add src/api/routes/x402Demo.ts src/api/app.ts src/api/main.ts test/api/x402Demo.route.test.ts
git commit -m "feat(x402-demo): flag-gated /x402-demo/quote seller route wired into the API"
```

---

## Post-implementation (not code tasks — for the controller)

1. **Full suite once:** `cd back/backend && npx vitest run && npx tsc --noEmit && npx biome check src test`.
2. **Deploy:** set `ENABLE_X402_DEMO=1` (and optionally `X402_DEMO_PAYTO`) in the VPS `.env`, restart. Confirm `curl https://project-alpha-pi.vercel.app/backend/x402-demo/quote` returns `402` with an `accepts[0].network == "eip155:5042002"`.
3. **Run Leg 3** (runbook in the design doc): `treasury_status` → `fund_treasury` → `fund_pocket` → `pay { to: ".../backend/x402-demo/quote", amountUsdc: 0.01 }` → expect 200 + settlement id in the ledger.
4. **After the leg is green:** unset the flag (route disappears); schedule a follow-up PR to remove the demo route module.

---

## Self-Review

**Spec coverage:**
- Flag-gated public route `/x402-demo/quote` → Task 2 (`mountX402DemoRoutes`, guarded mount in `app.ts`). ✓
- `settle` wired to Circle facilitator, self-verify local → Task 2 (`makeSettle` + `buildPaywall` reuse). ✓
- Config `ENABLE_X402_DEMO` / `X402_DEMO_PAYTO` (default platform addr) / `X402_DEMO_PRICE_USDC` (0.01, ≤1) → Task 1. ✓
- Off by default → Task 1 transform (absent → false) + Task 2 `buildX402DemoDeps` returns undefined + `if (deps.x402Demo)` mount. ✓
- Arc network `eip155:5042002`, USDC asset, price ≤ perTxCap → Global Constraints + Task 2 factory. ✓
- No secrets in served JSON → static `serve` payload. ✓
- Testing (404 off / 402 requirements / 402 malformed) → Task 2 test. ✓ Config parsing/validation → Task 1 test. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `X402DemoDeps` fields identical across the factory, mount fn, and test. `buildX402DemoDeps` param `Pick<Config, …>` matches the exact `Config` field names added in Task 1 (`enableX402Demo`, `x402DemoPayTo`, `x402DemoPriceUsdc`, `usdc`, `chainId`, `gatewayFacilitatorUrl`, `metadataBaseUrl`). `buildPaywall`/`makeSettle` signatures match `src/payments/seller.ts` + `settle.ts`. ✓
