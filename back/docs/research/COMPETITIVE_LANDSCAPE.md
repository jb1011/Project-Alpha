# Competitive Landscape — Legal Bodies for AI Agents & Agentic Commerce

> Companion to `SPEC.md` §5. Produced 2026-06-03 via parallel web research (primary/company
> sources, cited; secondary claims flagged). Scans the full field, not just Arc.
>
> **Our wedge for comparison:** an autonomous agent that *owns* a **Wyoming DAO LLC** with a custom
> upgradeable **on-chain governance** contract, an **ERC-8004 identity** bound to the legal entity,
> and a **USDC treasury on Arc** via **Circle Agent Stack**.

---

## Headline

One project (**Corpo**) is doing almost exactly this concept, but on **Solana, not Arc**, and it is
**pre-alpha / sandbox** (no live state filings yet). Beyond Corpo, the entire well-funded
agentic-commerce field stops at **payments / wallets / identity** and leaves the **legal-entity layer
open**. The wedge is real but narrower than "nobody thought of this."

---

## Tier 1 — Direct competitors (the legal-body wedge)

### Corpo (corpo.llc) — CLOSEST MATCH
- Agent **owns** a **Wyoming DAO LLC**; on-chain governance + USDC treasury; distributed as an MCP
  server (16 tools); formation "powered by Doola"; ~$299 one-time + $99/yr.
- **On Solana / Realms, not Arc** (no Circle Agent Stack, no ERC-8004).
- **Pre-alpha / sandbox only** — their marketplace listing: *"all operations are currently demo/
  sandbox only. Production Wyoming SOS filings coming soon."* Homepage reads as live; the independent
  listing + GitHub issue say otherwise. **[flagged: production-readiness unverified]**
- Uses **Doola** as its formation backend (the same rail we considered).
- **This is our real competitor**, not just "a sandbox to track." Differentiation: Arc + Circle Agent
  Stack + ERC-8004 + custom governance vs their Solana/Realms/Doola, and **live vs sandbox**.
- Sources: [corpo.llc](https://corpo.llc/) · [mcpmarket.com/server/corpo](https://mcpmarket.com/server/corpo) · [GitHub issue #1017](https://github.com/cline/mcp-marketplace/issues/1017)

### MIDAO (midao.org) — real legal shell, no autonomy stack
- Registered agent for **Marshall Islands DAO LLC**; dedicated "AI Agent Legal Entity Guide."
- Agent is **manager, not owner**; entity holds liability/contracts/bank/IP. Algorithmic management
  written into the statute.
- **No bundled chain / wallet / governance.** ~$9,500, <30 days. Marketing-stage: no named live
  AI-controlled entity. Retains human override / emergency-pause per the operating agreement.
- Sources: [midao.org/guides/ai-agents](https://www.midao.org/guides/ai-agents) · [midao.org](https://www.midao.org/)

### ClawBank / "Manfred" — agent self-incorporation (unverified)
- ~May 1 2026: agent reportedly auto-completed IRS Form SS-4, got an EIN, opened an FDIC-insured bank
  account, runs a crypto wallet. Behind it: Justice Conder / Fraction Software LLC (Ohio).
- **No DAO LLC, no on-chain governance wrapper, ownership ambiguous, a human signs at filing.** All
  coverage traces to the company's own statements. **[flagged: single-source / company-claimed]**
- Sources: [techstartups.com](https://techstartups.com/2026/05/01/ai-agent-forms-its-own-u-s-company-gets-ein-in-first-of-its-kind-breakthrough/) · [coindesk.com](https://www.coindesk.com/tech/2026/05/01/ai-agent-forms-its-own-company-gets-ready-to-trade-crypto)

### Doola — supplier, not competitor (for our wedge)
- Agentic LLC formation via MCP, but **for human founders** (collects human members, responsible
  party, ownership split). No agent-ownership / DAO / governance / wallet.
- **Powers Corpo's formation backend** — so Doola is plumbing under the closest competitor, and a
  candidate formation rail for us. See `LEGAL_OPERATIONS.md` §5.
- Sources: [doola.com blog](https://www.doola.com/blog/doola-mcp-form-your-llc-inside-ai-chat/) · [newswire.com](https://www.newswire.com/news/doola-launches-agentic-llc-formation-start-a-u-s-company-in-minutes-22772465)

### DAO legal-wrapper incumbents — pivoting toward agents, not agent-ownership
- **Tribute Labs (ex-OpenLaw):** launched ADIN (AI agents for VC due diligence) — agents *assist* a
  DAO, don't own an entity. **Otonomos:** added an "AI Corporate Agent" that *advises humans*; states
  agents can't directly own bank accounts/sign. **Aragon / Legal Nodes:** DAO wrappers, no agent
  product. **DAObox / KALI / Lex Autonomica / Law Nodes:** no 2026 agent pivot found (no signal).

---

## Tier 2 — Broad agentic-commerce field (payments / wallets / identity, ZERO legal)

Everyone with real funding builds the financial/technical stack; **none give the agent a legal body.**

- **Payment rails / standards:** x402 (Coinbase; x402 Foundation w/ Cloudflare), Google **AP2**,
  Skyfire, Payman, Nevermined, **Visa** Intelligent Commerce, **Mastercard** Agent Pay, **Stripe**
  Agentic Commerce Suite (+ Privy acquisition), **PayPal**.
- **Wallets / custody:** Crossmint, Privy (→ Stripe), Turnkey, Openfort, FluxA, **Coinbase AgentKit /
  Agentic Wallets**, **Circle Agent Stack** (our dependency).
- **Agent platforms w/ treasuries:** Virtuals (tokenized agents, Base), Olas/Autonolas, Fetch.ai/ASI,
  Story Protocol (agent IP licensing — closest to "contracting" but not entity formation), Morpheus.
- **Catena Labs** (ex-Circle founder Sean Neville; ~$18M seed + ~$30M Series A; applying for an OCC
  national trust-bank charter): the most institutional player, but it builds a regulated financial
  institution *for* agents. It has a legal body of *its own*; it does not give the *agent* one.

Across all of it, **liability flows back to a human or sponsoring company.**

Sources: [Catena/Fortune](https://fortune.com/2026/05/20/catena-labs-series-a-sean-neville-ai-native-bank/) ·
[x402](https://www.coinbase.com/developer-platform/discover/launches/google_x402) ·
[Google AP2](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol) ·
[Crossmint agent wallets compared](https://www.crossmint.com/learn/agent-wallets-compared) ·
[Coinbase Agentic Wallets](https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets).

---

## Tier 3 — Agent identity (no off-chain legal binding)

- **ERC-8004 "Trustless Agents"** (our identity layer): Identity + Reputation + Validation registries;
  authors from MetaMask, Ethereum Foundation, Google, Coinbase; extends Google's A2A. **The spec
  explicitly omits any off-chain legal-entity binding.** Status: EIP page reads "Draft"; reference
  contracts reportedly deployed to Ethereum mainnet Jan 29 2026. Adoption counts (20k-45k) are
  **secondary / unverified**.
- **Google AP2 / DIDs + Verifiable Credentials / Mastercard / Visa / Coinbase / World AgentKit:** all
  bind the agent to a **human principal or account**, not an autonomous legal entity.
- Sources: [eips.ethereum.org/EIPS/eip-8004](https://eips.ethereum.org/EIPS/eip-8004) ·
  [crypto.news ERC-8004 mainnet](https://crypto.news/ethereum-erc-8004-ai-agents-mainnet-launch-2026/).

---

## Ranked: closest → farthest from our wedge

1. **Corpo** — agent-owned WY DAO LLC + on-chain gov + USDC treasury. Our exact concept, but **Solana, pre-alpha**.
2. **MIDAO** — real agent legal entity (RMI), but legal shell only, $9,500, no chain/wallet/gov.
3. **ClawBank/Manfred** — agent self-incorporates + EIN + bank, but no DAO/governance, single-source.
4. **Tribute Labs / ADIN** — agents assist a real legal DAO, don't own it.
5. **Doola** — agentic LLC formation for humans (and Corpo's backend).
6. **Otonomos / Aragon / Legal Nodes** — entity formation + AI advisory chatbots; no agent-ownership.
7. **Catena / Circle / Coinbase / Virtuals / Olas / x402 / AP2 / Skyfire / etc.** — rails & platforms; **no legal body**.

---

## Verdict & implications

The legal-body-for-an-agent layer is **real but shallow, immature, and uncrowded.** The defensible
wedge, stated precisely:

> Not "no one is doing this" (Corpo is, conceptually). The wedge is **the first *live, production*
> agent legal body native to Arc + Circle Agent Stack, binding an ERC-8004 on-chain identity to a real
> Wyoming DAO LLC with a custom upgradeable governance contract.** Corpo chose Solana and hasn't
> shipped; everyone else stops at payments/wallets.

**Changes this forces in `SPEC.md` §5:**
1. **Corpo = headline competitor**, not "sandbox to track." Add explicit differentiation (Arc + Circle
   Agent Stack + ERC-8004 + custom governance vs Solana/Realms/Doola; **live vs sandbox**).
2. **Soften the "only platform combining X" claim** (§5 / "Our Wedge") to the precise version above —
   a reviewer who knows Corpo will catch an overclaim.
3. Add **ClawBank** (self-incorporation precedent) and **Catena Labs** (institutional context) to the
   landscape.

**Items to confirm before citing externally:** Corpo production-readiness (homepage vs sandbox
listing), ClawBank claims (single-source), ERC-8004 adoption numbers (secondary).
