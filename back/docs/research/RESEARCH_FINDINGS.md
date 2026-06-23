# Research Findings — "Giving AI Agents a Legal Body"

> Companion to `SPEC.md`. Produced 2026-05-29 via fan-out web research (30 primary/secondary
> sources, adversarial 3-vote verification) + Circle's official Skill bundles (`use-arc`,
> `use-circle-wallets`, `use-developer-controlled-wallets`).
> Each claim is tagged **[VERIFIED]**, **[NUANCE]**, **[CORRECTION]**, or **[UNVERIFIED]**.

---

## 0. Executive Summary

The two **legal pillars** of the spec (Bayern mechanism + Wyoming DAO LLC statute) are accurate and
well-supported by primary sources — with one important caveat: the *viability* of fully autonomous
zero-human entities is **academically contested**, not settled. The **technical stack** (Arc + Circle
Agent Stack) is real and the spec describes it accurately, with a few datable corrections. The
spec's headline **"custody problem" is real but over-stated as a blocker** — it has at least two clean
resolutions. The **competitive framing** holds up: no competitor combines legal + on-chain governance +
Agent Stack + Arc.

---

## 1. The Bayern Mechanism / Zero-Member LLC

**[VERIFIED]** Shawn Bayern, *"Of Bitcoins, Independently Wealthy Software, and the Zero-Member LLC"*,
**108 Nw. U. L. Rev. Online 257 / 108 Nw. U. L. Rev. 1485** (published online **April 10, 2014**).
- Sources: [FSU IR](https://ir.law.fsu.edu/articles/41/) · [SSRN 2366197](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2366197) · [Northwestern L. Rev.](https://northwesternlawreview.org/articles/of-bitcoins-independently-wealthy-software-and-the-zero-member-llc/)

**[VERIFIED]** The four-step mechanism in `SPEC.md` lines 32–38 (form LLC → operating agreement delegates
to algorithm → override member-loss dissolution default → human dissociates) is supported by Bayern's
later work and by LoPucki, *"Algorithmic Entities"* (2018), which confirms algorithmic systems can
control US LLCs and most US entity forms.
- The "plumbing" is real: RULLCA's 90-day no-member dissolution default is overridable; e.g. **NY LLC
  Law §701** allows 180 days or another agreed period; **NY §603** says an assignee is not automatically
  a member. Source: [NY Senate §701](https://www.nysenate.gov/legislation/laws/LLC/701) · [Justia NY §603](https://law.justia.com/codes/new-york/llc/article-6/603/)

**[NUANCE — important]** `SPEC.md` line 38 ("Courts don't need to recognize the algorithm as a person")
**overstates a settled position.** The viability of *truly autonomous* entities is **contested in the
literature** (Scherer / LoPucki, 2018): the mechanism is *functionally* plausible but **not formally
tested in court**, and critics argue practical/legal frictions remain. Treat "it just works" as a
*thesis to defend*, not a fact. This is the single most important framing correction for the grant pitch
and legal memo.
- Source: Bayern, *"Are Autonomous Entities Possible?"* (2019) + [Wash. U. L. Rev. discussion](https://journals.library.wustl.edu/lawreview/article/3143/galley/19976/view/)

---

## 2. Wyoming DAO LLC Statute (W.S. 17-31-101 et seq.)

**[VERIFIED]** Enacted by **SF0038 (2021)**, creating **W.S. 17-31-101 through -115, effective July 1,
2021**; **-116 added by 2022 amendment**. Source: [WY SF0038](https://www.wyoleg.gov/2021/Introduced/SF0038.pdf) · [WY SOS DAO Supplement](https://sos.wyo.gov/Forms/WyoBiz/DAO_Supplement.pdf) · [WY SOS DAO FAQs](https://sos.wyo.gov/Business/Docs/DAOs_FAQs.pdf)

Verified statutory specifics (these refine the spec's section numbers):

| Spec claim | Verified statute section | Status |
|---|---|---|
| Articles must include smart-contract public identifier | **§17-31-106(b)** | **[VERIFIED]** |
| Smart contract submitted / cured within 30 days or dissolution | **§17-31-105(e)** | **[VERIFIED]** (spec said "30 days" ✓; cure-or-dissolve mechanic) |
| Algorithmically-managed DAOs must use **upgradeable** smart contracts | **§17-31-104(d) / §17-31-109** | **[CORRECTION]** — cite **104(d)/109**, not a 105/106 subsection |
| Management vested in members or smart contract | **§17-31-104(e)** | **[VERIFIED]** |

**[CORRECTION / killed claim]** The blanket statement "management auto-vests in the smart contract if
algorithmically managed, absent contrary provisions" was **refuted (1–2 in adversarial verification)**.
Reality is more nuanced: the **articles + operating agreement control**, and a DAO is *member-managed by
default* unless the articles state algorithmic management. Don't assume the code is automatically the
manager — it must be explicitly elected and identified. Source: [Justia WY §17-31-106](https://law.justia.com/codes/wyoming/title-17/chapter-31/article-1/section-17-31-106/)

**[VERIFIED]** Formation economics ($100 form / $60 annual report / no state income tax / members not on
public record) are consistent with WY SOS materials.

---

## 3. Alternative Jurisdictions

**Marshall Islands (MIDAO) DAO LLC** — strongest competitor jurisdiction.
- **[VERIFIED]** Published setup cost **$9,500**, typically **< 30 days**. Source: [MIDAO pricing](https://www.midao.org/pricing) · [MIDAO AI agents guide](https://www.midao.org/guides/ai-agents)
- **[NUANCE]** MIDAO positions the agent as **manager, not owner**, and explicitly requires **identified
  human members who can pass KYC** (for banking/EIN). This is a *meaningful departure from Bayern's
  zero-human thesis* — MIDAO is "human-backstopped autonomy," not memberless. Strong selling point for the
  Wyoming-first, truly-autonomous angle.
- **[VERIFIED]** Markets directly to AI agents; explicitly recognizes smart-contract governance and
  on-chain (DeFi) operation; emphasizes entity **persistence across model upgrades** ("when GPT-4 is
  superseded… contracts and assets don't have to be re-papered").
- **[UNVERIFIED]** Spec's "250+ DAO LLCs registered" and "$1M seed raised" — MIDAO's own page says only
  "hundreds of entities." Treat the specific 250+/$1M figures as **unconfirmed**; soften or re-source.
- **[UNVERIFIED]** Spec's "25%+ governance rights require KYC" threshold — not found on the AI-agents
  page; may be on the [jurisdiction-comparison doc](https://docs.midao.org/the-marshall-islands-rmi-dao-llc/the-marshall-islands-rmi-dao-llc-vs.-other-jurisdictions-and-legal-forms). Verify before citing.

**Wyoming DUNA (2024)** — **[VERIFIED]** nonprofit unincorporated association; designed for large
membership protocol DAOs; **not** a fit for single autonomous agents. Source: [Preston Byrne on DUNAA](https://prestonbyrne.com/2024/03/08/dunaa/) · a16z DUNA explainer.

Delaware / Cayman / BVI / Switzerland descriptions in the spec are directionally correct (no
DAO-specific statute in DE; offshore complexity for Cayman/BVI; high cost/credibility for CH) — not
independently re-verified in depth this pass.

---

## 4. Arc (Circle's Layer 1)

Sources: [Arc system overview](https://docs.arc.io/arc/concepts/system-overview) · [Arc opt-in privacy](https://docs.arc.io/arc/concepts/opt-in-privacy) · [chainlist 5042002](https://chainlist.org/chain/5042002) · Circle `use-arc` Skill.

| Spec claim | Finding |
|---|---|
| Consensus: Malachite BFT | **[VERIFIED + NUANCE]** "Malachite" implementation running the **Tendermint BFT** protocol; >2/3 validator vote for finality |
| Execution: Reth / EVM | **[VERIFIED]** Reth (Rust Ethereum execution client); full EVM compatibility (Foundry/Hardhat/viem) |
| Gas token: USDC native | **[VERIFIED]** USDC is the native gas token |
| Finality sub-second, no reorgs | **[VERIFIED]** "Deterministic finality in under one second, no reorganization risk"; benchmarked **<350 ms** with 20 validators, **3,000+ TPS** |
| Validators permissioned | **[VERIFIED]** Proof-of-Authority set of **regulated institutions** |
| Chain ID 5042002 | **[VERIFIED]** (chainlist; hex `0x4CEF52`) |
| ArcaneVM confidential execution | **[CORRECTION]** ArcaneVM is **"Planned," not live** — it is a roadmap module, not a current differentiator. Don't present it as shippable today. |
| Post-quantum signatures (SLH-DSA) | **[UNVERIFIED this pass]** Consistent with reporting (The Block: "quantum-resistant") but the primary doc page didn't restate the exact scheme; the whitepaper PDF was unparseable. Verify the exact `SLH-DSA-SHA2-128s` claim before citing. |
| Testnet live Oct 2025, mainnet 2026 | **[PLAUSIBLE]** Testnet is live; mainnet timing not independently confirmed this pass |

**[CORRECTION — operational endpoints]** Circle's current `use-arc` Skill uses the **`arc.network`**
domain, not `arc.io`, for live infrastructure:
- RPC `https://rpc.testnet.arc.network` · Explorer `https://testnet.arcscan.app` · Faucet
  `https://faucet.circle.com` · docs/llms.txt `https://docs.arc.network/llms.txt`
- `docs.arc.io` **does** resolve for concept pages, so both may coexist/redirect — but **prefer
  `arc.network` endpoints** and re-confirm the MCP URL (`docs.arc.io/mcp` vs `docs.arc.network/mcp`).

**[NEW — gotcha not in spec]** Arc uses **dual decimals**: native gas = **18 decimals**, ERC-20 USDC =
**6 decimals**. Mixing them produces wrong amounts. USDC on Arc: `0x3600…0000`; EURC:
`0x89B5…D72a`; CCTP domain **26**.

---

## 5. Circle Agent Stack & the Custody Problem

> ⚠️ **SUPERSEDED for the custody conclusion (2026-06-08).** The "two viable paths (Developer-Controlled /
> platform-as-user)" conclusion below was later rejected: both are **custodial toward the end-user**. Current
> decision = **non-custodial Turnkey signer + a governed on-chain `AgentTreasury`** (see
> `../design/2026-06-08-wallet-and-treasury-architecture.md`). The Agent-Stack facts (rails, components,
> launch date) below remain accurate; only the custody recommendation changed.

Sources: [Agent Stack launch blog](https://www.circle.com/blog/introducing-circle-agent-stack-financial-infrastructure-for-the-agentic-economy) · [Agent Wallets docs](https://developers.circle.com/agent-stack/agent-wallets) · [Circle pressroom](https://www.circle.com/pressroom/circle-launches-ai-infrastructure-to-power-the-agentic-economy) · Circle wallet Skills.

**[VERIFIED]** Launched **May 11, 2026**. Components: **Agent Wallets, Agent Nanopayments, Agent
Marketplace, Circle CLI** (+ open-source Circle Skills).
- **Agent Wallets**: **[VERIFIED]** 2-of-2 MPC, **built on user-controlled wallets**. "Key shares are
  never exposed to the agent. The user retains custody, and Circle cannot unilaterally move funds." Two
  shares = **{User/Developer}** + **{Circle}**. Policies: time-bound USDC limits, allow/blocklists,
  sanctions screening pre-submission, capped gas sponsorship. The spec's description is **accurate**.
- **Nanopayments**: **[VERIFIED]** gas-free, sub-cent USDC, powered by Gateway, **x402**-compatible
  (x402 did **$24.24M / 30 days** as of Apr 29 2026, 99.8% in USDC).
- **Marketplace** & **CLI** ("the control plane"): **[VERIFIED]**.

### The custody "problem" — RESOLVED (two viable paths)

The spec frames 2-of-2 MPC as a near-blocker because "a human must always hold one share." **The
research shows this is over-stated.** The non-Circle share is held by **"User/Developer"** — and the
agent operating *autonomously within policies* does **not** require a human to click-approve each
transaction. Two clean architectures:

- **Path A — Developer-Controlled Wallets (Circle's own recommendation for agents).** Circle's
  `use-circle-wallets` decision table maps *"AI agent, autonomous multi-chain transactions"* → **
  Developer-Controlled + EOA**. Custody is held by the application/backend via a **registered 32-byte
  entity secret** (RSA-encrypted per request) — **no human key share, no per-tx approval**, Arc is a
  supported chain. This is the cleanest fit for the Bayern zero-human thesis: the **platform / LLC-of-
  record holds the entity secret**, and its use is governed by the operating agreement.
- **Path B — Agent Wallets (user-controlled 2-of-2), with the platform as "user."** Keep Agent Stack's
  Agent Wallets but have the **platform backend (acting for the LLC) hold the non-Circle share
  programmatically**, with autonomy delivered through spending policies. The agent never holds a share;
  the human is replaced by the entity-of-record.

**Open sub-question that remains:** mapping an algorithmically-managed LLC to Circle's **KYC / "user of
record"** requirements (who is the responsible person Circle onboards?). This — not the cryptography —
is the real unresolved item for Open Question #1.

---

## 6. Competitive Landscape

| Player | Verified facts | Gap vs. this project |
|---|---|---|
| **Doola** | **[VERIFIED]** Launched agentic LLC formation **Apr 30, 2026**; MCP inside **Claude & Replit**; forms **Wyoming LLCs** mid-conversation; handles EIN, registered agent, US bank account; "no SSN required." [Source](https://www.newswire.com/news/doola-launches-agentic-llc-formation-start-a-u-s-company-in-minutes-22772465) | **[VERIFIED]** Serves **human founders**; *no* autonomous-agent-owned entities, *no* DAO/smart-contract governance, *no* Agent Stack/Arc. Spec's framing holds. |
| **MIDAO** | See §3. Agent-as-manager, $9,500, KYC'd humans required. | Offshore; no on-chain governance integration; not memberless. |
| **Corpo** | **[UNVERIFIED]** Only source ([mcpmarket](https://mcpmarket.com/server/corpo)) was rated unreliable / yielded no verifiable claims. Treat "sandbox MCP for WY DAO LLC for AI agents" as **unconfirmed** — worth direct diligence. |
| **FluxA / Openfort** | Wallet-layer only; no legal entity (per spec; not re-verified this pass). | Different layer. |

**Wedge holds:** the only stack combining **legal body + on-chain governance + Circle Agent Stack +
Arc settlement**, exposed via MCP.

---

## 7. Jeremy Allaire / Grants / Arc Builders Fund

- **[VERIFIED]** **Arc Builders Fund** announced **Dec 17, 2025**, run by **Circle Ventures** (25
  participating firms, no investment commitment). **Five verticals**, and **"Agentic commerce"** is
  vertical #4 — verbatim *"AI agents, autonomous infrastructure, machines governing machines."* This
  directly supports the project's strategic-alignment claim. [Source](https://www.circle.com/blog/introducing-the-arc-builders-fund)
  - **[CORRECTION]** Arc Builders Fund (Circle Ventures, Dec 2025) appears **distinct** from the
    **Circle Developer Grants Program** (spec says relaunched May 14, 2026). The spec conflates them in
    places — keep them separate in the pitch. The grants-relaunch date itself was **not independently
    confirmed** this pass (community.arc.io blog not fetched).
- **[UNVERIFIED]** Specific Allaire quotes in `SPEC.md` lines 58–64 (No Priors Apr 2026, "instantiate an
  entity," "billions of AI agents," "love to back a team building this") were **not individually
  verified** in this pass — the secondary aggregators (capitalaidaily, etc.) and the No Priors YouTube
  weren't transcribed. The *theme* (Allaire bullish on agentic economy + Arc for agents) is
  well-attested; **verify exact quotes before putting them in a deck.**

---

## 8. Prioritized Corrections to SPEC.md

1. **Soften Bayern certainty** (line 38) — autonomy viability is contested, not settled (§1).
2. **Fix Wyoming upgradeability citation** → §17-31-104(d)/109 (§2).
3. **Don't assume code auto-manages** — articles/OA must elect algorithmic management (§2).
4. **Mark ArcaneVM as "Planned," not live** (§4).
5. **Prefer `arc.network` endpoints**; re-confirm MCP/llms.txt URLs (§4).
6. **Add dual-decimals gotcha** (18 native / 6 USDC) (§4).
7. **Re-frame the custody "problem" as solved** via developer-controlled wallets or platform-as-user;
   the real open item is **KYC / user-of-record for an algorithmic LLC** (§5).
8. **Re-source or soften** MIDAO "250+/$1M" and "25% KYC threshold" (§3).
9. **Separate** Arc Builders Fund (Circle Ventures, confirmed) from Circle Developer Grants Program
   (date unconfirmed) (§7).
10. **Verify Allaire quotes** before external use (§7).

---

## 9. Source Quality Ledger

- **Primary, high-confidence:** Bayern papers (FSU/SSRN/Northwestern), WY SF0038 + SOS DAO docs, NY LLC
  statute, Arc docs (system-overview, opt-in-privacy), chainlist, Circle Agent Stack blog + Agent
  Wallets docs + pressroom, Circle Skills (`use-arc`, wallet skills), Arc Builders Fund blog, MIDAO
  pricing + AI-agents guide, Doola newswire.
- **Secondary:** The Block (Arc quantum-resistant — 403 this pass), Yahoo/StockTitan (Circle launch).
- **Unreliable / unconfirmed:** mcpmarket (Corpo), businesswire mirror, capitalaidaily (Allaire
  aggregator). Verify independently before citing.
