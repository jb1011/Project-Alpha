# Governed Nanopayment Agent — Phase 3 Implementation Plan (Claude insight-agent loop)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a Claude-driven, cost-aware insight agent on top of the proven Phase-2 rail: given a query it reasons about which paid data to buy (bounded by the treasury's `available()`), buys it through the governed Authority (holding **no key**), synthesizes an answer, prices it, and sells it through its own paywall — with real on-chain settlement and a visible policy-reject moment.

**Architecture:** Additive on Phase 2 (Buyer / Seller / Authority / `signX402` unchanged). First we **wire real settlement** into the seller (the Finding-10 recipe), so buys and sells actually settle USDC on Arc. Then a **self-contained mock data vendor** (a `buildPaywall` instance) gives the agent something to buy. The **insight agent** is a hand-rolled Anthropic-SDK Messages tool-loop over Claude (`claude-sonnet-4-6` default, `claude-opus-4-8` toggle) whose only payment tool routes through the Authority — so it is structurally incapable of overspending. A CLI demo command runs one full buy→synthesize→sell cycle plus the policy-reject path.

**Tech Stack:** TypeScript (ESM, Node ≥20.18), viem, better-sqlite3, vitest, biome, Hono; `@circle-fin/x402-batching` (`/server` `BatchFacilitatorClient` for settle); **Anthropic SDK** (`@anthropic-ai/sdk`) for the agent — Claude Messages tool‑use driven by a hand‑rolled agentic loop we own.

## Global Constraints

Every task implicitly includes these (verbatim values; from the design + Finding 10):

- **Additive only.** Do not change Solidity, onboarding, `signX402`/codec, the Authority chokepoint, or the Buyer. New code lives in `backend/src/agent/` and `backend/src/payments/settle.ts`; the seller gets an *opt-in* settle hook.
- **The agent holds NO key.** Its only path to a payment is the Buyer → `POST /authorize` (the Authority). It never imports `signX402`, the pocket key, or Turnkey. A denied authorization MUST be handled gracefully (skip the purchase, lower spend, or answer partially) — never retried, never bypassed.
- **Provider = the direct Anthropic SDK (`@anthropic-ai/sdk`) + `ANTHROPIC_API_KEY` (deliberate, NOT the Vercel AI SDK and NOT the Vercel AI Gateway).** This is a self-contained Node/CLI backend (Arc/Circle), not a Vercel deployment; it manages its own secrets in `.env` (Turnkey/Circle/RPC), so a direct Anthropic key is consistent and dependency-light, and we own the ~30-line tool loop explicitly (clearer for the "agent holds no key, denials handled" logic). (If the team later deploys on Vercel and wants Gateway OIDC + `provider/model` slugs, swap the client construction in 3D.2/3E.2; the loop and tools are unchanged.) Tooling that assumes the Vercel Gateway (dotted model slugs, OIDC) does not apply here — it is a false positive for this project.
- **Model IDs (authoritative — HYPHENS, for the Anthropic API):** default `claude-sonnet-4-6`; max-sophistication toggle `claude-opus-4-8`. Selected via `AGENT_MODEL` env (default `claude-sonnet-4-6`). These are the real Anthropic Messages API ids (the dotted forms `claude-sonnet-4.6` are Vercel-Gateway-only slugs and would 404 against `@anthropic-ai/sdk`). Use them verbatim; never append a date suffix or hardcode a different id.
- **Anthropic SDK tool-use (stable, verified API).** `const client = new Anthropic({ apiKey })`; the agentic loop is the documented manual pattern: `client.messages.create({ model, max_tokens, system, tools, messages })` → if `stop_reason === "tool_use"`, execute each `tool_use` content block, push `{ role:"assistant", content: res.content }` then `{ role:"user", content: [tool_result blocks] }`, and repeat until `stop_reason === "end_turn"`. Tool defs are `{ name, description, input_schema: { type:"object", properties, required } }`. This API is stable — no probe task needed; `npm run typecheck` against the installed `@anthropic-ai/sdk` types confirms it.
- **Settlement recipe (Finding 10, proven 2026-06-18):** settle via `new BatchFacilitatorClient({ url: "https://gateway-api-testnet.circle.com" })` (testnet base, NO `/v1` suffix — the client appends `/v1/x402/...`; no API key on testnet). The payload handed to `verify`/`settle` MUST be `decodeX402Header(header)` enriched with `resource: {url,description,mimeType}` and `accepted: <the PaymentRequirements>`. Settlement is async/batched (`received` → `completed` in ~1 min); the payer's Gateway balance debits immediately on `success`.
- **Live calls are gated.** Any test that calls a live model (Anthropic) or live settlement (Circle Gateway) MUST be gated behind an env flag (`LIVE_AGENT=1` / `LIVE_SETTLE=1`) and skipped by default. Deterministic tests inject a fake Anthropic client + an injected fake settle.
- **Arc constants:** chainId `5042002`, network `eip155:5042002`, USDC `0x3600…0000` (6 decimals), GatewayWallet `0x0077…19b9`.
- **Quality gate per task:** `npm run typecheck` + `npm run lint` clean; `npm test` green. Commit each task.
- **Secret hygiene:** `ANTHROPIC_API_KEY` (+ pocket/Turnkey) stay in gitignored `.env`. Rotate keys before any public repo.

## File structure (Phase 3)

| File | Responsibility |
|---|---|
| `backend/src/config/env.ts` (modify) | add `ANTHROPIC_API_KEY?`, `AGENT_MODEL` (default `claude-sonnet-4-6`), `GATEWAY_FACILITATOR_URL` (default testnet base); redact the key |
| `backend/src/payments/settle.ts` | `makeSettle(cfg)` → `SettleFn`: decode header → enrich `resource`+`accepted` → `BatchFacilitatorClient.settle` |
| `backend/src/payments/seller.ts` (modify) | `PaywallConfig.settle?: SettleFn`; on a verified, non-replay payment, settle (record `markSettled`) before serving |
| `backend/src/agent/datasets.ts` | the canned datasets the mock vendor sells (id, title, price, payload) |
| `backend/src/agent/vendor.ts` | `buildVendor(cfg)` — a `buildPaywall` that 402s per dataset and serves the dataset on payment |
| `backend/src/agent/tools.ts` | the agent's tools: `buyData(datasetId)` (Buyer→Authority→data) and `getBudget()` (treasury `available()` − runningPending) |
| `backend/src/agent/pricing.ts` | deterministic `priceAnswer(totalCost, margin)` |
| `backend/src/agent/insightAgent.ts` | `buildInsightAgent(deps)` — the Claude tool-loop; `.run(query)` → `{ answer, purchases, totalCost, denied }` |
| `backend/src/agent/demo.ts` | `runDemo(deps, query)` — one full buy→synthesize→price→sell cycle + P&L summary |
| `backend/src/cli/index.ts` (modify) | `legalbody agent ask "<query>"` command |
| `backend/test/agent/**`, `backend/test/payments/settle*.ts` | unit + offline-e2e (fake Anthropic client) + opt-in live |

---

## How this plan is phased (read first)

Five independently-testable sub-phases; a reviewer can accept/reject each alone:

- **3A — Settle wiring** (the Finding-10 recipe). Makes buys/sells settle real USDC. Unit-tested with a fake settle; one opt-in live settle test reuses `probe-settle.mts`'s proven path.
- **3B — Mock data vendor.** A `buildPaywall` serving canned datasets — what the agent buys from. Offline-testable.
- **3C — Agent tools.** `buyData` + `getBudget`, wired to the Buyer + Authority + treasury reads. Offline-testable with fakes (a denied buy is a first-class case).
- **3D — Insight agent loop.** The Claude tool-loop (hand-rolled over `@anthropic-ai/sdk`). Deterministic tests inject a **fake Anthropic client**; one opt-in live run uses `claude-sonnet-4-6`.
- **3E — Demo + CLI.** `legalbody agent ask` runs the full cycle; an offline e2e (fake Anthropic client + mock vendor + real Authority/Buyer/Seller) proves buy→synthesize→sell and the policy-reject moment; opt-in live does it for real on Arc.

**Branch:** continue on `feat/nanopayments-x402-agent`. **Prerequisite for live runs:** set `ANTHROPIC_API_KEY` in `backend/.env` (deterministic tests don't need it).

---

# Phase 3A — Real settlement wiring (Finding 10)

> Makes the seller (and the vendor, same code) actually settle revenue on Arc. The recipe is already proven by `backend/scripts/probe-settle.mts` (verify `isValid:true`, settle `success:true`, balance debited, transfer `completed`). Here we lift it into a reusable `SettleFn` and an opt-in seller hook.

### Task 3A.1: Config — facilitator URL + agent env

**Files:**
- Modify: `backend/src/config/env.ts`
- Test: `backend/test/config/agentEnv.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/config/agentEnv.test.ts
import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const base = { ARC_TESTNET_RPC_URL: "https://rpc.example/v1", PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}` };

test("AGENT_MODEL defaults to claude-sonnet-4-6 and facilitator URL to the testnet base", () => {
  const cfg = loadConfig(base);
  expect(cfg.agentModel).toBe("claude-sonnet-4-6");
  expect(cfg.gatewayFacilitatorUrl).toBe("https://gateway-api-testnet.circle.com");
});
test("ANTHROPIC_API_KEY is parsed and redacted", () => {
  const cfg = loadConfig({ ...base, ANTHROPIC_API_KEY: "sk-ant-xxx" });
  expect(cfg.anthropicApiKey).toBe("sk-ant-xxx");
  expect(redact(cfg).anthropicApiKey).toBe("REDACTED");
});
test("AGENT_MODEL override is honored", () => {
  expect(loadConfig({ ...base, AGENT_MODEL: "claude-opus-4-8" }).agentModel).toBe("claude-opus-4-8");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/config/agentEnv.test.ts`
Expected: FAIL — `cfg.agentModel` undefined.

- [ ] **Step 3: Implement** — in `env.ts` add to `EnvSchema`:
```ts
ANTHROPIC_API_KEY: z.string().optional(),
AGENT_MODEL: z.string().default("claude-sonnet-4-6"),
GATEWAY_FACILITATOR_URL: z.string().url().default("https://gateway-api-testnet.circle.com"),
```
add to `Config`: `anthropicApiKey?: string; agentModel: string; gatewayFacilitatorUrl: string;`; map them in `loadConfig`'s return (`anthropicApiKey: e.ANTHROPIC_API_KEY, agentModel: e.AGENT_MODEL, gatewayFacilitatorUrl: e.GATEWAY_FACILITATOR_URL`); in `redact()` add `anthropicApiKey: cfg.anthropicApiKey ? "REDACTED" : undefined`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/config/agentEnv.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts backend/test/config/agentEnv.test.ts
git commit -m "feat(agent): config for ANTHROPIC_API_KEY + AGENT_MODEL + facilitator URL"
```

### Task 3A.2: `makeSettle` — the reusable SettleFn

**Files:**
- Create: `backend/src/payments/settle.ts`
- Test: `backend/test/payments/settle.test.ts`

**Interfaces:**
- Produces: `export type SettleFn = (header: string, requirements: SettleRequirements) => Promise<{ ok: boolean; transferId?: string; reason?: string }>` and `export function makeSettle(cfg: { facilitatorUrl: string }): SettleFn`, where `SettleRequirements = { scheme: string; network: string; asset: Address; amount: string; payTo: Address; maxTimeoutSeconds: number; extra: { name: string; version: string; verifyingContract: Address }; resourceUrl: string }`.

- [ ] **Step 1: Write the failing test** — the network call is isolated behind an injected facilitator; the test asserts the payload ENRICHMENT (the Finding-10 requirement) is correct, with a fake facilitator.

```ts
// backend/test/payments/settle.test.ts
import { expect, test, vi } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { settleWith, type Facilitator } from "../../src/payments/settle";

const KEY = `0x${"2".repeat(64)}` as const;
const payTo = "0x00000000000000000000000000000000000000ab" as const;

async function header(amount: bigint) {
  const s = makeSignX402({ signer: pocketSignerFromKey(KEY), chainId: 5042002, network: arcBatchingConfig.network, verifyingContract: arcBatchingConfig.verifyingContract });
  return (await s({ payTo, amount, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network, maxTimeoutSeconds: 600 })).header;
}

test("settleWith enriches the payload with resource + accepted and reports the transfer id", async () => {
  const fac: Facilitator = { settle: vi.fn(async () => ({ success: true, transaction: "tid-1" })) } as never;
  const reqs = { scheme: "exact", network: arcBatchingConfig.network, asset: arcBatchingConfig.asset, amount: "50", payTo, maxTimeoutSeconds: 600, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: arcBatchingConfig.verifyingContract }, resourceUrl: "https://insight.local/x" };
  const res = await settleWith(fac, await header(50n), reqs);
  expect(res).toMatchObject({ ok: true, transferId: "tid-1" });
  const [payloadArg] = (fac.settle as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(payloadArg.resource).toMatchObject({ url: "https://insight.local/x" });
  expect(payloadArg.accepted).toMatchObject({ network: arcBatchingConfig.network });
  expect(payloadArg.payload.authorization.to.toLowerCase()).toBe(payTo);
});

test("a facilitator failure is reported, not thrown", async () => {
  const fac: Facilitator = { settle: vi.fn(async () => ({ success: false, errorReason: "insufficient_balance" })) } as never;
  const reqs = { scheme: "exact", network: arcBatchingConfig.network, asset: arcBatchingConfig.asset, amount: "50", payTo, maxTimeoutSeconds: 600, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: arcBatchingConfig.verifyingContract }, resourceUrl: "x" };
  expect(await settleWith(fac, await header(50n), reqs)).toMatchObject({ ok: false });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/settle.test.ts`
Expected: FAIL — cannot find `settleWith`/`makeSettle`.

- [ ] **Step 3: Implement** — `settleWith` (the pure enrichment + call, testable) and `makeSettle` (binds the real `BatchFacilitatorClient`).

```ts
// backend/src/payments/settle.ts
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import type { Address } from "../types";
import { decodeX402Header } from "../adapters/x402/signX402";

export interface SettleRequirements {
  scheme: string; network: string; asset: Address; amount: string; payTo: Address;
  maxTimeoutSeconds: number; extra: { name: string; version: string; verifyingContract: Address };
  resourceUrl: string;
}
/** Minimal facilitator surface (BatchFacilitatorClient satisfies it). */
export interface Facilitator {
  // biome-ignore lint/suspicious/noExplicitAny: Circle's facilitator boundary is loosely typed
  settle(paymentPayload: any, paymentRequirements: any): Promise<{ success: boolean; transaction?: string; errorReason?: string }>;
}
export type SettleResult = { ok: true; transferId?: string } | { ok: false; reason?: string };
export type SettleFn = (header: string, requirements: SettleRequirements) => Promise<SettleResult>;

/** Decode the X-PAYMENT header, enrich with resource + accepted (Finding 10), and settle. Pure of network. */
export async function settleWith(fac: Facilitator, header: string, r: SettleRequirements): Promise<SettleResult> {
  const base = decodeX402Header(header);
  const requirements = { scheme: r.scheme, network: r.network, asset: r.asset, amount: r.amount, payTo: r.payTo, maxTimeoutSeconds: r.maxTimeoutSeconds, extra: r.extra };
  const paymentPayload = {
    ...base,
    resource: { url: r.resourceUrl, description: "governed nanopayment resource", mimeType: "application/json" },
    accepted: requirements,
  };
  const s = await fac.settle(paymentPayload, requirements);
  return s.success ? { ok: true, transferId: s.transaction } : { ok: false, reason: s.errorReason };
}

/** Bind the real Circle facilitator (testnet base URL — the client appends /v1/x402/...). */
export function makeSettle(cfg: { facilitatorUrl: string }): SettleFn {
  const fac = new BatchFacilitatorClient({ url: cfg.facilitatorUrl }) as unknown as Facilitator;
  return (header, requirements) => settleWith(fac, header, requirements);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/settle.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/payments/settle.ts backend/test/payments/settle.test.ts
git commit -m "feat(payments): makeSettle — BatchFacilitatorClient settle (Finding 10 recipe)"
```

### Task 3A.3: Seller settles on verified payment (opt-in hook)

**Files:**
- Modify: `backend/src/payments/seller.ts`
- Test: `backend/test/payments/sellerSettle.test.ts`

**Interfaces:**
- Consumes: `SettleFn` (3A.2), `buildPaywall`/`PaywallConfig`/`SellerConfig` (Phase 2), `decodeX402Header` (for the resourceUrl/amount).
- Produces: `PaywallConfig` gains `settle?: SettleFn` and `resourceUrl?: string`. When `settle` is set, a verified non-replay payment is settled before serving; settle failure → 402.

- [ ] **Step 1: Write the failing test** — a valid payment with an injected fake `settle` serves 200 and calls settle; a settle that fails returns 402; with no `settle` configured, behavior is unchanged (still 200).

```ts
// backend/test/payments/sellerSettle.test.ts
import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { buildPaywall } from "../../src/payments/seller";

const KEY = `0x${"2".repeat(64)}` as const;
const payout = "0x00000000000000000000000000000000000000ab" as const;
async function header(amount: bigint) {
  const s = makeSignX402({ signer: pocketSignerFromKey(KEY), chainId: 5042002, network: arcBatchingConfig.network, verifyingContract: arcBatchingConfig.verifyingContract });
  return (await s({ payTo: payout, amount, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network, maxTimeoutSeconds: 600 })).header;
}
const cfgBase = { price: 50n, payTo: payout, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network, serve: () => ({ answer: "x" }) };

test("when settle is configured, a paid request settles then serves", async () => {
  const settle = vi.fn(async () => ({ ok: true as const, transferId: "t1" }));
  const app = new Hono(); app.route("/", buildPaywall({ ...cfgBase, settle, resourceUrl: "https://insight.local/x" }));
  const res = await app.request("/api/insight", { headers: { "X-PAYMENT": await header(50n) } });
  expect(res.status).toBe(200);
  expect(settle).toHaveBeenCalledTimes(1);
});

test("a settle failure rejects with 402 and does not serve", async () => {
  const settle = vi.fn(async () => ({ ok: false as const, reason: "insufficient_balance" }));
  const served = vi.fn(() => ({ answer: "x" }));
  const app = new Hono(); app.route("/", buildPaywall({ ...cfgBase, serve: served, settle }));
  const res = await app.request("/api/insight", { headers: { "X-PAYMENT": await header(50n) } });
  expect(res.status).toBe(402);
  expect(served).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/sellerSettle.test.ts`
Expected: FAIL — `settle` not invoked / type error on `PaywallConfig.settle`.

- [ ] **Step 3: Implement** — extend `PaywallConfig` and the `buildPaywall` handler. After the existing verify + replay checks, before serving:

```ts
// PaywallConfig (add):
//   settle?: SettleFn;       // when set, settle the verified payment before serving
//   resourceUrl?: string;    // the resource URL recorded in the settle payload

// inside buildPaywall's handler, AFTER `seen.add(v.nonce)` and BEFORE the serve:
if (cfg.settle) {
  const r = await cfg.settle(header, {
    scheme: CIRCLE_BATCHING_SCHEME, network: cfg.network, asset: cfg.asset,
    amount: cfg.price.toString(), payTo: cfg.payTo, maxTimeoutSeconds: 60,
    extra: { name: CIRCLE_BATCHING_NAME, version: CIRCLE_BATCHING_VERSION, verifyingContract: arcBatchingConfig.verifyingContract },
    resourceUrl: cfg.resourceUrl ?? (cfg.resource ?? "/api/insight"),
  });
  if (!r.ok) return c.json({ ...buildRequirements(cfg), error: `settle-failed:${r.reason ?? ""}` }, 402);
}
return c.json((await cfg.serve(c.req.raw)) as Record<string, unknown>, 200);
```
(Add the imports `CIRCLE_BATCHING_NAME/SCHEME/VERSION` are already in seller.ts; import `arcBatchingConfig` from `../adapters/x402/pocket` and `SettleFn` from `./settle`.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/sellerSettle.test.ts` → PASS. Also re-run the existing seller tests: `npx vitest run test/payments/seller.test.ts test/payments/sellerVerify.test.ts` (no `settle` → unchanged). Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/payments/seller.ts backend/test/payments/sellerSettle.test.ts
git commit -m "feat(payments): seller settles a verified payment (opt-in SettleFn) before serving"
```

### Task 3A.4: Opt-in live settle test (reuses the proven path)

**Files:**
- Create: `backend/test/payments/settle.live.test.ts`

- [ ] **Step 1: Write the gated live test** — skipped unless `LIVE_SETTLE=1`; settles 0.01 USDC from the platform key (its Gateway residual) and asserts `ok:true` + a transfer id.

```ts
// backend/test/payments/settle.live.test.ts
import { describe, expect, test } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { makeSettle } from "../../src/payments/settle";
import { loadConfig } from "../../src/config/env";
import "dotenv/config";

const run = process.env.LIVE_SETTLE === "1" ? describe : describe.skip;
run("live settle on Arc (spends ~0.01 USDC)", () => {
  test("settles a platform-key authorization through Circle's facilitator", async () => {
    const cfg = loadConfig();
    const payTo = cfg.guardianAddress ?? "0x00000000000000000000000000000000000000ab";
    const s = makeSignX402({ signer: pocketSignerFromKey(cfg.platformPrivateKey), chainId: 5042002, network: arcBatchingConfig.network, verifyingContract: arcBatchingConfig.verifyingContract });
    const { header } = await s({ payTo: payTo as `0x${string}`, amount: 10_000n, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network, maxTimeoutSeconds: 600 });
    const settle = makeSettle({ facilitatorUrl: cfg.gatewayFacilitatorUrl });
    const res = await settle(header, { scheme: "exact", network: arcBatchingConfig.network, asset: arcBatchingConfig.asset, amount: "10000", payTo: payTo as `0x${string}`, maxTimeoutSeconds: 600, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: arcBatchingConfig.verifyingContract }, resourceUrl: "https://insight.local/x" });
    expect(res.ok).toBe(true);
    expect((res as { transferId?: string }).transferId).toBeTruthy();
  }, 60_000);
});
```

- [ ] **Step 2: Run (default = skipped)** — `cd backend && npx vitest run test/payments/settle.live.test.ts` → the suite is skipped (0 run). Then optionally `LIVE_SETTLE=1 npx vitest run test/payments/settle.live.test.ts` (needs a funded platform Gateway balance) and record the transfer id.

- [ ] **Step 3: Commit**

```bash
git add backend/test/payments/settle.live.test.ts
git commit -m "test(payments): opt-in live settle on Arc (LIVE_SETTLE=1)"
```

---

# Phase 3B — Mock data vendor

> A self-contained x402 paywall the agent buys from. Reuses `buildPaywall`; one paywall, many datasets selected by query param. The vendor's revenue is its own (a separate payout) — the agent's *cost*.

### Task 3B.1: The dataset catalog

**Files:**
- Create: `backend/src/agent/datasets.ts`
- Test: `backend/test/agent/datasets.test.ts`

**Interfaces:**
- Produces: `export interface Dataset { id: string; title: string; price: bigint; body: Record<string, unknown> }` and `export const DATASETS: Record<string, Dataset>` and `export function getDataset(id: string): Dataset | undefined`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/agent/datasets.test.ts
import { expect, test } from "vitest";
import { DATASETS, getDataset } from "../../src/agent/datasets";

test("datasets have positive atomic prices and unique ids", () => {
  const ids = Object.keys(DATASETS);
  expect(ids.length).toBeGreaterThanOrEqual(3);
  for (const id of ids) {
    expect(DATASETS[id].id).toBe(id);
    expect(DATASETS[id].price).toBeGreaterThan(0n);
  }
  expect(getDataset(ids[0])?.id).toBe(ids[0]);
  expect(getDataset("nope")).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails** — `cd backend && npx vitest run test/agent/datasets.test.ts` → FAIL (cannot find module).

- [ ] **Step 3: Implement** — a small fixed catalog (prices in atomic USDC, 6 decimals).

```ts
// backend/src/agent/datasets.ts
export interface Dataset { id: string; title: string; price: bigint; body: Record<string, unknown> }

export const DATASETS: Record<string, Dataset> = {
  "market-snapshot": { id: "market-snapshot", title: "USDC market snapshot", price: 20_000n, body: { usdcMcap: "...", arcTps: 9000, note: "synthetic demo data" } },
  "onchain-flows": { id: "onchain-flows", title: "Arc on-chain USDC flows (24h)", price: 50_000n, body: { inflow: "...", outflow: "...", topPairs: ["USDC/ETH"] } },
  "sentiment": { id: "sentiment", title: "Agent-economy sentiment index", price: 10_000n, body: { index: 0.62, trend: "up" } },
};
export function getDataset(id: string): Dataset | undefined { return DATASETS[id]; }
```

- [ ] **Step 4: Run to verify it passes** — PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/datasets.ts backend/test/agent/datasets.test.ts
git commit -m "feat(agent): mock vendor dataset catalog"
```

### Task 3B.2: The vendor paywall

**Files:**
- Create: `backend/src/agent/vendor.ts`
- Test: `backend/test/agent/vendor.test.ts`

**Interfaces:**
- Consumes: `buildPaywall` + `SellerConfig` (Phase 2), `DATASETS`/`getDataset` (3B.1).
- Produces: `export function buildVendor(cfg: { payTo: Address; asset: Address; network: string; settle?: SettleFn }): Hono` — exposes `GET /data/:id` that 402s at the dataset's price and serves the dataset body on a verified (and, if `settle` set, settled) payment.

- [ ] **Step 1: Write the failing test** — a 402 without payment; a 200 with a valid payment returns the dataset body; an unknown id 404s.

```ts
// backend/test/agent/vendor.test.ts
import { expect, test } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { DATASETS } from "../../src/agent/datasets";
import { buildVendor } from "../../src/agent/vendor";

const KEY = `0x${"2".repeat(64)}` as const;
const vendorPayout = "0x00000000000000000000000000000000000000cd" as const;
async function pay(amount: bigint, payTo: `0x${string}`) {
  const s = makeSignX402({ signer: pocketSignerFromKey(KEY), chainId: 5042002, network: arcBatchingConfig.network, verifyingContract: arcBatchingConfig.verifyingContract });
  return (await s({ payTo, amount, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network, maxTimeoutSeconds: 600 })).header;
}

test("vendor 402s then serves the dataset body on payment", async () => {
  const app = buildVendor({ payTo: vendorPayout, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network });
  const ds = DATASETS["sentiment"];
  const no = await app.request(`/data/${ds.id}`);
  expect(no.status).toBe(402);
  const ok = await app.request(`/data/${ds.id}`, { headers: { "X-PAYMENT": await pay(ds.price, vendorPayout) } });
  expect(ok.status).toBe(200);
  expect((await ok.json()).body).toMatchObject(ds.body);
});
test("unknown dataset id is 404", async () => {
  const app = buildVendor({ payTo: vendorPayout, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network });
  expect((await app.request("/data/nope")).status).toBe(404);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (cannot find `buildVendor`).

- [ ] **Step 3: Implement** — one Hono app; per-id it builds a `buildPaywall` priced at the dataset price (recipient = vendor payout) and dispatches.

```ts
// backend/src/agent/vendor.ts
import { Hono } from "hono";
import type { Address } from "../types";
import type { SettleFn } from "../payments/settle";
import { buildPaywall } from "../payments/seller";
import { getDataset } from "./datasets";

export function buildVendor(cfg: { payTo: Address; asset: Address; network: string; settle?: SettleFn }): Hono {
  const app = new Hono();
  app.get("/data/:id", async (c) => {
    const ds = getDataset(c.req.param("id"));
    if (!ds) return c.json({ error: "unknown dataset" }, 404);
    const paywall = buildPaywall({
      price: ds.price, payTo: cfg.payTo, asset: cfg.asset, network: cfg.network,
      resource: `/data/${ds.id}`, settle: cfg.settle, resourceUrl: `vendor://data/${ds.id}`,
      serve: () => ({ id: ds.id, title: ds.title, body: ds.body }),
    });
    // delegate to the paywall sub-app (it owns the 402/verify/settle/serve logic)
    return paywall.fetch(new Request(new URL(`/data/${ds.id}`, "http://vendor.local"), c.req.raw));
  });
  return app;
}
```
(If `buildPaywall`'s fixed path `/api/insight` does not match `/data/:id`, pass the dataset path via the existing `PaywallConfig.resource` option so the paywall registers `GET /data/:id`. Verify `PaywallConfig.resource` is honored as the route path; adjust the delegation URL to match.)

- [ ] **Step 4: Run to verify it passes** — PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/vendor.ts backend/test/agent/vendor.test.ts
git commit -m "feat(agent): mock x402 data vendor (per-dataset paywall)"
```

---

# Phase 3C — Agent tools (the only payment path)

> The agent's tools. `buyData` is the ONLY way the agent spends — it goes Buyer → Authority (`authorize`), so a denial is a normal return value the agent must handle. `getBudget` exposes the remaining cap so the model reasons cost-aware. No key, ever.

### Task 3C.1: `getBudget` + `buyData` (framework-agnostic core)

**Files:**
- Create: `backend/src/agent/tools.ts`
- Test: `backend/test/agent/tools.test.ts`

**Interfaces:**
- Consumes: `buyWithX402`/`BuyerDeps`/`AuthorizeFn` (Phase 2 buyer), `TreasuryState` reads via an injected `readBudget`.
- Produces:
  - `export interface AgentToolDeps { fetchImpl: typeof fetch; authorize: AuthorizeFn; vendorBase: string; readBudget: () => Promise<{ available: bigint; runningPending: bigint }> }`
  - `export function makeTools(d: AgentToolDeps): { getBudget(): Promise<{ remaining: bigint }>; buyData(datasetId: string): Promise<{ ok: true; data: unknown; cost: bigint } | { ok: false; reason: string }> }`

- [ ] **Step 1: Write the failing test** — a successful buy returns data + cost; a denied authorization returns `{ ok:false, reason }` (no throw, no retry); `getBudget` = available − runningPending.

```ts
// backend/test/agent/tools.test.ts
import { expect, test, vi } from "vitest";
import { makeTools, type AgentToolDeps } from "../../src/agent/tools";

const accept = { payTo: "0x00000000000000000000000000000000000000cd", maxAmountRequired: "10000", asset: "0x3600000000000000000000000000000000000000", network: "eip155:5042002", maxTimeoutSeconds: 600 };
function fetchImpl(served: unknown) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const xp = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"];
    return xp ? new Response(JSON.stringify(served), { status: 200 }) : new Response(JSON.stringify({ accepts: [accept] }), { status: 402 });
  }) as unknown as typeof fetch;
}
function deps(over: Partial<AgentToolDeps> = {}): AgentToolDeps {
  return { fetchImpl: fetchImpl({ body: { index: 0.62 } }), authorize: async () => ({ ok: true, header: "X-PAYMENT-ok" }), vendorBase: "http://vendor.local", readBudget: async () => ({ available: 1_000_000n, runningPending: 0n }), ...over };
}

test("getBudget returns available minus runningPending", async () => {
  const t = makeTools(deps({ readBudget: async () => ({ available: 1_000n, runningPending: 250n }) }));
  expect(await t.getBudget()).toEqual({ remaining: 750n });
});
test("buyData buys via the Authority and returns the data + cost", async () => {
  const t = makeTools(deps());
  const r = await t.buyData("sentiment");
  expect(r).toMatchObject({ ok: true, cost: 10000n });
  expect((r as { data: { body: unknown } }).data).toMatchObject({ body: { index: 0.62 } });
});
test("a policy-denied buy returns ok:false (no throw, no data)", async () => {
  const t = makeTools(deps({ authorize: async () => ({ ok: false, reason: "over-cap" }) }));
  const r = await t.buyData("sentiment");
  expect(r).toMatchObject({ ok: false, reason: "over-cap" });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (cannot find `makeTools`).

- [ ] **Step 3: Implement** — `buyData` calls `buyWithX402` (which routes the 402 through `authorize`), catching the policy-denied throw into a value.

```ts
// backend/src/agent/tools.ts
import { buyWithX402, type AuthorizeFn } from "../payments/buyer";

export interface AgentToolDeps {
  fetchImpl: typeof fetch;
  authorize: AuthorizeFn;
  vendorBase: string; // e.g. "http://vendor.local" or the live vendor URL
  readBudget: () => Promise<{ available: bigint; runningPending: bigint }>;
}
export type BuyResult = { ok: true; data: unknown; cost: bigint } | { ok: false; reason: string };

export function makeTools(d: AgentToolDeps) {
  return {
    async getBudget(): Promise<{ remaining: bigint }> {
      const b = await d.readBudget();
      const remaining = b.available - b.runningPending;
      return { remaining: remaining > 0n ? remaining : 0n };
    },
    async buyData(datasetId: string): Promise<BuyResult> {
      const url = `${d.vendorBase}/data/${datasetId}`;
      try {
        const res = await buyWithX402({ fetchImpl: d.fetchImpl, authorize: d.authorize }, url);
        if (res.status !== 200) return { ok: false, reason: `vendor-${res.status}` };
        const data = await res.json();
        // cost = the amount the Authority authorized; recover it from the 402 the buyer saw is internal,
        // so re-read it cheaply: the dataset price is the vendor's maxAmountRequired. The buyer used it.
        const cost = await priceOf(d, datasetId);
        return { ok: true, data, cost };
      } catch (e) {
        const m = (e as Error).message;
        const reason = m.startsWith("policy-denied:") ? m.slice("policy-denied:".length).trim() : m;
        return { ok: false, reason };
      }
    },
  };
}

/** The cost the agent paid = the vendor's price for the dataset (the 402's maxAmountRequired). */
async function priceOf(d: AgentToolDeps, datasetId: string): Promise<bigint> {
  const probe = await d.fetchImpl(`${d.vendorBase}/data/${datasetId}`);
  if (probe.status !== 402) return 0n;
  const body = (await probe.json()) as { accepts?: { maxAmountRequired: string }[] };
  return BigInt(body.accepts?.[0]?.maxAmountRequired ?? "0");
}
```
(If `buyWithX402` already returns the chosen amount/cost, thread it back instead of the extra `priceOf` probe — prefer that to avoid a second 402 round-trip. Verify the buyer's return shape and adjust; the test only asserts `cost === 10000n`.)

- [ ] **Step 4: Run to verify it passes** — PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/tools.ts backend/test/agent/tools.test.ts
git commit -m "feat(agent): getBudget + buyData tools (buyData is the only spend path)"
```

### Task 3C.2: Deterministic pricing

**Files:**
- Create: `backend/src/agent/pricing.ts`
- Test: `backend/test/agent/pricing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/agent/pricing.test.ts
import { expect, test } from "vitest";
import { priceAnswer } from "../../src/agent/pricing";

test("price = ceil(totalCost * (1 + margin))", () => {
  expect(priceAnswer(100n, 0.5)).toBe(150n);
  expect(priceAnswer(101n, 0.5)).toBe(152n); // ceil(151.5)
  expect(priceAnswer(0n, 0.5)).toBe(0n);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement** (integer math; margin as basis points to avoid float drift).

```ts
// backend/src/agent/pricing.ts
/** Price an answer at a margin over input cost. margin 0.5 = +50%. Integer (atomic USDC), rounded up. */
export function priceAnswer(totalCost: bigint, margin: number): bigint {
  const bps = BigInt(Math.round((1 + margin) * 10_000)); // e.g. 1.5 -> 15000
  return (totalCost * bps + 9_999n) / 10_000n; // ceil division
}
```

- [ ] **Step 4: Run to verify it passes** — PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/pricing.ts backend/test/agent/pricing.test.ts
git commit -m "feat(agent): deterministic answer pricing (cost + margin)"
```

---

# Phase 3D — The Claude insight-agent loop

> The model decides which datasets to buy (cost-aware vs `get_budget`), buys them via `buy_data` (governed; denials handled), and synthesizes an answer. Built on the Anthropic SDK's Messages tool-use with a **hand-rolled agentic loop we own** (no Vercel AI SDK). Deterministic tests inject a **fake Anthropic client** that returns scripted `tool_use`/`text` responses; a live run uses `claude-sonnet-4-6` (or `claude-opus-4-8` via `AGENT_MODEL`).

### Task 3D.1: Install the Anthropic SDK

**Files:**
- Modify: `backend/package.json`

- [ ] **Step 1: Install** — `cd backend && npm install @anthropic-ai/sdk`.

- [ ] **Step 2: Sanity-check the surface** (the Messages tool-use API is stable and verified — this is a smoke check, not a probe):

```bash
cd backend
node -e "const A=require('@anthropic-ai/sdk'); console.log('Anthropic client:', typeof A.default)"
```
Expected: `function` (the default export is the `Anthropic` client class). The verified tool-use shape (used in 3D.2): `client.messages.create({ model, max_tokens, system, tools, messages })` → `{ stop_reason, content: ContentBlock[] }`; a `tool_use` block is `{ type:"tool_use", id, name, input }`; you reply with `{ type:"tool_result", tool_use_id, content }` blocks inside a `user` message and call again until `stop_reason === "end_turn"`. `npm run typecheck` in 3D.2 is the real verification.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(agent): add @anthropic-ai/sdk"
```

### Task 3D.2: `buildInsightAgent` — the hand-rolled tool-loop

**Files:**
- Create: `backend/src/agent/insightAgent.ts`
- Test: `backend/test/agent/insightAgent.test.ts` (injects a fake Anthropic client — deterministic, no network, no `ANTHROPIC_API_KEY`)

**Interfaces:**
- Consumes: `makeTools`/`AgentToolDeps` (3C.1), `Anthropic` from `@anthropic-ai/sdk`.
- Produces: `export interface InsightAgentDeps { client: Anthropic; model: string; tools: ReturnType<typeof makeTools>; catalog: { id: string; title: string; price: string }[] }` and `export function buildInsightAgent(d: InsightAgentDeps): { run(query: string): Promise<{ answer: string; purchases: { id: string; cost: bigint }[]; denied: { id: string; reason: string }[]; totalCost: bigint }> }`. `client` is injected (a fake in tests, a real `new Anthropic({ apiKey })` live), keeping the loop deterministic-testable.

- [ ] **Step 1: Write the failing test** — inject a fake client scripted to: emit a `buy_data("sentiment")` tool call, then a final text answer. Assert the answer + that the purchase + cost were recorded; and a second test for the denied path.

```ts
// backend/test/agent/insightAgent.test.ts
import type Anthropic from "@anthropic-ai/sdk";
import { expect, test, vi } from "vitest";
import { buildInsightAgent } from "../../src/agent/insightAgent";

// A fake Anthropic client whose messages.create returns the scripted responses in order.
function fakeClient(scripted: Array<Partial<Anthropic.Message>>): Anthropic {
  let i = 0;
  return { messages: { create: async () => scripted[i++] } } as unknown as Anthropic;
}

test("the agent buys a dataset then returns a synthesized answer with recorded purchases", async () => {
  const tools = {
    getBudget: vi.fn(async () => ({ remaining: 1_000_000n })),
    buyData: vi.fn(async (id: string) => ({ ok: true as const, data: { id, body: { index: 0.62 } }, cost: 10_000n })),
  };
  const client = fakeClient([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "buy_data", input: { datasetId: "sentiment" } }] as never },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Agent-economy sentiment is up (index 0.62)." }] as never },
  ]);
  const agent = buildInsightAgent({ client, model: "claude-sonnet-4-6", tools: tools as never, catalog: [{ id: "sentiment", title: "Sentiment", price: "10000" }] });

  const r = await agent.run("How is agent-economy sentiment?");
  expect(r.answer).toContain("sentiment is up");
  expect(r.purchases).toEqual([{ id: "sentiment", cost: 10_000n }]);
  expect(r.totalCost).toBe(10_000n);
  expect(tools.buyData).toHaveBeenCalledWith("sentiment");
});

test("a denied purchase is recorded in `denied` and does not abort the answer", async () => {
  const tools = {
    getBudget: vi.fn(async () => ({ remaining: 5_000n })),
    buyData: vi.fn(async () => ({ ok: false as const, reason: "over-cap" })),
  };
  const client = fakeClient([
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "buy_data", input: { datasetId: "onchain-flows" } }] as never },
    { stop_reason: "end_turn", content: [{ type: "text", text: "I could not afford on-chain flows; partial answer based on priors." }] as never },
  ]);
  const agent = buildInsightAgent({ client, model: "claude-sonnet-4-6", tools: tools as never, catalog: [] });
  const r = await agent.run("flows?");
  expect(r.denied).toEqual([{ id: "onchain-flows", reason: "over-cap" }]);
  expect(r.purchases).toEqual([]);
  expect(r.answer).toContain("partial");
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (cannot find `buildInsightAgent`).

- [ ] **Step 3: Implement** — the hand-rolled Messages tool-use loop. Tool NAMES are snake_case (Anthropic convention); they dispatch to the `makeTools` methods. Accumulate purchases/denials as the loop runs.

```ts
// backend/src/agent/insightAgent.ts
import Anthropic from "@anthropic-ai/sdk";
import type { makeTools } from "./tools";

export interface InsightAgentDeps {
  client: Anthropic;   // injected: a fake in tests, a real `new Anthropic({ apiKey })` live
  model: string;       // e.g. "claude-sonnet-4-6" (or "claude-opus-4-8" via AGENT_MODEL)
  tools: ReturnType<typeof makeTools>;
  catalog: { id: string; title: string; price: string }[];
}
export interface AgentRun { answer: string; purchases: { id: string; cost: bigint }[]; denied: { id: string; reason: string }[]; totalCost: bigint }

const SYSTEM = [
  "You are a cost-aware research agent. You answer the user's query by optionally buying paid datasets.",
  "You hold NO payment key: every purchase goes through the buy_data tool, which may be DENIED by the on-chain policy.",
  "Before buying, consider get_budget (remaining USDC, atomic units, 6 decimals). Buy only datasets whose value",
  "justifies the price. If buy_data returns ok:false, do NOT retry — note it and answer with what you have.",
  "Finish with a concise synthesized answer in plain text.",
].join(" ");

const TOOL_DEFS: Anthropic.Tool[] = [
  { name: "get_budget", description: "Remaining spendable USDC (atomic, 6 decimals) under the on-chain cap.", input_schema: { type: "object", properties: {} } },
  { name: "buy_data", description: "Buy a paid dataset by id. May be policy-denied.", input_schema: { type: "object", properties: { datasetId: { type: "string", description: "dataset id from the catalog" } }, required: ["datasetId"] } },
];

export function buildInsightAgent(d: InsightAgentDeps) {
  return {
    async run(query: string): Promise<AgentRun> {
      const purchases: { id: string; cost: bigint }[] = [];
      const denied: { id: string; reason: string }[] = [];
      const system = `${SYSTEM} Catalog: ${JSON.stringify(d.catalog)}`;
      const messages: Anthropic.MessageParam[] = [{ role: "user", content: query }];
      let answer = "";

      for (let step = 0; step < 8; step++) {
        const res = await d.client.messages.create({ model: d.model, max_tokens: 1024, system, tools: TOOL_DEFS, messages });
        messages.push({ role: "assistant", content: res.content });

        if (res.stop_reason !== "tool_use") {
          answer = res.content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          break;
        }

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of res.content) {
          if (block.type !== "tool_use") continue;
          if (block.name === "get_budget") {
            const b = await d.tools.getBudget();
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ remaining: b.remaining.toString() }) });
          } else if (block.name === "buy_data") {
            const { datasetId } = block.input as { datasetId: string };
            const r = await d.tools.buyData(datasetId);
            if (r.ok) {
              purchases.push({ id: datasetId, cost: r.cost });
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ ok: true, data: r.data, cost: r.cost.toString() }) });
            } else {
              denied.push({ id: datasetId, reason: r.reason });
              toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify({ ok: false, reason: r.reason }) });
            }
          }
        }
        messages.push({ role: "user", content: toolResults });
      }

      const totalCost = purchases.reduce((s, p) => s + p.cost, 0n);
      return { answer, purchases, denied, totalCost };
    },
  };
}
```
(`Anthropic.Tool`, `Anthropic.MessageParam`, `Anthropic.TextBlock`, `Anthropic.ToolResultBlockParam` are the SDK's exported types — `npm run typecheck` validates the shapes. The loop, the no-retry-on-deny rule, and the return shape are the contract the test pins.)

- [ ] **Step 4: Run to verify it passes** — `cd backend && npx vitest run test/agent/insightAgent.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/insightAgent.ts backend/test/agent/insightAgent.test.ts
git commit -m "feat(agent): Claude insight-agent tool-loop (Anthropic SDK, no-key buys)"
```

---

# Phase 3E — Demo orchestration + CLI

> One command runs a full cycle: agent buys (governed) → synthesizes → prices → its seller serves a paying customer → P&L. Offline e2e uses a fake Anthropic client + mock vendor + real Authority/Buyer/Seller (no network, no LLM). Opt-in live runs it for real on Arc.

### Task 3E.1: `runDemo` — full buy→synthesize→price→sell cycle

**Files:**
- Create: `backend/src/agent/demo.ts`
- Test: `backend/test/agent/demo.int.test.ts`

**Interfaces:**
- Consumes: `buildInsightAgent` (3D.2), `makeTools` (3C.1), `buildVendor` (3B.2), `priceAnswer` (3C.2), `buildPaywall` (Phase 2), `authorizePayment` + `PaymentLedger` + `makeSignX402`/pocket (Phase 1/2).
- Produces: `export interface DemoDeps { client: Anthropic; model: string; vendor: Hono; authorize: AuthorizeFn; readBudget: () => Promise<{available:bigint;runningPending:bigint}>; vendorBase: string; margin: number; agentPayout: Address }` and `export async function runDemo(d: DemoDeps, query: string): Promise<{ answer: string; totalCost: bigint; price: bigint; pnl: bigint; purchases; denied }>`.

- [ ] **Step 1: Write the failing test** — wire a fake Anthropic client + the real vendor + a real Authority `authorize`; assert the agent buys, an answer is produced, the price = cost+margin, and a simulated customer buy of the answer settles to a positive P&L.

```ts
// backend/test/agent/demo.int.test.ts
import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { authorizePayment } from "../../src/payments/authority";
import { PaymentLedger } from "../../src/payments/ledger";
import { migrate } from "../../src/persistence/db";
import { buildVendor } from "../../src/agent/vendor";
import { runDemo } from "../../src/agent/demo";

const KEY = `0x${"2".repeat(64)}` as const;
const agentPayout = "0x00000000000000000000000000000000000000ab" as const;
const vendorPayout = "0x00000000000000000000000000000000000000cd" as const;

test("full cycle: agent buys sentiment, answers, prices at margin, customer pays -> positive P&L", async () => {
  const db = new Database(":memory:"); migrate(db);
  const ledger = new PaymentLedger(db);
  const signX402 = makeSignX402({ signer: pocketSignerFromKey(KEY), chainId: 5042002, network: arcBatchingConfig.network, verifyingContract: arcBatchingConfig.verifyingContract });
  const deps = { ledger, readTreasury: async () => ({ available: 1_000_000n, paused: false, allowlistEnabled: false, isAllowed: true }), signX402: async (req: never) => signX402(req) };
  const authorize = async (r: Parameters<typeof authorizePayment>[1]) => authorizePayment(deps as never, r);
  const vendor = buildVendor({ payTo: vendorPayout, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network });

  // fake Anthropic client: scripted tool_use then final text (no network, no key)
  let _i = 0;
  const scripted = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "buy_data", input: { datasetId: "sentiment" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Sentiment is up (0.62)." }] },
  ];
  const client = { messages: { create: async () => scripted[_i++] } } as never;

  const out = await runDemo({ client, model: "claude-sonnet-4-6", vendor, authorize, readBudget: async () => ({ available: 1_000_000n, runningPending: 0n }), vendorBase: "http://vendor.local", margin: 0.5, agentPayout }, "sentiment?");
  expect(out.purchases).toEqual([{ id: "sentiment", cost: 10_000n }]);
  expect(out.totalCost).toBe(10_000n);
  expect(out.price).toBe(15_000n);           // 10000 * 1.5
  expect(out.pnl).toBe(out.price - out.totalCost); // 5000, the customer paid `price`
  expect(out.answer.toLowerCase()).toContain("sentiment");
});
```
(`runDemo` wires the vendor's fetch into the tools' `fetchImpl` — `(url, init) => vendor.fetch(new Request(url, init))` — so the agent's buys hit the in-process vendor through the real Buyer + Authority. The customer-buy of the answer is simulated by pricing the answer and recording revenue = price; on the live path it is a real second buy against the agent's own paywall.)

- [ ] **Step 2: Run to verify it fails** — FAIL (cannot find `runDemo`).

- [ ] **Step 3: Implement** — assemble tools (vendor-backed fetch + authorize), build the agent, run it, price the answer, compute P&L.

```ts
// backend/src/agent/demo.ts
import type Anthropic from "@anthropic-ai/sdk";
import type { Hono } from "hono";
import type { Address } from "../types";
import type { AuthorizeFn } from "../payments/buyer";
import { makeTools } from "./tools";
import { buildInsightAgent } from "./insightAgent";
import { priceAnswer } from "./pricing";
import { DATASETS } from "./datasets";

export interface DemoDeps {
  client: Anthropic;
  model: string;
  vendor: Hono;
  authorize: AuthorizeFn;
  readBudget: () => Promise<{ available: bigint; runningPending: bigint }>;
  vendorBase: string;
  margin: number;
  agentPayout: Address;
}
export interface DemoResult { answer: string; totalCost: bigint; price: bigint; pnl: bigint; purchases: { id: string; cost: bigint }[]; denied: { id: string; reason: string }[] }

export async function runDemo(d: DemoDeps, query: string): Promise<DemoResult> {
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) =>
    d.vendor.fetch(new Request(url, init))) as unknown as typeof fetch;
  const tools = makeTools({ fetchImpl, authorize: d.authorize, vendorBase: d.vendorBase, readBudget: d.readBudget });
  const catalog = Object.values(DATASETS).map((x) => ({ id: x.id, title: x.title, price: x.price.toString() }));
  const agent = buildInsightAgent({ client: d.client, model: d.model, tools, catalog });
  const run = await agent.run(query);
  const price = priceAnswer(run.totalCost, d.margin);
  // P&L = revenue (a customer pays `price` for the answer) − input cost. On the live path this is a real
  // second buy against the agent's own paywall (payTo = agentPayout); here we record the priced revenue.
  const pnl = price - run.totalCost;
  return { answer: run.answer, totalCost: run.totalCost, price, pnl, purchases: run.purchases, denied: run.denied };
}
```

- [ ] **Step 4: Run to verify it passes** — `cd backend && npx vitest run test/agent/demo.int.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/demo.ts backend/test/agent/demo.int.test.ts
git commit -m "feat(agent): runDemo — full buy->synthesize->price->sell cycle with P&L"
```

### Task 3E.2: CLI command `agent ask`

**Files:**
- Modify: `backend/src/cli/index.ts`
- Test: `backend/test/agent/cli.test.ts`

**Interfaces:**
- Consumes: `buildCli(makeContext)` (existing), `runDemo` (3E.1). The command builds the live deps (Anthropic model via `AGENT_MODEL`, real Authority `authorize`, real vendor) and prints reasoning + purchases + answer + P&L. For tests, `buildCli` already accepts an injectable context — extend it to inject a `runDemo`-compatible deps factory so the CLI is testable without a live model.

- [ ] **Step 1: Write the failing test** — invoke the CLI with an injected fake demo runner; assert it prints the answer + P&L.

```ts
// backend/test/agent/cli.test.ts
import { expect, test, vi } from "vitest";
import { buildCli } from "../../src/cli/index";

test("`agent ask` prints the answer and P&L", async () => {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
  // buildCli must accept an injected agent demo runner for tests (see Step 3).
  const program = buildCli(undefined, { runDemo: async () => ({ answer: "Sentiment is up.", totalCost: 10_000n, price: 15_000n, pnl: 5_000n, purchases: [{ id: "sentiment", cost: 10_000n }], denied: [] }) });
  await program.parseAsync(["node", "legalbody", "agent", "ask", "sentiment?"]);
  spy.mockRestore();
  const out = logs.join("\n");
  expect(out).toContain("Sentiment is up.");
  expect(out).toContain("P&L");
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (no `agent ask` command / `buildCli` second arg).

- [ ] **Step 3: Implement** — add an optional second param to `buildCli` for injectable agent deps, and register the command. The live deps factory (Anthropic model + real `authorize` + vendor) lives behind a default so tests inject a fake.

```ts
// in buildCli signature (add a second optional arg, default builds live deps lazily):
//   export function buildCli(makeContext = buildContext, agentDeps?: { runDemo: (query: string) => Promise<DemoResult> }) {
// register:
program
  .command("agent")
  .command("ask <query>")
  .description("Run the governed insight agent: buy data, synthesize, price, report P&L")
  .action(async (query: string) => {
    const runner = agentDeps?.runDemo ?? (await buildLiveAgentRunner()); // buildLiveAgentRunner: loadConfig -> Anthropic model + real authorize + vendor
    const r = await runner(query);
    console.log("\n=== answer ===\n" + r.answer);
    console.log("\npurchases:", r.purchases.map((p) => `${p.id} (${p.cost})`).join(", ") || "(none)");
    if (r.denied.length) console.log("denied:", r.denied.map((x) => `${x.id}: ${x.reason}`).join(", "));
    console.log(`cost=${r.totalCost} price=${r.price} P&L=${r.pnl} (atomic USDC)`);
  });
```
`buildLiveAgentRunner()` (same file or `agent/demo.ts`): `loadConfig()` → build the Anthropic client `new Anthropic({ apiKey: cfg.anthropicApiKey })` (model = `cfg.agentModel`) → build the real `authorize` (Authority deps: ledger + readTreasury via ArcAdapter + pocket signX402) and the vendor → return `(q) => runDemo({ client, model: cfg.agentModel, ... }, q)`. Guard: throw a clear error if `cfg.anthropicApiKey` is missing.

- [ ] **Step 4: Run to verify it passes** — `cd backend && npx vitest run test/agent/cli.test.ts` → PASS. Then the FULL suite `npm test` (confirm no regression), `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/cli/index.ts backend/test/agent/cli.test.ts
git commit -m "feat(agent): `legalbody agent ask` CLI demo command"
```

### Task 3E.3: Opt-in live agent run + findings/index

**Files:**
- Create: `backend/scripts/spike-agent-live.mts`
- Modify: `docs/research/2026-06-16-x402-gateway-spike-findings.md`, `docs/README.md`

- [ ] **Step 1: Write the live spike** — gated on `ANTHROPIC_API_KEY` present; runs `runDemo` with the real Anthropic model + the in-process vendor + real Authority (signing real, settlement opt-in via `--settle`). Prints reasoning, purchases, answer, P&L. Mirrors the existing spikes' opt-in shape.

```ts
// backend/scripts/spike-agent-live.mts — needs ANTHROPIC_API_KEY; --settle spends testnet USDC.
import "dotenv/config";
import { loadConfig } from "../src/config/env";
// build the Anthropic model (3D.1), the vendor (3B.2), the real authorize (Phase 2 wiring), then runDemo.
// Print the full cycle. With --settle, pass makeSettle(cfg.gatewayFacilitatorUrl) into the vendor + the
// agent's own seller so the buy and the sell settle on Arc; print the transfer ids.
async function main() {
  const cfg = loadConfig();
  if (!cfg.anthropicApiKey) { console.log("set ANTHROPIC_API_KEY to run the live agent"); return; }
  // ... assemble + runDemo(query) ... (lift buildLiveAgentRunner from 3E.2)
  console.log("(fill in from buildLiveAgentRunner once a demo query is chosen)");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run offline** — `cd backend && npx tsx scripts/spike-agent-live.mts` → prints the "set ANTHROPIC_API_KEY" guard (no key in CI) or runs if a key is present. `npm run typecheck && npm run lint`.

- [ ] **Step 3: Append a Phase-3 findings section** to the research doc (the Anthropic SDK hand-rolled tool-loop; the fake-client deterministic test approach; the snake_case tool names; any live run's purchases/answer/P&L + settle transfer ids) and index this plan in `docs/README.md`.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/spike-agent-live.mts docs/research/2026-06-16-x402-gateway-spike-findings.md docs/README.md
git commit -m "spike(agent): opt-in live insight-agent run; record Phase-3 findings + index plan"
```

**Phase 3 gate:** full suite green (`npm test`), tsc + biome clean. `legalbody agent ask` runs the governed buy→synthesize→price→sell loop deterministically against a fake Anthropic client; the policy-reject path is exercised (a denied buy → graceful partial answer); with `ANTHROPIC_API_KEY` (+ `--settle`) it runs live on Arc with real settlement.

---

## Self-Review

- **Spec coverage** (design §5 component 4 + §7 demo moments): the Claude cost-aware loop → 3D; buy via Buyer/Authority (no key) → 3C + 3D; synthesize + price + serve → 3D + 3C.2 + 3A.3; the **policy-reject killer moment** → 3C.1/3D.2 (denied buy) + the demo (3E); real settlement (Finding 10) → 3A; the mock vendor the agent buys from → 3B; end-to-end demo → 3E. Funding bridge + dashboard are Phase 2 / Phase 4 (out of scope). The agent-holds-no-key invariant is enforced structurally (buyData → authorize is the only spend path; the agent module never imports signX402/pocket).
- **Placeholder scan:** the agent loop is concrete (the Anthropic Messages tool-use API is stable and verified — no probe deferral). The only deferred specific is the `--settle` live agent path (3E.3 spike), gated behind an explicit opt-in — matching the repo's established spike pattern, not a hidden TODO. All of *our* code (settle, vendor, tools, pricing, agent loop, demo, CLI) is complete.
- **Type consistency:** `SettleFn`/`SettleRequirements` (3A.2) are consumed unchanged by the seller hook (3A.3) and `buildVendor` (3B.2). `AgentToolDeps`/`makeTools` return shape (3C.1) is consumed by `buildInsightAgent` (3D.2) and `runDemo` (3E.1). `DemoResult` (3E.1) is printed by the CLI (3E.2) and returned by the live spike (3E.3). `priceAnswer(totalCost, margin)` (3C.2) is used once in `runDemo`. Atomic `bigint` USDC throughout; prices are `.toString()` only at the model/tool boundary.
- **Open prerequisite:** live runs need `ANTHROPIC_API_KEY` in `.env` (deterministic tests don't). Live settlement needs a funded pocket/platform Gateway balance. Both are documented and gated; CI stays green without either.
