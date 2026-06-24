# Backend VPS Deployment — Runbook (SQLite)

Deploy the onboarding backend ("the brain") to a single VPS, keeping **SQLite** as the database.
Written 2026-06-22. Decision: SQLite stays — on one persistent box it's a real, durable DB and needs
**zero code changes** (see `back/docs/V2_HARDENING_BACKLOG.md` for the multi-instance story if that ever changes).

> 📂 **Monorepo path:** the backend lives at **`back/backend/`** inside the
> [Project-Alpha](https://github.com/jb1011/Project-Alpha) monorepo. All `/opt/legalbody/...` paths below
> assume you clone the whole repo and the backend is at `<clone>/back/backend`.

---

## What this covers
A single long-lived Node process behind an HTTPS reverse proxy, with the SQLite DB + generated
documents on a persistent, backed-up volume. This is sufficient for the demo and the grant.

## Prerequisites
- A VPS (Ubuntu/Debian assumed) with a **domain name** pointing at it (needed for TLS + SIWE/passkeys).
- **Node ≥ 20.18.2** installed.
- The Arc-testnet contracts already deployed (addresses in `../addresses.arc-testnet.json`).

> ⚠️ The server runs TypeScript directly via **`tsx`** (`npm run api` → `tsx src/api/main.ts`). There is
> **no build/`dist` step.** So install **all** dependencies — do NOT use `npm ci --omit=dev` / `--production`,
> or `tsx` won't be present and the server won't start.

---

## 1. Get the code + install
```bash
git clone <Project-Alpha repo> /opt/legalbody && cd /opt/legalbody/back/backend
npm install            # full install — tsx is required at runtime
npm run gen:abis       # regenerate typed ABIs (safe; no-op if up to date)
```

## 2. Persistent data directory (DB + documents)
SQLite is a file; the operating-agreement docs are files too. Put both on a volume you back up.
```bash
mkdir -p /var/lib/legalbody/data
```
Set `DATA_DIR=/var/lib/legalbody/data` in the env (below). The backend will use:
- `${DATA_DIR}/legalbody.db` (+ `-wal` / `-shm` siblings) — the database
- `${DATA_DIR}/documents/` — generated OA / metadata files (`FileDocumentStore`)

**Back up the whole `DATA_DIR`**, not just the `.db` file (you need the documents too).

## 3. Production `.env`
Create `/opt/legalbody/back/backend/.env`. **`NODE_ENV=production` makes the server fail-closed** — it will
refuse to boot unless the security vars below are real (`config/env.ts`).

```ini
# ── Chain / contracts ──
ARC_TESTNET_RPC_URL=https://rpc.testnet.arc-node.thecanteenapp.com/v1/swrm_...   # SECRET token
ARC_CHAIN_ID=5042002
FACTORY_ADDRESS=0x...                 # from addresses.arc-testnet.json
PLATFORM_PRIVATE_KEY=0x...            # SECRET — Factory owner / manager; funded with Arc USDC

# ── Data ──
DATA_DIR=/var/lib/legalbody/data

# ── Turnkey (the consolidated org — see back/docs/TURNKEY_ORG_SWITCH.md) ──
TURNKEY_ORGANIZATION_ID=...
TURNKEY_API_PUBLIC_KEY=...
TURNKEY_API_PRIVATE_KEY=...           # SECRET
TURNKEY_SIGN_WITH=0x...               # wallet in the org (boot requirement)
TURNKEY_BASE_URL=https://api.turnkey.com
TURNKEY_DELEGATED_API_PUBLIC_KEY=...
TURNKEY_DELEGATED_API_PRIVATE_KEY=... # SECRET

# ── API security — MUST be real in production (fail-closed) ──
AUTH_JWT_SECRET=<32+ random chars>    # SECRET — NOT the dev default, or boot is refused
AUTH_JWT_TTL_SEC=3600
WEB_ORIGIN=https://app.yourdomain.com # exact frontend origin — NOT "*", or boot is refused

# ── Domain-bound auth — MUST match where the frontend is served ──
SIWE_DOMAIN=app.yourdomain.com        # EIP-4361 domain (no scheme)
PASSKEY_RP_ID=yourdomain.com          # WebAuthn RP ID (registrable domain)

# ── Optional (only if live agent/settle runs are used) ──
# ANTHROPIC_API_KEY=...
# CIRCLE_API_KEY=...
```

> 🔑 **The two easiest production mistakes:**
> 1. Leaving `WEB_ORIGIN=*` or the dev `AUTH_JWT_SECRET` → server won't boot under `NODE_ENV=production`.
> 2. `SIWE_DOMAIN` / `PASSKEY_RP_ID` not matching the real domain → **SIWE login and passkey
>    registration silently fail.** These are domain-bound by spec. Coordinate the exact values with
>    the frontend dev.

Lock the file down: `chmod 600 .env` (it holds private keys + the JWT secret + the RPC swrm token).

## 4. Run it as a service (systemd)
`/etc/systemd/system/legalbody-api.service`:
```ini
[Unit]
Description=Agent Legal Body API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/legalbody/back/backend
Environment=NODE_ENV=production
Environment=PORT=8789
ExecStart=/usr/bin/npx tsx src/api/main.ts
Restart=on-failure
User=legalbody
Group=legalbody

[Install]
WantedBy=multi-user.target
```
`main.ts` loads `.env` via `dotenv/config`, so the rest of the config comes from the `.env` file in
`WorkingDirectory`. Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now legalbody-api
sudo systemctl status legalbody-api      # should be active; logs: journalctl -u legalbody-api -f
```
On start it runs `reconcileInFlight()` and logs `Wizard API listening on :8789`.

## 5. HTTPS reverse proxy (Caddy — simplest auto-TLS)
The server speaks plain HTTP on `:8789`; terminate TLS in front of it. `/etc/caddy/Caddyfile`:
```
api.yourdomain.com {
    reverse_proxy localhost:8789
}
```
`sudo systemctl reload caddy`. (nginx + certbot works too — same idea.) The frontend then calls
`https://api.yourdomain.com`, and that host must be in `WEB_ORIGIN`'s allowed set... actually
`WEB_ORIGIN` is the **frontend's** origin (CORS), e.g. `https://app.yourdomain.com`.

## 6. Verify
```bash
curl https://api.yourdomain.com/healthz                 # {"ok":true}
curl https://api.yourdomain.com/schema/agent-spec.json  # the form schema
```
Then run one full onboarding through the frontend (or CLI) and confirm it reaches `bound`, and the new
sub-org appears in the Turnkey dashboard.

## 7. Backups (SQLite-safe)
Use SQLite's online backup (WAL-safe — don't just `cp` a live WAL DB), plus the documents dir:
```bash
# /etc/cron.daily/legalbody-backup  (chmod +x)
sqlite3 /var/lib/legalbody/data/legalbody.db ".backup '/var/backups/legalbody-$(date +\%F).db'"
tar czf /var/backups/legalbody-docs-$(date +%F).tar.gz -C /var/lib/legalbody/data documents
```
Keep a few days of rotation; copy off-box if it matters.

---

## Does this interact with anything else?

- **Turnkey org switch** — independent. Same Turnkey `.env` vars from `back/docs/TURNKEY_ORG_SWITCH.md`,
  just living on the VPS now. Do the org switch and the VPS move in either order.
- **Frontend integration** — `WEB_ORIGIN`, `SIWE_DOMAIN`, `PASSKEY_RP_ID` are the shared contract.
  Confirm the exact frontend origin/domain with the FE dev (see `back/docs/FRONTEND_INTEGRATION.md`).
- **Concurrency caveat (low risk for demo):** the onboarding saga is single-runner per key (no
  key-claim lock yet) — fine for one VPS process at demo traffic. If you ever scale to multiple
  processes/instances, both that and the file-based SQLite/doc store need the multi-instance work in
  `docs/V2_HARDENING_BACKLOG.md`.

## Checklist
- [ ] Node ≥ 20.18.2 on the box; domain DNS pointing at it
- [ ] `npm install` (full, not production-only) + `npm run gen:abis`
- [ ] `DATA_DIR` on a persistent volume
- [ ] `.env` with real `AUTH_JWT_SECRET`, explicit `WEB_ORIGIN`, correct `SIWE_DOMAIN` + `PASSKEY_RP_ID`
- [ ] `chmod 600 .env`
- [ ] systemd service running with `NODE_ENV=production`
- [ ] Caddy/nginx HTTPS in front of `:8789`
- [ ] `/healthz` returns `{ ok: true }` over HTTPS
- [ ] One onboarding reaches `bound`; sub-org visible in Turnkey
- [ ] Daily backup of `DATA_DIR` (DB via `.backup` + documents)
</content>
