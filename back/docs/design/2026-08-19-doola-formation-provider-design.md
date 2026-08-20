# doola Formation Provider — real legal bodies, anchored on-chain (B+)

> **Status:** DESIGN, ADVERSARIALLY AUDITED 2026-08-19 (3 independent passes: fact-check — 65
> claims, 55 confirmed, 9 corrected below; security/robustness — C1/H1-H7/M1-M16 folded in;
> completeness — 25 findings folded in). Combined verdict: **sound to build with the amendments
> in this revision**. Grounded in a 3-track code survey + live doola-sandbox E2E probe
> (2026-08-14→19: WY LLC formed, playground-completed, real 12-page OA PDF generated from our
> data and downloaded).
> **Why:** every entity today carries `ein: "STUB-NOT-FILED"` and a mock 15-line OA. Formation is
> the core product. doola's Partner API (sandbox live for us through mid-Sept; packs $100–150/
> formation in prod) makes it real.
> **Decisions locked (user, 2026-08-19):** formation is **MANDATORY** (initiated at onboarding,
> non-blocking); testnet runs **doola sandbox** (free, DEMO-watermarked docs, honestly labeled);
> credential-less deployments keep the stub; **build B+ now** (bundle-manifest hash anchored
> on-chain, updated through the existing timelock) — no A-then-B staging; **readiness decides the
> launch date, not Sept 16**.

## 0. TL;DR

A `formationProvider` seam is added to the onboarding saga, following the custody-provider pattern.
On onboard, the backend files a real Wyoming LLC through doola's Partner API; progress arrives via
a new HMAC-verified webhook receiver (the first inbound webhook in the codebase — treated strictly
as a **wake-up signal**, never as a source of facts) plus a recurring sweeper (the first in-API
timer). Every material legal change (formation completed, EIN issued) produces a new version of a
canonical **OA bundle manifest** — one RFC-8785-canonical JSON committing to the machine-readable
terms doc, every legal document's hash, the legal facts (EIN, formation date, filing number), and
the on-chain identity (chainId, proxy, agentId). The manifest hash is the on-chain anchor from
birth (v1 at `createEntity`) and is updated through `LegalManager`'s existing timelocked amendment
path, relayed through the NoviController (both selectors already granted, fork-tested at
`NoviController.t.sol:1246`). Anchoring is **strictly monotonic with a single pending version** —
the two rules that close the audit's critical finding. The guardian gets what the treasury path
has and the OA path lacks: monitoring topics, an unconditional scheduled-amendment notification
(WARN+), and a pending-amendment veto UI fed from the guardian's own RPC, never from the backend.
Formation state lives in its own sub-saga tables — **no new `EntityStatus` values** (7 files / 9
enforcement sites incl. an unalterable SQLite CHECK at `db.ts:26`; house style is to layer beside
the status machine, per ENS + guardian precedents).

## 1. What exists / what's missing (survey receipts, fact-checked)

| Piece | State | Where |
|---|---|---|
| OA mock + hash anchor | live | `src/oa/generator.ts`; hash → `createEntity` `args[7]` (0-indexed; 8th Solidity param) → `LegalManager.meta.operatingAgreementHash` |
| Legal facts injection point | stub | `src/policy/translator.ts:73-74` — `ein ?? "STUB-NOT-FILED"`, `formationDate = 0` |
| On-chain amendment path | live, no backend caller | `LegalManager.sol:131/140/149/155` — schedule (onlyManager, whenActive) / cancel (onlyGuardian) / liftVeto / execute; `scheduledAt`+`vetoed` keyed **by hash**; events `AmendmentScheduled/AmendmentVetoed/VetoLifted/OperatingAgreementUpdated`; **execute deletes `scheduledAt[hash]`** (see §7 C1 rules) |
| Controller relay for it | live | both OA selectors in `ControllerSelectors.sol:20-21`, granted at deploy, unpinned; e2e test `NoviController.t.sol:1246` |
| Adapter/route template | live | treasury pair `adapters/arc/arcAdapter.ts:366/381` + `routes/policy.ts` (threads `rec.manager` → `relayTargetFor`) |
| Multi-leg async sub-saga template | live | `bridge_legs` (`db.ts:305-319`) + attempt-bumped deterministic idempotency keys |
| Inbound webhooks | none | no receiver, no HMAC helper; Hono raw body via `c.req.text()`; no body-size or rate-limit middleware anywhere |
| Recurring timer / SIGTERM in API | none | monitor self-reschedules (`monitor/monitor.ts:302-314`); **API process has no signal handlers at all** — this design adds the first |
| Monitoring of LegalManager | none | proxies unwatched (`monitor/monitor.ts:159-165`), no LM topics (`events.ts:61-83`); treasury guardian-notification exists (`rules.ts:554-581`) — OA has nothing; note INFO alerts never leave the box (`alerts.ts:103`) |
| Guardian OA veto UI | none | interface ships only a hand-written `treasuryAbi.ts`; `AgentSettings.tsx` treasury-only |
| PII | none by design | World ID zero-PII; formation legally requires a named responsible party |
| PDF storage/serving | none | `documentStore` utf8-string-only; `FileDocumentStore.put` is bare `writeFileSync` (not atomic); no download route; `data/documents/` NOT in the Litestream backup |
| Onboarding doors | **five**, not three | REST, MCP, legacy `src/onboarding/server.ts` (no auth/World/custody gates, bypasses `claimKey`), `cli create-entity` (separate process, same DB) |

## 2. Provider model & config

```
DOOLA_API_KEY                    dk_test_… | dk_live_…   (all-or-nothing with the two secrets)
DOOLA_WEBHOOK_SECRET             issued/rotated BY DOOLA over email (not self-served in the portal)
DOOLA_WEBHOOK_SECRET_PREVIOUS    optional; both verified timing-safe → zero-downtime rotation
DOOLA_ENVIRONMENT                enum sandbox|production (default sandbox)
DOOLA_BASE_URL                   optional override; default from environment
ARC_NETWORK                      enum testnet|mainnet (NEW, default testnet) — added NOW so the
                                 mainnet⇒doola-production invariant is ENFORCED, not deferred
FORMATION_REQUIRED               bool; default TRUE when doola configured
FORMATION_SWEEP_MS               default 60_000
FORMATION_MAX_PER_TENANT         lifetime formation quota per tenant (default 3)
FORMATION_DAILY_CEILING          rolling 24h formation count across the deployment (default 10)
FORMATION_SANDBOX_SYNTHETIC_PII  bool, default TRUE when environment=sandbox — see §3 PII
```

- `cfg.doola?` all-or-nothing; half-config throws (`env.ts:494-500` pattern); secrets in `redact()`.
- `canFormEntities(cfg)` predicate → boot gate, `GET /config`
  (`formationAvailable/formationRequired/formationEnvironment`), MCP capability note.
- **Prod invariants** (isProd block): `FORMATION_REQUIRED` without `cfg.doola` → refuse;
  `ARC_NETWORK=mainnet` + doola sandbox → refuse; `ARC_NETWORK=mainnet` without doola → refuse
  (formation is mandatory on mainnet). NOT tied to `NODE_ENV` (testnet box runs
  `NODE_ENV=production` + sandbox by design).
- **Per-entity environment pinning (audit M5):** `entities.formation_environment` is persisted at
  claim (custody-rule twin, `onboarding.ts:116-118`); every provider call refuses loudly when the
  entity's pinned environment ≠ the deployment's. A mainnet flip can never route an in-flight
  sandbox company to `api.doola.com`.
- **Spend controls (audit H6):** formation is real money in prod ($100–150 each). Door-level
  preflight (refuse BEFORE the entity is minted, `custodyUnavailableMessage`-style): per-tenant
  quota + rolling daily ceiling (mirror `platform_outflows`) + pack-balance check where the API
  exposes it; low-pack ops alert. This is also the user-facing answer to pack exhaustion: the
  door refuses; an entity is never left live with a dead mandatory formation.
- **Honesty invariant, mechanically enforced:** `environment` is a REQUIRED field in the manifest
  schema, `EntityView.formation`, served metadata, and transparency — with a test asserting it
  cannot be omitted. Sandbox renders amber "Demo formation (sandbox)", never green.

## 3. Data model

**No new `EntityStatus`.** Additive columns + new tables only (ALTER-if-missing idiom, `db.ts:340+`).
Timestamps use TEXT `DEFAULT CURRENT_TIMESTAMP` (consistency with `bridge_legs`).

```sql
-- formation progress (provider-side milestones only; anchors live in oa_anchors)
CREATE TABLE IF NOT EXISTS formation_requests (
  entity_key   TEXT NOT NULL,
  step         TEXT NOT NULL CHECK (step IN
               ('create_provider','await_filing','fetch_documents','await_ein')),
  state        TEXT NOT NULL CHECK (state IN
               ('pending','submitted','confirmed','failed','abandoned')),
  attempt      INTEGER NOT NULL DEFAULT 0,
  provider_ref TEXT,
  detail       TEXT,          -- JSON: filingNumber, ein, doc ids…
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_key, step)
);
CREATE INDEX IF NOT EXISTS idx_formation_state ON formation_requests(state, step);
CREATE INDEX IF NOT EXISTS idx_formation_provider ON formation_requests(provider_ref);

-- anchor cycles: one row PER MANIFEST VERSION (audit H1 — the (entity,step) PK cannot hold two
-- cycles; bridge_legs gets away with it because a bridge has exactly one of each leg)
CREATE TABLE IF NOT EXISTS oa_anchors (
  entity_key    TEXT NOT NULL,
  version       INTEGER NOT NULL,
  manifest_hash TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN
                ('pending','scheduled','executed','vetoed','superseded','failed')),
  schedule_tx   TEXT, execute_tx TEXT,
  executable_at INTEGER,
  attempt       INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (entity_key, version)
);

-- webhook dedupe + audit; wake-up signal only (§6); swept after 30d (amortised, insert- AND
-- sweep-tick-driven so a quiet table still sweeps)
CREATE TABLE IF NOT EXISTS doola_webhook_events (
  event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL,
  provider_ref TEXT, payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_doola_events_pending ON doola_webhook_events(processed_at)
  WHERE processed_at IS NULL;

-- controller PII — separate table; NEVER in spec_json / views / transparency / metadata / logs
CREATE TABLE IF NOT EXISTS formation_parties (
  entity_key TEXT PRIMARY KEY,
  legal_first_name TEXT NOT NULL, legal_last_name TEXT NOT NULL,
  email TEXT NOT NULL, phone TEXT,
  line1 TEXT NOT NULL, line2 TEXT, city TEXT NOT NULL,
  region TEXT,                          -- nullable: most countries have no state/province (L3)
  postal_code TEXT NOT NULL, country TEXT NOT NULL,   -- ISO-3; US region = 2-letter state
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT                       -- erasure marker (H7)
);
```

- `entities` additive columns: `formation_provider` (null = legacy/stub), `formation_environment`,
  `ein_real`, `formation_filed_at`, `formation_filing_number`, `oa_manifest_version` (anchored),
  **`oa_manifest_anchored_hash`, `oa_manifest_pending_hash`, `oa_amendment_executable_at`** (the
  monitor and guardian UI read `entities` through a fixed projection — version *numbers* alone
  cannot feed the compromise rule or the veto card; audit H3/14). `entities.oa_hash` continues to
  mirror the anchored hash, updated transactionally on execute.
- `documents` table (declared-unused, `db.ts:55-63`) gains `entity_key, doc_type, sha256,
  content_type, size, provider_doc_id`; existing `path NOT NULL` satisfied by `putBytes`.
  `DocumentStore` gains `putBytes/getBytes` with **atomic writes** (tmp + fsync + rename, `wx` —
  a truncated file whose hash is anchored is a permanently unverifiable anchor; audit M7).
  **System of record for document bytes = doola** (re-fetchable via `provider_doc_id`); local
  `data/documents/` is additionally added to the backup runbook (the infra plan already flags it
  "the step most likely to be forgotten"). Disk-usage alert on `DATA_DIR` (full-disk history).
- **PII lifecycle (audit H7):** retention duty attaches to a *filed* responsible party, not an
  abandoned form. A sweeper job (plus a manual CLI) **erases** `formation_parties` rows for
  entities that never reached a confirmed `await_filing`; `deleted_at` marks erasure; retention
  period and lawful basis documented in the runbook. **Sandbox uses synthetic PII by default**
  (`FORMATION_SANDBOX_SYNTHETIC_PII=true`): the wizard clearly labels the demo identity fixture
  and real names/addresses are neither collected nor sent to doola's development environment —
  the zero-PII discipline of the World integration, kept. Prod (real filings) collects real PII
  behind an explicit consent screen naming doola as processor.
- PII hygiene elsewhere: plaintext SQLite v1 (box = trust boundary, S3-interim posture;
  `SecretStore` = the named encryption path); opsLog carries ids/steps/states only; frontend PII
  lives in a **non-persisted wizard slice with its own validator** — the localStorage persistence
  shape is inverted to an allowlist so a forgotten field can never leak (audit 16/L8); on session
  restore with missing PII the wizard bounces to the legal-identity phase explicitly.

## 4. The OA bundle manifest (B+ core)

Canonical JSON per **RFC 8785 (JCS)** — not "sorted keys" prose: JCS number/string rules,
integers only (no floats), UTF-8, one trailing `\n`; a **cross-implementation golden vector**
ships in the tests (a JS round-trip only proves the serializer agrees with itself; outsiders must
be able to recompute the anchor). Stored as `manifest-<entityKey>-v<n>.json`;
**anchor = keccak256(canonical bytes)**. Hash functions are mixed deliberately and documented for
verifiers: keccak256 for the anchor and `terms.hash` (EVM-native), sha256 for document bytes
(PDF-ecosystem-native).

```jsonc
{
  "schema": "novi/oa-bundle/1",
  "chain": { "chainId": 5042002, "legalManager": "0x…proxy", "agentId": "…" },  // domain separation (M9)
  "entity": { "name": "...", "jurisdiction": "US-WY", "publicId": "<uuid>" },
  "version": 2,
  "previous": "0x<last ANCHORED hash>",   // vetoed/superseded versions never enter the chain (M9)
  "terms": { "hash": "0x<keccak of oa-<key>-v<n>.md>", "uri": "novi:doc:oa-<key>-v<n>.md" },
  "legal": {                              // v1: null (pre-formation)
    "provider": "doola", "environment": "sandbox|production",   // REQUIRED, enforced by schema
    "providerCompanyId": "…", "entityType": "LLC", "state": "WY",
    "formationDate": 1755600000, "filingNumber": "…", "ein": "…|null",
    "documents": [
      { "type": "ArticlesOfOrganization", "sha256": "…", "name": "…" },
      { "type": "OperatingAgreement",     "sha256": "…", "name": "…" }
    ]
  }
}
```

- **v1 anchored at `createEntity` — for NEW entities only.** Gate: manifest-v1 derivation applies
  only when `createTxHash == null` (a record mid-onboarding at deploy time keeps the legacy
  doc-hash derivation to its broadcast tx — otherwise resume would silently diverge DB `oa_hash`
  from the chain; completeness finding 1). PR 1 is behavior-neutral **for existing rows**; for
  new rows it deliberately changes what the anchor commits to, and the served metadata publishes
  the manifest URI + scheme so a verifier holding only the chain can tell which scheme applies
  (M16). The dashboard label changes from "OA hash" to "OA anchor (vN)" in PR 1, not PR 4.
- **Terms-doc versioning rule (completeness 11):** the terms doc changes only when a *term*
  changes. The EIN and formation facts live in `legal` (manifest), NOT in the terms doc — the
  `EIN:` line is removed from `renderOperatingAgreement` for manifest-scheme entities, and
  `translate()` stops honoring caller-supplied `spec.legal.ein` (schema rejects it; the manifest
  is the only carrier). So v2/v3 change exactly one hash (the manifest); `terms.uri` stays v1
  unless terms actually change.
- **Single-pending rule (audit C1 part 1):** at most ONE version may be pending per entity. If a
  new material fact arrives while v(n) is pending, build v(n+1) folding **all** facts, mark v(n)
  `superseded` (never scheduled if not yet broadcast; left to expire unexecuted if already
  scheduled — and monitoring treats any execute of a non-current version as CRITICAL).
- On-chain `meta.ein`/`meta.formationDate` are frozen at initialize and read by nothing on-chain:
  superseded-by-manifest, documented. *Considered & rejected:* a timelocked metadata setter —
  new audited surface pre-freeze duplicating the manifest.

## 5. Saga integration & doors

Custody-pattern seams on `OnboardingDeps`. Persisted `formation_provider` wins over deployment
config (custody-resolution twin).

**PII intake — all doors (completeness 4):** PII never rides in `spec` (spec_json is persisted and
rendered) and never in MCP tool args. New tenant-scoped handle: `POST /formation-party` (REST,
authed) → `{partyId}`; the wizard and MCP callers pass `partyId` to onboard. MCP mirrors with a
`create_formation_party` tool whose description carries the formation capability note. On a
`FORMATION_REQUIRED` deployment, onboard without a `partyId` → 400 with the single-sourced
message; the gate ORDER mirrors REST↔MCP exactly (the `server.ts:489-491` discipline).
**Door matrix:** REST + MCP = full gates + partyId. Legacy `src/onboarding/server.ts` and
`cli create-entity` (doors 3+4, which today bypass claim/World/custody entirely) **hard-refuse
when `canFormEntities && FORMATION_REQUIRED`** — recommendation recorded: retire the legacy
server outright (vestigial); decision at PR 2 review.

**`create_provider` placement (audit H5, completeness 3):** runs AFTER step 8 (ENS) — after every
funding/binding step — and is wrapped in the ENS step's non-fatal try/catch shape: a doola outage
records a `failed` row + ops alert and **never** blocks funding, ENS, or the 202. The sweeper
retries it. Formation never gates `bound`/`funded`.

**doola idempotency (fact-check 1, completeness 9):** `Idempotency-Key` is honored ONLY by the two
create endpoints (`POST /customers`, `POST /companies`) — key scheme
`formation:<entityKey>:<step>:<attempt>`; a failed create releases the key; reuse-with-different-
body returns `409 E_IDEMPOTENCY_KEY_REUSED`. The playground/signature/resolution POSTs take no
such header and are naturally idempotent server-side. **Before PR 2 merges: verify the create-key
contract live in sandbox** (crash-window "adopt, never re-file" rests on it; a miss in prod is a
duplicate real LLC and a real fee). Belt-and-braces: before any create, look up by our previous
attempt's key/ref.

**Event handling (webhook = wake-up ONLY; audit H2):** the receiver persists the envelope and
schedules processing; processors **never read facts from `eventPayload`**. On every wake-up the
processor re-fetches authoritative state from doola over TLS with our API key
(`GET /companies/{id}`, `GET /companies/{id}/documents`, required-actions) and persists only
that. A forged-but-valid webhook (leaked secret) can cause a redundant poll, never a fact write.
Event map (names fact-checked): `company_formation_completed` → confirm `await_filing`;
`document_aoo_uploaded` / `document_operatingagreement_uploaded` (LLC-only; the signed SS-4
arrives as `document_ss4_uploaded`, NOT `signature_ss4_*`) → `fetch_documents`;
`company_ein_issued` (fires on FIRST issuance only — playground repeats re-fire only the letter
event) → `await_ein`; `company_formation_failed` → failed + alert; `partner_webhook_disabled` →
CRITICAL ops alert. Unknown event / unknown ref: persist + 200 + WARN, `processed_at` stays NULL,
re-driven by the sweeper once the mapping exists.

## 6. Webhook receiver

`POST /webhooks/doola/{sandbox|production}` (per-environment paths — rotation and the mainnet
flip never mix signature domains; audit M4), mounted in the public block (`app.ts:135` slot),
behind `if (deps.doola)`. Backend origin directly (the Vercel proxy strips the signature header).

Contract, in order:
1. Reject `Content-Length` > 256KB and cap while reading (first body-size control in the API —
   nothing else provides one; audit M1). `raw = await c.req.text()` before any JSON parse.
2. Verify `X-Doola-Signature` (case-insensitive): HMAC-SHA256 hex digest of the raw body, per
   doola docs. Explicit length check on the decoded buffers BEFORE `timingSafeEqual`
   (`timingSafeEqual` THROWS on length mismatch → would 500 and feed doola's 5-strike
   auto-disable; audit M2). Every failure path — bad hex, wrong length, wrong MAC — returns the
   same constant 401. Verify against `DOOLA_WEBHOOK_SECRET` then `_PREVIOUS`. Pin the exact
   observed header format against a live sandbox event as a PR 2 checklist item.
3. Envelope `{eventId, eventName, eventPayload, timestamp}` — `timestamp` is **Unix epoch
   MILLISECONDS** (fact-checked; a seconds assumption rejects everything). Stale (>48h) →
   **200 + WARN**, never 4xx (a clock-skewed box or a re-enabled backlog must not re-disable the
   endpoint; audit M3). doola's retry ladder spans ~37.3h cumulative (1m/15m/1h/12h/24h,
   per-previous-attempt) — 48h clears it with ~10.7h slack.
4. Dedupe: `INSERT OR IGNORE` on `event_id`; conflict → 200.
5. Ack fast; process async (wake-up model, §5). Failures leave `processed_at` NULL for the sweeper.
6. Secret handling: issued/rotated **by doola over email** (the Portal holds URL + subscriptions
   only — fact-check correction); rotation = request new secret → set `_PREVIOUS` → deploy →
   confirm → drop old. Ops: NTP required; "no doola webhook in 24h while formations are in
   flight" heartbeat alert; repeated-401 counter alert; manual portal re-enable runbook
   (auto-disable recovery). **Deploy sequence rule: ship PR 2 → verify the route live → only then
   configure the portal** (a portal pointing at a 404 gets the endpoint disabled before launch).

## 7. The anchor sub-saga (C1-hardened)

Adapter additions: `scheduleOperatingAgreementUpdate` / `executeOperatingAgreementUpdate`
(treasury-pair template, `abi: legalManagerAbi`, target `rec.proxy`, thread `rec.manager`), plus
reads `scheduledAt(hash)`, `vetoed(hash)`, `amendmentDelay()` (per-agent, immutable; the factory
reuses it as the treasury `policyDelay` — one value by construction), and
`meta().operatingAgreementHash`. Both calls use the **broadcast → persist tx → confirm** split
(the createEntity crash-window idiom): `sendManagerCall` (broadcast) → write
`schedule_tx`/`execute_tx` on the `oa_anchors` row → `waitForTransactionReceipt`. A crash between
broadcast and receipt resumes by adopting the persisted tx, never re-broadcasting.

**Monotonic anchoring (audit C1):**
- Single-pending rule (§4): one pending version per entity.
- Gate schedule AND execute on `version > entities.oa_manifest_version` (anchored) — a
  superseded/older version can never be scheduled or executed by us.
- Before scheduling: read `meta().operatingAgreementHash` — if it already equals the target hash,
  mark the row `executed` (crash-after-execute recovery; `scheduledAt` is deleted on execute, so
  "==0" alone is ambiguous between never-scheduled and already-executed — the exact trap the
  audit's regression scenario exploits).
- Schedule only when `scheduledAt(hash) == 0` (re-schedule silently RESETS the clock — no
  `AlreadyScheduled` guard, unlike the treasury).
- Hash-final discipline, twice: write manifest atomically → re-read → re-hash → byte-compare
  **before schedule**, and repeat the re-read + re-hash **immediately before the execute
  broadcast** (files can rot between the two txs and there is no manager-side cancel; audit M7).
- `vetoed(hash)` → the row parks `vetoed` and **the entity's entire anchor pipeline parks** until
  guardian `liftVeto` or an explicit operator acknowledgement — a veto is a stop sign, not a
  per-hash speed bump a re-versioning backend routes around (audit H4).
- `whenActive` precheck via `legalStatus(proxy)`; dissolution parks the sub-saga.
- On execute confirm, one repo transaction updates `entities.oa_hash`, `oa_manifest_version`,
  `oa_manifest_anchored_hash`, clears `oa_manifest_pending_hash`, `recordEvent`.

**Concurrency correctness is DB-level, not mutex-level (audit M13/20):** every step/state
transition is a compare-and-set `UPDATE … WHERE state = ?` acting only when `changes() === 1`.
`withKeyedLock` (single-process only, by its own doc) becomes an optimization. Manager-key
transactions gain a global in-process serialization lock (the sweeper is the first unattended
periodic producer of manager txs and must not race job ops on the nonce; L5).

**Reconcile & sweeper:** `formationReconcile()` runs at boot beside the two existing reconcilers
(`api/main.ts:288-292`) — formation entities are `bound`/`funded` and invisible to
`listInFlight()`. The sweeper (guarded self-rescheduling `setTimeout`, `FORMATION_SWEEP_MS`;
SIGTERM/SIGINT handlers added to the API process — the first ones — draining in-flight
broadcasts): executes due anchors; re-drives `processed_at IS NULL` events; retries transient
failures with backoff and a max-attempt → `abandoned` + alert; polls doola daily (company +
documents + required-actions, with backoff — an `await_ein` row legitimately sits 4–6 weeks) for
ANY entity whose formation is not complete, covering `create_provider` stuck rows and lost
document events (the >24h-outage/auto-disable scenario; audit M6); erases never-filed PII (§3);
alerts on "formation in flight > N days". Note: `synchronous=NORMAL` means a power loss can drop
a just-acked event row — the daily poll is the designed backstop and this dependency is
documented next to the ack-fast rule (L7).

## 8. Guardian surface + monitoring (launch requirements)

- **Monitoring**: watch entity `proxy` addresses (`byProxy` index); topics `AmendmentScheduled`,
  `AmendmentVetoed`, `VetoLifted`, `OperatingAgreementUpdated`. Rules: every `AmendmentScheduled`
  fires the guardian notification **unconditionally at WARN minimum** (INFO never leaves the box
  — `alerts.ts:103`; audit H3); escalate to **CRITICAL** when the scheduled hash ≠
  `entities.oa_manifest_pending_hash` OR the version regresses (`OperatingAgreementUpdated` whose
  hash ≠ current pending = CRITICAL). The DB comparison only ever ESCALATES, never suppresses —
  the treasury twin's independent-read principle. Monitor's `SELECT_ALL` + `MonitoredEntity`
  extended with the three new columns. Runbook updated (closes the amendment gap; the
  **dissolution**-events gap named in Known-Gaps remains and stays listed).
- **Guardian veto UI**: LegalManager ABI fragment shipped to the interface (second hand-written
  fragment — with a vitest drift-guard comparing it against `abis/generated.ts`). The pending-
  amendment card **enumerates `AmendmentScheduled` logs from the proxy via the user's own RPC**
  (`getLogs`), never trusting a backend-supplied hash (a compromised backend must not choose what
  the guardian vetoes; audit H4); shows a hard warning when on-chain pending ≠ what the API
  claims; Veto (`cancelOperatingAgreementUpdate`) + `liftVeto` buttons; executable-at countdown
  from `oa_amendment_executable_at`.
- **Tenant surfaces**: formation status card (doola sub-statuses humanized) + required-actions;
  wizard `legal-identity` phase between `guardian` and `custody` (Phase union + PHASES + render
  switch + separate non-persisted PII slice per §3). PDF downloads:
  `GET /entities/:id/documents/:docId` (auth-inherited, ownership idiom, `application/pdf`,
  `Content-Disposition`, `nosniff`, `private, no-store`); the browser path is fetch → blob →
  objectURL with the Bearer header (an `<a href>` cannot carry JWT; the existing api client is
  json-only and gains a bytes method); the Vercel proxy forwards `content-disposition`,
  `cache-control`, `content-length`, `x-content-type-options` and adds the documents path to its
  no-store branch (audit M14/15).
- **Public surfaces**: metadata route layers `legalBody.oaHash`, `formationDate`,
  `manifestVersion`, `manifestUri`, and `formation.environment` from the DB at serve time (the
  stored JSON otherwise advertises the v1 anchor forever — the fabrication class we forbid; audit
  M10). Transparency gains `formation: {status, environment}` and the "Legal formation is
  simulated until Arc mainnet" paragraph is rewritten **in PR 2** (it becomes false in a new
  direction the day sandbox formation ships; audit M11). EIN in authenticated views only.

## 9. Non-US founders (design now, validate in prod)

Non-US signal = absence of `ssn`. SS-4 signature flow: `signatureRequirements` on the company →
signature session endpoint (`POST /companies/{id}/signatures`, URL valid ~2h) → surfaced as a
required-action; the signed PDF arrives as `document_ss4_uploaded`. **Expedited EIN requires a
non-US applicant** — offered conditionally on that signal, never as a deployment default
(fact-check: as a config default it would break every US-founder formation). Note: of doola's two
required-action codes, only `FORMATION_NAME_OPTIONS_EXHAUSTED` is answerable via the resolution
endpoint; `FORMATION_SIGNATURE_SS4_RESET` self-closes when the replacement signature completes.
Sandbox cannot simulate any of this; live validation is a production-rollout checklist item, with
EIN-pending (4–6 weeks) rendered honestly (v2 anchors without EIN; v3 lands when the IRS does).

## 10. Threat model

- **Webhook forgery/replay** → HMAC dual-secret + length-checked timing-safe compare + eventId
  dedupe + millisecond-unit 48h bound + body cap; and structurally: the webhook is a wake-up —
  facts always re-fetched from doola's API, so a leaked webhook secret can trigger polls, not
  fact writes (audit H2). Replay of a captured valid event is inert (dedupe + idempotent steps).
- **doola compromise / poisoned documents** → hashes pinned in OUR manifest at fetch; download
  URLs are ~1h-expiring signed URLs (NOT single-use — fact-check correction): controls are the
  expiry window, HTTPS-only parse, manual-redirect handling compatible with the `ssrfGuard`
  fetcher (presigned-S3 redirects), and a 16MB cap enforced while streaming (Content-Length is
  spoofable on chunked responses; audit M15). doola never touches funds.
- **Backend compromise scheduling a malicious OA hash** → timelock + guardian veto + WARN-always
  notification + CRITICAL on pending-hash mismatch or version regression. Stated honestly: the
  veto is per-hash; the park-all-until-liftVeto rule (§7) is what stops a re-versioning
  adversary, and the guardian UI reading on-chain logs directly is what stops the backend from
  steering the veto (audit H4).
- **Anchor regression without an adversary** → the §7 monotonic rules exist because execute
  deletes `scheduledAt` (crash between broadcast and receipt would otherwise re-schedule an
  executed version and let a stale manifest land later; audit C1).
- **Money** → door-level quotas/ceilings/pack preflight (§2); formation spend is metered like
  USDC outflows.
- **PII** → separate table, synthetic-by-default in sandbox, erasure for never-filed parties,
  allowlist localStorage persistence, retention + lawful basis documented (audit H7).
- **Sandbox-as-real deception** → environment required-by-schema everywhere + amber labeling +
  mainnet boot invariant enforced via `ARC_NETWORK` now.

## 11. Test plan

- **Unit**: custody-idiom formation tests (poison seams; crash-window "adopt provider_ref, never
  re-file"); **deploy-mid-translating guard** (record with `createTxHash` keeps legacy hash —
  completeness 1); JCS golden vectors incl. a cross-implementation fixture + unicode/number
  edges; webhook: bad sig 401, wrong-length sig 401 (not 500), dup eventId, stale→200+WARN,
  unknown-ref re-drive once mapping lands, body-cap; sweeper: due-anchor executes exactly once
  under concurrent drivers (CAS proves it, mutex disabled); monotonic gates: superseded version
  never schedules, already-executed hash marks executed, vetoed parks ALL versions until
  liftVeto; PII: sandbox-synthetic substitution, erasure sweep, localStorage allowlist.
- **Adapter**: OA pair relays for controller agents / direct for legacy; `Vetoed()`/`TooEarly()`
  decode; broadcast-persist-confirm split crash points.
- **Foundry additions**: sequential amendments (v3 scheduled while v2 pending; assert both
  executable and that OUR ordering rules are therefore load-bearing) and **"a superseded
  scheduled hash stays executable forever on-chain"** (the risk the backend rules neutralize);
  reschedule-resets-the-clock (documented, currently untested). *(Replaced the unconstructible
  "amendmentDelay differs from treasury delay" test — the factory reuses one value by design.)*
- **Integration (anvil)**: full B+ loop — create (v1) → fake events → v2 schedule → warp →
  execute → `meta.operatingAgreementHash == keccak(manifest v2)`; crash-between-broadcast-and-
  receipt resume; guardian veto → liftVeto → v3 proceeds.
- **Sandbox E2E runbook** (= Sept-15 demo script): onboard on Arc testnet → playground completes
  → real webhooks → DEMO OA stored + hashed → v2/v3 anchored → dashboard trail. Note:
  `company_ein_issued` does NOT re-fire on playground repeats — the v3 path is exercised per
  fresh company, idempotence via the document-letter event only.
- **Config**: all-or-nothing, prod invariant matrix incl. `ARC_NETWORK`, `canFormEntities` drift
  guard, environment-pinning refusal.

## 12. Rollout

1. **PR 1 — foundations**: config (+`ARC_NETWORK`) + tables + doola client + manifest v1 for NEW
   entities (createTxHash guard) + dashboard label "OA anchor (v1)". Behavior-neutral for
   existing rows; anchor-semantics change for new rows, stated in the PR body.
2. **PR 2 — formation loop**: formation-party endpoint/tool + create_provider (non-fatal, after
   ENS) + webhook receiver + sweeper + documents + views/status + transparency copy rewrite +
   door refusals (legacy server/CLI). **Merge gates**: live idempotency-key contract verified in
   sandbox; live webhook signature format pinned. **Deploy sequence**: ship → verify route →
   configure portal.
3. **PR 3 — anchor loop (B+)**: `oa_anchors` sub-saga + adapter pair + monotonic rules +
   monitoring topics/rules + guardian notification. Restarts BOTH systemd units (api + monitor).
4. **PR 4 — surfaces**: wizard legal-identity phase + guardian veto UI (on-chain-log-driven) +
   dashboard cards + real-OA display replacing the cosmetic AgreementStep text.
5. Testnet deploy + full E2E on the box; **Sept-15 demo fallback declared now**: if PR 4 slips,
   the demo is PRs 1–3 + the ops trail (API-level evidence) — readiness over date, explicitly.
   **Ops task: request sandbox extension/renewal from doola before Sept 15** (access expires
   mid-Sept). Mainnet flip = `ARC_NETWORK=mainnet`, `DOOLA_ENVIRONMENT=production`, live key,
   pack purchased, SS-4 prod checklist.
6. Env examples (`.env.example`, `.env.sandbox.example`) updated with every new var in PR 1 (the
   repo has a live precedent of forgetting); `npm run e2e:formation` script for the runbook.

Legacy rows (13 testnet + existing prod agents): `formation_provider = null` = stub forever; no
backfill.

## 13. Open questions

1. **DAO supplement via doola** — pending from Halyna. Either answer changes no PR (documents are
   opaque hashed bytes); a "no" keeps the standard-WY-LLC + counsel question open.
2. Legacy `onboarding/server.ts`: retire vs gate — decide at PR 2 review (recommendation: retire).
3. Guardian notification transport (email/push vs ops-log) — shared gap with the treasury path,
   tracked as the controller design's existing follow-up.
