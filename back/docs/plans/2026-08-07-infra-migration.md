# Infrastructure Migration Plan — dedicated VPS

> **STATUS: PLANNED, DEFERRED.** Blocked until after hackathon judging (~2 weeks from 2026-08-07)
> — not because the migration changes anything judges can see, but because we don't want *any*
> change or downtime during a judging window. **The public URL does NOT change**
> (`https://project-alpha-pi.vercel.app` stays byte-identical); only Vercel's private
> `API_PROXY_TARGET` moves. Execute when judging closes.
>
> Written after an infra review on 2026-08-07 (post Tier-0 P4). Everything in "Why" was verified
> first-hand against the running box, not inferred.

## Why

Four problems, one move fixes all of them:

1. **The backend is reachable unencrypted.** The browser→Vercel hop is HTTPS, but Vercel→VPS is
   plain HTTP (`http://159.223.137.183:8789`, the hardcoded fallback in
   `interface/src/app/backend/[[...path]]/route.ts`). The VPS has **no TLS listener at all**.
   Session JWTs and MCP API keys cross the public internet in the clear on that hop, and the API
   port answers directly from the internet — bypassing Vercel entirely.
2. **Shared host.** The box also runs an unrelated third party's production service and database.
   Our secrets (Circle API key + entity secret, `POCKET_MASTER_SEED`, `PLATFORM_PRIVATE_KEY`,
   Turnkey delegated keys, `AUTH_JWT_SECRET`) are readable by anyone with root there, and a
   compromise of the co-tenant reaches them. **Note the Circle IP allowlist does not help here** —
   an attacker on the box is already at the allowlisted IP.
3. **Disk exhaustion.** Found at **14 MB free** of 9.3 GB (100%). SQLite runs in WAL mode; a full
   disk during a write is a corruption path. Freed 336 MB on 2026-08-07 by clearing regenerable
   caches only (apt 188M, npm 143M, journald vacuum 48M) — still ~97% used afterwards. The box is
   undersized: 1 vCPU / 458 MB RAM, and `node_modules` alone is 1.1 GB (dev deps are **required** —
   the server runs TypeScript via `tsx` at runtime; see `VPS_DEPLOY.md`).
4. **No backups.** Nothing streams or snapshots `legalbody.db`. If the droplet dies, the on-chain
   agents survive but the *mapping* does not — entity keys → wallets, the payment ledger,
   idempotency records, job history. Unreconstructable.

## What is NOT affected (verified 2026-08-07)

This is what makes the migration low-risk: **nothing outside the box points at the box.**

| Surface | Points at | Verified how |
|---|---|---|
| On-chain agent `metadataURI` | `…vercel.app/backend/metadata/<publicId>` | `METADATA_BASE_URL` in prod env |
| ENS CCIP gateway (baked into the on-chain resolver) | `…vercel.app/backend/ensgateway/{sender}/{data}.json` | resolver config in repo |
| MCP client configs | `…vercel.app/backend/mcp` | `MCP_PUBLIC_URL` |
| SIWE login / passkeys / CORS | `project-alpha-pi.vercel.app` | `SIWE_DOMAIN`, `PASSKEY_RP_ID`, `WEB_ORIGIN` |
| x402 demo seller | via the Vercel proxy | route mount |

**No on-chain transaction is required.** The only pointer to the VPS is Vercel's
`API_PROXY_TARGET` env var.

In-flight work is also safe: onboarding and job sagas are resumable from SQLite
(`reconcileInFlight`), so anything mid-flight at cutover resumes on the new box.

## Current state (ground truth for whoever executes this)

- Host `159.223.137.183` (DigitalOcean, NYC1), Ubuntu, 1 vCPU / 458 MB RAM / 9.3 GB, 2 GB swap
- Node **v20.20.2**; service `legalbody-api.service` (systemd, `User=root`,
  `WorkingDirectory=/root/Project-Alpha/back/backend`, `ExecStart=/usr/bin/npm run api`,
  `EnvironmentFile=…/.env`), listening on `*:8789`
- Repo at `/root/Project-Alpha`, deployed by `git pull` + `systemctl restart` (manual)
- **Data to migrate:** `back/backend/data/legalbody.db` (~140 KB, 11 entities / 4 jobs) **and**
  `back/backend/data/documents/` (~26 files, 4 MB)
- `.env`: ~45 vars incl. secrets. Circle API key is **IP-pinned** to this host.

## Prerequisites (user)

1. **Buy a domain** (~$12/yr). Needed for TLS — certificates are issued for names, not IPs. We
   use a subdomain, e.g. `api.<domain>`. (You want a web domain as a company regardless.)
2. **Create the VPS** on your own account. **Hetzner CX22** (2 vCPU / 4 GB / 40 GB, ~€5/mo) or
   DigitalOcean equivalent (~$24/mo). Ubuntu 24.04. Add SSH keys.
3. **DNS**: `A` record `api.<domain>` → new IP. Do this first; TLS issuance needs it to resolve.
4. **Circle console**: add the **new** IP to the API key allowlist *alongside* the old one. Both
   must be allowlisted during the migration window — the new box has to be testable before
   cutover while the old one still serves. The old IP is removed in Phase 5.

## Phase 1 — Build the new box (no downtime)

Old box keeps serving throughout.

- **Harden:** firewall allowing only SSH / 80 / 443. **Do not expose 8789** — the API binds to
  localhost and Caddy fronts it. This closes today's direct-from-internet exposure.
- **Non-root service user** (open decision, see below) instead of `User=root`.
- **Runtime:** Node 20 (match v20.20.2), clone repo at `main`, `npm install` **with dev
  dependencies**.
- **Secrets:** pipe `.env` host-to-host over SSH. Never through a displayed file, never through
  chat.
- **TLS:** Caddy, auto Let's Encrypt cert for `api.<domain>`, reverse-proxy → `localhost:8789`.
- **Backups:** Litestream → Cloudflare R2 (free at this size), continuous replication of
  `legalbody.db`. Verify a restore before relying on it.

## Phase 2 — Rehearsal (no downtime)

Copy a snapshot of the data to the new box and run the service there **while production still
serves from the old box**. Verify:

- boots clean; `/healthz` and `/config` correct
- reads Arc; reaches Circle (proves the new IP is allowlisted)
- a test onboarding into an **isolated `DATA_DIR`** (the technique used for P4 validation — see
  the Tier-0 design doc), so nothing pollutes real data

Fix anything found here at zero user impact.

## Phase 3 — Cutover (~10–15 min downtime)

1. Stop the old service (freezes the DB for a consistent copy)
2. Final sync of `data/legalbody.db` **and `data/documents/`**
3. Start the new service; verify locally on the box
4. **User:** flip Vercel `API_PROXY_TARGET` → `https://api.<domain>` (~2 min redeploy)
5. Verify through the public URL

> ⚠️ **`data/documents/` is the step most likely to be forgotten and the most damaging if it is.**
> Those files back the **on-chain** `metadataURI` values. Lose them and those URLs 404 forever,
> while every health check still shows green.

## Phase 4 — Verification

Automated: `/healthz`, `/config`, a real agent's metadata URL (proves the documents migrated),
ENS gateway, x402 demo seller.
Manual (user, browser): SIWE login, dashboard loads, MCP connection from Claude Code still works.

Then the still-open Tier-0 item: **onboard one agent through the real prod wizard with
Novi-managed custody** — the only path never exercised through the HTTP surface (P3/P4 used
scripts calling the same production builders). See the Tier-0 design doc.

## Phase 5 — Cleanup (a few days later)

Remove the old IP from the Circle allowlist · stop the old service · tell the co-tenant owner they
can reclaim ~1.5 GB · keep the old box's data for a week regardless.

## Rollback

**Flip `API_PROXY_TARGET` back and restart the old service — ~2 minutes.** The old box stays
untouched and functional through the whole migration. That is what makes this low-risk.

## Cost & effort

| | |
|---|---|
| New box | ~€5/mo (Hetzner) or ~$24/mo (DO) |
| Domain | ~$12/yr |
| Backups (R2) | free at this size |
| Optional staging box | ~€5/mo |
| Effort | ~half a day, of which **10–15 min is downtime** |

## Open decisions

1. **Non-root service user** — recommended (a fresh box is the cheapest moment; a service that
   signs financial transactions shouldn't run as root). Slightly more migration surface.
2. **Staging box now or later** — currently production is the only environment; every change so
   far went straight to prod.

## Why VPS and not PaaS/AWS (decision record, 2026-08-07)

- **SQLite ⇒ one stateful process with a local disk.** That rules out serverless (Vercel/Lambda/
  Cloud Run — ephemeral, no persistent disk) and container orchestration (solves running *many*
  copies; we run one). **The platform question is downstream of the database question** — the
  cloud conversation only genuinely reopens if we move SQLite → Postgres.
- **The Circle IP allowlist now requires a stable egress IP.** Fly.io's static egress
  (~$3.60/mo/region) **does not apply during deploys or machine migrations** — an intermittent
  401 that would be painful to debug. Railway/Render use shared rotating egress (needs a
  third-party static-IP proxy). AWS solves it via public-subnet EC2 + Elastic IP (~$3.60/mo) or a
  NAT gateway (~$32/mo). A plain VPS gives a stable IP for free.
- **AWS at ~$30/mo would be EC2 + EBS + EIP over SSH — functionally a VPS with more moving
  parts.** Its real wins (Secrets Manager/KMS, IAM+CloudTrail, RDS) only arrive with managed
  services that cost more and take more work — and the KMS win partly overlaps work already
  planned (Turnkey enclaves + Circle MPC already hold the agent keys; remaining plaintext secrets
  are the pocket master seed, retired by the circle path, and the platform key = open item S4).
- **Revisit AWS if:** a customer/investor requires SOC 2, or AWS Activate credits make it free.
  Because nothing external points at the host, a later VPS → AWS move is the same half-day — there
  is no lock-in penalty for choosing the simpler thing now.

## Practices to adopt on the new box (the actual "hackathon → company" gap)

The gap is practices, not platform. In rough priority: **Litestream backups**, **TLS + localhost
bind**, a **scripted/CI deploy** (not manual `git pull` over SSH), a **staging environment**, and
**log shipping with alerts** — the `opsLog` discipline already writes structured lines for every
Circle call and Turnkey signature, but they land on one box where nobody reads them. A full disk
should have paged someone.
