# Live End-to-End Wiring — Governed Nanopayment Agent (Design)

> **Status:** approved 2026-06-19. Additive on Phase 3 (PR #3). Next step: implementation plan
> (`docs/plans/2026-06-19-nanopayments-live-e2e-wiring-implementation.md`).

## In one sentence

Wire the proven Phase-0–3 pieces into **one runnable autonomous business cycle** — the agent funds itself
from the treasury (within the on-chain cap), buys data (cost settles out), and sells its answer (revenue
settles back into the treasury) — so a single command runs the full governed loop live on Arc testnet. This
session delivers the **wiring + a runbook**; the live run itself is operator-triggered (needs
`ANTHROPIC_API_KEY` + funded keys) and is out of scope to execute here.

## Why

Every component already works in isolation: the Authority gates + signs, `signX402`/`makeSettle` settle on
Arc (proven by `probe-settle.mts`, Finding 10), the Claude agent loop buys/synthesizes/prices, and
`runDemo` + `legalbody agent ask` run the cycle deterministically. What's missing is the **live three-leg
money flow as one orchestrated run**: the agent's `--settle` path is a deliberate stub, and the governed
funding bridge (`topUpPocket`) exists but is wired into no runnable entrypoint. This closes that gap — the
"demo dry-run" of the design (`2026-06-16-nanopayments-x402-agent-design.md` §9), and the artifact the
<3-min video shows.

## Scope

**In scope (this increment):**
- A thin live-orchestration module that composes funding → buy(settle) → sell(settle) into one runner.
- The governed funding bridge wired to the Turnkey enclave operator against the live treasury.
- A real, settled **sell** leg (a simulated customer pays the agent's own paywall; revenue settles in).
- Fix the latent vendor-payout bug (cost must leave to a distinct vendor address, not the treasury).
- Deterministic tests of the orchestration with fakes; the spike's `--settle` path made real (stub removed).
- A runbook for the operator-triggered live run.

**Out of scope (later):**
- Executing the live run (operator-triggered; needs secrets + funding).
- The Phase-4 demo dashboard (separate increment).
- A real external data vendor / real external customer (both are simulated, in-process, by design).
- V2 hardening already tracked elsewhere (priceOf cost TOCTOU, durable seller replay store).

## Money flow (the three legs)

```
LEG 0 — governed top-up (Turnkey enclave signs; O(top-ups)):
  treasury --fundOperator--> operator(enclave EOA) --transfer--> pocket EOA --Gateway deposit--> pocket Gateway balance
            (bounded by treasury.available(); refused if float > available)

LEG 1 — agent buys data (cost OUT):
  agent --/authorize--> pocket-signed X-PAYMENT --> vendor paywall (payTo = VENDOR_PAYOUT) --settle--> pocket→vendor

LEG 2 — agent sells answer (revenue IN):
  customer (platform key) --X-PAYMENT for `price`--> agent's sell paywall (payTo = treasury) --settle--> customer→treasury
```

Net on-chain effect: the treasury funds a bounded float; the float pays for data (cost out to the vendor);
the priced answer's revenue settles back into the treasury → real P&L = `price − totalCost`. Every payment
still flows through the Authority chokepoint, so the policy-reject and guardian-freeze "killer moments" are
unchanged.

## Components

New module **`backend/src/agent/liveRunner.ts`** (the only new source file; `runDemo` stays untouched):

| Unit | Responsibility | Depends on |
|---|---|---|
| `runLive(deps, query)` | Pure orchestration core: `fund` → `runDemo` → `sell`; returns `LiveRunResult`. Injectable seams (fakes in tests). | `runDemo` (3E.1), injected `fund`/`sell`/settle-log |
| `buildLiveAgentRunner(cfg)` | Live composition root (moved out of `cli/index.ts`): builds real deps and returns `(query) => runLive(...)`. | config, all live adapters |
| `fundPocket(cfg, floatAtomic)` | Leg 0: builds the Turnkey operator `WalletClient` + an `ArcAdapter` *with* `operatorWallet` + `PocketGateway`, then calls the existing `topUpPocket(...)`. Returns the tx hashes. | `buildOperatorWalletClient`, `ArcAdapter.fundOperator`/`operatorTransferUsdc`, `PocketGateway.deposit`, `topUpPocket` |
| `sellAnswer(cfg, {price, sellerPayTo, settle})` | Leg 2: builds the agent's own `buildPaywall` (payTo = treasury, `settle` on), simulates a customer (the **platform key**) signing + posting an X-PAYMENT for `price` in-process, returns the sale's settle result. | `buildPaywall`, `makeSignX402`, `pocketSignerFromKey` |

**Settle capture.** `runLive` wraps `makeSettle(cfg.gatewayFacilitatorUrl)` in a small recording `SettleFn`
that appends each `{transferId, ...}` to a list, and passes that wrapped settle into **both** the vendor
(leg 1) and the sell paywall (leg 2). The runner reports all collected transfer ids.

**`LiveRunResult`** = `DemoResult` (answer, totalCost, price, pnl, purchases, denied) **plus**
`{ fundingTxs: Hex[]; settleTransferIds: string[]; customer: Address; vendorPayout: Address }`.

**Vendor fix.** The vendor is built with `payTo: VENDOR_PAYOUT_ADDRESS` (a distinct cost destination) +
the recording settle hook — replacing the current `payTo = treasury` bug in the stub runner.

**Edits to existing files (additive):**
- `backend/src/cli/index.ts` — import `buildLiveAgentRunner` from `../agent/liveRunner` (remove the local
  copy); the `agent ask` action prints answer + P&L + funding txs + settle transfer ids.
- `backend/scripts/spike-agent-live.mts` — `--settle` calls the real settle/funding-enabled runner (stub
  removed); the default no-key guard stays.
- `backend/src/config/env.ts` — three additions (below).

## Config additions (`env.ts`)

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `VENDOR_PAYOUT_ADDRESS` | live only | — | Where the agent's data-purchase cost settles (must differ from the treasury). Throw on a live run if unset. |
| `FUNDING_FLOAT_USDC` | no | `"0.50"` | The bounded top-up amount (decimal USDC); `topUpPocket` refuses it if `> available()`. |
| `CUSTOMER_PRIVATE_KEY` | no | `platformPrivateKey` | The simulated customer's signer for the sell leg. Defaults to the platform key (reuses its residual Gateway balance — no new secret). |

(`TREASURY_ADDRESS` and `AGENT_PAYOUT_ADDRESS` already exist as `process.env` reads in the live runner.)

## Error handling & governance edges

- **Funding cap:** `topUpPocket` already refuses `float > treasury.available()` and signs nothing on refusal.
- **Settle failure (either leg):** `settleWith` is throw-safe (returns `{ok:false, reason}`) — the run
  records the failure and reports it rather than crashing.
- **Missing live prerequisites:** `buildLiveAgentRunner`/`fundPocket` throw clear, actionable errors when
  `ANTHROPIC_API_KEY`, `POCKET_PRIVATE_KEY`, `TREASURY_ADDRESS`, `VENDOR_PAYOUT_ADDRESS`, or `cfg.turnkey`
  (the enclave operator) are absent — before any spend.
- **Killer moments unchanged:** policy-reject (off-allowlist/over-cap → `policy-denied`, agent degrades) and
  guardian-freeze (guardian `pause` → Authority stops signing) live in the Authority, which every buy still
  routes through. No new bypass is introduced (the agent still holds no key).

## Testing

- **New `backend/test/agent/liveRunner.test.ts` (deterministic, no network/key/Turnkey):** drive `runLive`
  with injected **fakes** — a fake `fund` (records it ran), the in-process vendor + a fake Anthropic client
  (existing pattern), a fake recording settle, and a fake customer-pay. Assert: `fund` runs **before** the
  agent, `sell` runs **after**, both legs settle, and `LiveRunResult` carries the funding txs + transfer ids
  + correct P&L. Mirrors the existing `DemoDeps`/`AgentDeps` injection seam.
- **Untouched:** `demo.int.test.ts`, `cli.test.ts` (runDemo is unchanged; the CLI just imports the runner).
- **Quality gate per task:** `tsc` + `biome` clean; the non-live suite (`--exclude '**/*.live.test.ts'`)
  green. Do **not** run the live Turnkey suite (metered free-tier signatures).
- **Live execution** stays gated behind the spike + `ANTHROPIC_API_KEY` + funded keys (the runbook) — never
  in CI.

## Deliverable: the runbook

A dedicated runbook at `docs/runbooks/2026-06-19-live-agent-run.md` (and indexed in `docs/README.md`) with:
1. **Env to set** in `backend/.env`: `ANTHROPIC_API_KEY`, `VENDOR_PAYOUT_ADDRESS` (≠ treasury),
   `TREASURY_ADDRESS` (the live agent-656785 treasury), optional `FUNDING_FLOAT_USDC` / `CUSTOMER_PRIVATE_KEY`.
2. **Funding prerequisites:** the treasury holds USDC and its cap ≥ the float; the platform/customer key's
   Gateway balance ≥ the answer `price`; the operator (enclave) EOA has a small USDC gas reserve.
3. **Run:** `cd backend && npx tsx scripts/spike-agent-live.mts --settle`.
4. **Expected output:** purchases + answer + P&L + funding tx hashes + settle transfer ids.
5. **Verify on-chain:** Arcscan tx links + the Circle transfer ids (`received` → `completed` in ~1 min),
   and fill the live-run placeholder in `2026-06-16-x402-gateway-spike-findings.md`.

## Decisions (made during brainstorming, recorded)

1. **Sell = a real second settled sale** (revenue settles into the treasury), not a simulated price number.
2. **Funding bridge = the Turnkey enclave operator** (production-faithful; works against the live
   agent-656785 treasury; ~2 enclave sigs per top-up = O(top-ups), within the free tier).
3. **This session = wiring + runbook** (no live spend); the operator triggers the live run.
4. **Simulated customer = the platform key** (reuses its residual Gateway balance; no new secret).
5. **`VENDOR_PAYOUT_ADDRESS` is a new required-for-live env** so the agent's cost actually leaves the treasury.
6. **Structure = a thin `liveRunner.ts` orchestration layer**; `runDemo` stays unchanged and its test untouched.

## What stays simulated (transparency)

The data **vendor** and the **customer** are both in-process simulations (the customer is us, paying with a
funded key). The **payments, signatures, settlement, funding, and governance are all real on Arc testnet** —
only the two counterparties are stand-ins, which is appropriate for a self-contained, reproducible demo.
