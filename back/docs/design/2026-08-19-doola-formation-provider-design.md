# doola Formation Provider — real legal bodies, anchored on-chain (B+)

> **Status:** DESIGN, pending review. Grounded in a 3-track code survey (saga machinery / contract +
> controller semantics / API-config-PII patterns, 2026-08-19) plus a live doola-sandbox E2E probe
> (2026-08-14 → 2026-08-19: WY LLC formed, playground-completed, real 12-page Operating Agreement
> PDF generated from our data and downloaded).
> **Why:** every entity today carries `ein: "STUB-NOT-FILED"` and a mock 15-line OA. Formation is
> the core product. doola's Partner API (sandbox live for us through mid-Sept; packs $100–150/
> formation in prod) makes it real.
> **Decisions locked (user, 2026-08-19):** formation is **MANDATORY** (initiated at onboarding,
> non-blocking); testnet runs **doola sandbox** (free, DEMO-watermarked docs, honestly labeled);
> credential-less deployments keep the stub; **build B+ now** (bundle-manifest hash anchored
> on-chain, updated through the existing timelock) — no A-then-B staging; **readiness decides the
> launch date, not Sept 16**.

## 0. TL;DR

A `formationProvider` seam is added to the onboarding saga, following the custody-provider pattern
exactly. On onboard, the backend files a real Wyoming LLC through doola's Partner API; progress
arrives via a new HMAC-verified webhook receiver (the first inbound webhook in the codebase) plus a
small recurring sweeper (the first in-API timer). Every material legal change (formation completed,
EIN issued) produces a new version of a canonical **OA bundle manifest** — one JSON committing to
the machine-readable terms doc *and* every legal document's hash *and* the legal facts (EIN,
formation date, filing number). The manifest hash is the on-chain anchor from birth (v1 at
`createEntity`) and is updated through `LegalManager`'s existing timelocked amendment path, relayed
through the NoviController (both selectors already granted, fork-tested). The guardian gets what the
treasury path already has and the OA path lacks: monitoring topics, a scheduled-amendment
notification, and a pending-amendment veto UI. Formation state lives in its own `bridge_legs`-style
sub-saga table — **no new `EntityStatus` values** (7 enforcement points incl. an unalterable SQLite
CHECK; house style is to layer beside the status machine, per ENS + guardian precedents).

## 1. What exists / what's missing (survey receipts)

| Piece | State | Where |
|---|---|---|
| OA mock + hash anchor | live | `src/oa/generator.ts` (render/`computeOaHash`/metadata); hash → `createEntity` arg 7 → `LegalManager.meta.operatingAgreementHash` |
| Legal facts injection point | stub | `src/policy/translator.ts:73-74` — `ein ?? "STUB-NOT-FILED"`, `formationDate = 0` |
| On-chain amendment path | live, **no backend caller** | `LegalManager.sol:131/140/149/155` — schedule (onlyManager, whenActive) / cancel (onlyGuardian) / liftVeto / execute; `scheduledAt`+`vetoed` keyed **by hash**; events `AmendmentScheduled/AmendmentVetoed/VetoLifted/OperatingAgreementUpdated` |
| Controller relay for it | live | both OA selectors in `ControllerSelectors.sol:20-21`, granted at deploy, unpinned; e2e Foundry test `NoviController.t.sol:1246` |
| Adapter/route template | live | treasury pair `arcAdapter.ts:366/381` + `routes/policy.ts` (threads `rec.manager` → `relayTargetFor`) |
| Multi-leg async sub-saga template | live | `bridge_legs` (`db.ts:305-319`) + `bridgeLegRepository` + attempt-bumped deterministic idempotency keys |
| Inbound webhooks | **none** | no receiver, no HMAC helper, no raw-body precedent (Hono raw body IS accessible: `c.req.text()`) |
| Recurring timer in API | **none** | only the monitor process self-reschedules (`monitor/monitor.ts:302-314`); reconcile runs once at boot |
| Monitoring of LegalManager | **none** | proxies unwatched (`monitor/monitor.ts:159-165`), no LM topics (`monitor/events.ts:61-83`); treasury has a guardian-notification rule (`rules.ts:540-576`) — OA has nothing |
| Guardian OA veto UI | **none** | interface ships no LegalManager ABI; `AgentSettings.tsx` is treasury-only |
| PII | **none by design** | World ID zero-PII; only `guardianEmail` (never persisted). Formation legally requires a named responsible party |
| PDF storage/serving | **none** | `documentStore` is utf8-string-only; no download route, no `Content-Disposition` anywhere |

## 2. Provider model & config

Mirrors the Circle group + `canProvisionTurnkey` predicate (`config/env.ts:336-338, 382-389,
514-518`):

```
DOOLA_API_KEY            dk_test_… | dk_live_…       (all-or-nothing with secret)
DOOLA_WEBHOOK_SECRET     from Partner Portal (shown once)
DOOLA_ENVIRONMENT        enum sandbox|production      (default sandbox)
DOOLA_BASE_URL           optional override; default derived from environment
                         (api.test.doola.com | api.doola.com)
FORMATION_REQUIRED       bool; default TRUE when doola is configured
FORMATION_SWEEP_MS       default 60_000
```

- `cfg.doola?: {...}` built all-or-nothing; half-config throws at boot. Both secrets added to
  `redact()`.
- `canFormEntities(cfg)` predicate — single source for the boot gate, `GET /config`
  (`formationAvailable`, `formationRequired`, `formationEnvironment`), and the MCP capability note.
- **Prod invariants** (in the `isProd` block): `FORMATION_REQUIRED=true` without `cfg.doola` →
  refuse boot. Forward invariant (recorded now, enforced when the mainnet network flag exists):
  mainnet chain ⇒ `DOOLA_ENVIRONMENT=production`. We deliberately do NOT tie sandbox-vs-prod to
  `NODE_ENV` — the testnet box runs `NODE_ENV=production` with doola sandbox by design.
- **Honesty invariant (waiver-amber precedent):** `formation.environment` is surfaced on every
  view; sandbox formations render as "Demo formation (sandbox)" — amber, never green — and sandbox
  documents keep their DEMO watermark. No surface may present a sandbox entity as a real company.
- Deployment matrix: doola sandbox (testnet, free) / doola production (mainnet, packs) / absent
  (dev/CI → today's stub, boots fine).

## 3. Data model

**No new `EntityStatus`.** New tables + additive entity columns only (ALTER-if-missing idiom,
`db.ts:340+`).

```sql
-- formation sub-saga, modeled on bridge_legs
CREATE TABLE IF NOT EXISTS formation_requests (
  entity_key   TEXT NOT NULL,            -- entities.idempotency_key
  step         TEXT NOT NULL CHECK (step IN
               ('create_provider','await_filing','fetch_documents','await_ein',
                'anchor_schedule','anchor_execute')),
  state        TEXT NOT NULL CHECK (state IN
               ('pending','submitted','confirmed','failed','abandoned')),
  attempt      INTEGER NOT NULL DEFAULT 0,
  provider_ref TEXT,                     -- doolaCompanyId (create_provider row)
  detail       TEXT,                     -- JSON: filingNumber, ein, manifest version, tx hash…
  created_at   INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity_key, step)
);
CREATE INDEX IF NOT EXISTS idx_formation_state ON formation_requests(state, step);
CREATE INDEX IF NOT EXISTS idx_formation_provider ON formation_requests(provider_ref);

-- webhook dedupe + audit (at-least-once delivery; sweep like world_nonces)
CREATE TABLE IF NOT EXISTS doola_webhook_events (
  event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL,
  provider_ref TEXT, payload TEXT NOT NULL, received_at INTEGER NOT NULL,
  processed_at INTEGER
);

-- controller PII — separate table, NEVER in spec_json / views / transparency / metadata / logs
CREATE TABLE IF NOT EXISTS formation_parties (
  entity_key TEXT PRIMARY KEY,
  legal_first_name TEXT NOT NULL, legal_last_name TEXT NOT NULL,
  email TEXT NOT NULL, phone TEXT,
  line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL, state TEXT NOT NULL,
  postal_code TEXT NOT NULL, country TEXT NOT NULL,   -- ISO-3 (doola convention)
  created_at INTEGER NOT NULL
);
```

- `documents` table (declared, unused — `db.ts:57-63`) gains columns: `entity_key`, `doc_type`,
  `sha256`, `content_type`, `size`, `provider_doc_id`. `DocumentStore` gains
  `putBytes/getBytes` (PDFs; utf8 interface can't carry them).
- `entities` additive columns: `formation_provider` (null = legacy/stub), `formation_environment`,
  `ein_real`, `formation_filed_at`, `formation_filing_number`, `oa_manifest_version` (anchored),
  `oa_manifest_pending_version`. `entities.oa_hash` continues to mirror the **anchored** hash and
  is updated on every `anchor_execute` (survey blocker 6: UI reads DB, never chain).
- PII hygiene: plaintext SQLite v1 (documented risk; box is the trust boundary per S3 interim);
  the `SecretStore` seam is the named path to column encryption later. opsLog lines carry
  `{provider, entityKey, step, state, providerRef}` — never names/addresses/emails
  (`opsLog.ts:9-11` discipline). Frontend never persists PII to localStorage (the
  `guardianPasskey` nulling precedent, `OnboardingFlow.tsx:121`). Erasure path (first in repo):
  `DELETE FROM formation_parties` after doola acknowledges formation-complete is NOT possible —
  responsible-party data must survive for compliance; instead document retention and exclude from
  every projection.

## 4. The OA bundle manifest (B+ core)

Canonical JSON (sorted keys, NFC, LF, trailing newline — same canonical-form rules as the OA doc),
stored as `manifest-<entityKey>-v<n>.json`; **anchor = keccak256(canonical bytes)**.

```jsonc
{
  "schema": "novi/oa-bundle/1",
  "entity": { "name": "...", "jurisdiction": "US-WY", "publicId": "<uuid>" },
  "version": 2,
  "previous": "0x<anchor of v(n-1)>",          // hash-chain; v1: null
  "terms": { "hash": "0x<keccak of oa-<key>-v<n>.md>", "uri": "novi:doc:oa-<key>-v<n>.md" },
  "legal": {                                    // v1: null (pre-formation)
    "provider": "doola", "environment": "sandbox|production",
    "providerCompanyId": "…", "entityType": "LLC", "state": "WY",
    "formationDate": 1755600000, "filingNumber": "…", "ein": "…|null",
    "documents": [
      { "type": "ArticlesOfOrganization", "sha256": "…", "name": "…" },
      { "type": "OperatingAgreement",     "sha256": "…", "name": "…" }
    ]
  }
}
```

- **v1 is anchored at `createEntity`** — the saga's translating step now hashes the v1 manifest
  (terms + `legal: null`) instead of the bare terms doc. Uniform format from birth; the stub
  deployment simply never advances past v1.
- **Every material legal change appends a version and anchors it**: v2 on
  formation-completed + documents (formationDate, filingNumber, doc hashes), v3 on EIN issued.
  Sequential amendments are safe: `scheduledAt` is keyed by hash, and each execute overwrites
  `meta.operatingAgreementHash`. In sandbox both fire minutes apart → every test onboarding
  exercises the amendment path twice.
- **On-chain `meta.ein` / `meta.formationDate` are frozen at initialize** (survey blocker 1: only
  the OA hash has a mutation path; read by nothing on-chain). Decision: the **manifest is the
  canonical commitment**; new entities are created with `ein: ""`, `formationDate: 0`, documented
  as superseded-by-manifest. *Considered & rejected:* adding a timelocked
  `updateLegalMetadata` setter to the mainnet factory — new audited surface days before a freeze,
  duplicating what the manifest already commits to.
- Documents themselves stay private (guardian-downloadable); the manifest carries only hashes +
  types, so publishing it (public metadata layering) leaks no content. Anyone holding a document
  can verify it against the anchored manifest: **that is B+**.

## 5. Saga integration

Custody-pattern seams on `OnboardingDeps`: `formation?: { client: DoolaClient, required: boolean,
environment: … }`. Resolution rule mirrors custody (`onboarding.ts:116-118`): persisted
`formation_provider` wins; fresh records take the deployment's mode. Availability gates at all
three doors (REST `onboard.ts:32-38` slot, MCP `server.ts:489-491` mirror-order comment, legacy
`onboarding/server.ts`) with messages single-sourced in `src/formation.ts`
(`custodyUnavailableMessage` pattern).

**In-saga (fast) step — `create_provider`,** inserted after step 5 (bind) so on-chain identity is
never delayed by doola latency: create doola customer (from `formation_parties`) + company
(WY LLC; `registeredAgent`-provided addresses by default — doola's Sheridan address solves
agent-has-no-address; ISO-3 country codes). All `formation_requests` rows created up-front in one
transaction (bridge pattern) so "in flight?" is one indexed query. Crash-window rule (the
`createWindow` test style): persist `provider_ref` **before** confirming — resume **adopts** the
doola company, never re-files. Idempotency: `Idempotency-Key: formation:<entityKey>:<step>:<attempt>`,
attempt bumped on terminal provider failure (burned-key invariant, `circleJobOps` convention).

**Event-driven steps** (webhook/sweeper, under `withKeyedLock(entityKey)`):

| Trigger | Step advanced | Action |
|---|---|---|
| `company_formation_completed` | `await_filing` → confirmed | record formationDate/filingNumber |
| `document_*_uploaded` | `fetch_documents` | GET download URL → `putBytes` → sha256 → `documents` row |
| filing + docs both confirmed | `anchor_schedule` (v2) | build manifest v2 → persist doc+hash → on-chain schedule |
| `company_ein_issued` | `await_ein` → confirmed | persist `ein_real` → manifest v3 → `anchor_schedule` (v3) |
| timelock elapsed (sweeper) | `anchor_execute` | on-chain execute → update `entities.oa_hash` + `oa_manifest_version` |
| `company_formation_failed` | all → failed | surface + ops alert; manual re-file path (runbook) |
| required-action webhooks | — | persist + surface in dashboard (resolve via existing doola endpoint) |

**Formation does not gate `bound`/`funded`** — the entity is fully usable while formation runs
("initiated, not blocking"). `formationStatus` is a **derived read-time projection** from
`formation_requests` (the ENS/guardian layering precedent): `in_progress | filed | complete |
failed | vetoed | none(stub)`.

## 6. Webhook receiver (new surface — the security-critical piece)

`POST /webhooks/doola`, mounted in the **public** block (`app.ts:135` slot) behind an
`if (deps.doola)` gate; hits the backend origin directly (the Vercel proxy strips unknown headers
— portal is configured with `https://api.novicorpus.com/webhooks/doola`).

Handler contract, in order:
1. `raw = await c.req.text()` **before** any JSON parse (Hono raw-body rule).
2. HMAC-SHA256(raw, `DOOLA_WEBHOOK_SECRET`) vs `X-Doola-Signature` (case-insensitive header) via
   `crypto.timingSafeEqual` on equal-length buffers. Mismatch → uniform `401` with a constant
   body; no existence oracle, log only a truncated signature prefix.
3. Parse envelope `{eventId, eventName, eventPayload, timestamp}`. Reject `timestamp` older than
   48h (replay bound; doola retries span 24h — 48h gives slack without an open replay window).
4. Dedupe: `INSERT OR IGNORE INTO doola_webhook_events(event_id …)`; conflict → `200` immediately
   (at-least-once contract).
5. **Ack fast, work after**: return `200` once the event row is persisted; processing (§5 table)
   runs as a background task under `withKeyedLock(entityKey)` (runner `pending[]` pattern so
   `settled()` covers it in tests/shutdown). A processing failure leaves `processed_at` NULL —
   the sweeper re-drives from the persisted row, so doola's 5-retry/auto-disable policy is never
   our recovery mechanism.
6. Unknown `eventName` / unknown `provider_ref`: persist, `200`, WARN — never `4xx`/`5xx` (their
   endpoint-disable policy punishes non-2xx; an unmapped event must not take the receiver down).
7. Flood control: the endpoint does only (1)–(4) synchronously (one INSERT); dedupe rows swept
   after 30d with the amortised `worldStore.sweepNonces` pattern.

Ops runbook additions: portal webhook config per environment, secret rotation (portal re-issue →
env update → restart; brief overlap window documented), re-enable procedure if doola auto-disables
the endpoint.

## 7. The anchor sub-saga (on-chain rules, from the contract survey)

Adapter: `scheduleOperatingAgreementUpdate(proxy, newHash, agentManager)` /
`executeOperatingAgreementUpdate(proxy, newHash, agentManager)` — copied from the treasury pair
(`arcAdapter.ts:366-393`), `abi: legalManagerAbi`, target `rec.proxy`, via
`sendManagerCallConfirmed` → per-agent controller routing (`relayTargetFor(rec.manager)`); relay
errors decode through the existing `relayRevertError` (covers `NotManager/Vetoed/TooEarly/
NotAuthorized/TargetNotBound`). Reads added: `scheduledAt(hash)`, `vetoed(hash)`,
`amendmentDelay()`.

Hard rules (each maps to a survey finding):
- **Schedule only when `scheduledAt(hash) == 0`.** LegalManager re-schedule silently RESETS the
  clock (no `AlreadyScheduled` guard, unlike the treasury) — a naive retry loop would keep the
  amendment permanently unexecutable. The read-first discipline also makes schedule idempotent
  across crashes.
- **Hash is final before broadcast.** There is NO manager-side cancel — only the guardian can
  cancel, and that permanently blacklists the hash until `liftVeto`. Therefore: manifest doc is
  written to the doc store, re-read, re-hashed, and byte-compared **before** the schedule tx;
  `anchor_schedule.detail` records the hash it committed to.
- **`vetoed(hash) == true`** → the sub-saga parks in state `failed/vetoed`, surfaces to guardian +
  tenant, and never auto-reschedules that hash (a changed manifest → new version → new hash is the
  only path forward). Guardian `liftVeto` is respected on the next sweep.
- **`whenActive` precheck** via existing `arcAdapter.legalStatus(proxy)` — dissolution in flight
  parks the sub-saga (schedule and execute would revert `NotActive`).
- **Execute** when `now ≥ scheduledAt(hash)` (sweeper): after confirm, in one repo transaction
  update `entities.oa_hash`, `oa_manifest_version`, `recordEvent`. Documents are **versioned,
  never overwritten** (`oa-<key>-v<n>.md`, `manifest-<key>-v<n>.json`) — the metadata route keeps
  serving the stored JSON and layers `formation` status at serve time (ENS/World layering
  precedent, `metadata.ts:33-67`); `metadataURI` on-chain never changes.
- Relayed path takes standard `estimateGas` (no explicit-gas constant — that's only for
  near-full-balance USDC transfers on Arc).

**Sweeper** (first recurring loop in the API process; `monitor.ts:302-314` template — guarded
self-rescheduling `setTimeout`, SIGTERM stop, `FORMATION_SWEEP_MS`): drives `anchor_execute` when
timelocks elapse (no webhook exists for "the delay passed"), re-drives unprocessed webhook rows,
retries transient `failed` rows (attempt < max), and daily-polls doola `GET /companies/{id}` for
rows stuck > 24h in `await_*` (webhook-loss fallback). Every action idempotent + keyed-locked, so
sweeper/webhook/boot-reconcile racing is safe.

## 8. Guardian surface + monitoring (launch requirements, parity with treasury)

- **Monitoring** (`back/backend/src/monitor/`): add entity `proxy` addresses to the watched set +
  a `byProxy` index; add topics `AmendmentScheduled`, `AmendmentVetoed`, `VetoLifted`,
  `OperatingAgreementUpdated`; new rules: `legal_amendment_scheduled` (INFO; page if the scheduled
  hash ≠ the backend's recorded pending manifest hash — an unexpected amendment is the compromise
  signal), `legal_amendment_executed`, and a **guardian notification** twin of
  `rules.ts:540-576` telling the guardian the veto deadline and the `cancelOperatingAgreementUpdate`
  call. Runbook `controller-monitoring.md` updated (its "no LegalManager alerting" gap closes).
- **Guardian UI**: ship the minimal LegalManager ABI to the interface (first time); on
  `AgentSettings.tsx` (beside the treasury pending-policy card): pending-amendment card — pending
  manifest version, diff summary (which legal facts changed), executable-at countdown, **Veto**
  button (`cancelOperatingAgreementUpdate(newHash)`), plus `liftVeto`. The dashboard OA row shows
  anchored version + "update pending" chip.
- **Tenant/wizard surface**: formation status card on the agent page (doola service sub-statuses →
  human phrasing, compliance-calendar feed later); new wizard phase `legal-identity` between
  `guardian` and `custody` (PHASES array + validateConfig extension; PII excluded from
  localStorage persistence); required-actions surfaced with resolve flow.
- **Views**: `formation` block added in `api/views.ts` `toEntityView` (single choke point → REST +
  MCP + dashboard); `GET /entities/:id/documents/:docId` (auth-inherited mount, ownership check
  idiom, `Content-Disposition` + `nosniff` + `private, no-store`; proxy out-header list gains
  `content-disposition`). EIN appears in authenticated views only — **never** in `/transparency`
  (its "deliberately NOT included" list gains formation PII) or public metadata (existing
  decision).

## 9. Non-US founders (design now, validate in prod)

`formation_parties.country` is ISO-3 and free; a non-US responsible party without SSN triggers
doola's SS-4 signature flow: `signatureRequirements` on the company + signature-session endpoint +
`signature_ss4_*` webhooks are mapped into `formation_requests.detail` and surfaced as a
required-action ("sign your SS-4"). Expedited-EIN variant exposed as a config default
(`requestedServices: [{service: EinCreation, variant: Expedite}]`). **Sandbox cannot simulate this
flow** — it ships behind the same code paths but its live validation is an explicit
production-rollout checklist item, with EIN-pending (4–6 weeks) rendered honestly (manifest v2
anchors without EIN; v3 lands when the IRS does).

## 10. Threat model

- **Webhook forgery/replay** → HMAC + timing-safe compare + eventId dedupe + 48h timestamp bound;
  secret env-only, redacted, rotatable. The receiver mutates nothing directly — it only persists
  and lets keyed-locked processors advance persisted state, so even a replayed-valid event is a
  no-op (idempotent steps).
- **doola compromise / poisoned documents** → documents are hashed at fetch and pinned in the
  manifest **we** author; a later swap cannot match the anchored hash. Download URLs are used
  once, must parse as HTTPS, and responses are size-capped (16MB) + content-type checked before
  `putBytes`. doola never touches funds; blast radius = wrong paperwork, guardian-vetoable at the
  anchor.
- **Backend compromise scheduling a malicious OA hash** → same trust class as the treasury path:
  vault timelock (≥1h, default 24h) + guardian veto + the new monitoring rule (scheduled hash ≠
  recorded pending manifest = page). This is precisely why guardian notification is a launch
  requirement, not polish.
- **Wrong hash, honest bug** → no manager cancel exists; mitigated by the write-read-rehash-
  compare discipline before broadcast + versioned append-only manifests (a bad vN is abandoned by
  anchoring a corrected v(N+1); the bad hash simply expires unexecuted — note it stays executable
  forever on-chain, so monitoring flags any execute of a non-current version).
- **PII exposure** → separate table, excluded from spec_json/views/transparency/metadata/opsLog/
  localStorage; plaintext-at-rest accepted v1 (box = trust boundary, S3-interim posture) with
  `SecretStore` as the named encryption path; retention documented.
- **Sandbox-as-real deception** → environment surfaced end-to-end, amber labeling invariant,
  forward boot invariant (mainnet ⇒ doola production).

## 11. Test plan

- **Unit (vitest, `:memory:` + `migrate`)**: `onboardingFormation.test.ts` in the
  `onboardingCustody.test.ts` idiom — `makeFormationSeams()` factory + poison seams ("stub path
  never calls doola"), crash-window "resume ADOPTS provider_ref, never re-files"; manifest
  canonicalization golden tests (byte-stable across key order/unicode); webhook handler: bad sig
  401, dup eventId single-processing, unknown event 200-warn, timestamp bound; sweeper: clock
  advance → execute exactly once; anchor rules: schedule-only-when-zero, vetoed parks, whenActive
  parks.
- **Adapter**: extend `arcAdapter.relay.test.ts` — OA pair relays for controller agents, direct
  for legacy, `Vetoed()`/`TooEarly()` decode.
- **Foundry additions**: assert the reschedule-resets-clock behavior (documented, untested today)
  and an amendment on an agent whose `amendmentDelay` differs from the treasury delay.
- **Integration (anvil)**: full B+ loop against the real stack — create (v1 anchored) → fake
  formation events → v2 schedule → warp past delay → execute → `meta.operatingAgreementHash ==
  keccak(manifest v2)`; guardian veto branch.
- **Sandbox E2E runbook** (the Sept-15 demo script): onboard on Arc testnet with doola sandbox →
  playground formation-complete + EIN-complete → real webhooks → real DEMO OA PDF stored + hashed
  → v2/v3 anchored on-chain → dashboard shows the full trail; repeat-run idempotence (playground
  re-fires webhooks — dedupe proves itself).
- **Config tests**: all-or-nothing pair, prod invariants, `canFormEntities` drift guard.

## 12. Rollout

1. **PR 1 — foundations**: config group + tables + doola client + manifest v1 anchored at create
   (stub deployments: v1 = today's behavior, uniform format). Behavior-neutral for existing rows
   (null `formation_provider` = legacy, custody-pattern rule).
2. **PR 2 — formation loop**: create_provider step + webhook receiver + sweeper + document
   storage/download + views/status projection.
3. **PR 3 — anchor loop (B+)**: adapter pair + anchor sub-saga + monitoring topics/rules +
   guardian notification.
4. **PR 4 — surfaces**: wizard legal-identity phase + guardian veto UI + dashboard cards +
   frontend agreement display switched to the real OA (the cosmetic `AgreementStep` text goes
   away — divergence risk closed).
5. Testnet prod deploy + full sandbox E2E on the box; Sept 15 demo; mainnet flip = env swap
   (`DOOLA_ENVIRONMENT=production`, live key, pack purchased) + prod-checklist for the SS-4 flow.

Legacy rows: 13 testnet + existing prod agents keep `formation_provider = null` (stub) forever —
no backfill; formation is offered on new onboardings only.

## 13. Open questions

1. **DAO supplement via doola** — pending from Halyna. If yes: the Articles arrive DAO-flavored,
   zero design change (documents are opaque hashed bytes to us). If no: standard WY LLC now
   (counsel question stands), DAO-supplement filings via a registered agent as a later manual
   path. Does not block any PR above.
2. Whether `formation_requests` needs a `superseded` state for manifest versions vs deriving from
   `oa_manifest_pending_version` (leaning derive; decide in PR 3 review).
3. Guardian notification transport (the treasury twin currently logs/webhooks to ops — a direct
   guardian email/push is a product gap shared with the treasury path; out of scope here, tracked
   as the shared follow-up the controller design already flagged).
