# Onboarding Wizard REST API — Design (Track A)

> Status: design approved 2026-06-21. Part of the Circle grant backend roadmap
> (`docs/plans/2026-06-21-grant-backend-roadmap.md`), **Track A**. This is Phase 3's
> backend face. The web wizard frontend is a colleague's deliverable and is **out of scope**.
> Next step after spec review: writing-plans → implementation on branch
> `feat/onboarding-wizard-api` (PR to master).

## 1. Context & goal

The onboarding "brain" (idempotent, resumable saga + Arc/Turnkey adapters) is built and
live-proven (Phase 2). It is currently driven by a CLI and a single `POST /onboard` slice.
Track A turns it into a **clean, documented, multi-tenant REST API** that a separate web
wizard (built by a colleague) connects to, so a human controller can sign in and onboard /
monitor their agent legal bodies through a browser.

This is a **new face over the same brain** — no changes to smart contracts or the saga's
core logic. We add: SIWE auth, tenant ownership of entities, background (async) execution of
onboarding with status polling, and a typed contract artifact for the frontend.

### Existing pieces we build on
- `backend/src/onboarding/server.ts:40` — `buildOnboardingApp(deps)`, the current `POST /onboard`.
- `backend/src/onboarding/main.ts` — composition root wiring config, db, persistence, Arc
  adapter, Turnkey provisioning, operator signer, saga.
- `backend/src/workflow/onboarding.ts:60` — `runOnboarding(...)`, the resumable saga
  (steps: provision vault → translate → generate OA → createEntity → setAgentWallet bind → fund).
- `backend/src/policy/agentSpec.ts:46` — Zod `AgentSpec` schema (validation + field errors).
- `backend/src/persistence/{db,entityRepository,documentStore}.ts` — SQLite + file doc store.
- `backend/src/types.ts` — `EntityRecord`.

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Tenant model | **Individual controller** (1 tenant = 1 natural person) | Matches the natural-person-controller legal gate; simplest tenancy. |
| Auth | **SIWE (Sign-In with Ethereum)** | Login wallet = the on-chain guardian EOA → the person who logs in is the accountable on-chain controller. Minimal, audience-appropriate. |
| Session | **Short-lived Bearer JWT** (~30–60 min), re-auth via SIWE on expiry | Stateless, CORS-simple, easiest SPA integration; no session store. Cookies are a documented production upgrade. |
| Onboarding execution | **In-process background + poll** | The saga is already idempotent/resumable and persists status; fits single-process Hono+SQLite; least infra. |
| Guardian identity (v1) | **Auto-set guardian = login wallet** (not client-supplied) | Keeps login↔on-chain-controller binding airtight; removes a mismatch class. Selectable guardian deferred. |

## 3. Architecture

Long-running Node/Hono HTTP API in `backend/`, three layers over the existing brain:

1. **Auth (SIWE → JWT)** — nonce challenge, signature verify, JWT issue; middleware resolves
   `tenantId` (= wallet address) from the Bearer token.
2. **Tenancy** — every entity carries `ownerTenantId`; all API reads/writes are tenant-scoped.
3. **REST + async execution** — thin handlers over the saga; `POST /onboard` returns 202 and a
   background runner drives `runOnboarding`; a startup reconciler resumes in-flight entities.

Reuses the existing composition root for the real dependency wiring (one brain, new face).

## 4. Module layout

```
backend/src/
  auth/
    siwe.ts         # nonce issue + EIP-4361 message verify (viem verifyMessage / siwe lib)
    session.ts      # JWT sign/verify; payload { sub: address, iat, exp }
    middleware.ts   # Bearer -> verify -> attach tenantId; 401 on failure
  api/
    app.ts          # buildApiApp(deps): CORS + error envelope + mount public/protected routes
    routes/
      auth.ts       # GET /auth/nonce, POST /auth/verify, GET /healthz
      onboard.ts    # POST /onboard, GET /entities, GET /entities/:id, POST /entities/:id/fund
      passkey.ts    # GET /passkey/challenge
    errors.ts       # standard error envelope + code->status mapping
    views.ts        # EntityRecord -> EntityView (secret-free projection)
  workflow/
    runner.ts       # startOnboarding (persist+202+background) + reconcileInFlight() for startup
```

Persistence changes (`persistence/`):
- `db.ts` migration: add `ownerTenantId TEXT` to the entities table; add `auth_nonces` table
  (`nonce TEXT PRIMARY KEY, issuedAt INTEGER, expiresAt INTEGER`).
- `entityRepository.ts`: persist `ownerTenantId` on create; add `listByTenant(tenantId)` and
  `getByKeyForTenant(key, tenantId)`. Existing all-tenant reads remain for the reconciler.

## 5. API surface

### Public
- `GET /auth/nonce` → `200 { nonce }`. Stores nonce with short TTL.
- `POST /auth/verify` `{ message, signature }` → `200 { token, address, expiresAt }`.
  Verifies the SIWE message (domain, nonce present+unexpired+unconsumed, chainId, issuedAt/
  expirationTime), recovers the address, consumes the nonce (one-time), issues the JWT.
  Errors: `401 unauthorized` (bad sig / bad/expired/replayed nonce).
- `GET /healthz` → `200`.

### Protected (require `Authorization: Bearer <jwt>` → `tenantId`)
- `GET /passkey/challenge` → `200 { challenge, rpId }`. Challenge for the browser WebAuthn
  registration ceremony. (Turnkey sub-org creation is a WebAuthn *registration*; the
  attestation is replayable / not freshness-checked — see the per-agent-vault notes — so the
  challenge just needs to be consistently embedded in clientDataJSON.)
- `POST /onboard` `{ spec, guardianPasskey, idempotencyKey? }` → `202 { id, status }`.
  Validates `spec` (Zod). Server sets `spec.roles.guardian = tenant`; if the client supplies a
  differing guardian → `400 validation_error`. Persists `EntityRecord` (`status=translating`,
  `ownerTenantId=tenant`), returns immediately, kicks the background runner.
  `idempotencyKey` is **scoped per tenant** (see §8) so two controllers can reuse the same name.
  Errors: `400 validation_error`, `409 conflict` (this tenant's idempotencyKey already in-flight).
- `GET /entities` → `200 EntityView[]` (tenant-scoped).
- `GET /entities/:id` → `200 EntityView` | `404 not_found` (not owned by tenant).
- `POST /entities/:id/fund` `{ amount }` → `202 { id, status }`. Tenant-scoped; runs
  `fundTreasury` (background). `404` if not owned.

### EntityView (secret-free projection of EntityRecord)
`{ id (idempotencyKey), name, status, agentId, proxy, treasury, operator, manager, guardian,
oaHash, metadataURI, createTxHash, bindTxHash, fundTxHash, error?, createdAt, updatedAt }`.
Never exposes Turnkey ids, doc paths, or secrets.

## 6. Data flow

1. **Login.** `GET /auth/nonce` → frontend builds an EIP-4361 message with the nonce → wallet
   signs → `POST /auth/verify {message, signature}` → JWT (`tenantId = wallet address`).
2. **Onboard.** `GET /passkey/challenge` → browser `navigator.credentials.create()` produces the
   guardian attestation → `POST /onboard {spec, guardianPasskey}` (Bearer). Server validates,
   sets guardian = tenant, persists `translating`, returns `202 {id, status}`. Background runner
   drives the saga (provision → translate → createEntity → bind → fund), persisting each status.
3. **Poll.** Frontend polls `GET /entities/:id` (~2–3 s) until a terminal status
   (`bound` / `funded` / `failed`). `failed` carries `error`.

## 7. Auth & identity specifics
- `tenantId` = checksummed wallet address recovered from the SIWE signature.
- JWT: HS256 signed with `AUTH_JWT_SECRET`; payload `{ sub: tenantId, iat, exp }`; TTL from
  `AUTH_JWT_TTL` (default 60 min). Stateless verification in middleware.
- SIWE nonce is single-use (consumed on verify) and short-lived (TTL, e.g. 10 min) → replay-safe.
- The login wallet is auto-used as the on-chain guardian (`spec.roles.guardian`). `manager`
  stays the platform key (Factory owner); `operator` = the per-agent Turnkey enclave key. So:
  tenant = guardian, platform = manager, agent vault = operator.

## 8. Async execution & recovery
- `startOnboarding(deps, {spec, idempotencyKey, tenantId, guardianPasskey, fundAmount})`:
  persist initial `EntityRecord` → return id → schedule `runOnboarding` fire-and-forget
  (`queueMicrotask`/`setImmediate`) wrapped in try/catch that on error sets `status=failed`,
  `error=message`.
- **Tenant-scoped idempotency key:** entities are uniquely identified by
  `(ownerTenantId, idempotencyKey)`, not `idempotencyKey` alone, so two controllers can both
  name an agent "MyAgent" without colliding. The entities table migrates from an
  `idempotencyKey` primary key to a composite `(ownerTenantId, idempotencyKey)` key; all API
  lookups pass both. The user-facing `:id` in routes is the `idempotencyKey`, resolved within
  the caller's tenant scope.
- **In-process concurrency guard:** an in-memory in-flight set keyed by
  `(tenantId, idempotencyKey)` prevents a double runner within one process. Cross-process locking is out (single-process v1);
  documented. (Relates to the `docs/V2_HARDENING_BACKLOG.md` key-claim-lock item.)
- **`reconcileInFlight()`** on startup: find entities in non-terminal statuses
  (`provisioned`/`translating`/`created`/`bound`) and re-invoke `runOnboarding` (idempotent →
  resumes). This is the restart-recovery mechanism.

## 9. Error handling
- Envelope: `{ error: { code, message, details? } }`.
- Codes → HTTP: `validation_error` 400 (Zod field errors in `details`), `unauthorized` 401,
  `forbidden` 403, `not_found` 404, `conflict` 409, `upstream_error` 502, `internal_error` 500.
- Background saga failures are persisted on the entity (`status=failed`, `error`) and surfaced
  via `GET /entities/:id`. (Optional, deferred: `POST /entities/:id/retry` to resume.)

## 10. Testing
- **Unit:** SIWE verify (valid; bad signature; missing/expired/replayed nonce; wrong
  domain/chainId); JWT middleware (valid/expired/missing/garbage → 401); error mapping;
  repo tenant-scoping (`listByTenant`/`getByKeyForTenant`).
- **Integration (anvil harness, reused):** login → onboard → poll to `bound` → list;
  tenant isolation (tenant B `GET`s tenant A's entity → 404); `reconcileInFlight` resumes a
  mid-flight entity after a simulated restart.
- **Live** Turnkey/Arc paths gated by env flags (existing `ARC_E2E` / Turnkey opt-in pattern).

## 11. Frontend integration contract (for the colleague)
- Config: `WEB_ORIGIN` (CORS allow-list), base URL.
- Auth: nonce → sign → verify → store JWT in memory → send `Authorization: Bearer`.
- **OpenAPI/JSON-schema generated from the Zod `AgentSpec`** (e.g. `zod-to-json-schema` or
  `@hono/zod-openapi`), served at `GET /openapi.json` and/or committed, so the wizard gets a
  typed request shape.
- Polling guidance: poll `GET /entities/:id` every ~2–3 s until terminal status.
- A documented endpoint table + example requests in `backend/README`.

### New config keys
`AUTH_JWT_SECRET`, `AUTH_JWT_TTL`, `WEB_ORIGIN`, `SIWE_DOMAIN`, `PASSKEY_RP_ID` (defaults sane
for local dev).

## 12. Scope / YAGNI (explicitly OUT of v1)
Orgs/teams; billing; email/notifications; admin UI; JWT refresh-token rotation; websockets/SSE
(polling suffices); guardian gas funding for on-chain pause; rate limiting beyond a basic per-IP
guard on the auth routes; the MCP server (Track B); ERC-8183 proof-of-life (Track C).

## 13. Open items / future
- Passkey login + selectable guardian key (multisig/hardware) — future UX upgrade.
- httpOnly-cookie session option for production hardening.
- Durable job queue if onboarding volume outgrows in-process execution.
- `POST /entities/:id/retry` for failed sagas.
