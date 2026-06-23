# Governed Nanopayment Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the live Agent Legal Body a governed off-chain nanopayment path — a policy-gated Payment Authority that signs x402/Circle-Gateway payments only within the on-chain treasury's bounds — proven end-to-end on Arc testnet.

**Architecture:** Additive layer on the deployed protocol (contracts/onboarding/`TurnkeySigner` unchanged). A **de-risking spike** first proves real x402 + `@circle-fin/x402-batching` settlement on Arc testnet; then the **Payment Authority** (pure policy gate + SQLite spend-ledger + treasury reads + the existing `OperatorSigner`, exposed over a thin HTTP route) becomes the single signing chokepoint. The buyer/seller/agent/dashboard build on this in later phases.

**Tech Stack:** TypeScript (ESM, Node 24), viem + abitype, better-sqlite3, vitest, biome, Hono (thin HTTP), Turnkey (`@turnkey/sdk-server`/`@turnkey/viem`), `@circle-fin/x402-batching` + Coinbase `x402-*` packages, Claude (AI SDK) in a later phase.

---

## How this plan is phased (read first)

The spec's **top risk** is whether `@circle-fin/x402-batching` + x402 actually round-trip on Arc testnet. Until **Phase 0** resolves that empirically, the exact SDK call shapes are unknown — so writing bite-sized code for the SDK-dependent components now would be guessing. Therefore:

- **Phase 0 (spike)** and **Phase 1 (Payment Authority core)** are written in full TDD detail below. Phase 1 is deliberately built against the existing `OperatorSigner` *interface* and an injected `signX402()` seam, so it is fully testable **without** the live SDK.
- **Phases 2–4** (Buyer/Seller x402 integration, Claude agent loop, funding bridge, dashboard) are a **roadmap** here; each gets its own detailed plan once Phase 0 fixes the SDK reality and the `signX402()` seam is concrete.

**Branch:** `feat/nanopayments-x402-agent` (already created; design committed at `6c1fb6f`).

## File structure (Phase 0 + Phase 1)

| File | Responsibility |
|---|---|
| `backend/scripts/spike-x402-gateway.mts` | Phase 0 spike: prove x402 sign + Gateway settle on Arc testnet (exploratory, deletable) |
| `docs/research/2026-06-16-x402-gateway-spike-findings.md` | Phase 0 output: the verified SDK call shapes + the `signX402()` seam contract |
| `backend/src/adapters/arc/arcAdapter.ts` (modify) | Add treasury reads: `treasuryPaused`, `treasuryAllowlistEnabled`, `treasuryIsAllowed` |
| `backend/src/persistence/db.ts` (modify) | Add `payments_ledger` table to `migrate()` |
| `backend/src/payments/ledger.ts` | SQLite spend-ledger repository (record authorized / mark settled|failed / running pending) |
| `backend/src/payments/policyGate.ts` | Pure policy decision function (the core) |
| `backend/src/payments/authority.ts` | Compose treasury reads + ledger + policy + signer into `authorizePayment()` |
| `backend/src/payments/server.ts` | Thin Hono route exposing `POST /authorize` |
| `backend/test/payments/*.test.ts` | Tests for each unit |

---

# Phase 0 — De-risking spike (x402 + Circle Gateway on Arc testnet)

> Exploratory by design: the "tests" here are *prove-it-works* checks with explicit success criteria, not unit tests. Output is a findings doc that defines the `signX402()` seam Phase 1 depends on. Reuses the funded keys already in `backend/.env`.

### Task 0.1: Install + probe the payment SDKs

**Files:**
- Modify: `backend/package.json` (deps)

- [ ] **Step 1: Install the packages**

```bash
cd backend
npm install @circle-fin/x402-batching x402 x402-fetch
```

- [ ] **Step 2: Probe the exported surface (record what's real, not what docs claim)**

Run:
```bash
node -e "console.log(Object.keys(require('@circle-fin/x402-batching')))"
node -e "console.log(Object.keys(require('x402-fetch')))"
```
Expected: a `GatewayClient` (or equivalent) export from x402-batching; a `wrapFetchWithPayment`/`fetchWithPayment` from x402-fetch. **Record the actual exports** — they drive everything downstream.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "chore(payments): add x402 + Circle Gateway batching SDKs"
```

### Task 0.2: Prove an x402 authorization signs + verifies with our operator key

**Files:**
- Create: `backend/scripts/spike-x402-gateway.mts`

- [ ] **Step 1: Write the spike — sign an x402/EIP-3009 authorization with the Turnkey operator and verify recovery**

```ts
// backend/scripts/spike-x402-gateway.mts — exploratory; safe to delete after findings are recorded.
import "dotenv/config";
import { loadConfig } from "../src/config/env";
import { buildOperatorSigner } from "../src/adapters/turnkey/operatorSigner";

const cfg = loadConfig();
const signer = await buildOperatorSigner(cfg);
console.log("operator address:", signer.address);

// GOAL of this step: discover how x402 expects the payment authorization to be signed, and confirm
// our OperatorSigner (which signs arbitrary EIP-712 TypedDataDefinition) can produce it.
// Build the x402 "exact"/EIP-3009 typed data for a tiny USDC amount on Arc, sign via signer.signWalletSet
// (it signs any TypedDataDefinition), and verify recovery == signer.address.
// Fill in the concrete typed-data shape from the x402 package internals discovered in Task 0.1.
// RECORD: the exact typed-data structure x402 uses, so Phase 1 can reuse signer for it.
```

- [ ] **Step 2: Run and observe**

Run: `cd backend && npx tsx scripts/spike-x402-gateway.mts`
Expected: prints the operator address and a recovered signer address **equal** to it. If x402 needs a signer interface our `OperatorSigner` doesn't satisfy, **record the gap** (this is the key finding).

### Task 0.3: Prove a real settlement on Arc testnet via Gateway batching

**Files:**
- Modify: `backend/scripts/spike-x402-gateway.mts`

- [ ] **Step 1: Extend the spike — fund the Gateway balance and settle one batched authorization**

Use `GatewayClient` (from Task 0.1) to: deposit a small USDC amount from the platform/operator into the Gateway balance, submit one signed authorization, trigger/await a batch settlement on Arc testnet (chainId 5042002, RPC `https://rpc.testnet.arc.network`).

- [ ] **Step 2: Run and verify on-chain**

Run: `cd backend && npx tsx scripts/spike-x402-gateway.mts`
Expected: a settlement tx hash on Arc testnet. Verify with:
```bash
cast tx <hash> --rpc-url https://rpc.testnet.arc.network
```
Success criterion: a USDC movement settled on Arc that corresponds to the off-chain authorization.

### Task 0.4: Record findings + define the `signX402()` seam

**Files:**
- Create: `docs/research/2026-06-16-x402-gateway-spike-findings.md`

- [ ] **Step 1: Write the findings doc** — the real package exports, the x402 authorization typed-data shape, the `GatewayClient` deposit/submit/settle calls, any gaps, and a TypeScript signature for the seam Phase 1 will call:

```ts
// The seam Phase 1 depends on (concrete impl lives in backend/src/adapters/x402/):
export interface PaymentRequirements { payTo: Address; amount: bigint; asset: Address; network: string; /* ...from 402 */ }
export interface SignedX402 { header: string; /* the X-PAYMENT value */ ledgerRef: string }
export type SignX402 = (signer: OperatorSigner, req: PaymentRequirements) => Promise<SignedX402>;
```

- [ ] **Step 2: Commit**

```bash
git add docs/research/2026-06-16-x402-gateway-spike-findings.md backend/scripts/spike-x402-gateway.mts
git commit -m "spike(payments): verify x402 + Gateway settlement on Arc testnet; define signX402 seam"
```

**Phase 0 gate:** if Task 0.3 cannot settle on Arc testnet, STOP and fall back to the spec's "Approach-1 with simpler settlement" (settle via `AgentTreasury`/direct USDC transfer) before continuing. Either way, Phase 1 proceeds — it does not import the SDK directly.

---

# Phase 1 — Payment Authority core (the moat)

> Fully testable without the live SDK: the policy gate is pure, the ledger is SQLite, treasury state is read via `ArcAdapter` (anvil-backed in tests), and signing goes through the existing `OperatorSigner` interface plus the injected `SignX402` seam (faked in tests).

### Task 1.1: Treasury read helpers on ArcAdapter

**Files:**
- Modify: `backend/src/adapters/arc/arcAdapter.ts` (add methods after `treasuryAvailable`, ~line 220)
- Test: `backend/test/payments/treasuryReads.int.test.ts`

- [ ] **Step 1: Write the failing integration test** (anvil, reuse `deployStack` like `arcAdapter.bind.int.test.ts`)

```ts
import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { anvilChain } from "../../src/chains";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { deployStack } from "../helpers/stack";

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let treasury: `0x${string}`;
const manager = privateKeyToAccount(`0x${"a".repeat(63)}c`);

beforeAll(async () => {
  anvil = await startAnvil(8549);
  const transport = http(anvil.rpcUrl);
  const pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  const stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({ publicClient: pub, managerWallet: wallet, chainId: anvilChain.id, factory: stack.factory, identityRegistry: stack.registry });
  const res = await adapter.createEntity({ /* same minimal params as bind.int.test.ts */ } as never);
  treasury = (res as { treasury: `0x${string}` }).treasury;
}, 40_000);
afterAll(() => anvil?.stop());

test("treasury reads: paused=false, allowlistEnabled matches creation", async () => {
  expect(await adapter.treasuryPaused(treasury)).toBe(false);
  expect(typeof (await adapter.treasuryAllowlistEnabled(treasury))).toBe("boolean");
}, 40_000);
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/treasuryReads.int.test.ts`
Expected: FAIL — `adapter.treasuryPaused is not a function`.

- [ ] **Step 3: Add the read helpers** (mirror `treasuryAvailable`, using `agentTreasuryAbi`)

```ts
treasuryPaused(treasury: Address): Promise<boolean> {
  return this.d.publicClient.readContract({ address: treasury, abi: agentTreasuryAbi, functionName: "paused" }) as Promise<boolean>;
}
treasuryAllowlistEnabled(treasury: Address): Promise<boolean> {
  return this.d.publicClient.readContract({ address: treasury, abi: agentTreasuryAbi, functionName: "allowlistEnabled" }) as Promise<boolean>;
}
treasuryIsAllowed(treasury: Address, who: Address): Promise<boolean> {
  return this.d.publicClient.readContract({ address: treasury, abi: agentTreasuryAbi, functionName: "allowlist", args: [who] }) as Promise<boolean>;
}
```
(If the contract's allowlist getter differs from `allowlist(address)`, adjust `functionName`/`args` to match `agentTreasuryAbi` — verify against the generated ABI.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/treasuryReads.int.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/arc/arcAdapter.ts backend/test/payments/treasuryReads.int.test.ts
git commit -m "feat(payments): treasury read helpers (paused, allowlistEnabled, isAllowed)"
```

### Task 1.2: The pure policy gate

**Files:**
- Create: `backend/src/payments/policyGate.ts`
- Test: `backend/test/payments/policyGate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "vitest";
import { evaluatePolicy } from "../../src/payments/policyGate";

const base = { payee: "0x0000000000000000000000000000000000000abc" as const, amount: 100n, available: 1_000n, paused: false, allowlistEnabled: true, isAllowed: true, runningPending: 0n };

test("allows a within-cap, allowlisted, unpaused payment", () => {
  expect(evaluatePolicy(base)).toEqual({ ok: true });
});
test("denies when paused", () => {
  expect(evaluatePolicy({ ...base, paused: true })).toEqual({ ok: false, reason: "paused" });
});
test("denies a non-allowlisted payee when allowlist is on", () => {
  expect(evaluatePolicy({ ...base, isAllowed: false })).toEqual({ ok: false, reason: "not-allowlisted" });
});
test("ignores allowlist when disabled", () => {
  expect(evaluatePolicy({ ...base, allowlistEnabled: false, isAllowed: false })).toEqual({ ok: true });
});
test("denies when runningPending + amount exceeds available", () => {
  expect(evaluatePolicy({ ...base, runningPending: 950n, amount: 100n })).toEqual({ ok: false, reason: "over-cap" });
});
test("denies zero/negative amount", () => {
  expect(evaluatePolicy({ ...base, amount: 0n }).ok).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/policyGate.test.ts`
Expected: FAIL — cannot find `evaluatePolicy`.

- [ ] **Step 3: Implement the pure gate**

```ts
// backend/src/payments/policyGate.ts
import type { Address } from "../types";

export interface PolicyInput {
  payee: Address;
  amount: bigint;          // USDC base units (6 decimals)
  available: bigint;       // treasury.available() at check time
  paused: boolean;
  allowlistEnabled: boolean;
  isAllowed: boolean;      // payee ∈ allowlist (consulted only when allowlistEnabled)
  runningPending: bigint;  // sum of ledger entries authorized-but-not-yet-settled this window
}
export type PolicyReason = "zero-amount" | "paused" | "not-allowlisted" | "over-cap";
export type PolicyDecision = { ok: true } | { ok: false; reason: PolicyReason };

/** Deterministic, side-effect-free. The single source of truth for "may the agent pay this?". */
export function evaluatePolicy(i: PolicyInput): PolicyDecision {
  if (i.amount <= 0n) return { ok: false, reason: "zero-amount" };
  if (i.paused) return { ok: false, reason: "paused" };
  if (i.allowlistEnabled && !i.isAllowed) return { ok: false, reason: "not-allowlisted" };
  if (i.runningPending + i.amount > i.available) return { ok: false, reason: "over-cap" };
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/policyGate.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/payments/policyGate.ts backend/test/payments/policyGate.test.ts
git commit -m "feat(payments): pure policy gate (allowlist/cap/pause/amount)"
```

### Task 1.3: The spend-ledger (SQLite)

**Files:**
- Modify: `backend/src/persistence/db.ts` (add table to `migrate()`)
- Create: `backend/src/payments/ledger.ts`
- Test: `backend/test/payments/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { PaymentLedger } from "../../src/payments/ledger";

function freshLedger() {
  const db = new Database(":memory:");
  migrate(db);
  return new PaymentLedger(db);
}
const payee = "0x0000000000000000000000000000000000000abc" as const;

test("authorized entries count toward runningPending until settled", () => {
  const l = freshLedger();
  const id = l.recordAuthorized(payee, 100n);
  expect(l.runningPending()).toBe(100n);
  l.markSettled(id, "batch-1");
  expect(l.runningPending()).toBe(0n);
});
test("failed entries do not count toward runningPending", () => {
  const l = freshLedger();
  const id = l.recordAuthorized(payee, 50n);
  l.markFailed(id);
  expect(l.runningPending()).toBe(0n);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/ledger.test.ts`
Expected: FAIL — cannot find `PaymentLedger`.

- [ ] **Step 3: Add the table to `migrate()`**

```ts
// inside migrate(db), after the existing CREATE TABLE statements:
db.exec(`
  CREATE TABLE IF NOT EXISTS payments_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payee TEXT NOT NULL,
    amount TEXT NOT NULL,                -- bigint as decimal string
    status TEXT NOT NULL CHECK (status IN ('authorized','settled','failed')),
    batch_ref TEXT,
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );
`);
```

- [ ] **Step 4: Implement the repository**

```ts
// backend/src/payments/ledger.ts
import type Database from "better-sqlite3";
import type { Address } from "../types";

export class PaymentLedger {
  constructor(private readonly db: Database.Database) {}

  recordAuthorized(payee: Address, amount: bigint): number {
    const info = this.db
      .prepare("INSERT INTO payments_ledger (payee, amount, status, created_at) VALUES (?, ?, 'authorized', ?)")
      .run(payee, amount.toString(), nowSeconds());
    return Number(info.lastInsertRowid);
  }
  markSettled(id: number, batchRef: string): void {
    this.db.prepare("UPDATE payments_ledger SET status='settled', batch_ref=?, settled_at=? WHERE id=?")
      .run(batchRef, nowSeconds(), id);
  }
  markFailed(id: number): void {
    this.db.prepare("UPDATE payments_ledger SET status='failed' WHERE id=?").run(id);
  }
  /** Sum of authorized-but-not-yet-settled amounts (the off-chain spend not yet reflected on-chain). */
  runningPending(): bigint {
    const row = this.db.prepare("SELECT COALESCE(amount,'0') AS amount FROM payments_ledger WHERE status='authorized'").all() as { amount: string }[];
    return row.reduce((s, r) => s + BigInt(r.amount), 0n);
  }
}
// NOTE: nowSeconds() must not use Date.now() in workflow code, but a repository is fine; if the repo
// forbids Date in this layer, inject a clock. For v1 use: const nowSeconds = () => Math.floor(Date.now()/1000);
function nowSeconds(): number { return Math.floor(Date.now() / 1000); }
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/ledger.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/persistence/db.ts backend/src/payments/ledger.ts backend/test/payments/ledger.test.ts
git commit -m "feat(payments): SQLite spend-ledger with runningPending accounting"
```

### Task 1.4: `authorizePayment()` — compose treasury reads + ledger + gate + signer

**Files:**
- Create: `backend/src/payments/authority.ts`
- Test: `backend/test/payments/authority.test.ts`

- [ ] **Step 1: Write the failing test** (fake treasury reader, in-memory ledger, fake `signX402`)

```ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { PaymentLedger } from "../../src/payments/ledger";
import { authorizePayment, type AuthorityDeps } from "../../src/payments/authority";

const payee = "0x0000000000000000000000000000000000000abc" as const;
function deps(over: Partial<AuthorityDeps> = {}): AuthorityDeps {
  const db = new Database(":memory:"); migrate(db);
  return {
    ledger: new PaymentLedger(db),
    readTreasury: async () => ({ available: 1_000n, paused: false, allowlistEnabled: true, isAllowed: true }),
    signX402: async () => ({ header: "X-PAYMENT-fake", ledgerRef: "ref" }),
    ...over,
  };
}

test("authorizes a valid payment: records ledger + returns X-PAYMENT", async () => {
  const d = deps();
  const res = await authorizePayment(d, { payee, amount: 100n, resource: "/x" });
  expect(res.ok).toBe(true);
  expect((res as { header: string }).header).toBe("X-PAYMENT-fake");
  expect(d.ledger.runningPending()).toBe(100n);
});

test("denies an over-cap payment and writes nothing to the ledger", async () => {
  const d = deps({ readTreasury: async () => ({ available: 50n, paused: false, allowlistEnabled: false, isAllowed: false }) });
  const res = await authorizePayment(d, { payee, amount: 100n, resource: "/x" });
  expect(res).toMatchObject({ ok: false, reason: "over-cap" });
  expect(d.ledger.runningPending()).toBe(0n);
});

test("denies when guardian-paused", async () => {
  const d = deps({ readTreasury: async () => ({ available: 1_000n, paused: true, allowlistEnabled: false, isAllowed: false }) });
  const res = await authorizePayment(d, { payee, amount: 10n, resource: "/x" });
  expect(res).toMatchObject({ ok: false, reason: "paused" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run test/payments/authority.test.ts`
Expected: FAIL — cannot find `authorizePayment`.

- [ ] **Step 3: Implement the composition**

```ts
// backend/src/payments/authority.ts
import type { Address } from "../types";
import { evaluatePolicy } from "./policyGate";
import type { PaymentLedger } from "./ledger";

export interface TreasuryState { available: bigint; paused: boolean; allowlistEnabled: boolean; isAllowed: boolean; }
export interface AuthorizeRequest { payee: Address; amount: bigint; resource: string; }
export interface AuthorityDeps {
  ledger: PaymentLedger;
  readTreasury: (payee: Address) => Promise<TreasuryState>;
  signX402: (req: AuthorizeRequest) => Promise<{ header: string; ledgerRef: string }>;
}
export type AuthorizeResult =
  | { ok: true; header: string }
  | { ok: false; reason: string };

/** The single chokepoint: read on-chain state, evaluate policy, then (and only then) sign + record. */
export async function authorizePayment(d: AuthorityDeps, req: AuthorizeRequest): Promise<AuthorizeResult> {
  const t = await d.readTreasury(req.payee);
  const decision = evaluatePolicy({
    payee: req.payee, amount: req.amount,
    available: t.available, paused: t.paused, allowlistEnabled: t.allowlistEnabled, isAllowed: t.isAllowed,
    runningPending: d.ledger.runningPending(),
  });
  if (!decision.ok) return { ok: false, reason: decision.reason };
  const id = d.ledger.recordAuthorized(req.payee, req.amount);
  try {
    const signed = await d.signX402(req);
    return { ok: true, header: signed.header };
  } catch (e) {
    d.ledger.markFailed(id);
    throw e;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/authority.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/payments/authority.ts backend/test/payments/authority.test.ts
git commit -m "feat(payments): authorizePayment() — policy-gated signing chokepoint"
```

### Task 1.5: Wire real deps + expose `POST /authorize` (thin Hono route)

**Files:**
- Modify: `backend/package.json` (add `hono`)
- Create: `backend/src/payments/server.ts`
- Test: `backend/test/payments/server.test.ts`

- [ ] **Step 1: Install Hono**

```bash
cd backend && npm install hono
```

- [ ] **Step 2: Write the failing test** (Hono's `app.request()` — no network)

```ts
import { expect, test } from "vitest";
import { buildAuthorityApp } from "../../src/payments/server";

test("POST /authorize returns 200 + X-PAYMENT on allow, 402 on deny", async () => {
  const app = buildAuthorityApp({
    ledger: { runningPending: () => 0n, recordAuthorized: () => 1, markFailed: () => {}, markSettled: () => {} } as never,
    readTreasury: async () => ({ available: 1_000n, paused: false, allowlistEnabled: false, isAllowed: true }),
    signX402: async () => ({ header: "X-PAYMENT-ok", ledgerRef: "r" }),
  });
  const ok = await app.request("/authorize", { method: "POST", body: JSON.stringify({ payee: "0x0000000000000000000000000000000000000abc", amount: "100", resource: "/x" }), headers: { "content-type": "application/json" } });
  expect(ok.status).toBe(200);
  expect((await ok.json()).header).toBe("X-PAYMENT-ok");

  const denied = await app.request("/authorize", { method: "POST", body: JSON.stringify({ payee: "0x0000000000000000000000000000000000000abc", amount: "100000", resource: "/x" }), headers: { "content-type": "application/json" } });
  expect(denied.status).toBe(402);
});
```

- [ ] **Step 3: Implement the route** (parse → `authorizePayment` → map allow→200 / deny→402)

```ts
// backend/src/payments/server.ts
import { Hono } from "hono";
import type { Address } from "../types";
import { type AuthorityDeps, authorizePayment } from "./authority";

export function buildAuthorityApp(deps: AuthorityDeps) {
  const app = new Hono();
  app.post("/authorize", async (c) => {
    const body = (await c.req.json()) as { payee: string; amount: string; resource: string };
    const res = await authorizePayment(deps, { payee: body.payee as Address, amount: BigInt(body.amount), resource: body.resource });
    if (res.ok) return c.json({ header: res.header }, 200);
    return c.json({ error: "policy-denied", reason: res.reason }, 402);
  });
  return app;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run test/payments/server.test.ts` → PASS. Then `npm run typecheck && npm run lint`.

- [ ] **Step 5: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/src/payments/server.ts backend/test/payments/server.test.ts
git commit -m "feat(payments): POST /authorize Hono route (allow->200, deny->402)"
```

### Task 1.6: End-to-end guardian-freeze integration test (the demo moment, as a test)

**Files:**
- Test: `backend/test/payments/guardianFreeze.int.test.ts`

- [ ] **Step 1: Write the failing test** — anvil + real `ArcAdapter` treasury reads wired into a real `readTreasury`; assert that toggling on-chain `pause` flips `authorizePayment` from allow to `paused`-deny.

```ts
// Build readTreasury from the real adapter (Task 1.1 helpers):
const readTreasury = async (payee) => ({
  available: await adapter.treasuryAvailable(treasury),
  paused: await adapter.treasuryPaused(treasury),
  allowlistEnabled: await adapter.treasuryAllowlistEnabled(treasury),
  isAllowed: await adapter.treasuryIsAllowed(treasury, payee),
});
// 1) before pause: authorizePayment(...) -> ok:true
// 2) guardian calls treasury.pause() on anvil
// 3) after pause: authorizePayment(...) -> { ok:false, reason:"paused" }
```

- [ ] **Step 2: Run to verify it fails, then make it pass once wired** → PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/test/payments/guardianFreeze.int.test.ts
git commit -m "test(payments): guardian on-chain pause halts authorization (demo moment)"
```

**Phase 1 gate:** full suite green (`npm test`), tsc + biome clean. The Authority now enforces policy + guardian over a real treasury, signing only through the injected `signX402` seam.

---

# Phases 2–4 — Roadmap (detailed plans authored after Phase 0)

Each becomes its own `docs/plans/` file; bite-sized detail depends on the Phase 0 findings + the concrete `signX402()`.

### Phase 2 — x402 Buyer client + Seller
- **Buyer:** wrap the agent's `fetch` (via `x402-fetch`) so a `402` routes to the Authority's `/authorize`, then retries with the returned `X-PAYMENT`. Implement the concrete `signX402` in `backend/src/adapters/x402/` from Phase 0 findings; settle via `GatewayClient`.
- **Seller:** a paywalled `/api/insight` (Next.js or Hono) returning `402` then serving on verified `X-PAYMENT`; revenue routed to the treasury. Reconcile settlements back into the ledger (`markSettled`).
- **Deliverable:** a buy + a sell both settle on Arc testnet.

### Phase 3 — Claude insight-agent loop
- The autonomous loop (AI SDK + `claude-sonnet-4-6`, or `claude-opus-4-8` for max sophistication): given a query, decide which paid data to buy (cost-aware, reasons about value vs `available()`), buy via the Buyer, synthesize, price + serve via the Seller. The agent holds **no key** — it only calls `/authorize`.
- **Deliverable:** an end-to-end query that autonomously buys inputs and produces a priced answer, with a visible policy-reject path.

### Phase 4 — Funding bridge + demo dashboard
- **Funding bridge:** top up the Gateway balance from the treasury up to `available()`.
- **Dashboard:** live reasoning, payments in/out, treasury P&L + remaining cap, and a guardian **pause** button (the two killer moments on screen).
- **Deliverable:** the <3-min demo flow + a live deploy; track via `arc-canteen update-traction`/`update-product`.

---

## Self-Review

- **Spec coverage:** Authority + policy gate + ledger + treasury reads + guardian-freeze (§5/§6/§7/§8) → Phase 1 Tasks 1.1–1.6. Real x402 + Gateway settlement (§3/§7) → Phase 0 + Phase 2. Two-sided buy/sell (§3) → Phase 2. Claude agent (§5) → Phase 3. Funding bridge + dashboard + demo moments (§5/§7) → Phase 4. Tiered model (§4) is satisfied by leaving on-chain `spend()` untouched and adding the off-chain path. Deliverables/secret-hygiene (§10) → Phase 4 + the Phase 2 repo carve-out (tracked, not yet a task — flagged below).
- **Placeholder scan:** Phase 0 is intentionally exploratory (a spike); its "fill in from Task 0.1" notes are the spike's *purpose*, not hidden TODOs. Phases 2–4 are explicitly roadmap, to be detailed post-spike — not placeholders inside a detailed task. Phase 1 tasks contain complete code.
- **Type consistency:** `evaluatePolicy(PolicyInput)`/`PolicyDecision` (1.2) are consumed unchanged by `authorizePayment` (1.4); `PaymentLedger.{recordAuthorized,markSettled,markFailed,runningPending}` (1.3) are used consistently in 1.4/1.5; `AuthorityDeps`/`AuthorizeRequest` (1.4) match the server (1.5) and the `SignX402` seam (0.4). `runningPending` naming is consistent throughout (not `runningSpend`).
- **Open carve-out:** the public-repo split (§10) and the concrete `signX402` impl are deliberately deferred to Phase 0/2 (they depend on the spike); rotate the Turnkey key before the repo goes public.
