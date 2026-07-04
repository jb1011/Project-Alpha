# Public Metadata URI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bake a publicly-resolvable HTTPS `metadataURI` (backend-served) into the on-chain ERC-8004 record at every agent registration, instead of a `file://` path, so an agent's legal identity is fetchable/verifiable by anyone.

**Architecture:** Mint an opaque `publicId` at the onboarding *translating* step; set `metadataURI = ${METADATA_BASE_URL}/metadata/${publicId}` (baked on-chain by `createEntity`). A new public, unauthenticated `GET /metadata/:publicId` route resolves `publicId → entity` via the DB and serves the stored metadata JSON. Drop `ein` from that JSON; close a pre-existing doc-store path traversal at the sink.

**Tech Stack:** TypeScript, Hono, better-sqlite3, viem, vitest, Biome (backend at `back/backend`, no build step; run with `tsx`/`vitest`).

## Global Constraints

- **No new dependencies.** Backend vitest suite must stay green (`cd back/backend && npx vitest run`); each task is test-first (TDD).
- **Run tests** from `back/backend`: `npx vitest run <file>` (focused) then `npx vitest run` (full) before commit. Also keep Biome clean: `npx biome check src test` (CI enforces it — a formatting miss fails the build).
- **`publicId` is OPTIONAL** on `EntityRecord` (`publicId?: string | null`) — `bindings`/`toRecord` already coalesce with `?? null`, so no other record literal needs editing (satisfies audit M2 without touching `runner.ts`/`onboarding.ts` Step-0/tests).
- **`OnboardingDeps.metadataBaseUrl` is OPTIONAL with a localhost default** — 7 existing tests call `runOnboarding`; a required field would churn all of them. The 2 real callers (`main.ts` runSaga + `cli` create-entity) always pass the prod-guarded `cfg.metadataBaseUrl`, so the default only affects tests.
- **`METADATA_BASE_URL` is baked permanently on-chain** — prod must fail-closed on a non-https or loopback value.
- **The served metadata JSON must NOT contain `ein`** (audit S2). It stays in the OA doc (behind `oaHash`) + on-chain calldata.
- Stage ONLY the files each task names (never `git add -A`). Use the exact commit message shown.
- Branch: `feat/public-metadata-uri` (already created off main).

---

## File Structure

- `src/config/env.ts` — `METADATA_BASE_URL` env + `metadataBaseUrl` config + prod guard (T1).
- `src/persistence/documentStore.ts` — path-containment on `get`/`put` (T2).
- `src/persistence/db.ts` — `public_id` column + additive migration + unique index (T3).
- `src/types.ts` — `EntityRecord.publicId?` (T3).
- `src/persistence/entityRepository.ts` — map + insert `public_id` + `findByPublicId` (T3).
- `src/oa/generator.ts` — drop `ein` from `AgentMetadata`/`renderMetadata` (T4).
- `src/workflow/onboarding.ts` — `OnboardingDeps.metadataBaseUrl` + mint `publicId` + public URI (T4).
- `src/api/main.ts` + `src/cli/index.ts` — thread `metadataBaseUrl` into both onboard call sites; add `docStore` to `buildApiApp` (T4/T5).
- `src/api/routes/metadata.ts` — new public route (T5).
- `src/api/app.ts` — `ApiDeps.docStore` + mount route + CORS origin callback (T5).

---

## Task 1: Config — `METADATA_BASE_URL` + prod guard

**Files:**
- Modify: `src/config/env.ts`
- Test: `back/backend/test/config/metadataUrl.test.ts` (create)

**Interfaces:**
- Produces: `Config.metadataBaseUrl: string`.

- [ ] **Step 1: Write the failing test.** Create `test/config/metadataUrl.test.ts`:
```ts
import { expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";

// Minimal env that passes loadConfig + the existing prod guards (JWT/WEB_ORIGIN), so we isolate the
// METADATA_BASE_URL check.
const baseEnv = {
  ARC_TESTNET_RPC_URL: "https://rpc.example/arc",
  PLATFORM_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  AUTH_JWT_SECRET: "a-real-production-secret-1234",
  WEB_ORIGIN: "https://app.example.com",
};

test("metadataBaseUrl defaults + is exposed on config (non-prod)", () => {
  expect(loadConfig({ ...baseEnv }).metadataBaseUrl).toBe("http://localhost:8789");
});

test("prod rejects a loopback METADATA_BASE_URL", () => {
  expect(() =>
    loadConfig({ ...baseEnv, NODE_ENV: "production", METADATA_BASE_URL: "http://localhost:8789" }),
  ).toThrow(/METADATA_BASE_URL/);
});

test("prod rejects a non-https METADATA_BASE_URL", () => {
  expect(() =>
    loadConfig({ ...baseEnv, NODE_ENV: "production", METADATA_BASE_URL: "http://api.example.com/backend" }),
  ).toThrow(/METADATA_BASE_URL/);
});

test("prod accepts a real https METADATA_BASE_URL", () => {
  const cfg = loadConfig({
    ...baseEnv,
    NODE_ENV: "production",
    METADATA_BASE_URL: "https://project-alpha-pi.vercel.app/backend",
  });
  expect(cfg.metadataBaseUrl).toBe("https://project-alpha-pi.vercel.app/backend");
});
```

- [ ] **Step 2: Run it, verify it fails.** `cd back/backend && npx vitest run test/config/metadataUrl.test.ts` → FAIL (`cfg.metadataBaseUrl` undefined / no guard).

- [ ] **Step 3: Implement.** In `src/config/env.ts`:

Add to `EnvSchema` (after the `MCP_PUBLIC_URL` line ~58):
```ts
  METADATA_BASE_URL: z.string().url().default("http://localhost:8789"),
```
Add to the `Config` interface (after `mcpPublicUrl: string;`):
```ts
  metadataBaseUrl: string;
```
Add to the `cfg` object literal (after `mcpPublicUrl: e.MCP_PUBLIC_URL,`):
```ts
    metadataBaseUrl: e.METADATA_BASE_URL,
```
Add to the production fail-closed block (inside the `if ((env.NODE_ENV ?? process.env.NODE_ENV) === "production") {` block, after the WEB_ORIGIN check):
```ts
    const mbu = new URL(cfg.metadataBaseUrl);
    const loopback =
      mbu.hostname === "localhost" ||
      mbu.hostname.endsWith(".localhost") ||
      mbu.hostname === "0.0.0.0" ||
      mbu.hostname === "::1" ||
      mbu.hostname === "[::1]" ||
      mbu.hostname.startsWith("127.");
    if (mbu.protocol !== "https:" || loopback)
      throw new Error(
        "Invalid config: METADATA_BASE_URL must be an https, non-loopback URL in production (it is baked permanently on-chain)",
      );
```

- [ ] **Step 4: Run tests, verify pass.** `npx vitest run test/config/metadataUrl.test.ts` → PASS.

- [ ] **Step 5: Full suite + lint + commit.** `npx vitest run` (green) + `npx biome check src test` (clean).
```bash
cd /home/mbarr/Project-Alpha
git add back/backend/src/config/env.ts back/backend/test/config/metadataUrl.test.ts
git commit -m "feat(metadata): METADATA_BASE_URL config + prod fail-closed guard"
```

---

## Task 2: Doc-store path containment (audit S1)

**Files:**
- Modify: `src/persistence/documentStore.ts`
- Test: `back/backend/test/persistence/documentStore.test.ts` (create)

**Interfaces:**
- Produces: `FileDocumentStore.get`/`put` throw if the resolved path escapes the doc root.

- [ ] **Step 1: Write the failing test.** Create `test/persistence/documentStore.test.ts`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FileDocumentStore } from "../../src/persistence/documentStore";

function store() {
  return new FileDocumentStore(mkdtempSync(join(tmpdir(), "docstore-")));
}

test("put/get reject an id that escapes the doc root", () => {
  const s = store();
  expect(() => s.put("../evil.json", "{}")).toThrow(/escapes/);
  expect(() => s.get("../../../../etc/passwd")).toThrow(/escapes/);
});

test("a normal id still round-trips", () => {
  const s = store();
  s.put("meta-0xabc:agent.json", '{"a":1}');
  expect(s.get("meta-0xabc:agent.json")).toBe('{"a":1}');
});
```

- [ ] **Step 2: Run it, verify it fails.** `npx vitest run test/persistence/documentStore.test.ts` → the escape tests FAIL (no containment; `../evil.json` writes/throws ENOENT, not `/escapes/`).

- [ ] **Step 3: Implement.** In `src/persistence/documentStore.ts`, update the imports and add a `safePath` helper used by both `get` and `put`:
```ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
```
Inside `class FileDocumentStore`, add:
```ts
  /** Resolve id under the doc root and reject any path that escapes it (traversal guard). */
  private safePath(id: string): string {
    const root = resolve(this.root);
    const p = resolve(join(root, id));
    if (p !== root && !p.startsWith(root + sep))
      throw new Error(`document id escapes the store root: ${id}`);
    return p;
  }
```
Change `put` + `get` to route through it:
```ts
  put(name: string, contents: string): PutResult {
    const path = this.safePath(name);
    writeFileSync(path, contents, "utf8");
    return { id: name, path, uri: pathToFileURL(path).href };
  }

  get(id: string): string {
    return readFileSync(this.safePath(id), "utf8");
  }
```

- [ ] **Step 4: Run tests, verify pass.** `npx vitest run test/persistence/documentStore.test.ts` → PASS.

- [ ] **Step 5: Full suite + lint + commit.**
```bash
cd /home/mbarr/Project-Alpha
git add back/backend/src/persistence/documentStore.ts back/backend/test/persistence/documentStore.test.ts
git commit -m "fix(security): doc-store path-traversal containment on get/put"
```

---

## Task 3: Schema — `public_id` column + `findByPublicId`

**Files:**
- Modify: `src/persistence/db.ts`, `src/types.ts`, `src/persistence/entityRepository.ts`
- Test: `back/backend/test/persistence/publicId.test.ts` (create)

**Interfaces:**
- Produces: `EntityRecord.publicId?: string | null`; `EntityRepository.findByPublicId(publicId: string): EntityRecord | undefined`; a `public_id` column + `idx_entities_public_id` unique index.

- [ ] **Step 1: Write the failing test.** Create `test/persistence/publicId.test.ts`:
```ts
import { beforeEach, expect, test } from "vitest";
import type Database from "better-sqlite3";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";

const base: EntityRecord = {
  idempotencyKey: "0xA:agent",
  name: "A",
  status: "bound",
  manager: "0x0000000000000000000000000000000000000001",
  guardian: "0x0000000000000000000000000000000000000002",
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
};

let db: Database.Database;
let repo: SqliteEntityRepository;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
});

test("findByPublicId round-trips a stored publicId", () => {
  repo.upsert({ ...base, publicId: "11111111-1111-1111-1111-111111111111" });
  const got = repo.findByPublicId("11111111-1111-1111-1111-111111111111");
  expect(got?.idempotencyKey).toBe("0xA:agent");
  expect(repo.findByPublicId("no-such-id")).toBeUndefined();
});

test("the unique index tolerates multiple null publicIds", () => {
  repo.upsert({ ...base, idempotencyKey: "0xA:one" });
  repo.upsert({ ...base, idempotencyKey: "0xA:two" });
  expect(repo.findByIdempotencyKey("0xA:one")?.publicId ?? null).toBeNull();
  expect(repo.findByIdempotencyKey("0xA:two")?.publicId ?? null).toBeNull();
});
```

- [ ] **Step 2: Run it, verify it fails.** `npx vitest run test/persistence/publicId.test.ts` → FAIL (`findByPublicId` not a function).

- [ ] **Step 3a: Migration (`src/persistence/db.ts`).** In the additive-migration section, right after the `per_tx_cap` ALTER (~line 194, using the existing `cols` snapshot), add the ALTER **then** the index (mirror the `payments_ledger.entity_key` block at ~209-216 — index AFTER the ALTER, never before):
```ts
  if (!cols.includes("public_id")) db.exec("ALTER TABLE entities ADD COLUMN public_id TEXT");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_public_id ON entities(public_id)");
```

- [ ] **Step 3b: Type (`src/types.ts`).** In `EntityRecord`, after `perTxCap?: bigint | null;`:
```ts
  /** Opaque public slug; the on-chain metadataURI is METADATA_BASE_URL/metadata/<publicId>. */
  publicId?: string | null;
```

- [ ] **Step 3c: Repository (`src/persistence/entityRepository.ts`).**
Add to the `Row` interface (after `per_tx_cap: string | null;`):
```ts
  public_id: string | null;
```
Add to `toRecord` (after `perTxCap: r.per_tx_cap ? BigInt(r.per_tx_cap) : null,`):
```ts
    publicId: r.public_id ?? null,
```
Add to `bindings` (after `per_tx_cap: rec.perTxCap?.toString() ?? null,`):
```ts
      public_id: rec.publicId ?? null,
```
In `INSERT_COLUMNS`, change the tail `per_tx_cap, updated_at` → `per_tx_cap, public_id, updated_at`.
In `INSERT_VALUES`, change the tail `@per_tx_cap, CURRENT_TIMESTAMP` → `@per_tx_cap, @public_id, CURRENT_TIMESTAMP`.
In `upsert`'s `ON CONFLICT ... DO UPDATE SET`, add `public_id=excluded.public_id,` (e.g. right before `per_tx_cap=excluded.per_tx_cap`).
Add the lookup + interface method. In the `EntityRepository` interface (after `findByAgentId`):
```ts
  findByPublicId(publicId: string): EntityRecord | undefined;
```
In `class SqliteEntityRepository` (after `findByAgentId`):
```ts
  findByPublicId(publicId: string): EntityRecord | undefined {
    const r = this.db.prepare("SELECT * FROM entities WHERE public_id = ?").get(publicId) as
      | Row
      | undefined;
    return r ? toRecord(r) : undefined;
  }
```

- [ ] **Step 4: Run tests, verify pass.** `npx vitest run test/persistence/publicId.test.ts` → PASS.

- [ ] **Step 5: Full suite + lint + commit.**
```bash
cd /home/mbarr/Project-Alpha
git add back/backend/src/persistence/db.ts back/backend/src/types.ts back/backend/src/persistence/entityRepository.ts back/backend/test/persistence/publicId.test.ts
git commit -m "feat(metadata): public_id column + findByPublicId + unique index"
```

---

## Task 4: Onboard — mint publicId, public URI, drop `ein`

**Files:**
- Modify: `src/oa/generator.ts`, `src/workflow/onboarding.ts`, `src/api/main.ts:85-100`, `src/cli/index.ts:35-44`
- Test: `back/backend/test/oa/metadata.test.ts` (create) + extend the existing onboarding saga test (see Step 1b)

**Interfaces:**
- Consumes: `Config.metadataBaseUrl` (T1), `EntityRecord.publicId` (T3).
- Produces: `OnboardingDeps.metadataBaseUrl: string`; onboarded records carry `metadataURI = ${base}/metadata/${publicId}` (not `file://`) + a persisted `publicId`; `AgentMetadata.legalBody` has no `ein`.

- [ ] **Step 1a: Write a unit test for the dropped `ein`.** Create `test/oa/metadata.test.ts`:
```ts
import { expect, test } from "vitest";
import { renderMetadata } from "../../src/oa/generator";
import type { AgentSpec } from "../../src/policy/agentSpec";

const spec = {
  name: "A",
  jurisdiction: "WY",
  metadata: { description: "d", agentType: "t", capabilities: ["x"], version: "1" },
} as unknown as AgentSpec;
const r = {
  legal: { ein: "12-3456789", formationDate: 1700000000 },
} as never;

test("rendered metadata legalBody has no ein", () => {
  const meta = renderMetadata(spec, r, "0xabc" as `0x${string}`);
  expect(meta.legalBody).not.toHaveProperty("ein");
  expect(meta.legalBody).toMatchObject({ jurisdiction: "WY", formationDate: 1700000000, oaHash: "0xabc" });
});
```

- [ ] **Step 1b: Add onboarding assertions.** Extend `test/workflow/onboarding.createWindow.test.ts` (it already runs `runOnboarding(...)` with a fake `arc` that captures `broadcastCreateEntity` — the ideal harness to assert the on-chain `metadataURI`). Add `metadataBaseUrl: "https://host.example/backend"` to the deps that test passes to `runOnboarding`, and assert on the resulting record (and, if that test captures the `broadcastCreateEntity` args, assert the captured `metadataURI` equals `rec.metadataURI`):
```ts
expect(rec.metadataURI).toMatch(
  /^https:\/\/host\.example\/backend\/metadata\/[0-9a-f-]{36}$/,
);
expect(rec.metadataURI).not.toContain("file://");
expect(rec.publicId).toBeTruthy();
```
If a fake/capturing `arc` records `broadcastCreateEntity`, also assert the captured `metadataURI` equals `rec.metadataURI`. (Reuse that test's existing harness — do not build a new saga harness.)

- [ ] **Step 2: Run them, verify they fail.** `npx vitest run test/oa/metadata.test.ts test/workflow/onboarding.createWindow.test.ts` → FAIL (`ein` still present in the rendered metadata; `metadataURI` is a `file://` URI, not the public URL; `publicId` undefined).

- [ ] **Step 3a: Drop `ein` (`src/oa/generator.ts`).** In `AgentMetadata`, remove `ein: string;` from `legalBody` (leaving `jurisdiction`, `formationDate`, `oaHash`). In `renderMetadata`, remove the `ein: r.legal.ein,` line from the returned `legalBody`.

- [ ] **Step 3b: Onboarding (`src/workflow/onboarding.ts`).** Add the import at the top:
```ts
import { randomUUID } from "node:crypto";
```
Add to `OnboardingDeps` (after `usdc: Address;`):
```ts
  /** Public base URL for the on-chain metadataURI: ${metadataBaseUrl}/metadata/<publicId>. OPTIONAL
   *  (default localhost) so the existing saga tests compile untouched; the REAL callers (main.ts
   *  runSaga + cli create-entity) always pass the prod-guarded cfg.metadataBaseUrl. */
  metadataBaseUrl?: string;
```
In the translating step (~149-164), replace the metadata/URI lines. Current:
```ts
    const docPut = d.docStore.put(`oa-${key}.md`, doc);
    const metaPut = d.docStore.put(`meta-${key}.json`, JSON.stringify(meta, null, 2));
```
with:
```ts
    const docPut = d.docStore.put(`oa-${key}.md`, doc);
    d.docStore.put(`meta-${key}.json`, JSON.stringify(meta, null, 2)); // written for the public route to serve
    const publicId = rec?.publicId ?? randomUUID(); // minted once; preserved across a translating-resume
    const metadataBaseUrl = d.metadataBaseUrl ?? "http://localhost:8789"; // real callers pass the guarded cfg value
```
and in the `rec = { ... }` record literal that follows, change `metadataURI: metaPut.uri,` to:
```ts
      metadataURI: `${metadataBaseUrl}/metadata/${publicId}`,
      publicId,
```

- [ ] **Step 3c: Thread `metadataBaseUrl` into both call sites.** In `src/api/main.ts`, the `runSaga` → `runOnboarding({...})` call (~86): add `metadataBaseUrl: cfg.metadataBaseUrl,`. In `src/cli/index.ts`, the `create-entity` `runOnboarding({...})` call (~35): add `metadataBaseUrl: ctx.cfg.metadataBaseUrl,`.

- [ ] **Step 4: Run tests, verify pass.** `npx vitest run test/oa/metadata.test.ts test/workflow/` → PASS.

- [ ] **Step 5: Full suite + lint + commit.** (`npx vitest run` + `npx biome check src test`.)
```bash
cd /home/mbarr/Project-Alpha
git add back/backend/src/oa/generator.ts back/backend/src/workflow/onboarding.ts back/backend/src/api/main.ts back/backend/src/cli/index.ts back/backend/test/oa/metadata.test.ts back/backend/test/workflow/
git commit -m "feat(metadata): mint publicId + public metadataURI on onboard; drop ein from metadata JSON"
```

---

## Task 5: Public route — `GET /metadata/:publicId` + CORS

**Files:**
- Create: `src/api/routes/metadata.ts`
- Modify: `src/api/app.ts`, `src/api/main.ts:110-136`
- Test: `back/backend/test/api/metadata.route.test.ts` (create)

**Interfaces:**
- Consumes: `EntityRepository.findByPublicId` (T3), `docStore.get` (T2), `ApiDeps`.
- Produces: a public `GET /metadata/:publicId` → `200 application/json` (no auth), 404 for malformed/unknown/missing-file; CORS `*` for `/metadata/*`.

- [ ] **Step 1: Write the failing test.** Create `test/api/metadata.route.test.ts`, mirroring the `makeApp` harness in `test/api/bootstrapConnection.route.test.ts` BUT also passing a real `docStore`:
```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type Database from "better-sqlite3";
import { buildApiApp } from "../../src/api/app";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import type { EntityRecord } from "../../src/types";

const PUBLIC_ID = "22222222-2222-2222-2222-222222222222";
const KEY = "0xAAA:agent";
let db: Database.Database;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;

const rec: EntityRecord = {
  idempotencyKey: KEY, name: "A", status: "bound",
  manager: "0x0000000000000000000000000000000000000001",
  guardian: "0x0000000000000000000000000000000000000002",
  operator: null, amendmentDelay: "0", ein: "", formationDate: 0, oaHash: null,
  metadataURI: null, docPath: null, treasuryConfig: null, agentId: null, proxy: null,
  treasury: null, createTxHash: null, bindTxHash: null, fundTxHash: null,
  publicId: PUBLIC_ID,
};

function app() {
  return buildApiApp({ webOrigin: "https://app.example.com", repo, docStore } as never);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "meta-")));
  repo.upsert(rec);
  docStore.put(`meta-${KEY}.json`, JSON.stringify({ name: "A", legalBody: { jurisdiction: "WY" } }));
});
afterEach(() => db.close());

test("serves the metadata JSON with NO auth header", async () => {
  const res = await app().request(`/metadata/${PUBLIC_ID}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  const body = await res.json();
  expect(body).toMatchObject({ name: "A" });
  expect(body).not.toHaveProperty("ein");
});

test("unknown + malformed ids both 404", async () => {
  expect((await app().request("/metadata/33333333-3333-3333-3333-333333333333")).status).toBe(404);
  expect((await app().request("/metadata/not-a-uuid")).status).toBe(404);
});

test("a record whose file is missing 404s (not 500)", async () => {
  repo.upsert({ ...rec, idempotencyKey: "0xBBB:agent", publicId: "44444444-4444-4444-4444-444444444444" });
  expect((await app().request("/metadata/44444444-4444-4444-4444-444444444444")).status).toBe(404);
});

test("cross-origin OPTIONS preflight to /metadata gets ACAO: *", async () => {
  const res = await app().request(`/metadata/${PUBLIC_ID}`, {
    method: "OPTIONS",
    headers: { Origin: "https://other.example.com", "Access-Control-Request-Method": "GET" },
  });
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
});
```

- [ ] **Step 2: Run it, verify it fails.** `npx vitest run test/api/metadata.route.test.ts` → FAIL (route 404s as not-mounted / `docStore` not in deps).

- [ ] **Step 3a: The route (`src/api/routes/metadata.ts`).**
```ts
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public, unauthenticated: resolve publicId -> entity -> served metadata JSON. Uniform 404 for
 *  malformed/unknown/missing-file (no existence oracle). The filename derives from the DB record's
 *  key, never raw URL input — the doc store's own containment guard is the last line of defense. */
export function mountMetadataRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/metadata/:publicId", (c) => {
    const publicId = c.req.param("publicId");
    if (!UUID.test(publicId)) throw new ApiError("not_found", 404, "metadata not found");
    const ent = deps.repo.findByPublicId(publicId);
    if (!ent) throw new ApiError("not_found", 404, "metadata not found");
    let body: string;
    try {
      body = deps.docStore.get(`meta-${ent.idempotencyKey}.json`);
    } catch {
      throw new ApiError("not_found", 404, "metadata not found");
    }
    c.header("Content-Type", "application/json");
    c.header("Cache-Control", "public, max-age=300");
    return c.body(body);
  });
}
```

- [ ] **Step 3b: `app.ts` — deps, CORS callback, mount.** In `src/api/app.ts`:
Add to the `ApiDeps` interface:
```ts
  docStore: import("../persistence/documentStore").DocumentStore;
```
Add the import at the top:
```ts
import { mountMetadataRoutes } from "./routes/metadata";
```
Change the global cors registration (currently `app.use("*", cors({ origin: deps.webOrigin, allowHeaders: ["authorization", "content-type"] }))`) to a path-aware `origin` callback so `/metadata/*` is world-open (incl. preflight) while everything else keeps `webOrigin`:
```ts
  app.use(
    "*",
    cors({
      origin: (_origin, c) => (c.req.path.startsWith("/metadata/") ? "*" : deps.webOrigin),
      allowHeaders: ["authorization", "content-type"],
    }),
  );
```
Mount the route with the other public routes (next to `mountSchemaRoutes(app)`):
```ts
  mountMetadataRoutes(app, deps);
```

- [ ] **Step 3c: `main.ts` — inject `docStore`.** In `src/api/main.ts`, add `docStore,` to the `buildApiApp({ ... })` deps object (the `docStore` instance already exists at line 40).

- [ ] **Step 4: Run tests, verify pass.** `npx vitest run test/api/metadata.route.test.ts` → PASS.

- [ ] **Step 5: Full suite + lint + commit.**
```bash
cd /home/mbarr/Project-Alpha
git add back/backend/src/api/routes/metadata.ts back/backend/src/api/app.ts back/backend/src/api/main.ts back/backend/test/api/metadata.route.test.ts
git commit -m "feat(metadata): public GET /metadata/:id route + path-scoped CORS"
```

---

## Final verification (after all tasks, before merge)

Not a code task:
1. `cd back/backend && npx vitest run` → all green; `npx biome check src test` → clean; `npx tsc --noEmit` → clean.
2. **Deploy** (after merge): on the VPS, the additive `public_id` migration auto-applies on boot; set `METADATA_BASE_URL=https://project-alpha-pi.vercel.app/backend` in `.env`; restart `legalbody-api`.
3. **Smoke**: onboard a NEW agent → read its on-chain `metadataURI` (via `get_entity`) → confirm it's `https://project-alpha-pi.vercel.app/backend/metadata/<uuid>`; `curl -s` that URL → `200` JSON with **no `ein`**; a bogus uuid → `404`. The 2 legacy agents (842839, TestMB2) still carry `file://` (forward-only, expected).

---

## Self-Review notes (author)
- **Spec coverage:** every v2 spec §maps to a task — Config+guard (T1), doc-store containment/S1 (T2), schema public_id/M1/M2 (T3), onboard mint+URI+drop-ein/S2/M4 (T4), route+CORS/M3/S3 (T5). Deploy = final section.
- **Type consistency:** `publicId?: string | null` defined in T3, consumed in T3 (`findByPublicId`/bindings/toRecord), T4 (mint/persist), T5 (route reads `ent.idempotencyKey`, not publicId, for the filename). `metadataBaseUrl` defined in T1 (Config) + T4 (OnboardingDeps), threaded in T4. `docStore` added to `ApiDeps` in T5.
- **Ordering:** T1/T2/T3 independent; T4 needs T1+T3; T5 needs T2+T3. Sequence T1→T2→T3→T4→T5.
- **Deferred (out of scope, tracked in spec):** backfill existing agents, IPFS, edge-cache/rate-limit (audit S5).
