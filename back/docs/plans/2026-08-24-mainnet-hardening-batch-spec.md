# Mainnet hardening batch — implementation spec

**For:** backend colleague (+ their Claude session)
**Written:** 2026-08-24, by Martin + Claude (Fable)
**Goal:** close two S4 mainnet gates (env-fallback split, funding-wallet separation), harden the
controller monitor, and clear a basket of small pre-mainnet fixes. Arc mainnet is **Sept 16**;
everything here is a launch prerequisite or close to it.

---

## 0 · Context you need before touching anything

**What Novi Corpus is.** We give AI agents a legal body: a Wyoming DAO LLC wrapper, an on-chain
USDC treasury on Arc with spending rules, and a World ID verified human (the "guardian") who
answers for the agent. Backend = Hono + SQLite at `back/backend` (TypeScript, vitest, biome).
Contracts = Foundry at `back/` (`src/*.sol`). Frontend = Next.js at `interface/`, deployed on
Vercel (www.novicorpus.com). Prod backend runs on an AWS Lightsail box (`api.novicorpus.com`).

**The S4 problem this batch finishes.** Historically one key, `PLATFORM_PRIVATE_KEY`, did
everything: governed contracts, minted entities, AND held/moved operating USDC. We have been
splitting powers off it (beacon → admin wallet, factory/registry → NoviController #92). Two
powers still silently ride on it, and removing them is items 1 and 2 below. The power map and
the gate table live in `back/docs/plans/2026-08-11-mainnet-readiness.md` (§ "Remaining S4
work") — read it first.

**Working rules (non-negotiable):**
- Feature branch + PR to `main`. Never push to `main` directly. Rebase on `origin/main` before pushing.
- TDD: write the failing test first, watch it fail, then fix. Every behavior change lands with tests.
- Gates before any PR: `npm run lint` (biome), `npm run typecheck`, `npx vitest run` — all green
  (~1,400 tests). Never trust `$?` after a pipe; write output to a file and check the exit code directly.
- **Do not touch** anything under `src/formation/`, `src/adapters/doola/`, or formation-related
  saga/API code — the doola PR series (PR 3/4) is in flight in another session and will collide.
- Deployment to prod is NOT part of this task. Martin deploys and sets prod env vars. Your
  deliverable is merged code + updated runbook text telling him exactly what to set.
- Credential-less boot must keep working: a deployment with none of the optional env vars set
  must still start (features degrade to unavailable, loudly). This is an existing invariant —
  see how `pocketFunding` is optional in `src/api/app.ts` and returns 503 when absent.

---

## 1 · Split the env fallbacks off the platform key (S4 gate #3)

**Problem (plain words).** Three env vars silently default to the platform governance key when
unset. So forgetting a var in prod doesn't fail — it quietly makes the most powerful key in the
system also act as the job-escrow payer, the demo customer, and the x402 demo payout target.
A missing var must never escalate privilege; it must refuse.

**Where the fallbacks are** (`src/config/env.ts`):
- line ~510: `customerPrivateKey: e.CUSTOMER_PRIVATE_KEY ?? e.PLATFORM_PRIVATE_KEY`
- line ~518: `jobClientPrivateKey: e.JOB_CLIENT_PRIVATE_KEY ?? e.PLATFORM_PRIVATE_KEY`
- line ~531: `x402DemoPayTo: e.X402_DEMO_PAYTO ?? privateKeyToAccount(e.PLATFORM_PRIVATE_KEY).address`

**What to build:**
1. Delete all three `??` fallbacks. Each derived value becomes `undefined` when its var is unset.
2. Trace every consumer (grep for `customerPrivateKey`, `jobClientPrivateKey`, `x402DemoPayTo`;
   known consumers: job escrow funding in `src/api/routes/jobs.ts` + MCP `run_job` in
   `src/mcp/server.ts` ~line 412, the demo customer flows, the x402 demo seller). Each feature
   must refuse loudly (503 / clear boot error / tool error) when its key is absent, following
   the existing `pocketFunding` unavailable pattern — never fall back to the platform key.
3. Boot invariant: in production mode, if a feature flag that NEEDS one of these keys is enabled
   but the key is unset, refuse to boot with a message naming the var (mirror the existing boot
   invariants at the bottom of `env.ts`, e.g. the `ENS_APEX_RESOLVES_TO` one).
4. Add an explicit assertion test: no config value in the parsed env equals
   `PLATFORM_PRIVATE_KEY` or its derived address unless it is the platform field itself. This
   test is the regression guard for the whole item.
5. Update `back/backend/.env.example` (names only, never values) and the deploy runbook section
   in `back/docs/plans/2026-08-11-mainnet-readiness.md`: Martin must generate three distinct
   keys for prod and faucet them on testnet.

**Acceptance:** unset var + feature disabled → boots fine; unset var + feature enabled in prod →
refuses to boot naming the var; set var → feature signs with ITS key, never the platform key.
All existing tests that relied on the fallback get real test keys instead.

---

## 2 · Funding-wallet separation (S4 gate #4)

**Problem (plain words).** The platform key still holds and moves operating USDC: treasury
funding is a plain USDC transfer signed by it, and pocket funding tops up agent pocket EOAs.
Governance and money must not share a key: compromise of the money path must not yield
governance, and vice versa.

**Where the money moves today:**
- `src/adapters/arc/arcAdapter.ts` ~line 518: `fundTreasury(...)` — plain USDC `transfer`
  signed by the platform signer ("signer-direct", deliberately NOT relayed through the controller;
  the comment at ~line 139 explains which calls are signer-direct).
- `src/payments/pocketFunding.ts` (wired in `src/api/app.ts` ~line 127, route
  `POST /entities/:id/fund-pocket` in `src/api/routes/onboard.ts`).
- Whatever else greps to the platform signer doing `transfer(` on USDC — sweep and list them in
  the PR description.

**What to build:**
1. New env var `FUNDING_PRIVATE_KEY` (schema: same `privKeySchema.optional()` pattern), exposed
   as e.g. `fundingPrivateKey`. NO fallback to the platform key (that's the whole point).
2. A dedicated funding wallet client in `src/adapters/arc/clients.ts` next to the existing
   signer plumbing. `fundTreasury` and pocket funding sign with it.
3. When `FUNDING_PRIVATE_KEY` is unset: funding endpoints/tools return unavailable (503-style),
   same degrade pattern as item 1. In production with funding features enabled → refuse boot.
4. Boot invariant: `FUNDING_PRIVATE_KEY` must NOT equal `PLATFORM_PRIVATE_KEY` (refuse boot on
   equality — someone will try to "fix" a missing var that way).
5. Runbook text for Martin: generate the key, fund it with a small USDC float per period, top it
   up on a schedule; the platform key's USDC balance should trend to ~0 (gas only).

**Acceptance:** with the var set, a treasury fund + pocket fund run signs from the funding
address (assert on the tx `from` in tests); platform key signs no USDC transfer anywhere in the
test suite; equality with platform key refuses boot.

**Heads-up:** integration tests (`test/*.int.test.ts`) run against anvil with the contract
artifacts from `back/out` — build with Foundry (`forge build` in `back/`) if they complain about
missing JSON artifacts.

---

## 3 · Monitor hardening

Context: `src/monitor/` is a read-only watchdog service (own DB, `npm run monitor`, systemd unit
in `docs/runbooks/legalbody-monitor.service`, runbook `docs/runbooks/controller-monitoring.md`).
It polls chain state every 30s and raises alerts per `src/monitor/alerts.ts` (severity contract
is documented at the top of that file: WARN/CRITICAL go to webhook). Three sub-items:

**3a. Real alert destination.** `ALERT_WEBHOOK_URL` exists (`env.ts` ~line 184) but points
nowhere in prod. Wire it to a real Discord (or Slack) webhook: check the posted JSON payload
shape against what Discord expects (`{"content": ...}`) and adapt the webhook sink in
`alerts.ts` if needed (keep a generic mode; a `ALERT_WEBHOOK_FORMAT=discord|generic` env is
fine). Test with a mock server asserting the payload. Martin creates the actual webhook URL and
sets it on the box.

Update: the code half of 3a is done. `alerts.ts` already posts both `content` and `text` in one
body, so no `ALERT_WEBHOOK_FORMAT` env is added; the decision and the reasons are in
`docs/runbooks/controller-monitoring.md` under "Payload format: already both. Do not add a format
switch." What remains is operational: create the webhook, set `ALERT_WEBHOOK_URL` on the box.

**3b. Dead-man's switch.** Today nothing tells us if the monitor itself dies or stalls — the
one failure mode a watchdog must not have. Preferred design (simplest thing that pages a
human): systemd `WatchdogSec=` + `sd_notify` heartbeat from the monitor loop each healthy scan
cycle, so systemd restarts it on stall, PLUS an `OnFailure=` unit that fires a curl to the same
webhook ("monitor down/restarted"). If sd_notify from Node is awkward, the fallback design is a
heartbeat row in the monitor DB updated per cycle + a separate tiny systemd timer that alerts
when the heartbeat is stale (>5 min). Either way: document it in the runbook and update the
`.service` file (mind: paths in that unit are for the prod box user `novi`, not `/root`).

**3c. Runaway-agent kill switch (runbook + optional tooling).** Circle Gas Station supports
blocked addresses — blocking an agent's SCA stops sponsoring its transactions, which is our
fastest brake on a runaway agent. Deliverable: a runbook section in
`docs/runbooks/controller-monitoring.md` mapping the relevant CRITICAL alerts to the exact
console steps (Circle console → Gas Station → policy → blocked addresses → add the SCA). Then
investigate whether Circle's API exposes blocked-address management; if yes, add a small
`scripts/gasstation-block.mts` that blocks/unblocks one address (explicit CLI confirm, never
automatic — a monitor must never auto-block; it pages, the human decides).

---

## 4 · Small-fix basket

One PR (or two), low risk, each with its own verification:

1. **ENS resolver gateway URL.** Our CCIP-read gateway is served by the backend
   (`src/api/routes/ensGateway.ts`); the OffchainResolver contract on-chain stores the gateway
   URL from before the infra migration. Read the resolver's current `url` on-chain
   (`ENS_RESOLVER_ADDRESS` env; helper scripts `scripts/ens-gateway-verify.mts`,
   `scripts/ens-register-v2.mts` show the plumbing), and if it isn't
   `https://api.novicorpus.com/...`, update it (resolver owner signer) and re-verify.
   Acceptance: `demo.novicorpus.eth` and a wizard agent name resolve via a public ENS resolver
   client against prod — `demo.novicorpus.eth` being unresolvable on prod is a known open bug;
   diagnose it as part of this (could be the URL, the signer, or the label alias map).
2. **`scripts/tier0-p3-live.mts` DATA_DIR.** The header comment (~line 18) claims
   `DATA_DIR=./data-p3` but the script never sets it, so a rehearsal run pollutes the real data
   dir (this bit us once). Make the script set/require it: default `DATA_DIR` to `./data-p3`
   unless explicitly overridden, and refuse to run when it resolves to the live default dir.
3. **Interface `siteUrl` fallback.** `interface/src/app/layout.tsx` ~line 13 falls back to
   `https://novicorpus.xyz` — a domain we do not own. Change the fallback to
   `https://www.novicorpus.com` (env `NEXT_PUBLIC_SITE_URL` stays the override).
4. **Backfill `file://` metadata URIs.** Two early demo agents still have an on-chain
   `metadataURI` of `file://...` (see `src/persistence/documentStore.ts` — v1 behavior; every
   current agent gets a public `https://.../metadata/:publicId`). Find the affected rows
   (SQLite: entities whose metadataURI starts with `file://`), and update their on-chain URI to
   the public metadata URL. These are LEGACY agents: they are NOT controller-relayed; the
   registry `setMetadata` call for them is signed directly by the platform signer (per-agent
   direct routing — see `sendManagerCall` routing in `src/adapters/arc/arcAdapter.ts`). Testnet
   only, still: verify on Arcscan after.
5. **Orphan testnet agents 875919 / 876740.** Created by a rehearsal run against the live data
   dir (the DATA_DIR bug above). Decide with Martin: delete the DB rows or mark them failed;
   they must stop appearing on the public transparency page either way.

---

## 5 · Definition of done

- Every item: tests first, suite green (`npx vitest run` — expect ~1,400), `npm run lint`,
  `npm run typecheck`, PR with a verification section (commands run + real output).
- Runbook/docs updated where the spec says so; `.env.example` names any new vars (names only).
- A short handoff list for Martin at the end of each PR: exactly which env vars to generate/set
  on prod and in what order to deploy.
- Nothing under formation/doola touched; no deploys performed.
