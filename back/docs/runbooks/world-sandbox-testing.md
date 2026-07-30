# Runbook: testing guardian flows with fake humans (World Sandbox)

*2026-07-30. Why this exists: prod enforces `WORLD_REQUIRE_GUARDIAN` and World's sybil protection
means one real human can back exactly one tenant per action — so your own World ID cannot test the
"fresh unverified user" path, the sybil rejection path, or multi-human scenarios. During the
post-hackathon audit we worked around this by flipping the prod action (`guardian-audit`), which
worked but touched production. The Sandbox makes all of that a local, repeatable, five-minute
routine. Background: `docs/research/2026-07-30-world-identity-research.md`.*

## What the Sandbox gives us

A production-like World environment with its own backend and its own mobile app, where accounts
are **resettable** — delete an identity and sign up again as often as needed. Each fresh sandbox
identity produces a **different nullifier**, i.e. a different "fake verified human". That is the
one thing prod testing can never give us.

What it deliberately does not give us: real uniqueness, load-testing headroom, or an AgentBook —
the on-chain register exists only on World Chain mainnet, so seller-side (AgentKit) human-backing
stays covered by the injected readers in the test suite and the registered demo key on prod.

## One-time setup

1. **Install the sandbox World App** (separate app, not your real World App):
   - iOS: TestFlight → https://testflight.apple.com/join/VZEurhHe → install "World ID (Sandbox)".
   - Android: Developer Portal → World ID Sandbox → request tester access with your Google
     account email → install from the Play link once approved.
2. **Create the sandbox action** in the Developer Portal for the same app: `guardian-sandbox`
   (and `guardian-attest-sandbox` if testing the Identity Check step-up).
3. **Create the local profile**: `cp back/backend/.env.sandbox.example back/backend/.env.sandbox`
   and fill in `WORLD_APP_ID` / `WORLD_RP_ID` / `WORLD_RP_SIGNING_KEY` (same portal credentials as
   dev) plus a throwaway `PLATFORM_PRIVATE_KEY`. The profile pins `WORLD_ENVIRONMENT=sandbox`,
   a dedicated `DATA_DIR=./data-sandbox`, and enforcement ON.

## Per-session routine

```bash
cd back/backend
npm run api:sandbox          # same entrypoint, .env.sandbox via DOTENV_CONFIG_PATH
```

Then exercise whatever the test calls for from the interface (pointed at :8789) or curl:

- **Fresh-human onboarding**: sandbox app with a new account → verify → onboard. ~10s hot flow.
- **Sybil rejection**: verify tenant A with sandbox identity X, then try to verify tenant B with
  the SAME identity X → must be refused (`nullifier` already bound). This was untestable before.
- **Unverified refusal**: attempt onboarding with a tenant that never verified → gate must refuse.
- **Many humans**: reset the sandbox account (or sign up again) → new nullifier → repeat.

The sandbox DB is disposable: `rm -rf back/backend/data-sandbox` resets our side completely.

## Automated connectivity probe (no phone needed)

`WORLD_LIVE=1` unlocks a live test that drives `startGuardianVerification` against the configured
World environment — proving the WASM loads, the rp signature is accepted, and the request-creation
API answers. It needs no scan (it stops before the human step) and is skipped in CI:

```bash
cd back/backend
WORLD_LIVE=1 DOTENV_CONFIG_PATH=.env.sandbox npx vitest run test/world/worldHandshake.live.test.ts
```

Use it first whenever sandbox testing "doesn't work" — it splits "our integration is broken" from
"I'm holding the phone wrong" in ten seconds. It also runs against staging or production
credentials if pointed at a different env file (it only creates a request, never a verification).

## Gotchas

- `.env.sandbox` is gitignored (only the `.example` is tracked). Never put the production
  `WORLD_ACTION` or database in it.
- Use the DEDICATED sandbox actions. Nullifiers are per (human, rp, action) — reusing the prod
  action name would still be a separate environment, but keeping the names distinct makes logs and
  portal analytics unambiguous.
- A used uniqueness action cannot be re-proven by the same identity (World App refuses with
  replay before anything leaves the phone) — that is the sybil protection working, not a bug.
  Reset the sandbox account instead.
- Our staging fixtures (`test/world/fixtures/`) remain valid; `WORLD_ENVIRONMENT=staging` still
  works the same way if a staging capture is ever needed again.
