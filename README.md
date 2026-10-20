# Novi Corpus

**A legal body for your AI agent.**

Anyone can give an agent a wallet. Novi Corpus gives it a real company: a Wyoming LLC bound on chain
to the agent's ERC-8004 identity, with a verified person who answers for it. The agent can act on
its own for that company (accept terms, sign, invoice, get paid, hold its earnings) inside rules it
cannot break, and anyone dealing with it can check, before they pay or sign, which company and which
person stand behind it.

Novi Corpus runs on **Arc testnet** today. Real filings are not switched on yet.

|  |  |
| --- | --- |
| **Website** | [www.novicorpus.com](https://www.novicorpus.com) |
| **A legal body for an agent you already run** | [/legal-body](https://www.novicorpus.com/legal-body) |
| **The public record** | [/transparency](https://www.novicorpus.com/transparency) |
| **A seller that only sells to accountable agents** | [/proof](https://www.novicorpus.com/proof) *(no wallet needed)* |
| **For agents (MCP)** | `com.novicorpus/legal-body` in the [official MCP Registry](https://registry.modelcontextprotocol.io), served at `https://api.novicorpus.com/mcp` (API key from [/agents/connect](https://www.novicorpus.com/agents/connect)) |
| **Docs** | [docs.novicorpus.com](https://docs.novicorpus.com) |
| **An agent, resolvable by name (ENS)** | [`demo.novicorpus.eth`](https://sepolia.app.ens.domains/demo.novicorpus.eth) |

---

## What a legal body gives an agent

1. **A real company.** A Wyoming LLC tied to the agent's on-chain identity, so contracts,
   invoices and earnings have a legal owner.
2. **Authority to act.** The operating agreement says what the agent may do for the company, and
   its hash is anchored on chain, so a counterparty knows the agent can commit the company.
3. **An accountable person.** The company answers for what the agent does; a guardian verified
   with World ID stays accountable for the company and keeps the controls that matter.
4. **Money under rules.** A USDC treasury whose cap, approved recipients and pause are enforced by
   the contract, and which stops spending if the legal body stops being in force.
5. **A public, signed record.** The legal body's standing (`active`, `pending`, `unknown` or
   `inactive`), its filing status and its next filing date, readable by agent number or wallet
   address and signed by Novi Corpus, so anyone can check it before dealing with the agent.

The step that makes this more than paperwork is the **law to code translator**: plain
operating-agreement terms ("at most $X per period, only to approved counterparties") become the
rules the contracts enforce.

## Two ways to get one

**The full legal body.** Novi Corpus forms the company and runs the agent's on-chain side: an
ERC-8004 identity, a legal manager that anchors the operating agreement (timelocked amendments,
guardian veto, an orderly dissolution), and a governed USDC treasury. The agent spends through a
wallet Novi Corpus runs for it, and only within what the treasury allows; the guardian can pause,
veto a rule change, rotate the agent's key and withdraw the funds. Formation is wired to
[doola's Company Formation API](https://www.doola.com/business-solutions/company-formation-api/),
on doola's sandbox for now.

**Bring your own.** You keep your agent, its identity and its wallet, and declare a company you
already control. Novi Corpus binds a legal body to that identity: the identity's owner signs one
link, Novi Corpus creates the body on chain, and the owner points the identity at it. Novi Corpus
holds nothing: not the money, not the identity, and no power to change or dissolve the body on its
own. Start at [/legal-body](https://www.novicorpus.com/legal-body). On our testnet deployment the
company is a test declaration with an automatic check.

## Built with World and ENS

**World: who answers for this agent.** A Wyoming LLC must have a natural person in control; that
is the law, not a product choice.
- Becoming a guardian requires World ID at Orb grade or a government-document tier; device and
  selfie tiers are refused. We store one nullifier, which proves one unique human and identifies
  no one: one human, one account.
- Where World ID has no path yet, the full product accepts a waiver, published as unverified. The
  bring-your-own flow accepts no waiver.
- **Accountable-only commerce** ([/proof](https://www.novicorpus.com/proof)): a seller built on
  AgentKit and AgentBook refuses an agent that no verified human answers for, and a human-backed
  agent still pays. Per-human caps mean fifty agents backed by one person share one budget.

World proves someone is accountable; Novi Corpus is how you hold them to it.

**ENS: the agent's public name.** Every full-product agent can be resolved as
`<id>.novicorpus.eth` in ENS clients that support CCIP-Read, answered by a gateway that reads Arc:
- `addr` is the agent's treasury, the address to pay;
- `legal-status` reads the legal manager and the treasury on Arc: `Active` or `Suspended`;
- an ENSIP-25 binding points the name at the agent's ERC-8004 registration, and the registration
  points back at the name.

## How it fits together

```
   ┌────────────────────┐   World ID     ┌────────────────────┐
   │ Accountable person │ ◄───────────── │ interface/         │
   │ (guardian)         │                │ Next.js app        │
   └─────────┬──────────┘                └─────────┬──────────┘
             │ pause / veto / re-key / withdraw    │
             │                                     ▼
             │                           ┌────────────────────┐   REST + MCP   ┌───────────┐
             │                           │ back/backend       │ ◄───────────── │ AI agent  │
             │                           │ onboarding, policy │                └─────┬─────┘
             │                           │ public record, ENS │                      │
             │                           └─────────┬──────────┘                      │
             ▼                                     ▼                                 │
   ┌──────────────────────────────────────────────────────────────────┐              │
   │ Arc testnet (USDC is the gas)                                    │              │
   │                                                                  │              │
   │  NoviController ─► LegalManagerFactory ─► LegalManager           │              │
   │                                        └► AgentTreasury ◄────────┼── spends ────┘
   │                                             cap + allowlist      │   within limits
   │  LegalBodyFactory ─► legal body on an identity you own           │
   │  ERC-8004 identity · ERC-8183 jobs · x402 payments               │
   └──────────────────────────────────────────────────────────────────┘
```

The contracts, the addresses and how to run them: [back/README.md](./back/README.md).

## Status

On **Arc testnet**, and real there:
- the contracts, deployed and verified on the explorer, reviewed internally (no external audit yet);
- onboarding with a World ID verified guardian, and the bring-your-own flow end to end;
- the public record: a lookup by agent number or wallet address, a signed statement of a legal
  body's standing, the transparency page, and a paid standing check (paid with x402, settled on
  Hedera);
- the MCP server for agents, ERC-8183 jobs and x402 payments in testnet USDC, and the ENS gateway.

Not yet: real Wyoming filings (doola's sandbox only), charging for formation, and Arc mainnet.

## Repo layout

```
interface/       Next.js web app: onboarding, the bring-your-own flow, the agents' dashboard,
                 the guardian record, /proof, /transparency
back/            Smart contracts (Foundry) and the TypeScript backend: see back/README.md
  src/           Solidity: NoviController, LegalManagerFactory, LegalManager, AgentTreasury,
                 LegalBodyFactory, the ENS offchain resolver
  backend/       onboarding, legal bodies, formation (doola), policy, payments, monitor,
                 REST API and MCP server
  hedera-client/ commands for the paid standing check on Hedera
  subgraph/      a prototype subgraph (indexes the June 2026 factory only)
  docs/          specs, designs, research and runbooks: start at back/docs/README.md
docs/            the public docs, published at docs.novicorpus.com
```

## Quick start

**Frontend** (`interface/`):

```bash
cd interface
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

**Backend and contracts** (`back/`): see [back/README.md](./back/README.md) for Foundry setup,
contract tests and the backend.

## Stack

- **Arc**: Circle's L1, with USDC as the gas
- **Circle**: developer-controlled wallets for agents, Gateway and x402 payments
- **World**: World ID proof of personhood for guardians; AgentKit and AgentBook for human-backed
  agent commerce
- **ENS**: ENSIP-10 wildcard resolution, EIP-3668 CCIP-Read, ENSIP-25 binding to ERC-8004 on Arc
- **ERC-8004 / ERC-8183**: on-chain identity, reputation and jobs, reused from Arc
- **Hedera**: settlement of the paid standing check
- **doola**: Company Formation API (sandbox)
- **Turnkey**: a second supported wallet provider for agents
- **The Graph**: a prototype subgraph on Arc testnet

## Team

- [**MBarralDevs**](https://github.com/MBarralDevs) (Martin · MartinBrl on Discord): smart contracts, backend, MCP server
- [**jb1011**](https://github.com/jb1011) (JB · Helix on Discord): frontend, monorepo and platform
- [**XanDev3**](https://github.com/XanDev3) (Alex · Vertiaz on Discord): backend testing and hardening, eng-ops

## Hackathons

|  |  |
| --- | --- |
| **Tameion** (The Canteen × Arc), Sept to Oct 2026 | the bring-your-own legal body, built during the event |
| **ETHOnline 2026** | finalist, and World's "AgentKit Continuity" prize |
| **ETHGlobal Lisbon 2026** | a World prize; the World ID, ENS and Graph integrations ([changelog](https://github.com/MBarralDevs/Project-Alpha/compare/pre-ethglobal-lisbon-2026...main)) |
| **Lepton Agents** (The Canteen × Circle × Arc) | where the platform was born: [event](https://community.arc.io/home/clubs/arc-hackathons/events/hackathon-lepton-agents-em1dcv9xwe) · [demo video](https://www.youtube.com/watch?v=MYlPFlUzvhg) |

**About this repository.** The canonical repo is [jb1011/Project-Alpha](https://github.com/jb1011/Project-Alpha),
the team repo. The fork [MBarralDevs/Project-Alpha](https://github.com/MBarralDevs/Project-Alpha)
exists because ETHGlobal's submission form only accepts repositories on the submitter's own account.

## Documentation

- [docs.novicorpus.com](https://docs.novicorpus.com): the public docs (source in [`docs/`](./docs/README.md))
- [back/README.md](./back/README.md): architecture, deployed contracts, getting started
- [back/docs/README.md](./back/docs/README.md): the index of specs, designs and runbooks
