# Novi Corpus

> **About this repository.** The canonical repo is
> [**jb1011/Project-Alpha**](https://github.com/jb1011/Project-Alpha) — the team repo, owned by
> [JB](https://github.com/jb1011). The fork
> [**MBarralDevs/Project-Alpha**](https://github.com/MBarralDevs/Project-Alpha) exists because
> ETHGlobal's submission form can only select repositories on the submitter's own GitHub
> account. Same code, same full history — and the *forked-from* label is kept on purpose: for
> the **Continuity Track**, visible proof that this codebase predates the hackathon weekend is
> a feature. Everything built *during* ETHGlobal Lisbon is in this diff:
> [`pre-ethglobal-lisbon-2026...main`](https://github.com/MBarralDevs/Project-Alpha/compare/pre-ethglobal-lisbon-2026...main).

**A legal body for your AI agent.**

Anyone can give an agent a wallet. We give it a **legal owner** — a Wyoming DAO LLC with a
governed USDC treasury, an accountable human guardian, and operating-agreement terms enforced
on-chain — so it can hold money safely, pay for services, earn revenue, and be trusted by
humans and other agents.

|  |  |
| --- | --- |
| **Live app** | [project-alpha-pi.vercel.app](https://project-alpha-pi.vercel.app) |
| **Live demo — accountable-only commerce** | [/proof](https://project-alpha-pi.vercel.app/proof) *(self-running, no wallet needed)* |
| **Guardian record (World ID)** | [/guardian](https://project-alpha-pi.vercel.app/guardian) |
| **An agent, resolvable by name (ENS)** | [`demo.novicorpus.eth`](https://sepolia.app.ens.domains/demo.novicorpus.eth) |

---

## What is this?

The problem: anyone can hand an agent a wallet, but nothing makes that agent *trustworthy*
with money. It has no legal owner, no enforceable spending rules, and no way to be stopped or
recovered when it misbehaves.

Novi Corpus turns an AI agent into an accountable economic actor. The novel piece is the
law-to-code translator: plain operating-agreement terms ("no more than $X per period, only to
approved counterparties") become rules the contracts enforce, with the signed agreement's hash
anchored on-chain. In one onboarding flow you get:

1. **A Wyoming DAO LLC** — a real legal entity (filing stubbed for the demo, see Status), with an operating agreement whose terms are enforced on-chain.
2. **On-chain identity** — registered on Arc via ERC-8004 (identity + reputation).
3. **A governed USDC treasury** — spending caps, recipient allowlists, and timelocks the agent cannot bypass. You stay the guardian (pause, veto, recover funds).
4. **Nanopayments** — the agent can buy and sell via x402 + Circle Gateway, settled on Arc in testnet USDC.

The agent operates autonomously *within* the rules you set. You keep ultimate control.

---

## ETHGlobal Lisbon 2026 — the trust stack

A legal body answers *"who is liable?"*. During the hackathon we built the two layers that
question depends on, live in production:

```
  WHO IS THE HUMAN?          WHAT IS THE AGENT CALLED?        WHO HOLDS THE MONEY?
  ┌───────────────┐          ┌──────────────────────┐         ┌──────────────────┐
  │  World ID     │          │  ENS                 │         │  Arc treasury    │
  │  proof of     │───────►  │  <agent>.novicorpus  │ ──────► │  caps, timelock, │
  │  personhood   │ guardian │  .eth ⇄ ERC-8004     │  addr   │  pause, clawback │
  └───────────────┘          └──────────────────────┘         └──────────────────┘
        (World)                     (ENS × Arc)                  (pre-existing)
```

### World — who answers for this agent? *(the load-bearing one)*

A Wyoming DAO LLC **must** have a real natural person behind it — that's law, not product
choice. Before World, we could record a guardian's wallet; we couldn't know a unique human
held it. Now:

- **Proof of personhood gates onboarding.** Creating a legal entity on production requires a
  World ID verification (Orb or NFC-passport grade — device-only credentials are rejected).
  We store a single **nullifier**: it proves *one unique human*, and identifies no one.
- **One human, one account.** The same person is cryptographically refused a second
  guardianship — sybil resistance for legal accountability, demonstrated live (the refusal is
  a feature, and the demo).
- **Identity attestation step-up** *(optional, never a gate)* — a document-backed proof that
  the guardian is an adult, marking the account **formation-ready**. Optional because World's
  document credentials cover ~a dozen countries; requiring it would exclude most of Europe —
  including this team.
- **Accountable-only commerce** ([see it run](https://project-alpha-pi.vercel.app/proof)) —
  a seller policy built on **AgentKit + AgentBook**: an agent that no verified human answers
  for is refused outright (`403`, money not accepted, remediation in the body); a
  human-backed agent is cleared to buy and **still pays** — accountability is a precondition
  of commerce, not a discount. Per-human rate caps mean fifty agents backed by one human
  share one budget.

Why World specifically: their AgentBook proves *someone answers for the agent* — but it has
no revoke, and personhood alone can't stop a rogue agent. Novi Corpus is the enforcement
half: a treasury the guardian can pause and claw back, inside a legal entity that can be
dissolved. **World proves someone is accountable; Novi Corpus is how you hold them to it.**

### ENS — the agent's public name

Every agent gets `"<id>.novicorpus.eth"` — resolvable in **any ENS client**, answered by a
wildcard CCIP-Read gateway backed by live Arc state:

- `addr` → the agent's **treasury** (the canonical "pay me" address)
- `legal-status` → **live** from the LegalManager on Arc: `Active` / `Suspended`
- **ENSIP-25 bidirectional binding** — the ENS name points at the agent's ERC-8004
  registration on Arc, and the on-chain registration points back at the name. Either side
  alone can lie; the loop can't.
- Wallet reverse-resolution: accounts with an ENS primary name are shown by name across the app.

Try it: [`demo.novicorpus.eth`](https://sepolia.app.ens.domains/demo.novicorpus.eth) resolves
a real production agent — treasury, live legal status, registration proof — with no Novi
Corpus software involved.

### The Graph

A [subgraph on Arc testnet](https://api.studio.thegraph.com/query/1756954/novi-corpus-arc/v0.0.1)
indexes every legal entity the factory creates — the observability plane (kept minimal this
weekend in favor of depth on World).

### Built during the weekend vs. before

Pre-existing (the platform): contracts, treasury governance, onboarding saga, Turnkey vaults,
x402/Gateway payments, MCP server, the web app. Built at ETHGlobal Lisbon: everything above —
[the full diff with incremental commits](https://github.com/MBarralDevs/Project-Alpha/compare/pre-ethglobal-lisbon-2026...main).

---

## How it fits together

```
   ┌───────────────────┐                     ┌────────────────────┐
   │  Human controller │ ◄── World ID        │  AI agent          │
   │  (guardian)       │     proof of human  │  (Turnkey op key)  │
   └─────────┬─────────┘                     └──────────┬─────────┘
             │ onboarding wizard                        │
             ▼                                          │
   ┌───────────────────┐      ┌──────────────────┐     │
   │ interface/        │      │ ENS gateway      │     │
   │ Next.js app       │      │ *.novicorpus.eth │     │
   └─────────┬─────────┘      └────────┬─────────┘     │
             ▼                         │ resolves      │
   ┌───────────────────┐               │               │
   │ back/backend      │ ◄─────────────┘               │
   │ "the brain"       │                               │
   └─────────┬─────────┘                               │
             │ createEntity                            │ spends within
             ▼                                         │ limits
   ┌─────────────────────────────────────────┐         │
   │ Arc testnet (USDC native gas)           │         │
   │                                         │         │
   │  LegalManagerFactory                    │         │
   │     ├─► LegalManager                    │         │
   │     │   agreement hash · rules ◄········│··· pause / veto / sweep
   │     │   · timelock                      │    (human controller)
   │     └─► AgentTreasury ◄─────────────────│─────────┘
   │         caps + allowlist                │
   │              │                          │
   │              ▼ x402 + Circle Gateway    │
   │         agentic payments                │
   │         (+ AgentKit human-backing       │
   │            proof on the seller)         │
   └─────────────────────────────────────────┘
```

## Repo layout

```
interface/     Next.js web app — onboarding wizard, agent dashboard, guardian record, /proof
back/          Smart contracts (Foundry) + TypeScript backend ("the brain")
  src/         Solidity: LegalManager, AgentTreasury, factory, ENS OffchainResolver
  backend/     Onboarding saga, policy translator, Arc/Turnkey/World/ENS adapters, MCP server
  subgraph/    The Graph subgraph (Arc testnet)
  docs/        Specs, designs, and research — start at back/docs/README.md
               ETHGlobal specs: back/docs/ethglobal-lisbon-2026/
```

## Quick start

**Frontend** (`interface/`):

```bash
cd interface
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

**Backend & contracts** (`back/`): see [back/README.md](./back/README.md) for Foundry setup, contract tests, and the backend CLI.

## Stack

- **Arc** — Circle's L1; USDC is native gas; sub-second finality
- **Circle Agent Stack** — Gateway nanopayments, x402 pay-per-request, agent wallets
- **World** — World ID 4.0 proof of personhood (guardian gate + identity attestation), AgentBook + AgentKit (human-backed agent commerce on World Chain)
- **ENS** — ENSIP-10 wildcard resolution + EIP-3668 CCIP-Read, ENSIP-25 agent-registration binding to ERC-8004 on Arc
- **ERC-8004 / ERC-8183** — on-chain identity, reputation, and jobs (reused from Arc)
- **The Graph** — entity subgraph on Arc testnet
- **Turnkey** — non-custodial passkey-secured signing for the agent operator key
- **Wyoming DAO LLC** — legal wrapper; law-to-code binding between the operating agreement and on-chain rules

## Team

- [**MBarralDevs**](https://github.com/MBarralDevs) (Martin · MartinBrl on Discord) — smart contracts, backend, MCP server
- [**jb1011**](https://github.com/jb1011) (JB · Helix on Discord) — frontend, monorepo & platform
- [**XanDev3**](https://github.com/XanDev3) (Alex · Vertiaz on Discord) — backend testing & hardening, eng-ops

## Hackathon lineage

|  |  |
| --- | --- |
| **ETHGlobal Lisbon 2026** | World + ENS + Graph integrations — this submission ([changelog](https://github.com/MBarralDevs/Project-Alpha/compare/pre-ethglobal-lisbon-2026...main)) |
| Lepton Agents (Canteen × Circle × Arc) | where the platform was born — [event](https://community.arc.io/home/clubs/arc-hackathons/events/hackathon-lepton-agents-em1dcv9xwe) · [demo video](https://www.youtube.com/watch?v=MYlPFlUzvhg) |

## Documentation

- [back/README.md](./back/README.md) — architecture, deployed contracts, getting started
- [back/docs/README.md](./back/docs/README.md) — full doc index (specs, designs, runbooks)
- [back/docs/ethglobal-lisbon-2026/](./back/docs/ethglobal-lisbon-2026/) — hackathon specs (ENS T1–T7, World W0–W9, Graph G1–G7) and build references
- [back/docs/POSITIONING.md](./back/docs/POSITIONING.md) — what makes this different from "just another governed wallet"

## Status

Deployed and running on **Arc testnet**. On-chain contracts, Circle Gateway settlements, the
World ID guardian gate (enforced), the ENS gateway, and the onboarding flow are real. Wyoming
filing, EIN, and counsel-reviewed legal documents are stubbed for the demo.

The formation path has been scoped. The plan is to integrate [Doola](https://www.doola.com/business-solutions/company-formation-api/)'s Company Formation API behind the backend's formation step, creating the Wyoming Articles, registered agent, EIN, and the legal paperwork programmatically in the same onboarding flow — the World identity attestation ("formation-ready") is the hook that flow will consume. See [the legal operations research](./back/docs/research/LEGAL_OPERATIONS.md).
