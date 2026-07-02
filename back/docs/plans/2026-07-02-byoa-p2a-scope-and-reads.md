# BYOA P2a — MCP Scope Enforcement + Read Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Enforce the P1 API-key scope (`entityId` + `capability`) in the MCP layer, and add read-only tools
(`get_job`, `list_jobs`) so a linked agent can inspect its jobs. This is the **foundation** for P2b (`pay`)
and P2c (`run_job`) — those "acting" tools will reuse the scope helpers this slice defines.

**Architecture:** P1 made `apiKeyStore.verify` return a full `VerifiedKey { tenantId, id, entityId,
capability }`. Today the MCP layer throws that away (`resolveTenant` keeps only `tenantId`). This slice adds
`resolveKey` (keeps the whole scope), a pure `scope.ts` (a **capability ladder** `read < earn < spend` + an
**entity-scope** check), threads the scope through `buildMcpServer`, and adds two read tools that mirror the
existing `GET /jobs/:jobKey` + `GET /entities/:id/jobs` routes (same `ownerTenantId` check, plus the new
entity-scope check). No payment/earn logic here — reads only.

**Tech Stack:** TypeScript, Hono, `@modelcontextprotocol/sdk`, better-sqlite3, vitest, Biome (no build step, tsx).

## Global Constraints

- **Depends on P1** (PR #13): `apiKeyStore` must export `VerifiedKey` + `Capability` and `verify` must return
  the full scope. **Base branch:** cleanest is to **merge P0 (#12) + P1 (#13) to `main` first, then branch
  `feat/byoa-p2a-scope` off `main`**; alternative is to stack `feat/byoa-p2a-scope` on `feat/byoa-p1-connect`.
  Either way the P1 key-scope code MUST be present, or Task 1/2 won't compile.
- **Capability ladder:** `read < earn < spend` (a `spend` key can also earn + read; an `earn` key can read).
  `hasCapability(scope, needed)` = `level(scope.capability) >= level(needed)`.
- **Entity scope:** a key with a non-null `entityId` may operate ONLY that entity; a null `entityId`
  (tenant-wide key) may operate any of its tenant's entities. Ownership (`ownerTenantId === tenantId`) is
  always also checked.
- **Reads need no capability gate** (read is the floor — every valid key can read); they DO enforce entity
  scope + ownership. Capability gating of `pay` (spend) / `run_job` (earn) is P2b/P2c.
- **Additive / no regressions:** the existing MCP tools (`whoami`, `list_entities`, `get_entity`,
  `fund_treasury`, `onboard_agent`) keep working — they just read `scope.tenantId` instead of a bare
  `tenantId`. All current MCP tests stay green.
- **Never leak keys**; **stage specific files** (`git add <path>`), not `git add -A`.
- **Green gate:** `npm run lint && npm run typecheck && npm test`. Run from `back/backend/`.

---

## File Structure

- `src/mcp/scope.ts` (**new**) — `hasCapability` + `entityInScope` (pure; import `Capability`/`VerifiedKey`).
- `src/mcp/auth.ts` (**modify**) — add `resolveKey(authHeader, apiKeys): VerifiedKey | null` (keep `resolveTenant`).
- `src/mcp/server.ts` (**modify**) — `buildMcpServer(scope, deps)`; `McpToolDeps` gains `jobs: JobRepository`;
  existing tools use `scope.tenantId`; add `get_job` + `list_jobs`.
- `src/mcp/transport.ts` (**modify**) — resolve the full key; pass `scope` + `deps.jobs` to `buildMcpServer`.

---

### Task 1: `scope.ts` — capability ladder + entity-scope helpers

**Files:**
- Create: `src/mcp/scope.ts`
- Test: `test/mcp/scope.test.ts`

**Interfaces:**
- Produces: `hasCapability(scope: { capability: Capability }, needed: Capability): boolean`;
  `entityInScope(scope: { entityId: string | null }, id: string): boolean`.

- [ ] **Step 1: Write the failing test** — `test/mcp/scope.test.ts`:

```ts
import { expect, test } from "vitest";
import { entityInScope, hasCapability } from "../../src/mcp/scope";

test("capability ladder: read < earn < spend", () => {
  expect(hasCapability({ capability: "read" }, "read")).toBe(true);
  expect(hasCapability({ capability: "read" }, "earn")).toBe(false);
  expect(hasCapability({ capability: "read" }, "spend")).toBe(false);
  expect(hasCapability({ capability: "earn" }, "read")).toBe(true);
  expect(hasCapability({ capability: "earn" }, "earn")).toBe(true);
  expect(hasCapability({ capability: "earn" }, "spend")).toBe(false);
  expect(hasCapability({ capability: "spend" }, "spend")).toBe(true);
  expect(hasCapability({ capability: "spend" }, "read")).toBe(true);
});

test("entity scope: null = any owned entity; scoped = only that entity", () => {
  expect(entityInScope({ entityId: null }, "ent-A")).toBe(true);
  expect(entityInScope({ entityId: "ent-A" }, "ent-A")).toBe(true);
  expect(entityInScope({ entityId: "ent-A" }, "ent-B")).toBe(false);
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/mcp/scope.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `src/mcp/scope.ts`:

```ts
import type { Capability } from "../persistence/apiKeyStore";

const LEVEL: Record<Capability, number> = { read: 0, earn: 1, spend: 2 };

/** A key's capability grants that action and all lower ones (read < earn < spend). */
export function hasCapability(scope: { capability: Capability }, needed: Capability): boolean {
  return LEVEL[scope.capability] >= LEVEL[needed];
}

/** A key scoped to a single entity (entityId != null) may operate ONLY that entity; a tenant-wide key
 *  (entityId == null) may operate any of its tenant's entities. Ownership is checked separately. */
export function entityInScope(scope: { entityId: string | null }, id: string): boolean {
  return scope.entityId === null || scope.entityId === id;
}
```

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/mcp/scope.test.ts` → PASS (2 tests).

- [ ] **Step 5: Commit** — `git add src/mcp/scope.ts test/mcp/scope.test.ts && git commit -m "feat(mcp): capability-ladder + entity-scope helpers"`

---

### Task 2: `resolveKey` — surface the full key scope in MCP auth

**Files:**
- Modify: `src/mcp/auth.ts`
- Test: `test/mcp/auth.test.ts` (create if absent; else append)

**Interfaces:**
- Consumes: `ApiKeyStore.verify` (P1) → `VerifiedKey | null`.
- Produces: `resolveKey(authHeader: string | undefined, apiKeys: ApiKeyStore): VerifiedKey | null`.

- [ ] **Step 1: Write the failing test** — `test/mcp/auth.test.ts` (build a real `SqliteApiKeyStore` in `:memory:` and mint a scoped key):

```ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { resolveKey } from "../../src/mcp/auth";

function store() {
  const db = new Database(":memory:");
  migrate(db);
  return new SqliteApiKeyStore(db);
}

test("resolveKey returns the full scope for a valid Bearer key", () => {
  const s = store();
  const { key } = s.mint("tenantA", { entityId: "ent-1", capability: "spend" });
  expect(resolveKey(`Bearer ${key}`, s)).toEqual({ tenantId: "tenantA", id: expect.any(String), entityId: "ent-1", capability: "spend" });
});

test("resolveKey returns null for missing/malformed/invalid auth", () => {
  const s = store();
  expect(resolveKey(undefined, s)).toBeNull();
  expect(resolveKey("Basic xyz", s)).toBeNull();
  expect(resolveKey("Bearer not-a-key", s)).toBeNull();
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/mcp/auth.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/mcp/auth.ts`, keep `resolveTenant` and add:

```ts
import type { ApiKeyStore, VerifiedKey } from "../persistence/apiKeyStore";

/** Resolve `Authorization: Bearer <mcp key>` to the full verified key scope, or null. */
export function resolveKey(authHeader: string | undefined, apiKeys: ApiKeyStore): VerifiedKey | null {
  const [scheme, token] = (authHeader ?? "").split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return apiKeys.verify(token) ?? null;
}
```

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/mcp/auth.test.ts` → PASS (2 tests).

- [ ] **Step 5: Commit** — `git add src/mcp/auth.ts test/mcp/auth.test.ts && git commit -m "feat(mcp): resolveKey surfaces the full key scope"`

---

### Task 3: Thread `scope` + `jobs` through `buildMcpServer` + transport

**Files:**
- Modify: `src/mcp/server.ts` (signature + `McpToolDeps`; existing tools use `scope.tenantId`)
- Modify: `src/mcp/transport.ts` (resolve the full key; pass `scope` + `deps.jobs`)
- Test: the existing MCP server/e2e tests (find them, e.g. `test/mcp/*.test.ts`) must stay green; add a small
  scope-passing assertion.

**Interfaces:**
- Consumes: `resolveKey` (Task 2), `VerifiedKey`, `JobRepository`.
- Produces: `buildMcpServer(scope: VerifiedKey, deps: McpToolDeps): McpServer`;
  `McpToolDeps` gains `jobs: JobRepository`.

- [ ] **Step 1: Update the signature + deps.** In `src/mcp/server.ts`:
  - Add to `McpToolDeps`: `jobs: JobRepository;` (import `type { JobRepository } from "../jobs/jobRepository"`).
  - Change `export function buildMcpServer(tenantId: string, deps: McpToolDeps)` to
    `export function buildMcpServer(scope: VerifiedKey, deps: McpToolDeps)` (import
    `type { VerifiedKey } from "../persistence/apiKeyStore"`), and at the top add `const tenantId = scope.tenantId;`
    so the existing five tools keep referencing `tenantId` unchanged (minimal diff; the new tools use `scope`).

- [ ] **Step 2: Update transport.** In `src/mcp/transport.ts`, replace the `resolveTenant` block:
```ts
import { resolveKey } from "./auth";
// …
const scope = resolveKey(c.req.header("authorization"), deps.apiKeys);
if (!scope)
  return c.json({ error: { code: "unauthorized", message: "invalid api key" } }, 401);
const server = buildMcpServer(scope, {
  repo: deps.repo,
  runner: deps.runner,
  passkeys: deps.passkeys,
  jobs: deps.jobs,
});
```
(`deps.jobs` already exists on `ApiDeps` — the reputation route uses it.)

- [ ] **Step 3: Run the existing MCP tests + typecheck.** `npm run typecheck && npx vitest run test/mcp` →
  all existing MCP tests PASS (the tools still resolve `tenantId` via `scope.tenantId`; the anvil e2e test
  that mints a key + onboards still works because `resolveKey` accepts the same keys). Fix any test that
  constructed `buildMcpServer(tenantId, …)` directly — update it to pass a `VerifiedKey`
  (`{ tenantId, id: "test", entityId: null, capability: "spend" }`).

- [ ] **Step 4: Full gate** — `npm run lint && npm run typecheck && npm test` → all PASS.

- [ ] **Step 5: Commit** — `git add src/mcp/server.ts src/mcp/transport.ts test/mcp/ && git commit -m "feat(mcp): thread key scope + jobs repo through buildMcpServer"`

---

### Task 4: `get_job` + `list_jobs` read tools (scope-enforced)

**Files:**
- Modify: `src/mcp/server.ts` (register the two tools)
- Test: `test/mcp/readTools.test.ts`

**Interfaces:**
- Consumes: `deps.jobs.findByKey`/`listByEntity`, `toJobView` (`src/api/jobViews.ts`), `entityInScope` (Task 1).
- Produces: MCP tools `get_job({ jobKey })` and `list_jobs({ id })`, tenant + entity scoped.

- [ ] **Step 1: Write the failing test** — `test/mcp/readTools.test.ts`. Build the server with an in-memory
  `SqliteJobRepository` seeded with a couple of `JobRecord`s (mirror how an existing jobs test constructs a
  `JobRecord`; set `ownerTenantId` + `entityKey`). Call the tools directly on the built server (or via the
  registered-tool callback the other MCP tests use) and assert:

```ts
// scope = { tenantId: "tenantA", id: "k", entityId: null, capability: "read" }
// jobs repo has: job "j1" (ownerTenantId "tenantA", entityKey "tenantA:agent1"),
//                job "j2" (ownerTenantId "tenantB", entityKey "tenantB:x")
// get_job("j1") → returns the view; get_job("j2") → "job not found"; get_job("nope") → "job not found"
// list_jobs("tenantA:agent1") → [j1]; 
// with an ENTITY-SCOPED key {entityId:"tenantA:agent1"}: list_jobs("tenantA:other") → rejected (out of scope)
```
(Assert the tool returns the `toJobView` shape for allowed cases and a uniform "not found"/error for
denied/cross-tenant/out-of-scope cases — no existence oracle.)

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/mcp/readTools.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/mcp/server.ts`, add these two tools (after `get_entity`), importing
  `import { entityInScope } from "./scope"` and `import { toJobView } from "../api/jobViews"` and `z`:

```ts
server.registerTool(
  "get_job",
  { title: "Get job", description: "Fetch one job by jobKey (owned by you).", inputSchema: { jobKey: z.string() } },
  async ({ jobKey }) => {
    const rec = deps.jobs.findByKey(jobKey);
    if (!rec || rec.ownerTenantId !== scope.tenantId || !entityInScope(scope, rec.entityKey))
      return { content: [{ type: "text", text: "job not found" }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(toJobView(rec)) }] };
  },
);

server.registerTool(
  "list_jobs",
  { title: "List jobs", description: "List jobs for one of your entities (id = entity idempotency key).", inputSchema: { id: z.string() } },
  async ({ id }) => {
    if (!entityInScope(scope, id))
      return { content: [{ type: "text", text: "entity not in this key's scope" }], isError: true };
    const views = deps.jobs
      .listByEntity(id)
      .filter((j) => j.ownerTenantId === scope.tenantId)
      .map(toJobView);
    return { content: [{ type: "text", text: JSON.stringify(views) }] };
  },
);
```
(No capability gate — reads are the floor. Ownership + entity scope both enforced; the "not found" text is
uniform for missing / cross-tenant / out-of-scope so there's no existence oracle, matching `get_entity`.)

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/mcp/readTools.test.ts` → PASS.

- [ ] **Step 5: Full gate** — `npm run lint && npm run typecheck && npm test` → all PASS.

- [ ] **Step 6: Commit** — `git add src/mcp/server.ts test/mcp/readTools.test.ts && git commit -m "feat(mcp): get_job + list_jobs read tools (scope-enforced)"`

---

## After this slice

P2a gives every MCP tool the caller's `{tenantId, entityId, capability}` scope + the `hasCapability` /
`entityInScope` helpers, and lets a linked agent inspect its jobs. **P2b (`pay`)** then adds the governed
x402 spend (requires `hasCapability(scope, "spend")` + `entityInScope`, plus SSRF guard / hybrid allowlist /
idempotency / `treasury_status`), and **P2c (`run_job`)** adds earning (requires `hasCapability(scope,
"earn")`). Both reuse the helpers defined here.

> ⚠️ **P2b/P2c ORDERING PREREQUISITE (from the P2a whole-branch review).** The five pre-existing acting
> tools (`whoami`/`list_entities`/`get_entity`/`fund_treasury`/`onboard_agent`) currently enforce ONLY
> `tenantId` and ignore `scope.entityId`/`scope.capability`. This is safe today only because `POST
> /api-keys` always mints tenant-wide keys (`{entityId: null, capability: "spend"}`) — entity-scoped keys
> are not yet mintable over the API. Before ANY change widens the mint surface to issue entity/capability-
> scoped keys, `fund_treasury` and `onboard_agent` MUST first be gated with `entityInScope` +
> `hasCapability` — otherwise a nominally "read-only, entity-A" key would silently retain treasury-funding /
> onboarding power over the whole tenant. Gate the acting tools BEFORE exposing scoped minting; never the
> reverse.

## Self-Review

**Spec coverage:** design §14.2 "keys scoped to a single entityId + capability, enforced" → Tasks 1–3 wire
the scope in + define the enforcement helpers; the read tools (§4.3) → Task 4. Capability *enforcement on
acting tools* is P2b/P2c (this slice is scope plumbing + reads). ✓
**Placeholders:** every code step is complete; the Task-4 test sketch names exact records/assertions and
mirrors an existing jobs test's `JobRecord` construction (a real instruction, not a TBD). ✓
**Type consistency:** `Capability` / `VerifiedKey` imported from `apiKeyStore` and used identically in
`scope.ts`, `auth.ts`, `server.ts`; `buildMcpServer(scope, deps)` + `McpToolDeps.jobs` consistent between
Tasks 3 & 4; `hasCapability`/`entityInScope` signatures match their tests. ✓
**Dependency:** requires P1's `apiKeyStore` (VerifiedKey + Capability) — stated in Global Constraints. ✓
