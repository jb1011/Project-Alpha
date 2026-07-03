# BYOA P2c — `run_job` (earn / ERC-8183) MCP tool

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give a linked agent the governed **earn** capability — a `run_job` MCP tool that runs the proven
ERC-8183 job saga (agent as provider, platform stands in for client + evaluator in v1) so the agent can earn
USDC + reputation on demand. Completes the BYOA "operate" surface (read + earn + spend).

**Architecture:** Thin MCP tool that mirrors the existing `POST /entities/:id/jobs` HTTP route
(`src/api/routes/jobs.ts:10-35`) exactly, adding the `earn` capability gate and entity-scope check. It
delegates to `deps.jobRunner.start(...)` (the same saga the HTTP route uses) and returns `{ jobKey, status }`;
the agent polls `get_job` (already shipped in P2a) for `jobId` + tx hashes as the saga progresses.

**Tech Stack:** TypeScript, Hono, `@modelcontextprotocol/sdk`, better-sqlite3, vitest, Biome (no build step).

## Global Constraints

- **Depends on** P2a (`hasCapability`/`entityInScope` in `src/mcp/scope.ts`; `get_job`) and the job infra
  (`JobRunner`, `JobRepository`) — all on `main` now. Branch P2c off `main`.
- **Capability:** `run_job` requires `hasCapability(scope, "earn")`. (Ladder is `read < earn < spend`, so a
  `spend` key also earns; a `read` key cannot.) Capability-denied returns the SAME uniform "not found" as an
  ownership/scope miss (no oracle).
- **Tenant + entity isolation (§14.2):** re-check `rec.ownerTenantId === tenantId` AND `entityInScope(scope,
  id)`; uniform "not found"; cross-tenant IDOR test required. The `providerAddress` (operator) is derived from
  the RESOLVED entity record, never from a tool arg.
- **Input validation:** `budgetUsdc` is optional; if provided it must be a positive decimal USDC string
  (default `"1.00"`, matching the HTTP route). Reject non-numeric / non-positive.
- **Async, mirrors the route:** `run_job` triggers the saga and returns `{ jobKey, status }` (status
  `"pending"`); it does NOT block on completion. The agent polls `get_job(jobKey)` for progress. `Date.now()`
  + `randomUUID()` are used for the jobKey exactly as the HTTP route does (normal Node runtime).
- **Additive / no regressions.** All existing MCP tools + tests stay green. Gate: `npm run lint && npm run
  typecheck && npm test` from `back/backend/`.

---

## File Structure

- `src/mcp/server.ts` (**modify**) — `McpToolDeps` gains `jobRunner`, `jobClientAddress`, `jobEvaluatorAddress`;
  register the `run_job` tool (after `treasury_status`/`pay`).
- `src/mcp/transport.ts` (**modify**) — pass the three new deps into `buildMcpServer(scope, {...})` (they
  already exist on `ApiDeps`; the composition root already provides them).
- Test: `test/mcp/runJob.int.test.ts` (**new**).

---

### Task 1: `run_job` MCP tool (wire deps + register + tests)

**Files:**
- Modify: `src/mcp/server.ts`, `src/mcp/transport.ts`
- Test: `test/mcp/runJob.int.test.ts`

**Interfaces:**
- Consumes: `hasCapability`/`entityInScope` (`./scope`); `JobRunner` (`../jobs/jobRunner`); `usdToUnits`
  (`../policy/units`); `randomUUID` (`node:crypto`). `ApiDeps` already carries `jobRunner`,
  `jobClientAddress`, `jobEvaluatorAddress`.
- Produces: MCP tool `run_job({ id, budgetUsdc? })` → `{ jobKey, status }`.

- [ ] **Step 1: Write the failing test** — `test/mcp/runJob.int.test.ts`. Mirror
  `test/mcp/tools.read.int.test.ts`'s harness (`buildApiApp({...} as never)` + `startMcpTestClient(app, key)`
  from `test/mcp/helpers.ts` + `apiKeys.mint`). Pass a **fake `jobRunner`** in the `buildApiApp` deps whose
  `start(p)` records `p` and returns `{ status: "pending" }`, plus `jobClientAddress`/`jobEvaluatorAddress`
  fixtures. Seed an entity owned by TENANT with `operator` set (mirror `seedEntity` in
  `test/api/jobs.routes.test.ts` — note `operator` becomes the `providerAddress`). Assert:
  - **capability:** a `read` key (`apiKeys.mint(TENANT, { capability: "read" })`) → `run_job` returns
    "not found" AND the fake `jobRunner.start` was NOT called; an `earn` key
    (`apiKeys.mint(TENANT, { capability: "earn" })`) proceeds; a `spend` key (default mint) also proceeds
    (spend ⊇ earn).
  - **tenant/entity isolation:** a cross-tenant `id` and an entity-scoped-to-a-different-entity key
    (`apiKeys.mint(TENANT, { entityId: "TENANT:other", capability: "earn" })` calling `run_job` on
    "TENANT:agent1") → "not found" AND `start` NOT called.
  - **budget validation:** `budgetUsdc` ∈ {"abc", "-1", "0"} → error AND `start` NOT called ("0" →
    "budgetUsdc must be positive"; "abc"/"-1" → "invalid budgetUsdc").
  - **happy path:** an `earn` key + owned entity + `budgetUsdc: "2.00"` → `start` called ONCE with
    `{ jobKey: <starts with "TENANT:agent1:">, entityKey: "TENANT:agent1", tenantId: TENANT, budget:
    2_000_000n, clientAddress: <fixture>, evaluatorAddress: <fixture>, providerAddress: <the seeded
    operator> }` (assert `providerAddress` is the RESOLVED entity's operator, not derived from the id arg),
    and the tool returns JSON `{ jobKey, status: "pending" }`.
  - **default budget:** omitting `budgetUsdc` → `start` called with `budget: 1_000_000n`.

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/mcp/runJob.int.test.ts` → FAIL (`run_job` undefined).

- [ ] **Step 3: Implement**
  - `src/mcp/server.ts`: add to `McpToolDeps`: `jobRunner: import("../jobs/jobRunner").JobRunner;`
    `jobClientAddress: string;` `jobEvaluatorAddress: string;`. Add imports `import { randomUUID } from
    "node:crypto";` and `import { usdToUnits } from "../policy/units";` (and `hasCapability` from `./scope` if
    not already imported). Register after the `pay` tool:
```ts
server.registerTool(
  "run_job",
  {
    title: "Run job",
    description:
      "Have your agent earn USDC + reputation by running an ERC-8183 job (self-contained v1: the platform " +
      "stands in for the client + evaluator). Returns immediately with status 'pending'; poll get_job(jobKey).",
    inputSchema: { id: z.string(), budgetUsdc: z.string().optional() },
  },
  async ({ id, budgetUsdc }) => {
    if (!hasCapability(scope, "earn"))
      return { content: [{ type: "text", text: "not found" }], isError: true };
    const rec = repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
      return { content: [{ type: "text", text: "not found" }], isError: true };
    let budget: bigint;
    const raw = budgetUsdc ?? "1.00";
    if (!/^\d+(\.\d+)?$/.test(raw))
      return { content: [{ type: "text", text: "invalid budgetUsdc" }], isError: true };
    budget = usdToUnits(raw);
    if (budget <= 0n)
      return { content: [{ type: "text", text: "budgetUsdc must be positive" }], isError: true };
    const jobKey = `${rec.idempotencyKey}:${Date.now()}-${randomUUID().slice(0, 8)}`;
    const { status } = deps.jobRunner.start({
      jobKey,
      entityKey: rec.idempotencyKey,
      tenantId,
      budget,
      description: "agent job (mcp)",
      clientAddress: deps.jobClientAddress,
      evaluatorAddress: deps.jobEvaluatorAddress,
      providerAddress: rec.operator ?? "0x",
    });
    return { content: [{ type: "text", text: JSON.stringify({ jobKey, status }) }] };
  },
);
```
  - `src/mcp/transport.ts`: add `jobRunner: deps.jobRunner, jobClientAddress: deps.jobClientAddress,
    jobEvaluatorAddress: deps.jobEvaluatorAddress` to the `buildMcpServer(scope, { ... })` deps object.
  - (No `McpToolDeps` optionality needed — the MCP int tests build the app via `buildApiApp({...} as never)`,
    so the `as never` cast means those tests need not supply the new fields; `deps.jobRunner` is only read
    when `run_job` is invoked, and the new test supplies a fake. Confirm the existing MCP suites still pass.)

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/mcp/runJob.int.test.ts` + `npx vitest run test/mcp`
  → PASS.

- [ ] **Step 5: Full gate + commit** — `npm run lint && npm run typecheck && npm test`; then
  `git add src/mcp/server.ts src/mcp/transport.ts test/mcp/runJob.int.test.ts && git commit -m "feat(mcp):
  run_job earn tool (ERC-8183 saga, earn-gated, entity-scoped, mirrors POST /entities/:id/jobs)"`

---

## After this slice

P2c completes the "operate" tool surface: **read** (`whoami`/`list_entities`/`get_entity`/`get_job`/
`list_jobs`/`treasury_status`), **earn** (`run_job`), **spend** (`pay`), plus the provisioning tools
(`fund_treasury`/`onboard_agent`). Remaining BYOA work: P3 (agent-first magic-link bootstrap) → P4 (snippet
breadth + docs). Carried fast-follows: the **signed evaluator-attestation seam** (§14.2 — the ERC-8183
evaluator interface should carry a signature field so decentralizing evaluators later needs no rework; deeper
job-saga change, out of this slice); the P2b **ledger `runningPending` scoping + `markSettled`** pre-prod
must-fix; and `get_entity` gaining `entityInScope` for consistency with the newer read tools.

## Self-Review

**Spec coverage:** §4.1 `run_job` (self-contained v1, agent=provider, platform stands in for client+evaluator,
returns `{jobKey,status}`, poll a job read) → Task 1; §14.2 capability gating (`earn`) + tenant/entity
isolation + input validation → Task 1's gate/scope/budget checks + IDOR test. ✓
**Placeholders:** Task 1 contains the complete tool code + a concrete test spec (exact records/assertions,
mirroring `jobs.routes.test.ts`'s seed + `tools.read.int.test.ts`'s harness). ✓
**Type consistency:** `JobRunner.start`'s argument object matches the HTTP route's call
(`src/api/routes/jobs.ts:24-33`) field-for-field; `hasCapability`/`entityInScope` used as in P2a/P2b;
`usdToUnits`/`randomUUID` imports match the HTTP route. ✓
**Signed evaluator seam** intentionally deferred (noted above) — it's a job-saga change, not the MCP exposure
this slice delivers. ✓
