# BYOA Frontend Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two BYOA entry screens in `interface/` (web-first "Connect your agent" + agent-first bootstrap) with key + passkey revocation, plus the folded-in backend hardening (Hermes snippet, path-scoped proxy `no-store`, guardian passkey revoke).

**Architecture:** Frontend is Next.js 16 App Router / React 19 / Tailwind v4 consuming a flat typed fetch client (`src/lib/api/client.ts`) that attaches the SIWE JWT as `Authorization: Bearer`, relayed to the VPS by the `/backend/[[...path]]` proxy. New screens are client components under `src/components/agents/`, reachable from the agents dashboard + a new `/agents/connect` route. Backend adds a `revoke` to the passkey store + two routes; all other backend routes already exist.

**Tech Stack:** Next.js 16, React 19, Tailwind v4 (token utilities via `cx`), wagmi v3 + viem, `@turnkey/http` (WebAuthn). Backend: Hono, better-sqlite3, vitest, Biome.

## Global Constraints

- **No new dependencies** anywhere (frontend or backend).
- **Frontend styling:** Tailwind v4 token utilities only (`bg-paper`, `bg-paper-2`, `text-ink`, `text-muted`, `text-muted-2`, `text-accent-soft`, `hairline`, `hairline-strong`, `border-line-strong`), composed with `cx()` from `@/components/onboarding/primitives`. Reuse `Button`, `Card`, `Callout`, `StepHeader`, `Spinner` from that file. No toast/modal lib — inline `Callout` / red `<p className="text-[#ff8a84]">` for feedback; `window.confirm` for destructive confirms.
- **Frontend data pattern:** `const auth = await useAuth().ensureSession(); await clientFn(auth.token, …)` inside a `useCallback`/`useEffect`. NOT react-query hooks.
- **Secrets:** API keys + link codes live ONLY in React component state — never localStorage/sessionStorage, never logged, never in a URL. Never `dangerouslySetInnerHTML`.
- **Capability defaults (blast-radius split):** entity-scoped web-first defaults to `spend`; tenant-wide bootstrap defaults to `read`.
- **Uniform errors:** map backend 404s to generic friendly copy that does not reveal which resources exist.
- **Frontend has NO test harness** (`interface/package.json` scripts = `dev`/`build`/`start`/`lint`). Frontend task verification = `cd interface && npx tsc --noEmit` (typecheck) + `npm run lint`. Backend tasks use vitest (TDD).
- **Backend field name:** the passkey store returns `name` (not `label`). The frontend `PasskeyView` uses `name`.
- **Passkey revoke safety invariant** (state in a code comment): revoking a passkey only prevents that `passkeyId` from authorizing FUTURE onboard/bootstrap actions; it never alters an already-provisioned entity (its Turnkey/on-chain guardian exist independently).
- **Backend suite stays green:** every backend change ships with passing vitest (`cd back/backend && npx vitest run`).
- Work on branch `feat/byoa-frontend` (already created off `main`).

---

## File Structure

**Backend (`back/backend/`):**
- `src/mcp/snippets.ts` — add a `hermes` snippet (T1).
- `test/mcp/snippets.test.ts` — assert `hermes` present (T1).
- `src/persistence/db.ts` — `passkeys.revoked_at` column + additive migration (T2).
- `src/persistence/passkeyStore.ts` — `revoke()`, `get()`/`list()` exclude/expose revoked (T2).
- `test/persistence/passkeyStore.test.ts` — store tests (T2).
- `src/api/routes/passkey.ts` — `GET /passkeys` + `DELETE /passkeys/:id` (T3).
- `test/api/passkeys.route.test.ts` — route tests (T3).
- `docs/BYOA_INTEGRATION.md` — list Hermes (T1).

**Frontend (`interface/`):**
- `src/lib/api/types.ts` — new types (T4).
- `src/lib/api/client.ts` — new client fns + `getPasskeyChallenge(token)` fix + remove `mintApiKey` (T4).
- `src/components/onboarding/steps/WelcomeStep.tsx` — fix the `getPasskeyChallenge` call site (T4).
- `src/components/agents/connectTargets.ts` — snippet target list (T5).
- `src/components/agents/capabilityCopy.ts` — capability copy + defaults (T5).
- `src/components/agents/CapabilitySelector.tsx` — shared selector (T5).
- `src/components/agents/ConnectionSnippet.tsx` — shared snippet picker (T5).
- `src/components/agents/ActiveConnectionsPanel.tsx` — key list + revoke (T6).
- `src/components/agents/ConnectAgentPanel.tsx` — web-first panel (T7).
- `src/components/agents/AgentDashboard.tsx` — swap McpKeysPanel → ConnectAgentPanel (T7).
- `src/components/agents/McpKeysPanel.tsx` — deleted (T7).
- `src/components/agents/GuardianPasskeysPanel.tsx` — passkey list + revoke (T8).
- `src/components/agents/BootstrapAgent.tsx` — bootstrap wizard (T9).
- `src/app/agents/connect/page.tsx` — bootstrap route (T9).
- `src/components/agents/AgentShell.tsx` + `src/app/agents/page.tsx` — nav links (T10).
- `src/app/backend/[[...path]]/route.ts` — path-scoped `no-store` (T11).

---

## Task 1: Hermes snippet (backend)

**Files:**
- Modify: `back/backend/src/mcp/snippets.ts`
- Test: `back/backend/test/mcp/snippets.test.ts`
- Modify: `back/backend/docs/BYOA_INTEGRATION.md`

**Interfaces:**
- Produces: `buildSnippets(...)` now returns a `hermes` key (string) in addition to the existing 10.

- [ ] **Step 1: Verify Hermes's MCP config format.** Check Hermes's own docs (its MCP/tool-config page) for the exact config file + format. If it uses the common `{ "mcpServers": { "<name>": { url, headers } } }` block (as Cursor/Codex/Windsurf/Cline do), proceed with Step 3 as written. If Hermes uses a different shape, adapt the value to match. **If Hermes cannot be verified as a real MCP client with a documented config, OMIT this task entirely** (skip T1) and leave the other 10 targets — do not guess a wrong snippet. Record the decision in the commit message.

- [ ] **Step 2: Add the failing test.** In `test/mcp/snippets.test.ts`, add `"hermes"` to the key array in the first test (line 8-19) and to the JSON-form array in the third test (line 33-45):

```ts
// first test key list — add "hermes" after "generic"
"generic",
"hermes",
```
```ts
// third test JSON-form list — add "hermes" after "generic"
"generic",
"hermes",
```

- [ ] **Step 3: Run the test to verify it fails.** Run: `cd back/backend && npx vitest run test/mcp/snippets.test.ts`. Expected: FAIL (`s.hermes` is undefined).

- [ ] **Step 4: Add the snippet.** In `src/mcp/snippets.ts`, add a `hermes` entry to the returned object (after `generic`, before the closing brace). It reuses the shared `jsonBlock` (standard `mcpServers` form) unless Step 1 found otherwise:

```ts
    hermes: jsonBlock, // Hermes MCP config (mcpServers) — verified against Hermes docs
```

- [ ] **Step 5: Run tests to verify they pass.** Run: `cd back/backend && npx vitest run test/mcp/snippets.test.ts`. Expected: PASS.

- [ ] **Step 6: Document Hermes.** In `back/backend/docs/BYOA_INTEGRATION.md`, add Hermes to the supported-agents list (wherever the other agents are listed), noting it uses the standard `mcpServers` block.

- [ ] **Step 7: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add back/backend/src/mcp/snippets.ts back/backend/test/mcp/snippets.test.ts back/backend/docs/BYOA_INTEGRATION.md
git commit -m "feat(byoa): add Hermes to MCP connection snippets"
```

---

## Task 2: Guardian passkey revoke — store + migration (backend)

**Files:**
- Modify: `back/backend/src/persistence/db.ts:112-120` (passkeys table + migration block)
- Modify: `back/backend/src/persistence/passkeyStore.ts`
- Test: `back/backend/test/persistence/passkeyStore.test.ts` (create)

**Interfaces:**
- Produces: `PasskeyStore.revoke(tenantId, id): boolean`; `PasskeyView` gains `revokedAt: number | null`; `get()` returns `null` for a revoked passkey; `list()` includes revoked rows with `revokedAt` set.

- [ ] **Step 1: Write the failing test.** Create `back/backend/test/persistence/passkeyStore.test.ts`:

```ts
import { beforeEach, expect, test } from "vitest";
import type Database from "better-sqlite3";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";

const TENANT = "0x00000000000000000000000000000000000000A1";
const OTHER = "0x00000000000000000000000000000000000000B2";
const PK = {
  authenticatorName: "Guardian Passkey",
  challenge: "chal-1",
  attestation: { credentialId: "c", clientDataJson: "d", attestationObject: "o", transports: ["internal"] },
};

let db: Database.Database;
let store: SqlitePasskeyStore;
beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  store = new SqlitePasskeyStore(db);
});

test("revoke hides the passkey from get() but keeps it in list() with revokedAt", () => {
  const id = store.store(TENANT, PK);
  expect(store.get(TENANT, id)).not.toBeNull();
  expect(store.revoke(TENANT, id)).toBe(true);
  expect(store.get(TENANT, id)).toBeNull(); // can no longer authorize onboard/bootstrap
  const listed = store.list(TENANT);
  expect(listed).toHaveLength(1);
  expect(listed[0]!.revokedAt).toBeGreaterThan(0);
});

test("revoke is tenant-scoped and idempotent-safe", () => {
  const id = store.store(TENANT, PK);
  expect(store.revoke(OTHER, id)).toBe(false); // wrong tenant → no-op
  expect(store.get(TENANT, id)).not.toBeNull();
  expect(store.revoke(TENANT, id)).toBe(true);
  expect(store.revoke(TENANT, id)).toBe(false); // already revoked → no row updated
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `cd back/backend && npx vitest run test/persistence/passkeyStore.test.ts`. Expected: FAIL (`store.revoke` is not a function).

- [ ] **Step 3: Add the column + migration.** In `src/persistence/db.ts`, add `revoked_at` to the `CREATE TABLE passkeys` (after `created_at`, line 118):

```sql
      created_at   INTEGER NOT NULL,
      revoked_at   INTEGER
```

Then, in the additive-migration section (after the `akCols` block, ~line 201), add:

```ts
  const pkCols = (db.prepare("PRAGMA table_info(passkeys)").all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!pkCols.includes("revoked_at"))
    db.exec("ALTER TABLE passkeys ADD COLUMN revoked_at INTEGER");
```

- [ ] **Step 4: Implement store changes.** In `src/persistence/passkeyStore.ts`:

Extend `PasskeyView` + the interface:
```ts
export interface PasskeyView {
  id: string;
  name: string | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface PasskeyStore {
  store(tenantId: string, pk: GuardianPasskey): string;
  get(tenantId: string, id: string): GuardianPasskey | null;
  list(tenantId: string): PasskeyView[];
  /** Soft-revoke. Returns true if a live passkey was revoked. Off-chain only:
   *  prevents FUTURE onboard/bootstrap use of this passkeyId; never affects an
   *  already-provisioned entity (its Turnkey/on-chain guardian exist independently). */
  revoke(tenantId: string, id: string): boolean;
}
```

In `get()`, add the revoked filter:
```ts
        "SELECT name, challenge, attestation FROM passkeys WHERE id = ? AND owner_tenant = ? AND revoked_at IS NULL",
```

In `list()`, expose `revokedAt`:
```ts
        "SELECT id, name, created_at AS createdAt, revoked_at AS revokedAt FROM passkeys WHERE owner_tenant = ? ORDER BY created_at",
```

Add `revoke()`:
```ts
  revoke(tenantId: string, id: string): boolean {
    const res = this.db
      .prepare(
        "UPDATE passkeys SET revoked_at = ? WHERE id = ? AND owner_tenant = ? AND revoked_at IS NULL",
      )
      .run(Date.now(), id, tenantId);
    return res.changes > 0;
  }
```

- [ ] **Step 5: Run tests to verify they pass.** Run: `cd back/backend && npx vitest run test/persistence/passkeyStore.test.ts`. Expected: PASS.

- [ ] **Step 6: Run the full backend suite** to confirm no regression (get()'s new clause is used by onboard/bootstrap): `cd back/backend && npx vitest run`. Expected: PASS.

- [ ] **Step 7: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add back/backend/src/persistence/db.ts back/backend/src/persistence/passkeyStore.ts back/backend/test/persistence/passkeyStore.test.ts
git commit -m "feat(byoa): passkey soft-revoke (store + migration); get() excludes revoked"
```

---

## Task 3: Guardian passkey list/revoke routes (backend)

**Files:**
- Modify: `back/backend/src/api/routes/passkey.ts`
- Test: `back/backend/test/api/passkeys.route.test.ts` (create)

**Interfaces:**
- Consumes: `PasskeyStore.list`/`revoke` (T2), `deps.passkeys`, `deps.jwtSecret`, `requireAuth`.
- Produces: `GET /passkeys` → `PasskeyView[]`; `DELETE /passkeys/:id` → 204, or 404 `{error:{code:"not_found"}}`.

- [ ] **Step 1: Write the failing test.** Create `back/backend/test/api/passkeys.route.test.ts`, mirroring the `makeApp`/`login` harness from `test/api/bootstrapConnection.route.test.ts`:

```ts
import type Database from "better-sqlite3";
import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { GuardianPasskey } from "../../src/adapters/turnkey/provisioner";
import { buildApiApp } from "../../src/api/app";
import { SqliteNonceStore } from "../../src/auth/nonceStore";
import { SqliteApiKeyStore } from "../../src/persistence/apiKeyStore";
import { migrate, openDatabase } from "../../src/persistence/db";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { SqlitePasskeyStore } from "../../src/persistence/passkeyStore";
import { OnboardingRunner } from "../../src/workflow/runner";

const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const DOMAIN = "wizard.local";
const CHAIN = 5042002;
const PK: GuardianPasskey = {
  authenticatorName: "Test Key",
  challenge: "Y2hhbGxlbmdl",
  attestation: { credentialId: "cred-1", clientDataJson: "e30=", attestationObject: "o2M=", transports: ["internal"] },
};

let db: Database.Database;
let repo: SqliteEntityRepository;
let apiKeys: SqliteApiKeyStore;
let passkeys: SqlitePasskeyStore;

function makeApp() {
  const runner = new OnboardingRunner({ repo, runSaga: async (i) => repo.findByIdempotencyKey(i.idempotencyKey)! });
  return buildApiApp({
    webOrigin: "*",
    nonceStore: new SqliteNonceStore(db),
    siweDomain: DOMAIN,
    chainId: CHAIN,
    jwtSecret: "s",
    jwtTtlSec: 3600,
    repo,
    runner,
    passkeyRpId: "wizard.local",
    apiKeys,
    passkeys,
    mcpPublicUrl: "https://mcp.example.com/mcp",
  } as never);
}

async function login(app: ReturnType<typeof buildApiApp>) {
  const nonce = (await (await app.request("/auth/nonce")).json()).nonce as string;
  const message = createSiweMessage({ address: account.address, chainId: CHAIN, domain: DOMAIN, nonce, uri: `https://${DOMAIN}`, version: "1" });
  const signature = await account.signMessage({ message });
  const body = await (await app.request("/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, signature }) })).json();
  return body.token as string;
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  apiKeys = new SqliteApiKeyStore(db);
  passkeys = new SqlitePasskeyStore(db);
});
afterEach(() => db.close());

test("GET /passkeys lists the caller's passkeys", async () => {
  const app = makeApp();
  const jwt = await login(app);
  const id = passkeys.store(account.address, PK);
  const res = await app.request("/passkeys", { headers: { Authorization: `Bearer ${jwt}` } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.map((p: { id: string }) => p.id)).toContain(id);
});

test("DELETE /passkeys/:id revokes (get() then excludes it); unknown → 404", async () => {
  const app = makeApp();
  const jwt = await login(app);
  const id = passkeys.store(account.address, PK);
  const ok = await app.request(`/passkeys/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${jwt}` } });
  expect(ok.status).toBe(204);
  expect(passkeys.get(account.address, id)).toBeNull(); // revoked → onboard/bootstrap reject it
  const gone = await app.request(`/passkeys/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${jwt}` } });
  expect(gone.status).toBe(404);
});

test("401 without an Authorization header", async () => {
  const res = await makeApp().request("/passkeys");
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run the test to verify it fails.** Run: `cd back/backend && npx vitest run test/api/passkeys.route.test.ts`. Expected: FAIL (routes 404 / not mounted).

- [ ] **Step 3: Add the routes.** In `src/api/routes/passkey.ts`, inside `mountPasskeyRoutes`, after the `POST /passkey` handler (line 39), add:

```ts
  app.get("/passkeys", requireAuth(deps.jwtSecret), (c) => {
    return c.json(deps.passkeys.list(c.get("tenantId")));
  });

  app.delete("/passkeys/:id", requireAuth(deps.jwtSecret), (c) => {
    if (!deps.passkeys.revoke(c.get("tenantId"), c.req.param("id")))
      throw new ApiError("not_found", 404, "passkey not found"); // uniform (no exists-but-not-yours leak)
    return c.body(null, 204);
  });
```

- [ ] **Step 4: Run tests to verify they pass.** Run: `cd back/backend && npx vitest run test/api/passkeys.route.test.ts`. Expected: PASS.

- [ ] **Step 5: Run the full backend suite.** Run: `cd back/backend && npx vitest run`. Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add back/backend/src/api/routes/passkey.ts back/backend/test/api/passkeys.route.test.ts
git commit -m "feat(byoa): GET /passkeys + DELETE /passkeys/:id (list + revoke)"
```

---

## Task 4: Frontend API client + types

**Files:**
- Modify: `interface/src/lib/api/types.ts`
- Modify: `interface/src/lib/api/client.ts`
- Modify: `interface/src/components/onboarding/steps/WelcomeStep.tsx:34-41,98`

**Interfaces:**
- Produces: `Capability`, `ConnectionSnippets`, `ConnectionPackage`, `BootstrapPackage`, `PasskeyView` types; `createConnectionPackage`, `bootstrapConnection`, `storePasskey`, `getPasskeyChallenge(token)`, `listPasskeys`, `revokePasskey` client fns.

- [ ] **Step 1: Add types.** Append to `interface/src/lib/api/types.ts`:

```ts
export type Capability = "read" | "earn" | "spend";

export type ConnectionSnippets = {
  claudeCode: string;
  cursor: string;
  codex: string;
  openclaw: string;
  gemini: string;
  windsurf: string;
  cline: string;
  vscode: string;
  claudeDesktop: string;
  generic: string;
  hermes?: string; // present only if the backend Hermes snippet shipped (T1)
};

export type ConnectionPackage = {
  mcpUrl: string;
  apiKey: string;
  entityId: string;
  capability: Capability;
  snippets: ConnectionSnippets;
};

export type BootstrapPackage = {
  mcpUrl: string;
  apiKey: string;
  passkeyId: string;
  capability: Capability;
  linkCode: string;
  snippets: ConnectionSnippets;
};

export type PasskeyView = {
  id: string;
  name: string | null;
  createdAt: number;
  revokedAt: number | null;
};
```

- [ ] **Step 2: Update the client.** In `interface/src/lib/api/client.ts`:

Fix the import block (line 2-15) — remove `MintedApiKey`, add the new types:
```ts
import type {
  AgentRun,
  AgentSpec,
  ApiErrorBody,
  ApiKeyView,
  AuthSession,
  BootstrapPackage,
  Capability,
  ConnectionPackage,
  EntityView,
  GuardianPasskey,
  JobView,
  PasskeyView,
  ReputationView,
  TreasuryView,
} from "./types";
```

Replace `getPasskeyChallenge` (lines 68-73) with the token-taking version:
```ts
export async function getPasskeyChallenge(
  token: string,
): Promise<{ challenge: string; rpId: string }> {
  return request("/passkey/challenge", { token });
}
```

Delete `mintApiKey` (lines 175-184) entirely. Keep `listApiKeys` + `revokeApiKey`.

Add the new functions (after `revokeApiKey`):
```ts
export async function createConnectionPackage(
  token: string,
  entityId: string,
  capability: Capability,
): Promise<ConnectionPackage> {
  return request("/connection-package", { method: "POST", token, body: { entityId, capability } });
}

export async function bootstrapConnection(
  token: string,
  passkeyId: string,
  capability: Capability,
): Promise<BootstrapPackage> {
  return request("/bootstrap-connection", { method: "POST", token, body: { passkeyId, capability } });
}

export async function storePasskey(
  token: string,
  passkey: GuardianPasskey,
): Promise<{ id: string }> {
  return request("/passkey", { method: "POST", token, body: passkey });
}

export async function listPasskeys(token: string): Promise<PasskeyView[]> {
  return request("/passkeys", { token });
}

export async function revokePasskey(token: string, id: string): Promise<void> {
  await request(`/passkeys/${encodeURIComponent(id)}`, { method: "DELETE", token });
}
```

- [ ] **Step 3: Fix the `MintedApiKey` type.** Grep for `MintedApiKey`: `cd interface && grep -rn "MintedApiKey" src`. If the only remaining references were `client.ts` (now removed), delete the `export type MintedApiKey = …` line from `types.ts`. If anything else uses it, leave it.

- [ ] **Step 4: Fix the WelcomeStep call site.** In `interface/src/components/onboarding/steps/WelcomeStep.tsx`, add `ensureSession` to the `useAuth()` destructure (line 34-41):
```ts
  const {
    address,
    isConnected,
    isLoggingIn,
    connectWallet,
    login,
    session,
    ensureSession,
  } = useAuth();
```
And update the challenge call (line 98) — the route is now auth-gated:
```ts
      const auth = await ensureSession();
      const { challenge } = await getPasskeyChallenge(auth.token);
```

- [ ] **Step 5: Typecheck + lint.** Run: `cd interface && npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 6: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add interface/src/lib/api/types.ts interface/src/lib/api/client.ts interface/src/components/onboarding/steps/WelcomeStep.tsx
git commit -m "feat(byoa): connection/bootstrap/passkey client fns + types; auth-gate getPasskeyChallenge"
```

---

## Task 5: Shared connection building blocks

**Files:**
- Create: `interface/src/components/agents/connectTargets.ts`
- Create: `interface/src/components/agents/capabilityCopy.ts`
- Create: `interface/src/components/agents/CapabilitySelector.tsx`
- Create: `interface/src/components/agents/ConnectionSnippet.tsx`

**Interfaces:**
- Consumes: `ConnectionSnippets`, `Capability` (T4).
- Produces: `CONNECT_TARGETS`, `ConnectTarget`; `ENTITY_CAPABILITIES`, `TENANT_CAPABILITIES`, `ENTITY_DEFAULT_CAPABILITY`, `TENANT_DEFAULT_CAPABILITY`, `CapabilityOption`; `<CapabilitySelector options value onChange disabled?/>`; `<ConnectionSnippet snippets/>`.

- [ ] **Step 1: connectTargets.** Create `connectTargets.ts`:
```ts
import type { ConnectionSnippets } from "@/lib/api/types";

export type ConnectTarget = { key: keyof ConnectionSnippets; label: string; hint: string };

// Claude Code is the flagship (first). Hermes precedes generic; if the backend omits the
// hermes snippet, ConnectionSnippet simply skips rendering its pill.
export const CONNECT_TARGETS: ConnectTarget[] = [
  { key: "claudeCode", label: "Claude Code", hint: "Run this in your terminal." },
  { key: "cursor", label: "Cursor", hint: "Add to ~/.cursor/mcp.json" },
  { key: "codex", label: "Codex", hint: "Add to your Codex MCP config." },
  { key: "windsurf", label: "Windsurf", hint: "Add to ~/.codeium/windsurf/mcp_config.json" },
  { key: "cline", label: "Cline", hint: "Add to cline_mcp_settings.json" },
  { key: "gemini", label: "Gemini CLI", hint: "Add to your Gemini settings.json (mcpServers)." },
  { key: "vscode", label: "VS Code", hint: "Add to .vscode/mcp.json (uses `servers`)." },
  { key: "claudeDesktop", label: "Claude Desktop", hint: "Uses the mcp-remote bridge." },
  { key: "openclaw", label: "OpenClaw", hint: "Add to your OpenClaw MCP config." },
  { key: "hermes", label: "Hermes", hint: "Add to your Hermes MCP config." },
  { key: "generic", label: "Generic", hint: "Raw endpoint + auth header for any MCP client." },
];
```

- [ ] **Step 2: capabilityCopy.** Create `capabilityCopy.ts`:
```ts
import type { Capability } from "@/lib/api/types";

export type CapabilityOption = { value: Capability; label: string; description: string };

// Entity-scoped (web-first): bounded by ONE body's on-chain caps → spend default is safe.
export const ENTITY_CAPABILITIES: CapabilityOption[] = [
  { value: "read", label: "Read", description: "See balances, jobs, and status. Cannot move money or take jobs." },
  { value: "earn", label: "Earn", description: "Read + run jobs to earn (ERC-8183)." },
  { value: "spend", label: "Spend", description: "Earn + pay via x402 and fund this treasury, within its caps/allowlist." },
];

// Tenant-wide (bootstrap): acts across your whole tenant → default to read, opt-up explicitly.
export const TENANT_CAPABILITIES: CapabilityOption[] = [
  { value: "read", label: "Read", description: "See balances, jobs, and status across your tenant. Cannot move money." },
  { value: "earn", label: "Earn", description: "Read + run jobs to earn (ERC-8183)." },
  { value: "spend", label: "Spend", description: "Earn + pay + fund treasuries + create new agent legal bodies across your tenant." },
];

export const ENTITY_DEFAULT_CAPABILITY: Capability = "spend";
export const TENANT_DEFAULT_CAPABILITY: Capability = "read";
```

- [ ] **Step 3: CapabilitySelector.** Create `CapabilitySelector.tsx`:
```tsx
"use client";

import type { Capability } from "@/lib/api/types";
import { cx } from "@/components/onboarding/primitives";
import type { CapabilityOption } from "./capabilityCopy";

export function CapabilitySelector({
  options,
  value,
  onChange,
  disabled,
}: {
  options: CapabilityOption[];
  value: Capability;
  onChange: (c: Capability) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-xl border px-3.5 py-2.5 text-left transition-colors disabled:opacity-50",
            value === o.value ? "border-accent/40 bg-accent/[0.06]" : "hairline-strong hover:bg-paper-2",
          )}
        >
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
            <span
              className={cx(
                "h-3.5 w-3.5 rounded-full border",
                value === o.value ? "border-accent bg-accent" : "border-line-strong",
              )}
            />
            {o.label}
          </div>
          <div className="mt-1 pl-[22px] text-[11.5px] leading-[1.45] text-muted-2">{o.description}</div>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: ConnectionSnippet.** Create `ConnectionSnippet.tsx`:
```tsx
"use client";

import * as React from "react";
import type { ConnectionSnippets } from "@/lib/api/types";
import { Button, cx } from "@/components/onboarding/primitives";
import { CONNECT_TARGETS } from "./connectTargets";

export function ConnectionSnippet({ snippets }: { snippets: ConnectionSnippets }) {
  const available = CONNECT_TARGETS.filter((t) => snippets[t.key]);
  const [selected, setSelected] = React.useState<keyof ConnectionSnippets>(
    available[0]?.key ?? "claudeCode",
  );
  const [copied, setCopied] = React.useState(false);

  const target = available.find((t) => t.key === selected) ?? available[0];
  const snippet = target ? snippets[target.key] ?? "" : "";
  const canCopy = typeof navigator !== "undefined" && !!navigator.clipboard?.writeText;

  async function copy() {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* fall through to the manual-select hint */
    }
  }

  if (!target) return null;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-1.5">
        {available.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setSelected(t.key)}
            className={cx(
              "rounded-full border px-3 py-1 text-[11.5px] transition-colors",
              t.key === selected
                ? "border-accent/40 bg-accent/10 text-accent-soft"
                : "hairline text-muted hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-2 text-[11px] text-muted-2">{target.hint}</div>
      {target.key === "claudeCode" && (
        <div className="mt-1 text-[11px] text-muted-2">
          This command puts your key in your shell history — prefer a config-file option for a long-lived key.
        </div>
      )}
      <pre className="mt-2 select-text overflow-x-auto rounded-xl border hairline bg-paper-2/60 p-3 text-[11px] leading-relaxed text-muted">
        {snippet}
      </pre>
      {canCopy ? (
        <Button variant="ghost" size="md" className="mt-2" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy snippet"}
        </Button>
      ) : (
        <div className="mt-2 text-[11px] text-muted-2">Select the text above and copy manually.</div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Typecheck + lint.** Run: `cd interface && npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 6: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add interface/src/components/agents/connectTargets.ts interface/src/components/agents/capabilityCopy.ts interface/src/components/agents/CapabilitySelector.tsx interface/src/components/agents/ConnectionSnippet.tsx
git commit -m "feat(byoa): shared ConnectionSnippet + CapabilitySelector + copy tables"
```

---

## Task 6: ActiveConnectionsPanel (key list + revoke)

**Files:**
- Create: `interface/src/components/agents/ActiveConnectionsPanel.tsx`

**Interfaces:**
- Consumes: `listApiKeys`, `revokeApiKey` (existing), `ApiKeyView`, `useAuth`.
- Produces: `<ActiveConnectionsPanel entityId?/>` — with `entityId`, shows `connect:<entityId>` keys; without, shows all keys.

- [ ] **Step 1: Create the component.**
```tsx
"use client";

import * as React from "react";
import { listApiKeys, revokeApiKey } from "@/lib/api/client";
import type { ApiKeyView } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { cx } from "@/components/onboarding/primitives";

export function ActiveConnectionsPanel({ entityId }: { entityId?: string }) {
  const { ensureSession } = useAuth();
  const [keys, setKeys] = React.useState<ApiKeyView[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const auth = await ensureSession();
    const all = await listApiKeys(auth.token);
    setKeys(
      entityId ? all.filter((k) => (k.label ?? "").startsWith(`connect:${entityId}`)) : all,
    );
  }, [ensureSession, entityId]);

  React.useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  async function onRevoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      await revokeApiKey(auth.token, id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">Active connections</div>
      {keys.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted-2">No active connections yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between gap-3 rounded-xl border hairline px-3 py-2.5 text-[12px]"
            >
              <div className="min-w-0">
                <div className="truncate text-ink">{k.label ?? "Unlabeled"}</div>
                <div className="font-mono text-[10.5px] text-muted-2">{k.id.slice(0, 8)}…</div>
              </div>
              <button
                type="button"
                disabled={busy || !!k.revokedAt}
                onClick={() => void onRevoke(k.id)}
                className={cx(
                  "shrink-0 text-[11.5px] underline-offset-2 hover:underline",
                  k.revokedAt ? "text-muted-2" : "text-[#ff8a84]",
                )}
              >
                {k.revokedAt ? "Revoked" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[11.5px] text-[#ff8a84]">{error}</p>}
    </div>
  );
}
```
> Note: the prod DB was deployed fresh, so there are no legacy `mintApiKey` keys; every listed key is a `connect:`/`bootstrap:` connection. The unfiltered variant (on `/agents/connect`) still lists any key for full revocability.

- [ ] **Step 2: Typecheck + lint.** Run: `cd interface && npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 3: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add interface/src/components/agents/ActiveConnectionsPanel.tsx
git commit -m "feat(byoa): ActiveConnectionsPanel (list + one-click revoke)"
```

---

## Task 7: ConnectAgentPanel + dashboard swap

**Files:**
- Create: `interface/src/components/agents/ConnectAgentPanel.tsx`
- Modify: `interface/src/components/agents/AgentDashboard.tsx:16,317-319`
- Delete: `interface/src/components/agents/McpKeysPanel.tsx`

**Interfaces:**
- Consumes: `createConnectionPackage` (T4), `ConnectionSnippet` (T5), `ActiveConnectionsPanel` (T6), `CapabilitySelector` + `ENTITY_CAPABILITIES`/`ENTITY_DEFAULT_CAPABILITY` (T5), `EntityView`, `ApiError`.
- Produces: `<ConnectAgentPanel entity/>`.

- [ ] **Step 1: Create ConnectAgentPanel.**
```tsx
"use client";

import * as React from "react";
import { createConnectionPackage } from "@/lib/api/client";
import type { Capability, ConnectionPackage, EntityView } from "@/lib/api/types";
import { ApiError } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Button, Callout, Card } from "@/components/onboarding/primitives";
import { ActiveConnectionsPanel } from "./ActiveConnectionsPanel";
import { CapabilitySelector } from "./CapabilitySelector";
import { ConnectionSnippet } from "./ConnectionSnippet";
import { ENTITY_CAPABILITIES, ENTITY_DEFAULT_CAPABILITY } from "./capabilityCopy";

export function ConnectAgentPanel({ entity }: { entity: EntityView }) {
  const { ensureSession } = useAuth();
  const [capability, setCapability] = React.useState<Capability>(ENTITY_DEFAULT_CAPABILITY);
  const [pkg, setPkg] = React.useState<ConnectionPackage | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const notReady = entity.status !== "bound" && entity.status !== "funded";
  const badMcpUrl = !!pkg && /localhost|127\.0\.0\.1/.test(pkg.mcpUrl);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      setPkg(await createConnectionPackage(auth.token, entity.id, capability));
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? "Couldn't find that agent body — reload and try again."
          : e instanceof Error
            ? e.message
            : "Failed to generate connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">Connect your agent</div>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        Generate a scoped connection so your MCP agent (Claude Code, Cursor, …) can operate this legal body.
      </p>

      {notReady && (
        <Callout tone="info" className="mt-4">
          This agent&apos;s legal body is still being set up — a connection generated now won&apos;t be able to
          pay or take jobs until it&apos;s bound.
        </Callout>
      )}

      {!pkg ? (
        <>
          <div className="mt-4">
            <CapabilitySelector
              options={ENTITY_CAPABILITIES}
              value={capability}
              onChange={setCapability}
              disabled={busy}
            />
          </div>
          <Button className="mt-4" onClick={() => void generate()} loading={busy} disabled={busy}>
            Generate connection
          </Button>
        </>
      ) : (
        <>
          <Callout tone="accent" className="mt-4" title="Copy your key now">
            <p className="text-[12px] text-muted">You won&apos;t see this key again. Store it somewhere safe.</p>
            <code className="mt-2 block break-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink">
              {pkg.apiKey}
            </code>
          </Callout>
          {badMcpUrl && (
            <Callout tone="warn" className="mt-3">
              Server MCP URL looks misconfigured ({pkg.mcpUrl}) — the snippet may not work.
            </Callout>
          )}
          <ConnectionSnippet snippets={pkg.snippets} />
          <Button variant="ghost" size="md" className="mt-4" onClick={() => setPkg(null)}>
            Generate a new connection
          </Button>
        </>
      )}

      {error && <p className="mt-3 text-[11.5px] text-[#ff8a84]">{error}</p>}

      <div className="mt-6 border-t hairline pt-4">
        <ActiveConnectionsPanel entityId={entity.id} />
      </div>
    </Card>
  );
}
```

- [ ] **Step 2: Swap it into AgentDashboard.** In `interface/src/components/agents/AgentDashboard.tsx`:
Replace the import (line 16):
```ts
import { ConnectAgentPanel } from "@/components/agents/ConnectAgentPanel";
```
Replace the render (lines 317-319):
```tsx
      {entity && (
        <div className="mt-8">
          <ConnectAgentPanel entity={entity} />
        </div>
      )}
```

- [ ] **Step 3: Delete McpKeysPanel.** Run: `git rm interface/src/components/agents/McpKeysPanel.tsx`. Then grep to be sure nothing else imports it: `cd interface && grep -rn "McpKeysPanel" src` — expect no results.

- [ ] **Step 4: Typecheck + lint.** Run: `cd interface && npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 5: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add interface/src/components/agents/ConnectAgentPanel.tsx interface/src/components/agents/AgentDashboard.tsx
git rm interface/src/components/agents/McpKeysPanel.tsx
git commit -m "feat(byoa): ConnectAgentPanel replaces McpKeysPanel on the dashboard"
```

---

## Task 8: GuardianPasskeysPanel (passkey list + revoke)

**Files:**
- Create: `interface/src/components/agents/GuardianPasskeysPanel.tsx`

**Interfaces:**
- Consumes: `listPasskeys`, `revokePasskey` (T4), `PasskeyView`, `useAuth`.
- Produces: `<GuardianPasskeysPanel/>`.

- [ ] **Step 1: Create the component.**
```tsx
"use client";

import * as React from "react";
import { listPasskeys, revokePasskey } from "@/lib/api/client";
import type { PasskeyView } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { cx } from "@/components/onboarding/primitives";

export function GuardianPasskeysPanel() {
  const { ensureSession } = useAuth();
  const [passkeys, setPasskeys] = React.useState<PasskeyView[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const auth = await ensureSession();
    setPasskeys(await listPasskeys(auth.token));
  }, [ensureSession]);

  React.useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  async function onRevoke(id: string) {
    if (
      !window.confirm(
        "Revoking stops this passkey from creating new agents. Existing agents are unaffected. Continue?",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      await revokePasskey(auth.token, id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">Guardian passkeys</div>
      {passkeys.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted-2">No guardian passkeys yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {passkeys.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-xl border hairline px-3 py-2.5 text-[12px]"
            >
              <div className="min-w-0">
                <div className="truncate text-ink">{p.name ?? "Guardian passkey"}</div>
                <div className="font-mono text-[10.5px] text-muted-2">{p.id.slice(0, 8)}…</div>
              </div>
              <button
                type="button"
                disabled={busy || !!p.revokedAt}
                onClick={() => void onRevoke(p.id)}
                className={cx(
                  "shrink-0 text-[11.5px] underline-offset-2 hover:underline",
                  p.revokedAt ? "text-muted-2" : "text-[#ff8a84]",
                )}
              >
                {p.revokedAt ? "Revoked" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[11.5px] text-[#ff8a84]">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint.** Run: `cd interface && npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 3: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add interface/src/components/agents/GuardianPasskeysPanel.tsx
git commit -m "feat(byoa): GuardianPasskeysPanel (list + revoke passkeys)"
```

---

## Task 9: BootstrapAgent wizard + /agents/connect route

**Files:**
- Create: `interface/src/components/agents/BootstrapAgent.tsx`
- Create: `interface/src/app/agents/connect/page.tsx`

**Interfaces:**
- Consumes: `getPasskeyChallenge`, `storePasskey`, `bootstrapConnection` (T4), `createGuardianPasskey` (existing), `ConnectionSnippet` (T5), `CapabilitySelector` + `TENANT_CAPABILITIES`/`TENANT_DEFAULT_CAPABILITY` (T5), `ActiveConnectionsPanel` (T6), `GuardianPasskeysPanel` (T8), `RequireAuth` + `AgentShell` (existing).
- Produces: `/agents/connect` page.

- [ ] **Step 1: Create BootstrapAgent.**
```tsx
"use client";

import * as React from "react";
import { bootstrapConnection, getPasskeyChallenge, storePasskey } from "@/lib/api/client";
import { createGuardianPasskey } from "@/lib/api/passkey";
import type { BootstrapPackage, Capability } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Button, Callout, Card, StepHeader } from "@/components/onboarding/primitives";
import { ActiveConnectionsPanel } from "./ActiveConnectionsPanel";
import { CapabilitySelector } from "./CapabilitySelector";
import { ConnectionSnippet } from "./ConnectionSnippet";
import { GuardianPasskeysPanel } from "./GuardianPasskeysPanel";
import { TENANT_CAPABILITIES, TENANT_DEFAULT_CAPABILITY } from "./capabilityCopy";

type Phase = "passkey" | "capability" | "confirm" | "generate";

function LinkCodeBox({ code }: { code: string }) {
  const [end] = React.useState(() => Date.now() + 15 * 60_000);
  const [remaining, setRemaining] = React.useState(15 * 60);
  React.useEffect(() => {
    const h = setInterval(() => setRemaining(Math.max(0, Math.round((end - Date.now()) / 1000))), 1000);
    return () => clearInterval(h);
  }, [end]);
  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, "0");
  return (
    <div className="mt-4 rounded-xl border border-accent/30 bg-accent/[0.06] px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">One-time link code</div>
      <code className="mt-1 block break-all font-mono text-[13px] text-ink">{code}</code>
      <div className="mt-1 text-[11px] text-muted-2">
        {remaining > 0 ? `Valid for ${mm}:${ss}` : "Expired — start over to get a new code."}
      </div>
    </div>
  );
}

export function BootstrapAgent() {
  const { ensureSession } = useAuth();
  const [phase, setPhase] = React.useState<Phase>("passkey");
  const [passkeyId, setPasskeyId] = React.useState<string | null>(null);
  const [capability, setCapability] = React.useState<Capability>(TENANT_DEFAULT_CAPABILITY);
  const [pkg, setPkg] = React.useState<BootstrapPackage | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const webauthnUnavailable =
    typeof window !== "undefined" && typeof window.PublicKeyCredential === "undefined";

  async function createPasskey() {
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      const { challenge, rpId } = await getPasskeyChallenge(auth.token);
      const passkey = await createGuardianPasskey(challenge, rpId);
      const { id } = await storePasskey(auth.token, passkey);
      setPasskeyId(id);
      setPhase("capability");
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotAllowedError")
        setError("Passkey request was cancelled or denied on your device.");
      else setError(e instanceof Error ? e.message : "Passkey creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!passkeyId) return;
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession(); // re-check: guards a stale token across the multi-step flow
      setPkg(await bootstrapConnection(auth.token, passkeyId, capability));
      setPhase("generate");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate connection.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPhase("passkey");
    setPasskeyId(null);
    setPkg(null);
    setError(null);
    setCapability(TENANT_DEFAULT_CAPABILITY);
  }

  return (
    <div>
      <StepHeader
        eyebrow="Bootstrap"
        title="Let your agent set itself up"
        intro="Create a guardian passkey and a one-time link code so your MCP agent can onboard and operate a new legal body."
      />
      <Card className="p-6">
        {phase === "passkey" &&
          (webauthnUnavailable ? (
            <Callout tone="warn">
              Passkeys aren&apos;t available in this browser. Use the web-first &ldquo;Connect your agent&rdquo;
              panel on an agent&apos;s dashboard instead.
            </Callout>
          ) : (
            <div>
              <p className="text-[13px] text-muted">
                The guardian passkey is your human approval anchor — it authorizes creating the legal body.
              </p>
              <Button className="mt-4" onClick={() => void createPasskey()} loading={busy} disabled={busy}>
                Create guardian passkey
              </Button>
            </div>
          ))}

        {phase === "capability" && (
          <div>
            <p className="text-[13px] text-muted">
              Choose what the linked agent may do. This key is <span className="text-ink">tenant-wide</span>, so
              it can act across all your legal bodies.
            </p>
            <div className="mt-4">
              <CapabilitySelector options={TENANT_CAPABILITIES} value={capability} onChange={setCapability} />
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="ghost" onClick={() => setPhase("passkey")}>
                Back
              </Button>
              <Button onClick={() => setPhase("confirm")}>Continue</Button>
            </div>
          </div>
        )}

        {phase === "confirm" && (
          <div>
            <Callout tone="warn" title="Confirm authorization">
              You&apos;re about to create a <span className="text-ink">tenant-wide</span> connection with{" "}
              <span className="text-ink">{capability}</span> power, anchored to the guardian passkey you just
              created. Any agent that receives the one-time link code can act on your legal bodies at this level.
              {capability === "spend" && (
                <div className="mt-2">
                  &ldquo;spend&rdquo; also lets the agent fund treasuries and create new agent legal bodies.
                </div>
              )}
            </Callout>
            <div className="mt-4 flex gap-2">
              <Button variant="ghost" onClick={() => setPhase("capability")}>
                Back
              </Button>
              <Button onClick={() => void generate()} loading={busy} disabled={busy}>
                Confirm &amp; generate
              </Button>
            </div>
          </div>
        )}

        {phase === "generate" && pkg && (
          <div>
            <Callout tone="accent" title="Copy your key now">
              <p className="text-[12px] text-muted">You won&apos;t see this key again.</p>
              <code className="mt-2 block break-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink">
                {pkg.apiKey}
              </code>
            </Callout>
            <ConnectionSnippet snippets={pkg.snippets} />
            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">
                Passkey ID (needed for onboarding)
              </div>
              <code className="mt-1 block break-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink">
                {pkg.passkeyId}
              </code>
            </div>
            <LinkCodeBox code={pkg.linkCode} />
            <ol className="mt-4 flex list-decimal flex-col gap-1.5 pl-5 text-[12px] text-muted">
              <li>Paste the MCP config above into your agent.</li>
              <li>
                Ask your agent to run <code className="text-ink">claim_connection</code> with the link code — it
                returns <code className="text-ink">bound: true</code>.
              </li>
              <li>
                Ask it to run <code className="text-ink">onboard_agent</code> with{" "}
                <code className="text-ink">passkeyId: {pkg.passkeyId}</code> to create the legal body.
              </li>
              <li>
                Poll <code className="text-ink">get_entity</code> until status is{" "}
                <code className="text-ink">bound</code>.
              </li>
            </ol>
            <Button variant="ghost" size="md" className="mt-4" onClick={reset}>
              Start over
            </Button>
          </div>
        )}

        {error && <p className="mt-3 text-[11.5px] text-[#ff8a84]">{error}</p>}
      </Card>

      <div className="mt-6">
        <ActiveConnectionsPanel />
      </div>
      <div className="mt-6">
        <GuardianPasskeysPanel />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the route.** Create `interface/src/app/agents/connect/page.tsx`:
```tsx
"use client";

import { BootstrapAgent } from "@/components/agents/BootstrapAgent";
import { AgentShell } from "@/components/agents/AgentShell";
import { RequireAuth } from "@/components/agents/RequireAuth";

export default function ConnectPage() {
  return (
    <RequireAuth>
      <AgentShell title="Connect an agent">
        <BootstrapAgent />
      </AgentShell>
    </RequireAuth>
  );
}
```

- [ ] **Step 3: Typecheck + lint.** Run: `cd interface && npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 4: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add interface/src/components/agents/BootstrapAgent.tsx interface/src/app/agents/connect/page.tsx
git commit -m "feat(byoa): agent-first bootstrap wizard + /agents/connect route"
```

---

## Task 10: Navigation links

**Files:**
- Modify: `interface/src/components/agents/AgentShell.tsx:36`
- Modify: `interface/src/app/agents/page.tsx:66-73`

- [ ] **Step 1: Add the shell nav link.** In `AgentShell.tsx`, after the "My agents" NavLink (line 36), add:
```tsx
            <NavLink href="/agents">My agents</NavLink>
            <NavLink href="/agents/connect">Connect an agent</NavLink>
```

- [ ] **Step 2: Add the list-header button.** In `interface/src/app/agents/page.tsx`, change the header block (lines 66-73) to include a Connect link beside "Create another agent":
```tsx
          <div className="mb-4 flex justify-end gap-2">
            <Link
              href="/agents/connect"
              className="inline-flex rounded-full border hairline-strong bg-paper/40 px-5 py-2.5 text-[13px] font-medium text-ink hover:bg-paper-2"
            >
              Connect an agent
            </Link>
            <Link
              href="/onboarding?new=1"
              className="inline-flex rounded-full bg-ink px-5 py-2.5 text-[13px] font-medium text-paper hover:bg-ink-hover"
            >
              Create another agent
            </Link>
          </div>
```

- [ ] **Step 3: Typecheck + lint.** Run: `cd interface && npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 4: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add interface/src/components/agents/AgentShell.tsx interface/src/app/agents/page.tsx
git commit -m "feat(byoa): nav links to /agents/connect"
```

---

## Task 11: Path-scoped proxy no-store

**Files:**
- Modify: `interface/src/app/backend/[[...path]]/route.ts:35-40`

- [ ] **Step 1: Path-scope `no-store`.** Replace the response construction (lines 35-40) with:
```ts
  const outHeaders: Record<string, string> = {};
  const ct = res.headers.get("content-type");
  if (ct) outHeaders["content-type"] = ct;
  const joined = path?.join("/") ?? "";
  if (joined === "connection-package" || joined === "bootstrap-connection") {
    outHeaders["cache-control"] = "no-store";
  }

  return new NextResponse(body, { status: res.status, headers: outHeaders });
```

- [ ] **Step 2: Typecheck + lint.** Run: `cd interface && npx tsc --noEmit && npm run lint`. Expected: no errors.

- [ ] **Step 3: Commit.**
```bash
cd /home/mbarr/Project-Alpha
git add interface/src/app/backend/[[...path]]/route.ts
git commit -m "feat(byoa): path-scoped Cache-Control: no-store for connect responses"
```

---

## Final verification (after all tasks, before merge)

Not a code task — run as the whole-branch check:

1. **Backend suite:** `cd back/backend && npx vitest run` → all green.
2. **Frontend:** `cd interface && npx tsc --noEmit && npm run lint` → clean; `npm run build` → succeeds.
3. **Manual smoke against the live VPS** (backend already deployed; deploy the frontend or run `interface` locally pointed at `/backend`):
   - Web-first: open a restored agent (TestAgentMB_1), Connect your agent → Generate (spend) → paste the Claude Code snippet into Claude Code → confirm `whoami`/`list_entities` works. Revoke it in Active connections → confirm the tool call now 401s.
   - Bootstrap: `/agents/connect` → create passkey → capability (read) → confirm → generate; run `claim_connection` then `onboard_agent { passkeyId }` from an agent → confirm a new entity reaches `bound`. Revoke the passkey in Guardian passkeys → confirm a further `onboard_agent` with it is rejected.
   - Proxy: `curl -si https://project-alpha-pi.vercel.app/backend/connection-package -X POST` (unauth → 401) and confirm a real `connection-package` response carries `Cache-Control: no-store` while `/backend/healthz` does not.

---

## Self-Review notes (author)

- **Spec coverage:** every §Component design + §Backend hardening item maps to a task (ConnectAgentPanel=T7, BootstrapAgent=T9, ActiveConnectionsPanel=T6, GuardianPasskeysPanel=T8, ConnectionSnippet/CapabilitySelector/connectTargets/capabilityCopy=T5, client/types=T4, Hermes=T1, passkey revoke=T2+T3, proxy no-store=T11, nav=T10). M4 getPasskeyChallenge fix = T4. Capability copy differentiation + defaults = T5 (data) consumed by T7/T9.
- **Type consistency:** `Capability`, `ConnectionSnippets`, `ConnectionPackage`, `BootstrapPackage`, `PasskeyView` defined in T4 and consumed unchanged in T5-T9. Backend `PasskeyView.revokedAt` (T2) mirrored by frontend `PasskeyView.revokedAt` (T4). `entity.id` (frontend `EntityView.id`) used as the backend entity id (== idempotency_key).
- **Ordering:** backend routes (T1-T3) precede the frontend client (T4) that calls them; shared blocks (T5) precede the panels (T6-T9); nav/proxy (T10-T11) last.
- **Known follow-ups (out of scope):** deprecating the `/api-keys` mint route; live claim polling. Both recorded in the spec.
