# SPEC — World Integration: proof-of-personhood for the guardian + human-backed agent verification (Build 2 of 3)

Status: READY FOR IMPLEMENTATION.
Authoritative detail source: [reference-world.md](./reference-world.md) — this spec defines *what to build and in what order*; the reference defines *exactly how* (IDKit v4 API surface §2, AgentKit manual seam §5, no-SDK fallback §6). Where they disagree, the reference wins.
Executor note: implement task by task, commit per task, run each checkpoint before moving on.

## Pre-cleared blockers (2026-07-25 — do NOT re-verify)

- **Relay fixed:** `x402-worldchain.vercel.app` healthy (was 500-ing on 07-24).
- **R1 DEAD:** user's fresh v4 World ID registers fine through `agentkit-cli@0.2.0`. No fallback paths needed.
- **AgentBook registrations DONE (user is the Orb-verified human):** throwaway `0x172B7952b0F711b8B372410E81d51Dcba7D4BB02` (tx `0x4b7c004d…`, block 32818574) + demo-agent-845859 operator `0x6652749364b424612a33C9a67cb7acD1bFc3E51A` (run this session; confirm `lookupHuman` nonzero before W4's checkpoint).
- x402 v1/v2 package coexistence: non-issue (`@x402/core@2.15` already installed; agentkit's use is type-only).

## Goal

1. **Guardian gate:** entity formation requires proof the controller is a real, unique human (World ID v4) — nullifier stored, N-entities-per-human cap enforced, attestation served in the agent's public metadata.
2. **Human-backed agent verification:** our x402 demo seller verifies a paying agent is AgentBook-registered (backed by a unique human) and applies a per-human **authorization allowance** before falling through to the untouched Circle-Gateway-on-Arc settlement.

**⚠ FRAMING (prize DQ rule):** never present the mechanism as free trials/discounts/perks. It is an **authorization / execution-rights** limit inside the legal-body governance flow. Demo line: "unverified agents are refused execution; a human-backed, legally-governed agent is authorized."

**Non-goals:** World Chain deployment (none needed — AgentBook lookup is a read-only RPC); Mini Apps; Selfie/Identity Check betas (mention as roadmap only); Turnkey signMessage adapter (stretch — pocket EOA suffices); touching the treasury/payment contracts or the v1 x402 wire format.

## Architecture (decided — do not re-litigate)

- **Guardian gate = backend-driven vanilla `@worldcoin/idkit-core` flow** (request → connectorURI/QR → poll), mirroring the passkey stored-credential-handle pattern — works for web AND MCP-first onboarding, no React dependency. Preset `proofOfHuman` (v4 + legacy-Orb fallback), `allow_legacy_proofs: true`. Mandatory v4 `rp_context` minted server-side via `signRequest` (`idkit-core/signing`).
- Verification: forward the IDKit result payload **as-is** to `POST https://developer.world.org/api/v4/verify/{rp_id}`. Accept credentials `proof_of_human` (Orb) or secure-document tier; reject device/selfie server-side (`results[].identifier`).
- Storage: SQLite `guardian_verifications (nullifier TEXT, action TEXT, tenant_id TEXT, issuer_schema_id INT, verified_at INT, expires_at_min INT, UNIQUE(nullifier, action))` — nullifier stored decimal-normalized. **N-cap** (`WORLD_MAX_ENTITIES_PER_HUMAN`, default 3) enforced where onboarding starts.
- **Enforcement is flag-gated:** config block `world` is optional (mirrors `ens`/`payments`); `WORLD_REQUIRE_GUARDIAN=true` additionally makes onboarding REFUSE tenants without a stored verification. Default off → existing tests/deploys unaffected.
- Attestation: metadata route injects (like the ENS fields) `worldId: { humanVerified: true, nullifier, verifiedAt }` when the owning tenant has a stored verification.
- **Seller seam (manual API only — never their resource server):** in `buildPaywall` (payments/seller.ts) before the X-PAYMENT branch: `parseAgentkitHeader` → `validateAgentkitMessage` (nonce via SQLite) → `verifyAgentkitSignature` → `createAgentBookVerifier().lookupHuman(addr)` (World Chain public RPC; **null = fail-closed to normal payment path**; cache positive lookups in SQLite w/ TTL 1h). Within-allowance human-backed requests get an authorized 200; beyond allowance falls through to the existing 402 → Arc settlement UNTOUCHED. `buildRequirements` 402 body gains hand-minted `extensions.agentkit` (declareAgentkitExtension + nonce/issuedAt/expirationTime — the helper omits them).
- **Agent side:** `createAgentkitClient({ signer })` with the **pocket EOA** (`pocketSignerFromKey`, one EIP-191 personal_sign) wrapping `fetchImpl` in `entityPayment.pay` — only acts on agentkit-extended 402s, composes in front of `buyWithX402` unchanged.
- Config (`env.ts`, optional-with-warning): `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_RP_SIGNING_KEY`, `WORLD_ACTION` (default `guardian-verification`), `WORLD_MAX_ENTITIES_PER_HUMAN` (3), `WORLD_REQUIRE_GUARDIAN` (false), `WORLD_CHAIN_RPC` (default Alchemy public), `WORLD_ALLOWANCE_PER_HUMAN` (3). Redact `WORLD_RP_SIGNING_KEY`.
- Demo runs **isolated** (local backend w/ flags or standalone script), same as ENS — no prod VPS.

## Tasks (in order)

### W0 — USER TASK: Developer Portal setup (~30 min, needs developer.world.org login)
Create app (production + a staging action set), action `guardian-verification`; capture `app_id`, `rp_id`, `signing_key` into `back/backend/.env`. Blocking for W1–W3 runtime tests only (code can be written first).

### W1 — Config + storage
`world` config block (+ redaction) in env.ts; `guardian_verifications` + `world_nonces` + `world_usage` + `world_human_cache` SQLite migrations following existing migration idiom.
**Checkpoint:** backend boots with and without WORLD_* set; typecheck green.

### W2 — Guardian World ID gate (backend flow)
Routes (public zone): `POST /world-id/request` → creates the idkit-core request server-side (rp_context via signRequest), stores requestId→pending, returns `{ requestId, connectorURI }` (frontend renders QR or link); `GET /world-id/status/:requestId` → polls bridge (`pollUntilCompletion` equivalent), on proof: forward to v4 verify, validate credential tier, dedupe+store nullifier, bind to authenticated tenant, return stored-verification handle. MCP mirror: onboarding requires the handle only when `WORLD_REQUIRE_GUARDIAN=true` (checked in `runner.start()` gate + `onboard_agent`), with N-cap check alongside.
**Checkpoint:** staging E2E with simulator.worldcoin.org (staging action; simulator identities take ~5 min to activate) → verification stored, dedupe blocks a second tenant using the same simulated human, N-cap enforced.

### W3 — Metadata attestation
Metadata route injects the `worldId` block (mirror the ENS injection added in T5).
**Checkpoint:** served JSON for an entity whose tenant is verified shows `worldId.humanVerified: true`; unverified tenant → field absent; existing metadata tests green.

### W4 — Seller-side AgentBook verification
`payments/worldVerifier.ts`: parse/validate/verify + cached `lookupHuman` (fail-closed) + allowance counter; wire into `buildPaywall`/`buildRequirements` per architecture. Uses `@worldcoin/agentkit` manual exports; if the SDK fights our stack, the ~50-line no-SDK fallback in reference §6 (SIWE verify + one readContract) is pre-approved.
**Checkpoint:** vitest with mocked World Chain read: agentkit-header request within allowance → authorized 200 w/ `humanBacked:true`; beyond allowance → standard 402; no header → standard 402; RPC error → standard 402 (fail-closed). Real-chain spot check: `lookupHuman(0x6652…E51A)` nonzero via the verifier module.

### W5 — Agent-side agentkit.fetch
Signer adapter from the pocket EOA; wrap `fetchImpl` in `entityPayment.pay` when world config present. Surface `humanBacked`/authorization outcome in the `pay` receipt text.
**Checkpoint:** integration test against the local demo seller: registered wallet → authorized (no USDC moved) until allowance exhausted → then real 402 path engages (settlement mocked in test).

### W6 — E2E demo + tests + docs
`scripts/world-demo.mts`: full walkthrough — unverified agent refused execution rights → human-backed agent (registered operator 0x6652…) authorized within allowance → allowance exhausted → falls through to governed USDC settlement on Arc (live, small amount) → ends by calling `resolve_agent` (ENS build) to show the SAME agent's name + legal status: **the full trust stack in one script**. Vitest suite additions from W2/W4/W5. Full suite green.
**Checkpoint:** demo script runs end-to-end locally; suite ≥ previous count, all green.

## Acceptance criteria
1. A tenant cannot onboard past the gate (when enforced) without proving unique humanity; the same human cannot exceed the entity cap; nullifier never leaks PII (it's the only stored identity datum).
2. The demo seller distinguishes human-backed agents via a live AgentBook read and applies authorization limits; settlement path on Arc byte-identical to before (no v1 wire changes).
3. All flags absent → behavior identical to pre-World backend; suite green.
4. Demo script tells the authorization/accountability story (never discounts) and chains into the ENS verification.

## Estimates
W1 1–2h · W2 4–6h · W3 1h · W4 3–4h · W5 2–3h · W6 2–3h ≈ **13–19h**. Riskiest: W2 (v4 IDKit beta churn — mitigations in reference §2/§8).
