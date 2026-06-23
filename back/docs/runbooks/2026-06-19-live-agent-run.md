# Runbook — Live Governed Agent Cycle (Arc testnet)

Runs the full autonomous cycle live: governed funding -> agent buys data (settles) -> simulated customer
buys the answer (settles into the treasury) -> real P&L. **Spends real testnet USDC + Anthropic tokens +
~2 Turnkey enclave signatures.** Operator-triggered only.

## 1. Set env in `backend/.env`
- `ANTHROPIC_API_KEY=...`            (the agent's brain; demo-only)
- `TREASURY_ADDRESS=0x...`           (the live agent-656785 AgentTreasury)
- `VENDOR_PAYOUT_ADDRESS=0x...`      (where data-purchase cost settles — MUST differ from the treasury)
- `AGENT_PAYOUT_ADDRESS=0x...`       (optional; defaults to the treasury — where revenue lands)
- `FUNDING_FLOAT_USDC=0.50`          (optional; the bounded top-up)
- `CUSTOMER_PRIVATE_KEY=0x...`       (optional; defaults to the platform key)
- Already present from earlier phases: `POCKET_PRIVATE_KEY`, `TURNKEY_*`, `PLATFORM_PRIVATE_KEY`, the Arc RPC.

## 2. Funding prerequisites
- The treasury holds USDC and its rolling cap covers `FUNDING_FLOAT_USDC` (`available() >= float`).
- The customer key's Gateway balance >= the answer `price` (price = cost x (1 + margin), margin 0.5).
- The operator (enclave) EOA `0x46DE...` has a small USDC gas reserve (Arc charges USDC gas).

## 3. Run
```bash
cd backend && npx tsx scripts/spike-agent-live.mts --settle
```
(append a query as a bare arg to override the default, e.g. `... --settle "What are USDC flows on Arc?"`)

> ⚠️ **The CLI runs the same live cycle.** `legalbody agent ask "<query>"` (`npm run cli -- agent ask "..."`)
> invokes the identical `buildLiveAgentRunner` — with this `.env` configured it **also funds + buys + sells +
> settles real USDC** (it is not a dry run, and unlike the spike it has no `--settle` gate). Use the spike
> entrypoint above for the demo; only run `agent ask` against a live `.env` when you intend to spend.

## 4. Expected output
Answer, purchases, `cost=/price=/P&L=`, `sold=true`, the **funding tx hashes**, and the **settle transfer ids**.

## 5. Verify on-chain
- Funding txs on Arcscan (https://testnet.arcscan.app).
- Circle transfer ids settle `received -> completed` in ~1 min (batched gatewayMint).
- Record the run's purchases/answer/P&L + transfer ids in the Phase-3 section of
  `docs/research/2026-06-16-x402-gateway-spike-findings.md`.

## Safety
The data vendor and the customer are in-process simulations; payments/signing/settlement/funding/governance
are all real. Guardian `pause` halts the Authority's signing mid-run; an over-cap/off-allowlist buy is denied.
