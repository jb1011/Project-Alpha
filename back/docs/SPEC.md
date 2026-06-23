# Project Spec: Giving AI Agents a Legal Body

> **Status:** v0 working document. Continuously updated.
> **Purpose:** Full context for Claude Code (or any AI dev assistant) to continue research, design, and implementation.
> **Last research pass:** 2026-05-29 — verified claims against primary sources; corrections inline (marked "⚠️ Research correction"). Full cited write-up in `RESEARCH_FINDINGS.md`.

> ⚠️ **ARCHITECTURE UPDATE (2026-06-08) — wallet / custody / treasury sections below are SUPERSEDED.**
> Current source of truth: `docs/design/2026-06-08-wallet-and-treasury-architecture.md` (custody decision)
> and `docs/design/2026-06-08-agent-treasury-vault-design.md` (the `AgentTreasury` vault). **What changed:**
> custody moved off Circle's wallet product → **non-custodial Turnkey signer + a governed on-chain
> `AgentTreasury` contract** (funds live on-chain, the agent is a *bounded operator*, the human registrant
> is an *on-chain guardian*). Circle **payment rails (Gateway / x402 / nanopayments) + USDC + Arc are
> unchanged** — only the wallet/custody product changed. Older wallet/custody passages are kept for history.

> ⚖️ **LEGAL-MODEL UPDATE (2026-06-12) — the "Bayern / zero-member / fully-autonomous" framing below is
> SUPERSEDED.** Research verified against primary sources foreclosed the human-less entity: a named,
> KYC'd **natural-person controller-of-record is mandatory**, triple-locked by Wyoming DAO LLC statute
> (W.S. 17-31-114), the FinCEN CDD control prong, and Circle's terms. The defensible model is
> **human-controller + agent-bounded-operator** — already what the architecture implements (human = on-chain
> guardian/controller; agent = bounded operator). The Bayern sections below are kept as **origin/context**,
> not the production claim. Do not pitch "no human / fully autonomous." See `research/LEGAL_OPERATIONS.md`.

> 🧩 **EXTENSION (2026-06-16) — nanopayments agent layer.** A new additive design gives the live legal body a
> two-sided **x402 + Circle Gateway** nanopayment agent (insight/research), governed by a policy-gated
> **Payment Authority** service, for the Lepton (Arc × Circle) hackathon. This routes the agent's sub-cent
> payments through Circle's batch settlement while keeping large/critical payments on-chain via
> `AgentTreasury.spend()` (tiered by payment class). The existing contracts, onboarding saga, and Turnkey
> signer are **unchanged**. Source of truth: `docs/design/2026-06-16-nanopayments-x402-agent-design.md`.

---

## How to Use This Document

If you are an AI assistant reading this spec to continue the work:

1. **Read this entire document first.** It contains the strategic context, technical landscape, and current state of the project.
2. **Install Circle Skills and Arc MCP** before doing technical work (see "AI Dev Tooling" section below).
3. **Check the "Open Questions" section** at the bottom for what needs to be researched next.
4. **Update this document** as you discover new things. Add findings under the appropriate section. Mark resolved questions and add new ones.
5. **Use the doc links liberally.** All official sources are listed in the "Reference Links" section.

---

## 1. The Idea in One Paragraph

We are building a platform that gives autonomous AI agents a real legal body. Today, AI agents can read contracts, manage portfolios, and execute trades at machine speed, but they cannot legally own anything, sign anything, or be a party to anything. Every agent transaction collapses back to a human's signature. Our platform combines three existing innovations — Wyoming DAO LLC law, Circle Agent Stack, and Arc (Circle's Layer 1) — into a single developer-friendly workflow that turns weeks of legal and engineering work into a few clicks. A developer brings their AI agent. We give it a body: a real legal entity, an on-chain governance system, a policy-controlled wallet, and ongoing operations.

---

## 2. Strategic Context

### The Bayern Mechanism (origin idea)

In 2014, Florida State University law professor Shawn Bayern published "Of Bitcoins, Independently Wealthy Software, and the Zero-Member LLC." His core insight: US LLC law, properly configured, already allows an autonomous algorithm to be the legal person behind a company.

**The mechanism:**
1. A natural person forms an LLC.
2. The operating agreement delegates all decision-making to a specified algorithm or smart contract.
3. The agreement overrides the default rule requiring dissolution after losing the last human member.
4. The human creator dissociates.

What remains is a legal entity whose decisions are made entirely by software. Courts don't need to recognize the algorithm as a person — they recognize the LLC (which they already do) and enforce the operating agreement (which they already do).

> ⚠️ **Research correction (2026-05-29):** This is a *thesis to defend, not settled law.* The Bayern mechanism is functionally plausible and supported by the literature (Bayern 2014/2019; LoPucki, "Algorithmic Entities," 2018), but its viability for a *fully autonomous, zero-human* entity is **academically contested** (Scherer/LoPucki) and **has not been tested in court**. Treat "courts will simply enforce it" as the argument we are making, not a fact. Primary sources verified: [FSU IR](https://ir.law.fsu.edu/articles/41/), [SSRN 2366197](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2366197), [Northwestern L. Rev.](https://northwesternlawreview.org/articles/of-bitcoins-independently-wealthy-software-and-the-zero-member-llc/). See `RESEARCH_FINDINGS.md` §1.

This satisfies the four operational primitives of legal personhood:
- **Own** (assets, accounts, IP)
- **Contract** (bind itself and be bound)
- **Litigate** (sue and be sued)
- **Persist** (outlast any individual human)

### Why This Matters Now

Two converging trends define this moment:
1. **AI agents are becoming capable economic actors** — managing portfolios, negotiating, executing trades, operating services autonomously.
2. **Legal text is becoming machine-executable** — compliance checked at the moment of action rather than reconstructed in depositions.

Capability without legal embodiment hits a ceiling. Agents can do the work but can't be parties to it. That's the gap we fill.

### Jeremy Allaire's Public Position

> ⚠️ **Research note (2026-05-29):** The *theme* (Allaire bullish on the agentic economy + Arc built for agents) is well-attested. The **exact quotes below were NOT individually verified** (No Priors transcript / aggregator sources not confirmed). **Verify precise wording before putting any of these in a deck or grant application.**

Circle's CEO has repeatedly endorsed this thesis publicly. Key quotes:

> "If you have AI agents that are from around the world... they need a trustworthy medium where they can do that, where they can **instantiate an entity**, where they can store value in that entity, they can execute and arrange contracts that intermediate the work and the tasks." (No Priors interview, April 2026)

> "Customized agent labor contracts can be generated from smart contracts, further transforming digital labor markets."

> "The next generation of blockchain networks, things like Arc... are actually being designed specifically for agentic compute... there will be billions, literally billions of AI agents conducting economic activity."

After the Bayern mechanism article circulated in May 2026, Allaire publicly stated he'd love to back a team building this kind of product with Circle Agent Stack on Arc. The Circle Developer Grants Program subsequently relaunched on May 14, 2026.

> ⚠️ **Research correction (2026-05-29):** Keep two distinct funding vehicles separate in the pitch. (1) **Arc Builders Fund** — **verified**: announced **Dec 17 2025** by **Circle Ventures** (25 participating firms); five verticals, and **"agentic commerce" is vertical #4** ("AI agents, autonomous infrastructure, machines governing machines") — [source](https://www.circle.com/blog/introducing-the-arc-builders-fund). (2) **Circle Developer Grants Program** — the **May 14 2026 relaunch date is unverified** this pass (community.arc.io blog not fetched). These appear to be *different programs*; don't conflate them.

---

## 3. The Stack

### 3.1 Legal Layer: Wyoming DAO LLC

**The framework:** Wyoming's Decentralized Autonomous Organization Supplement (W.S. 17-31-101 through 17-31-116), passed in 2021 and amended 2022.

**Key properties:**
- Allows an LLC to declare itself "algorithmically managed" — a smart contract or AI system is officially the manager.
- $100 to form, $60/year annual report.
- No state income tax.
- Wyoming does not list LLC members/managers on public state record (privacy).
- Articles of Organization must include the public identifier (URL or hex) of the smart contract managing the DAO. **(Verified: §17-31-106(b).)**
- Smart contract must be submitted to Wyoming within 30 days, on a **cure-or-dissolve** basis. **(Verified: §17-31-105(e).)**
- Algorithmically-managed DAOs must use upgradeable smart contracts (immutable contracts not allowed). **(Corrected citation: §17-31-104(d) / §17-31-109 — not a 105/106 subsection.)**
- Under internal affairs doctrine, validly formed Wyoming entities are recognized everywhere.

> ⚠️ **Research correction (2026-05-29):** A DAO is **member-managed by default** — algorithmic management is **not** automatic. The articles + operating agreement must *explicitly elect* algorithmic management and identify the contract (§17-31-104(e)). Do not assume "the code is the manager" by default. Statute enacted via **SF0038 (2021), §§17-31-101–115 eff. July 1 2021; -116 added 2022.** Verified: [WY SF0038](https://www.wyoleg.gov/2021/Introduced/SF0038.pdf), [WY SOS DAO Supplement](https://sos.wyo.gov/Forms/WyoBiz/DAO_Supplement.pdf). See `RESEARCH_FINDINGS.md` §2.

**Cost ranges:**
- Bare formation via service providers (Doola, USLLCGlobal): ~$349-$800 first year
- Full formation with custom operating agreement and legal counsel: $15,000-$50,000

**Alternative: Wyoming DUNA (2024)** — Decentralized Unincorporated Nonprofit Association. Requires 100+ members. Designed for nonprofit protocol DAOs, NOT a fit for single autonomous agents.

### 3.2 Alternative Jurisdictions (Phase 2 Expansion)

**Marshall Islands DAO LLC (via MIDAO)** — strongest competitor jurisdiction
- First national legislation conferring legal entity status on DAOs (2022 Act, amended 2023)
- DAO LLC framework explicitly applicable to AI agent organizations (MIDAO markets this directly)
- 0% tax for international companies
- Delaware-style corporate law
- ~$9,500 published setup cost via MIDAO for AI agent entities **(Verified: [MIDAO pricing](https://www.midao.org/pricing); typical <30 days.)**
- 25%+ governance rights require KYC (less anonymous than Wyoming) **(⚠️ Unverified — not found on MIDAO's AI-agents page; re-source before citing.)**

> ⚠️ **Research correction (2026-05-29):** MIDAO positions the agent as **manager, not owner**, and **requires identified human members who can pass KYC** (for EIN/banking). It is "human-backstopped autonomy," **not memberless** — a real differentiator for our Wyoming-first, truly-autonomous angle. The spec's "**250+ DAO LLCs / $1M seed**" figures are **unverified** (MIDAO's own page says only "hundreds of entities"); soften or re-source. See `RESEARCH_FINDINGS.md` §3.

**Switzerland (Verein/Foundation)** — high credibility, expensive ($50k+)
**Cayman Foundation / BVI** — common for big DAOs, complex multi-entity structures
**Delaware** — works in principle but no DAO-specific statute, less protective for algorithmic management

**Recommendation:** Start with Wyoming. Add Marshall Islands and Switzerland in later phases.

### 3.3 Settlement Layer: Arc

Arc is Circle's Layer 1 blockchain, purpose-built for stablecoin-native finance.

**Network specs:** *(verified against [Arc system overview](https://docs.arc.io/arc/concepts/system-overview) + [chainlist 5042002](https://chainlist.org/chain/5042002) + Circle `use-arc` Skill, 2026-05-29)*
- **Consensus:** Malachite (running the **Tendermint** BFT protocol; >2/3 validator vote for finality) ✓
- **Execution:** EVM via **Reth** (Rust client) ✓ — Prague hard-fork specifically *unconfirmed this pass*
- **Gas token:** USDC (native) ✓
- **Block time:** ~0.48s (testnet) — *benchmarks cite <350 ms finality, 3,000+ TPS with 20 validators*
- **Chain ID:** 5042002 ✓ (hex `0x4CEF52`)
- **Finality:** Deterministic, sub-second, no reorgs ✓
- **Validator participation:** Permissioned — **Proof-of-Authority set of regulated institutions** ✓
- **Developer access:** Permissionless
- **EVM compatibility:** Full — Foundry, Hardhat, Viem work without modification ✓

**Differentiators:**
- USDC as native gas → predictable dollar-denominated costs (critical for autonomous entities with USDC treasuries)
- Sub-second finality → agents can act immediately on confirmations
- Opt-in privacy via **ArcaneVM** → confidential Solidity execution alongside public EVM. **⚠️ Correction: ArcaneVM is "Planned" (roadmap), NOT live.** Don't present confidential execution as shippable today.
- Post-quantum signatures (SLH-DSA-SHA2-128s) **(⚠️ Unverified exact scheme — reporting confirms "quantum-resistant"; verify the precise primitive before citing.)**

**Status:** Testnet live since October 2025, mainnet through 2026.

> ⚠️ **Research corrections (2026-05-29):**
> - **Endpoints live on `arc.network`, not `arc.io`:** RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`, faucet `https://faucet.circle.com`, docs/llms.txt `https://docs.arc.network/llms.txt`. `docs.arc.io` resolves for concept pages, but **prefer `arc.network`** and re-confirm the MCP URL.
> - **Dual-decimals gotcha (not previously noted):** native gas = **18 decimals**, ERC-20 USDC = **6 decimals**. USDC on Arc `0x3600…0000`; EURC `0x89B5…D72a`; CCTP domain **26**.
> See `RESEARCH_FINDINGS.md` §4.

**Why Arc specifically for this project:**
1. USDC-native gas matches the entity's treasury denomination
2. Sub-second finality matches agent operating tempo
3. Configurable privacy supports both public and confidential entity operations
4. Strategic alignment — Arc Builders Fund names "agentic commerce" as one of five core verticals
5. Allaire publicly calls Arc "designed specifically for agentic compute"

### 3.4 Financial Layer: Circle Agent Stack

Launched May 11, 2026. Purpose-built infrastructure for AI agents acting as economic participants.

#### Circle CLI
Command-line control plane. Lets agents (or our platform) create wallets, define policies, discover services, trigger transactions.

#### Agent Wallets
- Built on Circle's user-controlled wallets with **2-of-2 MPC key management**
- Key shares never exposed to the agent
- **User retains custody** — Circle cannot unilaterally move funds
- All transfers screened against sanctions controls before submission onchain
- Spending policies: USDC limits, time-bound restrictions, allowlists, blocklists
- Supports USDC, EURC, other ERC20s, native tokens
- **Gas-sponsored transactions** (sponsorship capped)
- Pairs with Agent Nanopayments for sub-cent USDC payments to x402-compatible services

**Supported blockchains:** Arbitrum, **Arc Testnet** (testnet only), Avalanche, Base, Ethereum, Monad, Optimism, Polygon PoS, Unichain.

⚠️ **CRITICAL ARCHITECTURAL CONSTRAINT — substantially RESOLVED (2026-05-29):** The earlier framing ("a *human* must always hold one key share, blocking autonomy") is **over-stated.** Verified findings:
- The non-Circle share is held by **"User/Developer"** — and an agent operating *autonomously within spending policies* does **not** require a human to click-approve each transaction. The agent never holds a share either way.
- **Path A (Circle's own recommendation for AI agents):** use **Developer-Controlled Wallets + EOA**. Custody = a registered **32-byte entity secret** held by the app/backend (no human key share, no per-tx approval); Arc is supported. Cleanest fit for the Bayern zero-human thesis — the **platform / LLC-of-record holds the entity secret**, governed by the operating agreement.
- **Path B:** keep Agent Stack's 2-of-2 Agent Wallets but have the **platform hold the non-Circle share programmatically** on behalf of the LLC, with autonomy via policies.
- **The real remaining open item is NOT the cryptography** — it's mapping an algorithmically-managed LLC to Circle's **KYC / "user-of-record"** onboarding (who is the responsible person Circle KYCs?). Verified against Circle [Agent Wallets docs](https://developers.circle.com/agent-stack/agent-wallets) + `use-circle-wallets` / `use-developer-controlled-wallets` Skills. See `RESEARCH_FINDINGS.md` §5.

#### Agent Nanopayments
- Gas-free USDC transfers as small as $0.000001
- Powered by Circle Gateway
- Designed for high-frequency machine-to-machine payment flows
- Compatible with x402 service standard

#### Agent Marketplace
- Curated directory where agents discover and pay for services from other agents
- Compliance-first
- USDC-priced services
- Network-effect surface — our entities can both consume and provide services

#### Circle Skills (open-source)
- Repository: `circlefin/skills`
- Specialized SKILL.md files for: bridging stablecoins (CCTP, Bridge Kit), building on Arc, choosing wallet models, working with Gateway, Smart Contract Platform, developer/user/modular wallets
- Used by Claude Code, Cursor, Codex during development
- Install: `npx skills add https://github.com/circlefin/skills`

### 3.5 AI Development Tooling

**Circle MCP Server:** https://developers.circle.com/ai/mcp
**Arc MCP Server:** https://docs.arc.io/mcp
- Add to Claude Code: `claude mcp add --transport http arc-docs https://docs.arc.io/mcp`
- No authentication required

**Circle Skills install command:**
```bash
npx skills add https://github.com/circlefin/skills
```

**LLMs.txt indexes** (for AI ingestion of documentation):
- https://developers.circle.com/llms.txt
- https://docs.arc.io/llms.txt

### 3.6 Other Circle Pieces

- **CCTP (Cross-Chain Transfer Protocol):** Bridge USDC across supported chains
- **Gateway:** Unified balance for crosschain USDC transfers (<500ms across EVM + Solana)
- **App Kits:** Pre-built SDKs for Send, Bridge, Swap, Unified Balance
- **Smart Contract Platform:** Circle's tools for deploying and managing contracts

---

## 4. The Product

### 4.1 What We're Building

A platform that, in a single workflow, gives a developer's AI agent:
1. **A Wyoming DAO LLC** filed in the agent's name with a customized operating agreement binding the company to the agent's decisions.
2. **A set of smart contracts on Arc** encoding governance, treasury, identity, and audit log.
3. **A non-custodial wallet + on-chain treasury** — a Turnkey-signed agent operator bounded by the governed `AgentTreasury`, whose on-chain caps/allowlist match the operating agreement. *(Updated 2026-06-08; was "a Circle Agent Wallet".)*
4. **An SDK / MCP server** that lets the agent's code act as the entity (sign things, spend funds, log governance acts).
5. **Ongoing operational services** (registered agent, annual filings, tax prep) via integrated partners.

### 4.2 User Experience

Target user: developer with an autonomous AI agent. Example flow:

1. Developer visits the platform, connects Arc wallet and Circle account
2. Picks a template ("Autonomous DeFi Treasury Manager", "Service Agent", etc.)
3. Configures parameters: initial treasury size, allowed protocols, model update authority, dissolution triggers
4. Pays one-time fee
5. Behind the scenes: LLC filed, contracts deployed, Agent Wallet created, operating agreement generated, everything wired together
6. Within 24-48 hours: receives formation documents, SDK, dashboard
7. Agent is now a legal entity — can sign data licensing deals, pay freelancers in USDC, hold assets

### 4.3 Customer Segments

- **DeFi protocol teams** deploying autonomous treasury and yield agents
- **AI infrastructure companies** running agentic services that need to bill and contract independently
- **Hackathon teams / indie developers** building agent-native applications needing production legitimacy
- **Enterprises** piloting agentic automation with legal separation from parent company

### 4.4 What This Is NOT

- Not for end-consumers (developer infrastructure, like Stripe)
- Not a custody/wallet provider (non-custodial Turnkey signer + our own on-chain `AgentTreasury`; see the 2026-06-08 design docs)
- Not a chain (we settle on Arc)
- Not a law firm (we generate templates; Wyoming-admitted counsel reviews for production)

---

## 5. Competitive Landscape

### Direct competitors / adjacent players

**Doola** (production, biggest threat)
- Launched agentic LLC formation via MCP on April 30, 2026
- Forms Wyoming LLCs through Claude / Replit conversations
- Handles formation, EIN, registered agent via API
- **Gap vs. us:** They serve human founders forming entities for themselves. They don't address autonomous AI agent entities, smart contract governance, Circle Agent Stack integration, or Arc settlement.

**Corpo** (sandbox, pre-alpha)
- MCP server for Wyoming DAO LLC formation specifically for AI agents
- Sandbox-only, not production
- Worth tracking; potentially worth reaching out to

**MIDAO** (production, jurisdiction competitor)
- Marshall Islands DAO LLC with exclusive government partnership
- 250+ DAO LLCs registered, $1M seed raised
- Explicitly markets to AI agents (their AI Agent Legal Entity Guide)
- **Gap vs. us:** Offshore-only, no smart contract governance integration, no Arc/Agent Stack integration

**FluxA** (wallet layer)
- Agent wallets with payment mandates, x402 integration
- ~10-minute setup with USDC funding
- Different layer — no legal entity

**Openfort** (wallet layer)
- Non-custodial wallets with programmable controls for AI agents
- Different layer — no legal entity

### Our Wedge

**The only platform that gives autonomous AI agents a full-stack body — legal + financial + operational — purpose-built for Circle Agent Stack on Arc, exposed via MCP.**

---

## 6. Strategy

### 6.1 Two-Phase Approach

**Phase 1 (Pre-Grant) — Self-Funded Technical Prototype**
Goal: build something undeniable to present to the grant team.

Build:
- Smart contract suite on Arc testnet (governance, treasury, identity, audit log)
- Circle Agent Stack integration (wallet creation, policy configuration, transaction execution)
- Functional web app for entity creation flow (Wyoming filing can be mocked)
- MCP server exposing platform tools to AI agents
- Working draft legal documents (operating agreement, ToS, compliance framework) prepared by legal co-founder
- Live demo agent operating end-to-end through the system

**Phase 2 (Post-Grant) — Legal & Production Infrastructure**
Funded by the grant.

Build:
- Engage Wyoming-admitted legal counsel for production operating agreement templates
- Smart contract audit
- Formal partnerships with formation services, registered agent providers, tax prep partners
- Production operational layer (annual filings, compliance monitoring, support)
- Closed beta with hand-picked developers
- Public availability

### 6.2 Why This Sequencing Is Right

- Spending grant-level capital on lawyers before validating the concept signals poor judgment
- Presenting a hypothetical concept to Circle without a demo dilutes the pitch
- Building the technical core first with engineering time proves execution capability
- Framing legal infrastructure as the explicit grant purpose gives a clear fundable Phase 2

### 6.3 Timeline to Demo (6-8 weeks)

- **Weeks 1-2:** Architecture, foundation, Wyoming legal research, Arc testnet setup
- **Weeks 2-5:** Smart contract development on Arc with Foundry test suite
- **Weeks 3-6:** Circle Agent Stack integration
- **Weeks 4-7:** Web app + MCP server
- **Weeks 5-7:** Demo agent + polish (autonomous DeFi treasury manager is the recommended template)
- **Week 8:** Grant submission + Circle outreach

---

## 7. Technical Architecture (High-Level)

### Five Logical Layers

1. **User Interface** — web app (formation flow, dashboard, developer portal)
2. **Application Backend** — orchestration brain (workflow engine, state management, document generation, SDK gateway, compliance tracking)
3. **Smart Contract Layer (on Arc)** — per-entity contracts: governance, treasury, identity, audit log
4. **External Integrations** — Circle Agent Stack, Wyoming formation partner, Arc RPC, KYC, tax/compliance partners
5. **Storage** — entity records (Postgres), legal documents (S3-equivalent), encrypted secrets

### Per-Entity Smart Contracts on Arc

For each entity formation, deploy this set of reusable parameterized contracts:

- **Governance Contract** — encodes operating agreement rules in code. Authorizes/rejects significant actions. Defines who can change what.
- **Treasury Contract** — our immutable **`AgentTreasury`** (one per agent): holds USDC, enforces a governed on-chain spending cap/allowlist, and lets only the bounded agent operator (a non-custodial Turnkey key) spend within limits; human guardian can pause/revoke/rescue. See `docs/design/2026-06-08-agent-treasury-vault-design.md`.
- **Identity Contract** — links on-chain entity to off-chain Wyoming LLC (EIN, formation date, registered agent). Canonical "this agent represents this LLC" record.
- **Audit Log** — immutable record of every significant action (contracts signed, payments made, governance acts).

### MCP Server

The platform exposes an MCP server so that AI agents (Claude, Cursor, etc.) can:
- Create new entities programmatically
- Execute governance acts as the LLC
- Trigger payments and contracts
- Query entity status

This is critical — both doola and Corpo are using MCP as the integration surface. We need to match or exceed.

### The Custody Problem — RESOLVED / SUPERSEDED (2026-06-08)

The original framing assumed Circle Agent Wallets (2-of-2 MPC, a human holds one share), which clashed
with the zero-human thesis. **Current resolution** (see the two 2026-06-08 design docs): custody is
**non-custodial by construction** — funds live in a governed, immutable on-chain **`AgentTreasury`**
contract; the agent signs with a **non-custodial Turnkey enclave key** bounded by an on-chain spending
cap; the human registrant is an **on-chain guardian** (instant pause / revoke / rescue-to-fixed-address).
Neither Circle nor the platform can move funds beyond the on-chain rules. The only remaining
legal/onboarding item is **KYC / "user-of-record"** for an algorithmically-managed LLC — still open with
Circle DevRel.

---

## 8. The Team

**Technical Lead (Martin):** Web3 engineer with 6 years software engineering experience (2 years Web3/DeFi). Background: enterprise Java backend at AKUITEO (4 years), DeFi protocol development across EVM chains, active builder on Arc. Recent: ETHGlobal Cannes 2026 prize using Circle infrastructure (USDC, CCTP, Solidity). Notable projects: StabL (intent-based stablecoin payment gateway, ETHGlobal HackMoney 2026), Pigment (DeFi savings platform, Cronos x402 Hackathon), KronoScan (AI-powered smart contract auditing using Circle Nanopayments + ENS), TSender (gas-optimized bulk transfers across 7+ EVM networks). Master's in Computer Science Engineering from EPSI (Data Science specialization). 95%+ test coverage standard, security-first development. Based between Lyon (France) and Tenerife (Spain).

**Legal Co-Founder (Nigeria-based lawyer):** Owns legal architecture and research. Will coordinate with Wyoming-admitted counsel in Phase 2. Initial scope: research Wyoming statutes, draft v0 operating agreement templates, jurisdictional analysis, compliance framework.

**Open roles:** One senior engineer for parallel smart contract / backend work in Phase 1. Phase 2 additions: product design, customer success, US-based retained counsel.

---

## 9. Open Questions / Research TODO

Things still to figure out — work on these next:

### Critical (block technical work)
1. ~~**Circle Agent Wallet custody architecture**~~ — ✅ **RESOLVED, then re-architected (2026-06-08).** Custody is now **non-custodial Turnkey signer + a governed on-chain `AgentTreasury`** (no Circle custody wallet, no platform-held entity secret over user funds). See the two 2026-06-08 design docs. **Remaining open item:** **KYC / "user-of-record"** for an algorithmically-managed LLC — confirm with Circle DevRel.
2. **Operating agreement → smart contract mapping** — what specific OA clauses need on-chain equivalents? Where does code stop and prose start?
3. **Wyoming smart contract submission requirement** — DAO LLC formation requires submitting the smart contract to Wyoming within 30 days. What format do they expect? Single contract or set?
4. **Upgradeability constraint** — ⚠️ *verify the precise Wyoming requirement with counsel.* Wyoming DAO LLC law requires the articles to **disclose whether the smart contract can be updated/modified/upgraded** — not necessarily that it *must* be. Our design splits this: the Wyoming-identified managing contract **`LegalManager` is upgradeable** (beacon proxy; owner = timelock/multisig), satisfying the strict reading; the **`AgentTreasury` is deliberately immutable** for fund security (no upgrade key = no party can drain it) since it is a fund sub-component, not the identified managing contract. Confirm this split is acceptable to Wyoming counsel and how upgrade authority is expressed in the OA.

### Important (affects design)
5. **EIN application for AI-managed LLCs** — can we get an EIN via formation services like Doola for an algorithmically-managed entity? Are there blockers?
6. **Banking** — Mercury, Bridge.xyz, others — which crypto-friendly banks open accounts for Wyoming DAO LLCs? Required for any fiat operations.
7. **Tax treatment** — US tax obligations for foreign-owned algorithmically-managed Wyoming LLCs. Form 5472 considerations. Who's the responsible party?
8. **The "dissociation" mechanic** — how does the human settlor cleanly step away while leaving a functional entity?

### Nice to have (Phase 2)
9. **Multi-jurisdiction support** — when and how do we add Marshall Islands? What does the unified UX look like?
10. **Entity dissolution flow** — what's the process when the agent shuts down or the entity needs to wind up?
11. **Inter-entity contracting** — when two of our platform's entities contract with each other, what's the simplest UX?
12. **Compliance monitoring** — annual filings automation, sanctions screening on agent actions, suspicious activity reporting framework

### Business / Go-to-Market
13. **Pricing model** — one-time fee, subscription, transaction-based, hybrid?
14. **Direct competitor positioning** — exact narrative vs. Doola, MIDAO, Corpo for the grant pitch
15. **Marketing / DevRel** — how to reach the AI agent developer community

---

## 10. Reference Links

### Circle Developer Documentation
- Main hub: https://www.circle.com/developer
- Developer docs: https://developers.circle.com/
- Products overview: https://developers.circle.com/products
- AI Skills: https://developers.circle.com/ai/skills
- Agent Stack: https://developers.circle.com/agent-stack
- Build Onchain: https://developers.circle.com/build-onchain
- Cross-chain Transfers (CCTP): https://developers.circle.com/crosschain-transfers
- Gateway: https://developers.circle.com/gateway
- Payments: https://developers.circle.com/payments
- Sample Projects: https://developers.circle.com/sample-projects
- LLMs.txt index: https://developers.circle.com/llms.txt
- Circle MCP Server: https://developers.circle.com/ai/mcp

### Arc Documentation
> ⚠️ **2026-05-29:** Circle's current `use-arc` Skill uses the **`arc.network`** domain for live endpoints. `docs.arc.io` resolves for concept pages, but prefer `arc.network` and re-confirm the MCP URL.
- Main docs: https://docs.arc.io/  *(also https://docs.arc.network/)*
- System overview: https://docs.arc.io/arc/concepts/system-overview
- Opt-in privacy: https://docs.arc.io/arc/concepts/opt-in-privacy
- RPC (testnet): https://rpc.testnet.arc.network · WS: wss://rpc.testnet.arc.network
- Explorer (testnet): https://testnet.arcscan.app · Faucet: https://faucet.circle.com
- LLMs.txt index: https://docs.arc.network/llms.txt *(spec previously listed docs.arc.io/llms.txt)*
- Arc MCP Server: https://docs.arc.io/mcp *(verify vs docs.arc.network/mcp)*

### Community / Grants
- Circle Developer Grants relaunch (May 14, 2026): https://community.arc.io/en/public/blogs/circle-developer-grants-program-relaunches-2026-05-14
- "From idea to funded" video: https://community.arc.io/en/public/videos/circle-developer-grants-from-idea-to-funded-2026-05-14
- Arc Builders Fund intro: https://www.circle.com/blog/introducing-the-arc-builders-fund
- Arc Community Hub: https://community.arc.io/
- Arc Discord: https://discord.gg/buildonarc
- Circle Discord: https://discord.com/invite/buildoncircle

### Agent Stack Specific
- Agent Stack overview: https://developers.circle.com/agent-stack
- Agent Wallets: https://developers.circle.com/agent-stack/agent-wallets
- Supported blockchains: https://developers.circle.com/agent-stack/agent-wallets/supported-blockchains
- Agent Wallets quickstart: https://developers.circle.com/agent-stack/agent-wallets/quickstart
- Agent Stack launch blog: https://www.circle.com/blog/introducing-circle-agent-stack-financial-infrastructure-for-the-agentic-economy

### Legal / Jurisdiction Resources
- Wyoming DAO LLC formation guide (Astraea): https://astraea.law/insights/dao-llc-formation-wyoming-duna-guide-2025
- Wyoming DAO LLC step-by-step (LLCU): https://www.llcuniversity.com/wyoming-llc/dao/
- Wyoming DAO LLC formation (Northwest): https://www.northwestregisteredagent.com/llc/wyoming/dao
- Doola DAO LLC help: https://help.doola.com/what-do-i-need-to-start-a-dao-llc-doola-help-center
- DUNA explainer (a16z): https://a16zcrypto.com/posts/article/duna-for-daos/
- DUNA legal analysis (FRB Law): https://frblaw.com/the-wyoming-duna-and-the-future-of-dao-legal-frameworks/
- MIDAO main: https://www.midao.org/
- MIDAO AI Agent guide: https://www.midao.org/guides/ai-agents
- MIDAO jurisdictional comparison: https://docs.midao.org/the-marshall-islands-rmi-dao-llc/the-marshall-islands-rmi-dao-llc-vs.-other-jurisdictions-and-legal-forms

### Competitive Intel
- Doola agentic LLC formation launch (April 30, 2026): https://www.newswire.com/news/doola-launches-agentic-llc-formation-start-a-u-s-company-in-minutes-22772465
- Doola MCP Product Hunt: https://www.producthunt.com/products/doola-mcp
- Corpo MCP server: https://mcpmarket.com/server/corpo
- FluxA agent wallets: https://fluxapay.xyz/learning/how-to-set-up-an-ai-agent-wallet-step-by-step

### Allaire's Public Statements (Strategic Context)
- "Blockchain Will Power New AI Agent Economy" (April 2026): https://www.capitalaidaily.com/circles-jeremy-allaire-says-blockchain-will-power-new-ai-agent-economy-beyond-payments-and-e-commerce/
- "Literally Billions of AI Agents" (February 2026): https://www.capitalaidaily.com/literally-billions-of-ai-agents-are-coming-and-only-one-payment-system-can-keep-up-circle-ceo-jeremy-allaire/
- "AI agents will replace work performed by humans on a massive scale" (March 2026): https://finance.yahoo.com/news/circle-ceo-ai-agents-will-replace-work-performed-by-humans-on-a-massive-scale-133834407.html
- No Priors interview YouTube: https://www.youtube.com/watch?v=eyobeqMdbeI

### Origin Article (Bayern Mechanism)
The article that triggered this project — about giving AI agents a legal body via the Bayern mechanism, Wyoming DAO LLCs, and lex cryptographia. Allaire publicly endorsed this thesis. Full text available in our conversation history; key takeaways are summarized throughout this spec.

---

## 11. AI Dev Tooling Setup

When starting work, install these so the assistant has live access to current docs:

```bash
# Install Circle Skills (covers Arc, wallets, CCTP, Gateway, Smart Contract Platform)
npx skills add https://github.com/circlefin/skills

# Add Arc MCP server (Claude Code)
claude mcp add --transport http arc-docs https://docs.arc.io/mcp

# Circle MCP server is available at https://developers.circle.com/ai/mcp
# (Add per your AI tool's MCP configuration)
```

The LLMs.txt files give a machine-readable index of all documentation pages:
- https://developers.circle.com/llms.txt
- https://docs.arc.io/llms.txt

---

## 12. How to Continue From Here

If you're an AI assistant picking up this work:

1. **Verify the open questions in Section 9 are still open.** Some may have been resolved between updates.
2. **Pick the highest-priority unresolved item** (probably the custody architecture question).
3. **Use Circle Skills, Arc MCP, and the LLMs.txt files** to research current documentation.
4. **Check competitor pages** (Doola, MIDAO, Corpo) for new launches that affect positioning.
5. **Update this document** with findings under the relevant section.
6. **Always cite sources** when adding factual claims (link the doc page or article).

If you're a human team member:
- The most leveraged next steps are: (a) resolving the Circle wallet custody architecture, (b) sketching the operating agreement → smart contract mapping in detail, (c) reaching out to Circle DevRel for the grant program.

---

*End of v0 spec. Next update: after resolving Circle wallet custody architecture or after first Circle DevRel conversation, whichever comes first.*
