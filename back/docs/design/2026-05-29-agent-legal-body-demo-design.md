# Design: Agent Legal Body — Phase 1 Demo

> **Status:** Design for review (2026-05-29). Companion to `SPEC.md` and `RESEARCH_FINDINGS.md`.
> **Next step after approval:** implementation plan (writing-plans skill).

> ⚠️ **ARCHITECTURE UPDATE (2026-06-08):** the **custody / wallet** parts of this doc (esp. §4.4) are
> **superseded**. Custody is now **non-custodial Turnkey signer + a governed on-chain `AgentTreasury`**
> (not Circle Developer-Controlled / Agent Wallets). Source of truth:
> `2026-06-08-wallet-and-treasury-architecture.md` + `2026-06-08-agent-treasury-vault-design.md`.
> Payment rails (Gateway / x402 / nanopayments) + Arc + ERC-8004/8183 are unchanged.

---

## 1. Purpose & Audience

A working Phase-1 prototype whose primary audience is **Circle grant / DevRel reviewers**. It must:

- Tell a tight strategic story aligned with Circle's "agentic commerce" vertical.
- Make **visible, deep use of Circle Agent Stack + Arc** (not reinvent them).
- Deliver one undeniable end-to-end moment: *register an agent → it has a legal body → it transacts on Arc as itself.*

Breadth and consumer polish are explicitly **not** goals. Narrative clarity and a believable live run are.

## 2. Product in One Sentence

A user brings (or describes) an AI agent, registers it through our protocol, and receives a **legal body**: a (mocked) Wyoming DAO LLC, an on-chain identity tied to it, a policy-governed Circle wallet, and the ability to sign, pay, and be a verifiable counterparty — all wired together in one flow.

## 3. What's Real vs. Mocked

| Piece | Demo status |
|---|---|
| Circle Agent Wallet (custody, policies, USDC) | **Real** (testnet) |
| On-chain contracts on Arc (Entity, Factory, Evidence, Governance) | **Real** (Arc testnet) |
| Agent making a real USDC payment + anchoring a signed attestation on Arc | **Real** |
| MCP server + web wizard driving the flow | **Real** |
| Operating agreement + formation documents (generated from templates) | **Real artifact, NOT legally reviewed** (Phase 2) |
| The actual Wyoming state filing / EIN issuance | **Mocked** — stubbed as if completed; clearly labeled |
| KYC / "user-of-record" onboarding to Circle | **Mocked / simplified** for demo |

Honest pitch framing: *"Everything you see is live on Arc with Circle's stack. The only thing we stub is the 48-hour government filing — which Phase-2 funding makes real."*

## 4. Architecture

### 4.1 Components

1. **Web wizard** (frontend) — connect wallet → configure agent/body → "Create" → dashboard. The human-facing on-ramp.
2. **MCP server** — same operations exposed as tools so an agent/developer can do it conversationally in Claude/Cursor ("give my agent a legal body").
3. **Orchestration backend** (the brain) — the single source of truth. Both the wizard and MCP are **thin faces calling this one backend**, so "both surfaces" is not double the work. Responsibilities: run the registration workflow, call Circle APIs, deploy/configure contracts, generate documents, translate legal terms → wallet policies, hold deployer + Circle credentials.
4. **Smart contracts on Arc** (see §4.2).
5. **Circle Agent Stack** — wallet custody, spending policies, sanctions screening, USDC payments, Nanopayments/x402, Marketplace. Used as-is.
6. **Storage** — entity records (DB), generated legal documents (object storage), encrypted secrets (Circle entity secret, deployer key) in a secrets manager.

### 4.2 Smart Contracts

**Decision (verified 2026-05-29):** go **all-native on Arc** — reuse Arc's live ERC-8004 + ERC-8183 infrastructure and write exactly **one** small custom contract. Constraint: Circle wallets sit **beside** the contracts (the wallet interacts with them; they are not wallet modules).

**Reused, already live on Arc testnet (we do NOT build these):**

| Standard | Arc testnet address | We use it for |
|---|---|---|
| **ERC-8004 IdentityRegistry** (upgradeable ERC-721) | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | The agent's on-chain identity. `register(metadataURI)` mints the `agentId` NFT; `setMetadata(agentId,key,value)` stores **EIN / formation date / operating-agreement hash**; `setAgentWallet` binds the Circle wallet. |
| **ERC-8004 ReputationRegistry** | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | Verifiable "good standing" / feedback — replaces the earlier EAS plan. |
| **ERC-8004 ValidationRegistry** | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | Credential/claim validation. |
| **ERC-8183 Job contract** | `0x0747EEf0706327138c69792bF28Cd525089e4583` | The **proof-of-life**: agent takes a job → USDC escrow → deliverable → settlement. |

**Our one custom contract:**

| Contract | Origin | Role |
|---|---|---|
| **LegalManager** (per-agent, **Beacon proxy** clone) + thin **Factory/Registry** | our small custom code + OZ `AccessManager` (delay + guardian veto) + `Pausable` | The Wyoming **"managing smart contract"** (must be upgradeable ✓ via beacon). Holds the **operating-agreement hash**, links to the agent's **ERC-8004 `agentId`**, and runs the **constitution**: rule amendments, contract upgrades, and **dissolution** flow through a transparent time-delayed, guardian-vetoable process mirroring the OA. Dissolution = pause → return assets → mark dissolved (never `selfdestruct`). The **Factory** registers the agent on ERC-8004, deploys the per-agent LegalManager, binds the Circle wallet, and maintains a public **registry** ("N legal bodies created"). |

**Custom code is now minimal:** one LegalManager + a thin Factory/Registry. Identity, reputation, validation, and jobs are all reused live-on-Arc infrastructure — smallest possible audit surface, strongest "built deeply on the stack" narrative.

### 4.3 The Novel Layer: Operating Agreement ⇄ Enforcement

The differentiating engineering is the **translation layer** in the backend:

- Legal prose ("agent may spend ≤ $X/day to approved counterparties") → **on-chain `AgentTreasury` policy** (a rolling per-period USDC cap + optional allowlist) that *enforces* it. *(Updated 2026-06-08; was "Circle wallet policies".)*
- Operating-agreement amendment/dissolution clauses → **LegalManager** parameters (delay, guardian).
- A **hash of the signed operating agreement** is stored on-chain via **ERC-8004 `setMetadata`** (and referenced by the LegalManager), binding the legal document to the agent's identity.

This two-way binding (law ⇄ code) is the genuinely novel asset; the rest is integration + reuse.

### 4.4 Custody Approach — REPLACED (2026-06-08)

> This section originally weighed Circle **Developer-Controlled** vs **Agent Wallets**. Both were rejected
> for being **custodial toward the end-user** (a small platform must not become a de-facto custodian of
> every agent's funds — security single-point-of-failure + money-transmitter exposure). The Agent-Wallets
> "headless" path Circle proposed (agent reads its own email-OTP) is human-free but custodial-in-practice
> with a weak email custody root. Full reasoning: `2026-06-08-wallet-and-treasury-architecture.md`.

**Current approach — non-custodial, two-tier:**

- **Tier 1 — `AgentTreasury` (immutable on-chain contract):** holds the USDC, enforces the operating
  agreement on-chain (rolling per-period cap + optional allowlist), changeable only via a timelocked,
  guardian-vetoable policy update. The **human registrant is an on-chain guardian** (instant pause /
  revoke-operator / rescue-to-fixed-address).
- **Tier 2 — agent operator (non-custodial Turnkey enclave key):** signs autonomously within the cap;
  does x402 / Gateway / nanopayments off a low-balance hot EOA replenished from the treasury. Keys never
  leave Turnkey's enclave; neither Circle nor the platform can move funds beyond the on-chain rules.

**Agent Stack still front-and-center via the wallet-agnostic rails** — Gateway, Nanopayments/x402,
Marketplace, USDC, Arc are all unchanged; only the *custody* product changed. See
`2026-06-08-agent-treasury-vault-design.md` for the contract.

## 5. The Demo Flow (hero path)

1. User opens the wizard (or calls the MCP tool) and registers an agent — bring-your-own (connect via key/MCP) or create-from-template.
2. Backend orchestrates, live: generate operating agreement from template → create Circle (developer-controlled) wallet → **register the agent on ERC-8004** (mint identity NFT) → write EIN/formation/**OA hash** via `setMetadata` and bind the wallet via `setAgentWallet` → translate legal terms into Circle wallet policies → deploy the per-agent **LegalManager** via the Factory (wires governance + dissolution) → **stub the Wyoming filing** (labeled).
3. Within seconds, the user sees a dashboard: the entity, its wallet, its ERC-8004 identity, its registry entry, its documents.
4. **Proof of life:** the agent autonomously completes an **ERC-8183 job** on Arc — accepts a job, USDC is escrowed, it submits a deliverable, and settlement releases **real USDC** to its wallet — earning a **reputation entry** on the ERC-8004 ReputationRegistry. All visible on-chain (Arcscan).
5. Closing beat: "and an agent can do all of this itself" — the same flow triggered via the MCP server.

**Success criteria:** a reviewer watches an agent go from nothing → legally-bodied (ERC-8004 identity tied to a legal entity) → autonomously earning USDC via an ERC-8183 job on Arc, in one sitting, with every on-chain action verifiable.

## 6. Non-Goals (YAGNI)

- No custom **payments rails** (Circle provides Gateway / x402 / nanopayments). *Updated 2026-06-08: we now DO build a custom on-chain treasury + spending-policy — the immutable `AgentTreasury` contract — replacing Circle wallet policies (see §4.4).*
- No custom identity/reputation/job contracts — **reuse Arc's live ERC-8004 + ERC-8183** (don't reinvent).
- No EAS layer and no soulbound membership NFT (ERC-8004 reputation/validation covers standing; dropped per decision).
- No token-weighted DAO Governor (overkill for a single entity; OZ `AccessManager` suffices).
- No real state filing, EIN, banking integration, or legally-reviewed documents (Phase 2).
- No multi-jurisdiction (Marshall Islands etc.) — Wyoming only.
- No production-grade auth, multi-tenant hardening, or consumer polish.

## 7. Risks / Deferred to Phase 2

- **KYC / user-of-record** for an algorithmically-managed LLC onboarding to Circle — the real remaining open question; mocked in the demo, must be confirmed with Circle DevRel.
- **Legal validity** of the zero-human autonomy thesis is academically contested and untested in court (`RESEARCH_FINDINGS.md` §1) — frame as thesis, not fact.
- **Smart-contract audit** of the LegalManager before any mainnet/production use.
- **ERC-8004/8183 maturity** — they're live on Arc testnet (verified), but young standards; pin the exact ABIs at build time and watch for changes. ERC-8183 `getJob` doesn't return deliverable data (noted).
- **`evmVersion: "paris"`** required for our LegalManager or Arc rejects `PUSH0` (build-config item).
- **Operating-agreement template** quality depends on Phase-2 Wyoming-admitted counsel.

## 8. Resolved Decisions & Remaining Open Items

**Resolved (this session):**
- ✅ **All-native on Arc:** reuse ERC-8004 (identity/reputation/validation) + ERC-8183 (jobs); one custom contract (LegalManager). EAS dropped.
- ✅ **Wallet/custody (re-decided 2026-06-08):** **non-custodial Turnkey signer + immutable on-chain `AgentTreasury`** (not Circle Developer-Controlled / Agent Wallets — both custodial toward the user). Agent Stack rails (Gateway / Nanopayments / x402 / Marketplace) showcased around it.
- ✅ **Proof-of-life:** an ERC-8183 job (escrowed USDC work), not a bare transfer.

**Remaining open (settle in the plan):**
- Bring-your-own-agent vs. create-from-template: which to feature as the hero path (both supported).
- Guardian identity in the demo (settlor key vs. platform service key).
- Confirm exact ERC-8004/8183 ABIs + Arc addresses at build time via Circle MCP (addresses captured in `STACK_REFERENCE.md` §1).
- Whether to deploy LegalManager via Circle Smart Contract Platform (needs dev-controlled SCA) or Foundry.
