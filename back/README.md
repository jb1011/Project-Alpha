# Novi Corpus: contracts and backend (`back/`)

The on-chain and server half of [Novi Corpus](../README.md): the Solidity contracts (a Foundry
project at this directory's root) and the TypeScript backend (`backend/`) that runs onboarding,
policy, payments, the public legal-body record and the MCP server for agents. For the product,
the team and the demo, see the [root README](../README.md).

Novi Corpus gives an AI agent a legal body: a Wyoming LLC bound on chain to the agent's ERC-8004
identity, with a verified person who answers for it. The agent acts on its own inside limits it
cannot exceed; the person stays accountable and keeps the controls that matter (pause, veto,
re-key, withdraw, dissolve).

Everything here runs on **Arc testnet**. Real filings are not switched on yet.

## Two ways to get a legal body

**1. The full legal body.** Novi Corpus forms the company and runs the agent's on-chain side:
an ERC-8004 identity, a `LegalManager` that anchors the operating agreement, and an
`AgentTreasury` that holds the agent's USDC under spending rules. Created by
`LegalManagerFactory` through `NoviController`.

**2. A legal body on an identity you already own** ("bring your own"). The customer keeps their
ERC-8004 identity and their own company; Novi Corpus creates a `LegalManager` clone bound to that
identity, with no treasury. Created by `LegalBodyFactory`. On a sandbox deployment the company is
a test declaration with an automatic check; on a production deployment an operator checks it
against the registry.
The browser flow is at `/legal-body` on the site.

## The contracts

**`NoviController`**: the single governed root of platform authority. It is the immutable manager
of the `LegalManager` and `AgentTreasury` of every agent created through the current factory, the
owner of that factory, its beacon and `LegalBodyFactory`, and the holder of each such agent's
ERC-8004 identity. It is a
selector-allowlisted relay: a cold admin manages roles, and the backend key may call only the
selectors it was granted. Handing over the admin role takes 24 hours.

**`LegalManagerFactory`**: `createEntity()` registers the agent's ERC-8004 identity and deploys its
`LegalManager` (a beacon proxy) and `AgentTreasury` in one transaction.

**`LegalManager`**: one per agent. It anchors the hash of the signed operating agreement, links the
identity, and runs the lifecycle Active, Winding down, Dissolved. Amendments are timelocked and
the guardian can veto them; dissolution has its own waiting window before funds are swept and the
body is finalized.

**`AgentTreasury`**: one per agent, immutable. It holds USDC and lets the agent's operator key
spend only within a rolling cap and, when it is on, an allowlist of approved recipients. It stops
spending as soon as the `LegalManager` leaves Active. The guardian can pause it, veto a policy
change, rotate the operator key, edit the allowlist and withdraw everything to safety; policy
changes are timelocked.

**The operator key**: the agent's bound `agentWallet`. It is a wallet Novi Corpus runs for the agent,
on Circle developer-controlled wallets or on Turnkey, and it can only spend what the treasury
allows.

**`LegalBodyFactory`**: for identities the customer owns. When the identity's owner signs an
EIP-712 `LegalBodyLink`, it creates an immutable EIP-1167 clone of `LegalManager` (no treasury)
and is the manager of every body it creates. Its only power over a body is to schedule an
operating-agreement amendment that the body's guardian has signed: it cannot dissolve, cancel a
dissolution or sweep. The owner links the body by writing `encodePointer(body)` under the
`legalBody` metadata key of their identity; `linkedLegalBody(agentId)` returns the linked body or
`address(0)`. Deploy with `script/DeployLegalBodyFactory.s.sol`, then pin and grant the selectors
of `ControllerSelectors.minimalGrants()` on the controller.

**Reused Arc infrastructure**: Arc testnet's ERC-8004 identity, reputation and validation registries,
the ERC-8183 job contract, and USDC.

The step that turns terms into code is the **law to code translator** (`backend/src/policy`):
plain operating-agreement terms ("at most $X per period to approved counterparties") become the
treasury's on-chain rules, and the signed agreement's hash is anchored in the `LegalManager`.

## Legal model

The original idea was a member-less "Bayern" LLC with no human at all. Research on 2026-06-12,
checked against primary sources, ruled that out: a named natural person in control is required
by the Wyoming DAO LLC statute (W.S. 17-31-114), by FinCEN's beneficial-ownership control test
and by Circle's terms. So the model is **an accountable person plus a bounded agent**, which is
what the contracts implement: the person is the on-chain guardian, the agent is the operator
inside its limits. The guardian is verified with World ID. The company answers for what the
agent does on its behalf; the person stays accountable for the company.

## What runs today (Arc testnet)

- **Contracts**: deployed and verified on the explorer, covered by unit, fuzz, invariant, fork
  and security tests. Reviewed internally; no external audit yet.
- **Onboarding**: a resumable onboarding saga that creates the identity, the legal body and the
  treasury, and binds the operator wallet with an EIP-712 `setAgentWallet`. The guardian verifies
  with World ID; where World ID has no path, a waiver is possible and is published as unverified.
  The bring-your-own flow accepts no waiver.
- **Company formation**: wired to [doola's Company Formation API](https://www.doola.com/business-solutions/company-formation-api/)
  against doola's sandbox. Production filings and payment are not switched on yet.
- **Bring your own legal body**: the declared-company check, the signed link, the on-chain body
  and the identity pointer, end to end in the browser.
- **The public record**: a lookup by wallet address or agent number, a signed statement of a
  legal body's standing (`active`, `pending`, `unknown` or `inactive`), a transparency page, and
  a paid standing check, paid with x402 and settled on Hedera.
- **Agent surfaces**: a REST API for the wizard and an MCP server for agents, over the same
  backend, plus ERC-8183 jobs and x402 payments in testnet USDC.
- **A monitor** that watches the controller's roles and relays, the beacon, the identity registry
  and the agents' contracts on chain.

## Deployed addresses: Arc testnet (chain ID 5042002)

Read from the chain on 2026-10-20; every contract is verified on
[explorer.testnet.arc.io](https://explorer.testnet.arc.io).

| Contract | Address |
|---|---|
| `NoviController` | [`0x9526E228E94A125843B2d010c1155780CBBAFb5c`](https://explorer.testnet.arc.io/address/0x9526E228E94A125843B2d010c1155780CBBAFb5c) |
| `LegalManagerFactory`: `createEntity()` | [`0x83D529E813Fe825b84250034A7A63f460A2ECA77`](https://explorer.testnet.arc.io/address/0x83D529E813Fe825b84250034A7A63f460A2ECA77) |
| Upgrade beacon | [`0x432ed0814FcDDd03330add098093482128Ad2CfD`](https://explorer.testnet.arc.io/address/0x432ed0814FcDDd03330add098093482128Ad2CfD) |
| `LegalManager` implementation (shared) | [`0xc2e89ABf562f2EB366e4dde42325af16EeF542a6`](https://explorer.testnet.arc.io/address/0xc2e89ABf562f2EB366e4dde42325af16EeF542a6) |
| `LegalBodyFactory` | [`0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456`](https://explorer.testnet.arc.io/address/0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456) |

`NoviController` owns the factory, the beacon and `LegalBodyFactory`. Per-agent `LegalManager` and
`AgentTreasury` contracts, and bring-your-own legal bodies, are created at runtime and are not
listed here.

**Legacy (June 2026):** the first `LegalManagerFactory`
[`0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902`](https://explorer.testnet.arc.io/address/0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902)
and its beacon
[`0xCbE36eC37673805a185a6883f9597613ABB41c97`](https://explorer.testnet.arc.io/address/0xCbE36eC37673805a185a6883f9597613ABB41c97).
They create no new agents. The beacon still serves the agents created before the controller
(2026-08-17), with the same `LegalManager` implementation; those agents' manager and identity
holder is the June key, not the controller.

**Reused:** ERC-8004 IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`,
ReputationRegistry `0x8004B663…`, ValidationRegistry `0x8004Cb1B…`, ERC-8183 Job `0x0747EEf0…`,
USDC (native gas; 6 decimals as a token) `0x3600…0000`, EURC `0x89B50855…`.

Full machine-readable copy, with owners and deployers: [`addresses.arc-testnet.json`](./addresses.arc-testnet.json).
RPC: `https://rpc.testnet.arc.io`.

## Repository layout

```
.                       Foundry project (Solidity) at the root
  src/                  LegalManager, AgentTreasury, LegalManagerFactory, NoviController,
                        LegalBodyFactory, BreakGlassOneShot, ens/ (offchain resolver), interfaces,
                        libraries (ControllerSelectors)
  test/                 Foundry tests (unit, fuzz, invariant, fork, security)
  script/               deploy scripts (Deploy, DeployController, DeployLegalBodyFactory)
  addresses.arc-testnet.json   deployed addresses (machine-readable)
backend/                TypeScript backend
  src/                  workflow (onboarding saga), legalBody (bring-your-own flow, statements),
                        formation (doola), policy (law to code), oa (operating agreement),
                        adapters (Arc, Circle, Turnkey, doola, World ID, x402),
                        payments (x402), jobs (ERC-8183),
                        monitor, api + mcp (thin faces), hedera, cli
  test/                 vitest unit, anvil integration, env-gated live tests
hedera-client/          customer-side commands for the Hedera rail (the paid standing check)
subgraph/               a July 2026 prototype subgraph; it indexes the legacy factory only
docs/                   specs, designs, plans, research, runbooks: see docs/README.md
```

## Getting started

### Smart contracts (Foundry)

```bash
# 1. install Foundry (CI pins v1.5.1): https://book.getfoundry.sh/getting-started/installation
# 2. install the pinned dependencies (no submodules; lib/ is gitignored):
forge install foundry-rs/forge-std@v1.16.1 --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.1.0 --no-git
# 3. build and test:
forge build && forge test
```

> The contracts are compiled with `evm_version = "paris"` (no PUSH0, Arc's deploy guidance when
> they were first deployed) and with `via_ir`. Both are set in `foundry.toml`: keep them, the
> deployed bytecode was built that way.

### Backend (TypeScript, Node 20.18.2 or later)

```bash
cd backend
npm install
npm run gen:abis     # regenerate typed ABIs from Foundry out/ after any forge build
npm test             # unit + anvil integration (live tests skip without credentials)
```

The integration tests need `anvil` (Foundry) on your PATH. CLI and live-run runbook:
[backend/README.md](./backend/README.md).

## Documentation

Start with **[docs/README.md](./docs/README.md)**, an index of the specs, designs, plans and
research with the status of each. Security reviewers: **[docs/AUDIT_CONTEXT.md](./docs/AUDIT_CONTEXT.md)**
(scope, privileged roles, intended behaviours, dependencies, prior reviews). New engineers: read this README, then the docs index, then
[backend/README.md](./backend/README.md).
