# World identity stack — docs dive & integration decisions (2026-07-30)

Research pass over docs.world.org (July 2026) triggered by the question: *should we integrate
World's "proof of identity" beta?* Answer in short: **we already integrated its preview form at
the hackathon; keep it optional while it is in preview, adopt session proofs for guardian
continuity, and use the new Sandbox for testing.** Details and receipts below.

## The current World credential landscape

| Product | Status (their words) | What it proves |
|---|---|---|
| Proof of Human (Orb) | Active | unique human, biometric, strongest sybil resistance |
| NFC Credential (Document) | **"Active"** (GA) | possession of a unique govt document (ICAO-9303 passport, eID, JP My Number); one document ↔ one World ID; **no renewal** — users enroll a new document |
| `identityCheck` preset | **"preview"** | attestation that document-backed properties match requested attributes |
| Selfie Check | **Beta/preview** | low-assurance liveness/uniqueness from a selfie |
| Session proofs (4.0) | shipped with 4.0 | **human continuity** — same human present across interactions |

`identityCheck` attributes a relying party can request: `document_type` (passport/eid/mnc),
`minimum_age`, `nationality` (ISO alpha-3), `issuing_country`, `full_name`, `document_number`.

**This is the thing we integrated at the hackathon** (`WORLD_ATTEST_ACTION` +
`WORLD_ATTEST_MIN_AGE`, `guardian_attestations` table). The user-visible name "proof of identity"
in World's marketing maps to the NFC/Document credential + the `identityCheck` preset on top.

## Two audit conclusions now confirmed by World's own docs

1. **`identity_attested` is NOT in the server verify response.** The v4 verify API's OpenAPI
   schema (`POST /api/v4/verify/{rp_id}`) has no `identity_attested` field anywhere — success is
   the per-credential `results[].success` boolean. The preset docs *do* say "successful Identity
   Check responses include `identity_attested`", i.e. it arrives via the client-side idkit result
   only. Our audit finding (claim-grade, client-controlled) matches their spec exactly; feedback
   item #3 stands, now phrased with their own schema as the receipt.

2. **`expires_at_min` is a validity floor, not an expiry.** Their docs: *"an integer representing
   the minimum timestamp until which the credential remains valid"* — i.e. the prover commits to
   "valid until AT LEAST this moment", generated on the phone at proof time. That is why our four
   measured values landed 19–44s in the past by the time we recorded them: they date from proof
   generation. Gating on it as an expiry (PR #58's first attempt) was semantically wrong, exactly
   as the production data showed. The still-open question for World is only: *what should a relying
   party read to know when a credential actually lapses?* (The NFC credential does carry a real
   `expires_at`, max 10 years, no renewal — but that is credential-internal.)

## Session proofs — the answer to guardian re-verification

World ID 4.0 has a dedicated mechanism for "is the same human still there?":

- `IDKit.createSession(...)` at first verification → store the returned **`session_id`**
  (persistent identifier for this human at this RP).
- Later: `IDKit.proveSession(sessionId, ...)` → fresh proof with a per-proof
  **`session_nullifier`** (replay protection); RP checks the `session_id` matches the stored one.
- Optional `require_user_presence: true` → forces a fresh liveness check before the proof returns.

This is strictly better than calendar re-scans, and it sidesteps the constraint we hit in the
audit: **World App refuses to re-prove an already-used uniqueness action** (replay), so naive
"verify again weekly" against the same action does not even leave the phone.

## Sandbox — the testing story

World now ships a dedicated **Sandbox**: a production-like environment with its own backend and
mobile apps (TestFlight `https://testflight.apple.com/join/VZEurhHe` / Play tester access via the
Developer Portal), **resettable accounts** ("delete an account and sign up again as often as you
need"), simulated verification without real hardware, and **toggleable fraud/attestation checks**.
Server-side integration is one switch: `environment: sandbox` — "nothing else is required".
Explicitly NOT for load testing or production sign-off; it cannot provide real uniqueness.

Our config already carries the enum (`WORLD_ENVIRONMENT=production|staging|sandbox`), so adoption
is configuration, not code. See `docs/runbooks/world-sandbox-testing.md` + `.env.sandbox.example`.

Limit that stays: **AgentBook is mainnet-only** (no sandbox deployment of the on-chain register),
so seller-side human-backing is tested with injected readers in the suite and the one real
registered demo key on prod. Sandbox covers the *onboarding/guardian* side fully.

## Decisions

1. **Identity Check: keep integrated, keep OPTIONAL while "preview".** Three reasons: preview
   status; country coverage (France's passport is still unsupported — we could not attest
   ourselves); and the `identity_attested` server-response gap means we can only treat it as a
   claim. Revisit when it goes GA: it then becomes the *enhanced verification tier* for
   real-money mainnet (v2.5/v3) — note `full_name` / `document_number` attestation could bind a
   guardian to the exact name on a Wyoming filing, which is the bridge from personhood to legal
   identity (with x401/KYC remaining the formal compliance layer).
2. **Adopt session proofs for guardian continuity in the v2.5 batch**: store `session_id`
   alongside the nullifier at first verification; `proveSession` (with `require_user_presence`
   for the sensitive cases) on guardian-critical events. Event-driven, not weekly — see the
   re-verification policy in the roadmap discussion.
3. **Use Sandbox for all fake-human testing** (multiple resettable identities = we can finally
   exercise the one-human-one-tenant sybil gate properly); keep `staging` working since our
   captured fixtures came from there.
4. World feedback draft updated: item 4 rephrased so we do not ask what their docs now answer.

Sources: docs.world.org — world-id/overview, world-id/credentials/9303, world-id/idkit/credentials,
api-reference/developer-portal/verify, world-id/4-0-migration, world-id/sandbox/what-is-sandbox,
world-id/sandbox/sandbox-access; world.org/blog announcements (World ID full-stack proof of human,
AgentKit).
