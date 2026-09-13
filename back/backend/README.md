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

## Hedera rail (ETHOnline 2026)

Novi Corpus adds a second, flag-gated payment rail on Hedera testnet, built for ETHGlobal
ETHOnline 2026's "AI & Agentic Payments on Hedera" track. Where the Arc rail settles through
Circle, the Hedera rail prices `GET /verify/:publicId`, a paid legal-standing check, in HTS USDC
and settles it through x402 v2 and the Blocky402 facilitator. The Arc rail is untouched; with the
flag off, nothing in this section exists at runtime.

Custody is self-custody with a leash. Your agent runtime holds its own Hedera key and signs every
payment locally; the Novi Corpus server never holds or sees that key. A human guardian co-owns the
float account through a 1-of-2 key list, so the guardian can rotate the agent key out at any time
(`revoke`). The policy gate is enforced by the client and the float, not by the server: before
paying, the client asks `check_policy`, and a deny stops the payment before anything is signed.

### Enable it

Set `HEDERA_ENABLED=1` and the rest of the block (the commented `HEDERA_*` lines in
`.env.example`). The block is all-or-nothing: if any required variable is missing, the server
refuses to boot rather than start half-configured.

| Variable | Value | Notes |
|---|---|---|
| `HEDERA_ENABLED` | `1` or `true` | Turns the whole block on. |
| `HEDERA_NETWORK` | `testnet` | The only accepted value; this build is testnet only. |
| `HEDERA_FACILITATOR_URL` | `https://api.testnet.blocky402.com` | The Blocky402 testnet facilitator. |
| `HEDERA_MIRROR_URL` | `https://testnet.mirrornode.hedera.com` | Read-only settlement confirmation. |
| `HEDERA_USDC_TOKEN_ID` | `0.0.429274` | HTS USDC, 6 decimals. |
| `HEDERA_PAYTO_ACCOUNT_ID` | your pay-to account | Where `/verify` payments land. Must be associated with the USDC token. |
| `HEDERA_VERIFY_PRICE_USDC` | `0.001` (default) | Price of one `/verify` call. |

### MCP tools (require an API key with the `spend` capability)

| Tool | Input | Description |
|---|---|---|
| `link_hedera_account` | `id`, `accountId`, `publicKey` | Record the entity's float account. The server reads the account from the mirror node and accepts only a 1-of-2 key list of two ECDSA keys, one equal to `publicKey`; the other is recorded as the guardian key. |
| `check_policy` | `id`, `payee`, `amountUsdc`, `network` | Answer `{ ok: true, available }` or `{ ok: false, reason }` (`paused`, `over-cap`, `not-linked`, `legal-not-active`, and so on) from the float account's USDC balance, the entity's caps, the guardian pause on Arc and the payee allowlist. The allowlist is read live from Arc; an unreadable state never allows. |
| `report_payment` | `id`, `payee`, `amountUsdc`, `network`, `transactionId`, `idempotencyKey` | Turn a settled transaction into a ledger row. Answers `{ status: settled }` only after the mirror node shows the USDC transfer on both legs; `pending` while the mirror node lags; `failed` with a reason otherwise. |

### How `/verify` is paid

`GET /verify/:publicId` is public and unauthenticated, but paid. A request without a payment
header gets a 402 with the price and payment requirements in the `PAYMENT-REQUIRED` header. Your
client signs a payment with its own Hedera key and resubmits; the facilitator verifies and settles
the USDC transfer on Hedera testnet and pays the network fee, so the float account needs no HBAR.
Novi Corpus does not trust the facilitator's reply alone: it reads the transaction back from the
mirror node with the USDC token pinned on both legs, and only then records the ledger row
(`network = hedera:testnet`, `batch_ref = <mirror transaction id>`) and serves the attestation
body (subject, standing, formation, controller flag, operating-agreement hash and version,
`issuedAt`, `expiresAt`). The body is unsigned in this pull request; the signature is the next one.

V2 note: the client signs whatever asset and amount the 402 names, and `check_policy` never sees
the asset. Pin the asset in the client before pointing it at a server you do not run.

### Run the client

The customer-side commands live in `back/hedera-client` (package `@novicorpus/hedera-client`,
bin `novi-hedera`). Run them as `op run --env-file=.env.tpl -- npx tsx src/cli.ts <command>` so
secrets resolve from 1Password into the child process only (the template lists item titles, never
values).

- `provision` creates the float account (the guardian funds it with USDC), sets its 1-of-2 key
  list while the account is still hollow, and sets the account memo. `--memo-only` re-sets the memo.
- `link` records the provisioned account with Novi Corpus by calling `link_hedera_account`.
- `revoke` rotates the agent's key out from the guardian, the on-chain kill switch.
- `pay <url>` asks `check_policy`, pays a Novi Corpus x402 route, and reports the settlement.

### Live run, 2026-09-12 (testnet)

Recorded in the plan (`docs/plans/2026-09-10-hedera-rail.md`, task 8) against a local backend
holding one seeded row of `FormationE2E_1`'s public data:

- `provision` set the 1-of-2 key list on float account `0.0.10450558`; `link` answered `ok: true`.
- `pay` on `/verify/9f8003f5-4c70-435a-9980-9a54625691b7` settled 0.001 USDC to `0.0.10412694`
  on the first try: [HashScan 0.0.7162784@1789178320.131369376](https://hashscan.io/testnet/transaction/0.0.7162784@1789178320.131369376),
  `CRYPTOTRANSFER SUCCESS`, fee paid by the facilitator; `report_payment -> settled`; ledger row
  `hedera:testnet|settled|0.0.7162784-1789178320-131369376|1000`.

### Demo-only, do not run in production

These exist only for the ETHOnline 2026 demo. Each refuses to run unless `HEDERA_DEMO_LOCAL=1` is
set, refuses outright when `NODE_ENV=production`, and prints `DEMO ONLY` as its first line.

- `scripts/demo/seed-public-entity.mts --from-prod <publicId> --tenant <address>` seeds one local
  database row from a production entity's public data (`/transparency` plus factory reads on Arc),
  so pre-merge checks run locally without touching real data. Set `FACTORY_ADDRESS` to the
  production factory the entity was created by.
- `novi-hedera demo-buyer <uaid>` will resolve a Novi Corpus company from its universal agent id
  and pay `/verify` against it end to end, the flow the demo video walks through. In this pull
  request it is a guarded stub that refuses and points at `pay <url>`; the buyer lands with the
  third pull request. Guarded even though it targets the deployed backend.

## v2 hardening
Known production-hardening items (crash-safety, concurrency, Turnkey, etc.) are tracked in
`../docs/V2_HARDENING_BACKLOG.md`. None block the testnet demo.
