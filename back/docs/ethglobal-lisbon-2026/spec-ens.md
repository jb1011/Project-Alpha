# SPEC — ENS Integration: `<publicId>.novicorpus.eth` (Build 1 of 3)

Status: READY FOR IMPLEMENTATION.
Authoritative detail source: [reference-ens.md](./reference-ens.md) — this spec defines *what to build and in what order*; the reference defines *exactly how*. Where they disagree, the reference wins.
Executor note: implement task by task, commit per task (continuity track requires incremental history), run each task's checkpoint before moving on.

## Goal

Every Novi Corpus agent resolves at `<publicId>.novicorpus.eth` (Sepolia) with live records
(treasury addr, legal-status, metadata URL, ENSIP-25 registration binding), served by ONE
wildcard CCIP-read resolver + a gateway route on our existing Hono backend. Bidirectional
ENSIP-25: the Arc ERC-8004 registry entry points back at the name.

**Non-goals (do NOT build):** mainnet registration (optional Saturday polish, same scripts);
on-chain subnames/NameWrapper anything; ENSIP-27 agent-card route (garnish only if all
acceptance criteria pass early); any change to treasury/payment contracts.

## Architecture (decided — do not re-litigate)

- Parent name `novicorpus.eth` on **Sepolia**, registered **unwrapped** via ensjs 4.3.1 script (commit+register same sitting; commitments expire 24h). `setResolver` via **registry** (`contract: 'registry'`).
- Resolver: `OffchainResolver.sol` + `SignatureVerifier.sol` copied verbatim from `ensdomains/offchain-resolver@099b7e9` (sources are in reference-ens.md §3) into `back/src/ens/`, deployed with Foundry to Sepolia. Constructor-frozen URL + signers → deploy with **2 signer addresses** (primary + spare). Gateway URL: `https://project-alpha-pi.vercel.app/backend/ensgateway/{sender}/{data}.json`.
- Gateway: new Hono route in `back/backend/src/api/routes/ensGateway.ts`, mounted like `metadata.ts`. GET `/ensgateway/:sender/:data` (strip `.json`) + POST `/ensgateway` fallback. **Unknown label/key → HTTP 200 with empty result, never 4xx** (4xx aborts client resolution).
- Signing: raw ECDSA over `keccak256(0x1900 ‖ resolver ‖ expires(uint64) ‖ keccak(request) ‖ keccak(result))`, viem `account.sign({hash})` — NOT personal_sign. Expiry now+300s. Signer = fresh EOA, env `ENS_GATEWAY_SIGNER_KEY`, never funded.
- Data source: `deps.repo.findByPublicId(label)` (`persistence/entityRepository.ts:220`; EntityRecord has `treasury`, `operator`, `agent_id`, `status`, `public_id`) + live legal status via the existing arcAdapter read used by the treasury route.

## Tasks (in order)

### T1 — Name registration (script, run once)
`back/backend/scripts/ens-register.ts` (or plain node script): ensjs 4.3.1 commit→wait 75s→register `novicorpus.eth`, duration 1y, per reference §2 (current controller params: no fuses; `reverseRecord` uint8; `referrer` exists). Env: `ENS_OWNER_KEY`, `SEPOLIA_RPC_URL`.
**Checkpoint:** name visible on sepolia.app.ens.domains, owned by our EOA, unwrapped (registry `owner(namehash) == our EOA`).

### T2 — Resolver contract
Copy sources per reference §3 into `back/src/ens/` (+ vendored SupportsInterface files). `forge build`; deploy per reference §3 commands with gateway URL + `[signer1, signer2]`. Then `setResolver` on the **registry** from the owner key.
**Checkpoint:** `cast call <resolver> "resolve(bytes,bytes)" …` reverts `OffchainLookup` (reference §7 command); registry resolver slot = our contract.

### T3 — Gateway route
`ensGateway.ts` per reference §4 (DNS wire decode, selector dispatch for `addr(bytes32)`, `addr(bytes32,uint256)`, `text(bytes32,string)`, signing). Config additions in `config/env.ts` (optional-with-warning, NOT fail-closed — deploys without ENS config must still boot): `ENS_GATEWAY_SIGNER_KEY`, `ENS_PARENT_NAME=novicorpus.eth`, `ENS_RESOLVER_ADDRESS`. CORS `*` for `/ensgateway/*` (extend the app.ts origin callback). Unit-test the signing digest against the deployed contract's `makeSignatureHash` view (reference §7 vector) BEFORE wiring records.
**Checkpoint:** digest unit test green; `curl` gateway direct returns `{data: 0x…}`; smoke-test THROUGH the Vercel proxy (hour-1 risk — fallback per reference §7).

### T4 — Records catalog
Implement `textRecord(entity, key)` per reference §5: `description`, `url`, `avatar`, `legal-status` (live), `treasury`, `operator`, `metadata`, ENSIP-25 key `agent-registration[0x00010000034cef52148004a818bfb912233c491871b3d84c89a494bd9e][<agentId>]` → `"1"` iff label↔agentId match, ENSIP-26 `agent-context` / `agent-endpoint[mcp]` / `agent-endpoint[web]`. `addr` → treasury; `addr(node, 2152525650)` → treasury as bytes.
**Checkpoint:** viem loop resolves addr + 3 text records for a REAL entity (e.g. publicId of agent 845775) per reference §7 script.

### T5 — Bidirectional half (Arc side)
1. Run the 10-min `cast` validation (reference §6 / README checklist #4). If setMetadata auth fails → off-chain-only fallback (metadata JSON), skip 2.
2. `arcAdapter.setAgentMetadata(agentId, "ens", name)` mirroring `setAgentWallet`'s writeContract shape (arcAdapter.ts ~L180) + one-shot backfill script for existing agents.
3. Extend `renderMetadata` (oa/generator.ts): add `"ens"` + `"registrations": [{agentId, agentRegistry: "eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e"}]`; regenerate stored meta JSONs. Document the lookup rule in this folder (ENSIP-25 MUST).
**Checkpoint:** `getMetadata(845775, "ens")` returns the name on Arc; metadata JSON shows both fields.

### T6 — MCP tool + wiring into onboarding
`resolve_agent` MCP tool (read capability, server.ts idiom): input `name`, runs the 4-step verification (addr → legal-status → ENSIP-25 record → Arc reverse check), returns structured verdict. Onboarding saga: new entities automatically get the metadata `ens` field + (if T5.2 landed) the setMetadata call — non-fatal on failure (recordEvent + continue).
**Checkpoint:** `resolve_agent` returns `verified: true` for a live entity; a fresh test onboard produces a name that resolves.

### T7 — Tests + demo assets
Vitest: DNS decoder, digest vs known vector, records dispatch (mock repo), ENSIP-25 label↔agentId mismatch → empty. Booth script: the 5-step walkthrough (reference §7 + concepts.md) as a runnable `scripts/ens-demo.ts`; pause an entity → `legal-status` flips.
**Checkpoint:** suite green; demo script runs end-to-end against prod backend.

## Acceptance criteria
1. Any onboarded agent resolves by name (addr + text) via vanilla viem on Sepolia with zero per-agent txs.
2. `legal-status` reflects live chain state (pause → `Suspended` on next resolve).
3. ENSIP-25 loop closes both directions for at least one real agent.
4. Gateway serves through the public Vercel URL; no hard-coded per-agent values anywhere.
5. All existing tests still pass; ENS config absent → backend boots with a warning, routes 404 cleanly.

## Env summary (VPS .env additions)
`ENS_GATEWAY_SIGNER_KEY` (fresh, unfunded) · `ENS_OWNER_KEY` (Sepolia, holds faucet ETH — scripts only, not the server) · `ENS_PARENT_NAME` · `ENS_RESOLVER_ADDRESS` · `SEPOLIA_RPC_URL`

## Estimates & risks
T1 1h · T2 2h · T3 3–4h · T4 2–3h · T5 2h · T6 2h · T7 2h ≈ **14–16h**.
Top risks + fallbacks: reference-ens.md §7/§9 (proxy passthrough, digest mismatch, 24h commitment expiry, 4xx-aborts).
