# Post-judging Infrastructure Plan

> **STATUS: PLANNED, DEFERRED.** Both workstreams execute once hackathon judging closes
> (~2 weeks from 2026-08-07). Written after an infra review on 2026-08-07 (post Tier-0 P4);
> everything in "Why" was verified first-hand against the running box, not inferred.
>
> **Two separate workstreams, one shared prerequisite (a domain — none owned yet):**
>
> | | Changes | Visible outside? | On-chain impact |
> |---|---|---|---|
> | **1. Server migration** (below) | the **private** backend address | **No** — the public URL stays byte-identical | None |
> | **2. Public domain migration** (second half) | the **public** URL | Yes | Yes — passkeys + agent `metadataURI` + ENS gateway |
>
> Workstream 1 is deferred only to avoid *any* change during judging — it changes nothing judges
> can see. Workstream 2 is the one with real consequences, and it gets **cheaper the earlier it
> happens**, so it should follow immediately.

---

# Workstream 1 — dedicated VPS

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

## Phase 5 — Cleanup, and actually severing the link (a few days later)

Stopping the service is **not** the same as leaving. Until these are done, our secrets are still
sitting on a third party's machine:

1. Remove the old IP from the Circle allowlist.
2. Stop and disable the old service.
3. **Securely delete our data and secrets from the old box** — `.env`, `data/legalbody.db`,
   `data/documents/`, and any `.env.bak-*` / `prod-db-backup-*.db` left in `/root`. This is the
   step that actually ends the shared-blast-radius problem; skipping it migrates the *service*
   and leaves the *keys* behind, which is the worse half.
4. **Rotate what lived there.** Once a secret has sat on a machine we don't control, treat it as
   potentially known:
   - **Easy, do it:** Circle API key (mint a third, pinned to the new IP) · `AUTH_JWT_SECRET`
     (rotating just logs everyone out).
   - **Harder, plan it:** `PLATFORM_PRIVATE_KEY` is an on-chain role (open item **S4**);
     `POCKET_MASTER_SEED` derives existing agents' pocket addresses, so a naive rotation strands
     funds — it is retired for circle-path agents anyway.
5. Tell the co-tenant owner they can reclaim ~1.5 GB.

Keep the old box's data for a week before step 3, as the rollback window.

> **Use a FRESH SSH key for the new box.** If one key authorises both, a compromise of the old
> machine yields access to the new one and the problem travels with us.

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

---

# Workstream 2 — public domain migration (`*.vercel.app` → our own domain)

> **STATUS: PLANNED. Do it as soon as judging closes — the earlier the cheaper (see Timing).**
> Distinct from the server migration above, but shares its trigger and its prerequisite (the same
> domain purchase). Workstream 1 changes the **private** backend address and nothing outside can
> see it. Workstream 2 changes the **public** address, and that is the one with consequences.

## Why

`project-alpha-pi.vercel.app` is a build-artifact URL. It is what judges, users, agents, and
**the blockchain** currently point at. A company shipping legal entities for AI agents should not
have its identity anchored to a hosting provider's generated subdomain.

## The mechanic that makes this survivable

**Vercel keeps the `*.vercel.app` URL working when you add a custom domain** — it becomes an
alias, not a replacement. (Confirm in the Vercel dashboard before executing.) That turns this from
a cutover into an **additive** change:

- everything already pointing at the old URL keeps resolving,
- new agents / new passkeys / new connection snippets use the new domain,
- the old URL becomes a **legacy alias we must keep alive** for as long as pre-migration agents
  exist — which, because agent `metadataURI` is written on-chain, is effectively forever unless we
  pay to update each one.

That last line is the whole timing argument.

## What changes

| Setting | Where | Note |
|---|---|---|
| Custom domain + DNS | Vercel project | keeps `*.vercel.app` as an alias |
| `SIWE_DOMAIN` | backend `.env` | login signature domain |
| `PASSKEY_RP_ID` | backend `.env` | **see Passkeys below — the sharp edge** |
| `WEB_ORIGIN` | backend `.env` | CORS |
| `METADATA_BASE_URL` | backend `.env` | affects NEW agents only; existing ones carry the old URL on-chain |
| `MCP_PUBLIC_URL` | backend `.env` | existing client configs keep the old URL |
| ENS CCIP gateway URL | **on-chain resolver** | needs a resolver update tx; old URL keeps working until then |
| `metadataBase` | `interface/src/app/layout.tsx` | currently the placeholder `https://novicorpus.example` (see frontend audit P2) |

## The sharp edge: passkeys

WebAuthn credentials are cryptographically bound to the RP ID (the domain). Changing
`PASSKEY_RP_ID` means **existing passkeys cannot be used from the new domain** — the browser will
not produce an assertion for an RP ID that doesn't match the origin.

Why this matters beyond login: on **turnkey-custody** agents the guardian's passkey is the *root
of the key vault* — the thing that makes "passkey-rooted" custody meaningful. Losing usable access
to it doesn't break day-to-day operations (those run on the delegated API key), but it does break
the **sovereignty guarantee** we sell.

**Mitigation:** because the old `*.vercel.app` URL stays alive, old passkeys remain usable *from
the old origin*. So nothing is destroyed — but we end up in a mixed state that must be documented,
and any guardian wanting root operations on a pre-migration agent has to use the legacy URL.
Decide before executing whether to (a) accept the mixed state, (b) ask affected guardians to
re-register on the new domain, or (c) do the change while the affected set is still just us.

## Timing — why "as soon as judging closes"

**The cost grows with every agent created.** Each one permanently records the then-current
`METADATA_BASE_URL` on-chain, and each guardian passkey is bound to the then-current domain. Today
that's 11 agents, nearly all tests, and a handful of passkeys that are ours. After real users
arrive, the same change means either an on-chain transaction per agent or a legacy URL we can
never retire.

Doing it in the same window as Workstream 1 is also efficient: the domain is already bought, DNS
is already being configured, and the backend `.env` is already being edited.

## Sequence

1. Workstream 1 (server migration) — proves the domain and DNS work, no public impact.
2. Add the custom domain to Vercel; verify `*.vercel.app` still resolves.
3. Update the backend `.env` settings above; restart; verify login, passkey registration, and a
   fresh onboarding on the **new** domain.
4. Update `metadataBase` in the frontend (removes the placeholder).
5. Update the ENS resolver's gateway URL on-chain.
6. Re-issue MCP connection snippets for anyone still on the old URL.
7. Keep the `*.vercel.app` alias alive indefinitely — it backs pre-migration agents' on-chain
   metadata and their passkeys. **Never delete it.**

## Open question

Which domain? It should be the one the company will use publicly — buy it once, use it for both
the site (`novicorpus.<tld>`) and the backend (`api.novicorpus.<tld>`).

---

## Practices to adopt on the new box (the actual "hackathon → company" gap)

The gap is practices, not platform. In rough priority: **Litestream backups**, **TLS + localhost
bind**, a **scripted/CI deploy** (not manual `git pull` over SSH), a **staging environment**, and
**log shipping with alerts** — the `opsLog` discipline already writes structured lines for every
Circle call and Turnkey signature, but they land on one box where nobody reads them. A full disk
should have paged someone.
