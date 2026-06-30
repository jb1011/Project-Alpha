# Agent Activity Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Show the agent's real x402 commerce in the dashboard — a feed of per-run "job receipts" (cost → revenue → P&L), each expandable to its individual on-chain payments.

**Architecture:** The live x402 loop (`liveRunner`) runs out-of-band and **persists each run** (one `agent_runs` row + N `run_payments` rows) into the backend's SQLite DB. The dashboard reads them via a tenant-scoped endpoint and renders expandable receipts. Display-only (no in-UI trigger).

**Tech Stack:** TypeScript, better-sqlite3, Hono, viem, vitest (backend); Next 16 / wagmi 3 / Tailwind (frontend).

**Reference spec:** `back/docs/design/2026-06-28-agent-activity-feed-design.md`. Branch `feat/agent-activity-feed`. Backend cwd `back/backend`; frontend cwd `interface`. Targets the 2026-07-06 hackathon — NOT tomorrow's call (this branch never touches prod until deliberately merged).

## Global Constraints

- `tenantId` from the authed session only; tenant-check every entity read (`rec.ownerTenantId !== tenantId` → 404). USDC amounts are **atomic decimal strings** (6 decimals); `pnl` is a signed atomic string (revenue − cost).
- The live loop persists into the **same DB the backend serves** (`cfg.dbPath` → `back/backend/legalbody.db` on the VPS) so the dashboard reads what it produced.
- Reuse the existing `ApiError`/`apiOnError` envelope and the `/entities/:id/treasury` route + `DashboardStep` fetch patterns. Additive-only to `app.ts`/`main.ts`/`db.ts`/`liveRunner.ts`.
- Backend: `npm run lint` (Biome), `npm run typecheck`, `npm test` (vitest). Frontend: `npm run build`. Heed `interface/AGENTS.md` for frontend (Next 16 fork).

---

## Phase 1 — persistence + producing real data

### Task 1: `agent_runs` + `run_payments` tables + `AgentRunStore`

**Files:**
- Modify: `src/persistence/db.ts` (two tables in `migrate`)
- Create: `src/persistence/agentRunStore.ts`
- Test: `test/persistence/agentRunStore.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RunPaymentInput { direction: "buy" | "sell"; counterparty: string; amount: string; transferId: string | null; status: "settled" | "failed" | "pending"; }
  export interface RunInput { entityKey: string; query: string; cost: string; revenue: string; pnl: string; status: "completed" | "failed"; }
  export interface RunView extends RunInput { id: string; createdAt: number; payments: RunPaymentInput[]; }
  export interface AgentRunStore { record(run: RunInput, payments: RunPaymentInput[]): string; listByEntity(entityKey: string): RunView[]; }
  export class SqliteAgentRunStore implements AgentRunStore { constructor(db: Database.Database) }
  ```

- [ ] **Step 1: Add the tables** to `migrate` in `src/persistence/db.ts` (append inside the `db.exec(\`...\`)` block, after the `job_events` table):

```sql
    CREATE TABLE IF NOT EXISTS agent_runs (
      id          TEXT PRIMARY KEY,
      entity_key  TEXT NOT NULL,
      query       TEXT NOT NULL,
      cost        TEXT NOT NULL,
      revenue     TEXT NOT NULL,
      pnl         TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('completed','failed')),
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_entity ON agent_runs(entity_key, created_at);

    CREATE TABLE IF NOT EXISTS run_payments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      direction    TEXT NOT NULL CHECK (direction IN ('buy','sell')),
      counterparty TEXT NOT NULL,
      amount       TEXT NOT NULL,
      transfer_id  TEXT,
      status       TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES agent_runs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_payments_run ON run_payments(run_id);
```

- [ ] **Step 2: Write the failing test** `test/persistence/agentRunStore.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteAgentRunStore } from "../../src/persistence/agentRunStore";

let db: Database.Database;
let store: SqliteAgentRunStore;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqliteAgentRunStore(db);
});
afterEach(() => db.close());

test("record persists a run + its payments; listByEntity returns them nested", () => {
  const id = store.record(
    { entityKey: "t:agent1", query: "USDC flows on Arc?", cost: "80000", revenue: "120000", pnl: "40000", status: "completed" },
    [
      { direction: "buy", counterparty: "0xVendor", amount: "50000", transferId: "tr-1", status: "settled" },
      { direction: "buy", counterparty: "0xVendor", amount: "30000", transferId: "tr-2", status: "settled" },
      { direction: "sell", counterparty: "0xCustomer", amount: "120000", transferId: "tr-3", status: "settled" },
    ],
  );
  expect(typeof id).toBe("string");
  const runs = store.listByEntity("t:agent1");
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ id, query: "USDC flows on Arc?", cost: "80000", revenue: "120000", pnl: "40000", status: "completed" });
  expect(runs[0]!.payments).toHaveLength(3);
  expect(runs[0]!.payments.filter((p) => p.direction === "buy")).toHaveLength(2);
  expect(runs[0]!.payments.find((p) => p.direction === "sell")?.amount).toBe("120000");
});

test("listByEntity is scoped to the entity and newest-first", () => {
  store.record({ entityKey: "t:a", query: "q1", cost: "1", revenue: "2", pnl: "1", status: "completed" }, []);
  store.record({ entityKey: "t:b", query: "other", cost: "1", revenue: "1", pnl: "0", status: "completed" }, []);
  store.record({ entityKey: "t:a", query: "q2", cost: "1", revenue: "3", pnl: "2", status: "completed" }, []);
  const a = store.listByEntity("t:a");
  expect(a.map((r) => r.query)).toEqual(["q2", "q1"]);
});
```

- [ ] **Step 3: Run, expect fail** — `npx vitest run test/persistence/agentRunStore.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement** `src/persistence/agentRunStore.ts`:

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface RunPaymentInput {
  direction: "buy" | "sell";
  counterparty: string;
  amount: string;
  transferId: string | null;
  status: "settled" | "failed" | "pending";
}
export interface RunInput {
  entityKey: string;
  query: string;
  cost: string;
  revenue: string;
  pnl: string;
  status: "completed" | "failed";
}
export interface RunView extends RunInput {
  id: string;
  createdAt: number;
  payments: RunPaymentInput[];
}
export interface AgentRunStore {
  record(run: RunInput, payments: RunPaymentInput[]): string;
  listByEntity(entityKey: string): RunView[];
}

/** Per-run "job receipts" (cost/revenue/P&L) + their individual x402 payments. */
export class SqliteAgentRunStore implements AgentRunStore {
  constructor(private readonly db: Database.Database) {}

  record(run: RunInput, payments: RunPaymentInput[]): string {
    const id = randomUUID();
    const insertRun = this.db.prepare(
      "INSERT INTO agent_runs (id, entity_key, query, cost, revenue, pnl, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    const insertPay = this.db.prepare(
      "INSERT INTO run_payments (run_id, direction, counterparty, amount, transfer_id, status) VALUES (?,?,?,?,?,?)",
    );
    this.db.transaction(() => {
      insertRun.run(id, run.entityKey, run.query, run.cost, run.revenue, run.pnl, run.status, Math.floor(Date.now() / 1000));
      for (const p of payments)
        insertPay.run(id, p.direction, p.counterparty, p.amount, p.transferId, p.status);
    })();
    return id;
  }

  listByEntity(entityKey: string): RunView[] {
    const runs = this.db
      .prepare(
        "SELECT id, entity_key AS entityKey, query, cost, revenue, pnl, status, created_at AS createdAt FROM agent_runs WHERE entity_key = ? ORDER BY created_at DESC, rowid DESC",
      )
      .all(entityKey) as Omit<RunView, "payments">[];
    const payStmt = this.db.prepare(
      "SELECT direction, counterparty, amount, transfer_id AS transferId, status FROM run_payments WHERE run_id = ? ORDER BY id",
    );
    return runs.map((r) => ({ ...r, payments: payStmt.all(r.id) as RunPaymentInput[] }));
  }
}
```

- [ ] **Step 5: Run + lint + typecheck** — `npx vitest run test/persistence/agentRunStore.test.ts && npm run lint && npm run typecheck` → PASS.

- [ ] **Step 6: Commit** — `git add src/persistence/db.ts src/persistence/agentRunStore.ts test/persistence/agentRunStore.test.ts && git commit -m "feat(activity): agent_runs + run_payments tables + AgentRunStore"`

---

### Task 2: `EntityRepository.findByTreasury`

**Files:**
- Modify: `src/persistence/entityRepository.ts` (interface + impl)
- Test: `test/entityRepository.test.ts` (append)

**Interfaces:**
- Produces: `findByTreasury(treasury: string): EntityRecord | undefined` on `EntityRepository`.

- [ ] **Step 1: Write the failing test** — append to `test/entityRepository.test.ts`:

```ts
test("findByTreasury returns the entity owning a treasury address (case-insensitive)", () => {
  const rec = record({ status: "bound" });
  rec.treasury = "0x000000000000000000000000000000000000000F" as `0x${string}`;
  repo.upsert(rec);
  expect(repo.findByTreasury("0x000000000000000000000000000000000000000f")?.idempotencyKey).toBe(rec.idempotencyKey);
  expect(repo.findByTreasury("0x0000000000000000000000000000000000000001")).toBeUndefined();
});
```
(If the test file's `record()` helper has no `treasury` field, set it on the returned object before `upsert`, as above.)

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/entityRepository.test.ts -t findByTreasury` → FAIL.

- [ ] **Step 3: Add to the interface** in `src/persistence/entityRepository.ts` (in `interface EntityRepository`, near `findByAgentId`):

```ts
  findByTreasury(treasury: string): EntityRecord | undefined;
```

- [ ] **Step 4: Implement** in `SqliteEntityRepository` (near `findByAgentId`). SQLite `COLLATE NOCASE` makes the address match case-insensitive:

```ts
  findByTreasury(treasury: string): EntityRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM entities WHERE treasury = ? COLLATE NOCASE")
      .get(treasury) as Row | undefined;
    return r ? toRecord(r) : undefined;
  }
```

- [ ] **Step 5: Run + typecheck** — `npx vitest run test/entityRepository.test.ts && npm run typecheck` → PASS.

- [ ] **Step 6: Commit** — `git add src/persistence/entityRepository.ts test/entityRepository.test.ts && git commit -m "feat(activity): EntityRepository.findByTreasury"`

---

### Task 3: Persist each live run (helper + wire into liveRunner)

**Files:**
- Create: `src/agent/persistRun.ts`
- Modify: `src/agent/liveRunner.ts` (capture per-payment detail in the settle wrapper; call persist after `runLive`)
- Test: `test/agent/persistRun.test.ts`

**Interfaces:**
- Consumes: `AgentRunStore` (Task 1), `EntityRepository.findByTreasury` (Task 2), `LiveRunResult` (existing, has `totalCost`/`price`/`pnl`/`sold`), `RunPaymentInput`.
- Produces: `persistAgentRun(deps, treasury, query, result, payments): string`.

- [ ] **Step 1: Write the failing test** `test/agent/persistRun.test.ts`:

```ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { persistAgentRun } from "../../src/agent/persistRun";
import { SqliteAgentRunStore } from "../../src/persistence/agentRunStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { LiveRunResult } from "../../src/agent/liveRunner";

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

function seedEntity(entityKey: string, treasury: string) {
  const repo = new SqliteEntityRepository(db);
  repo.upsert({
    idempotencyKey: entityKey, name: "A", status: "funded",
    manager: "0x000000000000000000000000000000000000000A", guardian: "0x000000000000000000000000000000000000000A",
    operator: null, amendmentDelay: "0", ein: "", formationDate: 0, oaHash: null, metadataURI: null, docPath: null,
    treasuryConfig: null, agentId: "1", proxy: null, treasury: treasury as `0x${string}`,
    createTxHash: null, bindTxHash: null, fundTxHash: null, ownerTenantId: "t",
  });
}

test("persistAgentRun resolves the entity from the treasury and records the run + payments", () => {
  const TREASURY = "0x000000000000000000000000000000000000000F";
  seedEntity("t:agent1", TREASURY);
  const runs = new SqliteAgentRunStore(db);
  const entities = new SqliteEntityRepository(db);
  const result = { totalCost: 80000n, price: 120000n, pnl: 40000n, sold: true } as unknown as LiveRunResult;
  const id = persistAgentRun({ runs, entities }, TREASURY, "q", result, [
    { direction: "buy", counterparty: "0xVendor", amount: "80000", transferId: "tr-1", status: "settled" },
    { direction: "sell", counterparty: "0xCustomer", amount: "120000", transferId: "tr-2", status: "settled" },
  ]);
  expect(typeof id).toBe("string");
  const got = runs.listByEntity("t:agent1");
  expect(got).toHaveLength(1);
  expect(got[0]).toMatchObject({ cost: "80000", revenue: "120000", pnl: "40000", status: "completed" });
  expect(got[0]!.payments).toHaveLength(2);
});

test("persistAgentRun falls back to the treasury address as entityKey when no entity matches", () => {
  const runs = new SqliteAgentRunStore(db);
  const entities = new SqliteEntityRepository(db);
  const result = { totalCost: 1n, price: 2n, pnl: 1n, sold: true } as unknown as LiveRunResult;
  persistAgentRun({ runs, entities }, "0xUnknownTreasury", "q", result, []);
  expect(runs.listByEntity("0xUnknownTreasury")).toHaveLength(1);
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/agent/persistRun.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/agent/persistRun.ts`:

```ts
import type { LiveRunResult } from "./liveRunner";
import type { AgentRunStore, RunPaymentInput } from "../persistence/agentRunStore";
import type { EntityRepository } from "../persistence/entityRepository";

/** Persist one completed live run as a job receipt + its payments. Entity resolved from the treasury;
 *  falls back to the treasury address as the key so a run is never silently dropped. */
export function persistAgentRun(
  deps: { runs: AgentRunStore; entities: EntityRepository },
  treasury: string,
  query: string,
  result: LiveRunResult,
  payments: RunPaymentInput[],
): string {
  const entityKey = deps.entities.findByTreasury(treasury)?.idempotencyKey ?? treasury;
  return deps.runs.record(
    {
      entityKey,
      query,
      cost: result.totalCost.toString(),
      revenue: result.price.toString(),
      pnl: result.pnl.toString(),
      status: result.sold ? "completed" : "failed",
    },
    payments,
  );
}
```

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/agent/persistRun.test.ts` → PASS.

- [ ] **Step 5: Wire into `liveRunner.ts`** — in `buildLiveAgentRunner`:
  (a) capture per-payment detail in the existing settle wrapper:

```ts
  const settleTransferIds: string[] = [];
  const paymentRecords: import("../persistence/agentRunStore").RunPaymentInput[] = [];
  const baseSettle = makeSettle({ facilitatorUrl: cfg.gatewayFacilitatorUrl });
  const settle: SettleFn = async (header, reqs) => {
    const r = await baseSettle(header, reqs);
    if (r.ok && r.transferId) settleTransferIds.push(r.transferId);
    paymentRecords.push({
      direction: reqs.payTo.toLowerCase() === vendorPayout.toLowerCase() ? "buy" : "sell",
      counterparty: reqs.payTo,
      amount: reqs.amount,
      transferId: r.ok ? (r.transferId ?? null) : null,
      status: r.ok ? "settled" : "failed",
    });
    return r;
  };
```
  (b) construct the stores + persist after `runLive`. Add imports at the top (`SqliteAgentRunStore`, `SqliteEntityRepository`, `persistAgentRun`), and change the returned function:

```ts
  const runs = new SqliteAgentRunStore(db);
  const entities = new SqliteEntityRepository(db);

  return async (query: string) => {
    const result = await runLive(
      { /* ...existing LiveDeps unchanged... */ },
      query,
    );
    persistAgentRun({ runs, entities }, treasury, query, result, paymentRecords);
    return result;
  };
```
  (`db`, `treasury`, `vendorPayout` are already in scope in `buildLiveAgentRunner`.)

- [ ] **Step 6: Typecheck + lint + full suite** — `npm run typecheck && npm run lint && npm test` → PASS (no regressions; the live-only path stays env-gated).

- [ ] **Step 7: Commit** — `git add src/agent/persistRun.ts src/agent/liveRunner.ts test/agent/persistRun.test.ts && git commit -m "feat(activity): persist each live run as a job receipt + payments"`

---

### Task 4: [OPERATOR] Stand up the live loop env + run it (the de-risk)

**Not a TDD task — an operator runbook.** Produces the real data Phase 2 displays. Do this on the VPS (where the backend DB lives). Reference: `back/docs/runbooks/2026-06-19-live-agent-run.md`.

- [ ] Generate a fresh **pocket** + **customer** keypair (e.g. `cast wallet new` ×2, or viem `generatePrivateKey`). Record the pocket address.
- [ ] Fund the **pocket** address with a small amount of Arc-testnet USDC (faucet `faucet.circle.com`) for gas + the float.
- [ ] On the VPS, add to `/root/Project-Alpha/back/backend/.env`: `ANTHROPIC_API_KEY=…`, `POCKET_PRIVATE_KEY=…`, `CUSTOMER_PRIVATE_KEY=…`, `TREASURY_ADDRESS=0x9f01EF223BdB596625d8eE2E30F13A8aB527B0a5` (TestAgentMB_1), `VENDOR_PAYOUT_ADDRESS=…`, `AGENT_PAYOUT_ADDRESS=…` (distinct, ≠ treasury). Confirm `FUNDING_FLOAT_USDC` is small (default 0.50).
- [ ] Check out `feat/agent-activity-feed` on the VPS so the persistence code is present: `cd /root/Project-Alpha && git fetch && git checkout feat/agent-activity-feed`.
- [ ] Run: `cd back/backend && npm run cli -- agent ask "What are USDC flows on Arc?"` (this is the FIRST live run — expect to iterate). Confirm it completes with a P&L line and prints settle transfer ids.
- [ ] Confirm a receipt landed in the backend DB: `node -e` quick query of `agent_runs`/`run_payments`, or wait for Phase 2's endpoint.
- [ ] **Do NOT restart the production backend onto this branch** — the live run writes to the same DB file; the prod service keeps serving the honest dashboard. (Switching the prod service to this branch only happens at deliberate merge time.)
- [ ] If the loop errors, capture the failing leg + message; debug against the runbook (settle interop is proven; the three-leg loop is new).

---

## Phase 2 — read + display

### Task 5: `GET /entities/:id/runs`

**Files:**
- Create: `src/api/routes/runs.ts`
- Modify: `src/api/app.ts` (ApiDeps += `agentRuns`; mount), `src/api/main.ts` (construct `SqliteAgentRunStore`, pass in deps)
- Test: `test/api/runs.routes.test.ts`

**Interfaces:**
- Consumes: `AgentRunStore.listByEntity` (Task 1), `EntityRepository`, `requireAuth`, `ApiError`.
- Produces: `GET /entities/:id/runs` → `200 { runs: RunView[] }`; 404 if not found / not owned.

- [ ] **Step 1: Extend `ApiDeps`** in `src/api/app.ts`:

```ts
  agentRuns: import("../persistence/agentRunStore").AgentRunStore;
```

- [ ] **Step 2: Mount** in `buildApiApp` (after `mountTreasuryRoutes(app, deps);` — the `/entities/*` requireAuth guard already covers it):

```ts
  mountRunsRoutes(app, deps);
```
Add import: `import { mountRunsRoutes } from "./routes/runs";`

- [ ] **Step 3: Write the failing test** `test/api/runs.routes.test.ts` (mirror `test/api/treasury.routes.test.ts` harness — copy its `account`/`otherAccount`/`DOMAIN`/`CHAIN`/`login`/`beforeEach`; build the app with `agentRuns: new SqliteAgentRunStore(db)`; seed a bound entity + a run):

```ts
// ...copy the treasury.routes.test.ts harness (imports, account/otherAccount, login, beforeEach/afterEach,
//    a makeApp that passes agentRuns: new SqliteAgentRunStore(db), and the seedBound helper)...
import { SqliteAgentRunStore } from "../../src/persistence/agentRunStore";

test("GET /entities/:id/runs → 200 with the entity's runs + payments", async () => {
  const app = makeApp();
  const token = await login(app);
  const id = seedBound(account.address, "a1");
  new SqliteAgentRunStore(db).record(
    { entityKey: id, query: "q", cost: "80000", revenue: "120000", pnl: "40000", status: "completed" },
    [{ direction: "sell", counterparty: "0xCust", amount: "120000", transferId: "tr-1", status: "settled" }],
  );
  const res = await app.request(`/entities/${encodeURIComponent(id)}/runs`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.runs).toHaveLength(1);
  expect(body.runs[0]).toMatchObject({ query: "q", pnl: "40000" });
  expect(body.runs[0].payments).toHaveLength(1);
});

test("cross-tenant → 404", async () => {
  const app = makeApp();
  await login(app);
  seedBound(account.address, "a1");
  const otherToken = await login(app, otherAccount);
  const res = await app.request(`/entities/${encodeURIComponent(`${account.address}:a1`)}/runs`, { headers: { authorization: `Bearer ${otherToken}` } });
  expect(res.status).toBe(404);
});

test("no auth → 401", async () => {
  expect((await makeApp().request("/entities/x/runs")).status).toBe(401);
});
```
The `makeApp` deps object must include `agentRuns: new SqliteAgentRunStore(db)` (and the `as never` cast covers other unused fields).

- [ ] **Step 4: Run, expect fail** — `npx vitest run test/api/runs.routes.test.ts` → FAIL.

- [ ] **Step 5: Implement** `src/api/routes/runs.ts`:

```ts
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

/** The agent's real x402 commerce: a feed of per-run job receipts + their payments. */
export function mountRunsRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/entities/:id/runs", (c) => {
    const id = c.req.param("id");
    const rec = deps.repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== c.get("tenantId"))
      throw new ApiError("not_found", 404, "entity not found");
    return c.json({ runs: deps.agentRuns.listByEntity(id) });
  });
}
```

- [ ] **Step 6: Wire `main.ts`** — add `const agentRuns = new SqliteAgentRunStore(db);` (after the other store constructions), the import, and `agentRuns,` in the `buildApiApp({ ... })` deps.

- [ ] **Step 7: Run + lint + typecheck + full suite** — `npx vitest run test/api/runs.routes.test.ts && npm run lint && npm run typecheck && npm test` → PASS.

- [ ] **Step 8: Commit** — `git add src/api/routes/runs.ts src/api/app.ts src/api/main.ts test/api/runs.routes.test.ts && git commit -m "feat(activity): GET /entities/:id/runs"`

---

### Task 6: Dashboard Activity feed (expandable receipts)

**Files:**
- Modify: `interface/src/lib/api/client.ts`, `interface/src/lib/api/types.ts`
- Modify: `interface/src/components/onboarding/steps/DashboardStep.tsx`

**Interfaces:**
- Consumes: `getEntityRuns(token, id)`; the existing `useAuth().ensureSession` + the dashboard's fetch/poll pattern.

- [ ] **Step 1: Add types** to `src/lib/api/types.ts`:

```ts
export type RunPayment = { direction: "buy" | "sell"; counterparty: string; amount: string; transferId: string | null; status: string };
export type AgentRun = { id: string; query: string; cost: string; revenue: string; pnl: string; status: "completed" | "failed"; createdAt: number; payments: RunPayment[] };
```

- [ ] **Step 2: Add the client fn** to `src/lib/api/client.ts` (mirror `getEntityTreasury`; add `AgentRun` to the `./types` import):

```ts
export async function getEntityRuns(token: string, id: string): Promise<{ runs: AgentRun[] }> {
  return request(`/entities/${encodeURIComponent(id)}/runs`, { token });
}
```

- [ ] **Step 3: Confirm the Next/wagmi versions** — per `interface/AGENTS.md`, no new libs needed here (plain React state + fetch). Read `node_modules/next/dist/docs/` only if a component API question arises.

- [ ] **Step 4: Fetch runs in `DashboardStep`** — alongside the existing treasury fetch, add `const [runs, setRuns] = React.useState<AgentRun[]>([])` and, in the same `entityId && treasuryAddr` effect (or a sibling effect keyed on `entityId`), call `getEntityRuns(auth.token, entityId)` on the 5s poll and `setRuns(r.runs)`. Import `getEntityRuns` + `AgentRun`.

- [ ] **Step 5: Replace the empty Activity card** with the feed. Keep the honest empty state when `runs.length === 0`; otherwise render one expandable receipt per run:

```tsx
<Card className="overflow-hidden">
  <div className="flex items-center justify-between border-b hairline px-5 py-3.5">
    <span className="text-[13px] font-medium text-ink">Activity</span>
    <span className="text-[11.5px] text-muted-2">Agent jobs · x402</span>
  </div>
  {runs.length === 0 ? (
    <div className="px-5 py-12 text-center text-[12.5px] text-muted-2">
      No agent payments yet — this agent hasn’t transacted.
    </div>
  ) : (
    <ul>
      {runs.map((run) => (
        <RunRow key={run.id} run={run} />
      ))}
    </ul>
  )}
</Card>
```

  and add the `RunRow` component (expandable; `usdc` formats atomic→human):

```tsx
function usdc(atomic: string): string {
  return (Number(atomic) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function RunRow({ run }: { run: { query: string; cost: string; revenue: string; pnl: string; payments: { direction: string; counterparty: string; amount: string; transferId: string | null; status: string }[] } }) {
  const [open, setOpen] = React.useState(false);
  const profit = Number(run.pnl) >= 0;
  return (
    <li className="border-b hairline last:border-0">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-paper-2/40">
        <div className="min-w-0">
          <div className="truncate text-[13px] text-ink">{run.query}</div>
          <div className="mt-0.5 text-[11.5px] text-muted-2">spent {usdc(run.cost)} · earned {usdc(run.revenue)} USDC</div>
        </div>
        <span className={cx("shrink-0 font-mono text-[13px] tabular-nums", profit ? "text-accent-soft" : "text-[#ff8a84]")}>
          {profit ? "+" : "−"}{usdc(run.pnl.replace("-", ""))}
        </span>
      </button>
      {open && (
        <div className="border-t hairline bg-paper/40 px-5 py-3">
          {run.payments.map((p, i) => (
            <div key={i} className="flex items-center justify-between gap-3 py-1.5 text-[11.5px]">
              <span className="text-muted">
                {p.direction === "buy" ? "Paid" : "Received"} {usdc(p.amount)} USDC · {p.counterparty.slice(0, 6)}…{p.counterparty.slice(-4)}
              </span>
              <span className="font-mono text-muted-2">{p.transferId ? `settle ${p.transferId.slice(0, 8)}…` : p.status}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
```

- [ ] **Step 6: Build** — `cd interface && npm run build` → compiles clean. Manually verify against a seeded run (or the real Phase-1 run): the feed shows the receipt, clicking expands the payments.

- [ ] **Step 7: Commit** — `git add interface/src/lib/api/client.ts interface/src/lib/api/types.ts interface/src/components/onboarding/steps/DashboardStep.tsx && git commit -m "feat(ui): expandable agent activity feed (x402 job receipts)"`

---

## Self-Review

**Spec coverage:** §3 two-phase architecture → Tasks 1-6. §4 data model (`agent_runs` + `run_payments` + `findByTreasury`) → Tasks 1-2. §5 Phase 1 (persistence + live run) → Tasks 3-4. §6 Phase 2 (endpoint + UI) → Tasks 5-6. §7 testing (build Phase 2 against seeded runs before the live run) → Tasks 5-6 use seeded data. ✓

**Type consistency:** `RunInput`/`RunPaymentInput`/`RunView`/`AgentRunStore` (Task 1) are reused verbatim in Tasks 3+5; `findByTreasury` (Task 2) consumed in Task 3; `AgentRun`/`RunPayment` (frontend, Task 6) mirror the backend `RunView` shape. `result.totalCost`/`price`/`pnl`/`sold` match the real `LiveRunResult`/`DemoResult` fields. ✓

**No placeholders:** every code step is complete. The one non-code task (Task 4) is a deliberate operator runbook, not a placeholder — its output (real data) is also coverable by seeded data so Tasks 5-6 don't depend on it landing first.
