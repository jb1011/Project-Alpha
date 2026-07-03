# BYOA P2b — Governed `pay` (x402) + `treasury_status`, and acting-tool gating

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give a linked agent the governed **spend** capability — a `pay` MCP tool that pays **x402 resource
URLs** through the existing `authorizePayment` chokepoint (caps + hybrid allowlist), signed by the per-agent
pocket — plus a `treasury_status` read so the agent can reason before spending. Also close the P2a
prerequisite by capability/entity-gating the acting tools (`fund_treasury`, `onboard_agent`).

**Architecture:** The `pay` MCP tool stays thin: it does the scope/capability/ownership checks, validates
input, then delegates to a per-entity **payment service** (`buildEntityPaymentService`) that composes the
existing pieces — the pocket signer (`derivePocketKey`), `authorizePayment` (the chokepoint:
`readTreasury` + `evaluatePolicy` + `signX402` + `ledger`), and `buyWithX402` (fetch → 402 → authorize →
re-fetch with `X-PAYMENT`) — and adds the §14.2 guards: **SSRF** URL hardening, the **§14.1 hybrid
allowlist** (allowlist off ≤ threshold, required above; the returned payee re-asserted), **idempotency**, and
input validation. This mirrors the composition already proven in `src/agent/liveRunner.ts:309-328` +
`src/agent/tools.ts`, generalized per-entity and on-demand.

**Tech Stack:** TypeScript, Hono, `@modelcontextprotocol/sdk`, viem, better-sqlite3, vitest, Biome (no build
step, tsx). Solidity untouched.

## v1 decisions (locked; flagged for plan-review)

- **D1 — pay targets = x402 URLs only** (user-confirmed). `to` must be an `https` x402 resource URL. The
  payee/amount come from the resource's 402 response and are leash-checked; the agent cannot send to an
  arbitrary wallet. **Raw-address sends are a documented fast-follow** through the same `authorizePayment`
  chokepoint (no rearchitecture).
- **D2 — acting-tool gating folded in** (user-confirmed) as Task 1.
- **D3 — no auto-top-up in v1** (⚠ confirm at plan-review). `pay` spends from the **existing pocket/Gateway
  float**; it does NOT top the pocket up per-call (that would cost ~2 Turnkey signatures each; the dev tier
  is rate-limited). The `authorizePayment` cap/policy check runs against the on-chain treasury as always; if
  the Gateway float is insufficient, the x402 settle fails and `pay` returns `{ ok:false, reason:"insufficient-float" }`.
  **JIT auto-top-up is a fast-follow.**
- **D4 — threshold is a config default in v1** (⚠ confirm at plan-review). `cfg.spendAllowlistThreshold`
  (from `SPEND_ALLOWLIST_THRESHOLD_USDC`) applies to all entities. **Per-entity guardian-set thresholds are
  a fast-follow** (matches how `perTxCap` started as a single value).
- **D5 — pay signs with the per-agent pocket key** (`derivePocketKey(masterSeed, entity.idempotencyKey)`),
  free/unlimited — NOT Turnkey. No Turnkey signatures per `pay`. (Grounded fact, mirrors liveRunner.)

## Global Constraints

- **Depends on P2a (PR #16).** Base this branch on `feat/byoa-p2a-scope` OR on `main` after #16 merges. P2a's
  `scope.ts` (`hasCapability`, `entityInScope`), `resolveKey`, `buildMcpServer(scope, deps)`, and the
  `McpToolDeps` shape MUST be present.
- **Chokepoint is inviolable (§14.2):** the ONLY path from an MCP tool to the pocket signer is via
  `authorizePayment`. No tool signs directly. A test asserts this.
- **Hybrid allowlist (§14.1):** amount ≤ `threshold` → any payee allowed (caps still apply); amount >
  `threshold` → payee must be allowlisted (`isAllowed`). The payee the 402 returned is re-asserted against
  this rule before the retry.
- **Tenant + entity isolation (§14.2) on every new tool:** re-check `ownerTenantId === tenantId` AND
  `entityInScope(scope, id)`; uniform "not found" (no oracle). Cross-tenant IDOR tests required. The Turnkey
  operator / pocket is derived from the tenant-owned entity record, NEVER from a tool arg.
- **Capability gates:** `pay` requires `hasCapability(scope, "spend")`; `fund_treasury` requires `"spend"`;
  `onboard_agent` requires `"spend"` + a tenant-wide key (`scope.entityId === null`); reads (`treasury_status`)
  need no capability gate (read is the floor). Denials return a uniform not-authorized error, indistinguishable
  from not-found where the tool takes an `id`.
- **Input validation (§14.2):** reject non-positive / non-integer `amountUsdc` at the tool boundary.
- **Idempotency (§14.2):** `pay` takes a client `idempotencyKey`; a repeat returns the original receipt,
  never a second settlement.
- **Additive / no regressions:** existing tools + tests stay green. `POST /api-keys` still mints tenant-wide
  `spend` keys, so all gates are no-ops for today's keys (verify no regression).
- **Never leak keys / secrets; stage specific files** (`git add <path>`). Gate: `npm run lint && npm run
  typecheck && npm test` from `back/backend/`.

---

## File Structure

- `src/mcp/server.ts` (**modify**) — gate `fund_treasury`/`onboard_agent` (T1); add `treasury_status` (T7)
  and `pay` (T8); `McpToolDeps` gains `payments?: EntityPaymentService` (T7).
- `src/payments/policyGate.ts` (**modify**) — add `threshold` + `over-threshold-needs-allowlist` (T2).
- `src/payments/ssrfGuard.ts` (**new**) — `assertPublicHttpsUrl` + `safeFetch` (T3).
- `src/persistence/paymentIdempotencyStore.ts` (**new**) + `src/persistence/db.ts` (**modify**, migration) — idempotency (T4).
- `src/config/env.ts` (**modify**) — `SPEND_ALLOWLIST_THRESHOLD_USDC` → `cfg.spendAllowlistThreshold` (T5).
- `src/payments/entityPayment.ts` (**new**) — `buildEntityPaymentService(cfg, adapter, deps)` → `{ status, pay }` (T6).
- `src/mcp/transport.ts` + `src/api/app.ts` (**modify**) — construct + thread the payment service (T7).

---

### Task 1: Gate the acting tools (`fund_treasury`, `onboard_agent`) — closes the P2a prerequisite

**Files:** Modify `src/mcp/server.ts`; Test `test/mcp/actingToolGates.int.test.ts`.

**Interfaces:** Consumes `hasCapability`, `entityInScope` (P2a `./scope`). No new deps.

- [ ] **Step 1: Write the failing test** — `test/mcp/actingToolGates.int.test.ts`. Mirror
  `test/mcp/tools.read.int.test.ts`'s harness (buildApiApp `as never` + `startMcpTestClient` + `apiKeys.mint`).
  Seed an entity owned by TENANT. Assert:
  - A **read** key (`apiKeys.mint(TENANT, { capability: "read" })`) calling `fund_treasury` → error text
    (not authorized); calling `onboard_agent` → error text.
  - An **entity-scoped** key (`apiKeys.mint(TENANT, { entityId: "TENANT:other", capability: "spend" })`)
    calling `fund_treasury({ id: "TENANT:agent1", amount: "1" })` → error text (entity out of scope); calling
    `onboard_agent` → error text (not tenant-wide).
  - A **tenant-wide spend** key (`apiKeys.mint(TENANT)`) still reaches `fund_treasury`/`onboard_agent` (no
    regression — reaches the runner; use the existing test's runner stubs so it returns a normal result).

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/mcp/actingToolGates.int.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/mcp/server.ts`, add the import `import { entityInScope, hasCapability }
  from "./scope";` (entityInScope already imported — add hasCapability). Inside `fund_treasury`'s handler,
  before `runner.fund`:
```ts
if (!hasCapability(scope, "spend"))
  return { content: [{ type: "text", text: "not found" }], isError: true };
if (!entityInScope(scope, id))
  return { content: [{ type: "text", text: "not found" }], isError: true };
```
  Inside `onboard_agent`'s handler, before the passkey lookup:
```ts
if (!hasCapability(scope, "spend") || scope.entityId !== null)
  return { content: [{ type: "text", text: "not authorized" }], isError: true };
```
  Update the header comment block (lines 23-30) to state the acting tools are NOW gated (remove the
  "PREREQUISITE" warning; it's resolved).

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/mcp/actingToolGates.int.test.ts` → PASS.

- [ ] **Step 5: Full gate + commit** — `npm run lint && npm run typecheck && npm test`; then
  `git add src/mcp/server.ts test/mcp/actingToolGates.int.test.ts && git commit -m "feat(mcp): capability+entity gate fund_treasury/onboard_agent (closes P2a prereq)"`

---

### Task 2: Hybrid allowlist threshold in `evaluatePolicy`

**Files:** Modify `src/payments/policyGate.ts`; Test `test/payments/policyGate.test.ts` (append).

**Interfaces:** Produces `PolicyInput.threshold?: bigint`; new reason `"over-threshold-needs-allowlist"`.

- [ ] **Step 1: Write the failing test** — append to `test/payments/policyGate.test.ts` (create if absent,
  mirroring existing evaluatePolicy tests):
```ts
import { evaluatePolicy } from "../../src/payments/policyGate";
const base = { available: 10_000_000n, paused: false, allowlistEnabled: false, isAllowed: false, runningPending: 0n };

test("hybrid: micro-payment (<= threshold) needs no allowlist", () => {
  expect(evaluatePolicy({ ...base, amount: 50_000n, threshold: 100_000n })).toEqual({ ok: true });
});
test("hybrid: above threshold requires an allowlisted payee", () => {
  expect(evaluatePolicy({ ...base, amount: 200_000n, threshold: 100_000n, isAllowed: false }))
    .toEqual({ ok: false, reason: "over-threshold-needs-allowlist" });
  expect(evaluatePolicy({ ...base, amount: 200_000n, threshold: 100_000n, isAllowed: true }))
    .toEqual({ ok: true });
});
test("no threshold set → hybrid rule inactive (back-compat)", () => {
  expect(evaluatePolicy({ ...base, amount: 999_999n })).toEqual({ ok: true });
});
test("explicit on-chain allowlist still wins for any non-allowed payee", () => {
  expect(evaluatePolicy({ ...base, amount: 1n, allowlistEnabled: true, isAllowed: false }))
    .toEqual({ ok: false, reason: "not-allowlisted" });
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/payments/policyGate.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/payments/policyGate.ts`: add `threshold?: bigint;` to `PolicyInput`
  (comment: "§14.1 hybrid: amount > threshold requires an allowlisted payee; undefined = rule off"); add
  `"over-threshold-needs-allowlist"` to `PolicyReason`; insert the rule AFTER the existing
  `allowlistEnabled && !isAllowed` check and BEFORE `perTxCap`:
```ts
  if (i.threshold !== undefined && i.amount > i.threshold && !i.isAllowed)
    return { ok: false, reason: "over-threshold-needs-allowlist" };
```

- [ ] **Step 4: Run, expect pass** → PASS.

- [ ] **Step 5: Commit** — `git add src/payments/policyGate.ts test/payments/policyGate.test.ts && git commit -m "feat(payments): §14.1 hybrid allowlist threshold in evaluatePolicy"`

---

### Task 3: SSRF guard for the `pay` URL

**Files:** Create `src/payments/ssrfGuard.ts`; Test `test/payments/ssrfGuard.test.ts`.

**Interfaces:** Produces `assertPublicHttpsUrl(raw: string): URL` (throws `SsrfError` on reject);
`safeFetch(fetchImpl: typeof fetch, raw: string, init?: RequestInit, opts?: { timeoutMs?: number }): Promise<Response>`.

- [ ] **Step 1: Write the failing test** — `test/payments/ssrfGuard.test.ts`:
```ts
import { expect, test } from "vitest";
import { assertPublicHttpsUrl, SsrfError } from "../../src/payments/ssrfGuard";

test("accepts a public https URL", () => {
  expect(assertPublicHttpsUrl("https://api.example.com/x").hostname).toBe("api.example.com");
});
test("rejects non-https", () => {
  expect(() => assertPublicHttpsUrl("http://api.example.com")).toThrow(SsrfError);
});
test("rejects loopback / private / link-local / metadata literals", () => {
  for (const u of [
    "https://127.0.0.1/x", "https://localhost/x", "https://10.0.0.5/x",
    "https://192.168.1.1/x", "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x", "https://0.0.0.0/x",
  ]) expect(() => assertPublicHttpsUrl(u), u).toThrow(SsrfError);
});
test("rejects a malformed URL", () => {
  expect(() => assertPublicHttpsUrl("not a url")).toThrow(SsrfError);
});
```

- [ ] **Step 2: Run, expect fail** → FAIL.

- [ ] **Step 3: Implement** — `src/payments/ssrfGuard.ts`:
```ts
import { lookup } from "node:dns/promises";
import net from "node:net";

export class SsrfError extends Error {}

/** True for IPv4/IPv6 literals that must never be a payment target (loopback, private, link-local,
 *  unspecified, unique-local, and the cloud metadata address). */
export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0) return true;              // loopback / private / unspecified
    if (a === 169 && b === 254) return true;                        // link-local + metadata (169.254.169.254)
    if (a === 192 && b === 168) return true;                        // private
    if (a === 172 && b >= 16 && b <= 31) return true;               // private
    return false;
  }
  if (v === 6) {
    const lo = ip.toLowerCase();
    return lo === "::1" || lo === "::" || lo.startsWith("fc") || lo.startsWith("fd") || lo.startsWith("fe80");
  }
  return false; // not an IP literal
}

/** Parse + validate a payment URL: https only, host must not be a blocked IP literal. Hostnames are
 *  additionally re-checked against their resolved IP at fetch time (see safeFetch). Throws SsrfError. */
export function assertPublicHttpsUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new SsrfError(`invalid url: ${raw}`); }
  if (u.protocol !== "https:") throw new SsrfError(`must be https: ${raw}`);
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (host === "localhost") throw new SsrfError("localhost blocked");
  if (net.isIP(host) && isBlockedIp(host)) throw new SsrfError(`blocked ip: ${host}`);
  return u;
}

/** Fetch with SSRF hardening: validate the URL, resolve the host and reject blocked IPs, forbid redirects
 *  (redirect:"manual" — an x402 resource must answer directly), and enforce a timeout. */
export async function safeFetch(
  fetchImpl: typeof fetch,
  raw: string,
  init: RequestInit = {},
  opts: { timeoutMs?: number } = {},
): Promise<Response> {
  const u = assertPublicHttpsUrl(raw);
  if (!net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) {
    const { address } = await lookup(u.hostname);       // resolve hostname → reject if it maps to a blocked IP
    if (isBlockedIp(address)) throw new SsrfError(`host ${u.hostname} resolves to blocked ${address}`);
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetchImpl(u.toString(), { ...init, redirect: "manual", signal: ctrl.signal });
    if (res.status >= 300 && res.status < 400) throw new SsrfError("redirects are not allowed");
    return res;
  } finally {
    clearTimeout(t);
  }
}
```

- [ ] **Step 4: Run, expect pass** → PASS. (The `assertPublicHttpsUrl` tests are unit; `safeFetch`'s DNS path
  is covered indirectly in T6 with a fake `fetchImpl` — do not hit the network in unit tests.)

- [ ] **Step 5: Commit** — `git add src/payments/ssrfGuard.ts test/payments/ssrfGuard.test.ts && git commit -m "feat(payments): SSRF guard for pay URLs (https-only, block private/metadata, no redirects, timeout)"`

---

### Task 4: Payment idempotency store

**Files:** Create `src/persistence/paymentIdempotencyStore.ts`; Modify `src/persistence/db.ts` (migration);
Test `test/persistence/paymentIdempotencyStore.test.ts`.

**Interfaces:** Produces `PaymentReceipt = { ok: boolean; txOrTransferId: string | null; reason?: string }`;
`SqlitePaymentIdempotencyStore` with `begin(key, tenantId, entityKey): { status: "new" } | { status: "replayed"; receipt: PaymentReceipt }` and `complete(key, receipt: PaymentReceipt): void`.

- [ ] **Step 1: Write the failing test** — `test/persistence/paymentIdempotencyStore.test.ts`:
```ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqlitePaymentIdempotencyStore } from "../../src/persistence/paymentIdempotencyStore";

function store() { const db = new Database(":memory:"); migrate(db); return new SqlitePaymentIdempotencyStore(db); }

test("first begin is new; complete then re-begin replays the receipt", () => {
  const s = store();
  expect(s.begin("k1", "tA", "tA:e1")).toEqual({ status: "new" });
  const r = { ok: true, txOrTransferId: "0xabc" };
  s.complete("k1", r);
  expect(s.begin("k1", "tA", "tA:e1")).toEqual({ status: "replayed", receipt: r });
});
test("same key under a different tenant/entity is a distinct payment", () => {
  const s = store();
  s.begin("k1", "tA", "tA:e1"); s.complete("k1", { ok: true, txOrTransferId: "0x1" });
  expect(s.begin("k1", "tB", "tB:e1")).toEqual({ status: "new" }); // scoped by (key,tenant,entity)
});
```

- [ ] **Step 2: Run, expect fail** → FAIL.

- [ ] **Step 3: Implement** — in `src/persistence/db.ts`'s `migrate`, add (idempotent CREATE):
```sql
CREATE TABLE IF NOT EXISTS payment_idempotency (
  idem_key TEXT NOT NULL, tenant_id TEXT NOT NULL, entity_key TEXT NOT NULL,
  receipt_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (idem_key, tenant_id, entity_key)
);
```
  Then `src/persistence/paymentIdempotencyStore.ts`:
```ts
import type Database from "better-sqlite3";

export interface PaymentReceipt { ok: boolean; txOrTransferId: string | null; reason?: string }

export class SqlitePaymentIdempotencyStore {
  constructor(private db: Database.Database) {}

  /** Atomically claim (key,tenant,entity). "new" = caller must proceed then call complete(); "replayed" =
   *  a completed receipt already exists (return it, do NOT settle again). A claimed-but-not-completed row
   *  (receipt_json null) also replays as a benign in-flight duplicate with a null receipt. */
  begin(key: string, tenantId: string, entityKey: string): { status: "new" } | { status: "replayed"; receipt: PaymentReceipt } {
    const existing = this.db
      .prepare("SELECT receipt_json FROM payment_idempotency WHERE idem_key=? AND tenant_id=? AND entity_key=?")
      .get(key, tenantId, entityKey) as { receipt_json: string | null } | undefined;
    if (existing) {
      const receipt = existing.receipt_json
        ? (JSON.parse(existing.receipt_json) as PaymentReceipt)
        : { ok: false, txOrTransferId: null, reason: "in-flight-duplicate" };
      return { status: "replayed", receipt };
    }
    this.db
      .prepare("INSERT INTO payment_idempotency (idem_key, tenant_id, entity_key, receipt_json) VALUES (?,?,?,NULL)")
      .run(key, tenantId, entityKey);
    return { status: "new" };
  }

  complete(key: string, receipt: PaymentReceipt): void {
    this.db
      .prepare("UPDATE payment_idempotency SET receipt_json=? WHERE idem_key=? AND receipt_json IS NULL AND tenant_id IN (SELECT tenant_id FROM payment_idempotency WHERE idem_key=?)")
      .run(JSON.stringify(receipt), key, key);
  }
}
```
  (Keep `complete` simple: it sets the receipt for the not-yet-completed row of that key. If the store is
  used per-(tenant,entity) call this is unambiguous.)

- [ ] **Step 4: Run, expect pass** → PASS.

- [ ] **Step 5: Commit** — `git add src/persistence/paymentIdempotencyStore.ts src/persistence/db.ts test/persistence/paymentIdempotencyStore.test.ts && git commit -m "feat(persistence): payment idempotency store (payment_idempotency table)"`

---

### Task 5: Config — spend allowlist threshold

**Files:** Modify `src/config/env.ts`; Test `test/config/*` (append a small case, mirroring `pocketKey.test.ts`).

**Interfaces:** Produces `cfg.spendAllowlistThreshold: bigint` (atomic USDC; from `SPEND_ALLOWLIST_THRESHOLD_USDC`,
default e.g. `"1"` = 1 USDC → `1_000_000n`).

- [ ] **Step 1: Write the failing test** — a test asserting `loadConfig()` (with the env var set to `"2.5"`)
  yields `spendAllowlistThreshold === 2_500_000n`, and the default (unset) is `1_000_000n`. Follow the
  existing env-test pattern (`usdToUnits` is already used for USDC→atomic conversion — reuse it).

- [ ] **Step 2: Run, expect fail** → FAIL.

- [ ] **Step 3: Implement** — in `src/config/env.ts`, parse `SPEND_ALLOWLIST_THRESHOLD_USDC` (default `"1"`)
  via the same USDC→atomic helper used for other USDC configs, expose as `spendAllowlistThreshold: bigint`.

- [ ] **Step 4: Run, expect pass** → PASS.

- [ ] **Step 5: Commit** — `git add src/config/env.ts test/config/... && git commit -m "feat(config): SPEND_ALLOWLIST_THRESHOLD_USDC (§14.1 hybrid threshold)"`

---

### Task 6: Per-entity payment service (`buildEntityPaymentService`)

**Files:** Create `src/payments/entityPayment.ts`; Test `test/payments/entityPayment.test.ts`.

**Interfaces:**
- Consumes: `derivePocketKey` (`../adapters/x402/pocketDerivation`), `makeSignX402` (`../adapters/x402/signX402`),
  `pocketSignerFromKey`/`arcBatchingConfig` (`../adapters/x402/pocket`), `authorizePayment` +
  `TreasuryState` (`./authority`), `evaluatePolicy` threshold (T2), `buyWithX402` (`./buyer`),
  `assertPublicHttpsUrl`/`safeFetch` (`./ssrfGuard`, T3), `PaymentLedger` (`./ledger`), `EntityRecord`
  (`../types`), a treasury-reader with `treasuryAvailable/treasuryPaused/treasuryAllowlistEnabled/treasuryIsAllowed`
  (the `ArcAdapter` surface — declare a minimal `TreasuryReader` interface so tests use a fake).
- Produces: `buildEntityPaymentService(cfg, reader, ledger): EntityPaymentService` where
  `EntityPaymentService = { status(entity: EntityRecord): Promise<TreasuryStatusView>; pay(entity: EntityRecord, args: { url: string; amountUsdc: bigint }): Promise<PaymentReceipt> }`.
  `TreasuryStatusView = { available: string; cap: string; paused: boolean; allowlistEnabled: boolean }`.

- [ ] **Step 1: Write the failing test** — `test/payments/entityPayment.test.ts`. Build a **fake reader**
  (returns scripted `available/paused/allowlistEnabled/isAllowed`) and a **fake fetchImpl** simulating an
  x402 server: first call returns `402` with `{ accepts: [{ payTo, maxAmountRequired, asset, network, maxTimeoutSeconds }] }`;
  the retry (with `X-PAYMENT`) returns `200`. Provide a real `PaymentLedger(new Database(":memory:"))` and a
  cfg literal with a test `pocketMasterSeed`, `chainId`, `spendAllowlistThreshold`. Seed an `EntityRecord`
  (mirror `test/api/jobs.routes.test.ts:86` shape) with a `treasury` + `idempotencyKey`. Assert:
  - **happy path:** `pay(entity, { url, amountUsdc: <micro> })` → `{ ok: true, txOrTransferId: <non-null> }`;
    the fake fetch was called twice (402 then 200) and the 2nd carried an `X-PAYMENT` header.
  - **policy denial surfaces the reason:** with the reader reporting `available` below the amount, `pay` →
    `{ ok: false, reason: "over-cap" }` and the retry fetch was NOT made.
  - **hybrid re-assert:** amount > threshold with `isAllowed:false` → `{ ok:false, reason:"over-threshold-needs-allowlist" }`.
  - **SSRF:** `pay(entity, { url: "http://127.0.0.1/x", ... })` → `{ ok:false, reason:/ssrf|https|blocked/ }`
    (no fetch made).
  - **payee re-assertion:** the `payTo` the 402 returns is what gets policy-checked (assert the fake reader's
    `isAllowed` was consulted for THAT payee).

- [ ] **Step 2: Run, expect fail** → FAIL.

- [ ] **Step 3: Implement** — `src/payments/entityPayment.ts`. Compose per call (mirroring
  `liveRunner.ts:309-328`), keyed off the passed `entity`:
```ts
// Pseudocode-precise structure (fill imports/types):
export interface TreasuryReader {
  treasuryAvailable(t: Address): Promise<bigint>;
  treasuryPaused(t: Address): Promise<boolean>;
  treasuryAllowlistEnabled(t: Address): Promise<boolean>;
  treasuryIsAllowed(t: Address, who: Address): Promise<boolean>;
}
export function buildEntityPaymentService(cfg: Config, reader: TreasuryReader, ledger: PaymentLedger): EntityPaymentService {
  const buildAuthorize = (entity: EntityRecord) => {
    const treasury = entity.treasury as Address;
    const pocketKey = derivePocketKey(requireMasterSeed(cfg), entity.idempotencyKey);
    const signX402 = makeSignX402({ signer: pocketSignerFromKey(pocketKey), chainId: cfg.chainId,
      network: arcBatchingConfig.network, verifyingContract: arcBatchingConfig.verifyingContract });
    const authorityDeps = {
      ledger,
      readTreasury: async (payee: Address): Promise<TreasuryState> => ({
        available: await reader.treasuryAvailable(treasury),
        paused: await reader.treasuryPaused(treasury),
        allowlistEnabled: await reader.treasuryAllowlistEnabled(treasury),
        isAllowed: await reader.treasuryIsAllowed(treasury, payee),
      }),
      signX402: async (req) => signX402({ payTo: req.payee, amount: req.amount, asset: req.asset,
        network: req.network, maxTimeoutSeconds: req.maxTimeoutSeconds }),
      perTxCap: entity.perTxCap ?? undefined,
      threshold: cfg.spendAllowlistThreshold,   // §14.1 — passed through to evaluatePolicy via authority
    };
    return (req) => authorizePayment(authorityDeps, req);
  };
  return {
    async status(entity) { /* read the 4 treasury fields + entity cap → TreasuryStatusView (strings) */ },
    async pay(entity, { url, amountUsdc }) {
      try { assertPublicHttpsUrl(url); } catch (e) { return { ok:false, txOrTransferId:null, reason:`ssrf: ${(e as Error).message}` }; }
      const authorize = buildAuthorize(entity);
      try {
        const res = await buyWithX402({ fetchImpl: (u, i) => safeFetch(fetch, u as string, i), authorize }, url);
        if (res.status !== 200) return { ok:false, txOrTransferId:null, reason:`resource-${res.status}` };
        // recover a settle/transfer id if the resource surfaced one; else the authorize ledgerRef
        return { ok:true, txOrTransferId: <transfer id or ledgerRef> };
      } catch (e) {
        const m = (e as Error).message;
        const reason = m.startsWith("policy-denied:") ? m.slice("policy-denied:".length).trim() : m;
        return { ok:false, txOrTransferId:null, reason };
      }
    },
  };
}
```
  **IMPORTANT:** `authorizePayment`/`AuthorityDeps` (`src/payments/authority.ts`) does NOT currently forward a
  `threshold` into `evaluatePolicy`. Add `threshold?: bigint` to `AuthorityDeps` and pass it into the
  `evaluatePolicy({...})` call in `authorizePayment` (one-line each). Keep this change minimal and covered by
  a focused authority test (`test/payments/authority.test.ts`, append): a request above `threshold` with a
  non-allowlisted payee returns `{ ok:false, reason:"over-threshold-needs-allowlist" }` and never calls
  `signX402`.

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/payments/entityPayment.test.ts test/payments/authority.test.ts` → PASS.

- [ ] **Step 5: Full gate + commit** — `git add src/payments/entityPayment.ts src/payments/authority.ts test/payments/entityPayment.test.ts test/payments/authority.test.ts && git commit -m "feat(payments): per-entity payment service (pocket-signed x402 via the authorize chokepoint + SSRF + hybrid)"`

---

### Task 7: Wire the payment service into MCP deps + add `treasury_status`

**Files:** Modify `src/mcp/server.ts`, `src/mcp/transport.ts`, `src/api/app.ts`; Test
`test/mcp/treasuryStatus.int.test.ts`.

**Interfaces:** `McpToolDeps` gains `payments?: EntityPaymentService` (optional so existing tests without it
still build; the read/pay tools error cleanly if absent). `ApiDeps` gains the constructed `payments` +
whatever it needs (an `ArcAdapter` built from cfg like `liveRunner`, a `PaymentLedger`, the idempotency
store). `treasury_status(id)` returns the `TreasuryStatusView`.

- [ ] **Step 1: Write the failing test** — `test/mcp/treasuryStatus.int.test.ts`. Harness like
  `tools.read.int.test.ts` but pass a `payments` stub in the `buildApiApp` deps (a fake
  `EntityPaymentService` whose `status()` returns a fixed view). Seed an entity owned by TENANT. Assert:
  - tenant-wide key: `treasury_status("TENANT:agent1")` → the view JSON.
  - cross-tenant / unknown id → uniform "not found".
  - entity-scoped key to a different entity → "not found" (entityInScope).

- [ ] **Step 2: Run, expect fail** → FAIL.

- [ ] **Step 3: Implement**
  - `src/mcp/server.ts`: add `payments?: EntityPaymentService` to `McpToolDeps`; register `treasury_status`:
```ts
server.registerTool("treasury_status",
  { title: "Treasury status", description: "Available balance, cap, paused, allowlist for one of your entities.",
    inputSchema: { id: z.string() } },
  async ({ id }) => {
    const rec = repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
      return { content: [{ type: "text", text: "entity not found" }], isError: true };
    if (!deps.payments) return { content: [{ type: "text", text: "payments unavailable" }], isError: true };
    const view = await deps.payments.status(rec);
    return { content: [{ type: "text", text: JSON.stringify(view) }] };
  });
```
  - `src/mcp/transport.ts`: pass `payments: deps.payments` into `buildMcpServer(scope, {...})`.
  - `src/api/app.ts`: construct the `EntityPaymentService` (build an `ArcAdapter` from cfg as `liveRunner`
    does — publicClient + factory/registry addrs; a `PaymentLedger(db)`; the idempotency store) and add it to
    the deps object threaded to `mountMcpRoute`. Add the needed config fields to `ApiDeps`. Guard: if the cfg
    lacks `pocketMasterSeed`/rpc, leave `payments` undefined (the tools then return "payments unavailable" —
    keeps non-payment deployments working).

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/mcp/treasuryStatus.int.test.ts` + the full MCP suite → PASS.

- [ ] **Step 5: Full gate + commit** — `git add src/mcp/server.ts src/mcp/transport.ts src/api/app.ts test/mcp/treasuryStatus.int.test.ts && git commit -m "feat(mcp): treasury_status read + wire the payment service through app/transport"`

---

### Task 8: The `pay` MCP tool

**Files:** Modify `src/mcp/server.ts`; Test `test/mcp/pay.int.test.ts`.

**Interfaces:** Consumes `deps.payments` (T7), `hasCapability`/`entityInScope` (P2a), the idempotency store
(via `deps.payments` or a `deps.paymentIdempotency` — thread whichever T7 chose; prefer folding idempotency
into the payment service so the tool stays thin). Tool `pay({ id, to, amountUsdc, idempotencyKey })` →
`{ ok, txOrTransferId, reason? }`.

- [ ] **Step 1: Write the failing test** — `test/mcp/pay.int.test.ts`. Harness like `tools.read.int.test.ts`
  with a **fake `EntityPaymentService`** whose `pay()` records its args and returns a scripted receipt.
  Assert:
  - **capability:** a `read` key → `pay` returns not-authorized/not-found; a `spend` key proceeds.
  - **entity scope + tenant:** cross-tenant id and entity-scoped-to-other-entity → uniform "not found"; the
    fake `pay` is NEVER called for a denied request (proves no shortcut past the gate).
  - **input validation:** `amountUsdc: "0"` / `"-1"` / `"1.5"` / `"abc"` → error, `pay` not called.
  - **happy path:** valid `spend` key + owned entity + `amountUsdc:"100000"` + a url → the fake `pay` is
    called with `{ url, amountUsdc: 100000n }` for the RESOLVED entity record (never an id-arg-derived
    operator), and the tool returns the receipt JSON.
  - **idempotency:** two calls with the same `idempotencyKey` → the second returns the first receipt without a
    second underlying settle (assert the fake settle/pay ran once). (If idempotency lives in the service,
    assert via the service double; if in the tool, assert the store.)
  - **chokepoint assertion (§14.2):** a test (here or in `entityPayment.test.ts`) proving the tool has no path
    to a signer except through `deps.payments.pay` → `authorizePayment`. At minimum assert `server.ts`
    imports no signer/`makeSignX402` directly.

- [ ] **Step 2: Run, expect fail** → FAIL.

- [ ] **Step 3: Implement** — register `pay` in `src/mcp/server.ts`:
```ts
server.registerTool("pay",
  { title: "Pay", description: "Pay an x402 resource URL with USDC (atomic, 6 decimals), within your treasury's leash.",
    inputSchema: { id: z.string(), to: z.string(), amountUsdc: z.string(), idempotencyKey: z.string() } },
  async ({ id, to, amountUsdc, idempotencyKey }) => {
    if (!hasCapability(scope, "spend"))
      return { content: [{ type: "text", text: "not found" }], isError: true };
    const rec = repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
      return { content: [{ type: "text", text: "not found" }], isError: true };
    let amount: bigint;
    try { amount = BigInt(amountUsdc); } catch { return { content: [{ type:"text", text:"invalid amountUsdc" }], isError:true }; }
    if (amount <= 0n) return { content: [{ type:"text", text:"amountUsdc must be positive" }], isError:true };
    if (!deps.payments) return { content: [{ type:"text", text:"payments unavailable" }], isError:true };
    const receipt = await deps.payments.pay(rec, { url: to, amountUsdc: amount, idempotencyKey, tenantId });
    return { content: [{ type: "text", text: JSON.stringify(receipt) }], isError: !receipt.ok };
  });
```
  (Fold idempotency into `deps.payments.pay` — extend its args with `{ idempotencyKey, tenantId }` and have
  the service call `begin`/`complete` around the settle. Keep the MCP tool thin. Update T6's service +
  test accordingly if idempotency wasn't already wired there; if so, add a T6 follow-on step rather than
  duplicating logic in the tool.)
  - `BigInt("1.5")`/`BigInt("abc")` throw → caught as "invalid amountUsdc"; `BigInt("0")`→0n rejected. ✓

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/mcp/pay.int.test.ts` + full MCP suite → PASS.

- [ ] **Step 5: Full gate + commit** — `git add src/mcp/server.ts test/mcp/pay.int.test.ts && git commit -m "feat(mcp): governed pay tool (x402 URLs, spend-gated, SSRF+hybrid+idempotent via the chokepoint)"`

---

## After this slice

P2b makes the agent **spend** within its leash. **P2c** adds `run_job` (earn, ERC-8183; requires
`hasCapability(scope, "earn")`; reuses this plan's scope/ownership pattern). Documented fast-follows from the
v1 decisions: **raw-address `pay`** (D1), **JIT pocket auto-top-up** (D3), **per-entity guardian-set
thresholds** (D4), and the §14.3 hardening items (guardian alerting/auto-pause, payload-scoped Turnkey
policy, manager/operator key separation).

## Self-Review

**Spec coverage:** §4.2 `pay` (URL-only per D1) → T3/T6/T8; §4.3 `treasury_status` → T7; §14.1 hybrid → T2/T5/T6;
§14.2 SSRF → T3, idempotency → T4/T8, tenant+entity isolation → T1/T7/T8, input validation → T8, chokepoint
assertion → T8, capability gating (incl. the P2a acting-tool prereq) → T1/T8. ✓
**Placeholders:** T6/T8 give precise structure with a few clearly-marked "fill the transfer-id/status
projection" spots that name exactly what to compute — real instructions, not TBDs; the pure/isolated tasks
(T2/T3/T4) are complete code. When executing, resolve the T6/T8 idempotency-placement note (fold into the
service) before writing tests so they assert the final contract. ✓
**Type consistency:** `PaymentReceipt` (T4) is the `pay` return across T6/T8; `EntityPaymentService`
{`status`,`pay`} consistent T6→T7→T8; `TreasuryState`/`AuthorityDeps.threshold` consistent T2/T6;
`hasCapability`/`entityInScope` from P2a used identically in T1/T7/T8. ✓
**Decisions flagged for plan-review:** D3 (no auto-top-up) and D4 (config-level threshold) are the two the
user should confirm before execution. ✓
