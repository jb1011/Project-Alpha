# x402 Demo Seller (Leg 3 smoke target) — Design

**Date:** 2026-07-04 · **Area:** `back/backend` (Hono/TS) · **Type:** test-support feature (flag-gated)

## Goal

Stand up a **live, public, Arc-settling x402 seller endpoint** so we can run the last
BYOA smoke leg — **Leg 3: an Arc-funded agent pays an x402-priced resource** — end-to-end
through the MCP `pay` tool against a real HTTPS URL, with settlement on Circle's live
Gateway/Nanopayments facilitator on Arc testnet.

## Background (why this shape)

Verified by codebase exploration on 2026-07-04:

- Our buyer stack is **already built on Circle's Gateway/Nanopayments facilitator**
  (`GATEWAY_FACILITATOR_URL` default `https://gateway-api-testnet.circle.com`,
  `@circle-fin/x402-batching`, batched EIP-3009 against the GatewayWallet). The settle leg
  is **already proven live** (`test/payments/settle.live.test.ts`, `LIVE_SETTLE=1`, asserts a
  real transfer id on Arc testnet).
- The MCP `pay` path is complete and reusable as-is:
  `pay` → `EntityPaymentService.pay` → SSRF guard (**public https only**, blocks
  localhost/private) → pocket float preflight (reads the pocket's on-chain Circle Gateway
  balance) → `buyWithX402` → Authority policy gate → pocket `signX402` → real HTTPS retry with
  `X-PAYMENT` → records the settlement id in the SQLite payments ledger.
- **The only gap** is that our *seller* logic (`buildPaywall` in `src/payments/seller.ts`,
  `buildVendor` in `src/agent/vendor.ts`) is only ever invoked **in-process** (`.fetch()`),
  never bound to a port. There is no live URL to pay.
- It **must be our own seller**, not a third party: our `X-PAYMENT` wire format is a bespoke
  base64-JSON codec (`encodeX402Header`/`decodeX402Header`) — a deliberate workaround because
  Arc (`eip155:5042002`) isn't in the upstream `x402` network allowlist — so it only
  interoperates with our own matching decoder + Circle's facilitator. No public third-party
  x402 endpoint runs on Arc anyway (Coinbase's facilitator doesn't support Arc; Circle's Agent
  Marketplace is a discovery directory with no Arc-settled listings).

So the build is **wrap + deploy the existing seller behind a flag**, not new payment code.

## Architecture

Mount the existing `buildPaywall(...)` as a **flag-gated, public, unauthenticated** route on
the wizard/MCP backend (`buildApiApp`). When `ENABLE_X402_DEMO` is set, the app exposes:

```
GET /x402-demo/quote
  no X-PAYMENT            -> 402 { x402Version, accepts:[{ scheme, network:eip155:5042002,
                                   asset:<USDC>, payTo:<demo>, maxAmountRequired:<price>, ... }] }
  valid X-PAYMENT         -> verify (self) -> settle (Circle facilitator) -> 200 { quote... }
  bad/replayed X-PAYMENT  -> 402 { ..., error }
```

Reached in production at `https://project-alpha-pi.vercel.app/backend/x402-demo/quote`
(public https via the existing Vercel `/backend/*` proxy → VPS), which satisfies the buyer's
SSRF guard. The buyer (MCP `pay`) and seller are the same deployment; that is fine for a smoke
test — the payment still makes a real network round-trip, is signed by the agent's pocket, and
**settles real USDC on Circle's facilitator** from the pocket's Gateway balance to `payTo`.

`settle` **is** wired (via `makeSettle({ facilitatorUrl })`) so money actually moves — that is
the point of the leg. Self-verify stays local (no Circle API key needed on testnet), exactly
as `buildPaywall` already does.

## Components

### 1. Config — `src/config/env.ts`

Add three fields (all optional; feature off by default):

- `ENABLE_X402_DEMO: boolean` — coerced from env (`"1"`/`"true"` → true; default `false`).
- `X402_DEMO_PAYTO: Address` — the seller's payout address (a demo vendor address we control;
  default to the platform account address derived from `PLATFORM_PRIVATE_KEY`, so receipt is
  verifiable). Validated as an address.
- `X402_DEMO_PRICE_USDC: string` — human price, default `"0.01"`; converted to atomic bigint
  (6-decimal USDC → `10000n`) at wiring time. Must be `> 0` and `<= 1.0` (stays under the 1 USDC
  `perTxCap` default and is a sanity ceiling for a demo).

Reuse existing config for the rest: `USDC_ADDRESS` (asset), the Arc network string
(`eip155:${ARC_CHAIN_ID}` = `eip155:5042002`), and `GATEWAY_FACILITATOR_URL` (settle).

### 2. Seller route — `src/api/routes/x402Demo.ts` (new)

```ts
export interface X402DemoDeps {
  enabled: boolean;
  payTo: Address;
  asset: Address;
  network: string;          // "eip155:5042002"
  price: bigint;            // atomic USDC, e.g. 10000n = 0.01
  facilitatorUrl: string;   // https://gateway-api-testnet.circle.com
}

export function mountX402DemoRoutes(app: Hono, deps: X402DemoDeps): void {
  if (!deps.enabled) return;                     // off by default
  const settle = makeSettle({ facilitatorUrl: deps.facilitatorUrl });
  const paywall = buildPaywall({
    price: deps.price,
    payTo: deps.payTo,
    asset: deps.asset,
    network: deps.network,
    resource: "/x402-demo/quote",
    resourceUrl: "https://project-alpha-pi.vercel.app/backend/x402-demo/quote",
    settle,
    serve: () => ({ quote: "BYOA x402 demo quote", ts: /* injected clock or fixed */ }),
  });
  app.route("/", paywall);                        // paywall registers GET /x402-demo/quote
}
```

Notes:
- The `serve` payload is a trivial fixed JSON — the *resource* isn't the point, the payment is.
  Avoid `Date.now()` in the returned body if it complicates deterministic tests; a static string
  is fine.
- `buildPaywall` registers the route at its `resource` path, so mounting at `/` gives
  `GET /x402-demo/quote`.

### 3. App wiring — `src/api/app.ts`

- Extend `ApiDeps` with an optional `x402Demo?: X402DemoDeps`.
- Call `if (deps.x402Demo) mountX402DemoRoutes(app, deps.x402Demo);` **before** the
  `requireAuth` path guards (or anywhere — the path is not auth-scoped). Placed alongside the
  other public mounts (`mountSchemaRoutes`/`mountMetadataRoutes`).
- CORS: the existing origin callback returns `webOrigin` for non-`/metadata/` paths. The seller
  is machine-to-machine (our server-side buyer), so browser CORS is irrelevant; no change needed.

### 4. Composition — `src/api/main.ts`

Build `x402Demo` from config only when `ENABLE_X402_DEMO` is true:

```ts
const x402Demo = cfg.enableX402Demo
  ? {
      enabled: true,
      payTo: cfg.x402DemoPayTo,
      asset: cfg.usdcAddress,
      network: `eip155:${cfg.arcChainId}`,
      price: parseUsdc(cfg.x402DemoPriceUsdc),   // "0.01" -> 10000n
      facilitatorUrl: cfg.gatewayFacilitatorUrl,
    }
  : undefined;
// pass x402Demo into buildApiApp deps
```

## Security

- **Public + unauthenticated is intended** — an x402 seller must be reachable to issue the 402.
  Risk surface is bounded: fixed route, fixed price/payTo from config (never user input), no
  path parameters (no traversal), trivial static resource body.
- **Off by default, flag-gated** (`ENABLE_X402_DEMO`) so it is not a standing prod attack
  surface; enable on the VPS only for the test window, then unset (and remove the route in a
  follow-up once the leg is proven).
- **Self-verify** rejects wrong-recipient / underpriced / expired / bad-signature / replayed
  (in-memory nonce set — acceptable for a demo; durable store is a noted non-goal).
- **Settle** moves funds only for a validly-signed authorization the pocket produced; the buyer
  side is already governed (Authority policy gate + treasury caps + `perTxCap`).
- No secrets in the served JSON. `payTo` and price are public by nature (they're in the 402).

## Testing

`test/api/x402Demo.route.test.ts` (Hono `app.request`, no network):
- Flag **off** → `GET /x402-demo/quote` is 404 (route not mounted).
- Flag **on**, no `X-PAYMENT` → 402 with a well-formed `accepts[0]` (scheme, `network`
  `eip155:5042002`, `asset`, `payTo`, `maxAmountRequired` = configured price).
- Flag **on**, malformed `X-PAYMENT` → 402 `{ error: "malformed X-PAYMENT" }`.
- (If a signed-header fixture helper already exists for `buildPaywall`/`signX402` tests, add a
  happy-path 200 with `settle` stubbed; otherwise the settle path is left to the live runbook —
  do **not** hit the real facilitator in unit tests.)

Mirror any existing `buildPaywall` test for fixture patterns. `npx biome check src test` per task.

## Leg 3 live runbook (post-deploy, manual)

Preconditions: `ENABLE_X402_DEMO=1` + `X402_DEMO_PAYTO` set on the VPS and redeployed;
TestBootstrapMB_1 is `bound` with a provisioned operator; `POCKET_MASTER_SEED`/`TURNKEY_*`/
`TREASURY_ADDRESS` present (already on the box).

1. `treasury_status` (TestBootstrapMB_1) — confirm empty.
2. `fund_treasury` — put ~1 USDC of Arc-testnet USDC into the treasury.
3. `fund_pocket` — bridge ~0.1 USDC treasury → operator → pocket → Gateway deposit.
4. `pay { to: "https://project-alpha-pi.vercel.app/backend/x402-demo/quote", amountUsdc: 0.01 }`
   → expect 200 + a settlement id.
5. Verify: MCP result shows the paid quote; the payments ledger row records the settlement id;
   optionally confirm `X402_DEMO_PAYTO`'s Gateway balance increased on Circle's facilitator.

## Non-goals

- Durable (SQLite) seen-nonce store for the seller — in-memory is fine for a demo.
- A permanent/public commercial seller — this is a smoke target, removed after the leg passes.
- Third-party / cross-ecosystem interop (would require the standard x402 envelope + a
  buyer-side adaptation) — tracked as a separate future "x402 interop" leg.

## Deployment / rollback

- Enable: set `ENABLE_X402_DEMO=1` + `X402_DEMO_PAYTO=<addr>` in the VPS `.env`, restart.
- Rollback: unset the flag + restart (route disappears). Full removal of the route module is a
  follow-up PR after Leg 3 is green.
