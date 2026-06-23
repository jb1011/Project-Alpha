# Onboarding Wizard REST API — Implementation Plan (Track A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing onboarding brain as a clean, multi-tenant REST API (SIWE auth,
Bearer JWT, async onboarding + status polling) that a separate web wizard connects to.

**Architecture:** A long-running Node/Hono HTTP API in `backend/` layered over the existing
saga: an auth layer (SIWE → JWT, tenant = wallet address), tenant-scoped persistence, and an
async execution layer (a background runner drives the resumable saga; a startup reconciler
resumes in-flight work). New face over the same brain — no contract changes.

**Tech Stack:** TypeScript (ESM, `moduleResolution: Bundler` → **extensionless relative
imports**), Hono 4 (`hono/jwt`, `hono/cors`), viem 2 (`viem/siwe`, `recoverMessageAddress`),
better-sqlite3, zod 3, vitest. One new dependency: `zod-to-json-schema`.

## Global Constraints

- **Spec:** `docs/design/2026-06-21-onboarding-wizard-api-design.md`. Everything here implements that.
- **No contract changes.** Reuse the saga (`src/workflow/onboarding.ts`) and adapters as-is except
  for the additive tenant/spec threading in Task 2.
- **Imports are extensionless** (`from "../types"`, never `"../types.ts"`) — `moduleResolution: Bundler`.
- **Run all commands from `backend/`.** Tests: `npx vitest run <file>`. Full suite: `npm test`.
  Lint/types: `npm run lint` + `npm run typecheck` (must stay clean).
- **Tests use `openDatabase(":memory:")`** for SQLite; Hono routes are tested via `app.request(...)`.
- **tenantId** is always a checksummed address (viem `getAddress`). The storage key for an entity is
  the namespaced string `` `${tenantId}:${userKey}` `` (preserves the existing `idempotency_key`
  PK + events FK while giving per-tenant key isolation — see Task 1).
- **Secrets:** never log JWT secret / signatures; `EntityView` (Task 8) never exposes Turnkey ids,
  doc paths, or `specJson`.
- Commit after every task with `git add <files> && git commit -m "..."`.

---

## File Structure

**New files**
- `src/auth/nonceStore.ts` — SQLite single-use SIWE nonce store (issue/consume with TTL).
- `src/auth/siwe.ts` — `verifySiwe(...)`: parse + validate SIWE message, recover signer, burn nonce.
- `src/auth/session.ts` — `signSession` / `verifySession` over `hono/jwt`.
- `src/auth/middleware.ts` — `requireAuth(secret)` Hono middleware → sets `tenantId`.
- `src/api/errors.ts` — `ApiError`, error envelope, `apiOnError` handler.
- `src/api/views.ts` — `toEntityView(record)` (secret-free projection).
- `src/api/app.ts` — `buildApiApp(deps)` (CORS + onError + mount routes + `/healthz`).
- `src/api/routes/auth.ts` — `GET /auth/nonce`, `POST /auth/verify`.
- `src/api/routes/onboard.ts` — `POST /onboard`, `GET /entities`, `GET /entities/:id`, `POST /entities/:id/fund`.
- `src/api/routes/passkey.ts` — `GET /passkey/challenge`.
- `src/api/routes/schema.ts` — `GET /schema/agent-spec.json` (zod-to-json-schema).
- `src/api/main.ts` — composition root + `serve(...)`.
- `src/workflow/runner.ts` — `OnboardingRunner` (start/fund/reconcileInFlight).
- Test files mirror each under `test/auth/`, `test/api/`, `test/workflow/`.

**Modified files**
- `src/types.ts` — extend `EntityStatus`; add `ownerTenantId`, `error`, `specJson` to `EntityRecord`.
- `src/persistence/db.ts` — widen status CHECK; add `owner_tenant_id`/`error`/`spec_json` columns;
  add `auth_nonces` table; idempotent ALTERs.
- `src/persistence/entityRepository.ts` — persist new columns; add `listByTenant`, `listInFlight`.
- `src/config/env.ts` — add `AUTH_JWT_SECRET`, `AUTH_JWT_TTL_SEC`, `WEB_ORIGIN`, `SIWE_DOMAIN`, `PASSKEY_RP_ID`.
- `src/workflow/onboarding.ts` — thread `ownerTenantId`/`specJson` through; accept `pending` as fresh start.
- `package.json` — add `zod-to-json-schema` dep + `api` script.

---

## Task 1: Persistence — tenant ownership, new statuses, nonce table

**Files:**
- Modify: `src/types.ts`
- Modify: `src/persistence/db.ts`
- Modify: `src/persistence/entityRepository.ts`
- Test: `test/persistence/tenantScope.test.ts` (create), `test/entityRepository.test.ts` (unchanged, must still pass)

**Interfaces:**
- Produces: `EntityStatus` (now `"pending" | "provisioned" | "translating" | "created" | "bound" | "funded" | "failed"`);
  `EntityRecord` gains `ownerTenantId?: string`, `error?: string | null`, `specJson?: string | null`.
  `EntityRepository` gains `listByTenant(tenantId: string): EntityRecord[]` and `listInFlight(): EntityRecord[]`.

- [ ] **Step 1: Write the failing test** — `test/persistence/tenantScope.test.ts`

```ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";

let db: Database.Database;
let repo: SqliteEntityRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

const rec = (over: Partial<EntityRecord>): EntityRecord => ({
  idempotencyKey: "k",
  name: "A",
  status: "pending",
  manager: "0x000000000000000000000000000000000000aAaa",
  guardian: "0x000000000000000000000000000000000000bBbb",
  operator: null,
  amendmentDelay: "3600",
  ein: "",
  formationDate: 0,
  oaHash: null,
  metadataURI: null,
  docPath: null,
  treasuryConfig: null,
  agentId: null,
  proxy: null,
  treasury: null,
  createTxHash: null,
  bindTxHash: null,
  fundTxHash: null,
  ...over,
});

test("owner_tenant_id, error, spec_json round-trip; pending/failed accepted", () => {
  repo.upsert(rec({ idempotencyKey: "t1:a", ownerTenantId: "t1", status: "failed", error: "boom", specJson: '{"x":1}' }));
  const got = repo.findByIdempotencyKey("t1:a");
  expect(got?.ownerTenantId).toBe("t1");
  expect(got?.status).toBe("failed");
  expect(got?.error).toBe("boom");
  expect(got?.specJson).toBe('{"x":1}');
});

test("listByTenant returns only that tenant's rows", () => {
  repo.upsert(rec({ idempotencyKey: "t1:a", ownerTenantId: "t1" }));
  repo.upsert(rec({ idempotencyKey: "t2:a", ownerTenantId: "t2" }));
  repo.upsert(rec({ idempotencyKey: "t1:b", ownerTenantId: "t1" }));
  expect(repo.listByTenant("t1").map((r) => r.idempotencyKey).sort()).toEqual(["t1:a", "t1:b"]);
  expect(repo.listByTenant("t2").map((r) => r.idempotencyKey)).toEqual(["t2:a"]);
});

test("listInFlight returns only non-terminal statuses", () => {
  repo.upsert(rec({ idempotencyKey: "p", status: "pending", ownerTenantId: "t" }));
  repo.upsert(rec({ idempotencyKey: "c", status: "created", ownerTenantId: "t" }));
  repo.upsert(rec({ idempotencyKey: "b", status: "bound", ownerTenantId: "t" }));
  repo.upsert(rec({ idempotencyKey: "f", status: "funded", ownerTenantId: "t" }));
  repo.upsert(rec({ idempotencyKey: "x", status: "failed", ownerTenantId: "t" }));
  expect(repo.listInFlight().map((r) => r.idempotencyKey).sort()).toEqual(["c", "p"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/persistence/tenantScope.test.ts`
Expected: FAIL (CHECK constraint rejects `pending`/`failed`, or `listByTenant` undefined).

- [ ] **Step 3: Extend `EntityStatus` + `EntityRecord` in `src/types.ts`**

Replace the `EntityStatus` line and add fields to `EntityRecord`:

```ts
/** Onboarding status. Forward order: pending < provisioned < translating < created < bound < funded. `failed` is a terminal-error state. */
export type EntityStatus =
  | "pending"
  | "provisioned"
  | "translating"
  | "created"
  | "bound"
  | "funded"
  | "failed";
```

Add inside the `EntityRecord` interface (after `turnkeyWalletId?: string;`):

```ts
  /** Owning tenant (controller wallet address). Set for API-created entities. */
  ownerTenantId?: string;
  /** Failure message when status === "failed". */
  error?: string | null;
  /** Validated AgentSpec JSON, persisted so the reconciler/fund can re-run the saga. */
  specJson?: string | null;
```

- [ ] **Step 4: Migrate `src/persistence/db.ts`**

In `migrate()`, widen the entities `status` CHECK to include `'pending'` and `'failed'`:

```sql
status TEXT NOT NULL CHECK (status IN ('pending','provisioned','translating','created','bound','funded','failed')),
```

Add three columns to the entities `CREATE TABLE` (after `turnkey_wallet_id  TEXT,`):

```sql
      owner_tenant_id    TEXT,
      error              TEXT,
      spec_json          TEXT,
```

Add the nonce table (anywhere in the `db.exec` block):

```sql
    CREATE TABLE IF NOT EXISTS auth_nonces (
      nonce      TEXT PRIMARY KEY,
      issued_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
```

After the `db.exec(...)` template literal, add idempotent ALTERs so existing dev DBs gain the new
columns (CREATE TABLE IF NOT EXISTS won't add columns to an existing table):

```ts
  // Additive migration for pre-existing dev DBs (new tables/columns only).
  const cols = (db.prepare("PRAGMA table_info(entities)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("owner_tenant_id")) db.exec("ALTER TABLE entities ADD COLUMN owner_tenant_id TEXT");
  if (!cols.includes("error")) db.exec("ALTER TABLE entities ADD COLUMN error TEXT");
  if (!cols.includes("spec_json")) db.exec("ALTER TABLE entities ADD COLUMN spec_json TEXT");
```

> Note: SQLite cannot ALTER an existing CHECK constraint. A pre-existing `./data/legalbody.db`
> keeps its old CHECK and will reject `pending`/`failed`. The dev DB is throwaway (gitignored) —
> delete `backend/data/legalbody.db` once after this task. Tests use `:memory:` (always fresh).

- [ ] **Step 5: Update `src/persistence/entityRepository.ts`**

Add to the `Row` interface (after `turnkey_wallet_id: string | null;`):

```ts
  owner_tenant_id: string | null;
  error: string | null;
  spec_json: string | null;
```

In `toRecord`, add (before the closing `}`):

```ts
    ownerTenantId: r.owner_tenant_id ?? undefined,
    error: r.error ?? null,
    specJson: r.spec_json ?? null,
```

In `upsert`, add the three columns to the INSERT column list, the `VALUES` list, the `ON CONFLICT
DO UPDATE SET` list, and the `.run({...})` params:

- columns: `owner_tenant_id, error, spec_json,`
- values: `@owner_tenant_id, @error, @spec_json,`
- update set: `owner_tenant_id=excluded.owner_tenant_id, error=excluded.error, spec_json=excluded.spec_json,`
- params: `owner_tenant_id: rec.ownerTenantId ?? null, error: rec.error ?? null, spec_json: rec.specJson ?? null,`

Add to the `EntityRepository` interface:

```ts
  listByTenant(tenantId: string): EntityRecord[];
  listInFlight(): EntityRecord[];
```

Add the implementations to `SqliteEntityRepository`:

```ts
  listByTenant(tenantId: string): EntityRecord[] {
    return (
      this.db.prepare("SELECT * FROM entities WHERE owner_tenant_id = ? ORDER BY rowid").all(tenantId) as Row[]
    ).map(toRecord);
  }

  listInFlight(): EntityRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM entities WHERE status IN ('pending','provisioned','translating','created') ORDER BY rowid")
        .all() as Row[]
    ).map(toRecord);
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/persistence/tenantScope.test.ts test/entityRepository.test.ts`
Expected: PASS (new test + the existing repo test, unchanged).

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/persistence/db.ts src/persistence/entityRepository.ts test/persistence/tenantScope.test.ts
git commit -m "feat(persistence): tenant ownership, pending/failed statuses, nonce table"
```

---

## Task 2: Saga — thread ownerTenantId/specJson, accept `pending`

**Files:**
- Modify: `src/workflow/onboarding.ts`
- Test: `test/workflow/tenantThread.test.ts` (create)

**Interfaces:**
- Consumes: `EntityRepository`, `translate`, `ArcAdapter`, `OperatorSigner` (existing).
- Produces: `OnboardingDeps` gains `ownerTenantId?: string` and `specJson?: string`; the saga writes
  both onto every record it builds and treats `status === "pending"` like a fresh start.

- [ ] **Step 1: Write the failing test** — `test/workflow/tenantThread.test.ts`

```ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { runOnboarding } from "../../src/workflow/onboarding";
import type { AgentSpec } from "../../src/policy/agentSpec";

let db: Database.Database;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

const spec = {
  name: "Tenant Agent",
  jurisdiction: "Wyoming-DAO-LLC",
  roles: {
    manager: "0x000000000000000000000000000000000000aAaa",
    guardian: "0x000000000000000000000000000000000000bBbb",
    operator: "0x000000000000000000000000000000000000cCcc",
  },
  treasury: {
    payoutAddress: "0x000000000000000000000000000000000000dDdd",
    spendingCapUsdc: "100.00",
    spendingPeriod: "24h",
    allowlistEnabled: false,
  },
  governance: { amendmentDelay: "24h" },
  legal: {},
  metadata: {},
} as unknown as AgentSpec;

// Structural fake ArcAdapter: just enough for the legacy (no-passkey) saga path.
const fakeArc = {
  chainId: 5042002,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  createEntity: async () => ({ agentId: 7n, proxy: "0x00000000000000000000000000000000000000Ef", treasury: "0x00000000000000000000000000000000000000Fe", txHash: "0xaa" }),
  walletSetDeadline: async () => 9999999999n,
  eip712Domain: async () => ({ name: "ERC8004IdentityRegistry", version: "1" }),
  setAgentWallet: async () => "0xbb",
} as never;

const fakeSigner = { address: "0x000000000000000000000000000000000000cCcc", signWalletSet: async () => "0xsig" } as never;

test("saga persists ownerTenantId + specJson and resumes from pending", async () => {
  const repo = new SqliteEntityRepository(db);
  const docStore = new FileDocumentStore(`/tmp/legalbody-test-${Math.floor(performance.now())}`);
  const out = await runOnboarding({
    spec,
    idempotencyKey: "t9:tenant-agent",
    repo,
    docStore,
    arc: fakeArc,
    operatorSigner: fakeSigner,
    usdc: "0x3600000000000000000000000000000000000000",
    ownerTenantId: "t9",
    specJson: JSON.stringify(spec),
  });
  expect(out.status).toBe("bound");
  expect(out.ownerTenantId).toBe("t9");
  const got = repo.findByIdempotencyKey("t9:tenant-agent");
  expect(got?.ownerTenantId).toBe("t9");
  expect(got?.specJson).toBe(JSON.stringify(spec));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/workflow/tenantThread.test.ts`
Expected: FAIL (`ownerTenantId` undefined on the persisted record; `OnboardingDeps` has no such field).

- [ ] **Step 3: Thread the fields in `src/workflow/onboarding.ts`**

Add to the `OnboardingDeps` interface (after `usdc: Address;`):

```ts
  /** Owning tenant (controller wallet address); persisted on every record the saga writes. */
  ownerTenantId?: string;
  /** Validated AgentSpec JSON; persisted so the reconciler/fund can re-run the saga. */
  specJson?: string;
```

In the Step-0 **minimal** record literal (the `else` branch that builds a fresh provisioned row),
add after `turnkeyWalletId: vault.walletId,`:

```ts
          ownerTenantId: d.ownerTenantId,
          error: null,
          specJson: d.specJson ?? null,
```

In the translate-step record literal, add after `turnkeyWalletId: rec?.turnkeyWalletId,`:

```ts
      ownerTenantId: d.ownerTenantId ?? rec?.ownerTenantId,
      error: null,
      specJson: d.specJson ?? rec?.specJson ?? null,
```

Update the translate-step guard to also start fresh from `pending`:

```ts
  if (!rec || rec.status === "pending" || rec.status === "provisioned" || rec.status === "translating") {
```

(The `created`/`bound`/`funded` steps spread `...rec`, so they already carry the new fields forward.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/workflow/tenantThread.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the existing saga int tests still pass**

Run: `npx vitest run test/onboarding.int.test.ts`
Expected: PASS (additive change; legacy path unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/workflow/onboarding.ts test/workflow/tenantThread.test.ts
git commit -m "feat(workflow): thread ownerTenantId/specJson through saga; accept pending"
```

---

## Task 3: Auth — SIWE nonce store + verify

**Files:**
- Create: `src/auth/nonceStore.ts`, `src/auth/siwe.ts`
- Test: `test/auth/siwe.test.ts`

**Interfaces:**
- Produces: `class SqliteNonceStore { issue(now: number, ttlMs: number): string; consume(nonce: string, now: number): boolean }`.
  `verifySiwe(args: { message: string; signature: \`0x${string}\`; nonceStore: NonceStore; domain: string; chainId: number; now: number }): Promise<\`0x${string}\`>` —
  returns the checksummed signer address or throws `ApiError("unauthorized", 401, ...)` (see Task 5; for this task, import `ApiError` after Task 5 — to keep order independent, throw a plain `Error` with a `code` prop here and let Task 5's `apiOnError` map by message... no: do Task 5 first if executing strictly. We avoid the cycle: define a local `AuthError extends Error` here.)

> Ordering note: `verifySiwe` throws `AuthError` (defined here). Task 5's `apiOnError` maps any
> error carrying a `status` number to that status; `AuthError` sets `status = 401`.

- [ ] **Step 1: Write the failing test** — `test/auth/siwe.test.ts`

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import type Database from "better-sqlite3";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { verifySiwe } from "../../src/auth/siwe";

let db: Database.Database;
let store: SqliteNonceStore;
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
const NOW = 1_700_000_000_000;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqliteNonceStore(db);
});
afterEach(() => db.close());

async function signedMessage(nonce: string, over: Partial<{ chainId: number; domain: string }> = {}) {
  const message = createSiweMessage({
    address: account.address,
    chainId: over.chainId ?? CHAIN,
    domain: over.domain ?? DOMAIN,
    nonce,
    uri: `https://${DOMAIN}`,
    version: "1",
    issuedAt: new Date(NOW),
  });
  const signature = await account.signMessage({ message });
  return { message, signature };
}

test("valid SIWE message verifies to the signer address", async () => {
  const nonce = store.issue(NOW, 600_000);
  const { message, signature } = await signedMessage(nonce);
  const addr = await verifySiwe({ message, signature, nonceStore: store, domain: DOMAIN, chainId: CHAIN, now: NOW });
  expect(addr).toBe(account.address);
});

test("replayed nonce is rejected (single-use)", async () => {
  const nonce = store.issue(NOW, 600_000);
  const { message, signature } = await signedMessage(nonce);
  await verifySiwe({ message, signature, nonceStore: store, domain: DOMAIN, chainId: CHAIN, now: NOW });
  await expect(
    verifySiwe({ message, signature, nonceStore: store, domain: DOMAIN, chainId: CHAIN, now: NOW }),
  ).rejects.toThrow(/nonce/i);
});

test("unknown nonce is rejected", async () => {
  const { message, signature } = await signedMessage("deadbeefdeadbeef");
  await expect(
    verifySiwe({ message, signature, nonceStore: store, domain: DOMAIN, chainId: CHAIN, now: NOW }),
  ).rejects.toThrow(/nonce/i);
});

test("expired nonce is rejected", async () => {
  const nonce = store.issue(NOW, 1_000);
  const { message, signature } = await signedMessage(nonce);
  await expect(
    verifySiwe({ message, signature, nonceStore: store, domain: DOMAIN, chainId: CHAIN, now: NOW + 2_000 }),
  ).rejects.toThrow(/nonce/i);
});

test("wrong domain is rejected", async () => {
  const nonce = store.issue(NOW, 600_000);
  const { message, signature } = await signedMessage(nonce, { domain: "evil.example" });
  await expect(
    verifySiwe({ message, signature, nonceStore: store, domain: DOMAIN, chainId: CHAIN, now: NOW }),
  ).rejects.toThrow(/domain/i);
});

test("tampered signature is rejected", async () => {
  const nonce = store.issue(NOW, 600_000);
  const { message } = await signedMessage(nonce);
  const bad = (`0x${"1".repeat(130)}`) as `0x${string}`;
  await expect(
    verifySiwe({ message, signature: bad, nonceStore: store, domain: DOMAIN, chainId: CHAIN, now: NOW }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/auth/siwe.test.ts`
Expected: FAIL ("Cannot find module ../../src/auth/nonceStore").

- [ ] **Step 3: Write `src/auth/nonceStore.ts`**

```ts
import type Database from "better-sqlite3";
import { generateSiweNonce } from "viem/siwe";

export interface NonceStore {
  issue(now: number, ttlMs: number): string;
  consume(nonce: string, now: number): boolean;
}

/** Single-use, TTL-bounded SIWE nonces backed by the auth_nonces table. */
export class SqliteNonceStore implements NonceStore {
  constructor(private readonly db: Database.Database) {}

  issue(now: number, ttlMs: number): string {
    const nonce = generateSiweNonce();
    this.db
      .prepare("INSERT INTO auth_nonces (nonce, issued_at, expires_at) VALUES (?,?,?)")
      .run(nonce, now, now + ttlMs);
    return nonce;
  }

  /** Returns true iff the nonce existed and was unexpired; deletes it either way (burn-on-consume). */
  consume(nonce: string, now: number): boolean {
    const row = this.db.prepare("SELECT expires_at FROM auth_nonces WHERE nonce = ?").get(nonce) as
      | { expires_at: number }
      | undefined;
    this.db.prepare("DELETE FROM auth_nonces WHERE nonce = ?").run(nonce);
    return !!row && row.expires_at > now;
  }
}
```

- [ ] **Step 4: Write `src/auth/siwe.ts`**

```ts
import { getAddress, recoverMessageAddress } from "viem";
import { parseSiweMessage } from "viem/siwe";
import type { NonceStore } from "./nonceStore";

/** Auth failure carrying the HTTP status apiOnError (Task 5) maps it to. */
export class AuthError extends Error {
  readonly code = "unauthorized";
  readonly status = 401;
}

export interface VerifySiweArgs {
  message: string;
  signature: `0x${string}`;
  nonceStore: NonceStore;
  domain: string;
  chainId: number;
  now: number;
}

/**
 * Validate a SIWE (EIP-4361) login: check domain/chainId/expiry, recover the signer from the
 * signature, then burn the nonce (single-use). Returns the checksummed signer address.
 */
export async function verifySiwe(a: VerifySiweArgs): Promise<`0x${string}`> {
  const fields = parseSiweMessage(a.message);
  if (!fields.address || !fields.nonce) throw new AuthError("malformed SIWE message");
  if (fields.domain !== a.domain) throw new AuthError(`bad domain: ${fields.domain}`);
  if (fields.chainId !== undefined && fields.chainId !== a.chainId)
    throw new AuthError(`bad chainId: ${fields.chainId}`);
  if (fields.expirationTime && fields.expirationTime.getTime() <= a.now)
    throw new AuthError("message expired");

  const recovered = await recoverMessageAddress({ message: a.message, signature: a.signature });
  if (getAddress(recovered) !== getAddress(fields.address))
    throw new AuthError("signature does not match address");

  // Burn the nonce last: a valid, unexpired, previously-issued nonce is required.
  if (!a.nonceStore.consume(fields.nonce, a.now)) throw new AuthError("unknown or expired nonce");

  return getAddress(fields.address);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/auth/siwe.test.ts`
Expected: PASS (all 6).

- [ ] **Step 6: Commit**

```bash
git add src/auth/nonceStore.ts src/auth/siwe.ts test/auth/siwe.test.ts
git commit -m "feat(auth): SIWE nonce store + verifySiwe"
```

---

## Task 4: Auth — JWT session + middleware

**Files:**
- Create: `src/auth/session.ts`, `src/auth/middleware.ts`
- Test: `test/auth/session.test.ts`

**Interfaces:**
- Produces: `signSession(address: string, secret: string, ttlSec: number, now: number): Promise<{ token: string; expiresAt: number }>`;
  `verifySession(token: string, secret: string): Promise<{ tenantId: \`0x${string}\` }>` (throws on invalid/expired);
  `requireAuth(secret: string)` — Hono middleware that sets `c.set("tenantId", addr)` or throws `AuthError`.

- [ ] **Step 1: Write the failing test** — `test/auth/session.test.ts`

```ts
import { Hono } from "hono";
import { expect, test } from "vitest";
import { requireAuth } from "../../src/auth/middleware";
import { signSession, verifySession } from "../../src/auth/session";

const SECRET = "test-secret";
const ADDR = "0x000000000000000000000000000000000000aAaa";
const NOW = 1_700_000_000;

test("signSession then verifySession round-trips the tenantId", async () => {
  const { token } = await signSession(ADDR, SECRET, 3600, NOW);
  expect((await verifySession(token, SECRET)).tenantId).toBe(ADDR);
});

test("expired token is rejected", async () => {
  const { token } = await signSession(ADDR, SECRET, -10, NOW); // already expired
  await expect(verifySession(token, SECRET)).rejects.toThrow();
});

test("tampered/garbage token is rejected", async () => {
  await expect(verifySession("not.a.jwt", SECRET)).rejects.toThrow();
});

test("requireAuth sets tenantId on valid Bearer", async () => {
  const { token } = await signSession(ADDR, SECRET, 3600, NOW);
  const app = new Hono();
  app.use("*", requireAuth(SECRET));
  app.get("/me", (c) => c.json({ tenantId: c.get("tenantId") }));
  const res = await app.request("/me", { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect((await res.json()).tenantId).toBe(ADDR);
});

test("requireAuth throws (401-mapped) on missing token", async () => {
  const app = new Hono();
  app.use("*", requireAuth(SECRET));
  app.get("/me", (c) => c.json({ ok: true }));
  app.onError((e, c) => c.json({ error: (e as { code?: string }).code ?? "err" }, ((e as { status?: number }).status ?? 500) as 401));
  const res = await app.request("/me");
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/auth/session.test.ts`
Expected: FAIL ("Cannot find module ../../src/auth/session").

- [ ] **Step 3: Write `src/auth/session.ts`**

```ts
import { sign, verify } from "hono/jwt";
import { getAddress } from "viem";
import { AuthError } from "./siwe";

/** Mint an HS256 JWT whose subject is the tenant (controller wallet) address. */
export async function signSession(
  address: string,
  secret: string,
  ttlSec: number,
  now: number,
): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now + ttlSec;
  const token = await sign({ sub: getAddress(address), exp: expiresAt }, secret);
  return { token, expiresAt };
}

/** Verify a session JWT; returns the tenantId. Throws AuthError on invalid/expired. */
export async function verifySession(token: string, secret: string): Promise<{ tenantId: `0x${string}` }> {
  let payload: { sub?: unknown };
  try {
    payload = (await verify(token, secret)) as { sub?: unknown };
  } catch {
    throw new AuthError("invalid or expired session");
  }
  if (typeof payload.sub !== "string") throw new AuthError("invalid session subject");
  return { tenantId: getAddress(payload.sub) };
}
```

- [ ] **Step 4: Write `src/auth/middleware.ts`**

```ts
import type { MiddlewareHandler } from "hono";
import { AuthError } from "./siwe";
import { verifySession } from "./session";

/** Hono context vars set by requireAuth. */
export type AuthVars = { tenantId: `0x${string}` };

/** Require a valid Bearer session; sets c.get("tenantId"). Throws AuthError (401) otherwise. */
export function requireAuth(secret: string): MiddlewareHandler<{ Variables: AuthVars }> {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) throw new AuthError("missing Bearer token");
    const { tenantId } = await verifySession(token, secret);
    c.set("tenantId", tenantId);
    await next();
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/auth/session.test.ts`
Expected: PASS (all 5).

- [ ] **Step 6: Commit**

```bash
git add src/auth/session.ts src/auth/middleware.ts test/auth/session.test.ts
git commit -m "feat(auth): JWT session sign/verify + requireAuth middleware"
```

---

## Task 5: API — error envelope, app skeleton, CORS, health

**Files:**
- Create: `src/api/errors.ts`, `src/api/app.ts`
- Test: `test/api/app.test.ts`

**Interfaces:**
- Produces: `class ApiError extends Error { code: string; status: ContentfulStatusCode; details?: unknown }`;
  `apiOnError(err, c)` Hono error handler; `buildApiApp(deps: ApiDeps)` returning a Hono app with
  CORS + onError + `GET /healthz`. `ApiDeps` is extended by later tasks; for now `{ webOrigin: string }`.

- [ ] **Step 1: Write the failing test** — `test/api/app.test.ts`

```ts
import { expect, test } from "vitest";
import { ApiError } from "../../src/api/errors";
import { buildApiApp } from "../../src/api/app";

const deps = { webOrigin: "*" } as never;

test("GET /healthz returns ok", async () => {
  const res = await buildApiApp(deps).request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});

test("apiOnError maps ApiError to its status + envelope", async () => {
  const app = buildApiApp(deps);
  app.get("/boom", () => {
    throw new ApiError("not_found", 404, "nope", { id: "x" });
  });
  const res = await app.request("/boom");
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: "not_found", message: "nope", details: { id: "x" } } });
});

test("unknown error maps to 500 envelope", async () => {
  const app = buildApiApp(deps);
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  const res = await app.request("/boom");
  expect(res.status).toBe(500);
  expect((await res.json()).error.code).toBe("internal_error");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/api/app.test.ts`
Expected: FAIL ("Cannot find module ../../src/api/errors").

- [ ] **Step 3: Write `src/api/errors.ts`**

```ts
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

/** A typed API failure mapped to a stable error envelope. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: ContentfulStatusCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Hono onError: ApiError → its status; ZodError → 400; AuthError (status prop) → its status; else 500. */
export function apiOnError(err: Error, c: Context) {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return c.json({ error: { code: "validation_error", message: "invalid request", details: issues } }, 400);
  }
  const maybe = err as { code?: string; status?: number };
  if (typeof maybe.status === "number") {
    return c.json(
      { error: { code: maybe.code ?? "error", message: err.message } },
      maybe.status as ContentfulStatusCode,
    );
  }
  return c.json({ error: { code: "internal_error", message: "internal error" } }, 500);
}
```

- [ ] **Step 4: Write `src/api/app.ts`**

```ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AuthVars } from "../auth/middleware";
import { apiOnError } from "./errors";

/** Dependencies for the REST API. Extended by later tasks (auth/onboard routes). */
export interface ApiDeps {
  webOrigin: string;
}

/** Build the wizard REST API app: CORS + error envelope + /healthz. Routes mounted by later tasks. */
export function buildApiApp(deps: ApiDeps) {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", cors({ origin: deps.webOrigin, allowHeaders: ["authorization", "content-type"] }));
  app.onError(apiOnError);
  app.get("/healthz", (c) => c.json({ ok: true }));
  return app;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/api/app.test.ts`
Expected: PASS (all 3).

- [ ] **Step 6: Commit**

```bash
git add src/api/errors.ts src/api/app.ts test/api/app.test.ts
git commit -m "feat(api): error envelope + app skeleton (CORS, onError, healthz)"
```

---

## Task 6: API — auth routes (nonce + verify)

**Files:**
- Create: `src/api/routes/auth.ts`
- Modify: `src/api/app.ts` (extend `ApiDeps`; mount auth routes)
- Test: `test/api/auth.routes.test.ts`

**Interfaces:**
- Consumes: `verifySiwe` (Task 3), `signSession` (Task 4), `SqliteNonceStore` (Task 3).
- Produces: `mountAuthRoutes(app, deps)`; `ApiDeps` gains `nonceStore: NonceStore`, `siweDomain: string`,
  `chainId: number`, `jwtSecret: string`, `jwtTtlSec: number`, `now?: () => number`.

- [ ] **Step 1: Write the failing test** — `test/api/auth.routes.test.ts`

```ts
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { verifySession } from "../../src/auth/session";
import { buildApiApp } from "../../src/api/app";
import { migrate, openDatabase } from "../../src/persistence/db";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const DOMAIN = "wizard.local";
const CHAIN = 5042002;

let db: Database.Database;
function app(db: Database.Database) {
  return buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
  } as never);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});
afterEach(() => db.close());

test("nonce -> sign -> verify issues a session for the signer", async () => {
  const a = app(db);
  const nonce = (await (await a.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: account.address, chainId: CHAIN, domain: DOMAIN, nonce,
    uri: `https://${DOMAIN}`, version: "1",
  });
  const signature = await account.signMessage({ message });
  const res = await a.request("/auth/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.address).toBe(account.address);
  expect((await verifySession(body.token, "s")).tenantId).toBe(account.address);
});

test("verify with a bad signature returns 401 envelope", async () => {
  const a = app(db);
  const nonce = (await (await a.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({
    address: account.address, chainId: CHAIN, domain: DOMAIN, nonce, uri: `https://${DOMAIN}`, version: "1",
  });
  const res = await a.request("/auth/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature: `0x${"1".repeat(130)}` }),
  });
  expect(res.status).toBe(401);
  expect((await res.json()).error.code).toBe("unauthorized");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/api/auth.routes.test.ts`
Expected: FAIL (no `/auth/nonce` route → 404).

- [ ] **Step 3: Extend `ApiDeps` + mount in `src/api/app.ts`**

Add to `ApiDeps`:

```ts
  nonceStore: import("../auth/nonceStore").NonceStore;
  siweDomain: string;
  chainId: number;
  jwtSecret: string;
  jwtTtlSec: number;
  /** Injectable clock (ms) for tests; defaults to Date.now. */
  now?: () => number;
```

In `buildApiApp`, after `app.get("/healthz", ...)` add:

```ts
  mountAuthRoutes(app, deps);
```

And add the import at the top: `import { mountAuthRoutes } from "./routes/auth";`

- [ ] **Step 4: Write `src/api/routes/auth.ts`**

```ts
import type { Hono } from "hono";
import { verifySiwe } from "../../auth/siwe";
import { signSession } from "../../auth/session";
import { ApiError } from "../errors";
import type { ApiDeps } from "../app";

const NONCE_TTL_MS = 600_000; // 10 min

export function mountAuthRoutes(app: Hono<{ Variables: { tenantId: `0x${string}` } }>, deps: ApiDeps) {
  const now = () => (deps.now ? deps.now() : Date.now());

  app.get("/auth/nonce", (c) => c.json({ nonce: deps.nonceStore.issue(now(), NONCE_TTL_MS) }));

  app.post("/auth/verify", async (c) => {
    let body: { message?: unknown; signature?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (typeof body.message !== "string" || typeof body.signature !== "string")
      throw new ApiError("validation_error", 400, "message and signature are required");

    const address = await verifySiwe({
      message: body.message,
      signature: body.signature as `0x${string}`,
      nonceStore: deps.nonceStore,
      domain: deps.siweDomain,
      chainId: deps.chainId,
      now: now(),
    });
    const { token, expiresAt } = await signSession(address, deps.jwtSecret, deps.jwtTtlSec, Math.floor(now() / 1000));
    return c.json({ token, address, expiresAt });
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/api/auth.routes.test.ts`
Expected: PASS (both).

- [ ] **Step 6: Commit**

```bash
git add src/api/routes/auth.ts src/api/app.ts test/api/auth.routes.test.ts
git commit -m "feat(api): SIWE auth routes (nonce + verify -> JWT)"
```

---

## Task 7: Onboarding runner (start, fund, reconcile)

**Files:**
- Create: `src/workflow/runner.ts`
- Test: `test/workflow/runner.test.ts`

**Interfaces:**
- Consumes: `EntityRepository` (Task 1), `AgentSpec`, `GuardianPasskey`, `EntityRecord`.
- Produces:
  ```ts
  type RunSaga = (input: {
    spec: AgentSpec; idempotencyKey: string; tenantId: string;
    guardianPasskey?: GuardianPasskey; specJson: string; fundAmount?: bigint;
  }) => Promise<EntityRecord>;
  class OnboardingRunner {
    constructor(deps: { repo: EntityRepository; runSaga: RunSaga });
    start(p: { spec: AgentSpec; userKey: string; tenantId: string; guardianPasskey: GuardianPasskey }): { id: string; status: EntityStatus };
    fund(p: { id: string; tenantId: string; amount: bigint }): { id: string; status: EntityStatus };
    reconcileInFlight(): number; // count resumed
    settled(): Promise<void>;    // test helper: await all background tasks
  }
  ```
  Storage key (`id`) = `` `${tenantId}:${userKey}` ``.

- [ ] **Step 1: Write the failing test** — `test/workflow/runner.test.ts`

```ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { OnboardingRunner } from "../../src/workflow/runner";
import type { AgentSpec } from "../../src/policy/agentSpec";
import type { EntityRecord } from "../../src/types";

const TENANT = "0x000000000000000000000000000000000000aAaa";
const spec = { name: "Demo", roles: { manager: "0x00000000000000000000000000000000000000Ma", guardian: TENANT } } as unknown as AgentSpec;
const passkey = { challenge: "c", attestation: {} } as never;

let db: Database.Database;
let repo: SqliteEntityRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});
afterEach(() => db.close());

// A fake saga that drives the persisted record to `bound` (mirrors what the real saga upserts).
const runSaga = async (i: { idempotencyKey: string; tenantId: string; specJson: string }): Promise<EntityRecord> => {
  const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
  const bound = { ...cur, status: "bound" as const, agentId: "5", treasury: "0x00000000000000000000000000000000000000Fe" };
  repo.upsert(bound);
  return bound;
};

test("start persists a pending record immediately and returns its id", () => {
  const runner = new OnboardingRunner({ repo, runSaga });
  const { id, status } = runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey });
  expect(id).toBe(`${TENANT}:Demo`);
  expect(status).toBe("pending");
  const row = repo.findByIdempotencyKey(id)!;
  expect(row.ownerTenantId).toBe(TENANT);
  expect(row.status).toBe("pending");
  expect(row.specJson).toContain("Demo");
});

test("background saga drives the record to bound", async () => {
  const runner = new OnboardingRunner({ repo, runSaga });
  const { id } = runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey });
  await runner.settled();
  expect(repo.findByIdempotencyKey(id)?.status).toBe("bound");
});

test("a failing saga marks the record failed with the error", async () => {
  const runner = new OnboardingRunner({ repo, runSaga: async () => { throw new Error("provision blew up"); } });
  const { id } = runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey });
  await runner.settled();
  const row = repo.findByIdempotencyKey(id)!;
  expect(row.status).toBe("failed");
  expect(row.error).toBe("provision blew up");
});

test("starting an already in-flight key is a 409 conflict", () => {
  const runner = new OnboardingRunner({ repo, runSaga: async (i) => repo.findByIdempotencyKey(i.idempotencyKey)! });
  runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey });
  expect(() => runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey })).toThrowError(
    expect.objectContaining({ status: 409 }),
  );
});

test("two tenants may reuse the same userKey", () => {
  const runner = new OnboardingRunner({ repo, runSaga: async (i) => repo.findByIdempotencyKey(i.idempotencyKey)! });
  const a = runner.start({ spec, userKey: "Demo", tenantId: TENANT, guardianPasskey: passkey });
  const b = runner.start({ spec, userKey: "Demo", tenantId: "0x000000000000000000000000000000000000bBbb", guardianPasskey: passkey });
  expect(a.id).not.toBe(b.id);
});

test("reconcileInFlight resumes a record stuck at created (subOrgId present)", async () => {
  // Seed a crashed-mid-flight record: created, with a sub-org id, and persisted spec.
  repo.upsert({
    idempotencyKey: `${TENANT}:Resume`, name: "Resume", status: "created", ownerTenantId: TENANT,
    manager: "0x00000000000000000000000000000000000000Ma", guardian: TENANT, operator: "0x00000000000000000000000000000000000000Op",
    amendmentDelay: "3600", ein: "", formationDate: 0, oaHash: null, metadataURI: null, docPath: null,
    treasuryConfig: null, agentId: "5", proxy: null, treasury: null, createTxHash: "0x1", bindTxHash: null, fundTxHash: null,
    turnkeySubOrgId: "sub_1", turnkeyWalletId: "w_1", specJson: JSON.stringify(spec), error: null,
  });
  const runner = new OnboardingRunner({ repo, runSaga });
  expect(runner.reconcileInFlight()).toBe(1);
  await runner.settled();
  expect(repo.findByIdempotencyKey(`${TENANT}:Resume`)?.status).toBe("bound");
});

test("reconcileInFlight fails a pending record with no sub-org (cannot resume without passkey)", async () => {
  repo.upsert({
    idempotencyKey: `${TENANT}:Stuck`, name: "Stuck", status: "pending", ownerTenantId: TENANT,
    manager: "0x00000000000000000000000000000000000000Ma", guardian: TENANT, operator: null,
    amendmentDelay: "3600", ein: "", formationDate: 0, oaHash: null, metadataURI: null, docPath: null,
    treasuryConfig: null, agentId: null, proxy: null, treasury: null, createTxHash: null, bindTxHash: null, fundTxHash: null,
    specJson: JSON.stringify(spec), error: null,
  });
  const runner = new OnboardingRunner({ repo, runSaga });
  runner.reconcileInFlight();
  await runner.settled();
  expect(repo.findByIdempotencyKey(`${TENANT}:Stuck`)?.status).toBe("failed");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/workflow/runner.test.ts`
Expected: FAIL ("Cannot find module ../../src/workflow/runner").

- [ ] **Step 3: Write `src/workflow/runner.ts`**

```ts
import { ApiError } from "../api/errors";
import type { EntityRepository } from "../persistence/entityRepository";
import type { AgentSpec } from "../policy/agentSpec";
import type { GuardianPasskey } from "../adapters/turnkey/provisioner";
import type { Address, EntityRecord, EntityStatus } from "../types";

export type RunSaga = (input: {
  spec: AgentSpec;
  idempotencyKey: string;
  tenantId: string;
  guardianPasskey?: GuardianPasskey;
  specJson: string;
  fundAmount?: bigint;
}) => Promise<EntityRecord>;

const TERMINAL: EntityStatus[] = ["bound", "funded", "failed"];

/** Drives the resumable onboarding saga in-process: immediate pending record + background run. */
export class OnboardingRunner {
  private readonly inFlight = new Set<string>();
  private readonly pending: Promise<unknown>[] = [];

  constructor(private readonly deps: { repo: EntityRepository; runSaga: RunSaga }) {}

  start(p: { spec: AgentSpec; userKey: string; tenantId: string; guardianPasskey: GuardianPasskey }): {
    id: string;
    status: EntityStatus;
  } {
    const id = `${p.tenantId}:${p.userKey}`;
    if (this.inFlight.has(id) || this.deps.repo.findByIdempotencyKey(id))
      throw new ApiError("conflict", 409, `onboarding already exists for "${p.userKey}"`);

    const specJson = JSON.stringify(p.spec);
    const initial: EntityRecord = {
      idempotencyKey: id,
      name: p.spec.name,
      status: "pending",
      manager: p.spec.roles.manager as Address,
      guardian: p.tenantId as Address,
      operator: null,
      amendmentDelay: "0",
      ein: "",
      formationDate: 0,
      oaHash: null,
      metadataURI: null,
      docPath: null,
      treasuryConfig: null,
      agentId: null,
      proxy: null,
      treasury: null,
      createTxHash: null,
      bindTxHash: null,
      fundTxHash: null,
      ownerTenantId: p.tenantId,
      error: null,
      specJson,
    };
    this.deps.repo.upsert(initial);
    this.run(id, () =>
      this.deps.runSaga({ spec: p.spec, idempotencyKey: id, tenantId: p.tenantId, guardianPasskey: p.guardianPasskey, specJson }),
    );
    return { id, status: "pending" };
  }

  fund(p: { id: string; tenantId: string; amount: bigint }): { id: string; status: EntityStatus } {
    const rec = this.deps.repo.findByIdempotencyKey(p.id);
    if (!rec || rec.ownerTenantId !== p.tenantId) throw new ApiError("not_found", 404, "entity not found");
    if (rec.status !== "bound") throw new ApiError("conflict", 409, `cannot fund in status "${rec.status}"`);
    if (this.inFlight.has(p.id)) throw new ApiError("conflict", 409, "entity is busy");
    const spec = JSON.parse(rec.specJson ?? "{}") as AgentSpec;
    this.run(p.id, () =>
      this.deps.runSaga({ spec, idempotencyKey: p.id, tenantId: p.tenantId, specJson: rec.specJson ?? "{}", fundAmount: p.amount }),
    );
    return { id: p.id, status: rec.status };
  }

  /** Resume non-terminal records after a restart. Records past provisioning resume; pre-provision pending ones fail. */
  reconcileInFlight(): number {
    let resumed = 0;
    for (const rec of this.deps.repo.listInFlight()) {
      if (this.inFlight.has(rec.idempotencyKey)) continue;
      if (!rec.turnkeySubOrgId) {
        // Crashed before the vault existed: can't resume without the (unpersisted) passkey.
        this.deps.repo.upsert({ ...rec, status: "failed", error: "interrupted before provisioning; please re-onboard" });
        continue;
      }
      const spec = JSON.parse(rec.specJson ?? "{}") as AgentSpec;
      this.run(rec.idempotencyKey, () =>
        this.deps.runSaga({ spec, idempotencyKey: rec.idempotencyKey, tenantId: rec.ownerTenantId ?? "", specJson: rec.specJson ?? "{}" }),
      );
      resumed++;
    }
    return resumed;
  }

  /** Await all background work (tests/shutdown). */
  async settled(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  private run(id: string, fn: () => Promise<unknown>) {
    this.inFlight.add(id);
    const task = (async () => {
      try {
        await fn();
      } catch (e) {
        const cur = this.deps.repo.findByIdempotencyKey(id);
        if (cur && !TERMINAL.includes(cur.status))
          this.deps.repo.upsert({ ...cur, status: "failed", error: e instanceof Error ? e.message : String(e) });
      } finally {
        this.inFlight.delete(id);
      }
    })();
    this.pending.push(task);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/workflow/runner.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add src/workflow/runner.ts test/workflow/runner.test.ts
git commit -m "feat(workflow): in-process onboarding runner (start/fund/reconcile)"
```

---

## Task 8: API — onboard / entities / fund / passkey routes

**Files:**
- Create: `src/api/views.ts`, `src/api/routes/onboard.ts`, `src/api/routes/passkey.ts`
- Modify: `src/api/app.ts` (extend `ApiDeps`; mount protected routes under `requireAuth`)
- Test: `test/api/onboard.routes.test.ts`

**Interfaces:**
- Consumes: `OnboardingRunner` (Task 7), `requireAuth` (Task 4), `parseAgentSpec`/`AgentSpecSchema` (existing), `EntityRepository`.
- Produces: `toEntityView(rec): EntityView`; `mountProtectedRoutes(app, deps)`; `mountPasskeyRoutes(app, deps)`.
  `ApiDeps` gains `runner: OnboardingRunner`, `repo: EntityRepository`, `passkeyRpId: string`.

- [ ] **Step 1: Write the failing test** — `test/api/onboard.routes.test.ts`

```ts
import type Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { OnboardingRunner } from "../../src/workflow/runner";
import type { EntityRecord } from "../../src/types";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
const MANAGER = "0x00000000000000000000000000000000000000Ma";

let db: Database.Database;
let repo: SqliteEntityRepository;

function makeApp() {
  const runSaga = async (i: { idempotencyKey: string }): Promise<EntityRecord> => {
    const cur = repo.findByIdempotencyKey(i.idempotencyKey)!;
    const bound = { ...cur, status: "bound" as const, agentId: "5" };
    repo.upsert(bound);
    return bound;
  };
  const runner = new OnboardingRunner({ repo, runSaga });
  const app = buildApiApp({
    webOrigin: "*", nonceStore: new SqliteNonceStore(db), siweDomain: DOMAIN, chainId: CHAIN,
    jwtSecret: "s", jwtTtlSec: 3600, repo, runner, passkeyRpId: "wizard.local",
  } as never);
  return { app, runner }; // runner exposed so tests can await background work deterministically
}

async function login(app: ReturnType<typeof buildApiApp>) {
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({ address: account.address, chainId: CHAIN, domain: DOMAIN, nonce, uri: `https://${DOMAIN}`, version: "1" });
  const signature = await account.signMessage({ message });
  const body = await (await app.request("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) })).json();
  return body.token as string;
}

const validSpec = {
  name: "WizardAgent", jurisdiction: "Wyoming-DAO-LLC",
  roles: { manager: MANAGER }, // guardian filled by the server = tenant
  treasury: { payoutAddress: "0x00000000000000000000000000000000000000Pd", spendingCapUsdc: "100.00", spendingPeriod: "24h" },
  governance: { amendmentDelay: "24h" },
};
const passkey = { challenge: "c", attestation: { credentialId: "id", clientDataJson: "j", attestationObject: "a", transports: ["AUTHENTICATOR_TRANSPORT_HYBRID"] } };

beforeEach(() => { db = openDatabase(":memory:"); migrate(db); repo = new SqliteEntityRepository(db); });
afterEach(() => db.close());

test("protected routes require auth", async () => {
  const res = await makeApp().app.request("/entities");
  expect(res.status).toBe(401);
});

test("onboard accepts (202 pending), then resolves to bound, guardian = tenant", async () => {
  const { app, runner } = makeApp();
  const token = await login(app);
  const res = await app.request("/onboard", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ spec: validSpec, guardianPasskey: passkey }) });
  expect(res.status).toBe(202);
  const { id, status } = await res.json();
  expect(status).toBe("pending");
  await runner.settled(); // deterministically await the background saga
  const view = await (await app.request(`/entities/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } })).json();
  expect(view.guardian).toBe(account.address);
  expect(view.status).toBe("bound");
  expect(view).not.toHaveProperty("specJson");
  expect(view).not.toHaveProperty("turnkeySubOrgId");
});

test("a different tenant cannot read another tenant's entity (404)", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const { id } = await (await app.request("/onboard", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ spec: validSpec, guardianPasskey: passkey }) })).json();
  // Forge a token for a different tenant.
  const other = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const msg = createSiweMessage({ address: other.address, chainId: CHAIN, domain: DOMAIN, nonce, uri: `https://${DOMAIN}`, version: "1" });
  const sig = await other.signMessage({ message: msg });
  const otherToken = (await (await app.request("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg, signature: sig }) })).json()).token;
  const res = await app.request(`/entities/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${otherToken}` } });
  expect(res.status).toBe(404);
});

test("onboard with an invalid spec returns 400 validation_error", async () => {
  const { app } = makeApp();
  const token = await login(app);
  const res = await app.request("/onboard", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ spec: { name: "" }, guardianPasskey: passkey }) });
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe("validation_error");
});

test("GET /passkey/challenge returns a challenge + rpId (no auth required)", async () => {
  const res = await makeApp().app.request("/passkey/challenge");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(typeof body.challenge).toBe("string");
  expect(body.rpId).toBe("wizard.local");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/api/onboard.routes.test.ts`
Expected: FAIL (no `/entities` route).

- [ ] **Step 3: Write `src/api/views.ts`**

```ts
import type { EntityRecord } from "../types";

/** Secret-free projection of an EntityRecord for API responses. */
export interface EntityView {
  id: string;
  name: string;
  status: EntityRecord["status"];
  agentId: string | null;
  proxy: string | null;
  treasury: string | null;
  operator: string | null;
  manager: string;
  guardian: string;
  oaHash: string | null;
  metadataURI: string | null;
  createTxHash: string | null;
  bindTxHash: string | null;
  fundTxHash: string | null;
  error: string | null;
}

export function toEntityView(r: EntityRecord): EntityView {
  return {
    id: r.idempotencyKey,
    name: r.name,
    status: r.status,
    agentId: r.agentId,
    proxy: r.proxy,
    treasury: r.treasury,
    operator: r.operator,
    manager: r.manager,
    guardian: r.guardian,
    oaHash: r.oaHash,
    metadataURI: r.metadataURI,
    createTxHash: r.createTxHash,
    bindTxHash: r.bindTxHash,
    fundTxHash: r.fundTxHash,
    error: r.error ?? null,
  };
}
```

- [ ] **Step 4: Write `src/api/routes/passkey.ts`**

```ts
import { randomBytes } from "node:crypto";
import type { Hono } from "hono";
import type { ApiDeps } from "../app";

/** Issue a WebAuthn registration challenge for the browser ceremony. (Turnkey does not check
 *  freshness — the challenge just needs to be embedded consistently in clientDataJSON.) */
export function mountPasskeyRoutes(app: Hono, deps: ApiDeps) {
  app.get("/passkey/challenge", (c) =>
    c.json({ challenge: randomBytes(32).toString("base64url"), rpId: deps.passkeyRpId }),
  );
}
```

- [ ] **Step 5: Write `src/api/routes/onboard.ts`**

```ts
import type { Hono } from "hono";
import { getAddress } from "viem";
import type { GuardianPasskey } from "../../adapters/turnkey/provisioner";
import { AgentSpecSchema } from "../../policy/agentSpec";
import type { AuthVars } from "../../auth/middleware";
import { ApiError } from "../errors";
import { toEntityView } from "../views";
import type { ApiDeps } from "../app";

export function mountProtectedRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/onboard", async (c) => {
    const tenantId = c.get("tenantId");
    let body: { spec?: unknown; guardianPasskey?: unknown; idempotencyKey?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (!body.guardianPasskey || typeof body.guardianPasskey !== "object")
      throw new ApiError("validation_error", 400, "guardianPasskey is required");

    // Server owns the guardian: force it to the authenticated tenant before validation.
    const rawSpec = (body.spec ?? {}) as Record<string, unknown>;
    const roles = { ...((rawSpec.roles as object) ?? {}), guardian: tenantId };
    const spec = AgentSpecSchema.parse({ ...rawSpec, roles }); // throws ZodError → 400

    const userKey = typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : spec.name;
    const { id, status } = deps.runner.start({
      spec,
      userKey,
      tenantId: getAddress(tenantId),
      guardianPasskey: body.guardianPasskey as GuardianPasskey,
    });
    return c.json({ id, status }, 202);
  });

  app.get("/entities", (c) => c.json(deps.repo.listByTenant(c.get("tenantId")).map(toEntityView)));

  app.get("/entities/:id", (c) => {
    const rec = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId")) throw new ApiError("not_found", 404, "entity not found");
    return c.json(toEntityView(rec));
  });

  app.post("/entities/:id/fund", async (c) => {
    let body: { amount?: unknown };
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("validation_error", 400, "invalid JSON body");
    }
    if (typeof body.amount !== "string" && typeof body.amount !== "number")
      throw new ApiError("validation_error", 400, "amount (atomic USDC) is required");
    const { id, status } = deps.runner.fund({ id: c.req.param("id"), tenantId: c.get("tenantId"), amount: BigInt(body.amount) });
    return c.json({ id, status }, 202);
  });
}
```

- [ ] **Step 6: Extend `ApiDeps` + mount in `src/api/app.ts`**

Add to `ApiDeps`:

```ts
  repo: import("../persistence/entityRepository").EntityRepository;
  runner: import("../workflow/runner").OnboardingRunner;
  passkeyRpId: string;
```

Add imports at the top of `app.ts`:

```ts
import { requireAuth } from "../auth/middleware";
import { mountPasskeyRoutes } from "./routes/passkey";
import { mountProtectedRoutes } from "./routes/onboard";
```

In `buildApiApp`, after `mountAuthRoutes(app, deps);`:

```ts
  mountPasskeyRoutes(app, deps);
  app.use("/onboard", requireAuth(deps.jwtSecret));
  app.use("/entities", requireAuth(deps.jwtSecret));
  app.use("/entities/*", requireAuth(deps.jwtSecret));
  mountProtectedRoutes(app, deps);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/api/onboard.routes.test.ts`
Expected: PASS (all 5).

- [ ] **Step 8: Commit**

```bash
git add src/api/views.ts src/api/routes/onboard.ts src/api/routes/passkey.ts src/api/app.ts test/api/onboard.routes.test.ts
git commit -m "feat(api): onboard/entities/fund/passkey routes (auth + tenant-scoped)"
```

---

## Task 9: Contract artifact, composition root, README

**Files:**
- Create: `src/api/routes/schema.ts`, `src/api/main.ts`
- Modify: `src/api/app.ts` (mount schema route), `src/config/env.ts`, `package.json`, `backend/README.md`
- Test: `test/api/schema.route.test.ts`

**Interfaces:**
- Consumes: `AgentSpecSchema` (existing), all of `buildApiApp` (Task 5–8), `loadConfig` (existing).
- Produces: `GET /schema/agent-spec.json`; `npm run api` boots the real wired server.

- [ ] **Step 1: Add the dependency**

Run: `npm install zod-to-json-schema@^3.23.0`
Expected: adds it to `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing test** — `test/api/schema.route.test.ts`

```ts
import { expect, test } from "vitest";
import { buildApiApp } from "../../src/api/app";

test("GET /schema/agent-spec.json serves the AgentSpec JSON schema", async () => {
  const res = await buildApiApp({ webOrigin: "*" } as never).request("/schema/agent-spec.json");
  expect(res.status).toBe(200);
  const schema = await res.json();
  expect(schema.$schema).toMatch(/json-schema/);
  // The schema must describe the agent spec's required-ish fields.
  expect(JSON.stringify(schema)).toContain("spendingCapUsdc");
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/api/schema.route.test.ts`
Expected: FAIL (404 — no schema route).

- [ ] **Step 4: Write `src/api/routes/schema.ts`**

```ts
import type { Hono } from "hono";
import { zodToJsonSchema } from "zod-to-json-schema";
import { AgentSpecSchema } from "../../policy/agentSpec";

const agentSpecJsonSchema = zodToJsonSchema(AgentSpecSchema, "AgentSpec");

/** Serve the AgentSpec JSON schema so the frontend can derive a typed onboard form/client. */
export function mountSchemaRoutes(app: Hono) {
  app.get("/schema/agent-spec.json", (c) => c.json(agentSpecJsonSchema));
}
```

- [ ] **Step 5: Mount it in `src/api/app.ts`**

Add import: `import { mountSchemaRoutes } from "./routes/schema";`
After `app.get("/healthz", ...)`: `mountSchemaRoutes(app);`

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/api/schema.route.test.ts`
Expected: PASS.

- [ ] **Step 7: Add config keys in `src/config/env.ts`**

Add to `EnvSchema`:

```ts
  AUTH_JWT_SECRET: z.string().min(16).default("dev-insecure-secret-change-me-please"),
  AUTH_JWT_TTL_SEC: z.coerce.number().int().positive().default(3600),
  WEB_ORIGIN: z.string().default("*"),
  SIWE_DOMAIN: z.string().default("localhost"),
  PASSKEY_RP_ID: z.string().default("localhost"),
```

Add to the `Config` interface:

```ts
  authJwtSecret: string;
  authJwtTtlSec: number;
  webOrigin: string;
  siweDomain: string;
  passkeyRpId: string;
```

Add to the returned object in `loadConfig`:

```ts
    authJwtSecret: e.AUTH_JWT_SECRET,
    authJwtTtlSec: e.AUTH_JWT_TTL_SEC,
    webOrigin: e.WEB_ORIGIN,
    siweDomain: e.SIWE_DOMAIN,
    passkeyRpId: e.PASSKEY_RP_ID,
```

Add to `redact`: `authJwtSecret: "REDACTED",` inside the returned object.

- [ ] **Step 8: Write `src/api/main.ts` (composition root)**

```ts
import "dotenv/config";
import { serve } from "@hono/node-server";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { managerWalletClient, publicClientFor } from "../adapters/arc/clients";
import { buildTurnkeyProvisionDeps } from "../adapters/turnkey/clients";
import { buildOperatorSigner } from "../adapters/turnkey/operatorSigner";
import { provisionAgentVault, type GuardianPasskey } from "../adapters/turnkey/provisioner";
import { TurnkeySigner } from "../adapters/turnkey/turnkeySigner";
import { loadConfig } from "../config/env";
import { migrate, openDatabase } from "../persistence/db";
import { FileDocumentStore } from "../persistence/documentStore";
import { SqliteEntityRepository } from "../persistence/entityRepository";
import { SqliteNonceStore } from "../auth/nonceStore";
import { runOnboarding } from "../workflow/onboarding";
import { OnboardingRunner, type RunSaga } from "../workflow/runner";
import type { Address } from "../types";
import { buildApiApp } from "./app";

async function main() {
  const cfg = loadConfig();
  if (!cfg.factoryAddress) throw new Error("FACTORY_ADDRESS is required to run the API server");
  if (!cfg.turnkey?.delegatedApiPublicKey || !cfg.turnkey?.delegatedApiPrivateKey)
    throw new Error("TURNKEY_DELEGATED_API_{PUBLIC,PRIVATE}_KEY are required to run the API server");

  const db = openDatabase(cfg.dbPath);
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  const docStore = new FileDocumentStore(cfg.docStoreDir);
  const nonceStore = new SqliteNonceStore(db);
  const arc = new ArcAdapter({
    publicClient: publicClientFor(cfg),
    managerWallet: managerWalletClient(cfg),
    chainId: cfg.chainId,
    factory: cfg.factoryAddress as Address,
    identityRegistry: cfg.identityRegistry,
  });
  const operatorSigner = await buildOperatorSigner(cfg);

  const provision = (p: { subOrgName: string; guardianPasskey: GuardianPasskey; guardianEmail?: string }) =>
    provisionAgentVault(buildTurnkeyProvisionDeps(cfg), { ...p, delegatedApiPublicKey: cfg.turnkey!.delegatedApiPublicKey! });
  const signerForEntity = (e: { subOrgId: string; operator: string }) => TurnkeySigner.forEntity(cfg, e);

  const runSaga: RunSaga = (i) =>
    runOnboarding({
      spec: i.spec,
      idempotencyKey: i.idempotencyKey,
      repo,
      docStore,
      arc,
      operatorSigner,
      usdc: cfg.usdc,
      ownerTenantId: i.tenantId,
      specJson: i.specJson,
      fundAmount: i.fundAmount,
      guardianPasskey: i.guardianPasskey,
      provision,
      signerForEntity,
    });

  const runner = new OnboardingRunner({ repo, runSaga });
  const resumed = runner.reconcileInFlight();
  if (resumed) console.log(`Resumed ${resumed} in-flight onboarding(s)`);

  const app = buildApiApp({
    webOrigin: cfg.webOrigin,
    nonceStore,
    siweDomain: cfg.siweDomain,
    chainId: cfg.chainId,
    jwtSecret: cfg.authJwtSecret,
    jwtTtlSec: cfg.authJwtTtlSec,
    repo,
    runner,
    passkeyRpId: cfg.passkeyRpId,
  });

  const port = Number(process.env.PORT ?? 8789);
  serve({ fetch: app.fetch, port });
  console.log(`Wizard API listening on :${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 9: Add the `api` script to `package.json`**

In `"scripts"`, add: `"api": "tsx src/api/main.ts",`

- [ ] **Step 10: Add a `backend/README.md` section**

Append a "Wizard REST API" section documenting: `npm run api`, env keys
(`AUTH_JWT_SECRET`, `AUTH_JWT_TTL_SEC`, `WEB_ORIGIN`, `SIWE_DOMAIN`, `PASSKEY_RP_ID`), and the
endpoint table + auth flow:

```markdown
## Wizard REST API (`npm run api`, default :8789)

Multi-tenant onboarding API for the web wizard. Tenant = controller wallet (SIWE login).

### Auth (SIWE → Bearer JWT)
1. `GET /auth/nonce` → `{ nonce }`
2. Build an EIP-4361 message with the nonce, sign with the wallet.
3. `POST /auth/verify { message, signature }` → `{ token, address, expiresAt }`
4. Send `Authorization: Bearer <token>` on protected routes. Re-auth on expiry.

### Endpoints
| Method | Path | Auth | Body / Notes |
|---|---|---|---|
| GET | `/healthz` | no | liveness |
| GET | `/schema/agent-spec.json` | no | JSON Schema for the onboard `spec` |
| GET | `/auth/nonce` | no | `{ nonce }` |
| POST | `/auth/verify` | no | `{ message, signature }` → JWT |
| GET | `/passkey/challenge` | no | `{ challenge, rpId }` for WebAuthn registration |
| POST | `/onboard` | yes | `{ spec, guardianPasskey, idempotencyKey? }` → `202 { id, status }`. `guardian` is forced to the caller. |
| GET | `/entities` | yes | tenant's `EntityView[]` |
| GET | `/entities/:id` | yes | one `EntityView` (404 if not owned) |
| POST | `/entities/:id/fund` | yes | `{ amount }` (atomic USDC) → `202 { id, status }` |

Poll `GET /entities/:id` (~2–3 s) until terminal status (`bound` / `funded` / `failed`).
```

- [ ] **Step 11: Full verification — suite + lint + types**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green (new tests pass; nothing regressed).

- [ ] **Step 12: Commit**

```bash
git add src/api/routes/schema.ts src/api/main.ts src/api/app.ts src/config/env.ts package.json package-lock.json backend/README.md test/api/schema.route.test.ts
git commit -m "feat(api): AgentSpec JSON-schema route, composition root, README"
```

---

## Self-Review (completed during planning)

- **Spec coverage:** §3 API surface → Tasks 6/8/9; §4 data flow → Tasks 6–8; §5 auth/JWT → Tasks 3–4;
  §6 data flow poll → Task 8; §7 identity (guardian = tenant) → Task 8 onboard handler; §8 async +
  reconcile + tenant-scoped key → Tasks 1/2/7; §9 errors → Task 5; §10 testing → tests in every task;
  §11 frontend contract (OpenAPI/JSON schema, README) → Task 9; §12 scope honored (no orgs/billing/MCP/Phase4).
- **Composite key:** realized as a namespaced `${tenantId}:${userKey}` storage key (Task 1 note) to
  preserve the existing `idempotency_key` PK + events FK — functionally the spec's composite key.
- **Type consistency:** `EntityStatus`, `EntityRecord` (ownerTenantId/error/specJson), `RunSaga`,
  `ApiDeps`, `AuthVars` are defined once and consumed with the same names downstream.
- **Placeholder scan:** none — every step ships real code/tests/commands.

## Execution Handoff

See the skill's handoff options after this plan is approved.
