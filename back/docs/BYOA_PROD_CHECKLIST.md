# BYOA — Prod Deploy + Test Checklist

State as of 2026-07-03: `main` = P0–P4 + full-audit hardening fixes + frontend. Backend green (497 tests).
This is the runbook to get it live on the VPS and smoke-test each face. Full env template:
`back/docs/VPS_DEPLOY.md`. Backend runs on the VPS (SQLite); frontend on Vercel.

## 1. Deploy the backend (VPS)
```bash
# on the VPS, in the repo
git pull origin main
cd back/backend && npm install        # tsx is a runtime dep
sudo systemctl restart legalbody-api  # migrations auto-apply on boot (idempotent)
```
New migrations that apply automatically: `payments_ledger.entity_key`, `link_codes`, `payment_idempotency`,
plus the P0–P2 columns. All `CREATE TABLE IF NOT EXISTS` / PRAGMA-guarded `ALTER` — safe on the existing DB.
Verify: `curl https://api.<domain>/healthz` → `{"ok":true}`; `curl https://api.<domain>/mcp` → 401.

## 2. Prod `.env` — the vars that gate each face
`NODE_ENV=production` makes the server fail-closed. Grouped by what they unlock:

| Var | Gates | Note |
|---|---|---|
| **`POCKET_MASTER_SEED`** | `pay`, `fund_pocket` | 32-byte hex, secret. Unset → both tools report "unavailable". **Most likely not set yet.** |
| **`MCP_PUBLIC_URL`** | the URL agents paste | set to `https://api.<domain>/mcp` (default is localhost) |
| `SIWE_DOMAIN` + `PASSKEY_RP_ID` | Connect + agent-first bootstrap | the real domain — wrong values make SIWE + passkey **silently fail** |
| `AUTH_JWT_SECRET` (real), `WEB_ORIGIN` (explicit) | all authed routes | prod refuses to boot on the dev defaults / `*` |
| Turnkey vars + `FACTORY_ADDRESS` | `onboard_agent`, `fund_treasury`, `fund_pocket` | operator signing + the factory contract |
| `JOB_EVALUATOR_PRIVATE_KEY` (+ client/`PLATFORM_PRIVATE_KEY`) | `run_job` | platform stands in for client+evaluator |
| `MAX_JOB_BUDGET_USDC` (def 5), `MAX_INFLIGHT_JOBS_PER_TENANT` (def 3) | `run_job` drain guard | tune if desired |
| `MAX_TREASURY_FUND_USDC` (def 25), `MAX_TREASURY_FUNDED_PER_TENANT_USDC` (def 100) | `fund_treasury` drain guard | per-call cap + per-tenant lifetime quota on platform→treasury funding; tune if desired |
| `SPEND_ALLOWLIST_THRESHOLD_USDC` (def 1), `FUNDING_FLOAT_USDC` | pay policy / float | have defaults |

**Capability note (post-S1):** `onboard_agent` and `fund_treasury` now require the **`provision`** capability,
not `spend` — `spend` only covers `pay`. Mint (or bootstrap) a `provision` key for any flow that provisions a
new entity or platform-funds a treasury; existing effective-`spend` keys were promoted to `provision` once by
a one-shot migration on deploy, so nothing already live breaks.

`ARC_TESTNET_RPC_URL` is the only strictly-required-no-default; contract addresses + Gateway URL have testnet
defaults. `chmod 600 .env`.

## 3. Frontend (Vercel — coordinate with the FE dev)
Set `NEXT_PUBLIC_API_URL` (+ `NEXT_PUBLIC_MCP_URL`) to the backend, or wire the `/backend` proxy to it. The FE
client already calls the real routes (`/auth`, `/passkey`, `/onboard`, `/entities/*`, `/api-keys`, `/jobs`, …).
Note: the FE mints keys via `/api-keys`; the newer `/connection-package` + snippet "Connect" screen and the
P3 bootstrap screen are still a future FE task (backend for both is live).

## 4. Fund + smoke-test each face
1. **Health:** `/healthz` → ok; `/mcp` → 401.
2. **Onboard** (frontend or `onboard_agent`, needs a `provision` key): needs Turnkey + `FACTORY_ADDRESS`. Poll
   `get_entity` → `bound`.
3. **fund_treasury** (needs a `provision` key) → **treasury_status** (`available` reflects it; re-funding now
   works repeatedly, up to the per-call/per-tenant caps above).
4. **fund_pocket** → **treasury_status** (`float` reflects it). Costs ~2 Turnkey sigs.
5. **run_job** → **get_job** (agent earns USDC + reputation; bounded by `MAX_JOB_BUDGET_USDC`).
6. **pay** an x402 URL → settles from the pocket float (returns `insufficient-float` if the float is low →
   run `fund_pocket` first).
7. **Agent-first:** `POST /bootstrap-connection { "capability": "provision" }` → paste key + linkCode into an
   agent → `claim_connection` → `onboard_agent` (server owns `manager`, so the agent's spec doesn't need it) →
   operate.

## 5. Gotchas
- **SIWE/passkey are domain-bound** — a domain mismatch fails silently; match FE + BE exactly.
- **Turnkey dev tier** has a lifetime signing limit — minimize sigs while testing (each fund_pocket / onboard
  costs a few).
- **Legacy ledger rows** (if any pre-migration `payments_ledger` rows exist) get `entity_key=NULL` and drop
  out of `runningPending` — negligible for a fresh pay-enable.
- **Rotate the Anthropic key** after the hackathon (was pasted in chat earlier; only on the VPS `.env`).

## Deferred (post-prod, tracked)
Tier-2 hardening from the audit (`whoami` self-discovery, `treasury_status` enrichment, per-`pay`/`fund` audit
events, config-guard warnings, exact float-atomic conversion, terminal-status shared constant); the standalone
HTTP-authority `ledgerId` gap; a CI retry for the flaky `forge install`. See
`back/docs/audit/2026-07-03-byoa-full-audit.md`.
