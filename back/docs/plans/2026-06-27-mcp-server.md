# MCP Server Implementation Plan (Track B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing onboarding brain as a remote, multi-tenant MCP server so an agent in Claude/Cursor can onboard and manage agent legal bodies conversationally.

**Architecture:** A `/mcp` Streamable-HTTP route mounted on the *same* Hono app as the wizard REST API, reusing the exact `repo`/`runner` instances already in `ApiDeps` (no wiring relocated). Per-tenant `Bearer` API keys (hashed at rest) resolve to a `tenantId`; a fresh stateless `McpServer` is built per request, closing over that `tenantId`, so every tool is tenant-scoped without depending on SDK auth-propagation internals. The guardian passkey (a public WebAuthn attestation) is captured once via the wizard and referenced by handle.

**Tech Stack:** TypeScript (strict), Hono + `@hono/node-server`, `@modelcontextprotocol/sdk` (stable v1.x), better-sqlite3, Zod, vitest, viem.

**Reference spec:** `back/docs/design/2026-06-27-mcp-server-design.md`. All work happens in `back/backend/` on branch `feat/mcp-server`. Commands below assume CWD `back/backend`.

## Global Constraints

- Node `20.18.2`; TypeScript strict; lint via `npm run lint` (Biome); typecheck via `npm run typecheck`; tests via `npm test` (vitest, `fileParallelism: false`).
- `tenantId` is an **EIP-55 checksummed address** (from `getAddress`). It is derived **only** from the authenticated API key — **never** from a tool argument or request body.
- Persist **only** key hashes (sha-256) and **public** passkey attestations — never plaintext keys or private material.
- `onboard_agent` forces `spec.roles.guardian = tenantId` before validation (parity with `POST /onboard`).
- Pin `@modelcontextprotocol/sdk` to one explicit stable `1.x` version in `package.json` (no `^` range drift); v2 is alpha and out of scope.
- Reuse the existing `ApiError`/`apiOnError` envelope, `toEntityView`, and `AgentSpecSchema`; do not introduce parallel machinery.
- Touch existing files **additively only**: `db.ts` (new tables), `api/app.ts` (new `ApiDeps` fields + route mounts), `api/main.ts` (construct new stores). Never modify the saga, `OnboardingRunner`, adapters, or contracts.

---

### Task 1: `api_keys` table + `ApiKeyStore`

**Files:**
- Modify: `src/persistence/db.ts` (add `api_keys` table inside `migrate`)
- Create: `src/persistence/apiKeyStore.ts`
- Test: `test/persistence/apiKeyStore.test.ts`

**Interfaces:**
- Consumes: `better-sqlite3` `Database`, the `migrate(db)`/`openDatabase` helpers.
- Produces:
  ```ts
  export interface ApiKeyView { id: string; label: string | null; createdAt: number; revokedAt: number | null; }
  export interface ApiKeyStore {
    mint(tenantId: string, label?: string): { id: string; key: string }; // key shown ONCE
    verify(key: string): { tenantId: string; id: string } | null;        // null if unknown/revoked
    list(tenantId: string): ApiKeyView[];
    revoke(tenantId: string, id: string): boolean;                        // false if not owned
  }
  export class SqliteApiKeyStore implements ApiKeyStore { constructor(db: Database.Database) }
  ```

- [ ] **Step 1: Add the table to `migrate`** in `src/persistence/db.ts` — append inside the `db.exec(\`...\`)` block, after the `auth_nonces` table:

```sql
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      owner_tenant TEXT NOT NULL,
      hash         TEXT NOT NULL,
      label        TEXT,
      created_at   INTEGER NOT NULL,
      revoked_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(hash);
```

- [ ] **Step 2: Write the failing test** `test/persistence/apiKeyStore.test.ts`:

```ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";
let db: Database.Database;
let store: SqliteApiKeyStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqliteApiKeyStore(db);
});
afterEach(() => db.close());

test("mint returns a prefixed plaintext key that verify maps back to the tenant", () => {
  const { id, key } = store.mint(TENANT, "laptop");
  expect(key.startsWith("mcp_")).toBe(true);
  const got = store.verify(key);
  expect(got).toEqual({ tenantId: TENANT, id });
});

test("verify returns null for an unknown key", () => {
  store.mint(TENANT);
  expect(store.verify("mcp_nope")).toBeNull();
});

test("revoke makes the key unverifiable; list reflects revocation, never leaks secrets", () => {
  const { id, key } = store.mint(TENANT, "ci");
  expect(store.revoke(TENANT, id)).toBe(true);
  expect(store.verify(key)).toBeNull();
  const views = store.list(TENANT);
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ id, label: "ci" });
  expect(views[0].revokedAt).toBeTypeOf("number");
  expect(JSON.stringify(views)).not.toContain("hash");
  expect(JSON.stringify(views)).not.toContain(key);
});

test("revoke is tenant-scoped: another tenant cannot revoke and list is isolated", () => {
  const { id } = store.mint(TENANT);
  expect(store.revoke(OTHER, id)).toBe(false);
  expect(store.list(OTHER)).toHaveLength(0);
});
```

- [ ] **Step 3: Run it, expect failure**

Run: `npx vitest run test/persistence/apiKeyStore.test.ts`
Expected: FAIL — cannot find module `apiKeyStore`.

- [ ] **Step 4: Implement** `src/persistence/apiKeyStore.ts`:

```ts
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface ApiKeyView {
  id: string;
  label: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface ApiKeyStore {
  mint(tenantId: string, label?: string): { id: string; key: string };
  verify(key: string): { tenantId: string; id: string } | null;
  list(tenantId: string): ApiKeyView[];
  revoke(tenantId: string, id: string): boolean;
}

const hashKey = (key: string): string => createHash("sha256").update(key).digest("hex");

/** Per-tenant API keys for the MCP server. Only the sha-256 hash is stored; the plaintext
 *  (`mcp_<base64url(32 bytes)>`) is returned exactly once from `mint`. */
export class SqliteApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: Database.Database) {}

  mint(tenantId: string, label?: string): { id: string; key: string } {
    const id = randomUUID();
    const key = `mcp_${randomBytes(32).toString("base64url")}`;
    this.db
      .prepare(
        "INSERT INTO api_keys (id, owner_tenant, hash, label, created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, tenantId, hashKey(key), label ?? null, Date.now());
    return { id, key };
  }

  verify(key: string): { tenantId: string; id: string } | null {
    const row = this.db
      .prepare("SELECT id, owner_tenant FROM api_keys WHERE hash = ? AND revoked_at IS NULL")
      .get(hashKey(key)) as { id: string; owner_tenant: string } | undefined;
    return row ? { tenantId: row.owner_tenant, id: row.id } : null;
  }

  list(tenantId: string): ApiKeyView[] {
    return (
      this.db
        .prepare(
          "SELECT id, label, created_at AS createdAt, revoked_at AS revokedAt FROM api_keys WHERE owner_tenant = ? ORDER BY created_at",
        )
        .all(tenantId) as ApiKeyView[]
    );
  }

  revoke(tenantId: string, id: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND owner_tenant = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), id, tenantId);
    return res.changes > 0;
  }
}
```

- [ ] **Step 5: Run tests + lint, expect pass**

Run: `npx vitest run test/persistence/apiKeyStore.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/db.ts src/persistence/apiKeyStore.ts test/persistence/apiKeyStore.test.ts
git commit -m "feat(mcp): api_keys table + ApiKeyStore (hashed, tenant-scoped)"
```

---

### Task 2: `passkeys` table + `PasskeyStore`

**Files:**
- Modify: `src/persistence/db.ts` (add `passkeys` table inside `migrate`)
- Create: `src/persistence/passkeyStore.ts`
- Test: `test/persistence/passkeyStore.test.ts`

**Interfaces:**
- Consumes: `GuardianPasskey` from `src/adapters/turnkey/provisioner.ts`:
  ```ts
  interface GuardianPasskey {
    authenticatorName?: string;
    challenge: string;
    attestation: { credentialId: string; clientDataJson: string; attestationObject: string; transports: string[] };
  }
  ```
- Produces:
  ```ts
  export interface PasskeyView { id: string; name: string | null; createdAt: number; }
  export interface PasskeyStore {
    store(tenantId: string, pk: GuardianPasskey): string;            // returns handle id
    get(tenantId: string, id: string): GuardianPasskey | null;       // tenant-scoped
    list(tenantId: string): PasskeyView[];
  }
  export class SqlitePasskeyStore implements PasskeyStore { constructor(db: Database.Database) }
  ```

- [ ] **Step 1: Add the table to `migrate`** in `src/persistence/db.ts` (after `api_keys`):

```sql
    CREATE TABLE IF NOT EXISTS passkeys (
      id           TEXT PRIMARY KEY,
      owner_tenant TEXT NOT NULL,
      name         TEXT,
      challenge    TEXT NOT NULL,
      attestation  TEXT NOT NULL,   -- JSON {credentialId, clientDataJson, attestationObject, transports}
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_passkeys_tenant ON passkeys(owner_tenant);
```

- [ ] **Step 2: Write the failing test** `test/persistence/passkeyStore.test.ts`:

```ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import type { GuardianPasskey } from "../../src/adapters/turnkey/provisioner";

const TENANT = "0x000000000000000000000000000000000000000A";
const OTHER = "0x000000000000000000000000000000000000000B";
const PK: GuardianPasskey = {
  authenticatorName: "Test Key",
  challenge: "Y2hhbGxlbmdl",
  attestation: {
    credentialId: "cred-1",
    clientDataJson: "e30=",
    attestationObject: "o2M=",
    transports: ["internal"],
  },
};
let db: Database.Database;
let store: SqlitePasskeyStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqlitePasskeyStore(db);
});
afterEach(() => db.close());

test("store then get round-trips the full GuardianPasskey for the owning tenant", () => {
  const id = store.store(TENANT, PK);
  expect(store.get(TENANT, id)).toEqual(PK);
});

test("get is tenant-scoped: another tenant sees null", () => {
  const id = store.store(TENANT, PK);
  expect(store.get(OTHER, id)).toBeNull();
});

test("get returns null for an unknown handle", () => {
  expect(store.get(TENANT, "nope")).toBeNull();
});

test("list returns secret-free metadata for the tenant only", () => {
  store.store(TENANT, PK);
  expect(store.list(OTHER)).toHaveLength(0);
  const views = store.list(TENANT);
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ name: "Test Key" });
  expect(JSON.stringify(views)).not.toContain("attestationObject");
});
```

- [ ] **Step 3: Run it, expect failure**

Run: `npx vitest run test/persistence/passkeyStore.test.ts`
Expected: FAIL — cannot find module `passkeyStore`.

- [ ] **Step 4: Implement** `src/persistence/passkeyStore.ts`:

```ts
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { GuardianPasskey } from "../adapters/turnkey/provisioner";

export interface PasskeyView {
  id: string;
  name: string | null;
  createdAt: number;
}

export interface PasskeyStore {
  store(tenantId: string, pk: GuardianPasskey): string;
  get(tenantId: string, id: string): GuardianPasskey | null;
  list(tenantId: string): PasskeyView[];
}

/** Server-side store of guardian WebAuthn attestations (PUBLIC credentials, not private keys),
 *  referenced by handle so the MCP `onboard_agent` tool can provision a per-agent vault without
 *  the LLM performing a browser ceremony. */
export class SqlitePasskeyStore implements PasskeyStore {
  constructor(private readonly db: Database.Database) {}

  store(tenantId: string, pk: GuardianPasskey): string {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO passkeys (id, owner_tenant, name, challenge, attestation, created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        tenantId,
        pk.authenticatorName ?? null,
        pk.challenge,
        JSON.stringify(pk.attestation),
        Date.now(),
      );
    return id;
  }

  get(tenantId: string, id: string): GuardianPasskey | null {
    const row = this.db
      .prepare(
        "SELECT name, challenge, attestation FROM passkeys WHERE id = ? AND owner_tenant = ?",
      )
      .get(id, tenantId) as
      | { name: string | null; challenge: string; attestation: string }
      | undefined;
    if (!row) return null;
    return {
      ...(row.name ? { authenticatorName: row.name } : {}),
      challenge: row.challenge,
      attestation: JSON.parse(row.attestation),
    };
  }

  list(tenantId: string): PasskeyView[] {
    return this.db
      .prepare(
        "SELECT id, name, created_at AS createdAt FROM passkeys WHERE owner_tenant = ? ORDER BY created_at",
      )
      .all(tenantId) as PasskeyView[];
  }
}
```

- [ ] **Step 5: Run tests + lint, expect pass**

Run: `npx vitest run test/persistence/passkeyStore.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/persistence/db.ts src/persistence/passkeyStore.ts test/persistence/passkeyStore.test.ts
git commit -m "feat(mcp): passkeys table + PasskeyStore (handle-referenced attestations)"
```

---

### Task 3: REST `/api-keys` routes (self-service, behind `requireAuth`)

**Files:**
- Create: `src/api/routes/apiKeys.ts`
- Modify: `src/api/app.ts` (extend `ApiDeps` with `apiKeys`; add `requireAuth` + mount)
- Modify: `src/api/main.ts` (construct `SqliteApiKeyStore`, pass in deps)
- Test: `test/api/apiKeys.routes.test.ts`

**Interfaces:**
- Consumes: `ApiKeyStore` (Task 1), `requireAuth`, `ApiError`, the `AuthVars` `tenantId` context var.
- Produces: `mountApiKeyRoutes(app, deps)`; routes `POST /api-keys`, `GET /api-keys`, `DELETE /api-keys/:id`.

- [ ] **Step 1: Extend `ApiDeps`** in `src/api/app.ts` — add to the interface:

```ts
  apiKeys: import("../persistence/apiKeyStore").ApiKeyStore;
```

- [ ] **Step 2: Mount the routes** in `buildApiApp` (after the existing `app.use("/jobs/*", ...)` guard, before `mountJobRoutes`):

```ts
  app.use("/api-keys", requireAuth(deps.jwtSecret));
  app.use("/api-keys/*", requireAuth(deps.jwtSecret));
  mountApiKeyRoutes(app, deps);
```

Add the import at the top: `import { mountApiKeyRoutes } from "./routes/apiKeys";`

- [ ] **Step 3: Write the failing test** `test/api/apiKeys.routes.test.ts` (mirror the `jobs.routes.test.ts` harness — copy its `account`, `otherAccount`, `DOMAIN`, `CHAIN`, `login`, `beforeEach`/`afterEach`; build the app with the new store):

```ts
import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { OnboardingRunner } from "../../src/workflow/runner";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
let db: Database.Database;
let repo: SqliteEntityRepository;

function makeApp() {
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
  });
  const app = buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo,
    runner,
    passkeyRpId: "wizard.local",
    apiKeys: new SqliteApiKeyStore(db),
  } as never);
  return app;
}

async function login(app: ReturnType<typeof buildApiApp>, acct = account) {
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: acct.address, chainId: CHAIN, domain: DOMAIN, nonce,
    uri: `https://${DOMAIN}`, version: "1",
  });
  const signature = await acct.signMessage({ message });
  const body = await (
    await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    })
  ).json();
  return body.token as string;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

test("POST /api-keys → 201 returns plaintext key once; GET lists it without the secret", async () => {
  const app = makeApp();
  const token = await login(app);
  const created = await app.request("/api-keys", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "laptop" }),
  });
  expect(created.status).toBe(201);
  const { id, key } = await created.json();
  expect(key.startsWith("mcp_")).toBe(true);

  const listed = await app.request("/api-keys", { headers: { authorization: `Bearer ${token}` } });
  const views = await listed.json();
  expect(views).toHaveLength(1);
  expect(views[0]).toMatchObject({ id, label: "laptop" });
  expect(JSON.stringify(views)).not.toContain(key);
});

test("DELETE /api-keys/:id → 204 and the key disappears from the list", async () => {
  const app = makeApp();
  const token = await login(app);
  const { id } = await (
    await app.request("/api-keys", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json();
  const del = await app.request(`/api-keys/${id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(del.status).toBe(204);
  const views = await (
    await app.request("/api-keys", { headers: { authorization: `Bearer ${token}` } })
  ).json();
  expect(views[0].revokedAt).toBeTypeOf("number");
});

test("no auth → 401", async () => {
  const app = makeApp();
  expect((await app.request("/api-keys")).status).toBe(401);
});
```

- [ ] **Step 4: Run it, expect failure**

Run: `npx vitest run test/api/apiKeys.routes.test.ts`
Expected: FAIL — `mountApiKeyRoutes` not found / `apiKeys` missing.

- [ ] **Step 5: Implement** `src/api/routes/apiKeys.ts`:

```ts
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";

export function mountApiKeyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/api-keys", async (c) => {
    let body: { label?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const label = typeof body.label === "string" ? body.label : undefined;
    const { id, key } = deps.apiKeys.mint(c.get("tenantId"), label);
    return c.json({ id, key, label: label ?? null }, 201);
  });

  app.get("/api-keys", (c) => c.json(deps.apiKeys.list(c.get("tenantId"))));

  app.delete("/api-keys/:id", (c) => {
    const ok = deps.apiKeys.revoke(c.get("tenantId"), c.req.param("id"));
    if (!ok) return c.json({ error: { code: "not_found", message: "api key not found" } }, 404);
    return c.body(null, 204);
  });
}
```

- [ ] **Step 6: Wire the store into the real composition root** — in `src/api/main.ts`, after `const nonceStore = new SqliteNonceStore(db);` add:

```ts
  const apiKeys = new SqliteApiKeyStore(db);
```

add the import `import { SqliteApiKeyStore } from "../persistence/apiKeyStore";`, and add `apiKeys,` to the `buildApiApp({ ... })` deps object.

- [ ] **Step 7: Run tests + lint + typecheck, expect pass**

Run: `npx vitest run test/api/apiKeys.routes.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/api/routes/apiKeys.ts src/api/app.ts src/api/main.ts test/api/apiKeys.routes.test.ts
git commit -m "feat(mcp): self-service POST/GET/DELETE /api-keys"
```

---

### Task 4: REST `POST /passkey` route (store attestation → handle)

**Files:**
- Modify: `src/api/routes/passkey.ts` (add authed `POST /passkey`)
- Modify: `src/api/app.ts` (extend `ApiDeps` with `passkeys`)
- Modify: `src/api/main.ts` (construct `SqlitePasskeyStore`, pass in deps)
- Test: `test/api/passkey.routes.test.ts`

**Interfaces:**
- Consumes: `PasskeyStore` (Task 2), `requireAuth`, `ApiError`, `AuthVars`.
- Produces: `POST /passkey` `{ authenticatorName?, challenge, attestation }` → `201 { id }`. `GET /passkey/challenge` unchanged (stays public).

- [ ] **Step 1: Extend `ApiDeps`** in `src/api/app.ts`:

```ts
  passkeys: import("../persistence/passkeyStore").PasskeyStore;
```

- [ ] **Step 2: Write the failing test** `test/api/passkey.routes.test.ts` (reuse the Task 3 harness — same imports, `makeApp` additionally passing `passkeys: new SqlitePasskeyStore(db)`, same `login`):

```ts
// ...identical setup to Task 3's test, plus:
//   import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
//   and add `passkeys: new SqlitePasskeyStore(db)` to the buildApiApp deps in makeApp().
const VALID = {
  authenticatorName: "My Key",
  challenge: "Y2hhbGxlbmdl",
  attestation: {
    credentialId: "cred-1",
    clientDataJson: "e30=",
    attestationObject: "o2M=",
    transports: ["internal"],
  },
};

test("POST /passkey → 201 { id } for a valid attestation", async () => {
  const app = makeApp();
  const token = await login(app);
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(VALID),
  });
  expect(res.status).toBe(201);
  expect(typeof (await res.json()).id).toBe("string");
});

test("POST /passkey with a malformed attestation → 400", async () => {
  const app = makeApp();
  const token = await login(app);
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ challenge: "x" }),
  });
  expect(res.status).toBe(400);
});

test("POST /passkey without auth → 401", async () => {
  const app = makeApp();
  const res = await app.request("/passkey", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(VALID),
  });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 3: Run it, expect failure**

Run: `npx vitest run test/api/passkey.routes.test.ts`
Expected: FAIL — POST /passkey returns 404 (route absent).

- [ ] **Step 4: Implement** — replace `src/api/routes/passkey.ts` with:

```ts
import { randomBytes } from "node:crypto";
import type { Env, Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

export const GuardianPasskeySchema = z.object({
  authenticatorName: z.string().optional(),
  challenge: z.string().min(1),
  attestation: z.object({
    credentialId: z.string().min(1),
    clientDataJson: z.string().min(1),
    attestationObject: z.string().min(1),
    transports: z.array(z.string()),
  }),
});

/** Public WebAuthn registration challenge + authed attestation storage (→ handle). */
export function mountPasskeyRoutes<E extends Env>(app: Hono<E>, deps: ApiDeps) {
  app.get("/passkey/challenge", (c) =>
    c.json({ challenge: randomBytes(32).toString("base64url"), rpId: deps.passkeyRpId }),
  );

  app.post("/passkey", requireAuth(deps.jwtSecret), async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    const pk = GuardianPasskeySchema.parse(raw); // ZodError → 400 via apiOnError
    const id = deps.passkeys.store((c as unknown as { get(k: "tenantId"): `0x${string}` }).get("tenantId"), pk);
    return c.json({ id }, 201);
  });
}
```

Note: `mountPasskeyRoutes` is generic over `E`; cast the context to read `tenantId` (set by the inline `requireAuth`). If the surrounding `buildApiApp` types `Hono<{ Variables: AuthVars }>`, you may instead type the handler param directly — adjust to satisfy `npm run typecheck`.

- [ ] **Step 5: Wire the store** in `src/api/main.ts` — add `const passkeys = new SqlitePasskeyStore(db);`, the import, and `passkeys,` in the `buildApiApp` deps.

- [ ] **Step 6: Run tests + lint + typecheck, expect pass**

Run: `npx vitest run test/api/passkey.routes.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/api/routes/passkey.ts src/api/app.ts src/api/main.ts test/api/passkey.routes.test.ts
git commit -m "feat(mcp): authed POST /passkey stores attestation, returns handle"
```

---

### Task 5: MCP transport spike — `/mcp` with Bearer auth + a `whoami` tool

> This task **empirically pins the transport API**. The integration test is the source of truth: install the SDK, run the test, and adjust the transport import/`handleRequest` signature to match the *pinned* version's exports. The wiring below is the expected v1.x shape; do not assume it compiles unchanged.

**Files:**
- Modify: `package.json` (add pinned `@modelcontextprotocol/sdk`)
- Create: `src/mcp/auth.ts`, `src/mcp/server.ts`, `src/mcp/transport.ts`
- Create: `test/mcp/helpers.ts`
- Modify: `src/api/app.ts` (call `mountMcpRoute(app, deps)`)
- Test: `test/mcp/transport.int.test.ts`

**Interfaces:**
- Consumes: `ApiKeyStore.verify`, `EntityRepository`, `OnboardingRunner`, `PasskeyStore`.
- Produces:
  ```ts
  // src/mcp/auth.ts
  export function resolveTenant(authHeader: string | undefined, apiKeys: ApiKeyStore): string | null;
  // src/mcp/server.ts
  export interface McpToolDeps { repo: EntityRepository; runner: OnboardingRunner; passkeys: PasskeyStore; }
  export function buildMcpServer(tenantId: string, deps: McpToolDeps): McpServer;
  // src/mcp/transport.ts
  export function mountMcpRoute(app: Hono, deps: ApiDeps): void;  // registers app.all("/mcp", ...)
  // test/mcp/helpers.ts
  export async function startMcpTestClient(app, apiKey: string): Promise<{ client: Client; close(): Promise<void> }>;
  ```

- [ ] **Step 1: Pin the SDK**

Run: `npm install @modelcontextprotocol/sdk@1` then edit `package.json` to replace the `^1.x.y` range with the exact resolved version (e.g. `"@modelcontextprotocol/sdk": "1.x.y"`). Run `npm install` again to refresh the lockfile.
Expected: `package-lock.json` updated; `node_modules/@modelcontextprotocol/sdk` present.

- [ ] **Step 2: Implement the auth resolver** `src/mcp/auth.ts`:

```ts
import type { ApiKeyStore } from "../persistence/apiKeyStore";

/** Resolve a `Authorization: Bearer <mcp key>` header to a tenantId, or null if absent/invalid. */
export function resolveTenant(authHeader: string | undefined, apiKeys: ApiKeyStore): string | null {
  const [scheme, token] = (authHeader ?? "").split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return apiKeys.verify(token)?.tenantId ?? null;
}
```

- [ ] **Step 3: Implement the server factory** `src/mcp/server.ts` (whoami only for now):

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EntityRepository } from "../persistence/entityRepository";
import type { PasskeyStore } from "../persistence/passkeyStore";
import type { OnboardingRunner } from "../workflow/runner";

export interface McpToolDeps {
  repo: EntityRepository;
  runner: OnboardingRunner;
  passkeys: PasskeyStore;
}

/** Build a fresh, tenant-scoped MCP server. tenantId is closed over — never taken from a tool arg. */
export function buildMcpServer(tenantId: string, _deps: McpToolDeps): McpServer {
  const server = new McpServer({ name: "project-alpha-brain", version: "1.0.0" });

  server.registerTool(
    "whoami",
    { title: "Who am I", description: "Return the authenticated tenant address." },
    async () => ({ content: [{ type: "text", text: tenantId }] }),
  );

  return server;
}
```

- [ ] **Step 4: Implement the transport mount** `src/mcp/transport.ts` (expected v1.x shape; align to the pinned version):

```ts
import { RESPONSE_ALREADY_SENT } from "@hono/node-server";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Hono } from "hono";
import type { ApiDeps } from "../api/app";
import { resolveTenant } from "./auth";
import { buildMcpServer } from "./server";

/** Mount the stateless Streamable-HTTP MCP endpoint. A fresh server+transport per request,
 *  closing over the authenticated tenantId. */
export function mountMcpRoute(app: Hono, deps: ApiDeps) {
  app.all("/mcp", async (c) => {
    const tenantId = resolveTenant(c.req.header("authorization"), deps.apiKeys);
    if (!tenantId) return c.json({ error: { code: "unauthorized", message: "invalid api key" } }, 401);

    const server = buildMcpServer(tenantId, {
      repo: deps.repo,
      runner: deps.runner,
      passkeys: deps.passkeys,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    // @hono/node-server exposes the raw Node req/res on c.env; the transport writes to res directly.
    const { incoming, outgoing } = c.env as unknown as {
      incoming: import("node:http").IncomingMessage;
      outgoing: import("node:http").ServerResponse;
    };
    const body = await c.req.json().catch(() => undefined);
    await transport.handleRequest(incoming, outgoing, body);
    return RESPONSE_ALREADY_SENT;
  });
}
```

Then in `src/api/app.ts` import and call it (after the other mounts): `import { mountMcpRoute } from "../mcp/transport";` and `mountMcpRoute(app, deps);` at the end of `buildApiApp`.

- [ ] **Step 5: Implement the test helper** `test/mcp/helpers.ts`:

```ts
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";

/** Serve the Hono app on an ephemeral port and return a connected MCP client authed with apiKey. */
export async function startMcpTestClient(
  app: { fetch: (req: Request) => Response | Promise<Response> },
  apiKey: string,
) {
  const server = serve({ fetch: app.fetch, port: 0 });
  const port = (server.address() as AddressInfo).port;
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${apiKey}` } },
  });
  await client.connect(transport);
  return {
    client,
    async close() {
      await client.close();
      server.close();
    },
  };
}
```

> If the pinned SDK's client transport passes auth differently (e.g. an `authProvider.token()`), adapt this helper — it is the single place test auth is configured.

- [ ] **Step 6: Write the failing integration test** `test/mcp/transport.int.test.ts`:

```ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { OnboardingRunner } from "../../src/workflow/runner";
import { startMcpTestClient } from "./helpers";

const TENANT = "0x000000000000000000000000000000000000000A";
let db: Database.Database;
let apiKeys: SqliteApiKeyStore;
let app: ReturnType<typeof buildApiApp>;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  const runner = new OnboardingRunner({
    repo,
    runSaga: async (i: { idempotencyKey: string }) => repo.findByIdempotencyKey(i.idempotencyKey)!,
  });
  app = buildApiApp({
    webOrigin: "*", nonceStore: new SqliteNonceStore(db), siweDomain: "wizard.local",
    chainId: 5042002, jwtSecret: "s", jwtTtlSec: 3600, repo, runner,
    passkeyRpId: "wizard.local", apiKeys, passkeys: new SqlitePasskeyStore(db),
  } as never);
});
afterEach(() => db.close());

test("a valid api key connects and whoami returns the tenant", async () => {
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("whoami");
    const res = await client.callTool({ name: "whoami", arguments: {} });
    expect((res.content as { text: string }[])[0].text).toBe(TENANT);
  } finally {
    await close();
  }
});

test("an invalid api key is rejected (connect/list fails)", async () => {
  await expect(
    (async () => {
      const { client } = await startMcpTestClient(app, "mcp_bogus");
      await client.listTools();
    })(),
  ).rejects.toThrow();
});
```

- [ ] **Step 7: Run, iterate to green**

Run: `npx vitest run test/mcp/transport.int.test.ts`
Expected: FAIL first (module/signature), then PASS after aligning the transport import + `handleRequest` call to the pinned version. **Do not proceed until green.** If `c.env` does not expose `incoming/outgoing` in the installed `@hono/node-server`, consult its docs for the raw-request accessor and update `transport.ts` only.

- [ ] **Step 8: Lint, typecheck, commit**

Run: `npm run lint && npm run typecheck`

```bash
git add package.json package-lock.json src/mcp/ src/api/app.ts test/mcp/
git commit -m "feat(mcp): /mcp streamable-http transport + bearer api-key auth (whoami)"
```

---

### Task 6: Read tools — `list_entities`, `get_entity`, `fund_treasury` + AgentSpec schema resource

**Files:**
- Modify: `src/mcp/server.ts` (register three tools + one resource)
- Test: `test/mcp/tools.read.int.test.ts`

**Interfaces:**
- Consumes: `buildMcpServer` (Task 5), `repo.listByTenant`/`findByIdempotencyKey`, `runner.fund`, `toEntityView`, `AgentSpecSchema`, `zod-to-json-schema`.
- Produces: tools `list_entities` (`{}`), `get_entity` (`{ id }`), `fund_treasury` (`{ id, amount }`); resource `schema://agent-spec`.

- [ ] **Step 1: Write the failing test** `test/mcp/tools.read.int.test.ts` (build the app exactly as in Task 5's test; seed entities directly via `repo.upsert` using the `seedEntity` helper copied from `jobs.routes.test.ts`, owned by `TENANT`):

```ts
// ...same app/db setup as Task 5's test, exposing `repo` and `apiKeys`...
test("list_entities returns only the caller tenant's entities", async () => {
  repoSeed(TENANT, "agent1"); // helper: repo.upsert a bound entity with ownerTenantId=TENANT
  repoSeed(OTHER_TENANT, "agentX");
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({ name: "list_entities", arguments: {} });
    const views = JSON.parse((res.content as { text: string }[])[0].text);
    expect(views).toHaveLength(1);
    expect(views[0].id).toBe(`${TENANT}:agent1`);
  } finally {
    await close();
  }
});

test("get_entity hides another tenant's entity (isError)", async () => {
  repoSeed(OTHER_TENANT, "secret");
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "get_entity",
      arguments: { id: `${OTHER_TENANT}:secret` },
    });
    expect(res.isError).toBe(true);
  } finally {
    await close();
  }
});

test("fund_treasury on a bound entity returns a status", async () => {
  repoSeed(TENANT, "agent1"); // status 'bound', treasury set
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "fund_treasury",
      arguments: { id: `${TENANT}:agent1`, amount: "1000000" },
    });
    const out = JSON.parse((res.content as { text: string }[])[0].text);
    expect(out.id).toBe(`${TENANT}:agent1`);
  } finally {
    await close();
  }
});

test("schema://agent-spec resource returns the AgentSpec JSON schema", async () => {
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const r = await client.readResource({ uri: "schema://agent-spec" });
    const schema = JSON.parse((r.contents as { text: string }[])[0].text);
    expect(schema).toHaveProperty("properties");
  } finally {
    await close();
  }
});
```

(`repoSeed` mirrors `seedEntity` from `test/api/jobs.routes.test.ts`: `repo.upsert({... status:"bound", ownerTenantId: tenant, treasury:"0x..F", treasuryConfig:{usdc:"0x..2", payoutAddress:"0x..A", cap:1000000000n, period:86400n, allowlistEnabled:false} ...})`. Set a non-null `treasuryConfig` and `treasury` so `fund_treasury` has a target.)

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run test/mcp/tools.read.int.test.ts`
Expected: FAIL — `list_entities`/`get_entity`/`fund_treasury` unknown; resource missing.

- [ ] **Step 3: Implement** — extend `buildMcpServer` in `src/mcp/server.ts`. Add imports and register inside the factory (after `whoami`):

```ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AgentSpecSchema } from "../policy/agentSpec";
import { toEntityView } from "../api/views";
```

```ts
  const { repo, runner } = _deps; // rename the param to `deps` and destructure

  server.registerResource(
    "agent-spec",
    "schema://agent-spec",
    { title: "AgentSpec schema", description: "JSON-schema for onboard_agent's spec argument", mimeType: "application/json" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(zodToJsonSchema(AgentSpecSchema)) }],
    }),
  );

  server.registerTool(
    "list_entities",
    { title: "List entities", description: "List the caller's agent legal bodies." },
    async () => {
      const views = repo.listByTenant(tenantId).map(toEntityView);
      return { content: [{ type: "text", text: JSON.stringify(views) }] };
    },
  );

  server.registerTool(
    "get_entity",
    {
      title: "Get entity",
      description: "Fetch one entity by id (idempotency key). Poll this after onboard_agent.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId)
        return { content: [{ type: "text", text: "entity not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(toEntityView(rec)) }] };
    },
  );

  server.registerTool(
    "fund_treasury",
    {
      title: "Fund treasury",
      description: "Fund a bound entity's treasury with atomic USDC (6 decimals).",
      inputSchema: { id: z.string(), amount: z.string() },
    },
    async ({ id, amount }) => {
      try {
        const { id: outId, status } = runner.fund({ id, tenantId, amount: BigInt(amount) });
        return { content: [{ type: "text", text: JSON.stringify({ id: outId, status }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    },
  );
```

(Change the factory signature from `_deps` to `deps: McpToolDeps` and destructure `repo`, `runner`, `passkeys`.)

- [ ] **Step 4: Run tests + lint + typecheck, expect pass**

Run: `npx vitest run test/mcp/tools.read.int.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts test/mcp/tools.read.int.test.ts
git commit -m "feat(mcp): list_entities/get_entity/fund_treasury tools + agent-spec resource"
```

---

### Task 7: `onboard_agent` tool (passkey handle → per-agent vault)

**Files:**
- Modify: `src/mcp/server.ts` (register `onboard_agent`)
- Test: `test/mcp/tools.onboard.int.test.ts`

**Interfaces:**
- Consumes: `passkeys.get`, `runner.start`, `AgentSpecSchema`.
- Produces: tool `onboard_agent` `{ spec, passkeyId, idempotencyKey? }` → `{ id, status: "pending" }`.

- [ ] **Step 1: Write the failing test** `test/mcp/tools.onboard.int.test.ts` — build the app as in Task 5, but with a `runner` whose `runSaga` is a stub that returns the current record (so `start` does not touch a chain), and a real `SqlitePasskeyStore`. A valid `AgentSpec` fixture is needed; copy a minimal valid spec from `test/onboarding/server.test.ts` (search it for `AgentSpecSchema.parse` / the spec object used there) so it passes validation.

```ts
test("onboard_agent with a stored passkey handle starts the saga and returns pending", async () => {
  const passkeys = /* the SqlitePasskeyStore passed into the app */;
  const handle = passkeys.store(TENANT, VALID_PASSKEY); // VALID_PASSKEY as in Task 2
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: handle },
    });
    const out = JSON.parse((res.content as { text: string }[])[0].text);
    expect(out.status).toBe("pending");
    expect(typeof out.id).toBe("string");
  } finally {
    await close();
  }
});

test("onboard_agent with an unknown passkey handle returns isError", async () => {
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const res = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId: "nope" },
    });
    expect(res.isError).toBe(true);
  } finally {
    await close();
  }
});
```

> The app's `runner` here must be built with a stub `runSaga` (returns `repo.findByIdempotencyKey(i.idempotencyKey)!`) AND the `OnboardingRunner.start` requires a `guardianPasskey` argument — the tool supplies it from the store. Use the same `OnboardingRunner` wiring as the other tests.

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run test/mcp/tools.onboard.int.test.ts`
Expected: FAIL — `onboard_agent` unknown.

- [ ] **Step 3: Implement** — register in `buildMcpServer` (`src/mcp/server.ts`):

```ts
  server.registerTool(
    "onboard_agent",
    {
      title: "Onboard agent",
      description:
        "Create an agent legal body. spec must match schema://agent-spec; the guardian is set " +
        "automatically to your tenant. passkeyId references a previously stored guardian passkey " +
        "(POST /passkey). Returns immediately with status 'pending' — poll get_entity until 'bound'.",
      inputSchema: {
        spec: z.record(z.unknown()),
        passkeyId: z.string(),
        idempotencyKey: z.string().optional(),
      },
    },
    async ({ spec, passkeyId, idempotencyKey }) => {
      const passkey = deps.passkeys.get(tenantId, passkeyId);
      if (!passkey)
        return { content: [{ type: "text", text: "passkey handle not found" }], isError: true };
      try {
        const raw = spec as Record<string, unknown>;
        const roles = { ...((raw.roles as object) ?? {}), guardian: tenantId };
        const parsed = AgentSpecSchema.parse({ ...raw, roles });
        const { id, status } = deps.runner.start({
          spec: parsed,
          userKey: idempotencyKey && idempotencyKey.length > 0 ? idempotencyKey : parsed.name,
          tenantId,
          guardianPasskey: passkey,
        });
        return { content: [{ type: "text", text: JSON.stringify({ id, status }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    },
  );
```

- [ ] **Step 4: Run tests + lint + typecheck, expect pass**

Run: `npx vitest run test/mcp/tools.onboard.int.test.ts && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts test/mcp/tools.onboard.int.test.ts
git commit -m "feat(mcp): onboard_agent tool (passkey handle, guardian forced to tenant)"
```

---

### Task 8: Anvil end-to-end + tenant isolation

**Files:**
- Test: `test/mcp/e2e.int.test.ts`

**Interfaces:**
- Consumes: the full real wiring (`ArcAdapter` on anvil, real `runOnboarding`) and the MCP client helper.

- [ ] **Step 1: Write the end-to-end test** `test/mcp/e2e.int.test.ts`. Reuse the anvil bootstrap from `test/onboarding.int.test.ts` verbatim (the `beforeAll`/`afterAll` that starts anvil, deploys the mock registry/factory, builds the real `ArcAdapter`, `operatorSigner`, `provision`, `runOnboarding`-based `runSaga`, and the `OnboardingRunner`). Then build the app with the **real** runner plus `SqliteApiKeyStore`/`SqlitePasskeyStore`, and drive it over `/mcp`:

```ts
test("end-to-end: mint key, store passkey, onboard_agent, poll get_entity to bound", async () => {
  const passkeyId = passkeys.store(TENANT, VALID_PASSKEY);
  const { key } = apiKeys.mint(TENANT);
  const { client, close } = await startMcpTestClient(app, key);
  try {
    const start = await client.callTool({
      name: "onboard_agent",
      arguments: { spec: VALID_SPEC, passkeyId },
    });
    const { id } = JSON.parse((start.content as { text: string }[])[0].text);

    // poll get_entity until terminal
    let status = "pending";
    for (let i = 0; i < 60 && !["bound", "funded", "failed"].includes(status); i++) {
      await new Promise((r) => setTimeout(r, 500));
      const got = await client.callTool({ name: "get_entity", arguments: { id } });
      status = JSON.parse((got.content as { text: string }[])[0].text).status;
    }
    expect(status).toBe("bound");
  } finally {
    await close();
  }
}, 60_000);

test("tenant isolation: a second tenant's key cannot see the first tenant's entity", async () => {
  repoSeed(TENANT, "agent1");
  const { key: otherKey } = apiKeys.mint(OTHER_TENANT);
  const { client, close } = await startMcpTestClient(app, otherKey);
  try {
    const list = await client.callTool({ name: "list_entities", arguments: {} });
    expect(JSON.parse((list.content as { text: string }[])[0].text)).toHaveLength(0);
    const get = await client.callTool({ name: "get_entity", arguments: { id: `${TENANT}:agent1` } });
    expect(get.isError).toBe(true);
  } finally {
    await close();
  }
});
```

(`TENANT` must be the controller address whose guardian/manager the anvil mock accepts — reuse whatever `test/onboarding.int.test.ts` uses as the tenant/guardian so `setAgentWallet` binds within the mock's rules.)

- [ ] **Step 2: Run on anvil, expect pass**

Run: `npx vitest run test/mcp/e2e.int.test.ts`
Expected: PASS (requires `forge` + anvil on PATH, as the existing `*.int.test.ts` do; the CI installs Foundry).

- [ ] **Step 3: Full suite + lint + typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: PASS (no regressions).

- [ ] **Step 4: Commit**

```bash
git add test/mcp/e2e.int.test.ts
git commit -m "test(mcp): anvil onboard_agent->bound e2e + tenant isolation"
```

---

### Task 9: Setup docs (Claude/Cursor) + README

**Files:**
- Modify: `backend/README.md` (add an "MCP server" section)

**Interfaces:** none (docs).

- [ ] **Step 1: Add a README section** documenting the full operator flow. Include, verbatim, runnable steps:
  1. Run the API (`npm run api`) — it now also serves `/mcp`.
  2. Sign in (SIWE) and mint a key: `POST /api-keys` → copy the one-time `key`.
  3. Capture the guardian passkey in the browser (`GET /passkey/challenge` → WebAuthn ceremony) and `POST /passkey` → copy the `id` (handle).
  4. Add the server to Claude/Cursor — `mcp.json` snippet:

```json
{
  "mcpServers": {
    "project-alpha": {
      "url": "https://<your-host>/mcp",
      "headers": { "Authorization": "Bearer mcp_<your-key>" }
    }
  }
}
```

  5. Example flow: read `schema://agent-spec`, call `onboard_agent` with `{ spec, passkeyId }`, then poll `get_entity` until `bound`; `fund_treasury` to top up; `list_entities` to review.

- [ ] **Step 2: Commit**

```bash
git add backend/README.md
git commit -m "docs(mcp): README setup for Claude/Cursor + example flow"
```

---

## Self-Review

**Spec coverage** (against `2026-06-27-mcp-server-design.md`):
- §3 same-process `/mcp` on the Hono app → Task 5. ✓
- §4 `api_keys` + `passkeys` tables/stores → Tasks 1, 2. ✓
- §5 REST `/api-keys` (×3) + `POST /passkey` → Tasks 3, 4. ✓
- §6 four tools + `schema://agent-spec` resource → Tasks 5 (whoami scaffolding), 6, 7. ✓
- §7 tenant isolation (tenantId from key only; guardian forced) → enforced in Tasks 6/7, tested in Task 8. ✓
- §8 unit + int + isolation tests → Tasks 1–8. ✓
- §9 config/docs → Task 9. ✓
- §3.1 additive-only edits to `db.ts`/`app.ts`/`main.ts` → Tasks 1–5. ✓

**Type consistency:** `ApiKeyStore`/`PasskeyStore` signatures, `McpToolDeps`, `buildMcpServer(tenantId, deps)`, `resolveTenant`, and `mountMcpRoute` are used consistently across tasks. `runner.start`/`runner.fund`/`repo.listByTenant`/`repo.findByIdempotencyKey`/`toEntityView` match the real source read during planning.

**Known risk (called out, not a placeholder):** Task 5's transport import path and `handleRequest` signature depend on the pinned SDK version (v1 vs v2 API churn). The task is structured as a spike whose integration test is the acceptance gate; the wiring is the expected v1.x shape to adapt, and the test/helper are the single places to adjust. No other task depends on those internals — they all go through `buildMcpServer`/the MCP client.
