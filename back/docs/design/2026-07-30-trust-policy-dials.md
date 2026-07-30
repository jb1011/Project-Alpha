# Trust-policy dials: human-accountable commerce on both sides of x402

*Spec 2026-07-30, agreed direction: build the code now, ship every dial OPEN by default, flip
defaults only at real-money mainnet (v2.5/v3) once the ecosystem can comply. Vision: a Novi Corpus
agent should eventually transact only with counterparties a verified unique human answers for —
as seller AND as buyer. Research grounding: `docs/research/2026-07-30-world-identity-research.md`.*

## What exists today

| Side | Mechanism | Status |
|---|---|---|
| Seller | `X402_TRUST_POLICY = open \| accountable-only` — anonymous buyers get 403 + remediation instead of 402 | SHIPPED (global env dial, demo-proven on `/proof`) |
| Buyer | nothing — `pay` will settle against any payee the on-chain policy allows | THIS SPEC |

## Honest threat framing (why each side matters differently)

- **Seller-side** (refuse anonymous buyers): payment risk is already zero on settled x402; what
  this buys is *accountability* — sybil-resistant rate limits, abuse recourse, a human to point
  at. Brand-defining, not payment-critical.
- **Buyer-side** (refuse unverified sellers): this is where money is actually at risk — the buyer
  pays first and hopes for delivery. Verifying the seller is the higher-value control, and we
  uniquely can do it: AgentBook says "a human vouches for this address", and our own ERC-8004/ENS
  layer (`resolve_agent`) says "this is a registered legal body with live status".

## Design

### Buyer dial (new)

`X402_BUYER_TRUST_POLICY = open | verified-sellers-only` (env, default `open`).

Enforcement point: the single pay choke point (`entityPayment.pay`), BEFORE settlement and BEFORE
the idempotency claim, alongside the existing policy gate:

1. Resolve the payee address from the 402 challenge (`payTo`).
2. `agentBookReader.lookupHuman(payTo)` (our 3-state reader from PR #63 — definitive
   null vs transport throw, with the same positive/negative cache semantics via `WorldStore`).
3. Non-null → proceed. Definitive null → **deny** `seller_not_human_backed` (cacheable). Throw →
   **deny** `seller_verification_unavailable` (fail-closed, NOT cached — a World Chain outage
   must not poison a seller's standing; retry succeeds when the RPC recovers).

Denials surface through the normal policy-denial path so `pay` returns a reason, the dashboard
shows it, and nothing settles.

### Later tier (v2.5+, out of scope now)

`verified-legal-bodies-only`: payee must ALSO resolve via ERC-8004/ENS with `legalStatus=Active`
(reuse the `resolve_agent` wiring). Strictly stronger than AgentBook alone: a human vouches AND a
legal body stands behind the seller. Blocked on nothing technical — deferred purely for scope.

### Per-entity override (both dials, v2.5)

Global env dials first (matches every existing payment knob). A per-entity `trustPolicy` column
(like `per_tx_cap`) comes with the v2.5 batch so one cautious agent can go strict while others
stay open. Not now: it adds a migration + REST/MCP surface for a setting nothing yet reads.

## Defaults & rollout

- Both dials default OPEN → merging is a no-op on prod. This is deliberate: (a) most x402 sellers
  are not yet AgentBook-registered, so strict buying today means empty shops; (b) World's client
  SDK still cannot recover from a 403 (our feedback item #2), so strict selling breaks conforming
  AgentKit buyers until World ships that fix.
- Flip to strict-by-default at real-money mainnet, entity-by-entity, once (a) and (b) move.

## Test plan (TDD, mirrors PR #63's method)

- Failing-first unit tests at the pay choke point: strict+registered settles; strict+unregistered
  denies with `seller_not_human_backed` and NO settle attempt; strict+RPC-throw denies with
  `seller_verification_unavailable` and is NOT cached (second call re-reads); open = byte-identical
  behavior to today (regression pin).
- Mutation checks: flip fail-closed to fail-open on the throw branch; drop the null check — each
  must fail a named test.
- No live leg until Turnkey signing is restored (the pay path cannot settle on prod today);
  land flag-off, validate live after the plan upgrade.
