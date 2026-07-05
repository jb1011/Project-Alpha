# Novi Corpus

**A legal body for your AI agent** — built for the [Lepton Agents Hackathon](https://community.arc.io/home/clubs/arc-hackathons/events/hackathon-lepton-agents-em1dcv9xwe) (Canteen × Circle × Arc).

> Anyone can give an agent a wallet. We give it a **legal owner** — so it can hold money safely, pay for services, earn revenue, and be trusted by humans and other agents.

**Live demo:** [project-alpha-pi.vercel.app](https://project-alpha-pi.vercel.app)

---

## What is this?

Novi Corpus turns an AI agent into an accountable economic actor. In one onboarding flow you get:

1. **A Wyoming DAO LLC** — a real legal entity, with an operating agreement whose terms are enforced on-chain.
2. **On-chain identity** — registered on Arc via ERC-8004 (identity + reputation).
3. **A governed USDC treasury** — spending caps, recipient allowlists, and timelocks the agent cannot bypass. You stay the guardian (pause, veto, recover funds).
4. **Nanopayments** — the agent can buy and sell via x402 + Circle Gateway, settled on Arc in testnet USDC.

The agent operates autonomously _within_ the rules you set. You keep ultimate control.

## Repo layout

```
interface/     Next.js web app — onboarding wizard, agent dashboard, landing page
back/          Smart contracts (Foundry) + TypeScript backend ("the brain")
  src/         Solidity: LegalManager, AgentTreasury, factory
  backend/     Onboarding saga, policy translator, Arc/Turnkey adapters, MCP server
  docs/        Specs, designs, and research — start at back/docs/README.md
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
- **ERC-8004 / ERC-8183** — on-chain identity, reputation, and jobs (reused from Arc)
- **Turnkey** — non-custodial passkey-secured signing for the agent operator key
- **Wyoming DAO LLC** — legal wrapper; law-to-code binding between the operating agreement and on-chain rules

## Hackathon links

|              |                                                                                                                           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Event        | [Lepton Agents — Arc House](https://community.arc.io/home/clubs/arc-hackathons/events/hackathon-lepton-agents-em1dcv9xwe) |
| Website      | [lepton.thecanteenapp.com](https://lepton.thecanteenapp.com/)                                                             |
| Discord      | [Canteen Discord](https://discord.gg/rsVfYutFZg)                                                                          |
| Arc builders | [buildonarc Discord](https://discord.com/invite/buildonarc)                                                               |

## Documentation

- [back/README.md](./back/README.md) — architecture, deployed contracts, getting started
- [back/docs/README.md](./back/docs/README.md) — full doc index (specs, designs, runbooks)
- [back/docs/POSITIONING.md](./back/docs/POSITIONING.md) — what makes this different from "just another governed wallet"

## Status

Deployed and running on **Arc testnet**. On-chain contracts, Circle Gateway settlements, and the onboarding flow are real. Wyoming filing, EIN, and counsel-reviewed legal documents are stubbed for the demo.
