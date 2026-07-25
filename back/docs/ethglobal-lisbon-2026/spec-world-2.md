# World Deepening — spec 2 (W7 attestation step-up, W8 no-World-ID path)

Continues `spec-world.md` (W0–W6, all shipped + live). Written 2026-07-25 evening, after:
consolidation to prod, `WORLD_REQUIRE_GUARDIAN=true` **live on prod**, The Graph **descoped**
by user decision. Build agent: Opus. Everything here is additive and config-gated — prod must
be unable to break mid-hackathon by merging this.

---

## Context & verified facts (checked against installed code, not docs)

- Installed `@worldcoin/idkit` re-exports **`identityCheck`** from idkit-core. Signature
  (idkit-core `dist/index.d.ts:728`):
  ```ts
  identityCheck(params: { attributes: IdentityAttribute[]; legacy_signal?: string }): IdentityCheckPreset
  // IdentityCheckPreset = { type: "IdentityCheck", attributes, legacy_signal? }  — "requires World ID 4.0-compatible clients"
  ```
  ⚠ It takes **`legacy_signal`**, not `signal` (unlike `proofOfHuman({signal})`).
- `IdentityAttribute` (d.ts:284): `document_type ("passport"|"eid"|"mnc") | document_number |
  issuing_country | full_name | minimum_age (number) | nationality`.
- **`makeRpContext` signs over `cfg.action`** (`guardianGate.ts:37-44` → `signRequest({action})`).
  A second action ⇒ the rp_context must be minted **for that action** or World rejects the request
  signature. Refactor required (W7.1).
- `verifyProof` (`guardianGate.ts:132-196`) forwards the IDKit result byte-for-byte to
  `POST developer.world.org/api/v4/verify/{rp_id}`, then reads only `results[].identifier`
  (credential tier) + `nullifier`. **Attested attributes are currently discarded.**
- `ACCEPTED_CREDENTIALS = {proof_of_human, orb, passport, secure_document, document}` — the
  NFC-passport tier is already accepted for baseline guardianship. Nothing in W7 changes this.
- Store: `guardian_verifications` PK `(nullifier, action)`; one-tenant-per-nullifier enforced in
  `recordVerification` (`worldStore.ts:66-68`). All migrations to date are `CREATE TABLE IF NOT
  EXISTS` — keep that property.
- World's Identity Check demo states the acceptance rule: *"Backend accepts when proof verifies
  and `identity_attested` is true."* Exact v4 response field names for attribute results are
  **UNVERIFIED** — see the verify-first gate in W7.2.
- Simulator (`simulator.orb.engineer`, per MrSauron): staging-only, explicitly supports testing
  Identity Attestations. Never usable against prod (and must never be).

## Decisions (locked with user)

1. **Step-up, never a gate.** Baseline guardianship stays exactly as shipped: unique human via
   Orb **or** NFC passport, nullifier only. Attestation requires a document credential that
   Orb-only humans and ~12-country passport coverage make scarce — gating on it would shrink the
   platform and contradict our own privacy copy.
2. **Request `minimum_age: 18` + `issuing_country` only.** Never `full_name`,
   `document_number`, `nationality`, `document_type`. We prove facts, we don't collect identity.
3. **What it unlocks: `formationReady`** — a guardian-level status meaning "this human clears
   the real-filing bar" (adult + known jurisdiction), distinct from demo-grade guardianship.
   Served on `/world-id/me`, rendered on `/guardian` and the onboarding step. `issuing_country`
   is **server-side only** — never in public metadata, ENS records, or entity views.
4. **Separate World action** for the step-up (`WORLD_ATTEST_ACTION`, suggested name
   `guardian-attest`), because nullifiers and one-proof-per-human are per-action. Feature is OFF
   unless the env var is set ⇒ merging is a prod no-op until we flip it.
5. Existing guardians stay valid untouched; attestation is a second, optional row — no
   re-verification wall, no schema change to `guardian_verifications`.

---

## W7 — Identity Check step-up ("formation-ready")

### W7.0 — Portal prerequisite (USER, ~5 min)
Create action **`guardian-attest`** in the World Developer Portal (same app/rp as `guardian`).
If the portal shows an Identity Check / document policy toggle for the action, enable it —
capture what you see; whether attestations need per-action enablement is an open question (§Open
questions). No new keys: reuse `WORLD_APP_ID` / `WORLD_RP_ID` / `WORLD_RP_SIGNING_KEY`.

### W7.1 — rp_context per action + config (backend)
- `makeRpContext(cfg, actionOverride?)` — signs over `actionOverride ?? cfg.action`. Existing
  callers unchanged.
- env.ts: `WORLD_ATTEST_ACTION` (optional string; absent ⇒ whole W7 surface unmounted),
  `WORLD_ATTEST_MIN_AGE` (int, default 18). Both inside the existing `world?:` config block.
  **No new required vars.**

### W7.2 — `verifyAttestation()` (backend) — ⚠ VERIFY-FIRST
Sibling of `verifyProof` in `guardianGate.ts` (don't overload it — the acceptance rule differs):
forward payload as-is to the same `/api/v4/verify/{rp_id}`; require `success` **and** the
attested-attributes acceptance (`identity_attested: true` per World's demo — confirm the exact
field). Extract: nullifier (decimal-normalised, same as `verifyProof`), satisfied `minimum_age`,
`issuing_country` value, credential tier, `expires_at_min`.

**Gate: before writing the parser, run one real staging round-trip via the simulator (or one
real prod scan) and capture the raw verify response into
`test/world/fixtures/attest-verify-response.json`.** The parser is written against that fixture,
not against guessed field names. This is the only genuinely unknown surface in W7 — burn the
uncertainty first, exactly like the ENS digest byte-match in T3.

### W7.3 — Store (backend)
New table (additive):
```sql
CREATE TABLE IF NOT EXISTS guardian_attestations (
  nullifier       TEXT NOT NULL,   -- attest-action nullifier (≠ guardian nullifier by design)
  action          TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  min_age         INTEGER NOT NULL,        -- threshold proven (e.g. 18), not a birthdate
  issuing_country TEXT NOT NULL,           -- ISO code; SERVER-SIDE ONLY
  credential      TEXT,
  verified_at     INTEGER NOT NULL,
  expires_at_min  INTEGER,
  PRIMARY KEY (nullifier, action)
);
CREATE INDEX IF NOT EXISTS idx_guardian_attestations_tenant ON guardian_attestations (tenant_id, action);
```
Store methods mirror verifications: `recordAttestation` (refuse if nullifier already bound to a
different tenant — same one-human-one-account rule), `findAttestationByTenant`.

### W7.4 — Routes (backend)
- `GET /world-id/attest/context` (authed): 404 when `WORLD_ATTEST_ACTION` unset (UI hides, same
  convention as the rest of the World surface); **403 `guardian_not_verified` unless the tenant
  already has a guardian verification** — it's a step-up, not an entry. Returns
  `{appId, action: attestAction, environment, signal: tenantId, rpContext: makeRpContext(cfg, attestAction), minAge}`.
- `POST /world-id/attest/verify` (authed): same precondition; `verifyAttestation` → tenant-bind
  check → `recordAttestation` → returns the attestation view.
- `GET /world-id/me` additions:
  `attestation?: { minAge, issuingCountry, verifiedAt }` and
  `formationReady: boolean` (= verified && attestation present && not expired). Country is fine
  here — `/me` is the owner reading their own record.

### W7.5 — UI (interface)
- `/guardian` (GuardianRecord): a **step-up panel** under the ledger strip, only when
  `verified && !attestation` and attest is configured (context 404 ⇒ hidden — probe via `me`
  gaining an `attestAvailable` flag rather than a throwaway request). Copy direction: keep the
  instrument-of-record voice — "Formation-ready" as the third state of the record, not a promo
  banner. When attested: ledger gains a `Formation-ready` cell (✓, country shown to the owner,
  "adult, document-attested"); the seal is NOT redrawn (one identity, one mark).
- Widget invocation: same `IDKitRequestWidget`, `preset={identityCheck({ attributes: [
  {type:"minimum_age", value: ctx.minAge}, {type:"issuing_country", value: ""} ], legacy_signal:
  ctx.signal })}` — ⚠ **verify at build time** how an *enumerated/requested* (vs constrained)
  attribute is expressed; `{type:"issuing_country"}` may need the `enumerate()` helper the SDK
  exports rather than an empty value. Part of the W7.2 fixture round-trip.
- Onboarding GuardianStep: one line only when verified-but-unattested and feature on — "Optional:
  prove formation-readiness on the guardian page." **No widget in the wizard** — don't tax the
  funnel with a second scan.
- `WorldErrorNote`: attestation-specific mappings — `credential_unavailable` in attest context ⇒
  "You need a document credential: tap an NFC passport in World App (Settings → World ID)";
  `nullifier_replayed` ⇒ already-attested (treat as success: refetch `me`).

### W7.6 — Tests
- `verifyAttestation` against the captured fixture (accept + reject + missing-attribute cases).
- Route tests: 404-when-unset, 403-step-up-precondition, tenant-bind refusal, `me` shape with and
  without attestation, expiry ⇒ `formationReady:false`.
- Suite target: green on top of current 605; no existing test modified except `me`-shape ones.

### W7-S — Stretch (only if W8 + submission material are done)
ENS text record `guardian-attested` = `"1"` iff formationReady — boolean only, no country.
~10 lines in `ensGateway.ts` textFor + 1 test. Trust-stack demo beat: the attestation shows up
in a name lookup any ENS client can do.

---

## W8 — The no-World-ID path

Enforcement is ON in prod: an unverified visitor in the wizard now has **no skip**. Today the
step shows a Verify button and nothing else; someone without World App who scans the QR lands on
World's generic "Get World App" marketing page — outside our funnel, with no explanation of why
and no way back. This screen is now the difference between a dead end and a conversion.

### W8.1 — `GetWorldIdHelp` (shared component, interface)
One component used by GuardianStep (unverified state) and GuardianRecord (unverified state).
Content, in the record voice, ~120 words max:
- **Why** (one line): a Wyoming DAO LLC needs a real natural person — that's law, not product.
- **Two routes in**:
  1. **NFC passport in World App** — no Orb needed. Download World App → World ID → add
     passport credential (tap phone to passport). Works for ~12 countries incl. US/UK — link
     the support article rather than hardcoding the list.
  2. **Find an Orb** — link `world.org/find-orb`; note "there are Orbs at this venue" is
     demo-day copy, keep it out of the shipped default.
- **The way back**: "Once World App shows your World ID, return here and tap Verify — this page
  keeps your place." (True: session + wizard state persist; verify by W8.3 test.)
Presentation: collapsed disclosure ("Don't have World ID?") under the Verify button — present,
not shouting.

### W8.2 — Required-state honesty (interface)
In GuardianStep when `required && !verified`: the current bullet copy stays, but drop the
"Optional for now" line (it's now false — it only renders when `!required`, verify that branch)
and ensure the help disclosure is ALWAYS visible in this state, not only after an error.

### W8.3 — Tests / passes
- Component render tests for both states of GuardianStep (`required` true/false) — no-skip
  assertion for required (this branch has never been walked: user's own account is verified).
- Manual pass: fresh wallet on prod → wizard blocks at 01 with help visible → (if a second human
  is available) full conversion; else verify the World App download → return → place-kept loop
  manually.

---

## Non-goals (explicit)
- No `full_name` / `document_number` / `nationality` — ever, in any store or request.
- No gate anywhere on attestation; `WORLD_REQUIRE_GUARDIAN` semantics untouched.
- No Doola API integration tonight — `formationReady` is the hook a real formation flow will
  consume later.
- No Graph work (G2–G7 descoped by user decision).
- No country in public metadata / ENS / entity views (stretch record is boolean only).

## Open questions for the World team (ask MrSauron)
1. Does Identity Check need per-action enablement in the portal, or does any action accept an
   `IdentityCheck` preset?
2. Does the new simulator mint **multiple distinct identities** (different nullifiers) — the
   whole value for sybil testing?
3. Is `identity_attested` the exact v4 response field, and what does the per-attribute result
   look like? (We'll have the fixture either way — this is confirmation.)
4. One-attestation-per-human-per-action: does `nullifier_replayed` apply to Identity Check
   requests the same way?

## Sequencing for the Opus build session
1. W7.0 (user, portal) → 2. W7.1 (rp_context + config) → 3. **W7.2 fixture round-trip on
   staging via simulator** (or one real scan) — hard gate → 4. W7.2 parser + W7.3 store →
   5. W7.4 routes → 6. W7.6 backend tests → 7. W7.5 UI → 8. W8.1–W8.3 → 9. deploy (env flip on
   VPS is a separate, deliberate step) → 10. W7-S only if time after submission material.

## Demo beat (booth)
Judge with a US/UK passport: verify as guardian (2 min, no Orb queue) → step-up on `/guardian`
(second scan) → record flips to **Formation-ready** → (stretch) `guardian-attested` appears in
a plain ENS lookup of the agent's name. One human, one account, provably adult, provably
jurisdictioned — and we never saw their name.
