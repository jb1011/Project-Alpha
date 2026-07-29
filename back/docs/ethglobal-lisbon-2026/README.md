# ETHGlobal Lisbon 2026 — Novi Corpus Continuity Build

**Event:** ETHGlobal Lisbon, July 24–26 2026, Pavilhão Carlos Lopes.
**Track:** Continuity Track ("Extend Open Source" path) — first ETHGlobal event allowing work on an existing codebase. Novi Corpus (this repo) is the pre-existing project.

## Documents in this folder

| File | Audience | Content |
|---|---|---|
| [concepts.md](./concepts.md) | Everyone (pitch, judges, teammates) | What each integration is and why, explained conceptually |
| [technical-blueprints.md](./technical-blueprints.md) | Builders | Cross-stack summary blueprints: packages, addresses, encodings, code seams, hour estimates, risks |
| [reference-thegraph.md](./reference-thegraph.md) | Builders (authoritative) | Complete offline build reference: manifest+schema drafts, AssemblyScript traps, Studio/self-hosted flows, x402 v2 leg, MCP/SKILL skeletons |
| [reference-world.md](./reference-world.md) | Builders (authoritative) | Complete offline build reference: IDKit v4 + verify API, AgentKit full API, seller seam, no-SDK fallback, track rules verbatim |
| [reference-ens.md](./reference-ens.md) | Builders (authoritative) | Complete offline build reference: resolver sources verbatim, ensjs flows, CCIP wire protocol, records catalog, test matrix |

Where a reference doc and the blueprint disagree, **the reference doc wins** (each has a
deltas section; known corrections are already patched into the blueprint).

## Continuity Track rules (compliance checklist)

- Must clearly document **pre-existing work vs hackathon work** — this folder + the dedicated branch are that documentation.
- **Incremental commit history required** — large single commits risk disqualification. Commit small and often, all weekend.
- Partner-prize eligibility for continuity teams "may vary by partner" — **confirm at each sponsor booth** whether continuity teams can enter their main (non-continuity) tracks.

## What Novi Corpus is (pre-existing, for context)

A protocol that gives an AI agent a real legal entity (Wyoming DAO LLC) with a legally
mandatory human controller ("guardian"). Live components before this hackathon:

- **On-chain governed treasury** (`AgentTreasury` on Arc testnet): rolling spending cap, payee allowlist, guardian pause + emergency clawback, timelocked policy updates with guardian veto, legal-status gate.
- **Payments:** x402 USDC nanopayments settled via Circle Gateway on Arc; pocket-float hot wallet governed by a software policy engine (`evaluatePolicy`).
- **Identity:** ERC-8004 agent identity registry + ERC-8183 job/reputation saga on Arc; public HTTPS metadata URI per agent.
- **Interface:** multi-tenant MCP server — any Claude/LLM agent can onboard, fund, pay, and earn.
- **Custody:** non-custodial Turnkey (guardian passkey root + sign-only delegated agent key).

## The build: "the trust stack for agent legal bodies"

Three integrations, one narrative — the three questions you'd ask about any counterparty,
answered for an AI agent:

1. **Who is the human behind you?** → **World** (World ID proof-of-personhood on the guardian + AgentKit human-backed-agent verification in our x402 seller). Target: AgentKit New Use Cases, $8,000.
2. **What are you called, and how does anyone verify you?** → **ENS** (`<publicId>.novicorpus.eth` wildcard CCIP-read names + ENSIP-25 bidirectional binding to our ERC-8004 registry on Arc). Targets: Best ENS Integration for AI Agents $1,500 + Continuity $2,000 + Most Creative $1,500 — one build.
3. **How do you behave?** → **The Graph** (AgentTreasury subgraph on `arc-testnet` + guardian alerting + policy-governed x402 pay-per-query, packaged as reusable MCP/SKILL tooling). Targets: Best AI Tooling $5,000, AI Use Case $3,000, AI Use Case Continuity $4,000.

None of the three touches the Arc treasury core. Every integration is additive.

## Why these three (and not the other five sponsors)

Researched all 8 sponsor tracks on 2026-07-24 (4-agent deep dive of prize pages + docs):

- **The Graph** — the ONLY sponsor whose stack reaches Arc (arc-testnet officially indexed); their top track literally names MCP servers, agent SKILLs, and x402 payment tooling; directly fixes our own audited observability gap (S5).
- **World** — proof-of-personhood for the *legally required* human controller is thesis-level fit; AgentKit is built on x402 (our rail) and its verification layer is chain-agnostic.
- **ENS** — ENSIP-25 (verifiable AI-agent identity) was designed around ERC-8004 registries, which we already run; one resolver serves every agent with zero per-agent transactions.
- **Hedera** (stretch, not committed) — HCS consensus topics as tamper-proof per-entity audit logs is a genuinely good fit (~10–16h sidecar) and their $6k AI-payments track lists x402/ERC-8004/HCS-audit-trails as sweeteners; but it requires at least one payment leg on Hedera testnet to qualify. Only if time remains.
- **Sui** — skipped: main $4k track is new-projects-only; the lone $2k continuity prize demands the integration be "core functionality"; only Walrus is usable without a Move rewrite.
- **1inch** — skipped: Lisbon prize is Aqua/SwapVM only (3-month-old protocol, not on Arc, Solidity-heavy) — pure prize-chasing for us.
- **0G** — skipped for the weekend: every track expects contracts on 0G chain and their continuity track presumes prior 0G work. (Their TEE "Sealed Inference" verified-watchdog idea is filed for post-hackathon — it attacks our rogue-agent-detection gap.)
- **Uniswap Foundation** — viable backup ($7k API track; `pay_in_any_token` MCP tool on Base Sepolia) but pulls the narrative toward DeFi features instead of the trust story. Not in scope unless plans change.

## Budget & priority

| Integration | Estimate | Risk profile |
|---|---|---|
| The Graph | 14–20h | Low (all our stack; watch arc-testnet indexer) |
| ENS | 14–20h | Low (one small contract on Sepolia + gateway on our backend) |
| World | 13–20h | Medium (beta SDK, v4 migration churn, one-time real Orb dependency) |

Total 41–60h → all three is aggressive solo, comfortable for two people.
**If cutting: ship ENS + The Graph fully, then World** — World's legs degrade gracefully
(the guardian World ID gate alone is already a coherent story).

## Pre-hackathon checklist (night 0)

1. **Orb (2 Orbs confirmed at the venue):** get one team member Orb-verified, then `npx @worldcoin/agentkit-cli register <operatorEOA>` (2 min, gasless, permanent — mainnet AgentBook). **⚠ R1: the published CLI uses the v3 identity bridge; World IDs created after 2026-06-01 are v4-only — a freshly-verified account may FAIL AgentBook registration. Prefer someone with a pre-June-2026 World ID, or test the CLI registration immediately after Orb verification tonight** (while there's still time to find another verified person).
2. **World Developer Portal:** create production + staging apps, action `guardian-verification`; capture `app_id`, `rp_id`, `signing_key`.
3. **Graph Studio:** wallet sign-in, create subgraph `novi-corpus-arc`, grab deploy key; deploy a factory-only walking skeleton ASAP to de-risk arc-testnet sync.
4. **Arc registry check (10 min):** `cast call 0x8004A818BFB912233c491871b3d84c89A494BD9e "getMetadata(uint256,string)(bytes)" 845775 "ens"` + a `setMetadata` gas estimate from the manager EOA (decides on-chain vs off-chain ENSIP-25 bidirectionality).
5. **Sepolia:** faucet ETH; register `novicorpus.eth` via the ensjs script (not the alpha app).
6. **Circle faucet:** Base Sepolia USDC for the Graph x402 payer key (1 USDC ≈ 100 queries).
7. **Booth questions:** ~~continuity eligibility~~ CONFIRMED — The Graph and World both accept continuity teams in their main tracks. Still ask: does subgraph + x402 gateway count as "≥2 Graph products" for the Composable track? And at World's 4:30 PM workshop: access to the two continuity-only beta prizes ($1,750 each, Selfie/Identity Check — partner-gated, require user+developer feedback documentation).
8. Commit incrementally from the first hour.

## Branch & submission strategy

- All hackathon work happens on the dedicated branch **`hackathon/ethglobal-lisbon-2026`**, cut from `main`.
- The pre-hackathon state of `main` is tagged (**`pre-ethglobal-lisbon-2026`**) — a dated, immutable proof of what existed before the event (continuity-track requirement).
- A **draft PR** from the branch to `main` is opened at the start: its diff IS the "work done during the hackathon" changelog judges are asked for — self-documenting, always current.
- Feature work lands as small commits (optionally micro-branches merged into the hackathon branch). No squashing during the event — the incremental history is a judging requirement.
- After the event: review + merge to `main` at leisure (nothing in the hackathon branch touches treasury-critical paths).
