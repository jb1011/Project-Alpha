# BYOA P3 — Agent-first magic-link bootstrap (+ `claim_connection`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let a human bootstrap a body-less connection in one browser step (SIWE login + guardian passkey),
then have their agent drive onboarding *and* operation from a prompt. Backend delivers: a one-time, TTL-bound
**link_code** store; a **`POST /bootstrap-connection`** endpoint that mints a tenant-wide operating key +
issues a link_code + returns the guardian passkey handle (so the agent can `onboard_agent`); and a
**`claim_connection`** MCP tool the agent calls to confirm it was intentionally linked to the right body.

**Architecture:** The audit-Critical "magic-link binding" (§14.2) is enforced on the backend: the token's
tenant is the **SIWE-derived `tenantId`** (from `requireAuth`, never an agent-supplied value); the link_code
is **high-entropy, single-use (atomic consume), short-TTL, tenant-scoped** (mirrors the existing
`SqliteChallengeStore`); `claim_connection` **returns a binding confirmation, not the key** (the API key is
already the agent's auth); responses that carry a key set `no-store` / `no-referrer`. The completion page,
human-readable authorization confirmation, and copy-once UI are the **frontend colleague's** scope.

**Tech Stack:** TypeScript, Hono, `@modelcontextprotocol/sdk`, better-sqlite3, vitest, Biome (no build step).

## Global Constraints

- **Depends on** the existing auth (`requireAuth` → `c.get("tenantId")`), `apiKeyStore.mint` (tenant-wide when
  `entityId` omitted), `passkeyStore` (`store`/`get`), `repo.listByTenant`, `buildSnippets`, and P2a's
  `scope`/`entityInScope`. All on `main`. Branch P3 off `main`.
- **Magic-link binding (§14.2, audit-Critical):** link_code = `randomBytes(32).toString("base64url")`,
  single-use (deleted on consume), short-TTL, tenant-scoped, never logged / never in a query string. The
  bootstrap endpoint's `tenantId` comes ONLY from `requireAuth` (SIWE session), never the request body.
- **`claim_connection` returns a confirmation, not the key.** It consumes the link_code scoped to the
  caller's `scope.tenantId` and returns `{ tenantId, entities, bound: true }` — no key, no secret.
- **No-store headers:** any response carrying a freshly-minted API key (`/bootstrap-connection` AND the
  existing `/connection-package`) sets `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- **Tenant isolation:** the bootstrap key is minted for the SIWE tenant; `passkeyId` must belong to that
  tenant (uniform 404 if not); `claim_connection`'s link_code must belong to the caller's tenant (uniform
  "invalid or expired link code" otherwise — no oracle).
- **Additive / no regressions.** Gate: `npm run lint && npm run typecheck && npm test` from `back/backend/`.

## v1 decisions (locked)
- **Bootstrap key** = **tenant-wide** (`entityId` null) + capability **`spend`** by default (full-operate so
  the agent can `onboard_agent` + operate), revocable, no TTL on the key itself. (The *link_code* is the
  short-TTL single-use element, not the key.)
- **link_code TTL** = 15 minutes (`LINK_CODE_TTL_MS = 15 * 60_000`), a const for v1.
- **`claim_connection`** needs no capability gate — the link_code tenant-match IS the gate (read is the floor).

---

## File Structure

- `src/persistence/linkCodeStore.ts` (**new**) + `src/persistence/db.ts` (**modify**, `link_codes` table) — T1.
- `src/api/routes/connection.ts` (**modify**) — add `POST /bootstrap-connection`; add no-store headers to both
  responses — T2. `src/api/app.ts` (**modify**) — mount behind `requireAuth`; `ApiDeps` gains `linkCodes`.
  `src/api/main.ts` (**modify**) — construct `SqliteLinkCodeStore`.
- `src/mcp/server.ts` + `src/mcp/transport.ts` (**modify**) — `McpToolDeps` gains `linkCodes`; register
  `claim_connection` — T3.

---

### Task 1: One-time link_code store

**Files:** Create `src/persistence/linkCodeStore.ts`; Modify `src/persistence/db.ts`; Test
`test/persistence/linkCodeStore.test.ts`.

**Interfaces:** Produces `LinkCodeStore { issue(tenantId, now, ttlMs): string; consume(tenantId, code, now):
boolean }` + `SqliteLinkCodeStore`.

- [ ] **Step 1: Write the failing test** — `test/persistence/linkCodeStore.test.ts` (mirror
  `test/persistence/challengeStore.test.ts` if it exists):
```ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteLinkCodeStore } from "../../src/persistence/linkCodeStore";

function store() { const db = new Database(":memory:"); migrate(db); return new SqliteLinkCodeStore(db); }

test("issue then consume once (single-use, tenant-scoped)", () => {
  const s = store();
  const code = s.issue("0xTENANT", 1000, 60_000);
  expect(s.consume("0xTENANT", code, 2000)).toBe(true);   // first consume ok
  expect(s.consume("0xTENANT", code, 2000)).toBe(false);  // single-use: gone
});
test("wrong tenant cannot consume, and does not burn the code", () => {
  const s = store();
  const code = s.issue("0xTENANT", 1000, 60_000);
  expect(s.consume("0xOTHER", code, 2000)).toBe(false);   // not your tenant
  expect(s.consume("0xTENANT", code, 2000)).toBe(true);   // still valid for the owner
});
test("expired code does not consume", () => {
  const s = store();
  const code = s.issue("0xTENANT", 1000, 60_000);
  expect(s.consume("0xTENANT", code, 1000 + 60_001)).toBe(false); // past expiry
});
```

- [ ] **Step 2: Run, expect fail** → FAIL.

- [ ] **Step 3: Implement** — in `src/persistence/db.ts` `migrate`, add (in the shared `db.exec` block):
```sql
CREATE TABLE IF NOT EXISTS link_codes (
  code TEXT PRIMARY KEY,
  owner_tenant TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```
  Then `src/persistence/linkCodeStore.ts` (mirror `SqliteChallengeStore` exactly — same single-use/
  tenant-scoped/atomic-delete semantics):
```ts
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

export interface LinkCodeStore {
  issue(tenantId: string, now: number, ttlMs: number): string;
  consume(tenantId: string, code: string, now: number): boolean;
}

/** Single-use, TTL-bounded, tenant-scoped agent-first bootstrap link codes. */
export class SqliteLinkCodeStore implements LinkCodeStore {
  constructor(private readonly db: Database.Database) {}

  issue(tenantId: string, now: number, ttlMs: number): string {
    const code = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO link_codes (code, owner_tenant, issued_at, expires_at) VALUES (?,?,?,?)")
      .run(code, tenantId, now, now + ttlMs);
    return code;
  }

  /** True iff the code existed for this tenant and was unexpired; deletes it if the tenant matches
   *  (single-use, so a wrong-tenant attempt never burns the owner's code). */
  consume(tenantId: string, code: string, now: number): boolean {
    const row = this.db
      .prepare("SELECT owner_tenant, expires_at FROM link_codes WHERE code = ?")
      .get(code) as { owner_tenant: string; expires_at: number } | undefined;
    if (row && row.owner_tenant === tenantId) {
      this.db.prepare("DELETE FROM link_codes WHERE code = ?").run(code);
      return row.expires_at > now;
    }
    return false;
  }
}
```

- [ ] **Step 4: Run, expect pass** → PASS.

- [ ] **Step 5: Commit** — `git add src/persistence/linkCodeStore.ts src/persistence/db.ts test/persistence/linkCodeStore.test.ts && git commit -m "feat(persistence): one-time tenant-scoped link_code store (agent-first bootstrap)"`

---

### Task 2: `POST /bootstrap-connection` endpoint (+ no-store headers)

**Files:** Modify `src/api/routes/connection.ts`, `src/api/app.ts`, `src/api/main.ts`; Test
`test/api/bootstrapConnection.route.test.ts`.

**Interfaces:** Consumes `requireAuth` tenantId, `deps.passkeys.get`, `deps.apiKeys.mint`,
`deps.linkCodes.issue`, `buildSnippets`. Produces `POST /bootstrap-connection` → `{ mcpUrl, apiKey,
passkeyId, capability, linkCode, snippets }` with `Cache-Control: no-store` + `Referrer-Policy: no-referrer`.
`ApiDeps` gains `linkCodes: LinkCodeStore`.

- [ ] **Step 1: Write the failing test** — `test/api/bootstrapConnection.route.test.ts`. Mirror
  `test/api/connection.route.test.ts`'s harness (build the app, SIWE-login helper to get a JWT, real stores).
  Register a guardian passkey first (`deps.passkeys.store(tenantId, ...)` directly, or via `POST /passkey`) to
  get a `passkeyId`. Assert:
  - authed `POST /bootstrap-connection { passkeyId }` → 200 with `{ mcpUrl, apiKey, passkeyId, capability:
    "spend", linkCode, snippets }`; `apiKey` verifies to a **tenant-wide** key (`apiKeys.verify(apiKey)`
    returns `entityId: null`); response headers include `cache-control: no-store` and
    `referrer-policy: no-referrer`; `linkCode` is a non-empty string.
  - a `passkeyId` not owned by the tenant → 404 uniform "passkey not found", no key minted.
  - no auth → 401.
  - (regression) the existing `/connection-package` response now also carries `cache-control: no-store`.

- [ ] **Step 2: Run, expect fail** → FAIL.

- [ ] **Step 3: Implement**
  - `src/api/routes/connection.ts`: add a `no-store` helper and apply it to BOTH responses; add the new route:
```ts
const LINK_CODE_TTL_MS = 15 * 60_000;
function noStore(c: Context) { c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer"); }

const BootstrapSchema = z.object({ passkeyId: z.string().min(1), capability: z.enum(["read","earn","spend"]).default("spend") });

app.post("/bootstrap-connection", async (c) => {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new ApiError("validation_error", 400, "invalid JSON body"); }
  const { passkeyId, capability } = BootstrapSchema.parse(raw);
  const tenantId = c.get("tenantId");
  if (!deps.passkeys.get(tenantId, passkeyId))
    throw new ApiError("not_found", 404, "passkey not found"); // uniform (no exists-but-not-yours leak)
  const { key } = deps.apiKeys.mint(tenantId, { capability, label: `bootstrap:${passkeyId}` }); // entityId omitted → tenant-wide
  const linkCode = deps.linkCodes.issue(tenantId, Date.now(), LINK_CODE_TTL_MS);
  noStore(c);
  return c.json({
    mcpUrl: deps.mcpPublicUrl, apiKey: key, passkeyId, capability, linkCode,
    snippets: buildSnippets({ mcpUrl: deps.mcpPublicUrl, apiKey: key }),
  });
});
```
    In the existing `/connection-package` handler, call `noStore(c)` right before `return c.json(...)`.
    (Import `Context` from `hono`.)
  - `src/api/app.ts`: `ApiDeps` gains `linkCodes: import("../persistence/linkCodeStore").LinkCodeStore;`. The
    connection routes already mount behind `app.use("/connection-package", requireAuth(...))`; add
    `app.use("/bootstrap-connection", requireAuth(deps.jwtSecret));` next to it so the new route is
    SIWE-authed.
  - `src/api/main.ts`: construct `linkCodes: new SqliteLinkCodeStore(db)` (same `db`) and pass it into the
    deps object.

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/api/bootstrapConnection.route.test.ts` + the full
  API suite → PASS.

- [ ] **Step 5: Full gate + commit** — `git add src/api/routes/connection.ts src/api/app.ts src/api/main.ts test/api/bootstrapConnection.route.test.ts && git commit -m "feat(api): POST /bootstrap-connection (agent-first: tenant-wide key + link_code + passkey handle) + no-store headers"`

---

### Task 3: `claim_connection` MCP tool

**Files:** Modify `src/mcp/server.ts`, `src/mcp/transport.ts`; Test `test/mcp/claimConnection.int.test.ts`.

**Interfaces:** `McpToolDeps` gains `linkCodes: LinkCodeStore`; `transport.ts` threads it. Tool
`claim_connection({ linkCode })` → `{ tenantId, entities, bound: true }` on success (consumes the code).

- [ ] **Step 1: Write the failing test** — `test/mcp/claimConnection.int.test.ts`. Mirror
  `test/mcp/tools.read.int.test.ts` harness, passing a real `SqliteLinkCodeStore(db)` in the `buildApiApp`
  deps. Seed an entity owned by TENANT. Assert:
  - **happy:** `linkCodes.issue(TENANT, Date.now(), 60_000)` → `code`; a TENANT key calls
    `claim_connection({ linkCode: code })` → returns `{ tenantId: TENANT, entities: [<the seeded entity view>],
    bound: true }`; a SECOND `claim_connection` with the same code → "invalid or expired link code" (single-use
    consumed).
  - **cross-tenant:** a code issued for `OTHER_TENANT` + a TENANT key → "invalid or expired link code"
    (uniform), and the code is NOT burned (the owner could still use it).
  - **unknown/expired code** → "invalid or expired link code".

- [ ] **Step 2: Run, expect fail** → FAIL.

- [ ] **Step 3: Implement**
  - `src/mcp/server.ts`: add `linkCodes: import("../persistence/linkCodeStore").LinkCodeStore;` to
    `McpToolDeps`; register `claim_connection` (after `whoami`, since it's an identity/confirmation tool):
```ts
server.registerTool(
  "claim_connection",
  {
    title: "Claim connection",
    description:
      "Confirm this agent was intentionally linked to your legal body: submit the one-time link code from " +
      "the bootstrap page. Returns your tenant + entities (a binding confirmation, not a key).",
    inputSchema: { linkCode: z.string() },
  },
  async ({ linkCode }) => {
    if (!deps.linkCodes.consume(scope.tenantId, linkCode, Date.now()))
      return { content: [{ type: "text", text: "invalid or expired link code" }], isError: true };
    const entities = repo.listByTenant(scope.tenantId).map(toEntityView);
    return { content: [{ type: "text", text: JSON.stringify({ tenantId: scope.tenantId, entities, bound: true }) }] };
  },
);
```
    (`toEntityView` is already imported in server.ts; no capability gate — the tenant-scoped `consume` is the
    gate.)
  - `src/mcp/transport.ts`: add `linkCodes: deps.linkCodes` to the `buildMcpServer(scope, {...})` deps object.
    (`ApiDeps.linkCodes` exists from T2; the composition root provides it.)

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/mcp/claimConnection.int.test.ts` + full MCP suite → PASS.

- [ ] **Step 5: Full gate + commit** — `git add src/mcp/server.ts src/mcp/transport.ts test/mcp/claimConnection.int.test.ts && git commit -m "feat(mcp): claim_connection tool (consume one-time link code, return binding confirmation)"`

---

## After this slice

P3 gives the agent-first entry path end to end (backend): a human bootstraps once (SIWE + passkey), the agent
gets a tenant-wide operating key + the guardian passkey handle + a link_code, calls `claim_connection` to
confirm the binding, then drives `onboard_agent` → the full operate surface. Remaining BYOA work: **P4**
(snippet breadth beyond the current 6 + docs for both entry paths). Carried fast-follows unchanged (P2b ledger
`runningPending`/`markSettled` pre-prod; signed evaluator seam; `get_entity` `entityInScope`). Frontend
(colleague): the bootstrap page + human-readable authorization confirmation + copy-once key UI.

## Self-Review

**Spec coverage:** §14.2 magic-link binding (tenant from SIWE → T2 uses `requireAuth` tenantId; single-use/
TTL/high-entropy/atomic token → T1; `claim_connection` returns confirmation-not-key → T3; no-store/no-referrer
→ T2) + §4.3 `claim_connection` + §5 connection package (agent-first: key + passkey_id, entity absent) → T2/T3.
Frontend parts (completion page, human-readable confirmation, copy-once) explicitly out of backend scope. ✓
**Placeholders:** T1 is complete code (mirrors `SqliteChallengeStore`); T2/T3 give the full handler/tool code;
tests name exact assertions. ✓
**Type consistency:** `LinkCodeStore { issue, consume }` used identically in T1/T2/T3; `ApiDeps.linkCodes` →
`McpToolDeps.linkCodes` → transport consistent; `apiKeys.mint(tenantId, {capability, label})` (entityId
omitted → tenant-wide) matches the P1 `MintOpts`; `repo.listByTenant`/`toEntityView` as used elsewhere in
server.ts. ✓
**Security check:** link_code never returned by `claim_connection`; tenant always from SIWE / `scope.tenantId`,
never a body arg; wrong-tenant consume never burns the owner's code (T1 asserts). ✓
