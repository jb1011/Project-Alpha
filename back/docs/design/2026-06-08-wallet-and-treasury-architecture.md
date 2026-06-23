# Design: Wallet Custody & Treasury Architecture

> **Status:** Decision draft (2026-06-08). Supersedes the wallet-custody sections of `RESEARCH_FINDINGS.md` and the earlier "build on Developer-Controlled Wallets" lean.
> **Companion to:** `SPEC.md`, `2026-05-29-agent-legal-body-demo-design.md`, `STACK_REFERENCE.md`.
> **Confidence:** Wallet-provider claims are from a deep-research pass (25 sources, 3-vote adversarial verify, 2026-06-08). Items not yet verified are flagged ⚠️ and tracked in §7 (research run `w6nrzmk2b` pending at time of writing).

---

## 0. TL;DR (the decisions)

1. **Custody model:** go **non-custodial toward the end-user**. The platform must NOT become a de-facto custodian of every agent's funds (security single-point-of-failure + money-transmitter/custody-licensing exposure for a small platform).
2. **Wallet/key layer:** **Turnkey** is the primary choice — non-custodial TEE-enclave keys, headless autonomous signing via persistent *Delegated Access*, in-enclave policy engine, externally audited (Trail of Bits, Cure53). **Crossmint** is the strong secondary (ERC-4337 smart accounts + AI-agent dual-key + agent-commerce tooling), brought in only if its features become core.
3. **Treasury architecture:** **Model B — governed on-chain treasury contract** (NOT wallet-as-treasury). The LLC operating agreement is enforced *on-chain*; the agent is a **bounded operator**, not the owner of the money. We already have governance/treasury/identity contracts on Arc, so Model B is half-built.
4. **Strongest build:** a **two-tier "vault + operating wallet"** design — a governed treasury contract (Tier 1) that holds the bulk of USDC and replenishes a low-balance agent operating wallet (Tier 2) within on-chain limits.
5. **"The combine":** Turnkey and the smart-account layer are *different layers* (key vs account). You can run an ERC-4337 / Safe smart account whose **signer is a Turnkey enclave key**. ⚠️ Feasibility on Arc under research (`w6nrzmk2b`).

---

## 1. Why we left Circle's wallets as primary

### 1.1 Developer-Controlled Wallets = custodial toward the user
2-of-2 MPC where **Circle holds one share and our backend holds the entity secret**. Circle is a security backstop, not a user-protecting gatekeeper — it co-signs whenever our entity secret authorizes. **The end-user holds no key and has no veto.** So from the user's perspective it is **custodial**: our platform controls their agent's funds. For a small/new platform this is the exact trust + MTL exposure we want to avoid. (Confirmed headless; fine as a throwaway prototype path only.)

### 1.2 Agent Wallets (user-controlled) — Circle DevRel answer (2026-06, ticket reply from "Echo")
- **Q1 (headless?):** "Accessing an agentic wallet through Circle CLI is headless. The email-OTP is just the requirement to make it self-custodial for the end-user side. If the AI agent has access to email services (Gmail, Agentmail, etc.) it can execute everything on its own without a human in the loop."
- **Decoded:** the email-OTP is **not removed** — it's the user-share unlock, and it is made *human-free* by giving the agent its own inbox to read its own OTPs. **Session-lifetime question was NOT answered** → likely recurring, not one-time-at-creation.
- **The trilemma (pick 2 of 3):** {autonomous (no human)} + {Agent Wallet} ⇒ inbox controlled by agent/platform ⇒ **custodial again**, with an *email inbox* as the key-custody root (phishable, weak attack surface). {non-custodial (user holds share)} + {Agent Wallet} ⇒ human reads OTPs ⇒ **not autonomous**. You cannot get all three.
- **Consequence:** for an autonomous agent, Agent Wallets are custodial-in-practice with a **weaker** custody root than even Dev-Controlled (email vs 32-byte entity secret). New Circle-native hierarchy: **Dev-Controlled > Agent Wallets** for our use case.
- **Q2 (dev self-custody MPC share on Arc):** doc pointer only — unanswered. **Q3 (Marketplace wallet-type req) & Q4 (KYC/user-of-record for an algorithmic LLC): still pending** — Q4 is the genuinely important production gate.

> Open follow-up still to send: is the OTP one-time-at-provisioning or recurring-per-session, and what is the session lifetime? Does the CLI + spending-policy path execute within policy *without* an OTP per session?

---

## 2. Wallet/key-provider comparison (verified 2026-06-08)

All of Crossmint, Turnkey, Privy **and** Circle are confirmed **Arc ecosystem partners** in Circle's Arc public-**testnet** press release (2025-10-28). ⚠️ MAINNET partner status unverified for all of them.

| Dimension | **Turnkey** | **Crossmint** | **Privy** | Circle Dev-Controlled | Circle Agent Wallets |
|---|---|---|---|---|---|
| Layer | Signer/key infra (EOA default) | Smart-account platform (ERC-4337) | Embedded wallets | MPC | MPC |
| Non-custodial to user | ✅ if user = sole sub-org root (config) | ⚠️ only via dual-key (server-signer-only = custodial) | ⚠️ Model 2 only | ❌ | ✅ share, but see trilemma |
| Headless autonomous | ✅ persistent Delegated Access (P-256 key) | ✅ Server Signer (secret in your infra) | ✅ both models | ✅ entity secret | ❓ via agent-email OTP automation |
| Human-owner override | ✅ root ≠ agent key; co-approval + lock | ✅ dual-key owner | ✅ Model 2 (revocable) | ❌ | ✅ (= the signing dependency) |
| Guardrails | in-enclave policy engine (**off-chain**) | smart-account modules (**on-chain**) | per-signer policies (off-chain) | build-your-own | wallet-layer policies |
| Audits | Trail of Bits, Cure53 | Halborn | vendor docs | Circle | Circle |

**Nuance:** Turnkey is best described as *"infrastructure-mediated self-custody"* (keys in Turnkey-operated AWS Nitro enclaves, not on a user device) — still non-custodial (Turnkey can't access raw keys), worth stating plainly in trust docs.

**Why Turnkey primary:** strongest + best-audited non-custodial guarantee, inherent (not config-fragile) once the registrant is provisioned as root; headless autonomy is the documented use case (no email/OTP); lowest lock-in (swappable signer); can later sign *under* a smart account. On Arc, **USDC-as-gas removes the "gasless" reason** to adopt ERC-4337 up front, lowering Crossmint's headline advantage.

---

## 3. Treasury architecture — the core decision

**The real question:** is the operating agreement enforced in a *wallet config* or in a *contract*?

| | Model A — wallet-as-treasury | **Model B — governed treasury contract (CHOSEN)** |
|---|---|---|
| Operating agreement | vendor/wallet config | **on-chain, auditable == the LLC charter** |
| Maps to Wyoming DAO LLC | weak ("agent has a wallet") | **strong (entity's treasury; agent is its bounded agent)** |
| Custody exposure | wallet key is the control point | **funds governed by code; wallet only requests within on-chain rules** |
| Blast radius if agent key leaks | up to wallet limits | **capped by contract; governance revokes the agent** |
| Human override | vendor feature (off-chain) | **on-chain guardian role (provable)** |
| Provider lock-in | high | **low — wallet is "just a signer"** |
| Grant/differentiation | commodity | **"governed on-chain treasury enforcing an operating agreement" (novel)** |
| Complexity/audit | lower | higher (treasury is a high-value target — must be audited) |

**Decision: Model B.** Decisive reason — we **already have governance/treasury/identity contracts on Arc** (`LegalManager.sol`, `LegalManagerFactory.sol`, ERC-8004/8183 identity), so Model B is half-built, and it reduces the wallet to "a non-custodial signer the treasury authorizes" → exactly Turnkey's strength, and makes Crossmint's on-chain-module feature largely **redundant with contracts we already wrote**.

---

## 4. The strongest build — two-tier vault + operating wallet

```
┌─────────────────────────────────────────────┐
│  TIER 1 — GOVERNED TREASURY (the legal body) │
│  on-chain contract / Safe / smart account     │
│  • holds the USDC treasury                     │
│  • operating agreement = on-chain rules        │
│    (caps, allowlists, timelocks, approvals)    │
│  • ERC-8004 identity attached                  │
│  • HUMAN REGISTRANT = on-chain GUARDIAN        │
│    (pause / emergency-withdraw / revoke agent) │
└───────────────┬───────────────────────────────┘
                │ authorizes + replenishes within on-chain limits
                ▼
┌─────────────────────────────────────────────┐
│  TIER 2 — AGENT OPERATING WALLET (hot, low $) │
│  • small replenishable balance for 24/7 ops   │
│  • does x402 / Gateway micro-payments natively │
│  • KEY HELD IN TURNKEY ENCLAVE (non-custodial) │
│  • scoped delegated key; if leaked, loss ≤ cap │
└─────────────────────────────────────────────┘
```

**Properties:** the treasury *is* the legal body (strongest lawyer/regulator/grant story); custody is in code not a vendor; bounded blast radius; provider-agnostic; payments stay simple because Tier 2 is a normal EOA doing EIP-3009 (no EIP-1271 needed).

**Prototype vs production:** for the demo, collapse to *treasury contract + one Turnkey-signed operator that pulls within limits*. The separate hot wallet is a production refinement (capital efficiency + blast radius) — don't over-build it for the demo.

---

## 5. "The combine" — Turnkey + a smart-account layer

Turnkey (key layer) and Safe/ZeroDev/Crossmint (account layer) are **complementary, not competing**. An ERC-4337 / Safe account needs an owner/signer key — that key can be a **Turnkey enclave key**. Result: on-chain programmable limits **and** enclave-grade non-custody, human registrant as guardian, agent as a scoped session key.

- Most-trodden combine: **Turnkey + Safe** or **Turnkey + ZeroDev** (Turnkey-as-signer is documented there). Treasuries especially favor **Safe** (most-audited treasury primitive).
- **Turnkey + Crossmint** depends on Crossmint supporting a bring-your-own Turnkey signer — ⚠️ to verify.
- Only adopt the smart-account layer if you want its features (session keys, batching, on-chain modules, agent-commerce checkout). On Arc, gas sponsorship is largely moot (USDC gas).

---

## 6. Recommendation (current)

1. **Treasury → Model B**, built on our existing governance/treasury contracts (extend them, or wrap/migrate to **Safe** — see §7b pending research).
2. **Agent wallet → non-custodial Turnkey enclave key**, authorized by the treasury as a bounded operator (Tier 2).
3. **Human registrant → on-chain guardian role** on the treasury (override lives on-chain, not in a vendor).
4. **Crossmint → only if** agent-commerce / smart-account session-keys become core, and then via the combine.

Net: Model B makes **Turnkey the clear wallet** and reduces Crossmint to an optional account-layer feature pack.

---

## 7. Research findings — run `w6nrzmk2b` (2026-06-08)

> ⚠️ The session cap killed the final adversarial-verification pass: 7 claims are **[VERIFIED]** (3-0/2-0);
> the rest are **[UNVERIFIED — primary source]** (the skeptic votes never ran — "0-0 abstain", NOT refuted).

**(a) The combine — Turnkey-as-signer under a smart account:**
- **[VERIFIED]** Turnkey-as-signer works at the SDK level: documented for **Safe** (Cometh SDK `createSafeSmartAccount`; Polymarket `turnkey-safe-builder-example` — Turnkey EOA = Safe owner), and Turnkey has signer docs for **ZeroDev** and **Pimlico**. The combine is real and well-trodden (esp. Turnkey + Safe / Turnkey + ZeroDev).
- **[VERIFIED] Arc deployment caveat:** Arc's official contract-addresses page is **TESTNET-ONLY** ("Mainnet addresses are not yet available"), and lists **NO** canonical Safe singleton/factory, **NO** ERC-4337 EntryPoint, **NO** ZeroDev Kernel, **NO** AA bundler/paymaster. → the smart-account *account layer* is **not documented as deployed at canonical addresses on Arc**. Turnkey, ZeroDev, Crossmint are named Arc **testnet** partners; **Safe is NOT** in the partner list.

**(a) EIP-1271 / x402 verdict (can a smart-contract treasury pay via x402 directly?):** NUANCED — **don't rely on it.**
- **[UNVERIFIED]** Token level: USDC implements **ERC-7598**, which extends EIP-3009 to accept **smart-contract (EIP-1271) signatures** (Circle's own `cpn/wallet-provider-compatibility` doc + EIP-7598). So at the USDC layer, an SCA *can* in principle authorize `transferWithAuthorization` via `isValidSignature`.
- **[UNVERIFIED]** But the **x402 'exact' EVM scheme spec** describes ECDSA `recovers-to` verification and **does NOT mention EIP-1271** in the payment path (EIP-1271 appears only in the unrelated ERC-7710 delegation section). → a given **x402 facilitator may reject contract-signature authorizations**. Gateway (Circle-native) is likelier to accept them than a Coinbase x402 facilitator.
- **→ Conclusion:** treasury-direct x402 is *possible* (esp. via Gateway + USDC/7598) but **not guaranteed**. The **two-tier design sidesteps the whole question** — Tier 2 is a normal EOA doing ECDSA EIP-3009, no EIP-1271 dependency. This **vindicates the two-tier architecture.**

**(b) Safe on Arc + Safe modules:**
- **[VERIFIED]** Safe is **NOT confirmed on Arc** — no canonical addresses on Arc's contract page, not in the Arc partner list. Adopting Safe on Arc would mean **self-deploying** the Safe suite + modules (incl. the `evmVersion:"paris"`/PUSH0 gotcha) and trusting it works.
- **[UNVERIFIED — primary]** Safe's **AllowanceModule** = per-token, per-delegate spending limits with **time-reset recurring allowances** (e.g. 100 USDC/day); Safe ships an official **"AI agent with spending limit"** quickstart (`addDelegate` + `setAllowance`). Delegates must be **EOAs** (no EIP-1271) — fine for us (our agent operator is a Turnkey EOA). **Zodiac Roles Modifier** = scoped target/function/param permissions; **Delay Modifier** = timelock. ⚠️ Roles Modifier canonical deploy covers 18+ chains but **NOT Arc**.

### Decision on (b): **EXTEND our own contracts** (don't adopt Safe — yet)
Rationale: Safe isn't on Arc, so "adopt Safe" really means *self-deploy Safe + modules on Arc* — **more work and risk** than extending the `LegalManager` contracts we already deploy on Arc (100% test coverage, ERC-8004/8183 already integrated, paris gotcha already handled). We don't need Safe's generality; the agent-operator + caps + guardian pattern is small. **Model the design on Safe's proven primitives** (AllowanceModule's per-delegate time-reset allowance; Zodiac Roles' scoped permissions) without the deployment dependency. Revisit Safe only if/when it's canonically on Arc and we want its multisig/module ecosystem + institutional brand.

**Consequence:** with Tier-1 = our own contracts and the agent = a **Turnkey non-custodial EOA**, the "combine" **reduces to Turnkey EOA + our contracts** — we may **not need Safe/ZeroDev/Crossmint at all** for the core. They stay optional (agent-commerce, multisig) for later.

## 8. Still open / to confirm
- **Circle:** Q1 (OTP one-time-vs-recurring + session lifetime) and Q3 (Marketplace wallet-type req) still open. **Q4 KYC / user-of-record — ✅ RESOLVED 2026-06-12:** a natural-person controller-of-record is mandatory, triple-locked (WY DAO LLC statute W.S. 17-31-114 + FinCEN CDD control prong + Circle terms); a fully memberless entity is foreclosed → realistic model = **human-controller + agent-bounded-operator** (our existing guardian role = that controller). ⚠️ **Agent Stack re-eval:** the May-2026 Circle Agent Stack frames Agent Wallets as non-custodial 2-of-2 MPC *delegates* — more favorable than §1.2's email-OTP read. If reconsidered vs Turnkey, re-verify how the agent unlocks/uses its share autonomously and what the practical custody root is (still unconfirmed); the §1.2 trilemma may or may not still hold under the new product.
- **Turnkey:** ✅ **[VERIFIED 2026-06-12]** Delegated Access is Turnkey's documented headless pattern (P-256 agent key, no session/OTP); an exclusive end-user-passkey-root sub-org is supported — `CREATE_SUB_ORGANIZATION_V7` with both users at creation → scoped `EFFECT_ALLOW` policy → `UPDATE_ROOT_QUORUM` demotes the agent, leaving the user sole root. Parent org is read-only over sub-orgs (can't move funds; can't delete without the sub-org's participation). Caveat: Turnkey's policy engine is **stateless per request** → only per-tx guardrails live there; cumulative/temporal limits stay on-chain (Tier-1 treasury). Confirm exact *revoke* activity names when coding M4.
- **EIP-1271/x402:** if we ever want treasury-direct payments, verify Gateway + USDC/7598 accept SCA signatures on Arc (re-run the killed verification pass).
- **⚠️ Mainnet:** every Arc confirmation is *testnet*-era; mainnet availability + vendor mainnet support unverified. Pricing at multi-tenant scale uncosted.
