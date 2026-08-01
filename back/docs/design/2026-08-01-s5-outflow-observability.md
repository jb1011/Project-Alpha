# S5 — platform outflow ceiling + money-path observability

*Spec 2026-08-01. The last CRITICAL-class item from the pre-hackathon V2 security audit that is
buildable today (S3/S4 fold into the Tier-0 smart-account migration; S1 closed by #38, S2 interim
by #39). Hermetic — needs neither Turnkey signing nor World sandbox.*

## The two gaps

1. **No aggregate brake.** S1 caps `fund_treasury` per call (25) and per tenant lifetime (100).
   S2 caps each agent's standing float (1.00). But nothing bounds the platform wallet's TOTAL
   outflow per unit time across all paths and all tenants: N tenants × 100 is unbounded by N, and
   gas seeds + the operator CLI move platform funds outside every existing cap. A runaway loop or
   a leaked provision key drains at wire speed until a human notices — and today nothing would
   make a human notice.
2. **No decision trail.** The backend logs nothing per request. This cost us twice in one week,
   measured: the World verify failure was undiagnosable until #58 added `logWorldRejection`, and
   the Turnkey quota exhaustion had no usage history to reconstruct. Every money decision
   (accept AND reject) must leave a line in journald.

## Design

### 1. Aggregate outflow meter (fail-closed brake)

- **Table** `platform_outflows(id, at, path, amount, ref)` — one row per platform-wallet outflow;
  additive migration. Paths: `fund_treasury`, `gas_seed`, `cli_fund`.
- **Recorded at the existing choke points**, not new ones: `runner.fund` (covers REST + MCP),
  the gas-seed sender, and the operator CLI (see 3).
- **Ceiling**: `PLATFORM_OUTFLOW_CEILING_USDC` per rolling `PLATFORM_OUTFLOW_WINDOW_HOURS`
  (defaults **200 USDC / 24 h** — ~17× the busiest real day so far; env-overridable; boot
  invariant: ceiling ≥ MAX_TREASURY_FUND_USDC so a single legal call can never be auto-blocked).
  Exceeding it rejects with `platform-outflow-ceiling` — same reject-don't-clamp discipline as S2.
- **Window query** is `SUM(amount) WHERE at > now - window` — no counters to reset, no cron.

### 2. Structured money-path logging

- Tiny `opsLog(event, fields)` helper: one JSON line to stdout → journald (no new infra; grep is
  the v1 alerting). Same redaction discipline as `env.ts` — amounts/paths/reasons/ids, never keys.
- Emitted on: fund accepted/rejected (with reason + running window total), pay policy denials
  (incl. the new seller-trust reasons), ceiling hits, sweep runs, World rejections (existing
  `logWorldRejection` becomes a caller of this).

### 3. Route the operator CLI through `runner.fund`

The CLI currently calls `arc.fundTreasury` directly — outside S1's caps and outside this meter
(the fast-follow #38 documented). It becomes a `runner.fund` caller like every other surface;
the trusted operator can still raise env caps deliberately, but no path is silently uncapped.

## Out of scope

External alerting/dashboards (journald + grep first; revisit with real traffic) · S3 (pocket
master seed) and S4 (platform key overload) → Tier-0 smart-account migration · per-tenant rate
limits beyond S1's lifetime quota.

## Test plan (TDD + mutation, house method)

Failing-first: window math (in/out of window, boundary), ceiling reject at exactly ceiling+1,
gas-seed and CLI paths metered (call-counted fakes), boot invariant, log lines emitted on
accept AND reject with secrets absent. Mutations: drop the window filter (lifetime sum),
skip the gas-seed recording, log only rejections — each must fail a named test.

## Audit corrections (2026-08-01, pre-implementation — spec audited against live code)

1. **`runner.fund` claim holds, but split check/record.** The saga's direct `arc.fundTreasury`
   (onboarding.ts:299) fires only with `fundAmount`, which only `runner.fund` passes (runner.ts:114)
   — contained. The CHECK belongs in `runner.fund` (synchronous, before the saga spawns); the
   RECORD belongs in the saga's fund step where the tx actually succeeds.
2. **Unit normalization was missing.** Gas seeds are 18-dec native wei; treasury funds are 6-dec
   atomic. Summing them raw is off by 1e12. ALL rows are normalized to 6-dec atomic at record
   time (`wei / 1e12` for seeds — exact on Arc where native IS USDC).
3. **Missed path: job funding.** `runJob` step 2 `approveAndFund(budget)` moves platform
   client-wallet USDC (bounded per job by MAX_JOB_BUDGET, but in no aggregate). New path
   `job_fund`: check before job creation, record on fund success.
4. **CLI-through-runner.fund was the wrong shape.** `runner.fund` is async fire-and-forget; the
   CLI is a synchronous operator tool. Corrected: the CLI keeps its direct signing (documented
   trusted-operator status) but goes through the SAME meter — check before, record after — so no
   path is silently unmetered. The original S1 fast-follow intent (no uncapped path) is met by
   the meter, not by rerouting.
5. **NEW SCOPE — Turnkey signature metering** (the plan became metered: 25 sigs/month + per-sig
   charges, after this spec was written). `meterTurnkeyAccount(account, kind)` wraps the three
   sign methods of every Turnkey-backed viem account (operatorWallet ×2 builders, TurnkeySigner
   ×2 sites): each signature emits an opsLog line (kind + purpose label; journald is the durable
   monthly record) and, where a db is registered from the composition root, a `turnkey_sigs` row
   for an exact in-DB monthly count. Known costs for budgeting: fund_pocket=2, pay=0, denials=0.
