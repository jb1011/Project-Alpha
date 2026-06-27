# MCP Server — Design (Track B)

> Status: design approved 2026-06-27. Part of the Circle grant backend roadmap
> (`docs/plans/2026-06-21-grant-backend-roadmap.md`), **Track B**. This is the second
> Phase-3 backend face: the same onboarding brain exposed as MCP tools for Claude/Cursor.
> Tracks A (wizard REST API) and C (ERC-8183 proof-of-life) are already merged.
> Next step after spec review: writing-plans → implementation on branch `feat/mcp-server`
> (PR to `main`).

## 1. Context & goal

The onboarding brain (idempotent, resumable saga + Arc/Turnkey adapters) is built, live-proven
(Phase 2), and already wears one multi-tenant face: the **wizard REST API** (Track A, merged
PR #5). Track B adds a **second face over the same brain** — an **MCP server** so an agent in
Claude Desktop / Cursor can onboard and manage agent legal bodies conversationally.

This is a thin, additive surface. **No changes** to smart contracts, the saga
(`workflow/onboarding.ts`), or the existing REST routes. We add: a remote MCP server, a
per-tenant API-key auth path, server-side storage of the guardian passkey attestation (the
missing half of roadmap A3), and four MCP tools that call the **same** `runner`/`repo`
methods the REST routes already use.

### Existing pieces we build on
- `backend/src/api/app.ts` — `buildApiApp(deps)`, the Hono wizard API app (CORS, error
  envelope, `requireAuth`, mounted route groups).
- `backend/src/api/main.ts` — composition root: wires config, db, persistence, Arc adapter,
  Turnkey provisioning, operator signer, `OnboardingRunner`, `buildJobDeps`.
- `backend/src/workflow/runner.ts` — `OnboardingRunner.start/fund/reconcileInFlight` (the
  background saga driver; keeps an in-memory `inFlight` set).
- `backend/src/persistence/entityRepository.ts` — `listByTenant`, `findByIdempotencyKey`,
  records carry `ownerTenantId` (tenant scoping already exists).
- `backend/src/auth/middleware.ts` — `requireAuth` (SIWE→JWT) sets `c.get("tenantId")`.
- `backend/src/api/routes/passkey.ts` — `GET /passkey/challenge` (issues a challenge only;
  **no storage yet** — the attestation is currently passed inline to `POST /onboard`).
- `backend/src/adapters/turnkey/provisioner.ts` — `GuardianPasskey` type (challenge +
  attestation: `credentialId`, `clientDataJson`, `attestationObject`, `transports`).
- `backend/src/policy/agentSpec.ts` — Zod `AgentSpec` (+ `zod-to-json-schema` already a dep).

## 2. Locked decisions (from brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| Deployment model | **Remote, multi-tenant**, Streamable HTTP | Matches the hosted brain + roadmap "API key → tenantId". |
| Process topology | **Same process** as the REST API (`/mcp` route on the Hono app) | Shares ONE `OnboardingRunner` (one `inFlight` set, one reconciler). A second process would race the same SQLite file and re-open the double-mint window Candidate 1 is closing. |
| Tool surface (v1) | Core 4 + AgentSpec schema resource | YAGNI; job/payment tools deferred. |
| Auth | **Self-service** `POST /api-keys`; hashed `api_keys` table; `Bearer → tenantId` | Long-lived key fits a pasted client config; JWT TTL would be brittle. |
| Guardian passkey | **Pre-capture, reference by handle** | An LLM can't perform a WebAuthn ceremony. Store the (public) attestation server-side keyed to the tenant; `onboard_agent` takes a handle. Preserves the per-agent Turnkey vault story. |
| REST `/onboard` | **Unchanged** — stays inline-passkey only; handles are MCP-only (v1) | Backward-compatible, smallest scope. Parity can come later if wanted. |
| MCP SDK | `@modelcontextprotocol/sdk`, **stable v1.x** | v2 is alpha; pin exact transport class at implementation time. |
| Session mode | **Stateless** (`sessionIdGenerator: undefined`, transport per request) | Four request/response tools, no server-initiated streaming/notifications needed. |

## 3. Architecture

```
Claude / Cursor (MCP client)
        │  Streamable HTTP, Authorization: Bearer <api-key>
        ▼
Hono app (ONE process / port)
 ├── existing REST routes  (SIWE→JWT, requireAuth)
 │     + POST/GET/DELETE /api-keys      (new, self-service, behind requireAuth)
 │     + POST /passkey                  (new, store attestation → handle, behind requireAuth)
 └── /mcp  ── mcpAuth (Bearer api-key → tenantId) ── StreamableHTTP transport ── McpServer
                                                                                   └── tools
        │
        ▼
buildBackend(cfg)  →  { repo, runner, jobDeps, nonceStore, apiKeys, passkeys, ... }
        │  (shared composition root — consumed by BOTH the REST app and the MCP route)
        ▼
runner.start / runner.fund / repo.listByTenant / repo.findByIdempotencyKey   (unchanged brain)
```

### 3.1 Composition extraction (targeted refactor)
The wiring currently inside `main()` in `api/main.ts` moves into a new
`backend/src/composition.ts` → `buildBackend(cfg): Backend`. `api/main.ts` becomes a thin
entrypoint: `const backend = buildBackend(cfg); const app = buildApiApp({ ...backend });
serve(...)`. This is the only change to existing wiring; the saga, adapters, and REST routes
are untouched. Justified because the MCP route must reuse the exact same `runner`/`repo`
instances (not new ones).

### 3.2 MCP module (`backend/src/mcp/`)
- `auth.ts` — `mcpAuth(apiKeys)`: read `Authorization: Bearer`, hash, look up → `tenantId`;
  reject with 401 if missing/unknown/revoked. Produces `authInfo = { token, tenantId }`.
- `server.ts` — `buildMcpServer(backend)`: constructs `McpServer`, registers the four tools
  and the schema resource. Tool handlers read `tenantId` from `authInfo` (the per-request
  auth context the transport passes through), never from a tool argument.
- `transport.ts` — mounts a stateless Streamable HTTP transport on the Hono `/mcp` route;
  hands the request to the transport with `{ authInfo }`.

## 4. Data model (migrations in `persistence/db.ts`)

```sql
CREATE TABLE api_keys (
  id            TEXT PRIMARY KEY,           -- public key id (kid), shown in listings
  owner_tenant  TEXT NOT NULL,              -- 0x… controller address
  hash          TEXT NOT NULL,              -- sha-256(plaintext key); plaintext shown ONCE
  label         TEXT,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER                     -- NULL = active
);
CREATE INDEX idx_api_keys_hash ON api_keys(hash);

CREATE TABLE passkeys (
  id            TEXT PRIMARY KEY,           -- the handle onboard_agent references
  owner_tenant  TEXT NOT NULL,
  name          TEXT,                       -- authenticatorName
  challenge     TEXT NOT NULL,
  attestation   TEXT NOT NULL,              -- JSON: {credentialId, clientDataJson, attestationObject, transports}
  created_at    INTEGER NOT NULL
);
```

Stores: `ApiKeyStore` (`mint(tenant,label) → {id,plaintext}`, `verify(plaintext) → tenant|null`,
`list(tenant)`, `revoke(tenant,id)`) and `PasskeyStore` (`store(tenant, GuardianPasskey) → id`,
`get(tenant, id) → GuardianPasskey|null`, `list(tenant)`). Both behind interfaces, SQLite impls,
mirroring the existing repository pattern.

**Key format:** `mcp_<base64url(32 random bytes)>`. Only `sha-256(plaintext)` is persisted
(no reversible storage). Plaintext is returned exactly once from `POST /api-keys`.

**Non-custodial note:** the stored passkey attestation is a *public* credential (credential id +
client data + attestation object), not a private key. Storing it does not make the system
custodial.

## 5. REST additions (behind existing `requireAuth`, tenant-scoped)

- `POST   /api-keys`        `{label?}` → `201 {id, key, label, createdAt}` (`key` = plaintext, once).
- `GET    /api-keys`        → `200 [{id, label, createdAt, revokedAt}]` (never returns hashes/plaintext).
- `DELETE /api-keys/:id`    → `204` (sets `revoked_at`; 404 if not owned by tenant).
- `POST   /passkey`         `{name?, challenge, attestation}` → `201 {id}` (validates shape via Zod;
  stores keyed to the tenant; `id` is the handle). `GET /passkey/challenge` already exists.

Error envelope + Zod 400s reuse the existing `ApiError`/`apiOnError` machinery.

## 6. MCP tools

All tools resolve `tenantId` from `authInfo` and call the same methods the REST routes use.

| Tool | Input (Zod) | Maps to | Returns |
|---|---|---|---|
| `onboard_agent` | `{ spec: AgentSpec, passkeyId: string, idempotencyKey?: string }` | resolve `passkeyId` → `GuardianPasskey` via `PasskeyStore.get(tenant,id)` (404→error), force `spec.roles.guardian = tenant`, then `runner.start({spec, userKey, tenantId, guardianPasskey})` | `{ id, status: "pending" }` |
| `get_entity` | `{ id: string }` | `repo.findByIdempotencyKey(id)` + `ownerTenantId === tenant` guard | entity view (or not-found error) |
| `list_entities` | `{}` | `repo.listByTenant(tenant)` | entity views |
| `fund_treasury` | `{ id: string, amount: string }` | `runner.fund({id, tenantId, amount: BigInt(amount)})` | `{ id, status }` |

- **Schema resource:** `schema://agent-spec` returns the `AgentSpec` JSON-schema
  (`zodToJsonSchema(AgentSpecSchema)`), so the model can construct a valid spec before calling
  `onboard_agent`. (Resource, not a tool — it's read-only reference data.)
- **Async contract:** `onboard_agent` returns immediately; tool descriptions instruct the model
  to **poll `get_entity`** through `provisioned → translating → created → bound → funded`.
- Tool errors map saga/validation failures to MCP tool errors with readable messages
  (`isError: true`), reusing the REST views (`toEntityView`) for shape parity.

## 7. Security & tenant isolation

- Every tool derives `tenantId` from the authenticated API key only — never from a tool
  argument — so a client cannot act for another tenant.
- `onboard_agent` forces `spec.roles.guardian = tenantId` (same as `POST /onboard`).
- `PasskeyStore.get`/`repo.find` are tenant-checked; a handle/entity from another tenant is a
  not-found error.
- Revoked or unknown keys → 401 before any tool runs.
- API keys: hash-at-rest, plaintext shown once, revocable.

## 8. Testing (mirrors existing patterns; runs under the new CI)

- **Unit:** `ApiKeyStore` (mint/verify/revoke, hash-at-rest, revoked rejected),
  `PasskeyStore` (store/get/tenant-scope), each tool with fake deps (the `runJobDeps` fake-graph
  style), `mcpAuth` (missing/unknown/revoked/valid).
- **Integration (`*.int.test.ts`, anvil):** drive `/mcp` with a real MCP client over the
  Streamable HTTP transport + a Bearer key, full `onboard_agent → poll get_entity` to `bound`,
  reusing the existing anvil mock-deploy harness.
- **Tenant isolation:** key A cannot `get_entity`/`list_entities` tenant B's records; a passkey
  handle minted by A is invisible to B.
- **REST:** `POST /api-keys` returns plaintext once + `GET` never leaks it; `POST /passkey`
  round-trips to a usable handle.

## 9. Config & docs

- No new secret env required (sha-256 needs no key). Optional `MCP_PATH` (default `/mcp`).
- `backend/README` section: (1) sign in to the wizard, mint a key (`POST /api-keys`);
  (2) capture the guardian passkey in the browser, `POST /passkey` → handle; (3) add the server
  to Claude/Cursor (`mcp.json` snippet: URL + `Authorization: Bearer` header); (4) example
  conversational flow (read `schema://agent-spec` → `onboard_agent` → poll `get_entity`).

## 10. Out of scope (v1)

- Job/reputation (Track C) and payment (`authorize_payment`/`agent_ask`) MCP tools.
- OAuth / MCP authorization-server flows (static Bearer API key only).
- Stateful MCP sessions / server-initiated notifications.
- REST `POST /onboard` accepting a `passkeyId` (stays inline-only).
- A second deployable process for MCP (explicitly co-located).

## 11. Deliverables

1. `backend/src/composition.ts` (`buildBackend`) + `api/main.ts` slimmed to use it.
2. `api_keys` + `passkeys` migrations; `ApiKeyStore`, `PasskeyStore`.
3. REST routes: `/api-keys` (×3), `POST /passkey`.
4. `backend/src/mcp/` — `auth.ts`, `server.ts`, `transport.ts`; `/mcp` mounted on the app.
5. `@modelcontextprotocol/sdk` dependency (pinned).
6. Tests (unit + int + isolation) and the README section.
