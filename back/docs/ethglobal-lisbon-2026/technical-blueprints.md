# ETHGlobal Lisbon 2026 — Implementation Blueprints (The Graph × World × ENS)

Research date: 2026-07-24. All facts verified against live docs, npm, on-chain state, and this repo.
Constraint honored throughout: **core contracts stay on Arc**; every integration is additive.

> **⚠ 2026-07-24 evening — corrections applied.** A second verification pass produced the
> authoritative per-stack build references (`reference-thegraph.md`, `reference-world.md`,
> `reference-ens.md` — each with a "deltas" section). Corrections found there have been
> patched into this file; where this summary and a reference doc disagree, **the reference
> doc wins**.

Unifying narrative: **"The trust stack for agent legal bodies"**
- Who is the human? → World ID (guardian proof-of-personhood)
- What is it called / how to verify? → ENS + ENSIP-25 (↔ our ERC-8004 on Arc)
- Is it behaving? → The Graph subgraph on `arc-testnet` (governance observability)

---

## 1. THE GRAPH (~14–20h) — targets: Best AI Tooling $5k, AI Use Case $3k, Continuity $4k, maybe Composable $3k

### Ground truth (verified on-chain + in repo)
- `LegalManagerFactory` `0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902`, **created at block 46,739,165**, 45 logs live. Per-agent `LegalManager` (beacon proxy) + `AgentTreasury` are factory-created → subgraph **templates** required.
- `arc-testnet` is first-class in the Networks Registry (caip2 `eip155:5042002`, Studio deploys supported, NO substreams/firehose/token-api).
- USDC `0x36000…0000` emits standard Transfer logs BUT has 74.8M txs — never index it globally.
- **Gaps (frame honestly):** no treasury-funding event (plain `safeTransfer` in); x402 payments never touch the treasury contract (`OperatorFunded` is the on-chain spend signal). Subgraph = "governance/custody plane". **No contract redeploy required.**
- `PolicyUpdated` lacks policyId → recompute in mapping: keccak of `abi.encode(cap, period, allowlistOn, payout)` (mirrors `_policyId`).
- `TreasuryCreated` lacks cap/period/allowlist/payout → `try_` eth_calls at creation block, nullable in schema.

### Toolchain
- `@graphprotocol/graph-cli@0.98.1`, `graph-ts@0.38.2`; manifest `specVersion: 1.3.0`, `apiVersion: 0.0.9`.
- ABIs: extract from Foundry `out/*.json` (`['abi']`).
- Flow: `graph init --from-contract 0x9199… --network arc-testnet --abi ./abis/LegalManagerFactory.json novi-corpus-arc` (CORRECTED: the `--product` flag no longer exists in graph-cli 0.98.1) → codegen/build → `graph auth <KEY>` → `graph deploy novi-corpus-arc`.
- Studio deploy alone is queryable free: `https://api.studio.thegraph.com/query/<uid>/<slug>/version/latest` (3k q/day, no auth). Publish (Arbitrum One tx) optional; testnets served by Edge & Node upgrade indexer (best-effort, auto-pruning, no time-travel). Gateway free plan 100k q/month.
- Templates: `TreasuryTemplate.createWithContext(addr, ctx)` with `ctx.setString("agentId", …)`; read via `dataSource.context()`. Templates index from creation block only (fine).
- Schema: entities AgentEntity / Treasury / SpendEvent(immutable) / PolicyProposal / Incident + timeseries `SpendPoint` with `@aggregation(intervals:["hour","day"])` (hour/day ONLY). Emit SpendPoint from BOTH `Spent` and `OperatorFunded` (both consume cap on-chain).
- Query from backend: plain `fetch` POST (graph-client is maintenance-mode; no new deps).

### Governed x402 pay-per-query (the differentiator)
- `@graphprotocol/client-x402` v1.0.0: **raw private key only, NO hooks/max-price** — silently pays. Don't use it; we speak x402 natively.
- Endpoints (any subgraph by ID): prod `https://gateway.thegraph.com/api/x402/subgraphs/id/<ID>` (Base mainnet, $0.01/query); **testnet `https://gateway.testnet.thegraph.com/api/x402/subgraphs/id/<ID>`** (CORRECTED host — `testnet.gateway.…` is NXDOMAIN) (Base Sepolia, eip155:84532, testnet price 42 atomic units ≈ $0.000042). EIP-3009 (no ETH gas needed), no refunds on empty results.
- **The gateway speaks x402 v2, not v1** (CORRECTED): empty 402 body, challenge in `PAYMENT-REQUIRED` header, `amount` field, pay via `PAYMENT-SIGNATURE` header — our v1 `buyWithX402` cannot be pointed at it as-is. Build a small v2 sibling (see reference-thegraph.md §7); the `evaluatePolicy` + pending-ledger chokepoint is reused unchanged. Base Sepolia USDC EIP-3009 domain name is `"USDC"` (Base mainnet: `"USD Coin"`) — both arrive in the challenge's `extra`. New `payments/graphQuery.ts` mirrors `entityPayment.ts` (idempotency → policy → pay → settle ledger).
- **Paid-leg caveat:** the x402 gateway serves *published* network subgraphs — a Studio-only deployment may not be reachable through it. Publish ours (small Arbitrum One tx) before demoing the paid leg, or demo against a known published subgraph id.
- Fund payer key: Circle faucet (faucet.circle.com) Base Sepolia USDC — 1 USDC = 100 queries. Stretch: Gateway unified-balance mint from Arc float (new adapter surface, ~2–3h; faucet is the safety net).
- MCP tools (buildMcpServer idiom, optional-deps pattern): `treasury_history` (read cap) + `query_subgraph_x402` (spend cap, policy-gated).
- Guardian alert watcher: ~80 LOC cursor poll (`incidents`, `policyProposals(status: SCHEDULED)`) every ~15s → dashboard. Demo: live pause → alert.

### Packaging (judging: usefulness 30 / reusability 25 / Graph use 20 / execution 15 / innovation 10)
- Anthropic-format `skills/governed-graph-query/SKILL.md` (frontmatter name/description/version) + `references/` (schema + query cookbook) + Claude Code plugin manifest. 2–4 min demo video is a hard requirement.
- Also wire the official Subgraph MCP (`https://subgraphs.mcp.thegraph.com/sse`, Bearer = Studio API key, 9 tools) into the demo Claude config.
- Differentiation vs PayQL (prior art wrapping the x402 gateway): ours is **governed** — policy-engine-gated, treasury-accountable, guardian-clawable.

### Risks
1. Upgrade-indexer on brand-new arc-testnet → deploy walking skeleton hour 1; fallback self-hosted graph-node docker vs `https://rpc.testnet.arc.network` (~1h).
2. `ethereum.call` in mappings may fail on fresh integration → always `try_`, nullable, never load-bearing.
3. Testnet x402 gateway is their newest piece → test one paid query early; fallback = free Studio endpoint for governance demo + $0.05 on Base mainnet.

Hours: subgraph 5–7 · watcher 2–3 · governed x402 + MCP 4–6 · SKILL/video 3–4.

---

## 2. WORLD (~13–20h) — targets: AgentKit New Use Cases $8k (framing: authorization/accountability — NEVER reputation or discounts)

### World ID v4 (guardian gate) — mid-migration, v3+v4 accepted until 2027-03-31
- Packages: `@worldcoin/idkit@4.2.1` (React `IDKitRequestWidget`), `idkit-core@4.2.2` (vanilla `IDKit.request`), signing via `idkit-core/signing` (`signRequest`).
- Portal (developer.world.org): app → `app_id` + **`rp_id`** + **`signing_key`**; action `guardian-verification`.
- **Mandatory rp_context**: backend route calls `signRequest({signingKeyHex, action, ttl:300})` → widget prop `rp_context`.
- Widget: `preset={proofOfHuman({ signal: tenantWalletAddress })}` (CORRECTED: docs now recommend `proofOfHuman` — v4 with automatic legacy-Orb fallback — over `orbLegacy`), `allow_legacy_proofs: true`; desktop = built-in QR → World App → bridge poll. Staging is action-level, not a separate app.
- Verify: `POST https://developer.world.org/api/v4/verify/{rp_id}` — forward IDKit payload AS-IS. Response has `nullifier`, `results[].identifier`, `issuer_schema_id`.
- **Backend must dedupe nullifiers** (same human+action = same nullifier): SQLite `guardian_verifications (nullifier, action UNIQUE)`, tenant link, N-entities-per-human cap enforced in our DB at `runner.start()`.
- Enforcement: accept Orb (`proof_of_human`, issuer_schema_id 1) + Secure Document/Passport tier; reject Device/Selfie for guardianship. Check server-side via `results[].identifier`.
- Insertion: `api/routes/onboard.ts` POST /onboard (after guardianPasskey check), `mcp/server.ts onboard_agent` (stored-verification-handle pattern like passkeys), persist nullifier into EntityRecord + `renderMetadata` (public attestation in on-chain metadataURI).
- **Testing without Orb**: simulator.worldcoin.org + `environment: "staging"` (staging app in Portal; same verify endpoint) — 30-min path. Newer full-E2E "Sandbox" (TestFlight World App, `environment: "sandbox"`).
- One-shot verification; persist verify response as the durable attestation. Session proofs = future recurring re-auth.

### AgentKit (agent-side + seller-side)
- Registration: `npx @worldcoin/agentkit-cli register <agent-address>` — address is ANY EVM address (our Arc operator EOA fine); human scans QR in World App; hosted relay `https://x402-worldchain.vercel.app` pays gas. **Requires a real Orb-verified human (AgentBook groupId=1, verified on-chain); no simulator path.** ~2 min, $0, permanent. **Do this BEFORE the weekend.**
- **⚠ R1 (HIGH, discovered in reference pass):** the published CLI 0.2.0 pins the v3 identity bridge, but World IDs created after 2026-06-01 are v4-only — a human freshly Orb-verified at the venue may be UNABLE to complete AgentBook registration. Register tonight with a pre-June-2026 World ID if possible, or test registration immediately after the venue Orb verification while there's time to find another verified person.
- AgentBook: World Chain mainnet `0xA23aB2712eA7BBa896930544C7d6636a96b944dA` — `lookupHuman(address)→uint256 humanId (nullifier)`, `getNextNonce`. Multiple agents per human: yes. No revoke function (our guardian clawback is the answer — honest pitch point). **CORRECTED: Base Sepolia is NOT a working fallback** — repo docs describing a Base-default CLI with `--network` are drift; the published CLI registers only on World Chain via the hosted relay. `lookupHuman` swallows RPC errors as `null` (fail-closed to payment) — cache positive lookups in SQLite.
- Client: `createAgentkitClient({signer})`; signer = `{address, chainId /*CAIP-2, eip155:5042002 OK*/, type:'eip191', signMessage}` — one `personal_sign`; Turnkey-compatible (add signMessage to OperatorSigner) or pocket EOA fallback (15 min). `agentkit.fetch` only acts on 402s with `extensions.agentkit` in JSON body — composes cleanly in FRONT of our `buyWithX402` (wrap `fetchImpl` in entityPayment.ts).
- **Seller seam (fully separable — "paid route can run on any EVM chain"; Arc even ships as built-in default RPC in the SDK):** do NOT adopt their resource server. Manual API: `parseAgentkitHeader` → `validateAgentkitMessage` (domain/uri binding, ≤5min, nonce) → `verifyAgentkitSignature` (SIWE recover) → `createAgentBookVerifier().lookupHuman(addr)` (read-only World Chain RPC `https://worldchain-mainnet.g.alchemy.com/public`). In `buildPaywall` (payments/seller.ts) before the X-PAYMENT branch: enforce a per-human authorization allowance per humanId (SQLite usage counter), else fall through to existing 402 → Circle Gateway settlement on Arc UNTOUCHED. x402 v1/v2 package coexistence is a non-issue: `@x402/core@2.15` already installed beside our `x402@1.2.0`; agentkit's use is type-only.
- 402 body: `declareAgentkitExtension({domain, resourceUri, network:'eip155:5042002', statement})` — must hand-mint `info.nonce` + `issuedAt` (+expirationTime); top-level `extensions` key next to `accepts`. The `agentkit` header must survive the Vercel proxy (same class as the old X-PAYMENT stripping) — hour-1 smoke test.
- **⚠ FRAMING CORRECTION (prize DQ list):** the live prize page bans "human-backed benefits for AI agents (i.e API calls, discounts)" — do NOT present the mechanism as free trials/perks. Same code, mandatory framing: a per-human **authorization/execution-rights limit** inside the legal-body governance flow ("access, limits, pricing, authorization, execution rights" is their qualifying language). Demo: same agent, same endpoint — unverified agents are refused execution rights; a human-backed, legally-governed agent is authorized and settles real USDC on Arc through the governed treasury.

### Risks
1. IDKit v4 beta churn → `allow_legacy_proofs` + legacy presets; vanilla idkit-core QR flow (proven in agentkit-cli source) as fallback.
2. Orb dependency → pre-register before event; Lisbon/venue Orb; last resort: AgentBook-ABI stub on Arc/anvil pointed at via `createAgentBookVerifier({client})`, clearly labeled.
3. SDK dep clash with our x402 v1 stack → raw fallback is ~50 lines: SIWE message + `viem.verifyMessage` + one `readContract lookupHuman` (ABI = 2 view fns). Cache lookups in SQLite w/ TTL vs RPC flakiness.

Hours: guardian gate 6–9 · agent-side 3–5 · seller-side 4–6.

---

## 3. ENS (~14–20h) — targets: AI Agents $1.5k + Continuity $2k + Most Creative $1.5k (one build, three prizes; booth demo Sunday AM mandatory)

### Context
- ENSv2 Namechain L2 CANCELLED (Feb 2026) — v1 flat registry + ENSIP-10 wildcard + CCIP-read is the live path; nothing throwaway.
- Build on **Sepolia** (free): Registry `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`, Controller `0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968`, NameWrapper `0x0635513f179D50A207757E05759CbD106d7dFcE8`, **UniversalResolver `0xeEeEeEeE14D718C2B47D9923Deab1335E144EeEe`** (in viem's sepolia chain object already). Manager app: sepolia.app.ens.domains.
- Optional mainnet `novicorpus.eth`: $5/yr + ~$3–8 gas, ~15 min (commit ≥60s → register) — buys Rainbow/Etherscan resolution at the booth. Same script/contract/gateway.
- Register via ensjs 4.3.1 script (`commitName`/`registerName` + `addEnsContracts(sepolia)`) — NOT the alpha app. **CORRECTED: names register UNWRAPPED with the current (2025) controller** — `setResolver` uses `contract: 'registry'`, NOT NameWrapper; there is no `fuses`/`ownerControlledFuses` param anymore (`reverseRecord` is now a uint8 enum; new `referrer` param exists). Keep registration + resolver-setting on ONE key. Commitments expire after 24h — commit and register in one sitting.

### Architecture
- ONE `OffchainResolver.sol` (copy verbatim from ensdomains/offchain-resolver, ~60 lines + SignatureVerifier) deployed on Sepolia via our Foundry; constructor = gateway URL + signer allowlist. ENSIP-10 `resolve(bytes dnsName, bytes innerCall)` reverts `OffchainLookup` → serves `*.novicorpus.eth` with ZERO per-agent txs.
- Gateway = new Hono route on OUR backend (backend is Hono, fetch-native — ~120 hand-rolled lines, viem only, no new deps): GET `/ensgateway/:sender/:data.json` + POST fallback. Decode DNS name → `repo.findByPublicId(label)` → answer `addr(bytes32)` (=treasury), `addr(bytes32,uint256)`, `text(bytes32,string)`.
- **Signing (classic footgun):** raw ECDSA over `keccak256(0x1900 ‖ resolverAddr ‖ expires(uint64) ‖ keccak(request) ‖ keccak(result))` — viem `account.sign({hash})`, NOT personal_sign/EIP-712. Fresh signer EOA in VPS .env (never holds funds). Expires = now+300s. Unit-test TS digest against the contract's public `makeSignatureHash()` FIRST.
- CORS `*` on `/ensgateway/*`; **smoke-test through the Vercel proxy hour 1** (it stripped X-PAYMENT before); fallback = direct VPS behind TLS + redeploy resolver (constructor arg, 2 min).

### Records per `<publicId>.novicorpus.eth` (publicId UUID = valid label)
- `addr` (60) → **treasury address** (the whitelist-able account); `addr(node, 2152525650)` → Arc-testnet coinType per ENSIP-11 (`0x80000000 | 5042002 = 0x804cef52`).
- text: `description`, `url` (=metadata URI), `avatar` (booth polish), `legal-status` (LIVE from LegalManager — pause on stage, watch it flip), `treasury`, `operator`, `metadata`.
- **ENSIP-25**: key `agent-registration[0x00010000034cef52148004a818bfb912233c491871b3d84c89a494bd9e][<agentId>]` → value `"1"` (presence = attestation; gateway returns "1" only if label↔agentId match in SQLite). ERC-7930 encoding of our registry: version `0001` ‖ chaintype `0000` ‖ chainRefLen `03` ‖ `4cef52` (5042002 BE) ‖ addrLen `14` ‖ `8004a818bfb912233c491871b3d84c89a494bd9e`.
- **Bidirectional half — WE CAN DO IT ON-CHAIN**: live registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` has `setMetadata(agentId, key, bytes)`; NFT owner = manager EOA (our backend) after createEntity. → `setMetadata(id, "ens", "<publicId>.novicorpus.eth")` per agent (~50k gas, batched script via new `arcAdapter.setAgentMetadata` mirroring setAgentWallet). ALSO add `"ens"` + `"registrations":[{agentId, agentRegistry:"eip155:5042002:0x8004…"}]` to metadata JSON (extend `renderMetadata`) + document the lookup rule (ENSIP-25 MUST).
- **VALIDATE FIRST (10 min):** `cast call 0x8004A818BFB912233c491871b3d84c89A494BD9e "getMetadata(uint256,string)(bytes)" 845775 "ens" --rpc-url $ARC_RPC` then a `cast estimate` setMetadata from manager. If auth fails → off-chain-only bidirectionality (explicitly permitted).
- ENSIP-26 (~30 min): `agent-context`, `agent-endpoint[mcp]` → our MCP URL, `agent-endpoint[web]`. ENSIP-27 agent-card (~1h): cite as "draft/emerging" (author moving it to ERC track) — garnish only.

### Booth walkthrough (the pitch)
name → `getEnsAddress` = governed treasury → `legal-status` live (pause on stage → `Suspended`) → ENSIP-25 record `"1"` → flip direction on Arc: `getMetadata(id,"ens")` = same name (neither side spoofable alone) → `agent-endpoint[mcp]` → connect and transact. Plus `resolve_agent(name)` MCP tool running steps 1–4.

### Risks
1. CCIP/UniversalResolver quirks → POST fallback, layer-by-layer testing (cast → curl → viem), resolver URL redeployable in 2 min.
2. Vercel proxy reachability → hour-1 smoke test; VPS-direct TLS fallback.
3. Signature digest mismatch ("Invalid sigature") → unit-test vs `makeSignatureHash` view before anything else.

Hours: name+resolver 3–4 · gateway 4–6 · records+ENSIP-25+backfill 3–4 · polish/MCP tool/mainnet 4–6.

---

## Pre-hackathon checklist (TONIGHT)
1. **Orb**: get one team member Orb-verified (venue/Lisbon Orb) → `npx @worldcoin/agentkit-cli register <operatorEOA>` (2 min, gasless, permanent).
2. **World Portal**: create production + staging apps, action `guardian-verification`, capture app_id/rp_id/signing_key.
3. **Graph Studio**: wallet sign-in, create subgraph `novi-corpus-arc`, grab deploy key; deploy factory-only walking skeleton ASAP to de-risk arc-testnet sync.
4. **cast validation** of `setMetadata` auth on the live Arc registry (10 min).
5. **Sepolia**: faucet ETH; register `novicorpus.eth` via ensjs script.
6. **Circle faucet**: Base Sepolia USDC for the Graph x402 payer key.
7. Confirm at sponsor booths: continuity-team eligibility for main tracks (World page is silent); Graph Composable "≥2 products" — does subgraph + x402 gateway count?
8. Hedera × Claude Code workshop today 17:00 WEST (optional; Hedera HCS is the stretch 4th integration, ~10–16h).
9. **Commit incrementally all weekend** — continuity track DQs large single commits.

## Combined budget
Graph 14–20h + World 13–20h + ENS 14–20h = 41–60h total → all three is aggressive for one person in 36–48h; comfortable for two. Priority if cutting: ship ENS + Graph fully (low-risk, all-our-stack), World next (highest prize, highest wow, most external dependencies — but its three legs degrade gracefully: guardian gate alone is already a track-worthy story).
