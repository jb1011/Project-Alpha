# Per-Agent Vault — Live Provisioning Test (passkey-capture tool) — Design

**Date:** 2026-06-20
**Status:** Approved (brainstorming) → ready for implementation plan
**Related:** [2026-06-19-per-agent-turnkey-vault-design.md](2026-06-19-per-agent-turnkey-vault-design.md), [../plans/2026-06-19-per-agent-turnkey-vault-implementation.md](../plans/2026-06-19-per-agent-turnkey-vault-implementation.md)

## Goal

Prove the per-agent Turnkey vault flow works **against the real Turnkey service**, not just against fakes. The 6-task per-agent vault plan is code-complete and green under deterministic tests (fake Turnkey client), but every test injects a mock — no real sub-org has ever been provisioned through `provisionAgentVault`. This is the proof-of-life milestone for the per-agent vault, mirroring the live E2E the legacy shared-key path already passed (agent 656785, 2026-06-16).

The one missing ingredient is a **real WebAuthn passkey attestation**. Turnkey's `provisioner.live.test.ts` is currently a gated stub because it has no real attestation to feed `provisionAgentVault`. This design delivers a small throwaway tool that captures a genuine attestation from a browser, plus the fleshed-out live test that consumes it.

## Scope

**In scope:**
- A throwaway dev tool that captures a real guardian passkey attestation to a local fixture file.
- Fleshing out `backend/test/adapters/turnkey/provisioner.live.test.ts` to provision **one real sub-org** via `provisionAgentVault` and assert the result.

**Out of scope (explicitly):**
- The full `POST /onboard` saga against Arc (provision → mint → bind → fund). The live test exercises **only the provisioner** (`provisionAgentVault`). Decided during brainstorming.
- Any change to `src/` production code. This is purely additive: a `tools/` dir + a test + config plumbing (npm script, `.gitignore`).
- The eventual production frontend (the real onboarding wizard). This tool is a single-purpose key-maker, not that frontend.
- The backup-authenticator feature (Decision 5 in the vault design) — separate follow-up.

## Background / key technical facts (verified 2026-06-20)

- The provisioner's expected shape is `GuardianPasskey = { authenticatorName?, challenge, attestation: { credentialId, clientDataJson, attestationObject, transports[] } }` (`backend/src/adapters/turnkey/provisioner.ts`).
- Turnkey's `getWebAuthnAttestation` (`@turnkey/http`, already an installed transitive dep) emits **exactly** that `attestation` shape: it base64url-encodes `rawId`/`clientDataJSON`/`attestationObject` and maps `transports` to the `AUTHENTICATOR_TRANSPORT_*` enum. Using it removes all hand-rolled-encoding risk.
- **The attestation is replayable.** Sub-org creation is a WebAuthn *registration* (attestation) flow. Turnkey verifies internal consistency (the challenge embedded in `clientDataJSON` matches the `challenge` field) and signature validity — **not** freshness against a server-issued challenge. So "capture once → feed into the test later" is valid; the fixture is portable.
- `rpId: "localhost"` is accepted at creation time. The credential is registered under whatever rpId/origin it was created with; that only constrains where the guardian could later *authenticate*, which the provisioner-only test does not exercise.
- WebAuthn requires a **secure context**, i.e. the page must be served from `http://localhost` (a `file://` page cannot call `navigator.credentials.create()`). A tiny localhost server therefore has to exist regardless — which makes one-click auto-capture nearly free.
- The page is **authenticator-agnostic**: Windows Hello, a security key, or **Chrome DevTools' virtual authenticator** all satisfy it identically. On WSL2 the virtual authenticator needs zero hardware setup and is the recommended path.
- Tooling already present: `esbuild` 0.28.0 (`node_modules/.bin/esbuild`), `@hono/node-server`, and Turnkey's `webauthn-json`/`base64url` helpers.

## Approach decision

**Bundle Turnkey's official `getWebAuthnAttestation` with esbuild** for the browser, rather than hand-rolling vanilla WebAuthn + base64url in a single HTML file.

- *Chosen:* esbuild bundles `@turnkey/http`'s verified encoder → zero attestation-encoding risk; esbuild is already installed so the build is a single command in the npm script. Slightly more machinery (a build step + a bundle file).
- *Rejected:* hand-rolled vanilla single-HTML (no build step) — lighter, but reintroduces the exact base64url + transport-enum encoding risk we can eliminate for free. Not worth it for attestation bytes.

## Architecture

One throwaway dev tool (`backend/tools/passkey-capture/`) plus the fleshed-out gated test. Nothing in `src/` changes.

```
Browser (Windows Hello / security key / Chrome virtual authenticator)
   │  click "Create guardian passkey"
   ▼
capture.entry.ts  ──getWebAuthnAttestation()──►  { challenge, attestation }
   │  POST /capture
   ▼
server.ts (Hono on http://localhost:8899)  ──writes──►  test/fixtures/guardian-passkey.local.json  (gitignored)
                                                              │
                                       LIVE_TURNKEY=1 vitest  │ reads
                                                              ▼
                                   provisioner.live.test.ts ──provisionAgentVault()──► real Turnkey sub-org
```

### Components (all new / additive)

1. **`backend/tools/passkey-capture/server.ts`** — a tiny Hono app served with `@hono/node-server` on `http://localhost:8899` (port overridable via `PORT`).
   - `GET /` → serves `index.html`.
   - `GET /capture.js` → serves the esbuild bundle.
   - `POST /capture` → validates the body shape, writes the fixture, returns `{ ok: true, path }`.
   - What it does / how to use / depends on: serves the page and persists a posted attestation; used via `npm run passkey:capture`; depends on `@hono/node-server`, `hono`, Node `fs`.

2. **`backend/tools/passkey-capture/index.html`** — minimal page: one "Create guardian passkey" button + a status line. Loads `/capture.js` as a module.

3. **`backend/tools/passkey-capture/capture.entry.ts`** — the browser entry (esbuild-bundled to `capture.js`). On click: generate a random challenge buffer + random user id, call `getWebAuthnAttestation({ publicKey: { rp: { id: "localhost", name: "Agent Vault Guardian" }, challenge, pubKeyCredParams: [ES256(-7), RS256(-257)], user: {...}, authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" }, timeout } })`, then `POST /capture` with `{ challenge: base64url(challenge), attestation }`. Show success/error in the status line.

4. **`npm run passkey:capture`** (in `backend/package.json`) → `esbuild tools/passkey-capture/capture.entry.ts --bundle --format=esm --outfile=tools/passkey-capture/capture.js && tsx tools/passkey-capture/server.ts`.

5. **`backend/test/adapters/turnkey/provisioner.live.test.ts`** — replace the stub. Run only when **all** of: `LIVE_TURNKEY === "1"`, the fixture file exists, and `cfg.turnkey.delegatedApiPublicKey` is set; otherwise `describe.skip` with a message pointing at `npm run passkey:capture`.

## Data flow & contracts

### Fixture contract — `backend/test/fixtures/guardian-passkey.local.json`

Exactly a `GuardianPasskey` (minus the optional `authenticatorName`), so the test feeds it straight through:

```json
{
  "challenge": "<base64url>",
  "attestation": {
    "credentialId": "<base64url>",
    "clientDataJson": "<base64url>",
    "attestationObject": "<base64url>",
    "transports": ["AUTHENTICATOR_TRANSPORT_INTERNAL"]
  }
}
```

`POST /capture` accepts a body of this shape and writes it verbatim. It rejects (400) if `challenge` or any of the four `attestation` fields are missing/wrong-typed.

### Live test behaviour

```
const cfg  = loadConfig();
const deps = buildTurnkeyProvisionDeps(cfg);                 // real parent + delegated clients (Task 4)
const fix  = JSON.parse(read("test/fixtures/guardian-passkey.local.json"));
const ids  = await provisionAgentVault(deps, {
  subOrgName: `live-test agent vault ${Date.now()}`,         // unique per run
  guardianPasskey: fix,
  delegatedApiPublicKey: cfg.turnkey.delegatedApiPublicKey,
});
```

**Assertions:**
- `ids.subOrgId`, `ids.walletId`, `ids.guardianUserId`, `ids.delegatedUserId` are non-empty strings.
- `ids.operator` matches `/^0x[0-9a-fA-F]{40}$/`.
- Read-back (belt-and-suspenders): `deps.makeDelegatedClient(ids.subOrgId).getWallets({ organizationId: ids.subOrgId })` returns the wallet, and its account address equals `ids.operator`.

A successful `provisionAgentVault` return already implies all three Turnkey steps ran (createSubOrganization → createPolicy → updateRootQuorum each throw on rejection), so the read-back is confirmation, not the primary proof. Read-back of the policy text and the guardian-only root quorum is a **stretch goal**, deferred because the exact read API is unconfirmed; the plan may add it if the getter is straightforward.

## Error handling

- **Browser:** WebAuthn unsupported, user-cancelled, or no authenticator → caught, shown in the status line, no POST issued. A failed `POST /capture` → shown in the status line.
- **Server:** `POST /capture` validates the shape before writing; malformed → 400 with a clear message; never writes a partial fixture.
- **Test:** skips loudly (not silently) with remediation text when gated off / fixture missing / delegated key absent.

## Testing strategy

- **Deterministic (always-on):** a small unit test for `POST /capture` using Hono's `app.request` (no browser) — asserts a valid body is written and a malformed body is rejected 400. The browser entry's attestation encoding is delegated to `@turnkey/http` (trusted, not re-tested).
- **Live (opt-in):** `provisioner.live.test.ts`, gated on `LIVE_TURNKEY=1` + fixture presence. This is the deliverable.
- The full existing deterministic suite must stay green; `src/` is untouched.

## Known trade-offs (flagged, not hidden)

- **Throwaway sub-orgs accumulate.** Each live run creates a real Turnkey sub-org named `live-test agent vault <timestamp>` that the Turnkey API cannot delete — they pile up under the parent org. Acceptable on a metered free tier (a handful of runs); the distinct name makes them identifiable. Documented in the tool's usage notes.
- **Manual step remains.** Capturing the passkey is a human browser action by design (it must be — a real attestation requires a real authenticator gesture). The test is automated; the fixture generation is not, and that is intentional.

## Files

| File | Change |
|---|---|
| `backend/tools/passkey-capture/server.ts` | new — Hono capture server |
| `backend/tools/passkey-capture/index.html` | new — capture page |
| `backend/tools/passkey-capture/capture.entry.ts` | new — browser entry (bundled) |
| `backend/tools/passkey-capture/capture.js` | new build artifact — **gitignored** |
| `backend/test/adapters/turnkey/provisioner.live.test.ts` | modify — replace stub with real provision + assertions |
| `backend/test/tools/passkey-capture.server.test.ts` | new — unit test for `POST /capture` validation |
| `backend/test/fixtures/guardian-passkey.local.json` | runtime artifact — **gitignored** |
| `backend/package.json` | modify — add `passkey:capture` script |
| `backend/.gitignore` (or repo root) | modify — ignore `test/fixtures/*.local.json` and `tools/passkey-capture/capture.js` |

## Definition of done

- `npm run passkey:capture` serves the page on `http://localhost:8899`; clicking the button creates a real passkey and writes `guardian-passkey.local.json`.
- `LIVE_TURNKEY=1 npx vitest run test/adapters/turnkey/provisioner.live.test.ts` provisions one real sub-org and passes all assertions.
- The deterministic suite (`npx vitest run --exclude '**/*.live.test.ts'`) stays green; `tsc` + `biome` clean.
- The fixture and the bundle are gitignored; no secrets or run-specific artifacts are committed.
