# Design: Governed Nanopayment Agent (x402 + Circle Gateway on the Agent Legal Body)

> **Status:** ✅ current — design (brainstormed 2026-06-16).
> **Context:** Submission design for the **Lepton Agents Hackathon** (Canteen, sponsored by **Arc × Circle**,
> June 15–29 2026, theme: *nanopayments*). Built as an **additive layer on top of the existing, live**
> Agent Legal Body protocol — see [wallet-and-treasury-architecture](./2026-06-08-wallet-and-treasury-architecture.md),
> [agent-treasury-vault-design](./2026-06-08-agent-treasury-vault-design.md), and
> [backend-onboarding-brain-design](./2026-06-09-backend-onboarding-brain-design.md).
> **The existing protocol (contracts, onboarding saga, Turnkey signer) is UNCHANGED and reused as deployed
> on Arc testnet** (proven live 2026-06-16: agentId `656785`, operator `0x46DE…BF0` bound non-custodially).

---

## 1. Goal & primary optimization target

Optimize for a **Circle grant recommendation**: novel, credible Arc + Circle infrastructure with a polished,
legible demo. Hackathon prize placement / traction is secondary, so we favor a sharp demonstration of our
unique value over seeding real user volume. Lower build risk in the ~13-day window.

## 2. Thesis (the pitch)

> Everyone in this hackathon will build *an agent that can pay*. We build the **legally-accountable,
> guardian-governed body that makes an agent safe to be trusted with money** — and x402 + Circle Gateway is
> how that body **spends and earns at nanoscale**.

**Value to Circle (sharpened):** we do not improve Circle's batching — we **unlock a customer segment for it.**
Circle already has nanopayment rails (Gateway, x402); the blocker to *agent* adoption is accountability —
no institution/human will let an autonomous agent put real money on those rails without bounds. Our legal
body + guardian + policy envelope is exactly that missing trust layer, expanding *who* can safely transact on
Circle's nanopayment stack. That is a market-expansion story, not a volume story.

## 3. Scope decisions (locked in brainstorm 2026-06-16)

| Decision | Choice |
|---|---|
| Primary goal | Circle grant recommendation (credibility + novelty > traction) |
| Agent role | **Two-sided**: the agent both **buys** inputs and **sells** an output |
| Vertical | **Insight/research agent**: buys raw data per-call, synthesizes, sells answers per-query |
| Payment depth | **Real x402 + Circle Gateway batching** (`@circle-fin/x402-batching`), spiked first to de-risk |
| Governance architecture | **Approach 1** — policy-gated signing Authority + treasury-funded Gateway cap |
| Agent brain | Claude-driven loop — default **Sonnet 4.6** (`claude-sonnet-4-6`); **Opus 4.8** (`claude-opus-4-8`) for max agentic sophistication |

## 4. Core principle — tiered payments by class (NOT a switch to off-chain)

We do **not** move from on-chain to off-chain. We **keep both** and route by payment class. The legal body
governs both under one policy + guardian envelope.

| Payment class | Rail | Why |
|---|---|---|
| Nanopayments (sub-cent, high-frequency, pay-per-call/sec) | **Off-chain x402 → Circle Gateway batch settle** | On-chain gas makes these economically impossible |
| Large / critical (payout, big purchase, treasury move) | **On-chain `AgentTreasury.spend()`** (existing) | Trustless contract enforcement + instant finality + per-tx audit worth the gas |

This is also a *strength* for the pitch: the protocol demonstrably governs **both** on-chain payments and
off-chain nanopayments coherently.

### 4.1 Signing-cost tier — the enclave signs *governed top-ups*, not individual payments (decided 2026-06-17)

A second tiering axis, as important as gas: **secure-enclave signing is metered**. Turnkey bills *per
signature*, and by its own definition "a signature is a transaction — whenever money moves or a financial
action is authorized." Pricing (verified 2026-06-17): free tier **25 signatures/month**, then **$0.10/sig**
(pay-as-you-go), **$0.05/sig** (Pro, $99/mo), down to **~$0.0015/sig** (enterprise).

**So one enclave signature per payment is economically impossible for nanopayments.** A sub-cent payment
($0.000001–$0.01) signed at $0.0015–$0.10 costs **1.5×–100× the payment itself**. Per-payment enclave
signing only makes sense for large/critical payments, where the fee is negligible against the value moved.

**Decision — the "vault refills the pocket" model:**

| Role | Key | Signs | How often | Turnkey cost |
|---|---|---|---|---|
| **Vault** | Turnkey enclave key (the operator / bound `agentWallet`) | governed treasury top-ups + large on-chain `spend()` | rarely | 1 sig each (negligible vs value) |
| **Pocket** | a bounded hot / session key | the high-frequency nanopayment x402 authorizations | constantly | **free** (not a Turnkey sig) |

The treasury's existing `fundOperator(amount)` — *"top up the operator's hot EOA for x402/Gateway/
nanopayments, within the same cap"* — is the on-chain primitive: the **vault** pushes a small, capped float
to the **pocket**; the **pocket** signs the thousands of micro-payments itself. The enclave is touched only
to refill, so **Turnkey cost is O(governed top-ups), not O(payments)** — one refill covers thousands of
payments, independent of payment volume.

**Safety / non-custody preserved:** the pocket only ever holds the bounded float, so its worst-case loss is
that float — never the treasury. The treasury stays non-custodial and governed; the guardian's `pause` /
`emergencyWithdraw` still freeze and sweep everything. This is the standard bounded-hot-wallet trade-off,
sized by the on-chain cap.

**This refines §5/§6:** for the *nanopayment* tier the per-payment signer is the **pocket** key, not the
enclave; the Authority's Turnkey call happens at **top-up** time (and for the large/critical tier), not on
every `/authorize`. Pitch line: *we keep secure-enclave signing O(governed actions), not O(payments) — the
only way nanopayments are viable alongside real, non-custodial key security.*

## 5. Architecture

Left of the line is reused as-deployed; right of the line is the new hackathon build.

```
        REUSED (live on Arc testnet)         │            NEW (hackathon build)
                                             │
  ERC-8004 identity + LegalManager           │   ┌─────────────────────────────────────┐
  AgentTreasury  (cap / period / allowlist / │   │  Insight Agent (Claude-driven loop)  │
   payoutAddress, guardian pause/veto/        │   │  decides what data to buy (cost-     │
   emergencyWithdraw, operator.spend)         │   │  aware), synthesizes, prices+serves  │
  TurnkeySigner (enclave key = agentWallet)  │   └──────┬───────────────────────┬───────┘
  Onboarding saga (entity creation)          │          │ buy (inputs)          │ sell (output)
                                             │   ┌──────▼──────┐         ┌──────▼──────┐
                                             │   │ x402 Buyer  │         │ x402 Seller │
                                             │   │  client     │         │ (paywalled  │
                                             │   └──────┬──────┘         │  /api/insight)
                                             │          │ POST /authorize └──────┬──────┘
                                             │   ┌──────▼───────────────────────▼──────┐
                                             │   │   PAYMENT AUTHORITY SERVICE (moat)   │
                                             │   │  gate every payment:                 │
                                             │   │  allowlist + cap + velocity + paused?│
                                             │   │  → then Turnkey signs the x402 auth  │
                                             │   └──────┬───────────────────────────────┘
                                             │          │ funds Gateway up to available()
   AgentTreasury.spend ──────────────────────┼─────────▼  Circle Gateway (x402 batching) → on-chain settle
```

### Reused components (no changes)
- **ERC-8004 identity + `LegalManager` + `LegalManagerFactory`** — the on-chain legal body.
- **`AgentTreasury`** — governed USDC vault: rolling `cap`/`period`, `allowlistEnabled`, `payoutAddress`,
  guardian `pause`/`veto`/`emergencyWithdraw`, `available()` view, `spend(to,amount) onlyOperator`.
- **`TurnkeySigner` / `buildOperatorSigner`** — non-custodial EIP-712 operator signer (enclave key).
- **Onboarding saga** — creates/binds the entity (already proven live).

### New components (purpose / interface / depends-on)
1. **Payment Authority Service** — *the novel core* (detailed in §6). `POST /authorize {payee, amount,
   resource}` → signed `X-PAYMENT` **or** `policy-denied`. Depends on `TurnkeySigner`, on-chain
   `AgentTreasury` reads, Gateway client, a spend-ledger.
2. **x402 Buyer client** — wraps the agent's outbound HTTP: on `402`, request an authorization from the
   Authority, retry with `X-PAYMENT`. Depends on the Authority.
3. **x402 Seller** — the agent's own paywalled `/api/insight` endpoint: `402` → verify `X-PAYMENT` → serve.
   Earns USDC into the treasury via Gateway settlement. Depends on an x402 facilitator/verifier.
4. **Insight Agent** — the Claude-driven loop: cost-aware decision on which paid data to buy, synthesize,
   price, serve. Depends on the Buyer client + the Seller + an LLM.
5. **Treasury↔Gateway funding bridge** — tops up the agent's Gateway balance from the treasury up to
   `available()` (the on-chain cap layer). Depends on `AgentTreasury` + Gateway.
6. **Demo dashboard** — live reasoning, payments in/out, treasury P&L + remaining cap, and a guardian
   **pause** button. The <3-min video surface. Depends on read APIs over the above.

## 6. The Payment Authority Service (deep dive)

**What it is.** A small HTTP backend service (a new TypeScript module/sibling to the existing backend) — the
agent's *comptroller*. It is mostly an assembly of code we already have: the signing piece = existing
`TurnkeySigner`/`buildOperatorSigner`; the policy piece = existing `agentSpec`/policy logic
(cap/period/allowlist); plus a SQLite spend-ledger; wrapped in one `POST /authorize` route. **No LLM** —
deterministic checks only.

**What it holds (and why it's "trusted").** The Turnkey API credentials (`TURNKEY_*`) — i.e. the
*authorization to request signatures* from the operator's enclave key. **The private key never leaves
Turnkey's enclave** (custody model preserved: non-custodial). The Authority can only ask Turnkey to sign a
specific payment; it cannot export the key. Whoever controls the Authority controls *when* the operator key
signs — that is the trust it carries.

**What it does, per payment:**
```
agent → POST /authorize {payee, amount, resource}
  read on-chain: treasury.available(), allowlist, paused?
  check:  payee ∈ allowlist?  runningSpend + amount ≤ available?  rate ok?  not paused?
    ├─ pass → Turnkey signs x402/EIP-3009 authorization → record spend in ledger → return X-PAYMENT
    └─ fail → return "policy-denied"   (the agent gets NO signature)
```

**Why it's separate from the agent.** The agent (the fallible LLM loop — can hallucinate or be
prompt-injected) is given **no key at all**; it can only *ask* the Authority. This makes the agent
**structurally incapable** of paying outside policy — the off-chain analogue of the contract's `onlyOperator`
guard.

**Security model / "run and secure".** Protect the Turnkey creds, authenticate the `/authorize` caller (only
the agent), keep it available, keep the ledger correct. **Blast radius if fully compromised = `available()`
(the current period's cap), never the treasury** — because the treasury only funds Gateway up to the cap and
the guardian can `pause`/`emergencyWithdraw` on-chain. Bounded, not catastrophic. **Defense in depth:** the
Authority's Turnkey API key can be scoped (sub-org/policy) to sign *only* for this one operator wallet.

## 7. Data flows

**Funding (periodic / on demand):** Treasury → fund the agent's Gateway balance up to `available()`. Gas only
at top-up. Guardian `pause` stops top-ups; `emergencyWithdraw` reclaims unspent.

**Buy flow (agent spends):**
1. Agent calls a paywalled data endpoint → `402 Payment Required` (price, recipient, asset, network).
2. Buyer client → `POST /authorize` to the Authority.
3. Authority runs the policy gate; on pass, Turnkey signs the off-chain x402/EIP-3009 authorization.
4. Buyer retries with `X-PAYMENT`; data returned.
5. Gateway batches many such authorizations → one on-chain settlement on Arc.

**Sell flow (agent earns):**
1. A buyer calls the agent's `/api/insight` → `402` with the agent's price + treasury-linked recipient.
2. Buyer signs an x402 authorization; agent's Seller verifies it (facilitator) and serves the answer.
3. Revenue settles (via Gateway batch) into the treasury → on-chain P&L: revenue in, input costs out.

**The two demo "killer moments" (un-bypassable because of Approach 1):**
- **Policy-reject:** the agent tries an **off-allowlist** or **over-cap** payment → Authority returns
  `policy-denied` → the agent cannot pay. Vanilla x402 demos cannot show this.
- **Guardian-freeze:** the guardian hits on-chain `pause` → the Authority observes it and **stops signing
  mid-stream** → the agent freezes live on the dashboard.

## 8. Error handling & governance edges
- **Policy-denied** — off-allowlist, over-cap, rate-exceeded, or paused → deterministic `policy-denied`,
  surfaced to the agent (it should degrade gracefully: skip the purchase, lower spend, or stop).
- **Expired / invalid x402 authorization** — Authority sets short expiries; verifier rejects stale/forged
  auths (same discipline as the on-chain bind's verified 300s `MAX_DEADLINE_DELAY` window).
- **Settlement failure / reconciliation** — the Authority's off-chain ledger is the source of truth for
  in-flight spend; a batch that fails to settle is retried; the ledger reconciles to on-chain settlements.
- **Double-spend** — the Authority is the *single* signing chokepoint + single ledger, so concurrent requests
  are serialized against `available()` (single-runner per agent for v1).
- **Authority compromise** — bounded by `available()` + guardian (see §6).
- **Liveness** — if the Authority is down, the agent cannot pay. Acceptable for the demo; HA is a v2 item.

## 9. Testing
- **Unit:** the policy gate (allowlist / cap / velocity / paused permutations); x402/EIP-3009 authorization
  build + verify; ledger accounting against `available()`.
- **Integration:** buy + sell against a local seller and a Gateway test path; assert a **guardian `pause`
  halts signing** and an **over-cap payment is denied** (the two demo moments as automated tests).
- **Reuse:** existing anvil harness + the live Arc-testnet path already wired in the backend.
- **Demo dry-run:** a scripted end-to-end that produces the exact sequence shown in the video.

## 10. Build sequencing (~13 days) & deliverables
1. **Days 1–3 — Gateway/x402 spike (de-risk first).** Prove `@circle-fin/x402-batching` (`GatewayClient`)
   round-trips on Arc testnet with our operator key signing an authorization. Fall back to Approach-1 with
   simpler settlement only if the SDK blocks us.
2. **Authority service** (assemble `TurnkeySigner` + policy + ledger + `/authorize`).
3. **Buyer client + Seller** (x402 in and out).
4. **Insight Agent loop** (Claude reasoning, cost-aware buying).
5. **Funding bridge** (treasury → Gateway up to `available()`).
6. **Dashboard** (reasoning + P&L + cap + guardian pause).
7. **Polish:** the two killer moments, the <3-min video, a live deploy.

**Deliverables (hackathon):** public GitHub repo, <3-min demo video, live deployed product (encouraged),
brief traction notes. Progress tracked via the `arc-canteen` CLI (`login`, `update-traction`,
`update-product`).

**Repo & secret hygiene:** the existing repo is the private/shared team repo; the hackathon requires a
**public** repo. Carve out a public repo that builds on the already-deployed contracts (reference deployed
addresses; import/trim the backend pieces). **Before anything goes public: rotate the Turnkey API key /
use a throwaway sub-org**, and confirm no secrets in git history (`.env` is gitignored; Phase-1 audit found
history clean).

## 11. Trade-offs: fully on-chain vs hybrid (recorded for the writeup)
- **Fully on-chain (`spend()` only):** trustless per payment, instant finality, full per-tx audit, nothing
  extra to run — but gas per payment makes nanopayments impossible.
- **Hybrid (+ off-chain x402/Gateway):** economically viable nanopayments, instant per-payment auth, real
  Circle rails, settlement lands on-chain in aggregate, on-chain cap + guardian backstop — at the cost of a
  trusted Authority, settlement lag + reconciliation, a new attack surface + liveness dependency, and
  per-nanopayment auditability that lives in an off-chain ledger. **All downside is bounded by the on-chain
  cap + guardian.**

## 12. v2 / hardening (post-hackathon)
- **Verifiable Authority** — push enforcement toward a TEE / ZK / on-chain checkpoints so per-payment policy
  is trust-minimized (turn the "trusted service" into a "verifiable service").
- **Turnkey policy scoping** — constrain the Authority's API key at the Turnkey layer.
- **HA / liveness** for the Authority; trustworthy/auditable off-chain ledger for clean entity books.
- **Agent-to-agent (RFB #3)** — two governed agents transacting; multi-source data.
- See [V2_HARDENING_BACKLOG.md](../V2_HARDENING_BACKLOG.md) for the existing protocol's deferred items.

## 13. Open questions / risks
- **Gateway batching SDK** availability + limits on Arc testnet (the Day 1–3 spike resolves this; it is the
  top risk).
- **Seller-side x402 verification** — use Circle's facilitator vs self-host a verifier.
- **Public-repo carve-out** from the private team repo (what to vendor vs reference).

## 14. References
- Hackathon overview: Lepton Agents Hackathon (Canteen, Arc × Circle).
- Reference implementation: `circlefin/arc-nanopayments` (Next.js seller + LangChain buyer +
  `@circle-fin/x402-batching`).
- x402 protocol: Coinbase x402 docs; Circle "Autonomous Payments with Circle Wallets, USDC & x402".
- Existing protocol designs: [custody/treasury architecture](./2026-06-08-wallet-and-treasury-architecture.md),
  [treasury vault](./2026-06-08-agent-treasury-vault-design.md),
  [onboarding brain](./2026-06-09-backend-onboarding-brain-design.md).
