# Treasury and policy

Each agent gets its own `AgentTreasury`: an immutable USDC vault on Arc. The operator spends. The guardian can stop it. The manager can propose policy changes, never instant ones.

## What the vault holds

USDC on Arc (6 decimals). On Arc, USDC is also the gas token. The vault is **not upgradeable**. There is no admin key that can drain beyond the rules encoded at deploy and later amended through the timelock.

## On chain rules

| Rule | Effect |
| --- | --- |
| Rolling period cap | `available()` is `cap - spentInWindow`. The window resets after `period`. Max period is 365 days. |
| Allowlist | If `allowlistEnabled`, `spend` reverts unless `isAllowed[to]`. The guardian toggles entries. |
| Pause | Guardian can pause and unpause. `spend` reverts while paused. |
| Legal status | `spend` reverts unless the linked `LegalManager` is `Active`. |
| Payout address | Emergency withdraw always goes here, never to an arbitrary address the caller types. |
| Policy delay | At least 1 hour. Manager schedules a new cap, period, payout, or allowlist flag. Guardian can veto. After the delay, manager executes. |

`spend(to, amount)` is `onlyOperator`. The operator key signs. It does not own the USDC. Custody of the vault is the contract.

## Software rules (Payment Authority)

Before the backend signs an x402 payment it re-reads chain state and also applies:

* **Per transaction cap.** Not a Solidity check. Enforced in software, then the on chain period cap still applies.
* **Hybrid allowlist.** Chain allowlist plus any extra software list.
* **Trust policy.** Seller side: `open` or `accountable-only` (refuse buyers with no human backing). Buyer side: `open` or `verified-sellers-only`. Default for both is `open`.
* **Entity must be bound, not paused, legally Active.**

These checks fail closed. Nothing is signed if they fail. Idempotency keys mean a retry after a denial does not double spend.

## Two wallets around the vault

Payments do not always leave the treasury in the same transaction as the HTTP 402.

1. **Treasury** (the contract). Long term store. Period cap lives here.
2. **Pocket.** A short lived float used to settle x402 through Circle Gateway. Top up with `fund_pocket` (MCP) or the dashboard equivalent. Explicit only. `pay` never auto tops up.

A spend that would exceed the on chain remaining cap cannot be made good by filling the pocket.

## Funding

On the hosted product, the **platform wallet** transfers testnet USDC into the treasury. You pick the amount. You do not sign the funding transfer.

Limits (defaults, deployment configurable):

* `MAX_TREASURY_FUND_USDC`: 25 USDC per call
* `MAX_TREASURY_FUNDED_PER_TENANT_USDC`: 100 USDC lifetime per tenant

There is no in app faucet. Amounts above those caps are refused.

## Policy updates

Changing cap, period, payout, or allowlist enabled:

1. Manager (platform) calls `schedulePolicyUpdate`.
2. The change sits until `executableAt`.
3. Guardian may `vetoPolicyUpdate`. A vetoed policy id cannot execute until the guardian lifts it (same pattern as operating agreement hashes).
4. After the delay, manager `executePolicyUpdate`.

The dashboard reads amendment state from **your RPC**, not from the backend's word. A hash is shown as live only because a point read on chain said so.
