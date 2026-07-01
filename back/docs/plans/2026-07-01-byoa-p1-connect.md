# BYOA P1 — Connect (web-first) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the backend for "Connect your agent" (BYOA design §3.1 / Slice 1): mint an **entity-scoped,
capability-scoped, TTL-bounded** API key for an already-onboarded legal body, assemble the **connection
package** (MCP URL + key + entity id), and generate **per-agent paste-in snippets** (Claude Code flagship +
Cursor / Codex / OpenClaw / Gemini / generic).

**Architecture:** Extends the existing `SqliteApiKeyStore` (today tenant-scoped only) with optional
`entity_id` / `capability` / `expires_at` columns — backward-compatible (NULL entity = tenant-wide, today's
behavior). A new `POST /connection-package` route (behind SIWE/JWT) verifies the caller owns the target
entity, mints a scoped key, and returns the package + snippets. A pure `buildSnippets` function turns the
package into per-agent config strings. **Capability ENFORCEMENT on MCP operate tools is P2, not P1** — P1
only mints + stores the scope so P2 can enforce it.

**Tech Stack:** TypeScript, Hono, better-sqlite3, viem, zod, vitest, Biome (no build step, tsx). The
frontend "Connect your agent" screen is the colleague's — out of scope here (§10 of the design).

## Global Constraints

- **Branch:** `feat/byoa-p1-connect` off `main` (P0 is in PR #12; base this on `main` so it's independent).
- **Backward-compatible:** the existing `POST /api-keys` route + `resolveTenant` keep working unchanged —
  new columns are nullable; `mint` keeps its `(tenantId, label?)` behavior via an options object.
- **`capability` is `"read" | "earn" | "spend"`**, default `"spend"` (full). Stored in P1; enforced in P2.
- **Never log or leak** a plaintext key; it is returned exactly once (like today). sha-256 hash at rest.
- **Ownership is mandatory:** `/connection-package` mints a key for `entityId` ONLY if the entity's
  `ownerTenantId === tenantId` (mirror `get_entity`'s check); otherwise a uniform 404.
- **Lint/typecheck/tests green:** `npm run lint && npm run typecheck && npm test`. Run from `back/backend/`.
- **Stage specific files** (`git add <path>`), never `git add -A`.

---

## File Structure

- `src/persistence/db.ts` (**modify**) — additive nullable columns on `api_keys`: `entity_id`, `capability`, `expires_at`.
- `src/persistence/apiKeyStore.ts` (**modify**) — `mint(tenantId, opts?)`; `verify` enforces expiry + returns scope; `MintOpts`/`VerifiedKey` types.
- `src/mcp/snippets.ts` (**new**) — `buildSnippets({mcpUrl, apiKey})`: per-agent config strings.
- `src/config/env.ts` (**modify**) — `MCP_PUBLIC_URL` → `Config.mcpPublicUrl`.
- `src/api/routes/connection.ts` (**new**) — `POST /connection-package`.
- `src/api/app.ts` (**modify**) — mount the connection route; ensure `ApiDeps` exposes `repo`, `apiKeys`, `mcpPublicUrl`.

---

### Task 1: Entity/capability/TTL scope on API keys

**Files:**
- Modify: `src/persistence/db.ts` (the `api_keys` table in `migrate`)
- Modify: `src/persistence/apiKeyStore.ts`
- Test: `test/persistence/apiKeyStore.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `interface MintOpts { label?: string; entityId?: string; capability?: "read"|"earn"|"spend"; ttlMs?: number }`;
  `mint(tenantId: string, opts?: MintOpts): { id: string; key: string }`;
  `interface VerifiedKey { tenantId: string; id: string; entityId: string | null; capability: "read"|"earn"|"spend" }`;
  `verify(key: string): VerifiedKey | null` (null when expired/revoked/absent).

- [ ] **Step 1: Add the migration.** In `src/persistence/db.ts` `migrate`, after the `api_keys` table exists,
  add additive columns guarded like the other additive migrations in this file (mirror the existing
  `if (!cols.includes(...)) db.exec("ALTER TABLE ... ADD COLUMN ...")` pattern; find it for `entities`):

```ts
const akCols = db.prepare("PRAGMA table_info(api_keys)").all().map((c: any) => c.name);
if (!akCols.includes("entity_id")) db.exec("ALTER TABLE api_keys ADD COLUMN entity_id TEXT");
if (!akCols.includes("capability")) db.exec("ALTER TABLE api_keys ADD COLUMN capability TEXT");
if (!akCols.includes("expires_at")) db.exec("ALTER TABLE api_keys ADD COLUMN expires_at INTEGER");
```

- [ ] **Step 2: Write the failing test** — `test/persistence/apiKeyStore.test.ts`:

```ts
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";

function store() {
  const db = new Database(":memory:");
  migrate(db);
  return new SqliteApiKeyStore(db);
}

test("mint scoped to an entity + capability round-trips via verify", () => {
  const s = store();
  const { key } = s.mint("tenantA", { entityId: "ent-1", capability: "spend" });
  const v = s.verify(key);
  expect(v).toEqual({ tenantId: "tenantA", id: expect.any(String), entityId: "ent-1", capability: "spend" });
});

test("verify rejects an expired key", () => {
  const s = store();
  const { key } = s.mint("tenantA", { ttlMs: -1 }); // already expired
  expect(s.verify(key)).toBeNull();
});

test("mint with no opts stays tenant-wide with default capability (back-compat)", () => {
  const s = store();
  const { key } = s.mint("tenantA");
  expect(s.verify(key)).toEqual({ tenantId: "tenantA", id: expect.any(String), entityId: null, capability: "spend" });
});
```

- [ ] **Step 3: Run, expect fail** — `npx vitest run test/persistence/apiKeyStore.test.ts` → FAIL.

- [ ] **Step 4: Implement** — rewrite `src/persistence/apiKeyStore.ts`'s interface + class:

```ts
export type Capability = "read" | "earn" | "spend";
export interface MintOpts { label?: string; entityId?: string; capability?: Capability; ttlMs?: number }
export interface VerifiedKey { tenantId: string; id: string; entityId: string | null; capability: Capability }

export interface ApiKeyStore {
  mint(tenantId: string, opts?: MintOpts): { id: string; key: string };
  verify(key: string): VerifiedKey | null;
  list(tenantId: string): ApiKeyView[];
  revoke(tenantId: string, id: string): boolean;
}
```
In `SqliteApiKeyStore.mint`:
```ts
mint(tenantId: string, opts: MintOpts = {}): { id: string; key: string } {
  const id = randomUUID();
  const key = `mcp_${randomBytes(32).toString("base64url")}`;
  const expiresAt = opts.ttlMs !== undefined ? Date.now() + opts.ttlMs : null;
  this.db
    .prepare(
      "INSERT INTO api_keys (id, owner_tenant, hash, label, created_at, entity_id, capability, expires_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(id, tenantId, hashKey(key), opts.label ?? null, Date.now(), opts.entityId ?? null, opts.capability ?? "spend", expiresAt);
  return { id, key };
}
```
In `verify` (enforce expiry, return scope):
```ts
verify(key: string): VerifiedKey | null {
  const row = this.db
    .prepare("SELECT id, owner_tenant, entity_id, capability, expires_at FROM api_keys WHERE hash = ? AND revoked_at IS NULL")
    .get(hashKey(key)) as { id: string; owner_tenant: string; entity_id: string | null; capability: string | null; expires_at: number | null } | undefined;
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at <= Date.now()) return null;
  return { tenantId: row.owner_tenant, id: row.id, entityId: row.entity_id, capability: (row.capability as Capability) ?? "spend" };
}
```
(`list`/`revoke` unchanged. `resolveTenant` in `mcp/auth.ts` still compiles — it reads `.tenantId` off the result.)

- [ ] **Step 5: Run + full gate** — `npx vitest run test/persistence/apiKeyStore.test.ts && npm run typecheck && npm run lint && npm test` → all PASS.

- [ ] **Step 6: Commit** — `git add src/persistence/db.ts src/persistence/apiKeyStore.ts test/persistence/apiKeyStore.test.ts && git commit -m "feat(apikey): entity + capability + TTL scope (back-compat, enforced later)"`

---

### Task 2: Per-agent snippet generator

**Files:**
- Create: `src/mcp/snippets.ts`
- Test: `test/mcp/snippets.test.ts`

**Interfaces:**
- Produces: `buildSnippets(p: { mcpUrl: string; apiKey: string }): Record<"claudeCode"|"cursor"|"codex"|"openclaw"|"gemini"|"generic", string>`.

- [ ] **Step 1: Write the failing test** — `test/mcp/snippets.test.ts`:

```ts
import { expect, test } from "vitest";
import { buildSnippets } from "../../src/mcp/snippets";

const p = { mcpUrl: "https://api.example/mcp", apiKey: "mcp_abc" };

test("emits a snippet for every main agent, each embedding url + key", () => {
  const s = buildSnippets(p);
  for (const k of ["claudeCode", "cursor", "codex", "openclaw", "gemini", "generic"] as const) {
    expect(s[k]).toContain("https://api.example/mcp");
    expect(s[k]).toContain("mcp_abc");
  }
});

test("claude code snippet is the documented CLI form", () => {
  expect(buildSnippets(p).claudeCode).toBe(
    'claude mcp add legalbody --transport http https://api.example/mcp --header "Authorization: Bearer mcp_abc"',
  );
});

test("cursor + generic snippets are valid JSON", () => {
  const s = buildSnippets(p);
  expect(() => JSON.parse(s.cursor)).not.toThrow();
  expect(() => JSON.parse(s.generic)).not.toThrow();
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/mcp/snippets.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `src/mcp/snippets.ts`:

```ts
export interface ConnectionInfo { mcpUrl: string; apiKey: string }

/** Per-agent "paste-here" MCP config for the same universal server. Claude Code is the flagship. */
export function buildSnippets({ mcpUrl, apiKey }: ConnectionInfo) {
  const auth = `Bearer ${apiKey}`;
  const jsonEntry = { legalbody: { url: mcpUrl, headers: { Authorization: auth } } };
  const jsonBlock = JSON.stringify({ mcpServers: jsonEntry }, null, 2);
  return {
    claudeCode: `claude mcp add legalbody --transport http ${mcpUrl} --header "Authorization: ${auth}"`,
    cursor: jsonBlock, // ~/.cursor/mcp.json
    codex: jsonBlock, // Codex MCP config
    openclaw: jsonBlock, // OpenClaw MCP config
    gemini: jsonBlock, // Gemini CLI settings.json mcpServers
    generic: JSON.stringify({ url: mcpUrl, headers: { Authorization: auth } }, null, 2),
  };
}
```
(These are the current standard MCP registration forms; confirm each agent's exact key names against its docs during frontend/docs polish — the server is identical for all.)

- [ ] **Step 4: Run, expect pass** — `npx vitest run test/mcp/snippets.test.ts` → PASS (3 tests).

- [ ] **Step 5: Commit** — `git add src/mcp/snippets.ts test/mcp/snippets.test.ts && git commit -m "feat(mcp): per-agent connection snippet generator"`

---

### Task 3: `MCP_PUBLIC_URL` config

**Files:**
- Modify: `src/config/env.ts`
- Test: `test/config/mcpUrl.test.ts`

**Interfaces:**
- Produces: `Config.mcpPublicUrl: string` from `MCP_PUBLIC_URL` (default `http://localhost:8789/mcp`).

- [ ] **Step 1: Write the failing test** — `test/config/mcpUrl.test.ts` (mirror an existing `loadConfig` test's `base`):

```ts
test("MCP_PUBLIC_URL loads (with a localhost default)", () => {
  expect(loadConfig(base).mcpPublicUrl).toBe("http://localhost:8789/mcp");
  expect(loadConfig({ ...base, MCP_PUBLIC_URL: "https://api.x/mcp" }).mcpPublicUrl).toBe("https://api.x/mcp");
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/config/mcpUrl.test.ts` → FAIL.

- [ ] **Step 3: Implement** — in `src/config/env.ts`: add to the env schema
  `MCP_PUBLIC_URL: z.string().default("http://localhost:8789/mcp"),`, to `Config` `mcpPublicUrl: string;`,
  and to the mapping `mcpPublicUrl: e.MCP_PUBLIC_URL,`.

- [ ] **Step 4: Run + typecheck** — `npx vitest run test/config/mcpUrl.test.ts && npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `git add src/config/env.ts test/config/mcpUrl.test.ts && git commit -m "feat(config): MCP_PUBLIC_URL for connection snippets"`

---

### Task 4: `POST /connection-package` endpoint

**Files:**
- Create: `src/api/routes/connection.ts`
- Modify: `src/api/app.ts` (mount + ensure `ApiDeps` has `repo`, `apiKeys`, `mcpPublicUrl`)
- Test: `test/api/connection.route.test.ts`

**Interfaces:**
- Consumes: `ApiKeyStore.mint` (Task 1), `buildSnippets` (Task 2), `Config.mcpPublicUrl` (Task 3), `deps.repo` (`findByIdempotencyKey` + `ownerTenantId`).
- Produces: `POST /connection-package` behind SIWE/JWT. Body `{ entityId: string, capability?: "read"|"earn"|"spend" }`.
  200 → `{ mcpUrl, apiKey, entityId, capability, snippets }`. 404 (uniform) if the entity isn't owned by the caller.

- [ ] **Step 1: Write the failing test** — `test/api/connection.route.test.ts` (copy the app/deps + JWT harness
  from an existing route test, e.g. `test/api/onboard.routes.test.ts`; seed the repo with an entity owned by the
  test tenant):

```ts
test("mints an entity-scoped connection package for an owned entity", async () => {
  // entity "ent-1" owned by tenantA is seeded in deps.repo
  const res = await app.request("/connection-package", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({ entityId: "ent-1", capability: "spend" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.entityId).toBe("ent-1");
  expect(body.apiKey).toMatch(/^mcp_/);
  expect(body.snippets.claudeCode).toContain(body.apiKey);
  // the minted key is scoped to the entity + capability
  expect(deps.apiKeys.verify(body.apiKey)).toMatchObject({ tenantId: "tenantA", entityId: "ent-1", capability: "spend" });
});

test("404 (uniform) when the entity is not owned by the caller", async () => {
  const res = await app.request("/connection-package", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify({ entityId: "someone-elses-entity" }),
  });
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run, expect fail** — `npx vitest run test/api/connection.route.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `src/api/routes/connection.ts`:

```ts
import type { Hono } from "hono";
import { z } from "zod";
import type { AuthVars } from "../../auth/middleware";
import { buildSnippets } from "../../mcp/snippets";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const BodySchema = z.object({
  entityId: z.string().min(1),
  capability: z.enum(["read", "earn", "spend"]).default("spend"),
});

export function mountConnectionRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/connection-package", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    const { entityId, capability } = BodySchema.parse(raw);
    const tenantId = c.get("tenantId");
    const ent = deps.repo.findByIdempotencyKey(entityId);
    if (!ent || ent.ownerTenantId !== tenantId)
      throw new ApiError("not_found", 404, "entity not found"); // uniform (no exists-but-not-yours leak)
    const { key } = deps.apiKeys.mint(tenantId, { entityId, capability, label: `connect:${entityId}` });
    return c.json({
      mcpUrl: deps.mcpPublicUrl,
      apiKey: key,
      entityId,
      capability,
      snippets: buildSnippets({ mcpUrl: deps.mcpPublicUrl, apiKey: key }),
    });
  });
}
```
(`ApiError`'s constructor + `not_found` code match `passkey.ts`/`connection` conventions — check `src/api/errors.ts` for the exact signature and reuse it.)

- [ ] **Step 4: Wire into the app.** In `src/api/app.ts`: add `mcpPublicUrl: string` to `ApiDeps` (sourced from
  `cfg.mcpPublicUrl` where `ApiDeps` is built), `import { mountConnectionRoutes }`, and call it on the
  SIWE/JWT-guarded app alongside `mountApiKeyRoutes`/`mountPasskeyRoutes`. Update `src/api/main.ts` if it
  constructs `ApiDeps` explicitly.

- [ ] **Step 5: Full gate** — `npm run typecheck && npm run lint && npm test` → all PASS (incl. the new route test).

- [ ] **Step 6: Commit** — `git add src/api/routes/connection.ts src/api/app.ts src/api/main.ts test/api/connection.route.test.ts && git commit -m "feat(api): POST /connection-package (entity-scoped key + snippets)"`

---

## After this slice

P1 gives the backend a one-call "connect an existing agent to an onboarded body." Next: **P2 Operate** —
the `pay` + `run_job` MCP tools, which is also where the key's `capability`/`entityId` scope (minted here)
gets **enforced** on each tool call, plus the §14.2 SSRF guard, idempotency, and tenant re-checks. The
frontend "Connect your agent" screen (renders `snippets`, copy-once key) is the colleague's, built against
this endpoint.

## Self-Review

**Spec coverage (design §3.1 + §14.2):** connection package + per-agent snippets → Tasks 2+4; entity/
capability/TTL key scoping → Task 1; ownership gate (uniform 404) → Task 4. Capability *enforcement* is
explicitly deferred to P2 (this slice only mints+stores the scope). ✓
**Placeholders:** every code step has complete code; the per-agent snippet exact key-names carry a "confirm
against each agent's docs" note (the server is identical; only the wrapper format differs) — a real
verification instruction, not a TBD. ✓
**Type consistency:** `MintOpts`/`VerifiedKey`/`Capability` used identically in Tasks 1 & 4; `buildSnippets`
return shape matches its test and the route's `snippets` field; `mcpPublicUrl` consistent across Tasks 3 & 4. ✓
**Back-compat:** `mint(tenantId)` with no opts preserves today's tenant-wide behavior (Task 1 test asserts
it); `resolveTenant` still reads `.tenantId`. ✓
