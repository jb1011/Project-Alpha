# Backend Rules & Reputation Endpoints — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Build the small backend endpoints + enforcement the frontend roadmap needs to surface
governance and the agent's track record — without touching any frontend.

**Architecture:** Additive. Three tenant-scoped JWT routes mounted alongside the existing
`/entities/:id/*` routes, plus one off-chain policy check in the Payment Authority. The cap/period
change is **manager-signed** (platform key, via `ArcAdapter`); the per-tx cap is an **off-chain**
Authority policy stored on the entity. Reputation is a **local aggregate** of the agent's jobs.

**Tech Stack:** TypeScript, Hono, better-sqlite3, viem, vitest, Biome. No build step (tsx). Arc
testnet, `AgentTreasury` contract (`agentTreasuryAbi`), tenant-scoped auth via `requireAuth(jwt)`.

## Global Constraints

- **Branch:** `feat/backend-rules-and-reputation` (stacked on `feat/agent-activity-feed`/PR #7).
- **Tenant scoping (mandatory):** every route resolves the entity via `deps.repo.findByIdempotencyKey(id)`
  and returns `ApiError("not_found", 404, "entity not found")` if missing OR
  `rec.ownerTenantId !== c.get("tenantId")` — identical to `src/api/routes/treasury.ts`.
- **USDC is atomic 6-decimal** everywhere on the wire (strings). Use `usdToUnits`/`formatUnits` for
  conversions, never hand-rolled math.
- **Auth:** all new routes live under the existing `app.use("/entities/*", requireAuth(...))` guard.
- **Manager signing:** policy changes use `ArcAdapter`'s `managerWallet` (the platform key) — the
  same wallet that signs `createEntity`. The user's wallet is the guardian, NOT the manager.
- **Out of frontend scope:** the **allowlist fix is frontend-only** (set the existing `allowlistEnabled`
  spec field + guardian `setAllowlistEntry` wagmi); **no backend task** here.
- **Lint/typecheck/tests must stay green:** `npm run lint && npm run typecheck && npm test`.

---

### Task 1: Reputation read route — `GET /entities/:id/reputation`

The ERC-8004 reputation registry exposes no on-chain read; our job saga already persists each job
(`status` reaches `"reputed"`). So reputation = a **local aggregate of the agent's jobs**.

**Files:**
- Create: `src/api/routes/reputation.ts`
- Modify: `src/api/app.ts` (mount, after `mountJobRoutes`)
- Test: `test/api/reputation.routes.test.ts`

**Interfaces:**
- Consumes: `deps.repo.findByIdempotencyKey`, `deps.jobs` (the existing `JobStore` already in `ApiDeps`
  for the jobs routes — confirm its list/by-entity method name in `src/api/routes/jobs.ts`), `requireAuth`, `ApiError`.
- Produces: `GET /entities/:id/runs`-style route → `200 { reputation: { totalJobs, completed, reputed } }`.

- [ ] **Step 1: Read `src/api/routes/jobs.ts`** to learn the exact `deps.jobs` method that lists an
  entity's jobs (used by `GET /entities/:id/jobs`) and the job record's `status` field values. Use
  that same method here. (Do not add a new store method if one already lists by entity.)

- [ ] **Step 2: Write the failing test** `test/api/reputation.routes.test.ts` — mirror the harness in
  `test/api/runs.routes.test.ts` (copy its `account`/`otherAccount`/`login`/`beforeEach`/`makeApp`/
  `seedBound`). Seed a bound entity, seed 2 jobs for it (one `status:"reputed"`, one `status:"completed"`),
  then:

```ts
test("GET /entities/:id/reputation → 200 with the agent's job track record", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "a1");
  // seed jobs for `id` via the same JobStore the app uses (see Step 1 for the method + fields)
  seedJob(id, "reputed");
  seedJob(id, "completed");
  const res = await app.request(`/entities/${encodeURIComponent(id)}/reputation`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.reputation).toMatchObject({ totalJobs: 2, reputed: 1 });
});

test("cross-tenant → 404", async () => {
  const app = makeApp();
  await login(app);
  seedBound(account.address, "a1");
  const other = await login(app, otherAccount);
  const res = await app.request(`/entities/${encodeURIComponent(`${account.address}:a1`)}/reputation`, {
    headers: { authorization: `Bearer ${other}` },
  });
  expect(res.status).toBe(404);
});

test("no auth → 401", async () => {
  expect((await makeApp().request("/entities/x/reputation")).status).toBe(401);
});
```

- [ ] **Step 3: Run, expect fail** — `npx vitest run test/api/reputation.routes.test.ts` → FAIL.

- [ ] **Step 4: Implement** `src/api/routes/reputation.ts` (mirror `treasury.ts`'s guard; aggregate
  from the jobs the entity owns — adapt `listEntityJobs` to the real method name from Step 1):

```ts
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

/** The agent's track record: a local aggregate of its ERC-8183 jobs (the registry has no on-chain read). */
export function mountReputationRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/entities/:id/reputation", (c) => {
    const id = c.req.param("id");
    const rec = deps.repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    const jobs = deps.jobs.listByEntity(id); // ← use the real method name from Step 1
    const totalJobs = jobs.length;
    const reputed = jobs.filter((j) => j.status === "reputed").length;
    const completed = jobs.filter((j) => j.status === "completed" || j.status === "reputed").length;
    return c.json({ reputation: { totalJobs, completed, reputed } });
  });
}
```

- [ ] **Step 5: Mount** in `src/api/app.ts` after `mountJobRoutes(app, deps);`:

```ts
  mountReputationRoutes(app, deps);
```
Add: `import { mountReputationRoutes } from "./routes/reputation";`

- [ ] **Step 6: Run + lint + typecheck + full suite** — `npx vitest run test/api/reputation.routes.test.ts && npm run lint && npm run typecheck && npm test` → all PASS.

- [ ] **Step 7: Commit** — `git add src/api/routes/reputation.ts src/api/app.ts test/api/reputation.routes.test.ts && git commit -m "feat(api): GET /entities/:id/reputation (job track record)"`

---

### Task 2: `ArcAdapter` policy methods (manager-signed) + `POST /entities/:id/policy`

Lets the frontend schedule a cap/period change (manager-signed; timelocked on-chain) and execute it
after the delay. `schedulePolicyUpdate`/`executePolicyUpdate` don't exist in the adapter yet.

**Files:**
- Modify: `src/adapters/arc/arcAdapter.ts` (add two manager-signed methods near `createEntity`)
- Create: `src/api/routes/policy.ts`
- Modify: `src/api/app.ts` (mount), `src/api/main.ts` (no new dep — `arc` is already in `ApiDeps`)
- Test: `test/adapters/arc/arcAdapter.policy.test.ts` (unit, mocked wallet) + `test/api/policy.routes.test.ts`

**Interfaces:**
- Consumes: `agentTreasuryAbi`, `ArcAdapter` manager wallet, `requireAuth`, `ApiError`, `usdToUnits`,
  `parseDuration` (from `src/policy/units`).
- Produces: `ArcAdapter.schedulePolicyUpdate(treasury, {newCap, newPeriod, allowlistOn, newPayout}) → Hex`,
  `ArcAdapter.executePolicyUpdate(treasury, policyId) → Hex`; routes
  `POST /entities/:id/policy` (schedule) and `POST /entities/:id/policy/execute` (execute).

- [ ] **Step 1: Read** `src/adapters/arc/arcAdapter.ts` `createEntity`/`fundOperator` to copy the exact
  manager-signed write pattern (`this.d.managerWallet`, `simulateContract` + `writeContract` +
  `waitForTransactionReceipt`), and `treasury.ts`/`runs.ts` for the route guard pattern.

- [ ] **Step 2: Write the failing adapter test** `test/adapters/arc/arcAdapter.policy.test.ts` — assert
  `schedulePolicyUpdate` simulates `functionName: "schedulePolicyUpdate"` with
  `args: [newCap, newPeriod, allowlistOn, newPayout]` against `agentTreasuryAbi` (mock `publicClient.simulateContract`
  to capture args + return a `{request}`; mock `managerWallet.writeContract` to return a hash). Mirror an
  existing adapter unit test if one exists.

- [ ] **Step 3: Run, expect fail.**

- [ ] **Step 4: Implement** the two methods in `ArcAdapter` (near `createEntity`):

```ts
  /** Schedule a treasury policy change (manager-gated, timelocked). Returns the on-chain tx hash. */
  async schedulePolicyUpdate(
    treasury: Address,
    p: { newCap: bigint; newPeriod: bigint; allowlistOn: boolean; newPayout: Address },
  ): Promise<Hex> {
    const { request } = await this.d.publicClient.simulateContract({
      account: this.d.managerWallet.account ?? undefined,
      address: treasury,
      abi: agentTreasuryAbi,
      functionName: "schedulePolicyUpdate",
      args: [p.newCap, p.newPeriod, p.allowlistOn, p.newPayout],
    });
    const hash = await this.d.managerWallet.writeContract(request);
    await this.d.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Execute a previously-scheduled policy change once its timelock has elapsed (manager-gated). */
  async executePolicyUpdate(treasury: Address, policyId: Hex): Promise<Hex> {
    const { request } = await this.d.publicClient.simulateContract({
      account: this.d.managerWallet.account ?? undefined,
      address: treasury,
      abi: agentTreasuryAbi,
      functionName: "executePolicyUpdate",
      args: [policyId],
    });
    const hash = await this.d.managerWallet.writeContract(request);
    await this.d.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }
```

- [ ] **Step 5: Run adapter test, expect pass.**

- [ ] **Step 6: Write the failing route test** `test/api/policy.routes.test.ts` — mirror the
  `treasury.routes.test.ts` harness; build the app with a **stub `arc`** whose `schedulePolicyUpdate`/
  `executePolicyUpdate` return a fake hash and capture args. Assert: `POST /entities/:id/policy` with
  `{ capUsdc: "200.00", periodSeconds: 86400, allowlistOn: false, payoutAddress }` → 200
  `{ txHash }` and the stub received `newCap = usdToUnits("200.00")`, `newPeriod = 86400n`; cross-tenant → 404;
  no auth → 401; invalid body (bad cap) → 400 (Zod).

- [ ] **Step 7: Run, expect fail.**

- [ ] **Step 8: Implement** `src/api/routes/policy.ts` (guard like `treasury.ts`; the treasury address
  comes from `rec.treasury`; validate the body with Zod):

```ts
import type { Hono } from "hono";
import { z } from "zod";
import type { AuthVars } from "../../auth/middleware";
import type { Address } from "../../types";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";
import { usdToUnits } from "../../policy/units";

const ScheduleBody = z.object({
  capUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  periodSeconds: z.coerce.number().int().positive(),
  allowlistOn: z.boolean(),
  payoutAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

/** Manager-signed treasury policy changes (cap/period). Guardian actions stay client-side (wagmi). */
export function mountPolicyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  function ownedTreasury(c: Parameters<Parameters<typeof app.get>[1]>[0]): Address {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    if (!rec.treasury) throw new ApiError("not_ready", 409, "treasury not deployed yet");
    return rec.treasury as Address;
  }

  app.post("/entities/:id/policy", async (c) => {
    const treasury = ownedTreasury(c);
    const b = ScheduleBody.parse(await c.req.json());
    const txHash = await deps.arc.schedulePolicyUpdate(treasury, {
      newCap: usdToUnits(b.capUsdc),
      newPeriod: BigInt(b.periodSeconds),
      allowlistOn: b.allowlistOn,
      newPayout: b.payoutAddress as Address,
    });
    return c.json({ txHash });
  });

  app.post("/entities/:id/policy/execute", async (c) => {
    const treasury = ownedTreasury(c);
    const { policyId } = z.object({ policyId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) }).parse(await c.req.json());
    const txHash = await deps.arc.executePolicyUpdate(treasury, policyId as `0x${string}`);
    return c.json({ txHash });
  });
}
```

- [ ] **Step 9: Mount** in `src/api/app.ts` after the treasury route: `mountPolicyRoutes(app, deps);`
  + `import { mountPolicyRoutes } from "./routes/policy";`. (No `main.ts` change — `arc` is already in `ApiDeps`.)

- [ ] **Step 10: Run + lint + typecheck + full suite** → PASS.

- [ ] **Step 11: Commit** — `git add src/adapters/arc/arcAdapter.ts src/api/routes/policy.ts src/api/app.ts test/adapters/arc/arcAdapter.policy.test.ts test/api/policy.routes.test.ts && git commit -m "feat(api): manager-signed treasury policy schedule/execute + ArcAdapter methods"`

---

### Task 3: Per-tx cap — spec field, storage, and Payment Authority enforcement

A real per-transaction cap, enforced **off-chain** in the Authority (no contract change). Stored on
the entity; the on-chain per-period cap remains the hard guardrail.

**Files:**
- Modify: `src/policy/agentSpec.ts` (add `perTxCapUsdc`), `src/types.ts` (`EntityRecord.perTxCap`),
  `src/persistence/db.ts` (add `per_tx_cap` column), `src/persistence/entityRepository.ts` (read/write it),
  `src/workflow/onboarding.ts` (persist it from the spec at create), `src/payments/policyGate.ts`
  (`PolicyInput.perTxCap` + `over-tx-cap`), `src/payments/authority.ts` (`AuthorityDeps.perTxCap` → pass through),
  `src/agent/liveRunner.ts` (load the entity's `perTxCap` into `authorityDeps`)
- Test: `test/payments/policyGate.test.ts` (append), `test/persistence/entityRepository.test.ts` (append)

**Interfaces:**
- Consumes: `usdToUnits`, `EntityRecord`, `findByTreasury`.
- Produces: `EntityRecord.perTxCap: bigint | null`; `evaluatePolicy` rejects `amount > perTxCap` with
  reason `"over-tx-cap"`.

- [ ] **Step 1: Write the failing policyGate test** — append to `test/payments/policyGate.test.ts`:

```ts
test("evaluatePolicy: rejects a single payment over the per-tx cap", () => {
  const base = { available: 1_000_000n, paused: false, allowlistEnabled: false, isAllowed: true, runningPending: 0n };
  expect(evaluatePolicy({ ...base, amount: 30_000n, perTxCap: 20_000n })).toEqual({ ok: false, reason: "over-tx-cap" });
  expect(evaluatePolicy({ ...base, amount: 10_000n, perTxCap: 20_000n })).toEqual({ ok: true });
  expect(evaluatePolicy({ ...base, amount: 30_000n })).toEqual({ ok: true }); // no cap set → allowed
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** in `src/payments/policyGate.ts` — add `perTxCap?: bigint` to `PolicyInput`,
  add `"over-tx-cap"` to `PolicyReason`, and insert the check after the zero-amount check (before over-cap):

```ts
  if (i.perTxCap !== undefined && i.amount > i.perTxCap) return { ok: false, reason: "over-tx-cap" };
```

- [ ] **Step 4: Run policyGate test, expect pass.**

- [ ] **Step 5: Thread `perTxCap` through the Authority** — in `src/payments/authority.ts` add an
  optional `perTxCap?: bigint` to `AuthorityDeps`, and pass `perTxCap: d.perTxCap` into the
  `evaluatePolicy({...})` call.

- [ ] **Step 6: Persist the field.** Add `per_tx_cap TEXT` to the `entities` table in
  `src/persistence/db.ts` (nullable; additive migration); add `perTxCap: bigint | null` to `EntityRecord`
  in `src/types.ts`; in `src/persistence/entityRepository.ts` read it (`r.per_tx_cap ? BigInt(r.per_tx_cap) : null`)
  and write it (`@per_tx_cap` as `rec.perTxCap?.toString() ?? null`) in `toRecord`/`upsert` (mirror an
  existing nullable bigint-ish column). Append a round-trip test to `test/persistence/entityRepository.test.ts`.

- [ ] **Step 7: Spec + onboarding.** Add `perTxCapUsdc: usdcAmount.optional()` to the `treasury`
  sub-object in `src/policy/agentSpec.ts`; in `src/workflow/onboarding.ts` where the `EntityRecord` is
  built, set `perTxCap: spec.treasury.perTxCapUsdc ? usdToUnits(spec.treasury.perTxCapUsdc) : null`.

- [ ] **Step 8: Load it in the live runner.** In `src/agent/liveRunner.ts` `buildLiveAgentRunner`, after
  resolving the entity (it already calls `entities.findByTreasury(treasury)` for the vault operator), pass
  `perTxCap: entity.perTxCap ?? undefined` into the `authorityDeps` object.

- [ ] **Step 9: Run + lint + typecheck + full suite** → PASS (no regressions; the new field is nullable
  and optional everywhere).

- [ ] **Step 10: Commit** — `git add -A && git commit -m "feat(policy): per-transaction cap (spec field + entity storage + Authority enforcement)"`

---

### Task 4: Per-tx cap edit route — `PATCH /entities/:id/per-tx-cap`

Per-tx cap is off-chain policy, so changing it is an instant DB update (no timelock, no on-chain tx) —
tenant-scoped.

**Files:**
- Create: `src/api/routes/perTxCap.ts`
- Modify: `src/api/app.ts` (mount)
- Test: `test/api/perTxCap.routes.test.ts`

**Interfaces:**
- Consumes: `deps.repo` (`findByIdempotencyKey` + `upsert`), `requireAuth`, `ApiError`, `usdToUnits`.
- Produces: `PATCH /entities/:id/per-tx-cap` `{ perTxCapUsdc: string | null }` → `200 { perTxCap }` (atomic string or null).

- [ ] **Step 1: Write the failing test** `test/api/perTxCap.routes.test.ts` (mirror the treasury harness):
  seed a bound entity; `PATCH /entities/:id/per-tx-cap` with `{ perTxCapUsdc: "0.02" }` → 200, then
  `deps.repo.findByIdempotencyKey(id).perTxCap === 20000n`; sending `{ perTxCapUsdc: null }` clears it
  (`perTxCap === null`); cross-tenant → 404; no auth → 401; bad amount → 400.

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement** `src/api/routes/perTxCap.ts`:

```ts
import type { Hono } from "hono";
import { z } from "zod";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";
import { usdToUnits } from "../../policy/units";

const Body = z.object({ perTxCapUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/).nullable() });

/** Edit the off-chain per-transaction cap (instant; no timelock). Tenant-scoped. */
export function mountPerTxCapRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.patch("/entities/:id/per-tx-cap", async (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    const { perTxCapUsdc } = Body.parse(await c.req.json());
    const perTxCap = perTxCapUsdc === null ? null : usdToUnits(perTxCapUsdc);
    deps.repo.upsert({ ...rec, perTxCap });
    return c.json({ perTxCap: perTxCap === null ? null : perTxCap.toString() });
  });
}
```

- [ ] **Step 4: Mount** in `src/api/app.ts`: `mountPerTxCapRoutes(app, deps);` + the import.

- [ ] **Step 5: Run + lint + typecheck + full suite** → PASS.

- [ ] **Step 6: Commit** — `git add src/api/routes/perTxCap.ts src/api/app.ts test/api/perTxCap.routes.test.ts && git commit -m "feat(api): PATCH /entities/:id/per-tx-cap (edit off-chain per-tx limit)"`

---

## Self-Review

**Spec coverage:** roadmap backend items → tasks: reputation read → Task 1; cap/period policy route →
Task 2; per-tx cap (enforce) → Task 3; per-tx cap (edit) → Task 4; allowlist → frontend-only (noted, no
task). ✓
**Placeholders:** Task 1 Step 1 and Step 4 intentionally direct the implementer to confirm the real
`deps.jobs` list-by-entity method name + job `status` values from `src/api/routes/jobs.ts` (a read, not a
guess) — this is a verification step, not a placeholder. All new code is complete.
**Type consistency:** `perTxCap` is `bigint | null` on `EntityRecord` and `perTxCap?: bigint` on
`PolicyInput`/`AuthorityDeps` (undefined = no cap); routes convert via `usdToUnits`/`.toString()`.
`schedulePolicyUpdate` args order `[newCap, newPeriod, allowlistOn, newPayout]` matches `agentTreasuryAbi`.
