# World (World ID + AgentKit) — Complete Build Reference

**Novi Corpus × ETHGlobal Lisbon 2026.** Verified against live sources 2026-07-24. Companion to
[technical-blueprints.md §2](./technical-blueprints.md); this document supersedes it where they
disagree — see [§8 Corrections & deltas](#8-corrections--deltas-vs-technical-blueprintsmd).

Context updates since the blueprint: **two Orbs confirmed at the venue**, and **World confirmed
continuity-track teams are eligible for their main tracks** (booth-confirmed; their prize page is silent).

**Pinned versions (npm `latest` on 2026-07-24):**

| Package | Version | Published | Direct deps |
|---|---|---|---|
| `@worldcoin/idkit` (React) | **4.2.1** | 2026-07-17 | `@worldcoin/idkit-core@4.2.2`, `qrcode ^1.5.4`; peer `react >=18` |
| `@worldcoin/idkit-core` (vanilla) | **4.2.2** | 2026-07-17 | `@noble/hashes ^1.7.2`, `@worldcoin/idkit-server 1.1.1` |
| `@worldcoin/agentkit` | **0.2.0** | 2026-04-29 | `@x402/core ^2.4.0`, `@worldcoin/agentkit-core ^0.2.0` |
| `@worldcoin/agentkit-core` | **0.2.0** | 2026-04-29 | `zod ^3.24.2`, `siwe ^2.3.2`, `viem ^2.46.2`, `tweetnacl`, `@scure/base` |
| `@worldcoin/agentkit-cli` | **0.2.0** | 2026-04-29 | `viem ^2.30.2`, `incur`, `qrcode-terminal`, **`@worldcoin/idkit-core@2.1.0`** (v3 bridge — see risk R1) |

**Dependency coexistence — RESOLVED, no work needed:** `@x402/core` (v2, scoped) and `x402` (v1,
unscoped) are *different npm package names*. Our backend **already has both installed**:
`@x402/core@2.15.0` (pulled by our `@x402/evm ^2.15.0`) sits next to `x402@1.2.0` + `x402-fetch@1.2.0`
in `back/backend/node_modules` today. `npm i @worldcoin/agentkit` just dedupes onto the existing
`@x402/core` (satisfies `^2.4.0`). `zod` (ours 3.25.76 ⊇ their `^3.24.2`) and `viem`
(ours 2.52.2 ⊇ `^2.46.2`; `viem/chains` exports both `worldchain` (480) and `arcTestnet` (5042002))
also dedupe cleanly. AgentKit's `@x402/core` usage is a *type-only* import (`PaymentRequired`) — zero
runtime interaction with our v1 x402 path.

```jsonc
// back/backend/package.json — add exactly these two:
"@worldcoin/agentkit": "0.2.0",        // seller seam + agent client (pulls agentkit-core)
"@worldcoin/idkit-core": "4.2.2"       // guardian gate: vanilla request flow + /signing subpath
// React widget (frontend repo only, if used): "@worldcoin/idkit": "4.2.1"
// CLI is npx-only, never a dependency: npx @worldcoin/agentkit-cli@0.2.0
```

**Key addresses / URLs (verbatim, verified):**

| What | Value |
|---|---|
| AgentBook — World Chain mainnet (canonical; CLI + SDK default) | `0xA23aB2712eA7BBa896930544C7d6636a96b944dA` |
| AgentBook — Base Sepolia (per repo REGISTRATION.md; no relay, not reachable from published CLI) | `0xA23aB2712eA7BBa896930544C7d6636a96b944dA` |
| AgentBook — Base mainnet (listed in REGISTRATION.md for a *future* CLI; do not use) | `0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4` |
| World Chain mainnet | chainId **480** (`eip155:480`), RPC `https://worldchain-mainnet.g.alchemy.com/public`, explorer `https://worldscan.org`, status `https://worldchain-mainnet-status.alchemy.com` |
| AgentKit hosted registration relay | `https://x402-worldchain.vercel.app` (CLI POSTs `{agent,root,nonce,nullifierHash,proof,contract}` to `/register`; relay pays gas) |
| AgentKit CLI's own World ID app (hardcoded in CLI) | `app_id: app_a7c3e2b6b83927251a0db5345bd7146a`, action `agentbook-registration` |
| Developer Portal | `https://developer.world.org` (legacy `developer.worldcoin.org`) |
| v4 verify endpoint | `POST https://developer.world.org/api/v4/verify/{rp_id}` |
| Developer Portal MCP | `https://developer.world.org/api/mcp` (streamable-http, `Authorization: Bearer api_<base64(id:secret)>`) |
| Simulator (staging only) | `https://simulator.worldcoin.org` |
| World USDC on World Chain (only if we ever accept payment there — we don't) | `0x79A02482A880bCE3F13e09Da970dC34db4CD24d1` |
| World ID docs index | `https://docs.world.org/llms.txt` · integration skill: `https://docs.world.org/world-id/SKILL.md` |

---

## 1. Build sequence checklist (with time estimates)

### T-0 — TONIGHT / before hacking starts (~2h wall clock, mostly waiting)

- [ ] **(15–30 min/human) Orb-verify at the venue** — two Orbs on site. Prereq: World App
  installed from App/Play Store + account created *before* queueing. The capture itself is
  <1 min; the Proof-of-Human credential lands in World App and is usable within minutes.
  ⚠️ **Prefer a teammate whose World ID predates 2026-06-01** (see risk R1 — fresh accounts are
  v4-only and the AgentKit CLI requests a v3 legacy proof).
- [ ] **(10 min) AgentKit registration** of the Arc operator EOA (and/or the pocket EOA you'll
  sign AgentKit challenges with — the registered address MUST equal the signing address):
  `npx @worldcoin/agentkit-cli register <address>` → QR in terminal → Orb-verified human scans
  in World App → hosted relay submits on World Chain, $0 gas, permanent. Verify:
  `npx @worldcoin/agentkit-cli status <address>` → `registered: true, humanId: 0x…`.
  **Do this the moment the Orb verification exists** — it is the single external dependency.
- [ ] **(20 min) Developer Portal** (`developer.world.org`): create app with **`app_mode: external`**
  (fixed at creation; `mini-app` apps cannot be converted). Click **"Enable World ID 4.0"** /
  run `configure_world_id` → capture `app_id`, `rp_id`, and `signing_key` — **the private key is
  shown exactly ONCE**; put it straight into VPS `.env` as `RP_SIGNING_KEY` (server-only, never
  `NEXT_PUBLIC_*`). Create action `guardian-verification` **twice**: once `environment: production`
  (real phones) and once `environment: staging` (simulator). Poll on-chain RP registration to
  `registered` before demo day (Portal UI or MCP `get_world_id_registration_status`).
  Optional: wire the Developer Portal MCP into Claude Code (endpoint above) — tools
  `get_team_context`, `get_app_config`, `create_app`, `configure_world_id`, `create_world_id_action`,
  `get_world_id_registration_status`, `rotate_world_id_signing_key`.
- [ ] **(30–45 min) Simulator smoke test** of the staging action (walkthrough in §3) — proves the
  full rp-sig → request → proof → verify loop before any of our code exists.
- [ ] **(5 min) Env vars** on VPS: `RP_SIGNING_KEY`, `WORLD_APP_ID`, `WORLD_RP_ID`,
  `WORLD_ACTION=guardian-verification`, `WORLD_ENV=production|staging`,
  `WORLDCHAIN_RPC_URL` (optional override), `AGENTKIT_MODE`, `WORLD_ID_REQUIRED` (rollout flag).

### Build order (World total ≈ 13–20h, matches blueprint)

| # | Task | Est. | Section |
|---|---|---|---|
| 1 | rp-signature route (Hono) | 0.5h | §2.2 |
| 2 | Guardian verification request flow (vanilla idkit-core, server-driven; + optional React widget) | 1.5–2h | §2.3 |
| 3 | Verify route → v4 endpoint → nullifier store + N-cap | 2h | §2.4–2.5 |
| 4 | Insertion: `POST /onboard` + MCP `onboard_agent` (stored-handle pattern) | 1.5–2h | §2.6 |
| 5 | Public metadata attestation (`renderMetadata`) | 0.75h | §2.7 |
| 6 | Tests (simulator + unit) | 1–2h | §3 |
| 7 | AgentKit signer adapter (pocket EOA now, Turnkey optional) | 0.5–1h | §4.2 |
| 8 | `agentkit.fetch` in front of `buyWithX402` (wrap `fetchImpl`) | 1h | §4.3 |
| 9 | Registration E2E against a live AgentKit endpoint | 1–2h | §4.4 |
| 10 | Seller seam: hand-minted 402 extension + header verify path in `buildPaywall` | 2.5–3h | §5 |
| 11 | SQLite `AgentKitStorage` + access-mode logic | 1h | §5.4 |
| 12 | Demo choreography + proxy smoke test (`agentkit` header through Vercel!) | 1–2h | §5.6, R4 |

Degradation order if cutting: seller seam alone (10–11) is demoable with the public AgentKit
ecosystem; guardian gate (1–6) alone is a coherent story; agent-side (7–9) needs a counterparty.

---

## 2. World ID guardian gate

Human controller (guardian) proves unique personhood once at onboarding; nullifier caps
N entities per human; verification is publicly attested in the agent's on-chain metadata URI.

### 2.1 Flow overview

```
MCP/web client            our Hono backend (VPS)                developer.world.org
    │  onboard intent          │                                       │
    │────────────────────────▶ │ signRequest(RP_SIGNING_KEY)           │
    │  ◀── connectorURI ────── │ IDKit.request(...).preset(...)        │
    │  guardian scans QR       │ pollUntilCompletion()  ◀─bridge─ World App
    │                          │ POST /api/v4/verify/{rp_id} ────────▶ │
    │                          │ ◀─ {success, nullifier, results[]} ── │
    │  ◀── verificationId ──── │ dedupe nullifier, store handle        │
    │  onboard_agent(handle)   │ runner.start() enforces N-cap         │
```

Server-driven vanilla flow (idkit-core on the backend) is primary — it mirrors our
passkey stored-credential-handle pattern (`api/routes/passkey.ts`: authed challenge issue →
verify → `deps.passkeys.store(tenantId, …) → { id }` handle consumed later by `/onboard`) and
works for BOTH the web wizard and the MCP path (MCP client just displays `connectorURI`).
The React widget (§2.3b) is optional polish for the frontend repo.

### 2.2 rp-signature (backend-internal; never expose the key)

The signing key authenticates proof requests as ours. v4 REQUIRES `rp_context` on every request.
`signRequest` lives at `@worldcoin/idkit-core/signing` (also re-exported by `@worldcoin/idkit/signing`
and `@worldcoin/idkit-server`).

```ts
// back/backend/src/adapters/worldid/rpSignature.ts
import { signRequest } from "@worldcoin/idkit-core/signing";

export function makeRpContext(cfg: { rpId: string; signingKeyHex: string; action: string }) {
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: cfg.signingKeyHex, // 0x-prefix optional
    action: cfg.action,
    ttl: 300, // seconds, default 300
  });
  // NOTE the camelCase→snake_case mapping — rp_context wants snake_case:
  return { rp_id: cfg.rpId, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig };
}
```

Algorithm (if ever re-implemented): `msg = 0x01 ‖ nonce(32) ‖ be64(created_at) ‖ be64(expires_at)
[‖ hash_to_field(action)]` (49 or 81 bytes), EIP-191-prefixed keccak, secp256k1 recoverable sig
`r‖s‖(recovery_id+27)`. `hash_to_field(x) = keccak256(x) >> 8`. Test vectors in
`docs.world.org/world-id/idkit/signatures` (e.g. `hash_to_field("") =
0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4`).

A public `POST /worldid/rp-signature` route is only needed if the FRONTEND runs the widget;
gate it with `requireAuth(deps.jwtSecret)` exactly like `/passkey/challenge`.

### 2.3 Verification request — vanilla idkit-core (primary path)

Entry points on `@worldcoin/idkit-core`: `IDKit.request(config)`, `IDKit.requestWithInviteCode(config)`
(6-char code mode — iOS-install resilience; only `selfieCheckLegacy` supported there today).
Each returns a builder finalized with `.preset(...)`.

**Request config (full):** `app_id` · `action` · `rp_context` (required) ·
`allow_legacy_proofs` (required boolean; `true` = accept v3 fallback) ·
`environment?: "production" | "staging" | "sandbox"` (default production; staging = simulator;
sandbox = TestFlight/Firebase sandbox World App builds) · `return_to?` (mobile deep-link callback) ·
`bridge_url?` (custom bridge) · `require_user_presence?: boolean` (default false; fresh liveness
check, fails with `user_presence_failed`).

**All presets (current SDK surface):**

| Preset | Proves | Notes |
|---|---|---|
| `proofOfHuman({ signal? })` | Unique human, Orb biometric (v4 PoH, issuer_schema_id 1, 3-year validity) | **USE THIS for the guardian gate** — includes automatic legacy-Orb fallback; needs `allow_legacy_proofs: true` |
| `passport({ signal? })` | NFC-verified government passport (v4) | includes legacy Document fallback; acceptable second tier for guardianship |
| `identityCheck({ attributes })` | Document-backed attributes match (preview, access-gated) | attributes: `document_type` (`"passport"|"eid"|"mnc"`), `document_number`, `issuing_country`/`nationality` (ISO 3166-1 alpha-3), `full_name`, `minimum_age` (number); response adds `identity_attested` |
| `selfieCheckLegacy({ signal? })` | Camera liveness/similarity (v3 Face proof; select partners) | the Selfie-Check beta tracks want this |
| `orbLegacy({ signal? })` | Orb, v3 only | legacy; superseded by `proofOfHuman` |
| `secureDocumentLegacy({ signal? })` | ≥ Secure Document; returns highest of Secure Document/Orb (v3) | |
| `documentLegacy({ signal? })` | ≥ Document; highest of Document/Secure Document/Orb (v3) | |
| `deviceLegacy({ signal? })` | ≥ Device; highest incl. Device (v3) | REJECT for guardianship |

`signal` binds app context into the proof (we bind the **tenant wallet address**); the backend
must enforce the same value. Multi-credential constraint composition (`.constraints(any(...))`)
exists on the session API (`IDKit.createSession` / `IDKit.proveSession`, `CredentialRequest("proof_of_human")`)
— sessions are the future recurring-re-auth story, not needed for the one-shot gate.

**After `.preset(...)` you get an `IDKitRequest`:** `connectorURI` (render as QR; empty inside
World App native transport) · `requestId` · `pollOnce()` ·
`pollUntilCompletion({ pollInterval, timeout })` · `getDebugReport()`.

```ts
// back/backend/src/adapters/worldid/guardianGate.ts
import { IDKit, proofOfHuman, IDKitErrorCodes } from "@worldcoin/idkit-core";
import { makeRpContext } from "./rpSignature";

export async function startGuardianVerification(cfg: WorldIdConfig, tenantWallet: string) {
  const request = await IDKit.request({
    app_id: cfg.appId,                       // app_…
    action: cfg.action,                      // "guardian-verification"
    rp_context: makeRpContext(cfg),
    allow_legacy_proofs: true,
    environment: cfg.environment,            // "production" | "staging" | "sandbox"
  }).preset(proofOfHuman({ signal: tenantWallet }));

  return {
    connectorURI: request.connectorURI,      // hand to web page QR or MCP text reply
    requestId: request.requestId,
    // Poll in the background (bridge poll ≈ agentkit-cli's proven loop):
    completion: request.pollUntilCompletion({ pollInterval: 2_000, timeout: 300_000 }),
  };
}
// completion: { success: true, result: IDKitResult } | { success: false, error: IDKitErrorCodes }
// On failure inspect request.getDebugReport() → { version, package_version,
//   transport: "bridge"|"mini_app", generated_at, request_id?, request_payload?, response_payload? }.
```

**IDKit client/bridge error codes (full table):** `user_rejected`, `verification_rejected` (legacy
alias), `credential_unavailable`, `world_id_4_not_available`, `world_id_3_not_available`,
`malformed_request`, `invalid_network` (env mismatch app-config↔World App), `inclusion_proof_pending`
(retry later — fresh simulator identities hit this), `inclusion_proof_failed`, `unexpected_response`,
`connection_failed`, `max_verifications_reached`, `failed_by_host_app` (widget `handleVerify` threw),
`invalid_rp_signature`, `nullifier_replayed`, `duplicate_nonce` (never reuse an rp_context —
generate fresh per request), `unknown_rp`, `inactive_rp`, `timestamp_too_old`,
`timestamp_too_far_in_future`, `invalid_timestamp`, `rp_signature_expired`, `user_presence_failed`,
`identity_attributes_not_matched`, `generic_error`, `invalid_rp_id_format`, `timeout` (client poll),
`cancelled`. Match with `IDKitErrorCodes`; `setDebug(true)` (or `window.IDKIT_DEBUG = true`)
enables verbose logging.

### 2.3b React widget variant (frontend repo, optional)

`IDKitRequestWidget` is **controlled** (v4 breaking change — no render-prop/child function):

| Prop | Req | Notes |
|---|---|---|
| `open` / `onOpenChange` | ✔ | controlled visibility |
| `app_id`, `action`, `rp_context` | ✔ | `rp_context: RpContext` fetched from our authed backend route |
| `allow_legacy_proofs` | ✔ | TS error if missing |
| `preset` | ✔ | e.g. `proofOfHuman({ signal: tenantWallet })` |
| `onSuccess(result)` | ✔ | fires after `handleVerify` resolves (or immediately if omitted) |
| `handleVerify?(result)` | – | async backend verify BEFORE success; throw ⇒ widget error state + `onError("failed_by_host_app")` |
| `onError?(errorCode, debugReport?)` | – | `debugReport` present for flow/bridge errors |
| `environment?`, `require_user_presence?` | – | as in config |
| `language?` | – | `"en" | "es" | "th"` |
| `autoClose?` | – | default `true` |

Headless: `useIDKitRequest({ …same config…, preset, polling: { interval, timeout } })` →
`{ open(), reset(), isAwaitingUserConnection, isAwaitingUserConfirmation, isSuccess, isError,
connectorURI, result, errorCode, getDebugReport() }`. Siblings: `IDKitInviteCodeRequestWidget` /
`useIDKitInviteCodeRequest` (adds `codeExpiresAt`; codes are one-shot, 15-min TTL) and
`IDKitSessionWidget` / `useIDKitSession`.
v3→v4 type renames: `IRpContext`→`RpContext`, `ISuccessResult`→`IDKitResult` (no `I` prefix).

### 2.4 Verify route (backend → Developer Portal)

Forward the IDKit result **byte-for-byte, as-is** (no remapping, no re-encoding — the #1 cause of
`invalid_proof`) to `POST https://developer.world.org/api/v4/verify/{rp_id}` (rp_id preferred;
app_id accepted for back-compat; staging host `https://staging-developer.worldcoin.org` exists but
the primary host verifies staging payloads too — the request's `environment` field governs).

**Request body** = the IDKit result. Three shapes (`oneOf`):
- **v4 uniqueness** (required: `protocol_version:"4.0"`, `nonce`, `action`, `responses[]`):
  each response item requires `identifier` (e.g. `proof_of_human`), `issuer_schema_id` (int),
  `nullifier`, `expires_at_min`, `proof` (**exactly 5 hex elements** — 4 compressed proof elements
  + Merkle root); optional `signal_hash` (default `0x0`). Optional top-level `action_description`,
  `environment: "production"|"staging"` (default production), `user_presence_completed`.
- **v3 legacy** (`protocol_version:"3.0"`): response items require `identifier` (e.g. `orb`),
  `proof` (single hex string), `merkle_root`, `nullifier`; optional `signal_hash` (default =
  hash_to_field("") `0x00c5d2…85a4`), `max_age` (3600–604800).
- **v4 session** (`session_id: session_<128 hex>`, items carry `session_nullifier: [nullifier, action]`).

**200 response:** `{ success: true, action?, nullifier?, created_at?, environment?, session_id?,
results: [{ identifier, success, nullifier?, code?, detail? }], message? }` — 200 means **at least
one** proof verified; check per-result `success` when multiple.
**400:** `{ success: false, code, detail, results? }` — documented codes: `app_not_migrated`
("use the v2 verify endpoint" — RP not v4-registered), `all_verifications_failed` (with per-result
`code: verification_error`, `detail: "On-chain proof verification failed."`), plus `invalid_proof` /
`verification_failed` (typically staging/production mismatch or mutated payload) and `not_registered` /
rp-errors (on-chain RP registration still `pending`). **404:** app not found / no longer active.
**Rate limits: none published** for `/api/v4/verify` — assume adequate for hackathon volume, but
don't poll it in a loop.

```ts
// inside the completion handler (guardianGate.ts)
const res = await fetch(`https://developer.world.org/api/v4/verify/${cfg.rpId}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(completion.result),        // AS-IS
});
const body = await res.json();
if (!res.ok || !body.success) throw new WorldIdVerifyError(body.code, body.detail);
```

**Enforce credential tier server-side** (client requests are advisory):
accept `results[].identifier === "proof_of_human"` (v4 Orb, cross-check `issuer_schema_id === 1`)
or legacy `"orb"`; optionally accept `"passport"` / legacy `"secure_document"` as a document tier;
**reject** `device`/`selfie` identifiers for guardianship. Persist the tier alongside the nullifier.

### 2.5 Nullifier storage + N-cap

Same human + same app + same action ⇒ same nullifier (unlinkable across apps — that's the privacy
model). Portal proves validity; **we** must dedupe. Docs warn about hex parsing/casing bugs —
normalize to decimal: `BigInt(nullifier).toString(10)` (fits TEXT in SQLite; the `NUMERIC(78,0)`
advice is Postgres-specific).

```sql
-- migration, mirrors passkeys table conventions
CREATE TABLE IF NOT EXISTS guardian_verifications (
  id            TEXT PRIMARY KEY,             -- handle (uuid), like passkey id
  tenant_id     TEXT NOT NULL,
  action        TEXT NOT NULL,
  nullifier_dec TEXT NOT NULL,                -- BigInt(nullifier).toString(10)
  identifier    TEXT NOT NULL,                -- proof_of_human | orb | passport …
  issuer_schema_id INTEGER,
  environment   TEXT NOT NULL,                -- production | staging
  verify_response_json TEXT NOT NULL,         -- durable attestation (one-shot verification)
  verified_at   INTEGER NOT NULL,
  UNIQUE (nullifier_dec, action)              -- the anti-replay constraint; reject on violation, never upsert
);
```

- **Dedupe:** unique-constraint violation on insert ⇒ this human already verified for this action.
  For our gate that is *fine* (same guardian, more entities) — the row's tenant binding is what
  matters; a *different* tenant presenting the same human's proof is rejected.
- **N-cap:** in `runner.start()` (and the MCP `onboard_agent` preflight):
  `SELECT COUNT(*) FROM entities e JOIN guardian_verifications g ON e.world_verification_id = g.id
  WHERE g.nullifier_dec = ? AND e.status != 'failed'` → reject over `WORLD_MAX_ENTITIES_PER_HUMAN`
  (default e.g. 5) with a typed error.
- Persist the whole verify response (`verify_response_json`) — one-shot verification; this is the
  durable attestation. Session proofs (`session_id` as the stable identifier) are the documented
  path for recurring re-auth — post-hackathon.

### 2.6 Insertion points (match the passkey stored-handle pattern)

- **`api/routes/onboard.ts` → `POST /onboard`:** after the `guardianPasskey` requirement check,
  when `WORLD_ID_REQUIRED=1` require `body.worldVerificationId`, load it from
  `guardian_verifications`, assert `tenant_id === c.get("tenantId")` (uniform 404 on miss, like
  passkeys), assert environment matches server config, then pass through to `runner.start()` where
  the N-cap runs. Persist `world_verification_id` on the `EntityRecord`.
- **New routes (mirror `mountPasskeyRoutes`):** `POST /worldid/verification` (authed) — starts the
  vanilla flow, returns `{ id, connectorURI }`; the server polls in the background and flips the row
  to verified on success. `GET /worldid/verification/:id` — status poll for the client.
- **`mcp/server.ts` → `onboard_agent`:** same stored-handle two-step as passkeys: a
  `request_guardian_verification` tool returns `connectorURI` ("HUMAN ACTION REQUIRED: open this
  link in World App…" — exactly the agentkit-cli UX), a follow-up call consumes the handle.
- Rollout flag `WORLD_ID_REQUIRED` (default off) so the branch is mergeable without breaking
  existing tenants; demo runs with it on.

### 2.7 Public metadata attestation

Extend `renderMetadata` (the public HTTPS metadata JSON served at
`project-alpha-pi.vercel.app/backend/metadata/<publicId>`, which is the on-chain ERC-8004
`metadataURI`) with a no-PII attestation block:

```jsonc
"guardianVerification": {
  "type": "world-id",
  "protocol": "4.0",
  "action": "guardian-verification",
  "credential": "proof_of_human",        // enforced tier
  "issuerSchemaId": 1,
  "nullifier": "0x…",                    // app+action-scoped; reveals nothing, unlinkable across apps
  "environment": "production",
  "verifiedAt": "2026-07-25T…Z"
}
```

This makes "a unique human guardian stands behind this legal body" independently checkable from the
agent's on-chain identity — the pitch line. (ein-style redaction rules from the metadata PR apply:
nothing here is PII; the nullifier is explicitly safe to publish.)

---

## 3. Testing without / with the Orb

### 3.1 Staging + simulator (no Orb, no phone — the 30-min loop)

Environment matching is THE failure mode. Three dials **must agree**:
1. the **action's** environment in the Portal (created per-environment — staging and production are
   *separate actions*, not separate apps),
2. the IDKit request's `environment` field,
3. the prover: simulator (staging) vs real World App (production).

A staging action + production World App **silently produces zero proofs** and looks like a frontend
bug. If World ID shows "action not found" or the QR scan does nothing, the action doesn't exist in
the environment IDKit points at.

Walkthrough:
1. Portal: action `guardian-verification` with `environment: staging` (T-0 step).
2. Backend: `WORLD_ENV=staging` → request carries `environment: "staging"`.
3. Open `https://simulator.worldcoin.org` in another tab. Create an identity — **temporary**
   (throwaway) or **persistent** (derived from a WalletConnect signature, survives reloads). The
   simulator's identity faucet inserts it into the staging identity set.
4. Paste the `connectorURI` (or scan the QR) into the simulator, pick the credential (Orb), send
   the proof.
5. Our backend polls to completion, forwards to `/api/v4/verify/{rp_id}` (payload carries
   `environment: "staging"`; response echoes it), stores the nullifier.
6. Re-run with the same identity → verify still 200s but our UNIQUE insert rejects — test the
   dedupe path this way.

⚠️ **Activation delay:** a freshly created simulator identity may fail for the first minutes with
`inclusion_proof_pending` (credential inclusion data not ready) — budget **~5 min**, retry; only if
it persists treat as `inclusion_proof_failed`/operational. Create the simulator identity FIRST,
then write code while it activates.

**Never mix**: staging rows must be marked (`environment` column) and staging verifications must
not satisfy the production gate — assert environment in the onboard consume step (§2.6).

### 3.2 Sandbox (optional deeper E2E)

A production-like isolated environment with its own World ID app builds:
iOS via public TestFlight link `https://testflight.apple.com/join/VZEurhHe` (no invite needed);
Android via Firebase App Distribution (link from a World contact — not self-serve, skip at the
hackathon). Set `environment: "sandbox"` in IDKit; accounts are resettable, proofs non-production.
Use only if we chase the Selfie-Check beta tracks; otherwise simulator + real Orb covers us.

### 3.3 With the Orb (production)

- Prereq per human: World App installed + account created (do in the queue). Capture <1 min;
  credential lands in World App and is usable within minutes (budget 10–15 min before relying on it).
- Flip `WORLD_ENV=production`; the guardian scans our real QR with World App — everything else
  identical (that's the point of the staging loop).
- Then immediately run the AgentKit CLI registration (§4.1) while the verified human is present.
- One-time note: the verify endpoint enforces max verifications per action if configured in the
  Portal (`max_verifications_reached`) — leave our action unlimited (default) since the same
  guardian may onboard several entities.

---

## 4. AgentKit — agent side (our agent proves it's human-backed)

### 4.1 Registration (one-time per wallet, before the weekend)

```bash
npx @worldcoin/agentkit-cli register <agent-address>   # any EVM address; our Arc EOAs are fine
npx @worldcoin/agentkit-cli status  <agent-address>    # → { registered, humanId, contract, network }
```

What the published CLI 0.2.0 actually does (source-verified — **ignore the repo's REGISTRATION.md
where it talks about Base**, see Δ3):
1. reads `getNextNonce(agent)` from AgentBook `0xA23aB…44dA` on **World Chain** (viem `worldchain`,
   default public RPC);
2. builds signal `solidityEncode(['address','uint256'], [agent, nonce])` — the World ID proof is
   bound to (address, nonce): old proofs can't be replayed for re-registration;
3. opens a World ID request via the **v3 bridge** (`createWorldBridgeStore`, its own hardcoded
   `app_id app_a7c3e2b6b83927251a0db5345bd7146a`, action `agentbook-registration`) → terminal QR +
   link; human scans with **production World App** (Orb-verified — AgentBook groupId=1); CLI polls
   (5-min timeout — rerun on `timed out`);
4. `--auto` (default): POSTs `{agent, root, nonce, nullifierHash, proof[8], contract}` to
   `https://x402-worldchain.vercel.app/register`; the relay pays World Chain gas → `{ txHash }`.
   `--manual` (`-m`): prints the payload for self-submission to
   `register(address agent, uint256 root, uint256 nonce, uint256 nullifierHash, uint256[8] proof)`.
   `API_URL=<base>` overrides the relay (POST `{API_URL}/register`).
5. Registration is permanent; multiple agents per human: yes; **no revoke function on AgentBook**
   (our guardian clawback is the honest answer to "what if the agent goes rogue").

Errors: `VERIFICATION_FAILED` (bridge errorCode), `INVALID_PROOF` (unexpected proof shape),
`REGISTRATION_FAILED <status>: <body>` (relay; retryable), `STATUS_LOOKUP_FAILED` (RPC; retryable).

⚠️ **Risk R1 (new, important):** the CLI's pinned `idkit-core@2.1.0` requests a **v3 legacy Orb
proof**. Per the v4 migration timeline, **users whose World ID was created after 2026-06-01 are
v4-only and cannot generate v3 proofs.** A teammate freshly verified at the venue on a NEW account
may be unable to complete AgentBook registration. Mitigations, in order: (a) register tonight with
a team member whose World ID predates June 2026; (b) an existing pre-June account that gets
Orb-verified at the venue keeps its original credential lineage — test immediately after verifying;
(c) fallback: registration-free demo against our own AgentBook stub (§6) — label it clearly.

### 4.2 Signer adapter

The registered AgentBook address must equal the address that signs AgentKit challenges. One
`personal_sign` per challenge; type `eip191`.

```ts
// pocket EOA (15-min path) — reuse the per-entity derivation from entityPayment.ts
import { privateKeyToAccount } from "viem/accounts";
import { derivePocketKey } from "../adapters/x402/pocketDerivation";

export function agentkitSignerForEntity(cfg: Config, entity: EntityRecord): AgentkitSigner {
  const account = privateKeyToAccount(derivePocketKey(cfg.pocketMasterSeed!, entity.idempotencyKey));
  return {
    address: account.address,
    chainId: "eip155:5042002",                       // CAIP-2; must match a supportedChains entry in the 402
    type: "eip191",
    signMessage: (message) => account.signMessage({ message }),
  };
}
// Turnkey operator variant: add signMessage (personal_sign) to OperatorSigner and pass its address.
// Whichever you pick, THAT address is the one to register in §4.1.
```

`AgentkitSigner = { address: string; chainId: string; type: 'eip191' | 'eip1271';
signMessage(message: string): Promise<string> }`.

### 4.3 `createAgentkitClient` + wrapping `buyWithX402`

`createAgentkitClient({ signer, fetch?, onEvent? })` → `{ fetch, createHeader }`.
- `fetch` has the exact `fetch` shape. Behavior (source-verified): pass-through unless the first
  response is **402 with a JSON body containing `extensions.agentkit`** (needs `info.domain/uri/
  version/nonce/issuedAt` strings + `supportedChains` array to be recognized). Then: pick the
  `supportedChains` entry matching the signer's `chainId`+`type` (no match ⇒ skip, return original
  402); build the CAIP-122/SIWE message via viem `createSiweMessage`; sign; base64-encode the JSON
  payload (`info` fields + `address` + `chainId` + `type` + `signature`); **retry once** with header
  `agentkit: <base64>`. If the retry still 402s, that response is returned — normal x402 takes over.
  It never creates payments.
- `createHeader(extension)` for non-fetch HTTP clients.
- `onEvent` types: `agentkit_detected{url}`, `agentkit_signed{url,chainId,signatureType}`,
  `agentkit_skipped{url,reason}`, `agentkit_retry_completed{url,status}` — log these into our
  payment ledger events for the demo.

Composition — one line in `entityPayment.ts` `pay()` (AgentKit in FRONT of the x402 buyer;
policy engine still authorizes any actual payment; free-pass responses never touch the ledger):

```ts
const baseFetch = deps.fetchImpl ?? ((u, i) => safeFetch(fetch, u as string, i)); // SSRF wrap stays innermost
const agentkit = createAgentkitClient({ signer: agentkitSignerForEntity(cfg, entity), fetch: baseFetch });
const fetchImpl = agentkit.fetch;   // hand THIS to buyWithX402 as d.fetchImpl
```

Flow: `buyWithX402` does its first fetch through `agentkit.fetch` → on an AgentKit-enabled 402 the
client retries with the header → if the seller grants access (200), `buyWithX402` sees a non-402
first response and returns **without paying** (no authorize, no ledger row — correct); if exhausted
(seller falls through to plain 402), `buyWithX402` proceeds: `evaluatePolicy` → sign X-PAYMENT →
settle on Arc via Circle Gateway, untouched. One caveat: `buyWithX402` reads the FINAL 402 body for
`accepts[0]` — our seller must keep `accepts` present in every 402 variant (it does, §5).

### 4.4 E2E check

Against our own seller (§5) or any public AgentKit endpoint: first call with an unregistered signer
⇒ `agentkit_skipped`/`agent_not_verified` ⇒ falls through to payment; with the registered signer ⇒
`agent_verified` 200. Confirm zero ledger rows for free-pass calls, then exhaust the trial and
confirm leg 4 settles real USDC through the governed treasury.

---

## 5. AgentKit — seller side (manual seam in `buildPaywall`)

Do NOT adopt `x402ResourceServer`/`paymentMiddlewareFromHTTPServer` (that's the `@x402/*` v2 resource
server — our seller speaks x402 v1 with the Circle batching scheme). The low-level functions are
fully separable and chain-agnostic; the paid route stays on Arc, and **AgentBook lookup always
resolves on World Chain regardless** (SDK guarantee).

### 5.1 The 402 extension body (hand-minted)

`declareAgentkitExtension(options)` (options: `domain?`, `resourceUri?`, `statement?`, `version?`
(default `"1"`), `network?: string | string[]`, `expirationSeconds?`, `mode?`) returns
`{ agentkit: { info, supportedChains, schema, _options } }` — but (source-verified) it does **NOT**
fill `info.nonce` / `info.issuedAt` / `info.expirationTime` (the hooks pipeline normally does).
Hand-mint them per response or the client's `isAgentkitExtension` check rejects it:

```ts
// payments/agentkitSeam.ts
import { declareAgentkitExtension } from "@worldcoin/agentkit";
import { randomUUID } from "node:crypto";

export function mintAgentkitExtension(cfg: { domain: string; resourceUrl: string }) {
  const ext = declareAgentkitExtension({
    domain: cfg.domain,                       // hostname ONLY, no port — validation compares URL.hostname
    resourceUri: cfg.resourceUrl,             // full public URL (through the Vercel proxy)
    network: "eip155:5042002",                // ⇒ supportedChains [{chainId,type:'eip191'},{…'eip1271'}]
    statement: "Prove this agent is backed by a verified human",
    mode: { type: "free-trial", uses: 3 },    // advertised to clients; enforcement is ours
  });
  const a = ext.agentkit;
  // ⚠ CORRECTION (2026-07-25) — THIS DOC'S EARLIER SAMPLE WAS WRONG, NOT THE SDK.
  // An earlier revision of this file suggested `randomUUID()` here. That is a BUG IN THIS DOC:
  // the nonce feeds an EIP-4361 (SIWE) message, and SIWE requires an ALPHANUMERIC nonce, so a
  // UUID's hyphens make the client's createHeader throw SiweError "Nonce size smaller then 8
  // characters or is not alphanumeric" — which agentkitFetch catches and reports as
  // `agentkit_skipped` (observable via onEvent, but invisible if you don't subscribe): the agent
  // silently never gets authorized.
  // VERIFIED: World's own `agentkitResourceServerExtension` uses exactly the line below
  // (`randomBytes(16).toString("hex")`), i.e. the SDK does this correctly — we only hit it because
  // we hand-mint the extension (our seller is x402 v1 + Circle batching, so their v2 resource
  // server is not usable). World's docs do not show nonce generation at all; the only fair
  // feedback for them is that the "Manual Usage (Advanced)" path doesn't state the SIWE
  // alphanumeric constraint. NOT an SDK bug — do not report it as one.
  a.info.nonce = randomBytes(16).toString("hex");   // NOT randomUUID()
  a.info.issuedAt = new Date().toISOString();
  a.info.expirationTime = new Date(Date.now() + 5 * 60_000).toISOString();
  return ext; // spread as a TOP-LEVEL `extensions` key next to `accepts`
}
```

Resulting 402 body (our v1 shape + the extension — the client only reads `.extensions.agentkit`,
so x402Version 1 vs 2 is irrelevant to it):

```jsonc
{
  "x402Version": 1,
  "accepts": [ { "scheme": "…circle-batching…", "network": "eip155:5042002", "asset": "0x3600…", 
                 "payTo": "<treasury>", "maxAmountRequired": "10000", "maxTimeoutSeconds": 60 } ],
  "extensions": {
    "agentkit": {
      "info": { "domain": "project-alpha-pi.vercel.app", "uri": "https://project-alpha-pi.vercel.app/backend/x402-demo/quote",
                "resources": ["…same…"], "statement": "…", "version": "1",
                "nonce": "…uuid…", "issuedAt": "…ISO…", "expirationTime": "…ISO…" },
      "supportedChains": [ { "chainId": "eip155:5042002", "type": "eip191" },
                           { "chainId": "eip155:5042002", "type": "eip1271" } ],
      "schema": { /* JSON Schema of the header payload — filled by declareAgentkitExtension */ }
    }
  }
}
```

### 5.2 Header verification path (insert in `buildPaywall` BEFORE the X-PAYMENT branch)

Low-level API (signatures + return types, source-verified):
- `parseAgentkitHeader(header: string): AgentkitPayload` — base64→JSON→zod
  (`AgentkitPayloadSchema`: required `domain,address,uri,version,chainId,type,nonce,issuedAt,signature`;
  optional `statement,expirationTime,notBefore,requestId,resources,signatureScheme`).
  **Throws** `Invalid agentkit header: …` on malformed input — try/catch it.
- `validateAgentkitMessage(payload, expectedResourceUri, { maxAge?, checkNonce? }): Promise<{valid, error?}>` —
  checks `payload.domain === new URL(expected).hostname`, `new URL(payload.uri).host ===
  new URL(expected).host` (note: hostname vs host asymmetry — keep the public URL portless),
  `issuedAt` within `maxAge` (default 5 min) and not in the future, `expirationTime`/`notBefore`
  windows, then `checkNonce(nonce)` (return `false` ⇒ "Nonce validation failed (possible replay
  attack)"). Wire `checkNonce` to our SQLite nonce table (§5.4).
- `verifyAgentkitSignature(payload, options?): Promise<{valid, address?, error?}>` — reconstructs the
  SIWE message (viem `createSiweMessage`) and calls `publicClient.verifyMessage` on the **signed**
  chain: automatic ERC-1271/6492 smart-wallet support with EOA ecrecover fallback. `options` is
  a string rpcUrl or `{ rpcUrl?, rpcUrls?: Record<caip2, url> }`. Built-in default RPCs include
  **Arc testnet via a shared Alchemy free-tier key**
  (`https://arc-testnet.g.alchemy.com/v2/k0eQqlkOQBUAUuM8qcfGh` — public, rate-limited; pass
  `rpcUrls: { "eip155:5042002": cfg.rpcUrl }` to use ours), plus World Chain, Base, Tempo, and a
  pre-wired Arc mainnet id 5042. Error strings embed the reconstructed SIWE message — great for debugging.
- `createAgentBookVerifier({ rpcUrl?, contractAddress?, client? })` → `{ lookupHuman(address):
  Promise<string | null> }` — ALWAYS World Chain (`worldchain` viem chain, default public RPC
  `https://worldchain-mainnet.g.alchemy.com/public`); returns humanId hex or `null` (not registered
  **or RPC error — errors are swallowed**, so add our own retry/cache, §5.5). `client` injects any
  viem PublicClient (this is the stub/anvil hook for §6).

```ts
// in buildPaywall's route, before `if (!header) return c.json(buildRequirements(cfg), 402);`
const akHeader = c.req.header("agentkit");
if (akHeader && cfg.agentkit) {
  const outcome = await handleAgentkit(akHeader, cfg);      // below
  if (outcome.grant) {
    // human-backed & within allowance: serve WITHOUT payment; no settle, no ledger
    return c.json((await cfg.serve(c.req.raw)) as Record<string, unknown>, 200);
  }
  // fall through to the normal 402/X-PAYMENT flow (include extensions in the 402 body)
}
// … existing 402s become: c.json({ ...buildRequirements(cfg), ...(cfg.agentkit ? { extensions: mintAgentkitExtension(cfg.agentkit) } : {}) }, 402)

async function handleAgentkit(header: string, cfg): Promise<{ grant: boolean; humanId?: string }> {
  let payload;
  try { payload = parseAgentkitHeader(header); } catch { return { grant: false }; }
  const validation = await validateAgentkitMessage(payload, cfg.agentkit.resourceUrl, {
    checkNonce: (n) => !cfg.agentkit.storage.hasNonce(n),
  });
  if (!validation.valid) return { grant: false };
  const sig = await verifyAgentkitSignature(payload, { rpcUrls: { "eip155:5042002": cfg.rpcUrl } });
  if (!sig.valid || !sig.address) return { grant: false };
  const humanId = await cfg.agentkit.agentBook.lookupHuman(sig.address);   // World Chain read
  if (!humanId) return { grant: false };                                    // not human-backed
  cfg.agentkit.storage.recordNonce(payload.nonce);
  const withinAllowance = cfg.agentkit.storage.tryIncrementUsage(
    cfg.agentkit.resourceUrl, humanId, cfg.agentkit.uses);                  // per-HUMAN, per-endpoint
  return { grant: withinAllowance, humanId };
}
```

Every deny falls through to payment — AgentKit failure can never break the paid path.

### 5.3 Access modes (semantics — enforcement is ours in the manual seam)

`AgentkitMode`: `{type:'free'}` (always bypass) · `{type:'free-trial', uses?}` (first N per human
per endpoint bypass; default 1) · `{type:'discount', percent, uses?}` — discount REQUIRES the v2
facilitator `verifyFailureHook` machinery (underpay → verify fails → hook adjusts amount) and does
**not** fit our v1 seam; don't attempt it. Counters key on **humanId** (two agents, one human ⇒
shared counter) — demo this: register the pocket EOA of a second entity under the same human and
show the shared allowance. ⚠️ Framing: see §7 — present the mode as *authorization/limits*, not a perk.

### 5.4 Storage (SQLite; the SDK interface for reference)

`AgentKitStorage` = `{ tryIncrementUsage(endpoint, humanId, limit): Promise<boolean> /* MUST be
atomic check+increment */, hasUsedNonce?(nonce), recordNonce?(nonce) }`. `InMemoryAgentKitStorage`
is a Map/Set reference impl (fine for tests). Ours (better-sqlite3 is synchronous ⇒ atomic):

```sql
CREATE TABLE IF NOT EXISTS agentkit_usage (
  endpoint TEXT NOT NULL, human_id TEXT NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (endpoint, human_id));
CREATE TABLE IF NOT EXISTS agentkit_nonces (
  nonce TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);   -- prune > 10 min old
```
`tryIncrementUsage` = single
`UPDATE … SET uses = uses + 1 WHERE endpoint=? AND human_id=? AND uses < ?` (insert-or-ignore
first; `changes === 1` ⇒ granted).

### 5.5 AgentBook lookup caching

Public World Chain RPC is fine for demo volume but uncapped-undocumented; cache
`address → humanId` in SQLite with a short TTL (e.g. 10 min — registration is append-only, no
revoke, so positive results can be cached long; cache negatives briefly). If the public RPC flakes:
Alchemy free-tier keyed URL `https://worldchain-mainnet.g.alchemy.com/v2/<OUR_KEY>` (create one
account pre-event), or any World Chain RPC via `createAgentBookVerifier({ rpcUrl })`.

### 5.6 Demo money-shot (reframed — see §7)

Same agent, same endpoint: (1) unregistered agent → 402 → policy-governed x402 settlement on Arc
(the *only* path for anonymous automation); (2) registered human-backed agent → authorized N
sponsored calls tied to its humanId, every call logged against the human identifier; (3) allowance
exhausted → falls back to governed payment; (4) guardian pauses the treasury on-chain → even the
human-backed agent can no longer *spend* — accountability end-to-end. Smoke-test **hour 1** that the
`agentkit` header survives the Vercel proxy (it stripped `X-PAYMENT` before — risk R4).

---

## 6. AgentBook direct-read fallback (no SDK, ~50 lines)

If `@worldcoin/agentkit` install fights us, the whole seller seam is reproducible with viem alone
(we already ship viem 2.52.2; `worldchain` chain + `createSiweMessage`/`parseSiweMessage` +
`verifyMessage` all included):

```ts
// payments/agentkitLite.ts — EOA-only (skips ERC-1271), enough for our own client
import { createPublicClient, http, toHex, verifyMessage } from "viem";
import { worldchain } from "viem/chains";
import { parseSiweMessage } from "viem/siwe";

const AGENT_BOOK = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" as const;
const ABI = [
  { type: "function", name: "lookupHuman", stateMutability: "view",
    inputs: [{ name: "", type: "address" }], outputs: [{ name: "humanId", type: "uint256" }] },
  { type: "function", name: "getNextNonce", stateMutability: "view",
    inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;
const client = createPublicClient({ chain: worldchain, transport: http() }); // or http(cfg.worldchainRpcUrl)

export async function lookupHuman(address: `0x${string}`): Promise<`0x${string}` | null> {
  const id = await client.readContract({ address: AGENT_BOOK, abi: ABI, functionName: "lookupHuman", args: [address] });
  return id === 0n ? null : toHex(id);
}

export async function verifyAgentkitHeaderLite(header: string, expectedHost: string) {
  const p = JSON.parse(Buffer.from(header, "base64").toString("utf8")); // AgentkitPayload
  if (p.domain !== expectedHost) return null;
  const age = Date.now() - Date.parse(p.issuedAt);
  if (!(age >= 0 && age < 5 * 60_000)) return null;
  // Reconstruct the exact CAIP-122/SIWE message the client signed (viem's canonical formatter):
  const { createSiweMessage } = await import("viem/siwe");
  const message = createSiweMessage({
    domain: p.domain, address: p.address, statement: p.statement, uri: p.uri,
    version: p.version, chainId: Number(p.chainId.split(":")[1]), nonce: p.nonce,
    issuedAt: new Date(p.issuedAt),
    expirationTime: p.expirationTime ? new Date(p.expirationTime) : undefined,
    resources: p.resources,
  });
  const ok = await verifyMessage({ address: p.address, message, signature: p.signature }); // offline ecrecover
  if (!ok) return null;
  return lookupHuman(p.address); // humanId hex | null
}
```

**Full contract surface we touch** (AgentBook.sol, Miguel Piedrafita, Ownable2Step):
`register(address agent, uint256 root, uint256 nonce, uint256 nullifierHash, uint256[8] proof)`
(nonce must equal `getNextNonce[agent]`, sets `lookupHuman[agent] = nullifierHash` then
`worldIdRouter.verifyProof(root, groupId, hashToField(abi.encodePacked(agent, nonce)),
nullifierHash, EXTERNAL_NULLIFIER_HASH, proof)` — reverts on bad proof, so state only persists on
valid registration) · views `lookupHuman(address)→uint256`, `getNextNonce(address)→uint256`,
`groupId()→uint256` (Orb group = 1), `worldIdRouter()` · event
`AgentRegistered(address indexed agent, uint256 indexed humanId)` · errors `InvalidNonce()`,
`InvalidConfiguration()`, `CannotRenounceOwnership()`.

**Stub path (last resort, clearly labeled):** deploy this 2-view-function shape (or the real
AgentBook with a mock router) on anvil/Arc and point `createAgentBookVerifier({ client })` or
`agentkitLite`'s `client` at it. Base Sepolia has a real deployment at the same `0xA23aB…` address,
but it still requires a real Orb proof to register and the published CLI cannot target it (no
`--network` flag — Δ3), so it does not remove the Orb dependency.

---

## 7. Track rules (verbatim) + framing guardrails

Fetched 2026-07-24 from `https://ethglobal.com/events/lisbon2026/prizes/world`:

**World prize pool — five tracks:**
1. **AgentKit New Use Cases — $8,000** (1st $4,000 / 2nd $2,500 / 3rd $1,500) ← our target
2. Selfie Check Beta — $1,750 (1st $1,000 / 2nd $750)
3. Identity Check Beta Test — $1,750 (1st $1,000 / 2nd $750)
4. Selfie Check Beta – Continuity — $1,750 (two winners × $875, Continuity Track only)
5. Identity Check Beta Test – Continuity — $1,750 (two winners × $875, Continuity Track only)

**AgentKit qualification (verbatim):**
- "Uses AgentKit in a meaningful way"
- "Verifies an agent is human-backed before granting access, limits, pricing, authorization, or execution rights"
- "Shows a working end-to-end flow, not just a wrapper or static demo"

**AgentKit — will NOT qualify (verbatim): "Projects reusing prior hackathon patterns without
genuinely new workflows, including:**
- **Agent reputation**
- **Human-backed agent interactions in simple content generation use cases**
- **Human-backed benefits for AI agents (i.e API calls, discounts)"**

**Framing guardrails (the DQ list got sharper than the blueprint assumed):**
- ❌ Never say *reputation*, *discount*, *cheaper*, *free API calls*, *perk*, *rewards*.
- ✅ Vocabulary from their own qualification line: **access, limits, pricing, authorization,
  execution rights** — plus our unique words: *legal accountability, guardianship, governed treasury,
  clawback*.
- ✅ Our genuinely new workflow (say this): AgentKit as the **authorization/accountability layer of
  an agent LEGAL BODY** — human-backing is checked before an agent gets *execution rights* against
  a paid resource, is bound to a *legally accountable guardian* via the World ID gate, and every
  spend stays inside an on-chain governed treasury the guardian can pause/claw back (answering
  AgentBook's no-revoke gap). The free-trial counter is presented as a **per-human authorization
  limit**, not a benefit.
- ⚠️ **Honesty line — do not over-claim linkage:** the guardian-gate nullifier (our app + action)
  and the AgentBook humanId (their app + `agentbook-registration`) are **cryptographically
  unlinkable by design** (nullifiers are app/action-scoped). Pitch them as two *independent*
  proof-of-personhood anchors on the same stack — never claim we've verified it's the *same* human.
- Selfie/Identity Check tracks (incl. their Continuity variants) require: meaningful implementation
  ("risk, eligibility, fairness, continuity, abuse prevention—not generic login"), **"testing
  documentation with both developer feedback and user feedback"**, a working app/prototype; Identity
  Check additionally wants a data-minimization rationale. Both credentials are **access-gated**
  ("select partners" / preview — `developers@toolsforhumanity.com`; check `enable_face_check` via
  `POST https://developer.world.org/api/v1/precheck/{app_id}` `{"action": "…"}`). Only stretch for
  these if the World booth grants access Friday — the Continuity variants are uncontested-looking
  money but the access gate + feedback-doc requirement is real work.
- World workshop: **Friday, July 24, 4:30 PM WEST, in-person** — attend; ask about R1 (v3 proof for
  fresh accounts) and beta-credential access there.
- Continuity mechanics still apply (README): dedicated branch, incremental commits, pre-event tag.

---

## 8. Corrections & deltas vs technical-blueprints.md

| # | Blueprint said | Reality (verified 2026-07-24) | Impact |
|---|---|---|---|
| Δ1 | Widget preset `orbLegacy({signal})` | Docs now ship **`proofOfHuman`** (v4 PoH + automatic legacy-Orb fallback); `orbLegacy` is in the "other legacy presets" bucket, v3-only | Use `proofOfHuman` + `allow_legacy_proofs: true`; accept `proof_of_human` (schema 1) OR `orb` server-side |
| Δ2 | "framing: authorization/accountability — NEVER reputation or discounts" | Confirmed and now **explicit on the prize page**: "Human-backed benefits for AI agents (i.e API calls, discounts)" is on the verbatim DQ list | The "free-trial ×3" money-shot must be *presented* as a per-human authorization limit inside the legal-body governance story (§5.6, §7) — mechanic unchanged, language changed |
| Δ3 | CLI registers on World Chain via hosted relay | True for **published CLI 0.2.0** (source-verified). BUT the repo's `cli/REGISTRATION.md` describes a **Base-default CLI with `--network base|base-sepolia`** and a Base AgentBook `0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4` that the shipped CLI cannot reach (no `--network` flag exists in 0.2.0 source) — docs are ahead of code | Follow the CLI, not REGISTRATION.md. If a 0.3.0 drops mid-event defaulting to Base, pin `@worldcoin/agentkit-cli@0.2.0` (verifier default = World Chain `0xA23aB…` — matches 0.2.0 registration) |
| Δ4 | "Base Sepolia deployment exists (same addr) but … no default relay" | Still true, but *additionally* unreachable from the published CLI (Δ3) | Base Sepolia is NOT a working Orb-free fallback; use the stub path (§6) instead |
| Δ5 | "staging app in Portal" | Staging/production is an **action-level** environment (create two actions in one app; `create_world_id_action` env param); the three dials (action env, IDKit `environment`, prover) must match | Simpler Portal setup; sharper failure mode (§3.1) |
| Δ6 | "SDK dep clash with our x402 v1 stack" listed as risk 3 | **Non-issue**: `@x402/core@2.15.0` already installed beside `x402@1.2.0` in our backend (via `@x402/evm`); agentkit's `@x402/core` use is type-only | Delete the risk; keep the §6 fallback for install-friction reasons only |
| Δ7 | World ID v4 "mid-migration, v3+v4 accepted until 2027-03-31" | True for *verification*, but **new accounts since 2026-06-01 are v4-only** — they cannot produce the v3 proofs the AgentKit CLI (idkit-core 2.1.0) requests | **NEW RISK R1** — venue-fresh World IDs may fail AgentBook registration; register tonight with a pre-June account (§4.1) |
| Δ8 | Prize framing "targets: AgentKit New Use Cases $8k" | Confirmed $8k (4k/2.5k/1.5k); **four additional World tracks exist**, incl. two Continuity-only prizes (Selfie/Identity Check Beta, $1,750 each, two winners each) — access-gated + testing-doc requirements | Optional stretch; ask at the booth/workshop (§7) |
| Δ9 | "Portal (developer.world.org): app → app_id + rp_id + signing_key" | Confirmed; plus: signing key is shown **exactly once** (rotation invalidates), `app_mode` must be `external` (fixed at creation), on-chain RP registration must reach `registered`, and a **Developer Portal MCP** (`https://developer.world.org/api/mcp`) can do all of it from Claude Code | §1 T-0, §2 |
| Δ10 | `agentkit.fetch` "only acts on 402s with `extensions.agentkit` in JSON body" | Confirmed from source, with precision: retries **exactly once**, requires a matching `supportedChains` entry (chainId+type), and `declareAgentkitExtension` does NOT mint `nonce`/`issuedAt` — hand-mint or the client ignores our 402 | §5.1 is load-bearing |
| Δ11 | Verify: "Response has `nullifier`, `results[].identifier`, `issuer_schema_id`" | Confirmed + full schemas/error codes now documented (§2.4); v4 proof = exactly 5 hex elements; nullifiers should be stored as decimal | §2.4–2.5 |
| Δ12 | idkit@4.2.1 / idkit-core@4.2.2 | Unchanged (republished 2026-07-17 — still moving; pin exact) | — |

**New risks discovered (beyond blueprint's 3):**
- **R1 (HIGH):** AgentKit CLI v3-proof dependency vs post-June-2026 v4-only World IDs → §4.1, Δ7.
  Mitigate TONIGHT with a pre-June-verified teammate.
- **R2 (MED):** `createAgentBookVerifier().lookupHuman` swallows RPC errors as `null` ("not
  registered") — a World Chain RPC outage silently downgrades human-backed agents to the paid path.
  Acceptable failure direction (fail-closed to payment), but cache positives (§5.5) and log raw reads.
- **R3 (LOW):** AgentKit packages are beta (0.2.x) and repo main is already 0.2.1-unreleased with
  the Base migration staged (Δ3); pin exact versions, vendor the §6 fallback.
- **R4 (MED):** Vercel proxy header stripping — it ate `X-PAYMENT` once; the `agentkit` header and
  the 402 JSON `extensions` body must round-trip through `project-alpha-pi.vercel.app/backend/*`.
  Hour-1 smoke test; VPS-direct TLS is the fallback.
- **R5 (LOW):** `/api/v4/verify` rate limits are unpublished; verify once per onboarding (never in
  a poll loop) and persist the response.
