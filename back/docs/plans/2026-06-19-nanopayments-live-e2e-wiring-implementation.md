# Live End-to-End Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose the proven Phase-0–3 pieces into one runnable autonomous cycle — governed Turnkey-driven funding → agent buys data (settles out to a vendor) → simulated customer buys the answer (settles into the treasury) → real P&L — runnable live on Arc with one command, plus a runbook. This session delivers the wiring; the live run is operator-triggered.

**Architecture:** A thin orchestration module `backend/src/agent/liveRunner.ts` owns the three-leg flow via a pure `runLive(deps, query)` core (injectable seams, deterministically testable) and a live composition root `buildLiveAgentRunner(cfg)`. `runDemo` is unchanged — it just receives a settle-enabled vendor whose payout is a *distinct* vendor address. Two leg helpers: `fundPocket` (leg 0, Turnkey enclave) and `sellAnswer` (leg 2, simulated customer).

**Tech Stack:** TypeScript (ESM, Node ≥20.18), viem, better-sqlite3, vitest, biome, Hono, Turnkey (`@turnkey/*`), `@circle-fin/x402-batching`, `@anthropic-ai/sdk`.

## Global Constraints

Every task's requirements implicitly include these (verbatim from the design):

- **Additive only.** New source lives ONLY in `backend/src/agent/liveRunner.ts` (+ its test) and the three config fields. Do not modify Solidity, onboarding, `signX402`/codec, the Authority, the Buyer, the Seller's logic, the agent loop, or `runDemo` (`backend/src/agent/demo.ts` stays byte-unchanged). Permitted edits to existing files: `config/env.ts` (3 additions), `cli/index.ts` (import the runner + print extra fields), `scripts/spike-agent-live.mts` (real `--settle`), `docs/README.md` (index the runbook).
- **The agent holds NO key (unchanged).** The agent module's only spend path is still Buyer → Authority. `liveRunner.ts` may import `signX402`/pocket/Turnkey — it is the *operator/composition* layer, NOT the agent. `runDemo`/`insightAgent`/`tools` must remain free of those imports.
- **Funding bridge = the Turnkey enclave operator.** `fundPocket` uses `buildOperatorWalletClient(cfg)` (the `cfg.turnkey` path) and throws clearly if `cfg.turnkey` is absent. ~2 enclave sigs per top-up (O(top-ups)). The live funding/settlement path is opt-in (`--settle`), never in CI.
- **Settlement recipe (Finding 10):** `makeSettle({ facilitatorUrl: cfg.gatewayFacilitatorUrl })` (testnet base, no `/v1`); the live runner wraps it in a recording `SettleFn` shared by BOTH legs. Batching domain values come from `arcBatchingConfig` (GatewayWallet, not USDC).
- **Simulated customer = the platform key by default** (`cfg.customerPrivateKey` defaults to `platformPrivateKey`). No new secret required.
- **`VENDOR_PAYOUT_ADDRESS` must differ from the treasury** (cost must actually leave). The live runner throws if it's unset or equals the treasury.
- **Arc constants:** chainId `5042002`, network `"eip155:5042002"`, USDC `0x3600…0000` (6 decimals, atomic `bigint`). Model IDs unchanged: `claude-sonnet-4-6` default, `claude-opus-4-8` toggle.
- **Deterministic tests inject fakes** — no network, no `ANTHROPIC_API_KEY`, no Turnkey, no real settlement. Atomic `bigint` USDC throughout; `.toString()` only at the model/tool/print boundary.
- **Quality gate per task:** `npm run typecheck` (tsc) + `npm run lint` (biome) clean; the non-live suite `npx vitest run --exclude '**/*.live.test.ts'` green. Do NOT run the full `npm test` (it contains a metered live Turnkey signature). Commit at the end of each task.

## File structure

| File | Responsibility |
|---|---|
| `backend/src/config/env.ts` (modify) | Add `fundingFloatUsdc` (default `"0.50"`), `customerPrivateKey` (default `platformPrivateKey`, redacted) to `Config` |
| `backend/src/agent/liveRunner.ts` (create) | `sellAnswer` (leg 2), `runLive` core + `LiveRunResult`, `resolveLiveAddresses`, `fundPocket` (leg 0), `buildLiveAgentRunner` (live root) |
| `backend/test/agent/liveRunner.test.ts` (create) | Deterministic tests: `sellAnswer`, `runLive` orchestration, `resolveLiveAddresses` |
| `backend/src/cli/index.ts` (modify) | Import `buildLiveAgentRunner` from `../agent/liveRunner` (drop the local copy); print funding txs + transfer ids |
| `backend/scripts/spike-agent-live.mts` (modify) | `--settle` runs the real live runner (stub removed); opt-in spend gating |
| `docs/runbooks/2026-06-19-live-agent-run.md` (create) | Operator runbook for the live run |
| `docs/README.md` (modify) | Index the runbook |

---

### Task 1: Config — funding float + customer key

**Files:**
- Modify: `backend/src/config/env.ts`
- Test: `backend/test/config/liveEnv.test.ts`

**Interfaces:**
- Produces: `cfg.fundingFloatUsdc: string` (default `"0.50"`), `cfg.customerPrivateKey: Hex` (default = `cfg.platformPrivateKey`), redacted in `redact()`.

- [ ] **Step 1: Write the failing test**

```ts
// backend/test/config/liveEnv.test.ts
import { expect, test } from "vitest";
import { loadConfig, redact } from "../../src/config/env";

const base = { ARC_TESTNET_RPC_URL: "https://rpc.example/v1", PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}` };

test("fundingFloatUsdc defaults to 0.50 and is overridable", () => {
  expect(loadConfig(base).fundingFloatUsdc).toBe("0.50");
  expect(loadConfig({ ...base, FUNDING_FLOAT_USDC: "1.25" }).fundingFloatUsdc).toBe("1.25");
});

test("customerPrivateKey defaults to the platform key and is overridable + redacted", () => {
  const cfg = loadConfig(base);
  expect(cfg.customerPrivateKey).toBe(base.PLATFORM_PRIVATE_KEY);
  const over = loadConfig({ ...base, CUSTOMER_PRIVATE_KEY: `0x${"2".repeat(64)}` });
  expect(over.customerPrivateKey).toBe(`0x${"2".repeat(64)}`);
  expect(redact(over).customerPrivateKey).toBe("REDACTED");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/config/liveEnv.test.ts`
Expected: FAIL — `cfg.fundingFloatUsdc` is `undefined`.

- [ ] **Step 3: Implement** — in `backend/src/config/env.ts`:
  - In `EnvSchema` add: `FUNDING_FLOAT_USDC: z.string().default("0.50"),` and `CUSTOMER_PRIVATE_KEY: privKeySchema.optional(),` (reuse the same private-key schema the other key fields use — match `PLATFORM_PRIVATE_KEY`/`POCKET_PRIVATE_KEY`).
  - In the `Config` interface add: `fundingFloatUsdc: string;` and `customerPrivateKey: Hex;`.
  - In `loadConfig`'s return object add: `fundingFloatUsdc: e.FUNDING_FLOAT_USDC,` and `customerPrivateKey: e.CUSTOMER_PRIVATE_KEY ?? e.PLATFORM_PRIVATE_KEY,`.
  - In `redact()` add: `customerPrivateKey: "REDACTED",` (it is always set, so unconditional, mirroring `platformPrivateKey`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/config/liveEnv.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/config/env.ts backend/test/config/liveEnv.test.ts
git commit -m "feat(agent): config for funding float + simulated-customer key"
```

---

### Task 2: `sellAnswer` — the settled sell leg

**Files:**
- Create: `backend/src/agent/liveRunner.ts`
- Test: `backend/test/agent/liveRunner.test.ts`

**Interfaces:**
- Consumes: `buildPaywall` (`../payments/seller`), `arcBatchingConfig`/`pocketSignerFromKey` (`../adapters/x402/pocket`), `makeSignX402` (`../adapters/x402/signX402`), `SettleFn` (`../payments/settle`), `Address`/`Hex` (`../types`).
- Produces: `export async function sellAnswer(p: SellParams): Promise<{ ok: boolean; status: number }>` where `SellParams = { chainId: number; answer: string; price: bigint; sellerPayTo: Address; customerPrivateKey: Hex; settle: SettleFn; resourceUrl?: string }`.

- [ ] **Step 1: Write the failing test** (real seller verify + fake settle; a local customer key signs in-process)

```ts
// backend/test/agent/liveRunner.test.ts
import { getAddress } from "viem";
import { expect, test, vi } from "vitest";
import { sellAnswer } from "../../src/agent/liveRunner";

const CUSTOMER = `0x${"2".repeat(64)}` as const;
const treasury = getAddress(`0x${"ab".repeat(20)}`);

test("sellAnswer: the customer pays the agent's paywall, it settles, and serves 200", async () => {
  const settle = vi.fn(async () => ({ ok: true as const, transferId: "sale-1" }));
  const r = await sellAnswer({
    chainId: 5042002,
    answer: "Sentiment is up (0.62).",
    price: 15_000n,
    sellerPayTo: treasury,
    customerPrivateKey: CUSTOMER,
    settle,
  });
  expect(r).toEqual({ ok: true, status: 200 });
  expect(settle).toHaveBeenCalledTimes(1);
  const reqs = (settle.mock.calls[0] as unknown[])[1] as { amount: string; payTo: string };
  expect(reqs.amount).toBe("15000");
  expect(reqs.payTo.toLowerCase()).toBe(treasury.toLowerCase());
});

test("sellAnswer: a settle failure surfaces as ok:false / 402", async () => {
  const settle = vi.fn(async () => ({ ok: false as const, reason: "insufficient_balance" }));
  const r = await sellAnswer({
    chainId: 5042002,
    answer: "x",
    price: 15_000n,
    sellerPayTo: treasury,
    customerPrivateKey: CUSTOMER,
    settle,
  });
  expect(r).toEqual({ ok: false, status: 402 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/agent/liveRunner.test.ts`
Expected: FAIL — cannot find module `../../src/agent/liveRunner`.

- [ ] **Step 3: Implement** — create `backend/src/agent/liveRunner.ts` with `sellAnswer`:

```ts
// backend/src/agent/liveRunner.ts
import { arcBatchingConfig, pocketSignerFromKey } from "../adapters/x402/pocket";
import { makeSignX402 } from "../adapters/x402/signX402";
import type { SettleFn } from "../payments/settle";
import { buildPaywall } from "../payments/seller";
import type { Address, Hex } from "../types";

export interface SellParams {
  chainId: number;
  answer: string;
  price: bigint;
  sellerPayTo: Address; // the treasury payout — revenue lands governed
  customerPrivateKey: Hex; // the simulated customer's signer (defaults to the platform key upstream)
  settle: SettleFn;
  resourceUrl?: string;
}

/** Leg 2: a simulated customer pays the agent's own paywall for the answer; the Seller verifies + settles. */
export async function sellAnswer(p: SellParams): Promise<{ ok: boolean; status: number }> {
  const paywall = buildPaywall({
    price: p.price,
    payTo: p.sellerPayTo,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
    serve: () => ({ answer: p.answer }),
    settle: p.settle,
    resourceUrl: p.resourceUrl ?? "agent://insight",
  });
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(p.customerPrivateKey),
    chainId: p.chainId,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });
  const { header } = await signX402({
    payTo: p.sellerPayTo,
    amount: p.price,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
    maxTimeoutSeconds: 600,
  });
  const res = await paywall.request("/api/insight", { headers: { "X-PAYMENT": header } });
  return { ok: res.status === 200, status: res.status };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/agent/liveRunner.test.ts` → PASS (both cases). Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/liveRunner.ts backend/test/agent/liveRunner.test.ts
git commit -m "feat(agent): sellAnswer — simulated customer buys+settles the answer into the treasury"
```

---

### Task 3: `runLive` core + `LiveRunResult` (the orchestration)

**Files:**
- Modify: `backend/src/agent/liveRunner.ts`
- Modify: `backend/test/agent/liveRunner.test.ts`

**Interfaces:**
- Consumes: `runDemo`/`DemoResult` (`./demo`), `sellAnswer` (Task 2), `buildVendor` (`./vendor`), `authorizePayment` (`../payments/authority`), `PaymentLedger` (`../payments/ledger`), `migrate` (`../persistence/db`), `makeSignX402` + pocket helpers, `SettleFn`/`SettleResult` (`../payments/settle`).
- Produces:
  - `export interface LiveDeps { fund: (floatAtomic: bigint) => Promise<Hex[]>; runDemo: (query: string) => Promise<DemoResult>; sell: (answer: string, price: bigint) => Promise<{ ok: boolean; status: number }>; floatAtomic: bigint; settleTransferIds: () => string[]; customer: Address; vendorPayout: Address }`
  - `export interface LiveRunResult extends DemoResult { fundingTxs: Hex[]; settleTransferIds: string[]; sold: boolean; customer: Address; vendorPayout: Address }`
  - `export async function runLive(d: LiveDeps, query: string): Promise<LiveRunResult>`

- [ ] **Step 1: Write the failing test** — append a full-orchestration test that uses a fake `fund`, a fake Anthropic client, the REAL in-process vendor + REAL `sellAnswer` + a REAL recording settle (only chain-funding and the LLM are faked).

```ts
// append to backend/test/agent/liveRunner.test.ts
import Database from "better-sqlite3";
import { runLive } from "../../src/agent/liveRunner";
import { sellAnswer as realSell } from "../../src/agent/liveRunner";
import { runDemo } from "../../src/agent/demo";
import { buildVendor } from "../../src/agent/vendor";
import { authorizePayment } from "../../src/payments/authority";
import { PaymentLedger } from "../../src/payments/ledger";
import { migrate } from "../../src/persistence/db";
import { arcBatchingConfig } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import type { SettleFn } from "../../src/payments/settle";

const POCKET = `0x${"2".repeat(64)}` as const;
const vendorPayout = getAddress(`0x${"cd".repeat(20)}`);
const treasury2 = getAddress(`0x${"ab".repeat(20)}`);

test("runLive: fund -> agent buys (settles) -> customer buys answer (settles) -> P&L + transfer ids", async () => {
  // recording settle shared by BOTH legs (the vendor's buy + the sale)
  const settleLog: string[] = [];
  const recordingSettle: SettleFn = async () => {
    const id = `t${settleLog.length + 1}`;
    settleLog.push(id);
    return { ok: true, transferId: id };
  };

  // real Authority over an in-memory ledger + fake treasury reads + real pocket signX402
  const db = new Database(":memory:"); migrate(db);
  const ledger = new PaymentLedger(db);
  const signX402 = makeSignX402({ signer: pocketSignerFromKey(POCKET), chainId: 5042002, network: arcBatchingConfig.network, verifyingContract: arcBatchingConfig.verifyingContract });
  const authorityDeps = {
    ledger,
    readTreasury: async () => ({ available: 1_000_000n, paused: false, allowlistEnabled: false, isAllowed: true }),
    signX402: async (req: Parameters<typeof authorizePayment>[1]) => signX402({ payTo: req.payee, amount: req.amount, asset: req.asset, network: req.network, maxTimeoutSeconds: req.maxTimeoutSeconds }),
  };
  const authorize = (req: Parameters<typeof authorizePayment>[1]) => authorizePayment(authorityDeps as never, req);

  // the vendor the agent buys from — buys settle through the recording settle
  const vendor = buildVendor({ payTo: vendorPayout, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network, settle: recordingSettle });

  // fake Anthropic client: buy "sentiment", then a final answer
  let i = 0;
  const scripted = [
    { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "buy_data", input: { datasetId: "sentiment" } }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Sentiment is up (0.62)." }] },
  ];
  const client = { messages: { create: async () => scripted[i++] } } as never;

  const fund = vi.fn(async () => ["0xfund1", "0xfund2"] as `0x${string}`[]);

  const out = await runLive({
    fund,
    runDemo: (q) => runDemo({ client, model: "claude-sonnet-4-6", vendor, authorize, readBudget: async () => ({ available: 1_000_000n, runningPending: 0n }), vendorBase: "http://vendor.local", margin: 0.5, agentPayout: treasury2 }, q),
    sell: (answer, price) => realSell({ chainId: 5042002, answer, price, sellerPayTo: treasury2, customerPrivateKey: POCKET, settle: recordingSettle }),
    floatAtomic: 500_000n,
    settleTransferIds: () => settleLog,
    customer: pocketSignerFromKey(POCKET).address,
    vendorPayout,
  }, "How is sentiment?");

  expect(fund).toHaveBeenCalledWith(500_000n);
  expect(out.purchases).toEqual([{ id: "sentiment", cost: 10_000n }]);
  expect(out.totalCost).toBe(10_000n);
  expect(out.price).toBe(15_000n);
  expect(out.pnl).toBe(5_000n);
  expect(out.sold).toBe(true);
  expect(out.fundingTxs).toEqual(["0xfund1", "0xfund2"]);
  // two settlements recorded: the buy leg (t1) then the sale (t2)
  expect(out.settleTransferIds).toEqual(["t1", "t2"]);
  expect(out.answer.toLowerCase()).toContain("sentiment");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/agent/liveRunner.test.ts`
Expected: FAIL — cannot find `runLive`.

- [ ] **Step 3: Implement** — add the types + `runLive` to `backend/src/agent/liveRunner.ts` (add the `DemoResult` import):

```ts
// add to backend/src/agent/liveRunner.ts
import type { DemoResult } from "./demo";

export interface LiveDeps {
  fund: (floatAtomic: bigint) => Promise<Hex[]>;
  runDemo: (query: string) => Promise<DemoResult>;
  sell: (answer: string, price: bigint) => Promise<{ ok: boolean; status: number }>;
  floatAtomic: bigint;
  settleTransferIds: () => string[];
  customer: Address;
  vendorPayout: Address;
}

export interface LiveRunResult extends DemoResult {
  fundingTxs: Hex[];
  settleTransferIds: string[];
  sold: boolean;
  customer: Address;
  vendorPayout: Address;
}

/** Orchestrate the three legs: fund the pocket, run the agent (buys settle via its vendor), then sell the answer. */
export async function runLive(d: LiveDeps, query: string): Promise<LiveRunResult> {
  const fundingTxs = await d.fund(d.floatAtomic); // leg 0 — before the agent can spend
  const demo = await d.runDemo(query); // legs 1 — agent buys (settles) + synthesizes + prices
  const sale = await d.sell(demo.answer, demo.price); // leg 2 — customer buys the answer (settles in)
  return {
    ...demo,
    fundingTxs,
    settleTransferIds: d.settleTransferIds(),
    sold: sale.ok,
    customer: d.customer,
    vendorPayout: d.vendorPayout,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/agent/liveRunner.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/agent/liveRunner.ts backend/test/agent/liveRunner.test.ts
git commit -m "feat(agent): runLive — fund -> buy(settle) -> sell(settle) orchestration with P&L + transfer ids"
```

---

### Task 4: `resolveLiveAddresses` + `fundPocket` + `buildLiveAgentRunner` (live composition root)

**Files:**
- Modify: `backend/src/agent/liveRunner.ts`
- Modify: `backend/test/agent/liveRunner.test.ts` (add the `resolveLiveAddresses` test)
- Modify: `backend/src/cli/index.ts`

**Interfaces:**
- Consumes: `Config`/`loadConfig` (`../config/env`), `buildOperatorWalletClient` (`../adapters/turnkey/operatorWallet`), `ArcAdapter` (`../adapters/arc/arcAdapter`), `PocketGateway` (`../adapters/x402/gateway`), `topUpPocket` (`../payments/funding`), `makeSettle`/`SettleFn` (`../payments/settle`), `buildVendor` (`./vendor`), `runDemo` (`./demo`), `usdToUnits` (`../policy/units`), `chainFor` (`../chains`), `Anthropic` (`@anthropic-ai/sdk`), `PaymentLedger`, `migrate`, `authorizePayment`.
- Produces:
  - `export function resolveLiveAddresses(env: { treasury?: string; vendorPayout?: string; agentPayout?: string }): { treasury: Address; vendorPayout: Address; agentPayout: Address }` (throws on missing/equal).
  - `export async function fundPocket(cfg: Config, treasury: Address, floatAtomic: bigint): Promise<Hex[]>`
  - `export async function buildLiveAgentRunner(cfg?: Config): Promise<(query: string) => Promise<LiveRunResult>>`

- [ ] **Step 1: Write the failing test** — only `resolveLiveAddresses` is deterministically testable here (the rest is live composition, verified by typecheck + the existing cli test).

```ts
// append to backend/test/agent/liveRunner.test.ts
import { resolveLiveAddresses } from "../../src/agent/liveRunner";

test("resolveLiveAddresses: requires treasury + vendorPayout, and they must differ", () => {
  const t = getAddress(`0x${"ab".repeat(20)}`);
  const v = getAddress(`0x${"cd".repeat(20)}`);
  expect(resolveLiveAddresses({ treasury: t, vendorPayout: v })).toEqual({ treasury: t, vendorPayout: v, agentPayout: t });
  expect(() => resolveLiveAddresses({ vendorPayout: v })).toThrow(/TREASURY_ADDRESS/);
  expect(() => resolveLiveAddresses({ treasury: t })).toThrow(/VENDOR_PAYOUT_ADDRESS/);
  expect(() => resolveLiveAddresses({ treasury: t, vendorPayout: t })).toThrow(/must differ/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/agent/liveRunner.test.ts`
Expected: FAIL — cannot find `resolveLiveAddresses`.

- [ ] **Step 3: Implement** — add the three functions to `backend/src/agent/liveRunner.ts`. Add imports at the top.

```ts
// add imports
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { http, createPublicClient } from "viem";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { PocketGateway } from "../adapters/x402/gateway";
import { buildOperatorWalletClient } from "../adapters/turnkey/operatorWallet";
import { chainFor } from "../chains";
import { type Config, loadConfig } from "../config/env";
import { authorizePayment } from "../payments/authority";
import { topUpPocket } from "../payments/funding";
import { PaymentLedger } from "../payments/ledger";
import { makeSettle } from "../payments/settle";
import { migrate } from "../persistence/db";
import { usdToUnits } from "../policy/units";
import { runDemo } from "./demo";
import { buildVendor } from "./vendor";

/** Validate the three demo addresses from env: treasury + vendorPayout required, and distinct. */
export function resolveLiveAddresses(env: { treasury?: string; vendorPayout?: string; agentPayout?: string }): {
  treasury: Address;
  vendorPayout: Address;
  agentPayout: Address;
} {
  const treasury = (env.treasury ?? "") as Address;
  if (!treasury) throw new Error("set TREASURY_ADDRESS to run the agent");
  const vendorPayout = (env.vendorPayout ?? "") as Address;
  if (!vendorPayout) throw new Error("set VENDOR_PAYOUT_ADDRESS (the data-vendor cost destination) to run the agent");
  if (vendorPayout.toLowerCase() === treasury.toLowerCase()) {
    throw new Error("VENDOR_PAYOUT_ADDRESS must differ from TREASURY_ADDRESS (cost must leave the treasury)");
  }
  const agentPayout = (env.agentPayout || treasury) as Address;
  return { treasury, vendorPayout, agentPayout };
}

/** Leg 0: governed top-up treasury -> operator(enclave) -> pocket -> Gateway. Returns the on-chain tx hashes. */
export async function fundPocket(cfg: Config, treasury: Address, floatAtomic: bigint): Promise<Hex[]> {
  if (!cfg.turnkey) throw new Error("the funding bridge needs the Turnkey enclave operator (set TURNKEY_*)");
  if (!cfg.pocketPrivateKey) throw new Error("set POCKET_PRIVATE_KEY to run the funding bridge");
  const operatorWallet = await buildOperatorWalletClient(cfg);
  const pub = createPublicClient({ chain: chainFor(cfg.chainId, cfg.rpcUrl), transport: http(cfg.rpcUrl) });
  const adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: undefined as never, // not used by the operator-sent funding txs
    operatorWallet,
    chainId: cfg.chainId,
    factory: (cfg.factoryAddress ?? "0x0") as Address,
    identityRegistry: cfg.identityRegistry,
  });
  const gateway = new PocketGateway({ pocketPrivateKey: cfg.pocketPrivateKey, rpcUrl: cfg.rpcUrl });
  const txs: Hex[] = [];
  await topUpPocket(
    {
      treasury,
      usdc: cfg.usdc,
      pocketAddress: gateway.address,
      available: () => adapter.treasuryAvailable(treasury),
      fundOperator: async (t, a) => {
        const h = await adapter.fundOperator(t, a);
        txs.push(h);
        return h;
      },
      operatorTransferUsdc: async (u, to, a) => {
        const h = await adapter.operatorTransferUsdc(u, to, a);
        txs.push(h);
        return h;
      },
      depositToGateway: (amt) => gateway.deposit(amt),
    },
    floatAtomic,
  );
  return txs;
}

/** Live composition root: wire real funding + agent + settled sell into a single runner. */
export async function buildLiveAgentRunner(cfg: Config = loadConfig()): Promise<(query: string) => Promise<LiveRunResult>> {
  if (!cfg.anthropicApiKey) throw new Error("set ANTHROPIC_API_KEY to run the agent");
  if (!cfg.pocketPrivateKey) throw new Error("set POCKET_PRIVATE_KEY to run the agent");
  const { treasury, vendorPayout, agentPayout } = resolveLiveAddresses({
    treasury: process.env.TREASURY_ADDRESS,
    vendorPayout: process.env.VENDOR_PAYOUT_ADDRESS,
    agentPayout: process.env.AGENT_PAYOUT_ADDRESS,
  });

  const pub = createPublicClient({ chain: chainFor(cfg.chainId, cfg.rpcUrl), transport: http(cfg.rpcUrl) });
  const adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: undefined as never,
    chainId: cfg.chainId,
    factory: (cfg.factoryAddress ?? "0x0") as Address,
    identityRegistry: cfg.identityRegistry,
  });
  const db = new Database(cfg.dbPath);
  migrate(db);
  const ledger = new PaymentLedger(db);
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(cfg.pocketPrivateKey),
    chainId: cfg.chainId,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });

  // recording settle shared by both legs
  const settleTransferIds: string[] = [];
  const baseSettle = makeSettle({ facilitatorUrl: cfg.gatewayFacilitatorUrl });
  const settle: SettleFn = async (header, reqs) => {
    const r = await baseSettle(header, reqs);
    if (r.ok && r.transferId) settleTransferIds.push(r.transferId);
    return r;
  };

  const authorityDeps = {
    ledger,
    readTreasury: async (payee: Address) => ({
      available: await adapter.treasuryAvailable(treasury),
      paused: await adapter.treasuryPaused(treasury),
      allowlistEnabled: await adapter.treasuryAllowlistEnabled(treasury),
      isAllowed: await adapter.treasuryIsAllowed(treasury, payee),
    }),
    signX402: async (req: Parameters<typeof authorizePayment>[1]) =>
      signX402({ payTo: req.payee, amount: req.amount, asset: req.asset, network: req.network, maxTimeoutSeconds: req.maxTimeoutSeconds }),
  };
  const authorize = (req: Parameters<typeof authorizePayment>[1]) => authorizePayment(authorityDeps, req);

  const vendor = buildVendor({ payTo: vendorPayout, asset: arcBatchingConfig.asset, network: arcBatchingConfig.network, settle });
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const readBudget = async () => ({ available: await adapter.treasuryAvailable(treasury), runningPending: ledger.runningPending() });
  const floatAtomic = usdToUnits(cfg.fundingFloatUsdc);
  const customer = pocketSignerFromKey(cfg.customerPrivateKey).address;

  return (query: string) =>
    runLive(
      {
        fund: (amt) => fundPocket(cfg, treasury, amt),
        runDemo: (q) =>
          runDemo({ client, model: cfg.agentModel, vendor, authorize, readBudget, vendorBase: "http://vendor.local", margin: 0.5, agentPayout }, q),
        sell: (answer, price) => sellAnswer({ chainId: cfg.chainId, answer, price, sellerPayTo: agentPayout, customerPrivateKey: cfg.customerPrivateKey, settle }),
        floatAtomic,
        settleTransferIds: () => settleTransferIds,
        customer,
        vendorPayout,
      },
      query,
    );
}
```

> Note: `usdToUnits(cfg.fundingFloatUsdc)` converts the decimal USDC float (e.g. `"0.50"`) to atomic `bigint` (`500000n`) — confirm against the existing `usdToUnits` used by `cli/index.ts`'s `--fund` option. `pocketSignerFromKey(...).address` gives the customer EOA address.

- [ ] **Step 4: Wire the CLI to the moved runner.** In `backend/src/cli/index.ts`:
  - Delete the local `buildLiveAgentRunner` function (the block from `export async function buildLiveAgentRunner` through its closing brace) and the now-unused imports it alone used (e.g. `ArcAdapter`, `makeSignX402`, `pocketSignerFromKey`, `authorizePayment`, `PaymentLedger`, `migrate`, `arcBatchingConfig`, `buildVendor`, `runDemo`, `chainFor`, `createPublicClient`, `http`, `Anthropic`, `Database`) — remove only those that become unused (let `tsc`/biome flag leftovers).
  - Add: `import { buildLiveAgentRunner } from "../agent/liveRunner";` and keep `import { type DemoResult } from "../agent/demo";` only if still referenced (the `AgentDeps` type uses `DemoResult`).
  - In the `agent ask` action, after printing the answer + purchases + denied + `cost=/price=/P&L=` line, add (guarded, since the injected test runner returns a plain `DemoResult`):

```ts
const lr = r as Partial<import("../agent/liveRunner").LiveRunResult>;
if (lr.fundingTxs?.length) console.log("funding txs:", lr.fundingTxs.join(", "));
if (lr.settleTransferIds?.length) console.log("settled transfer ids:", lr.settleTransferIds.join(", "));
if (lr.sold !== undefined) console.log(`sold=${lr.sold} customer=${lr.customer} vendorPayout=${lr.vendorPayout}`);
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend && npx vitest run test/agent/liveRunner.test.ts test/agent/cli.test.ts` → PASS (the cli test still passes with its injected fake runner). Then `npm run typecheck && npm run lint`, then `npx vitest run --exclude '**/*.live.test.ts'` (no regression).

- [ ] **Step 6: Commit**

```bash
git add backend/src/agent/liveRunner.ts backend/test/agent/liveRunner.test.ts backend/src/cli/index.ts
git commit -m "feat(agent): live composition root (fundPocket + buildLiveAgentRunner); CLI uses it"
```

---

### Task 5: Real `--settle` spike + operator runbook

**Files:**
- Modify: `backend/scripts/spike-agent-live.mts`
- Create: `docs/runbooks/2026-06-19-live-agent-run.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: `buildLiveAgentRunner` (Task 4), `loadConfig` (`../src/config/env`).

- [ ] **Step 1: Rewrite the spike's body** so `--settle` runs the real live runner (no more stub). Keep the no-key guard; gate the actual spend behind `--settle`.

```ts
// backend/scripts/spike-agent-live.mts — needs ANTHROPIC_API_KEY; --settle spends testnet USDC.
import "dotenv/config";
import { buildLiveAgentRunner } from "../src/agent/liveRunner";
import { loadConfig } from "../src/config/env";

async function main() {
  const cfg = loadConfig();
  if (!cfg.anthropicApiKey) {
    console.log("set ANTHROPIC_API_KEY in backend/.env to run the live agent");
    return;
  }
  if (!process.argv.includes("--settle")) {
    console.log("pass --settle to run the live settled cycle (funds the pocket + buys + sells; spends testnet USDC)");
    return;
  }
  const query = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "How is agent-economy sentiment trending?";
  const run = await buildLiveAgentRunner(cfg);
  const r = await run(query);
  console.log("\n=== answer ===\n" + r.answer);
  console.log("\npurchases:", r.purchases.map((p) => `${p.id} (${p.cost})`).join(", ") || "(none)");
  if (r.denied.length) console.log("denied:", r.denied.map((x) => `${x.id}: ${x.reason}`).join(", "));
  console.log(`\ncost=${r.totalCost} price=${r.price} P&L=${r.pnl} (atomic USDC)`);
  console.log("sold:", r.sold, "| customer:", r.customer, "| vendorPayout:", r.vendorPayout);
  console.log("funding txs:", r.fundingTxs.join(", ") || "(none)");
  console.log("settled transfer ids:", r.settleTransferIds.join(", ") || "(none)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run offline** to confirm the guard (no key in `.env`):

Run: `cd backend && npx tsx scripts/spike-agent-live.mts`
Expected: prints `set ANTHROPIC_API_KEY in backend/.env to run the live agent` and exits 0 (no live call). Then `npm run typecheck && npm run lint`.

- [ ] **Step 3: Write the runbook** — create `docs/runbooks/2026-06-19-live-agent-run.md`:

```markdown
# Runbook — Live Governed Agent Cycle (Arc testnet)

Runs the full autonomous cycle live: governed funding -> agent buys data (settles) -> simulated customer
buys the answer (settles into the treasury) -> real P&L. **Spends real testnet USDC + Anthropic tokens +
~2 Turnkey enclave signatures.** Operator-triggered only.

## 1. Set env in `backend/.env`
- `ANTHROPIC_API_KEY=...`            (the agent's brain; demo-only)
- `TREASURY_ADDRESS=0x...`           (the live agent-656785 AgentTreasury)
- `VENDOR_PAYOUT_ADDRESS=0x...`      (where data-purchase cost settles — MUST differ from the treasury)
- `AGENT_PAYOUT_ADDRESS=0x...`       (optional; defaults to the treasury — where revenue lands)
- `FUNDING_FLOAT_USDC=0.50`          (optional; the bounded top-up)
- `CUSTOMER_PRIVATE_KEY=0x...`       (optional; defaults to the platform key)
- Already present from earlier phases: `POCKET_PRIVATE_KEY`, `TURNKEY_*`, `PLATFORM_PRIVATE_KEY`, the Arc RPC.

## 2. Funding prerequisites
- The treasury holds USDC and its rolling cap covers `FUNDING_FLOAT_USDC` (`available() >= float`).
- The customer key's Gateway balance >= the answer `price` (price = cost x (1 + margin), margin 0.5).
- The operator (enclave) EOA `0x46DE...` has a small USDC gas reserve (Arc charges USDC gas).

## 3. Run
```bash
cd backend && npx tsx scripts/spike-agent-live.mts --settle
```
(append a query as a bare arg to override the default, e.g. `... --settle "What are USDC flows on Arc?"`)

## 4. Expected output
Answer, purchases, `cost=/price=/P&L=`, `sold=true`, the **funding tx hashes**, and the **settle transfer ids**.

## 5. Verify on-chain
- Funding txs on Arcscan (https://testnet.arcscan.app).
- Circle transfer ids settle `received -> completed` in ~1 min (batched gatewayMint).
- Record the run's purchases/answer/P&L + transfer ids in the Phase-3 section of
  `docs/research/2026-06-16-x402-gateway-spike-findings.md`.

## Safety
The data vendor and the customer are in-process simulations; payments/signing/settlement/funding/governance
are all real. Guardian `pause` halts the Authority's signing mid-run; an over-cap/off-allowlist buy is denied.
```

- [ ] **Step 4: Index the runbook** in `docs/README.md` — add a `docs/runbooks/2026-06-19-live-agent-run.md` entry next to the existing plan/research entries, matching their format/status convention (status: operator runbook / current).

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/spike-agent-live.mts docs/runbooks/2026-06-19-live-agent-run.md docs/README.md
git commit -m "feat(agent): real --settle live runner + operator runbook"
```

**Plan gate:** `tsc` + `biome` clean; `npx vitest run --exclude '**/*.live.test.ts'` green; the spike prints its guard with no key. The live settled cycle is one command away for the operator (`--settle` + a funded treasury/pocket).

---

## Self-Review

- **Spec coverage:** liveRunner module + `runLive` (§Components) → Tasks 2–4; funding bridge wired to Turnkey enclave (§money-flow leg 0, Decision 2) → `fundPocket` Task 4; real settled sell (Decision 1) → `sellAnswer` Task 2 + leg 2 in `runLive` Task 3; vendor-payout fix (Decision 5) → `resolveLiveAddresses` + the vendor build in Task 4; config additions (§Config) → Task 1; settle capture (§Components) → the recording `SettleFn` in Task 4; killer moments unchanged (§Error handling) → Authority untouched, agent still keyless (Global Constraints); deterministic tests with fakes (§Testing) → Tasks 1–3; spike `--settle` real + runbook (§Deliverable) → Task 5. Live execution stays out of scope (operator-triggered) — matches the spec.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code; the runbook's `0x...` are operator-supplied env values (documented), not plan gaps.
- **Type consistency:** `SellParams`/`sellAnswer` return `{ok,status}` (Task 2) consumed by `LiveDeps.sell` (Task 3) and `buildLiveAgentRunner` (Task 4); `LiveDeps`/`LiveRunResult` (Task 3) consumed by `buildLiveAgentRunner` (Task 4) and the CLI/spike (Tasks 4–5); `resolveLiveAddresses` returns `{treasury,vendorPayout,agentPayout}` used by `buildLiveAgentRunner`; `fundPocket(cfg,treasury,floatAtomic): Promise<Hex[]>` matches `LiveDeps.fund`; `cfg.fundingFloatUsdc`/`cfg.customerPrivateKey` (Task 1) used in Task 4. Atomic `bigint` USDC throughout; `.toString()` only at the print boundary.
- **Open prerequisite:** the live run needs `ANTHROPIC_API_KEY` + a funded treasury/pocket/customer (documented + gated). `buildLiveAgentRunner` is live-composition — deterministic coverage is the `resolveLiveAddresses` guard + the existing cli test + typecheck; runtime correctness is proven by the operator's `--settle` run (the runbook).
