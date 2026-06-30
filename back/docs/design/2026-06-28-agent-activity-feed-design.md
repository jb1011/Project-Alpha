# Agent Activity Feed — Design (x402 settlements in the dashboard)

> Status: design approved 2026-06-28. Goal: make the dashboard show the agent's **real** x402
> commerce — a feed of "job receipts" (cost → revenue → P&L), each expandable to its individual
> on-chain payments. Targets the hackathon deadline (2026-07-06), NOT tomorrow's Circle call.
> Branch: `feat/agent-activity-feed`. The "stretch" from `back/docs/plans/2026-06-28-honest-dashboard.md`.

## 1. Context & goal

The honest dashboard (shipped) shows real treasury balance + a real guardian freeze, but its Activity
card is an honest **empty state** ("No agent payments yet"). The agent is *deployed but idle*. This
feature makes the agent **actually transact** (run the governed x402 buy→sell→settle loop for the first
time live) and **display the real result** in the dashboard.

**The nanopayment loop already exists** (`src/agent/liveRunner.ts`, `src/payments/*`, `src/adapters/x402/*`)
and computes cost / revenue / P&L / settle transfer IDs per run — but it has **never been run live**, and
its result is **returned in memory, never persisted**. The current `PaymentLedger` is thin (records buys as
`authorized`, never calls `markSettled`, doesn't record sells, has no entity link). So this feature adds a
**persistence layer + a read/display layer**.

### Decisions locked (brainstorming)
- **Display-only UX:** the loop runs **out-of-band** (operator/CLI); the dashboard **displays** what it
  produced. No in-UI "run the agent" trigger (that autonomous/trigger UX is explicitly deferred).
- **Run-level data ("receipt per job"), with expandable per-payment detail.** One receipt per `agent ask`
  run (cost/revenue/P&L); clicking it reveals the individual buys + the sell, each with a settlement link.

## 2. Scope

**In:**
- A run-persistence layer (two tables) written by the live loop.
- Phase 1: stand up + execute the live x402 loop against a funded agent, persisting real runs.
- Phase 2: a tenant-scoped read endpoint + a dashboard Activity panel (expandable receipts).

**Out of scope (noted, not built):**
- An in-UI "run the agent" trigger / autonomous background runner.
- Governed funding top-ups (treasury→operator→pocket→Gateway) as separate feed entries.
- Multi-agent ledger association beyond the single showcase agent.
- Reworking the low-level `PaymentLedger` (that's the rejected "Option B").

## 3. Architecture (two phases)

```
PHASE 1 (out-of-band, on the VPS)                  PHASE 2 (the dashboard reads)
  agent ask "<query>"                               GET /entities/:id/runs  (JWT, tenant-scoped)
   └─ liveRunner: fund → buy(x402) → sell(x402)       └─ reads agent_runs + run_payments
   └─ persist: 1 agent_runs row + N run_payments     Frontend DashboardStep:
        rows  (into the backend's SQLite DB) ────────►  Activity card = feed of job receipts,
                                                          each EXPANDABLE to its payments
```

The loop writes to the **same SQLite DB the backend serves from** (`back/backend/legalbody.db` on the VPS),
so the dashboard reads exactly what the loop produced.

## 4. Data model (migrations in `persistence/db.ts`)

```sql
CREATE TABLE IF NOT EXISTS agent_runs (
  id          TEXT PRIMARY KEY,
  entity_key  TEXT NOT NULL,          -- the agent this run is for (resolved from the run's treasury)
  query       TEXT NOT NULL,          -- the question the agent answered
  cost        TEXT NOT NULL,          -- atomic USDC spent on data (sum of buys)
  revenue     TEXT NOT NULL,          -- atomic USDC earned from the sell
  pnl         TEXT NOT NULL,          -- atomic USDC net (revenue - cost), signed decimal string
  status      TEXT NOT NULL CHECK (status IN ('completed','failed')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_entity ON agent_runs(entity_key, created_at);

CREATE TABLE IF NOT EXISTS run_payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('buy','sell')),
  counterparty TEXT NOT NULL,         -- vendor (buy) or customer (sell)
  amount       TEXT NOT NULL,         -- atomic USDC
  transfer_id  TEXT,                  -- Circle settlement transfer id (the real settlement reference; a batched-Gateway UUID, not an on-chain hash); null if unsettled
  status       TEXT NOT NULL,         -- 'settled' | 'failed' | 'pending'
  FOREIGN KEY (run_id) REFERENCES agent_runs(id)
);
```

Store: `AgentRunStore` — `record(run, payments[]) → id`, `listByEntity(entityKey) → RunWithPayments[]`.
Entity resolution: a `EntityRepository.findByTreasury(addr)` helper (small addition) maps the run's
`TREASURY_ADDRESS` → `entity_key` at persist time.

## 5. Phase 1 — produce real data (the de-risk)

1. **Env on the VPS** (`/root/Project-Alpha/back/backend/.env`): add `ANTHROPIC_API_KEY` (user's), a fresh
   `POCKET_PRIVATE_KEY` + `CUSTOMER_PRIVATE_KEY`, `VENDOR_PAYOUT_ADDRESS` + `AGENT_PAYOUT_ADDRESS` (distinct),
   `TREASURY_ADDRESS` = **TestAgentMB_1's** `0x9f01EF223BdB596625d8eE2E30F13A8aB527B0a5`, and a small USDC
   top-up to the pocket (operator one-time gas seed). The loop already reads these (`loadConfig`).
2. **Add run persistence to the loop:** thread the per-payment detail (each buy's counterparty/amount/
   transfer-id, the sell's) out of `runLive`/`runDemo`/`sellAnswer`, and at the end of a run write one
   `agent_runs` row + its `run_payments` via `AgentRunStore`, into the backend's DB (same `cfg.dbPath`).
3. **Run `agent ask "<query>"` a few times** on the VPS (operator) → real receipts land in the DB. This is
   the **first-ever live execution** of the loop; expect to iterate (settle interop is proven — Finding 10 —
   but the full three-leg loop is not). Runbook: `docs/runbooks/2026-06-19-live-agent-run.md`.

## 6. Phase 2 — display

- **Backend:** `GET /entities/:id/runs` (JWT, tenant-scoped exactly like `/entities/:id/treasury`):
  404 if not found / not owned; returns `{ runs: [{ id, query, cost, revenue, pnl, status, createdAt,
  payments: [{ direction, counterparty, amount, transferId, status }] }] }` (atomic USDC strings).
  Wire `AgentRunStore` into `ApiDeps` + `main.ts`. New route file `src/api/routes/runs.ts`.
- **Frontend (`DashboardStep.tsx`):** add `getEntityRuns(token, id)` to the client; fetch on the dashboard
  (alongside the treasury poll). Replace the empty Activity card with a **feed of receipts** — each row
  shows `query` + `cost → revenue → net P&L` (green/red); clicking a row **expands** to list its payments
  (direction, counterparty, amount, and the **Circle settlement transfer id** shown as the settlement
  reference — it's a batched-Gateway UUID, so display it as proof rather than a clickable explorer link).
  Keep the honest empty state when there are no runs.

## 7. Testing

- **Backend (TDD):** `AgentRunStore` unit tests (record + listByEntity, payments nested); `findByTreasury`
  test; `GET /entities/:id/runs` route test (tenant-scoping + shape) with seeded runs. `npm test` green.
- **Phase 2 buildable before Phase 1 lands:** seed `agent_runs`/`run_payments` in tests so the endpoint +
  UI are built and verified against fake receipts; then the real run (Phase 1) populates the same shape.
- **Frontend:** `npm run build` typecheck/compile; manual verify the expandable feed against a seeded (then
  real) run.
- **Phase 1 verification:** a live `agent ask` run completes, a receipt appears in the DB, and the dashboard
  shows it with working settlement links.

## 8. Deliverables

1. `agent_runs` + `run_payments` migrations; `AgentRunStore`; `EntityRepository.findByTreasury`.
2. Run-persistence wired into `liveRunner` / the `agent ask` path (per-payment detail threaded out).
3. Live-loop env on the VPS + ≥1 real `agent ask` run producing a persisted receipt.
4. `GET /entities/:id/runs` + `ApiDeps`/`main.ts` wiring + tests.
5. `getEntityRuns` client + the expandable Activity feed in `DashboardStep`.
