# Circle Grant — Backend Roadmap (Phase 3 + Phase 4)

> Locked 2026-06-21. Scope decision: **entire grant backend** — Phase 3 REST API + MCP
> server + Phase 4 ERC-8183 proof-of-life. Integration model: **multi-tenant + auth**.
> The web wizard frontend is a colleague's deliverable and is **out of scope** here; this
> roadmap covers only the backend faces a frontend connects to.
>
> Grounded in the backend code map (2026-06-21). Existing pieces are noted so we extend
> rather than rebuild. Per [[git-collaboration-workflow]]: feature branch + PR, rebase on
> origin/master. Rotate the Turnkey key / use throwaway sub-orgs before any public carve-out.

## Decisions to lock before code (per track)
- **Auth mechanism** — guardians already hold WebAuthn passkeys/wallets, so wallet-based
  (SIWE) or passkey-as-login is a natural fit vs. email+JWT. Leaning wallet/passkey-based.
- **Onboarding is async** — on-chain `createEntity`/`setAgentWallet` take time. Lean:
  `POST /onboard` returns immediately; the wizard polls `GET /entities/:id` through the
  saga's existing status states (`provisioned → translating → created → bound → funded`).
  Needs a background runner.
- **Phase 4 "work"** — what the agent actually does to fulfill an ERC-8183 job (reuse the
  insight agent, or a trivial deliverable for proof-of-life).

---

## Track A — Phase 3: Wizard REST API (multi-tenant + auth)
Goal: a clean, documented HTTP surface the frontend wizard builds against.
Existing entry: `backend/src/onboarding/server.ts:40` (`POST /onboard`), saga
`backend/src/workflow/onboarding.ts:60`, spec `backend/src/policy/agentSpec.ts:46`.

### A1. Tenancy + auth foundation
- [ ] Pick + implement auth (SIWE/passkey vs JWT) → `auth` middleware resolving a `tenantId`
- [ ] Add `tenants`/`users` table + `ownerTenantId` column on entities; migration in `persistence/db.ts`
- [ ] Tenant-scope all reads/writes in `persistence/entityRepository.ts`
- [ ] Address single-runner/key-claim concurrency (now real with multiple tenants) — see `docs/V2_HARDENING_BACKLOG.md`

### A2. REST surface over the brain
- [ ] Make `POST /onboard` async + tenant-scoped (return `idempotencyKey`+`status`; run saga in background)
- [ ] `GET /entities` — list, tenant-scoped (wraps `list-entities`)
- [ ] `GET /entities/:id` — status/detail for wizard progress polling (wraps `get-entity`)
- [ ] `POST /entities/:id/fund` — wraps `fund-treasury`
- [ ] Standardize error envelope; keep Zod field-level validation errors (400)
- [ ] CORS for the frontend origin; basic rate limiting

### A3. Browser passkey flow (today local-only: `backend/tools/passkey-capture/`)
- [ ] `GET /passkey/challenge` — issue + persist a WebAuthn challenge
- [ ] Endpoint to receive the browser attestation → feed as `guardianPasskey` into provisioning

### A4. Frontend contract artifacts
- [ ] Generate OpenAPI/JSON-schema from the Zod `AgentSpec` so the colleague gets a typed client
- [ ] Document every route (req/resp shapes) for handoff

### A5. Quality
- [ ] anvil integration tests for the HTTP routes incl. auth + tenant isolation
- [ ] `backend/README` section: run instructions + example requests

---

## Track B — Phase 3: MCP server (thin face)
Goal: same brain, exposed as MCP tools for Claude/Cursor. None exists yet.
- [ ] Scaffold MCP server (`@modelcontextprotocol/sdk`) in `backend/src/mcp/`, reusing the HTTP composition root
- [ ] Tools: `onboard_agent`, `get_entity`, `list_entities`, `fund_treasury` (+ optionally `authorize_payment`, `agent_ask`)
- [ ] Per-tenant auth for MCP (API key → tenantId)
- [ ] Tests + setup docs (adding the server to Claude/Cursor)

---

## Track C — Phase 4: Autonomous ERC-8183 proof-of-life
Goal: agent accepts a job → escrow → delivers → settles real USDC → reputation.
Interface exists (`src/interfaces/IERC8183Job.sol`, live `0x0747…4583`); no backend orchestration yet.
- [ ] Verify live ERC-8183 + ERC-8004 ReputationRegistry (`0x8004B663…`) ABIs/domains against chain before wiring
- [ ] Arc adapter bindings: read jobs + `createJob`/`fund`/`submit`/`complete` via viem (non-custodial signer)
- [ ] Job-execution orchestration: accept job → perform work → `submit()` deliverable
- [ ] Settlement: on validation, `complete()` releases USDC to the agent wallet
- [ ] Record reputation entry on ERC-8004 ReputationRegistry
- [ ] Persist job state; expose a trigger/observe path (CLI + HTTP route + MCP tool)
- [ ] anvil tests + opt-in live Arc-testnet run (env-gated, like `ARC_E2E`)

---

## Execution order
1. **Track A** first (unblocks the frontend colleague). ← starting here
2. Track B (MCP) — reuses Track A's composition root.
3. Track C (Phase 4 proof-of-life).
