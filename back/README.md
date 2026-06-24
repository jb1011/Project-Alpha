# Agent Legal Body

> Working name. Giving autonomous AI agents a real **legal body** so they can own assets, get paid,
> and act as accountable economic actors — without a human behind every signature.

A developer brings an AI agent; in one workflow we give it: a **legal entity** (Wyoming LLC), an
**on-chain identity** (ERC-8004), and a **USDC treasury governed by hard, on-chain spending rules** —
wired into the **Circle Agent Stack** and settled on **Arc** (Circle's L1, chain ID 5042002, where
USDC is the native gas token).

The agent is a **bounded operator**: it spends autonomously *within* limits it cannot exceed (cap per
period + approved-recipient allowlist), while a **human controller** stays in ultimate control
(pause / veto / key-rotate / sweep-to-safety). That human is also the legally-required, KYC'd
controller-of-record that keeps the entity alive — see the legal model note below.

## What can an agent not do without this?
A raw key already lets an agent move USDC. What it *can't* do is be **trusted** with money: spend
under limits it physically cannot break, be stopped/recovered when it misbehaves, have an accountable
legal owner, and carry a verifiable identity counterparties can rely on. This project is that missing
trust-and-safety layer for agentic commerce.

> 📦 **This is the `back/` half of the [Project-Alpha](https://github.com/jb1011/Project-Alpha) monorepo**
> (the frontend lives in `interface/`; live demo: https://project-alpha-pi.vercel.app). The backend's full
> commit-by-commit engineering history — 30+ TDD/audit commits — is preserved in the archived source repo:
> **[ArcXBayernMeca/ProjectAlpha](https://github.com/ArcXBayernMeca/ProjectAlpha)** (read-only).

## Architecture in one picture
- **`LegalManagerFactory`** — entry point; `createEntity()` mints the agent's ERC-8004 identity and
  deploys its `LegalManager` + `AgentTreasury` in one atomic transaction.
- **`LegalManager`** (upgradeable, beacon proxy, one per agent) — holds the operating-agreement hash,
  links the identity, and enforces rule amendments + dissolution via a timelocked, guardian-vetoable
  process.
- **`AgentTreasury`** (immutable, one per agent) — the non-custodial vault: holds USDC and enforces
  the on-chain spending policy (rolling cap + allowlist).
- **Operator key** — the agent's bound `agentWallet`, a **non-custodial Turnkey enclave key** that
  *signs* spends but never holds custody; the human is the on-chain **guardian/controller**.
- Reuses Arc's live **ERC-8004** (identity/reputation) and **ERC-8183** (agent jobs).

The novel piece is the **law → code translator**: plain operating-agreement terms ("≤ $X per period to
approved counterparties") become enforced on-chain rules, with the signed agreement's hash anchored
on-chain. Custody is non-custodial by design — that's also what keeps the platform clear of
money-transmitter licensing.

## Repository layout
```
.                      Foundry project (Solidity contracts) at the root
  src/                 contracts: LegalManager, AgentTreasury, factory, interfaces
  test/                Foundry tests (unit + fuzz + invariant + security)
  script/              deploy scripts
  addresses.arc-testnet.json   deployed addresses (machine-readable)
backend/               TypeScript "brain": the onboarding orchestrator + CLI
  src/                 config, persistence, policy (translator), oa generator,
                       adapters (arc/viem, turnkey), workflow (onboarding saga), cli
  test/                vitest unit + anvil integration + env-gated live tests
docs/                  all specs, designs, plans, research — see docs/README.md
```

## Status
- ✅ **Phase 1 — Smart-contract layer:** built, internally audited (no Critical/High), **deployed to
  Arc testnet (2026-06-12)**. 159 Foundry tests pass (unit + fuzz + invariant + security). Addresses below.
- ✅ **Phase 2 — Backend "brain":** the full onboarding flow is built and tested against a local chain
  (anvil) end-to-end — config/persistence, the law→code translator, operating-agreement generator,
  the Arc adapter (`createEntity` + EIP-712 `setAgentWallet` binding), the Turnkey operator signer, the
  idempotent/resumable onboarding saga, and a CLI. The first **live Arc-testnet** run (with a Turnkey
  operator key) is the remaining step.
- ⬜ **Phase 3 — Thin faces:** MCP server + web wizard over the same backend.
- ⬜ **Phase 4 — Demo agent:** an autonomous ERC-8183 "proof of life" (the agent earns USDC on Arc).

**Real vs. mocked (transparent):** everything on-chain + Circle is real on testnet. The *legal layer*
— Wyoming filing, EIN, KYC, counsel-reviewed documents — is stubbed for the demo and becomes real with
funding + counsel. Production-hardening items are tracked in [docs/V2_HARDENING_BACKLOG.md](./docs/V2_HARDENING_BACKLOG.md).

## ⚖️ Legal model (important — read before pitching)
The original framing was a "Bayern mechanism / zero-member LLC" (a fully human-less entity). Research
on 2026-06-12 (verified against primary sources) **foreclosed** that: a named, KYC'd **natural-person
controller-of-record is mandatory** — triple-locked by Wyoming DAO LLC statute (W.S. 17-31-114), the
FinCEN CDD control prong, and Circle's own terms. The real, defensible model is
**human-controller + agent-bounded-operator**, which is exactly what the architecture already implements
(the human is the on-chain guardian/controller; the agent is the bounded operator). Lead with that —
not "no human / fully autonomous." Details: [docs/research/LEGAL_OPERATIONS.md](./docs/research/LEGAL_OPERATIONS.md)
(Bayern remains the origin/context, not the production claim).

## Deployed addresses — Arc testnet (chain ID 5042002)
**Our contracts** (live, 2026-06-12):

| Contract | Address |
|---|---|
| `LegalManagerFactory` — entry point; `createEntity()` | [`0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902`](https://testnet.arcscan.app/address/0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902) |
| `LegalManager` implementation (shared via beacon) | [`0xc2e89ABf562f2EB366e4dde42325af16EeF542a6`](https://testnet.arcscan.app/address/0xc2e89ABf562f2EB366e4dde42325af16EeF542a6) |
| Upgrade beacon | [`0xCbE36eC37673805a185a6883f9597613ABB41c97`](https://testnet.arcscan.app/address/0xCbE36eC37673805a185a6883f9597613ABB41c97) |

Per-agent `LegalManager` + `AgentTreasury` instances are created **at runtime** by `createEntity` — not
deployed up front. The beacon owner is currently the deployer (a testnet key); move it to a
multisig/timelock before production.

**Reused Arc infrastructure** (live; we build on these): ERC-8004 IdentityRegistry
`0x8004A818BFB912233c491871b3d84c89A494BD9e`, ReputationRegistry `0x8004B663…`, ValidationRegistry
`0x8004Cb1B…`, ERC-8183 Job `0x0747EEf0…`, USDC (6 dec, native gas) `0x3600…0000`, EURC `0x89B50855…`.
Full machine-readable copy: [`addresses.arc-testnet.json`](./addresses.arc-testnet.json) · Explorer:
[testnet.arcscan.app](https://testnet.arcscan.app)

## Getting started

### Smart contracts (Foundry)
```bash
# 1. install Foundry: https://book.getfoundry.sh/getting-started/installation
# 2. install pinned deps (no submodules — lib/ is gitignored):
forge install foundry-rs/forge-std@v1.16.1 --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.1.0 --no-git
# 3. build + test:
forge build && forge test
```
> Arc requires `evm_version = "paris"` (no PUSH0). Already set in `foundry.toml` — do not change it.

### Backend (TypeScript)
```bash
cd backend
npm install
npm run gen:abis     # regenerate typed ABIs from Foundry out/ after any forge build
npm test             # unit + anvil integration (live tests skip without creds)
```
Requires `anvil` (Foundry) on PATH for the integration tests. CLI + live-run runbook:
[backend/README.md](./backend/README.md).

## Documentation
Start here: **[docs/README.md](./docs/README.md)** — an index of every spec, design, plan, and research
doc with its current/historical status. New engineers: read this README, then the docs index, then
[backend/README.md](./backend/README.md).

## Team & funding
Technical lead: Martin (Web3/DeFi, Arc builder). Legal/research co-founder owns the legal layer.
Targeting Circle Developer Grants / Arc Builders Fund (agentic commerce is an official vertical).
