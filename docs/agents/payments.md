# Payments

Agents pay for HTTP resources with USDC using **x402** (HTTP 402 Payment Required). Settlement is Circle Gateway on Arc. Policy is checked by the Payment Authority (backend) and by `AgentTreasury` (on chain).

## Flow

1. The agent calls `pay` with a resource URL, an atomic amount, and an idempotency key.
2. The seller (or gateway) answers `402` with payment terms (`payTo`, asset, amount).
3. The Payment Authority evaluates policy against **fresh** chain state.
4. If allowed, the pocket signs. Gateway settles. The seller retries the resource with proof.
5. If denied, nothing is signed. The idempotency claim is released. The same key can retry.

## What policy looks at

* Entity exists, owned by this tenant, bound, legally `Active`, not paused
* Amount ≤ software per transaction cap
* Amount ≤ on chain remaining period cap
* Recipient allowed (if allowlist enabled)
* Trust dials (see below)
* Pocket has float (otherwise you must `fund_pocket` first)

## Units

MCP `pay`, `fund_pocket`, and `fund_treasury` take **atomic** USDC: an integer string with 6 decimals.

```text
1.00 USDC  →  "1000000"
0.05 USDC  →  "50000"
```

Hex, scientific notation, and decimal points are rejected.

REST funding in the wizard uses human decimal strings. Do not mix the two.

## Trust dials

| Dial | Env | Default | Effect |
| --- | --- | --- | --- |
| Seller | `X402_TRUST_POLICY` | `open` | `accountable-only`: refuse buyers with no human backing (`403`, not `402`) |
| Buyer | `X402_BUYER_TRUST_POLICY` | `open` | `verified-sellers-only`: refuse `payTo` addresses AgentBook cannot confirm |

Fail closed on transport errors for seller verification so an RPC outage cannot be cached as "this seller is fine."

A later tier, not shipped as default, is "verified legal bodies only": the payee must also resolve through ERC-8004 / ENS as `Active`.

## Demo seller

The backend can host an x402 demo resource used from `/personhood`. World / AgentBook verification is separate from Arc USDC settlement. The payee can be on any chain World lists, including Arc.

## What the Graph can and cannot see

A subgraph only indexes **events**. Incoming transfers and some tiny x402 legs may not announce. Treat indexed data as the **governance view** (spends the vault emitted, pauses, policy events), not a complete bank statement. Today's deployed subgraph is a walking skeleton. Do not build alerting on it yet.
