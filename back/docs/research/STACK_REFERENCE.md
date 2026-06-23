# Circle + Arc Engineering Reference

> **Purpose:** Authoritative build reference for the agent-legal-body protocol (Wyoming DAO LLC + on-chain identity on Arc, Circle Agent Stack as the financial layer).
> **Compiled:** 2026-05-29 from official Circle (`developers.circle.com`, `agents.circle.com`, `circle.com/blog`) + Arc docs + Circle Skill bundles (`use-arc`, `use-gateway`, `use-smart-contract-platform`, `use-developer-controlled-wallets`).
> **Confidence:** Items not confirmed against a primary page are flagged ⚠️. For live addresses / chain IDs, the **Circle MCP codegen server is the source of truth** (see §11).

---

## 1. Arc Chain

Circle's EVM-compatible L1 where **USDC is the native gas token**. Positioned for the "agentic economy."

**Core specs**
- Native gas = **USDC** (not ETH). Clients defaulting to ETH gas fail.
- EVM-compatible — standard Solidity tooling (Foundry, Hardhat, viem, ethers, web3.py).
- **Sub-second deterministic single-block finality**, irreversible — treat a tx as final after one block; do **not** add multi-block confirmation logic.
- Opt-in confidential transactions w/ selective disclosure. Post-quantum security on roadmap (not yet live).
- **TESTNET ONLY** — no mainnet. ⚠️ Arc Testnet "not reviewed or approved by NYDFS."

**Chain config / endpoints**
- **CAIP-2: `eip155:5042002`** (⇒ EVM chain ID **5042002**, hex `0x4CEF52`). CLI/SDK alias: **`ARC-TESTNET`**.
- RPC: `https://rpc.testnet.arc.network` · WS: `wss://rpc.testnet.arc.network` (per `use-arc` skill).
- Faucet: https://faucet.circle.com · Explorer: https://testnet.arcscan.app
- USDC `0x3600000000000000000000000000000000000000` (6 dec) · EURC `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` (6 dec) · CCTP domain **26** · Gateway domain **26**.
- ⚠️ **Never hardcode addresses** — confirm per chain via MCP / `use-arc`.

**Decimals gotcha:** USDC = **6 decimals** (`parseUnits(x,6)`). Native gas amounts use 18 decimals; the ERC-20 USDC token uses 6. Don't mix.

**⚠️ EVM-version gotcha (critical for our contracts):** compile Solidity with **`evmVersion: "paris"`** (or earlier). Solidity ≥0.8.20 defaults to Shanghai → emits `PUSH0`, which **Arc rejects** (`ESTIMATION_ERROR` / `Create2: Failed on deploy`). Applies to Foundry *and* the Smart Contract Platform.

**Agentic-economy standards (VERIFIED LIVE ON ARC TESTNET 2026-05-29):**
- **ERC-8004 "Trustless Agents"** — real EIP ([eips.ethereum.org/EIPS/eip-8004](https://eips.ethereum.org/EIPS/eip-8004); live on Ethereum mainnet 2026-01-29). Three registries; identity is an **upgradeable ERC-721** (`ERC721URIStorage`). **Arc testnet addresses (same across Sepolia/Base/Polygon/Scroll — vanity `0x8004…`):**
  - IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`
  - ReputationRegistry `0x8004B663056A597Dffe9eCcC1965A193B7388713`
  - ValidationRegistry `0x8004Cb1BF31DAf7788923b405b754f57acEB4272`
  - Identity fns: `register(metadataURI)` → mints identity NFT (agentId); `setAgentURI`, `getMetadata/setMetadata(agentId,key,value)` (on-chain KV — store EIN / formation / OA hash here), `setAgentWallet` (binds wallet via EIP-712/ERC-1271), `ownerOf/tokenURI`. Reputation: `giveFeedback(agentId,score,type,tag,…)`, `getSummary`, `revokeFeedback`. Validation: `validationRequest/validationResponse`. Metadata = IPFS JSON (name, description, agent_type, capabilities, version). Tutorial: `/arc/tutorials/register-your-first-ai-agent`.
- **ERC-8183 "Agentic Commerce"** — real EIP ([eips.ethereum.org/EIPS/eip-8183](https://eips.ethereum.org/EIPS/eip-8183); Virtuals + EF). **Arc testnet:** `0x0747EEf0706327138c69792bF28Cd525089e4583`. "Job" primitive (client/provider/evaluator), programmable USDC escrow. Fns: `createJob(provider,evaluator,expiredAt,description,hook)`→jobId, `setBudget`, `fund` (client approves USDC then funds escrow), `submit(deliverable hash)`, `complete`→settles USDC to provider, `getJob`. States: Open/Funded/Submitted/Completed/Rejected/Expired. USDC `0x3600…0000`. Composes with x402 + ERC-8004. Tutorial: `/arc/tutorials/create-your-first-erc-8183-job`.
- Chain-level compliance: **Elliptic** + **TRM Labs** integrated natively.

**App Kit** (`@circle-fin/app-kit`, `@circle-fin/adapter-viem-v2`): Bridge / Swap / Send / Unified Balance; wraps CCTP + Gateway. Adapters for Viem, Ethers, Solana, Circle Wallets.

> ⚠️ **Docs-domain caveat:** `docs.arc.network` 301-redirects to `docs.arc.io`, and one source flagged `docs.arc.io` may describe a *separate payments product*. Chain ID `eip155:5042002` + USDC-as-gas are confirmed by Circle. **Treat `circle:use-arc` + `developers.circle.com` + Circle MCP as authoritative**; cross-check any `docs.arc.io`-only claim.

---

## 2. Circle Wallets — Developer-Controlled

**Custody:** app/server holds keys via an **entity secret** (NOT MPC). The realistic primitive for autonomous-agent custody.

- npm `@circle-fin/developer-controlled-wallets` · PyPI `circle-developer-controlled-wallets`.
- **Entity Secret** = 32-byte credential the developer controls; Circle never stores it. Built-in encrypt/register/rotate/recover. Must register entity secret + create a **wallet set** before creating wallets. Funcs: `initiateDeveloperControlledWalletsClient`, `createWalletSet`, `createWallets`.
- **EOA** (needs USDC in-wallet for gas on Arc) vs **SCA** (gas sponsorship via Gas Station + batch execution). **Gas Station = SCA only.**
- API-driven create/transfer/balance/sign; idempotency keys; async → **webhooks** for state. ⚠️ tx-state enum from `developer-controlled-wallets.yaml`.
- Chains: EVM + Solana + Aptos; **Arc Testnet** is a quickstart target.

---

## 3. Circle Agent Stack — Overview

**Agent Stack = Agent Wallets + Agent Nanopayments (Gateway) + Agent Marketplace + Circle CLI**, composed from Circle Wallets + CCTP + Gateway + x402 + Gas Station/Paymaster behind one surface. Capabilities: autonomous on-chain ops within policy, hold USDC multichain, x402 per-request payments, spending controls + compliance, cross-chain trading/bridging.

---

## 4. Agent Wallets

"Hold funds and transact onchain autonomously within spending policies you define." CLI/prompt-driven setup.

- **Custody:** built on user-controlled **2-of-2 MPC**; shares never exposed to the agent.
- **⚠️ Auth = email OTP**, `circle wallet login you@example.com [--testnet]`; **sessions expire after 7 days**; separate mainnet/testnet sessions. **For true autonomy the agent must control the auth inbox + auto-re-auth** — a real constraint (a reason to prefer Developer-Controlled wallets for our autonomous agent).
- **Policies:** transfer limits, time bounds, address allow/blocklists, contract blocklists, x402 nanopayment caps. ⚠️ exact schema on policies sub-page.
- **Gas-sponsored** ("gasless across chains"), caps "subject to change" ⚠️.
- Tokens: USDC, EURC, ERC-20, native.
- **Supported chains:** mainnet ARB/AVAX/BASE/ETH/MONAD/OP/MATIC/UNI; testnet adds **`ARC-TESTNET`** (Arc = **testnet only** here). Verify at runtime: `circle blockchain list`.
- Quickstart: install `@circle-fin/cli` (Node ≥20.18.2) → `circle wallet login` → `circle wallet list --type agent --chain ARC-TESTNET` → testnet auto-funds **20 USDC** (omit `--method/--amount`).

---

## 5. Agent Nanopayments + x402

Gas-free, **batched** USDC payments at sub-cent scale for x402 services (machine-to-machine).

**x402 flow:** call paid API → `HTTP 402` → agent sends signed payment authorization → **Gateway (facilitator)** verifies + **batches** many auths → single on-chain settlement (amortizes gas to sub-cent) → `200` + resource.

- **Minimum: $0.000001** per payment. Marketplace per-call costs ~$0.02–$5.55.
- Powered by **Gateway** (unified USDC balance, **<500ms** transfers). Funds held in **Gateway balance**, not on-chain by default; seller revenue accrues to seller's Gateway balance.
- **Settlement is batched, not real-time** — seller balance credits after a batch settles.
- Facilitator (testnet): **`https://gateway-api-testnet.circle.com`**.
- **Storefront (seller):** npm `@circle-fin/x402-batching` → `createGatewayMiddleware({ sellerAddress })`; guard route with `gateway.require("$0.01")` — **price is a USD string**, not raw USDC units.
- **Buyer (CLI):** `circle gateway deposit|balance|withdraw` (⚠️ `withdraw` = same-chain only), `circle services pay <URL> --max-amount`.
- ⚠️ Confirm x402 settlement on `ARC-TESTNET` specifically (Gateway supports Arc testnet, domain 26).

---

## 6. Agent Marketplace (`agents.circle.com`)

"Circle for Agents" — discover + pay for paid APIs in USDC via x402; no signups/cards/API keys/subscriptions. Catalog: `agents.circle.com/services`. Clients: Claude, Codex, Cursor, Claws, custom. Sellers: declare a wallet address + use `@circle-fin/x402-batching` (no signup). Setup skill: `curl -sL https://agents.circle.com/skills/setup.md`.

---

## 7. Circle CLI

`@circle-fin/cli` (global; Node ≥20.18.2). Controls: wallet create/manage, transfer/swap/bridge USDC (CCTP under hood), execute contracts, discover/pay x402 services. Wallet types: **Agent Wallets** (email OTP + policies) and **Local wallets** (self-custodial, Open Wallet Standard, key/mnemonic import). Key cmds: `circle wallet login|create|list|fund|balance`, `circle blockchain list`, `circle gateway deposit|balance|withdraw`, `circle services pay`.

---

## 8. Compliance Engine

Circle Wallets' AML/CTF **transaction screening** — **eligibility-gated** (must apply via Circle; ⚠️ may affect timeline). Real-time screening, allow/blocklists, configurable alert rules, data export, address investigation. Quickstart `/wallets/compliance-engine/tx-screening-quickstart`; OpenAPI `compliance.yaml`. ⚠️ Supported chains (incl. Arc) + account-type applicability not confirmed. (Arc also has chain-level Elliptic/TRM.)

---

## 9. Smart Contract Platform (deploy our contracts)

- npm `@circle-fin/smart-contract-platform` (pair with `@circle-fin/developer-controlled-wallets`). Dual-client: **SCP reads/deploys/monitors; wallets-client does writes** (`createContractExecutionTransaction`).
- Deploy via **bytecode + ABI**, or audited templates (ERC-20/721/1155/Airdrop, Thirdweb-sourced). **⚠️ Deployment needs a dev-controlled SCA wallet (not EOA)**; gasless deploy via Gas Station.
- Reads → `queryContract()` (no gas). Deploys are **async** → poll `getContract()` `deploymentStatus`. Blockchain id `'ARC-TESTNET'`. Idempotency = UUID v4. **Compile `evmVersion: "paris"`** (see §1). Event monitoring via webhooks. `name` field alphanumeric only; fee = nested `fee:{type:'level',config:{feeLevel:'MEDIUM'}}`.
- Alternative: just deploy with **Foundry** to Arc RPC (also needs paris). Choose per the plan.

---

## 10. SDKs + API Reference

- **Base URL `https://api.circle.com`**; **Bearer** auth; **separate testnet/mainnet keys**. **CCTP + Gateway are permissionless (no API key).** Health: `GET /ping` → `{"message":"pong"}` (unauth).
- **Gas sponsorship — two models (don't conflate):** **Gas Station** (developer sponsors fees; SCA only) vs **Paymaster** (ERC-4337; end user pays gas in USDC).
- **Cross-chain:** **CCTP V2 default** (V1 legacy, still needed on Noble/Sui/Aptos). Bridge Kit (`@circle-fin/bridge-kit`) for frontend; raw CCTP for backend. CCTP→Arc quickstarts exist.
- Other wallets: User-Controlled (`@circle-fin/user-controlled-wallets`, MPC, social/OTP/PIN), Modular (`@circle-fin/modular-wallets-core`, ERC-4337/6900, passkeys).
- Gateway: 11 EVM chains + Solana (mainnet+testnet) + **Arc testnet (domain 26)**. OpenAPI specs at `developers.circle.com/openapi/`.

---

## 11. Circle MCP (live source-of-truth for addresses/IDs)

**Codegen** MCP server (dev tooling, not runtime): `https://api.circle.com/v1/codegen/mcp`, server name `circle`. Exposes AI-assisted codegen for Wallets, SCP, CCTP, Gateway + **live SDK signatures, contract addresses, chain IDs.** Install (Claude Code): `claude mcp add --transport http circle https://api.circle.com/v1/codegen/mcp --scope user`. Separate **Arc docs MCP** at `docs.arc.io/ai/mcp`. ⚠️ MCP auth model undocumented.

---

## 12. How each piece maps to OUR protocol

| Need | Piece | Use |
|---|---|---|
| On-chain agent identity (the "body" registry) | **Arc + ERC-8004** + our Entity contract | Align/extend ERC-8004 for identity/reputation; bind to off-chain Wyoming LLC + OA hash |
| Job / settlement (proof-of-life) | **Arc + ERC-8183** | Escrow-funded job → deliverable → USDC settlement |
| Agent treasury/custody | **Developer-Controlled Wallets (entity secret)** primary; Agent Wallets alt | Dev-controlled avoids email-OTP/7-day-session limit → cleaner autonomy |
| Spending guardrails | Agent Wallet policies / our Governance + **Compliance Engine** | Limits, allow/blocklists, x402 caps; AML screening (gated) |
| Pay/earn for services | **Nanopayments + x402 + `@circle-fin/x402-batching`** | Agent pays per-call; expose our API as storefront |
| Service discovery | **Agent Marketplace** | List/consume at `agents.circle.com/services` |
| Gas | **Arc USDC-as-gas**; Gas Station/Paymaster elsewhere | On Arc gas is USDC; sponsor SCA if needed |
| Cross-chain USDC | **CCTP V2 + Gateway + App Kit** | Fund Arc treasury; unified balance for nanopayments |
| Deploy contracts | **SCP (SCA wallet) or Foundry** | `evmVersion:paris`; async deploy; webhook events |
| Dev tooling | **Circle MCP + Skills** | Live addresses/IDs; `use-arc/use-gateway/use-dev-controlled` |

### Top gotchas (carry into the plan)
1. Arc testnet-only, not NYDFS-reviewed. 2. Agent Wallets on Arc = testnet only. 3. USDC-as-gas (not ETH). 4. Single-block finality (no multi-confirm). 5. USDC 6 decimals. 6. **Agent Wallet email-OTP/7-day sessions** → prefer dev-controlled for autonomy. 7. Gas Station = SCA only. 8. `gateway withdraw` same-chain only. 9. Nanopayment revenue batched, held in Gateway balance. 10. x402 price = USD string. 11. Entity secret = your liability (rotate/recover). 12. Never hardcode addresses. 13. **`evmVersion:paris` or Arc deploy fails.** 14. CCTP V2 default. 15. Async everything → webhooks. 16. Compliance Engine eligibility-gated (timeline risk).

### Open unknowns to verify (via Circle MCP / DevRel)
- Exact Arc RPC/addresses + ERC-8004/8183 addresses & ABIs; Arc gas-fee model/units; Agent Wallet policy schema + sponsorship caps; whether Agent Wallets are EOA/SCA; x402 settlement on Arc specifically; Gateway fee schedule; Compliance Engine chains + approval timeline; Arc mainnet roadmap date; Circle MCP auth.
