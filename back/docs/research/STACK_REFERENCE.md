# Circle and Arc engineering reference

> **Purpose:** the build reference for Novi Corpus's stack: a Wyoming LLC bound to an on-chain
> identity on Arc, with Circle as the financial layer.
> **Compiled** 2026-05-29 from Circle's and Arc's official docs and Circle's skill bundles;
> **refreshed** 2026-10-21 against our code and our checks of September and October 2026. Items
> not confirmed against a primary source are marked "unconfirmed". For live addresses and chain
> ids, Circle's codegen MCP server and docs.arc.io are the sources of truth (§11); in our code,
> `back/backend/src/chains.ts` and `back/backend/src/config/env.ts`.

---

## What changed since 2026-05-29

- **Arc mainnet launched on 2026-09-16** (chain id 5042). This reference no longer says
  "testnet only".
- **New hosts.** Testnet RPC `https://rpc.testnet.arc.io`, explorer `https://explorer.testnet.arc.io`,
  docs `https://docs.arc.io`. The old `rpc.testnet.arc.network` stopped resolving around
  2026-10-16; `testnet.arcscan.app` redirects to the new explorer.
- **PUSH0.** Arc runs contracts that use PUSH0 (the ERC-8004 registry's implementation on testnet
  does). Our contracts are still compiled with `evmVersion: "paris"` because the deployed
  bytecode was built that way.
- **Circle Agent Wallets:** sessions last 28 days (not 7), the wallets are smart accounts, and Arc
  mainnet is supported (§4).
- **x402:** our code now uses the x402 v2 packages (§5).

---

## 1. Arc

Circle's EVM-compatible L1 where **USDC is the native gas token**.

**Core facts**
- Gas is paid in **USDC** (not ETH). Clients that assume ETH gas fail.
- EVM compatible: standard Solidity tooling (Foundry, Hardhat, viem, ethers).
- **Sub-second deterministic finality in one block**: treat a transaction as final after one
  block; no multi-block confirmation logic.
- Opt-in confidential transactions with selective disclosure. Post-quantum security is on the
  roadmap.

**Networks**

| | Testnet | Mainnet |
|---|---|---|
| Chain id | `5042002` (`eip155:5042002`, CLI alias `ARC-TESTNET`) | `5042` (`eip155:5042`, CLI alias `ARC`) |
| RPC | `https://rpc.testnet.arc.io` | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.testnet.arc.io` | `https://explorer.arc.io` |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| ERC-8004 ValidationRegistry | `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` | `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` |
| ERC-8183 Job | `0x0747EEf0706327138c69792bF28Cd525089e4583` | none known (unconfirmed) |

- USDC `0x3600000000000000000000000000000000000000` (6 decimals as a token) and EURC
  `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` on testnet. CCTP and Gateway domain **26**.
- Faucet: https://faucet.circle.com.
- **Decimals:** the USDC token has 6 decimals; native gas amounts use 18. Do not mix them.
- **The public testnet RPC** refuses `eth_getLogs` over many addresses or a large block range
  ("requested range too large", -32012) and rate-limits heavy use; on 2026-10-20 it also returned
  no receipt for transactions from June. Use the explorer's API for old history.
- **EVM version:** Arc's early guidance was to compile with `evmVersion: "paris"` (no PUSH0). Arc
  now runs PUSH0 bytecode (our fork tests run under `shanghai` for that reason). Our contracts keep
  `paris` so that rebuilt bytecode matches what is deployed; new projects can follow Arc's current
  docs.
- Never hard-code addresses from memory: confirm them per chain.

**Agentic-economy standards on Arc**
- **ERC-8004 "Trustless Agents"** ([EIP](https://eips.ethereum.org/EIPS/eip-8004)): three
  registries; identity is an upgradeable ERC-721. Identity functions: `register(agentURI)` mints
  the identity (agentId); `setAgentURI`; `getMetadata` / `setMetadata(agentId, key, value)`, an
  on-chain key-value store; `setAgentWallet` binds a wallet with an EIP-712 signature (ECDSA or
  ERC-1271); `ownerOf`, `tokenURI`. Reputation: `giveFeedback`, `getSummary`, `revokeFeedback`.
  Validation: `validationRequest`, `validationResponse`.
- **ERC-8183 "Agentic Commerce"** ([EIP](https://eips.ethereum.org/EIPS/eip-8183)): the job
  primitive (client, provider, evaluator) with a USDC escrow: `createJob`, `setBudget`, `fund`,
  `submit`, `complete` (settles USDC to the provider), `getJob`. States Open, Funded, Submitted,
  Completed, Rejected, Expired. Testnet only as far as we know.
- Chain-level compliance: Elliptic and TRM Labs are integrated.

**App Kit** (`@circle-fin/app-kit`, `@circle-fin/adapter-viem-v2`): bridge, swap, send, unified
balance; wraps CCTP and Gateway.

---

## 2. Circle Wallets: developer-controlled

**Custody:** the app holds the keys through an **entity secret**. This is what Novi Corpus uses
for the agents' operating wallets (`custody: "circle"`).

- npm `@circle-fin/developer-controlled-wallets` (we use 10.x).
- The **entity secret** is a 32-byte credential the developer controls; Circle never stores it.
  Register it and create a **wallet set** before creating wallets.
- **EOA** (needs USDC for gas on Arc) or **SCA** (gas sponsored through Gas Station, batch
  execution). Gas Station sponsors SCAs only.
- API-driven create, transfer, balance and sign; idempotency keys; webhooks for state.
- On Arc mainnet from day one, with Gas Station, the Smart Contract Platform and Gateway.
- Transaction `refId` is limited to 100 characters.

---

## 3. Circle Agent Stack: overview

**Agent Stack = Agent Wallets + Agent Nanopayments (Gateway) + Agent Marketplace + Circle CLI**,
built from Circle Wallets, CCTP, Gateway, x402 and Gas Station behind one surface.

---

## 4. Agent Wallets

"Hold funds and transact onchain autonomously within spending policies you define." Checked
between 2026-09-28 and 2026-10-01, including a live test on Arc testnet.

- **Operated only through Circle's CLI** (`@circle-fin/cli`, Node 20.18.2 or later); there is no
  SDK or API.
- **Login by email one-time code**, `circle wallet login you@example.com [--testnet]`. A session
  lasts **28 days** and cannot be refreshed; testnet and mainnet have separate logins. While a
  session lasts, the machine signs with no human step.
- **Smart accounts** (Circle's single-owner modular account): signatures verify through ERC-1271,
  and the account must be deployed on a chain before it can sign there. Gas is sponsored by Circle.
- **Policies** (transfer limits, allow and block lists): mainnet only, and not readable by a third
  party.
- **Chains:** Arc mainnet (`ARC`) since 2026-09-16 and Arc testnet (`ARC-TESTNET`), plus other
  EVM mainnets. Verify with `circle blockchain list`.
- **Terms:** the holder is a natural person, and no third party may operate the wallet or its
  sessions. That is why Novi Corpus runs agents on developer-controlled wallets, and treats an
  Agent Wallet only as a customer's own wallet.

---

## 5. Agent Nanopayments and x402

Gas-free, **batched** USDC payments at sub-cent scale for x402 services.

**x402 flow:** call a paid API, get `HTTP 402`, send a signed payment authorization; the
**Gateway** facilitator verifies and **batches** many authorizations into one on-chain settlement;
then `200` and the resource.

- Minimum $0.000001 per payment. Funds sit in the **Gateway balance**; seller revenue accrues
  there and is credited after a batch settles.
- Gateway batch payments are signed by an EOA. Since 2026-08-05 Gateway accepts ERC-1271
  signatures from smart accounts for burn intents only.
- Circle also runs a hosted **x402 Facilitator Service** (Arc, Base and Polygon, `eip155:5042` on
  Arc mainnet); its pricing was unpublished when we checked.
- **Our code:** the x402 v2 packages (`@x402/core`, `@x402/evm`, `@x402/hono`, `@x402/hedera`,
  2.25) and `@circle-fin/x402-batching` 3.x for Gateway batching; the legacy `x402` 1.x package is
  still a dependency.
- Prices in Circle's seller middleware are USD strings (`gateway.require("$0.01")`), not raw
  units.

---

## 6. Agent Marketplace (`agents.circle.com`)

Discover and pay for paid APIs in USDC through x402, with no sign-up, card or API key. About 2,777
listings at the end of September 2026, none for legal or KYB checks. Listing is through a form
linked from Circle's blog, for mainnet services.

---

## 7. Circle CLI

`@circle-fin/cli` (global; Node 20.18.2 or later): wallet create and manage, transfer, swap and
bridge USDC, execute contracts, sign typed data, discover and pay x402 services. Wallet types:
**Agent Wallets** (email code and policies) and **local wallets** (self-custodial). Circle can
block old CLI versions remotely, so do not pin one.

---

## 8. Compliance Engine

Circle Wallets' AML/CTF **transaction screening**, available on application to Circle. Real-time
screening, allow and block lists, alert rules, data export. Whether it covers Arc is unconfirmed.
Arc also has chain-level Elliptic and TRM screening.

---

## 9. Smart Contract Platform

- npm `@circle-fin/smart-contract-platform` (paired with the developer-controlled wallets client:
  the platform reads, deploys and monitors; the wallets client writes).
- Deploy from bytecode and ABI, or from audited templates. Deployment needs a developer-controlled
  SCA wallet; Gas Station can sponsor it. Deploys are async (poll `getContract()`); events through
  webhooks.
- We deploy with **Foundry** instead (`back/script/`).

---

## 10. SDKs and API

- Base URL `https://api.circle.com`, Bearer auth, separate testnet and mainnet keys. CCTP and
  Gateway are permissionless.
- **Gas sponsorship, two models:** Gas Station (the developer pays, SCAs only) and Paymaster
  (ERC-4337; the user pays gas in USDC).
- **Cross-chain:** CCTP V2 by default; Bridge Kit (`@circle-fin/bridge-kit`) for frontends.
- Other wallets: user-controlled (`@circle-fin/user-controlled-wallets`), modular
  (`@circle-fin/modular-wallets-core`, ERC-4337/6900, passkeys).

---

## 11. Sources of truth for addresses and ids

- Circle's **codegen MCP server**, `https://api.circle.com/v1/codegen/mcp` (server name `circle`):
  live SDK signatures, contract addresses, chain ids. Claude Code:
  `claude mcp add --transport http circle https://api.circle.com/v1/codegen/mcp --scope user`.
- **docs.arc.io** (connect and RPC pages) and its docs MCP at `docs.arc.io/ai/mcp`.
- Circle's skills repository (`circlefin/skills`, `use-arc`).

---

## 12. How each piece maps to Novi Corpus

| Need | Piece | Use |
|---|---|---|
| The agent's on-chain identity | **ERC-8004** on Arc | Bound to the legal body; the `legalBody` metadata key points at it |
| Jobs and settlement | **ERC-8183** on Arc testnet | Escrow-funded jobs |
| The agent's operating wallet | **Developer-controlled wallets** (or Turnkey) | Run by Novi Corpus within the treasury's on-chain rules |
| A customer's own wallet | **Agent Wallets** | Only as the customer's wallet, never operated by Novi Corpus |
| Spending rules | Our `AgentTreasury` on chain | Cap, allowlist, pause, enforced by the contract |
| Paying and earning | **x402**, Gateway nanopayments | Agents pay per call; our paid standing check sells over x402 |
| Discovery | **Agent Marketplace** | Mainnet listing for the paid standing check |
| Gas | USDC on Arc; Gas Station for SCAs | |
| Cross-chain USDC | CCTP V2, Gateway, App Kit | Funding from other chains |
| Deploying contracts | **Foundry** | `paris` build setting kept for our contracts |

### Top gotchas

1. USDC is the gas. 2. One-block finality. 3. USDC has 6 decimals as a token, 18 as native gas.
4. Agent Wallets: email login, 28-day sessions, a natural person holds them. 5. Gas Station
sponsors SCAs only. 6. Nanopayment revenue is batched and held in the Gateway balance. 7. x402
prices are USD strings in Circle's middleware. 8. The entity secret is your liability (rotate and
recover it). 9. Never hard-code addresses from memory; mainnet and testnet registries differ.
10. Async everything: use webhooks. 11. The public testnet RPC limits log queries and old
receipts.

### Still open

Agent Wallet limit defaults and whether they cover contract calls and typed-data signatures; the
Agent Wallet gas sponsorship cap; whether an ERC-8183 job contract will exist on Arc mainnet; the
x402 Facilitator Service's pricing; Compliance Engine coverage of Arc.
