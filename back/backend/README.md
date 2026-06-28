# Agent Legal Body — Backend ("the brain")

Framework-agnostic TypeScript backend that onboards an AI agent into an on-chain legal body on Arc:
generate operating agreement → register ERC-8004 identity → deploy + wire LegalManager + AgentTreasury
via the Factory (one atomic tx) → bind the agent wallet → persist. CLI-driven, fully tested.

## Prerequisites
- Node >= 20.18.2, npm. Foundry (forge/anvil) on PATH for integration tests.
- Contracts deployed to Arc testnet (see `../script/Deploy.s.sol` and `../addresses.arc-testnet.json`).

## Setup
    cp .env.example .env     # fill PLATFORM_PRIVATE_KEY, FACTORY_ADDRESS, GUARDIAN_ADDRESS, OPERATOR_PRIVATE_KEY
    npm install
    npm run gen:abis         # regenerate typed ABIs after any `forge build`

## Test
    npm test                                              # unit + anvil integration (live tests skipped)
    ARC_E2E=1 npx vitest run test/e2e.arc.live.test.ts   # live Arc testnet (spends USDC gas)

## CLI
    npm run cli -- create-entity --config agent.example.json --id agent-1
    npm run cli -- create-entity --config agent.example.json --id agent-1 --fund 50.00
    npm run cli -- get-entity agent-1
    npm run cli -- list-entities
    npm run cli -- fund-treasury agent-1 25.00

## Roles (v1)
- **manager**  = platform key (Factory owner; sends `createEntity` + `setAgentWallet`). `PLATFORM_PRIVATE_KEY`.
- **guardian** = human registrant address (on-chain pause/veto/rescue). `GUARDIAN_ADDRESS`.
- **operator** = the agent's spending key; **signs** the EIP-712 `AgentWalletSet` (bound as `agentWallet`).
  `OPERATOR_PRIVATE_KEY` in v1 (`LocalKeySigner`); a Turnkey enclave key in production (`TurnkeySigner`, M4.3).

The operator **signs** the bind; the manager **sends** the tx. The operator key never sends gas.

## Live Arc-testnet E2E — runbook
1. `PLATFORM_PRIVATE_KEY` must be the **Factory owner** key (`createEntity` is `onlyOwner`) and be **funded
   with Arc-testnet USDC** (USDC is the gas token on Arc). The deployed owner is recorded in
   `../addresses.arc-testnet.json`; faucet: <https://faucet.circle.com>.
2. `OPERATOR_PRIVATE_KEY` can be a throwaway — it only signs, never sends gas, never holds funds.
3. `GUARDIAN_ADDRESS` is any address distinct from manager/operator.
4. Run: `ARC_E2E=1 npx vitest run test/e2e.arc.live.test.ts` (optionally `ARC_E2E_TAG=<label>` for a stable
   idempotency key). Asserts the entity reaches `bound` and `getAgentWallet(agentId) == operator`.

The off-chain EIP-712 domain + `AgentWalletSet` typehash are verified against the live registry, so the
bind signature is correct by construction (no "bad signature" surprise).

## Wizard REST API (`npm run api`, default :8789)

Multi-tenant onboarding API for the web wizard. Tenant = controller wallet (SIWE login).

### Auth (SIWE → Bearer JWT)
1. `GET /auth/nonce` → `{ nonce }`
2. Build an EIP-4361 message with the nonce, sign with the wallet.
3. `POST /auth/verify { message, signature }` → `{ token, address, expiresAt }`
4. Send `Authorization: Bearer <token>` on protected routes. Re-auth on expiry.

### Config keys
| Key | Default | Notes |
|---|---|---|
| `AUTH_JWT_SECRET` | `dev-insecure-secret-change-me-please` | Min 16 chars. **Change in production.** |
| `AUTH_JWT_TTL_SEC` | `3600` | JWT lifetime in seconds |
| `WEB_ORIGIN` | `*` | CORS allowed origin |
| `SIWE_DOMAIN` | `localhost` | EIP-4361 domain |
| `PASSKEY_RP_ID` | `localhost` | WebAuthn RP ID |

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

## MCP Server (Claude / Cursor)

The API (`npm run api`) also serves `/mcp` as a Model Context Protocol server, exposing agent onboarding
and management tools to Claude/Cursor.

### Setup

1. **Run the API** (same server, no new service):
   ```bash
   npm run api  # listens on :8789
   ```

2. **Sign in (SIWE) and mint an MCP key:**
   - `GET /auth/nonce` → `{ nonce }`
   - Sign the message with your wallet
   - `POST /auth/verify { message, signature }` → `{ token, address, expiresAt }`
   - `POST /api-keys` with `Authorization: Bearer <JWT token>` → `{ id, key, label }` — **copy the `key`** (shown once)

3. **Capture the guardian passkey in your browser:**
   - `GET /passkey/challenge` → `{ challenge, rpId }` — use these for WebAuthn registration
   - Perform the WebAuthn ceremony in your browser
   - `POST /passkey` with `Authorization: Bearer <JWT token>` and the attestation → `{ id }` — **copy the `id`** (handle)

4. **Add the server to Claude/Cursor:**
   Create or edit `~/.claude/mcp.json` (Claude CLI) or `.cursor/rules/mcp.json` (Cursor):
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
   Replace `<your-host>` with the deployed/local URL and `<your-key>` with the key from step 2.

### Tools

| Tool | Input | Description |
|---|---|---|
| `whoami` | (none) | Return the authenticated tenant address |
| `list_entities` | (none) | List all agent legal bodies owned by the caller |
| `get_entity` | `id` (idempotency key) | Fetch one entity; poll after `onboard_agent` until status is `bound` |
| `onboard_agent` | `spec` (object), `passkeyId` (handle from step 3), `idempotencyKey?` (optional) | Create an agent legal body; guardian is automatically set to the caller |
| `fund_treasury` | `id` (idempotency key), `amount` (atomic USDC, 6 decimals as string) | Fund a bound entity's treasury |

### Resources

| Resource | URI | Description |
|---|---|---|
| `agent-spec` | `schema://agent-spec` | JSON Schema for `onboard_agent`'s `spec` argument |

### Example Flow

1. Read `schema://agent-spec` to understand the required entity structure
2. Call `onboard_agent` with your agent spec and guardian passkey handle → returns `{ id, status: "pending" }`
3. Poll `get_entity` with the returned `id` (~2–3 s) until `status` reaches `bound` (or `failed`)
4. Call `fund_treasury` with `id` and amount to top up the treasury (atomic USDC)
5. Call `list_entities` to review all owned legal bodies

## v2 hardening
Known production-hardening items (crash-safety, concurrency, Turnkey, etc.) are tracked in
`../docs/V2_HARDENING_BACKLOG.md`. None block the testnet demo.
