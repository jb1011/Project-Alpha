# Formation, production-ready — companies as first-class, real intake, USDC payments

> **Status:** DESIGN, ADVERSARIALLY AUDITED 2026-08-26 (3 passes: fact-check — 45 claims, 33
> confirmed, 10 corrected, 2 carried as doola questions since settled from their docs, §10; security —
> 14 findings incl. 1 critical; completeness — 18 findings) **and re-gated 2026-08-29 (8-angle gate:
> 7 finders + 4 adversarial verifiers against the merged code — 20 confirmed findings, none refuted
> outright, all folded; traceability in §12).** Combined verdict after amendments: sound to build.
> Successor to `2026-08-19-doola-formation-provider-design.md` (four PRs + fix merged; E2E proven on
> testnet 2026-08-26 — capture of that run as a runbook artifact is an A1 prerequisite, §10).
> **Decisions locked (Martin, 2026-08-26):** (1) company:agents = user's choice (1:1, N:1, many),
> reuse suggested default, sharing labeled plainly; N:1 document coherence → counsel
> (non-blocking). (2) SSN: collect (US persons), forward, delete adopt-safely. (3) Payments FREE
> for beta but BUILT now, flag-gated. (4) Rail: USDC on Arc. (5) Company legal name explicit + 2
> required alternates, never auto-generated. (6) Hybrid flow: inline first onboarding, Companies
> section after. (7) One doola OA per company, generated once; agents attach beneath it with zero
> doola interaction.

## 0. TL;DR

A `companies` table becomes the home of everything doola-related; entities attach many-to-one.
The formation sub-saga re-keys from entity to company and runs once per company; the anchor loop's
legal-block builder and status projection re-source from the company row (their entity-column
reads are the ONLY per-agent machinery that changes — named in §3). Production intake becomes
real: three validated name candidates, business purpose, industry label (doola deprecated
`naicsCode`), responsible party, and an encrypted write-once SSN deleted in the transaction that
persists the doola company id. A USDC payment path is built and shipped OFF: the guardian signs a
genuine USDC-token-domain EIP-3009 `transferWithAuthorization` in the browser (NEW work — no
typed-data signing exists in the interface today), our executor submits it on-chain, and the
receipt is the settlement — no Gateway deposit, no Circle facilitator, no external dependency.
Identity floor: World ID personhood is a boot invariant for production formation; the per-tenant
quota SURVIVES payment. Migration is specified to the query level because two audit passes showed
the naive version files duplicate LLCs, erases live PII, and re-anchors the fleet.

## 1. What exists (fact-checked against merged code)

As in the audited table of the predecessor design, with corrections from this audit:
- `formation_requests (entity_key, step)`; `formation_parties` (party_id PK, entity_key UNIQUE,
  bind inside the claim transaction); `documents` entity-keyed (index id + file path both embed
  the entity key); `oa_anchors` per-entity; manifest `legal` has NO name field of any kind.
- Intake today: no SSN anywhere; ONE name candidate derived from the agent name; the wizard's
  "purpose" is forwarded as doola's `description`; the hardcoded default is the **industry
  label** "Software development" (`naicsCode` is deprecated at doola — the wire wants the label;
  the client has no `references/naics-codes` method yet).
- Payments: the existing x402 rail signs Circle's **Gateway batching domain** server-side against
  the GatewayWallet, spending **Gateway balances** that require an on-chain deposit; verification
  is local structural self-verify (the facilitator is only asked to settle); the seller replay
  guard is an in-memory Set. None of it is reusable for a human wallet payment — §6 builds the
  real thing. No `signTypedData` exists anywhere in `interface/`.
- `getComplianceCalendar` exists on the client but has never been called (first consumption is §7).
- `SecretStore` has zero production consumers; keys land in `config/env.ts` (so does
  `FORMATION_PII_KEY`).
- Erasure rules (C7) are TWO DISJOINT arms, not one conjunction: `listAbandoned` = `create_provider`
  state `abandoned` AND `provider_ref IS NULL` AND no confirmed `await_filing` (no time component);
  `listStaleUnbound` = `entity_key IS NULL` AND `created_at` older than 7 days (no provider
  conditions). `erase` NULLs ten PII columns in ONE statement. `abandoned` has exactly one writer —
  the sweeper at max attempts; `key_reused`/`lost` parks never bump the attempt, so a human-parked
  row is never abandoned by the system and there is no operator abandon action today.
- `assertGuardianAllowed` silently returns when `cfg.world` is undefined (any of `WORLD_APP_ID` /
  `WORLD_RP_ID` / `WORLD_RP_SIGNING_KEY` missing) or `requireGuardian` is off; it is wired on
  exactly two doors (REST onboard, MCP onboard); its ceiling counts AGENTS
  (`countEntitiesForNullifier`).
- `FormationStatus` = `none | in_progress | filed | complete | failed`, pinned by a CI drift test
  against the interface union. There is no `forming`.
- `oa_anchors.listDue` is `ORDER BY k LIMIT 50` with no cursor; `factsMovedSince` and `listDue`'s
  UNION arm read `formation_requests.updated_at`, which `persistPollBackoff` bumps on EVERY poll.
- Documents are entity-keyed end to end: `documentIndexId`/`documentStoreName` embed the entity key,
  dedupe is `UNIQUE(entity_key, provider_doc_id)`, and five readers are `WHERE entity_key = ?`.
- Interface proxy: `isDocumentDownloadPath`/`isNoStorePath` hardcode `/entities/…/documents`
  regexes; the drift test asserts fragments that survive a rename.
- `seller.ts verifyPayment` performs the four EIP-3009 checks, but on an x402 header envelope, with an
  amount FLOOR, against the Gateway domain. No `authorizationState`/`cancelAuthorization` code exists.
  The S5 `OutflowMeter` (`OutflowPath` enum: `fund_treasury | gas_seed | job_fund | cli_fund |
  gas_sponsorship`, all platform-wallet paths) is the platform hot-wallet brake, one rolling `SUM`
  over `platform_outflows` (default ceiling 200 USDC / 24h).

## 2. Data model + THE MIGRATION (specified to the query)

`companies` as previously drafted, with amendments:
- `industry_label TEXT NOT NULL` replaces `naics_code`. No code column: nothing would write or read it.
- `status` is restricted to the dimension only the company owns: `'draft' | 'ready' | 'abandoned'`.
  **"Paying" is DERIVED**, never stored: `hasLivePayment(companyId)` =
  `EXISTS (formation_payments WHERE company_id = ? AND status IN ('quoted','settling'))`, exported
  beside `deriveFormationStatus`. Filing progress stays derived via `deriveFormationStatus`, whose
  union is `none | in_progress | filed | complete | failed`. Nothing about payments is ever written
  to `companies`, so a refund or an expired quote needs no second write and cannot drift.
- `intake_synthesized INTEGER NOT NULL DEFAULT 0` — the row-level marker for migrated/shimmed
  intake (never a key inside `name_options`, which keeps ONE shape).
- `name_options` stored shape is canonical: `[{name, entityTypeEnding, position}]`, produced by the
  existing `companyNameOptions` (strips a trailing `LLC`/`L.L.C.`). The migration, the shim and the
  live intake ALL call it. The §5 matcher normalizes BOTH sides (trim, NFC, strip a trailing
  `LLC`/`L.L.C.`/`Limited Liability Company`, casefold) and compares the bare `name` — doola's list
  item reports the name WITHOUT its ending (verified 2026-08-27).
- `legal_name_filed TEXT NULL` — set ONLY by matching doola's reported name against OUR stored
  `name_options` (§5); never doola free text.
- `formation_payments`: status union enumerated ONCE, normatively:
  `quoted | settling | settled | expired | failed | refunded` (there is no `released`);
  `product` as §6.8; `amount_usdc` (the STORED quote), `nonce` (32 random bytes), `valid_before`,
  `payer_address`, `raw_tx BLOB NULL` and `tx_hash` persisted BEFORE broadcast (§6.4); `attempt`;
  `refund_tx_hash NULL`.
  Unique partial index `idx_formation_payments_one_live ON formation_payments(company_id, product)
  WHERE status IN ('quoted','settling')` — LIVE rows only, per product, so a later
  `maintenance_year` quote and a re-quote after `expired`/`failed` are both insertable.
- `formation_requests` PK becomes `(company_id, step)` and gains `facts_updated_at TEXT NOT NULL`,
  written ONLY by transitions that change state, `provider_ref` or fact detail — never by
  `persistPollBackoff` (§3 reads it).
- `formation_parties` gains `company_id TEXT NULL UNIQUE` — a party row is SINGLE-USE: once bound to
  a company it is never reusable (a second company needs a new party row, §7), bound by a CAS inside the `POST /companies` transaction (§7) — plus `ssn_ciphertext BLOB NULL`,
  `ssn_iv BLOB NULL`, `ssn_key_id TEXT NULL`, `ssn_deleted_at TEXT NULL`. `entities` gains
  `company_id` (WRITE-ONCE — anchored manifests carry `legal.providerCompanyId`, so re-attach would
  make a permanent on-chain claim false; detach/dissolution is out of scope and on the counsel list).
- **Documents re-key to the company:** `documentIndexId(companyId, providerDocId)`,
  `documentStoreName(companyId, …)`, dedupe `UNIQUE(company_id, provider_doc_id)` (replaces
  `idx_documents_entity_provider`; `idx_documents_entity` stays for legacy rows). Existing rows keep
  their entity-derived id and path as opaque locators; lookups read the `company_id` COLUMN and never
  re-derive an id. Readers that change: `listByEntity → listByCompany` (anchorLoop, formationProcessor,
  documents route, views), `findOwned(companyId, id)`, `findByProviderDocId` and `storedTypes`
  (company-scoped); `listByEntities` stays entity-shaped at the view boundary through a join on
  `entities.company_id`. A company can be filed and have its documents fetched before any agent
  attaches (§7 sequencing) — that is why the entity key cannot be the document key.
- Indexes added in the same migration: `entities(company_id) WHERE company_id IS NOT NULL`,
  `companies(tenant_id, status)`, `formation_requests(facts_updated_at)` (the `listDue` UNION arm and
  `factsMovedSince` read it), `oa_anchors(entity_key, updated_at)`.
- **Idempotency keys:** existing keys are DERIVED (`formation:<entityKey>:<step>:<attempt>[:endpoint]`)
  and are only ever re-sent while a `create_provider` row is `pending`/`submitted` — exactly the rows
  step 1 refuses. No surviving row can re-send a key, so nothing needs preserving: ALL keys become
  `company:<companyId>:…` after the migration. No `legacy_key_prefix` column, no branch in
  `idempotencyKey` (fixture: no migrated row is in a key-re-deriving state).

**Migration steps (one guarded transaction, meta-marker, refuses loudly rather than guessing):**
1. **Refusal predicate:** any `create_provider` row non-terminal (`pending`/`submitted`/`failed`
   with no `provider_ref`) → REFUSE with a message naming the entity — re-keying a live create can
   file a second real LLC. **Operator escape (ships with A1):** CLI `formation:abandon <entityKey>`
   transitions `create_provider → abandoned` with an ops-logged reason and REFUSES when
   `provider_ref IS NOT NULL` (a create that reached doola is adopted, never abandoned by hand); the
   refusal message names the command. Without it a `key_reused`-parked row, which never burns
   attempts, blocks the upgrade forever.
2. **The synthesis rule (§10 references it by this name):** for EVERY entity with
   `formation_provider IS NOT NULL` OR a bound `formation_parties` row — NOT only formed ones:
   unopened entities, live filings past `create_provider`, and abandoned-with-`provider_ref` rows all
   exist and all hold PII that must stay attached — synthesize a `companies` row: status `ready` (so
   the sub-saga and attach stay unblocked), `intake_synthesized = 1`, `name_options =
   companyNameOptions(agentName)` at position 1, `business_purpose` = the forwarded description or
   the default, `industry_label` = "Software development", `created_at`/`updated_at` copied from
   the entity.
3. Re-key `formation_requests` (table REBUILD — SQLite cannot alter a PK; the house precedent for
   populated-table rebuilds is refuse-unless-clean, which step 1 guarantees). **The INSERT enumerates
   columns and copies `created_at`, `updated_at`, `attempt`, `provider_ref`, `detail`, `error`,
   `next_poll_at` VERBATIM — never re-defaulted:** `updated_at` is what `factsMovedSince`, the
   `listDue` UNION arm, the retry clock, the stall detector and `listPollDue` read; a re-stamp makes
   every formed entity due forever and starves the 50-row anchor batch. `facts_updated_at` is
   initialised to `updated_at`. `documents.company_id` and `formation_parties.company_id` backfills
   are ALTER-only (index ids and file paths are NOT re-derived; manifests commit to
   `{type, sha256, name}`, so bytes and hashes are untouched).
4. **Re-keyed queries, each named because each silently breaks otherwise:** `listStaleUnbound`
   (`entity_key IS NULL` → `company_id IS NULL AND entity_key IS NULL` — both null preserves "never
   used" even if a backfill misses a row; a wider predicate NULLs the responsible party of every real
   filing), `listAbandoned` (join on `company_id`, restating its THREE conditions at company scope),
   `countByTenant`, `oa_anchors.listDue`'s UNION arm, `listUnopened` (companies-keyed — the
   crash-recovery query that starts a stuck filing). **Post-migration assertion inside the
   transaction:** zero rows where `deleted_at IS NULL AND entity_key IS NOT NULL AND company_id IS
   NULL`, else REFUSE and roll back.
5. Fixture tests: a PR-4-era DB with formed entities migrates losslessly; a party bound to a filed
   company is NOT erasable after 8 days; a migrated entity's next anchor pass computes an UNCHANGED
   manifest hash (no storm); the in-flight fixture refuses and its message names `formation:abandon`;
   `listDueEntityKeys` returns the same set pre- and post-migration; no migrated `create_provider`
   row is `pending`/`submitted` (the key-re-deriving states); an unopened entity's synthesized
   company is `ready` and fileable; an abandoned-with-`provider_ref` party survives.

**Manifest `companyName`:** emitted by `normalizeLegal` ONLY when `legal_name_filed` is a non-empty
string — a conditional key; absent ≡ null for this one field (a deliberate, documented departure from
the explicit-nulls convention in `manifest.ts`). NO baseline gate: `deriveLegalBlock` stays a pure
function of facts, called before `loadAnchoredManifest` exactly as today (a baseline-gated builder
could never bootstrap the field for an already-anchored entity, and would force a manifest read per
tick). No storm: every migrated company has `legal_name_filed` NULL ⇒ byte-identical block ⇒
`sameLegal` short-circuits; the hash moves exactly once, when a real filed name lands — the intended
amendment. A schema-id bump is NOT an option: `parseManifest` refuses any schema ≠ v1.

## 3. Company sub-saga, attach, and the anchor interface

Sub-saga steps/states/semantics carry over verbatim, company-keyed. Webhook `provider_ref` now
maps to a company (one advance per company replaces N — the processor never read payloads anyway).

**The two functions that change signature (the honest scope of "per-agent work"):**
- `deriveLegalBlock` re-sources from the company row (`filed_at`, `filing_number`, `ein`,
  `legal_name_filed`) and `documents.listByCompany`; entity columns `formation_filed_at`/
  `formation_filing_number`/`ein_real` are dropped from the read path (kept for migration only).
- `formationSummary(rec, steps)` becomes `formationSummary(company, steps)`; `deriveFormationStatus`
  keeps its steps-only signature (the rows just scope differently).

**Attach (reuse):** door check AND a CAS inside the claim transaction (re-read company tenant/
environment/status in the same transaction; `UPDATE entities SET company_id = ? WHERE
idempotency_key = ? AND company_id IS NULL`). Pin fields are copied FROM THE COMPANY ROW, never
from config. Attach is allowed for status `ready` AND derived filing status any of
`none | in_progress | filed | complete` (a `ready` company whose `create_provider` row is not yet
open derives `none` — the shim's and the hybrid flow's happy path); refused for `draft`,
`abandoned`, `hasLivePayment`, or derived `failed`.
**Caps:** `FORMATION_MAX_AGENTS_PER_COMPANY` (default 10) — each attached agent is an anchor
sequence per late fact, sponsored on-chain writes through timelocks; a per-human ceiling on
COMPANIES (`maxCompaniesPerHuman`, §6.7) bounds filings, and the per-human ENTITY ceiling
(`maxEntitiesPerHuman`) stays as the separate agent bound.

**Anchor scheduling under N:1 (three changes, all in A1):**
- `listDue` gains a keyset cursor — `WHERE k > @after ORDER BY k LIMIT ?`, the sweeper persists the
  last key and wraps (the anti-starvation shape `listPollDue` already has) — and opsLogs
  `anchor_batch_full` when a batch comes back full. Its UNION arm is deduped at company granularity
  (`SELECT DISTINCT company_id`, expanded to entities AFTER the limit), so one busy company cannot
  fill the 50-slot batch with its ten agents.
- `factsMovedSince` and the UNION arm compare `facts_updated_at`, not `updated_at`: a poll must not
  invalidate the anchor gate (today one `await_ein` poll makes an entity re-read its manifest every
  tick for the whole 4–6-week EIN wait).
- Late facts (e.g. EIN) fire one amendment cycle per attached entity through its own timelock. The
  bound is stated: `agents × late facts × 2 sponsored writes` (worst case 10 × 3 × 2 = 60 ≈ $0.54 at
  the measured $0.009/op) plus one guardian notification per entity per fact. One cheap gate: a new
  cycle is not OPENED while the company's `facts_updated_at` is younger than one sweep interval, so
  facts landing together fold into one cycle per entity. Company-level batching is a named follow-up,
  not A1.

## 4. SSN lifecycle (amended)

1. Collected only in the production REST create-company form (US persons; optional-but-
   recommended copy). **REST-only: MCP `create_company` OMITS `ssn`** (an SSN in MCP tool args
   would sit in an LLM client's context and MCP logs; the tool description says so and points to
   the web form). Sandbox/synthetic: field absent.
2. Encrypted immediately: AES-256-GCM, 12-byte random IV stored beside the ciphertext, AAD =
   `party_id || company_id`, key-id prefix so `FORMATION_PII_KEY_PREVIOUS` is selected not
   trial-decrypted. `FORMATION_PII_KEY` lives in `config/env.ts` with a boot invariant (required
   when doola is production). Stated honestly: the key shares the box `.env` — encryption-at-rest
   defends the Litestream→R2 replica, not a compromised box.
3. Forwarded ONLY in `createCompany`, ONCE, as `responsibleParty.ssn` (`createCustomer` takes no
   SSN; `members[].ssn` is never sent). Settled from doola's docs 2026-08-27: US-vs-non-US is
   derived from ANY one person's `ssn`, and the responsible party is the IRS-relevant person, so
   sending it once is sufficient and minimises PII exposure.
4. Deleted (`ssn_ciphertext = NULL`, `ssn_deleted_at = now`) in the SAME transaction that
   persists `doola_company_id` — both the create-persist and the adopt path; idempotent. Not
   earlier (same-key retry must rebuild a byte-identical body or doola 409s; consequence is a
   parked-for-human state, not a wedge — the key_reused handler adopts where it can).
5. **`expedited` is frozen into `create_provider.detail` at first send** and read from there
   forever — it is a function of the SSN, and PII erasure must never mutate a body under a live
   key.
6. **Two clocks, stated separately (replaces the flat 30 days).** (a) **SSN erasure:** NULL
   `ssn_ciphertext`/`ssn_iv`/`ssn_key_id` and stamp `ssn_deleted_at` when the company is terminal
   (`abandoned`, or `create_provider` terminal) OR the SSN is older than 7 days AND `create_provider`
   has never reached `submitted`. The `doola_company_id` case is §4.4's in-transaction delete; the
   sweeper's clause for it is an idempotent backstop, not a TTL. (b) **Party erasure** stays EXACTLY
   C7's two disjoint arms (§1). The system NEVER manufactures `abandoned` from a clock: a company with
   no `provider_ref` at day 7 raises a `formation_stale` guardian notification + ops alert and KEEPS
   its intake; only the max-attempt path or the operator CLI sets `abandoned`. Why: a NULL
   `provider_ref` is not proof no company exists at doola (the adopt path exists for exactly that),
   and an erased party makes adoption unrecoverable. `erase` is extended to the four `ssn_*` columns
   so ONE statement still erases everything. (c) **Draft expiry (the one clock that may terminate):**
   a `draft` company with NO `create_provider` row at all, no live payment, and `created_at` older
   than 7 days is provably never filed — the sweeper sets `companies.status = 'abandoned'`, opsLogs
   `company_draft_expired`, and (a) then erases the SSN as terminal. **Company-level `abandoned` has
   exactly three writers:** this draft expiry, the max-attempt path, and `formation:abandon` — the
   latter two set `companies.status` in the SAME transaction as the `create_provider` step
   transition, so the company and step statuses cannot disagree.
7. Intake immutability: name options, purpose, party fields and SSN are frozen once the first
   create is sent; the edit-and-retry UX is offered ONLY when the last failure was `rejected`
   (the one case where doola releases the key — verified). Values are canonicalized (trim/NFC)
   at intake, stored canonical, sent verbatim. **Merge-gate probe (A1):** same key, same values,
   re-ordered JSON keys — settles byte-vs-semantic comparison in one request.

## 5. Intake details

- Names ×3, validated (length, charset, WY restricted words as data + test, no duplicates), stored in
  the canonical `{name, entityTypeEnding, position}` shape via `companyNameOptions`. Adopt lookup
  matches ANY of the three stored candidates, not just the first.
- **Filed name:** doola's full-company response carries `nameOptions` with no winner flag; the
  LIST item carries `name` (verified 2026-08-27: it is our submitted first option WITHOUT its ending).
  The processor normalizes both sides (§2: trim, NFC, ending stripped, casefold) and matches doola's
  reported name against the bare `name` of OUR stored candidates — on match, `legal_name_filed` = OUR candidate string (never doola free text — the
  anchor imports from the filer, it never hashes partner-controlled text); on no match →
  required-action to the owner, `legal_name_filed` stays NULL, `manifest.legal.companyName` is absent
  (honest) until resolved. **A1 merge gate: a live sandbox probe pinning where the filed name is
  actually readable** (list item vs `getCustomer.companies[]` vs AOO), recorded in the runbook; the
  question is also open with doola (§10).
- Business purpose: own required field; agent description no longer doola-visible. Industry: the
  label list is a static federal reference table, shipped as a BUILD-TIME constant refreshed by a
  script (`scripts/refresh-naics.mts` against `references/naics-codes`; the `listNaicsCodes` client
  method exists for the script only) — no partner API call at the top of the funnel, no cache to
  specify.

## 6. Payments (rebuilt from the real primitive; built now, OFF for beta)

**Primitive: genuine EIP-3009 on the USDC token contract** (`transferWithAuthorization` — native
USDC feature; Arc's USDC predeploy is Circle's FiatTokenV2_2, which also exposes
`authorizationState` and `cancelAuthorization`). NOT the Gateway batching scheme (wrong domain,
requires an on-chain Gateway deposit, library-generated nonce, server-side signer). No facilitator,
no Circle service in the path, no new external dependency.

Flow:
1. `POST /companies` (payment ON) → company stays `draft`; a `formation_payments` row `quoted`
   makes it derived-paying; quote `{amountUsdc, payTo: FORMATION_REVENUE_ADDRESS, nonce, validUntil}`.
   `nonce` = random 32 bytes, stored on the row (uniqueness from the row, NOT derived from companyId
   — a derived nonce is one-shot and bricks the company after any failed attempt). The client signs
   `validAfter = 0` and `validBefore = validUntil`.
2. Guardian signs with wagmi `useSignTypedData` against the **USDC domain** — NEW frontend work,
   budgeted as such (no typed-data signing exists in the interface; SIWE is personal_sign).
3. Backend verifies LOCALLY before touching the chain through ONE shared helper,
   `verifyTransferAuthorization({ authorization, signature, domain, payTo, value, mode })`, extracted
   from the recovery core of `seller.ts` and called by both rails (x402: Gateway domain, `floor`;
   formation: USDC domain, `exact`): recipient == revenue address, value == the STORED quote amount
   (never live config — a fee change between quote and settle must not re-price a signature),
   `validAfter <= now`, `validBefore` in the future, signature recovers the guardian.
4. **Crash-window discipline (same class as the doola create, same primitives as the bridge legs):**
   persist `settling` + the signed RAW tx + its hash BEFORE broadcast (`markSubmitted`-before-network,
   as `bridgeLegRepository`); the executor — the platform EOA, `writeContract` with EXPLICIT gas via a
   new `TRANSFER_WITH_AUTHORIZATION_GAS` beside `USDC_TRANSFER_GAS` (ecrecover + an
   `authorizationState` SSTORE; do not reuse the 100k plain-transfer figure; the Arc estimate footgun
   does not bite here because the guardian, not the executor, is the token sender) — submits; gas is
   USDC cents on Arc, the platform pays it, stated; confirm receipt → `settled` → company `ready` in
   one transaction. **Resume is owned by a NEW eighth sweeper leg, `resumeStalledSettles()`**,
   modelled on `resumeStalledCreates` (`SUBMITTED_STALL_MS`, `attempt`/`bumpAttempt`, `retryDelayMs`
   from `formation/schedule.ts`), with three rules: (1) `settling` with an unknown outcome NEVER
   re-quotes — it re-broadcasts the persisted raw tx; (2) it moves to `expired` only when `now >
   validBefore` AND `authorizationState(from, nonce) === false`; if that reads true, it resolves
   `settled` from the receipt; (3) the fast path is an explicit guardian action — a second
   `useSignTypedData` over `CancelAuthorization`, submitted by the executor (the platform cannot cancel
   unilaterally), after which the row may go `expired` at once. The same leg moves `quoted` rows past
   `validBefore` to `expired`. Re-quote is therefore two-step: `quoted → expired` or `settling →
   expired/failed` THEN a new row with a new nonce (the live-rows index admits it). Why: a signed
   authorization is public and self-authorizing until `validBefore`; `authorizationState == false`
   means "not yet used", not "dead", so re-quoting on it can charge the guardian twice — and B1 ships
   no fund-moving refund.
5. `create_provider` refuses while `hasLivePayment` (CAS-guarded). With payment OFF the payment
   states never exist and beta copy says formation is included.
6. **Refunds and revenue custody DECIDED (2026-08-27):** `FORMATION_REVENUE_ADDRESS` is a Ledger
   hardware-wallet account — receive-only, NO key on the box, listed in the S4 key inventory. Refunds
   are signed MANUALLY from the Ledger by runbook, so B1 ships NO fund-moving refund path and NO hot
   float: the CLI only RECORDS a refund (`settled → refunded` with the Ledger tx hash +
   `opsLog(formation_payment_refunded)`) and moves nothing. **A refund is NOT a platform-wallet
   outflow and never enters `platform_outflows`**: a 399 USDC record would exceed the 200 USDC S5
   ceiling and block every agent's treasury funding, gas seeds and job funding for 24 hours. The
   later hot-float phase (built only if refund volume justifies it) adds `formation_refund` to
   `OutflowPath` TOGETHER WITH an env invariant `PLATFORM_OUTFLOW_CEILING_USDC >= FORMATION_FEE_USDC`
   beside the existing `maxTreasuryFund` guard. Boot invariants: revenue address ≠ executor and ≠
   every platform key (a fixed set plus an indexed `EXISTS` over operator addresses, not a fleet scan);
   payment cannot be required in sandbox.
7. **Identity floor (the anonymous-USDC-buys-real-LLCs finding):** production formation
   (`DOOLA_ENVIRONMENT=production` OR payment required) boot-FAILS unless `cfg.world` is CONSTRUCTED
   (all three `WORLD_*` present) AND `world.requireGuardian` AND `world.maxCompaniesPerHuman != null`
   — the invariant asserts the WIRED dependency, never env strings, because `assertGuardianAllowed`
   silently no-ops when `cfg.world` is undefined. `assertGuardianAllowed` is called on `POST
   /companies` and MCP `create_company` — the doors that spend the money — in addition to onboard.
   NEW `countCompaniesForNullifier` (join `companies.tenant_id` ↔ `guardian_verifications`) backs
   `maxCompaniesPerHuman`; `maxEntitiesPerHuman`/`countEntitiesForNullifier` stay as the separate
   per-human AGENT ceiling. The per-tenant formation quota is KEPT when paying (raised via config,
   never removed — payment is a price, not a brake) and counts companies that have spent or committed
   (`status = 'ready'` OR `hasLivePayment`), never drafts; the platform DAILY ceiling stays on
   `create_provider` rows (`createRequestsSince`) — where the fee is actually incurred, since with
   payment ON a company can sit in draft for days before its create fires. doola's KYB/KYC is the named
   contractual identity control on the filing itself; formation velocity per tenant/human is opsLogged
   and alertable. `payer_address` recorded on every payment.
8. `/config` gains `formationPaymentRequired` + `formationFeeUsdc` (deliberate departure from
   the booleans-only rule — public pricing; the revenue address stays OFF it, the quote carries
   `payTo` on an authenticated route). Fee (provisional, 2026-08-27): `FORMATION_FEE_USDC=399`
   all-in; the Wyoming filing fee ($100, OUTSIDE doola's pack per doola's FAQ and state-fees
   endpoint) is shown as a breakdown line in copy, never added at checkout. Beta copy:
   "included during the beta, normally $399". `formation_payments.product TEXT NOT NULL DEFAULT
   'formation'` with `CHECK (product IN ('formation','maintenance_year'))` so a yearly
   maintenance quote (registered-agent renewal + annual report) is additive later; B1 quotes
   `formation` only. Billing is per COMPANY: attaching an agent to an existing company is free.
9. **B1 merge gate: a live probe settling a real signed authorization to a test revenue address
   on Arc testnet** (the house six-probes precedent; B1 touches no doola so it needs its own
   live gate).

## 7. Surfaces and doors

- **Doors (three: REST, MCP, CLI) and ONE domain function:** every company creation goes through
  `createCompany(deps, tenantId, intake)`, which REST `POST /companies`, MCP `create_company` and the
  A1 shim all call — tenant quota, daily ceiling, `assertGuardianAllowed`, the synthetic-PII
  refusals, intake validation/synthesis and the party bind CAS
  (`UPDATE formation_parties SET company_id = ? WHERE party_id = ? AND tenant_id = ? AND company_id
  IS NULL AND deleted_at IS NULL` inside the transaction that inserts the company; false ⇒ roll back),
  all refusing BEFORE any row is minted (the `formationDoorRefusal` "cannot drift" precedent). The
  spend controls therefore land in A1 with the function, never in a later phase. Onboard carries
  `companyId` ONLY — **"inline creation" is wizard SEQUENCING (`POST /companies` then
  `POST /onboard`), never a company payload on the onboard door** (PII, now including SSN potential,
  stays off it). MCP gains `create_company` (no ssn) + `list_companies`; `create_formation_party` STAYS its own
  call (the bind CAS needs a pre-existing party row, and PII never rides in `spec` or spec-shaped
  args) — `create_company` takes the `partyId` it returns. CLI keeps its hard refusal. Message
  constants: `formationPartyRequiredMessage` → company-based; `formationPartyUnavailableMessage`'s
  single-use arm is KEPT at company scope (`party.companyId` set ⇒ unavailable) — reusing an identity
  for a second company is a NEW party row (fresh intake, fresh SSN capture, its own clocks), and the
  brake on how many companies one human forms is `maxCompaniesPerHuman`, not party reuse;
  `syntheticPiiRequiredMessage`/`syntheticPiiRefusedMessage` carried UNCHANGED, keyed on the
  deployment's `sandboxSyntheticPii`, which writes `companies.environment`/`synthetic` (never caller
  input), with a boot invariant `sandboxSyntheticPii ⇒ DOOLA_ENVIRONMENT ≠ production`;
  `legacyDoorRefusalMessage` reworded.
- **Wizard:** legal-body phase branches (picker default = last-used, an API-level ordering
  contract shared by `list_companies`; create form; payment step when ON — delivered by B1). localStorage
  allowlist: `companyId` added; `partyId`/`partySynthetic` retired; the sandbox label signal
  moves to the company's `environment`/`synthetic` (AgreementStep no longer keys on
  `partySynthetic`). SSN joins the never-persisted PII slice. Resume gate keys on
  `session.companyId`.
- **Companies section:** list + detail with explicit states (empty, draft, paying, ready — filing not
  yet opened, in_progress, filed, complete, failed, abandoned); documents; compliance calendar (FIRST
  consumption of `getComplianceCalendar`): lazy-on-view, in-process `Map<companyId, {at, events}>`
  with a 24h TTL, restart re-fetches — the `worldVerifier`/`transparency` TTL-map precedent; never
  sweeper-warmed, NO table (re-derivable partner data does not belong in the replicated store);
  attached agents; annual-report row with "handled by: (ask doola)" placeholder.
- **Sharing labels — the exact surfaces:** authenticated only: `EntityView.formation` gains
  `sharedWith: <count>`, rendered by `FormationCard` and mirrored by the three MCP entity tools.
  The PUBLIC surfaces (`/transparency`, `/metadata`) do NOT carry the count. **Honest privacy
  note (stated in-product):** manifests already publish `legal.providerCompanyId`, so two agents
  sharing a company are publicly linkable via their anchored manifests — the reuse picker says
  this before the user confirms.
- Document routes move to `/companies/:id/documents/:docId`; the entity alias is dropped
  immediately. Client changes in the SAME PR: `downloadDocument`, AND the proxy predicates
  `isDocumentDownloadPath` → `/^companies\/[^/]+\/documents\/[^/]+$/` and `isNoStorePath` →
  `/^companies\/[^/]+\/documents(\/|$)/` (they gate `content-disposition`, `cache-control:
  private, no-store`, `content-length`, `x-content-type-options` on legal PDFs). The drift test
  becomes a PATH guard: it extracts each regex literal from the source, asserts it matches
  `companies/abc/documents/def`, and asserts the negative on `entities/abc/documents/def`, so a
  half-done rename fails CI.
- opsLog events (new): `company_created`, `company_reused`, `company_attach`, `company_draft_expired`,
  `formation_payment_{quoted,settling,settled,expired,failed,refunded}`, `formation_stale`,
  `anchor_batch_full`, `formation_ssn_erased`, `formation_velocity_warn`.
- Runbooks updated in the same PRs: `doola-deploy.md` (door table AGAIN, `formation:abandon`),
  `doola-webhooks.md` (provider_ref → company), `.env.example`/`.env.sandbox.example`, S4 key
  inventory (revenue address = Ledger, no refund float), manual-refund runbook.

## 8. Threat model (delta, amended)

SSN as §4 (adopt-safe, encrypted, AAD-bound, two erasure clocks, never clock-abandoned). Payment:
signature binds amount+recipient+validAfter+validBefore+nonce; local verification against the stored
quote through the shared helper; nonce uniqueness from the row; raw tx persisted before broadcast;
expiry only after `validBefore` + `authorizationState`; guardian-signed cancel fast path; unique
live-payment index per product; refunds outside the S5 meter; velocity alerts. Reuse: one domain
function on every door; door + claim-transaction CAS; party single-use per company; pin from company
row; write-once `company_id`. Revenue custody: receive-only Ledger, no key on the box; refunds signed
manually, recorded not executed. Identity: wired-dependency boot invariant + `assertGuardianAllowed`
on the paying doors + per-human company ceiling + per-human agent ceiling + kept quotas + doola KYB
named. Migration: refusal predicate + operator abandon, verbatim `formation_requests` timestamps,
universal company synthesis + post-migration assertion, PII-query re-keys with fixture proofs.
Public linkability of shared companies disclosed, not hidden.

## 9. Test plan (amended)

Everything previously listed, PLUS: settle resume never re-signs or re-quotes on an unknown outcome
(crash mid `settling`; resume re-broadcasts the persisted raw tx; `expired` only after `validBefore`
AND `authorizationState === false`); the two-step re-quote; `maintenance_year` row insertable beside
a `settled` formation row; MCP↔REST parity across ALL new company fields on all three entity tools;
migrated-entity manifest hash UNCHANGED on the next anchor pass; `legal_name_filed` NULL ⇒ legal
block bytes unchanged, setting it ⇒ exactly one new version; PII fixtures (bound party not erasable
at day 8; a company parked on a required action for 8 days is NOT abandoned and its party NOT
erasable; abandoned-with-`provider_ref` party survives migration; `erase` NULLs the `ssn_*` columns);
the reordered-JSON idempotency probe; attach-CAS race (abandon between door and claim loses); attach
allowed at derived `none`; party bind CAS refuses a second company; sandbox refuses real intake incl.
SSN and production refuses `synthetic: true` through `createCompany`; production-formation boot
fails when `cfg.world` is unwired (any `WORLD_*` missing) or `maxCompaniesPerHuman` is null, even
with the env flag on; `POST /companies` calls `assertGuardianAllowed`;
`listDue` cursor wraps and no key starves under a 10-agent company; a poll does not move
`facts_updated_at`; proxy path guard (positive on `companies/…`, negative on `entities/…`); a
recorded refund leaves `platform_outflows` untouched.

## 10. Rollout

- **A1** — schema + migration (as §2, with its refusal predicate, `formation:abandon` CLI, the
  synthesis rule and fixtures) + company-keyed sub-saga + company-keyed documents + the anchor
  scheduling changes (§3) + `createCompany` domain function WITH spend controls and the identity
  gate + company CRUD + **shim**: a party-only onboard calls `createCompany` for a 1:1 company that
  lands in `ready` (never draft/paying) with `intake_synthesized = 1` via the §2 synthesis rule, and
  is removed in A3. A1 merge gates: filed-name live probe; reordered-JSON probe; FormationE2E_1 run
  captured as a runbook artifact (it is the migration's golden fixture).
- **A2** — production intake (names/purpose/industry/SSN) + REST/MCP surfaces + messages.
- **A3** — wizard branch + Companies section + labels + document-route move (with the proxy
  predicates) + shim removal + compliance-calendar consumption.
- **B1** — payments (flag off): `formation_payments` + quote route, the wagmi `useSignTypedData`
  signing step (NEW frontend work) and the wizard payment step, `/config`
  `formationPaymentRequired`/`formationFeeUsdc`, `verifyTransferAuthorization` extraction,
  `resumeStalledSettles` leg, `TRANSFER_WITH_AUTHORIZATION_GAS`, guardian cancel fast path, Ledger
  revenue address, refund-recording CLI + manual-refund runbook + live settle probe. B1 touches no
  doola and may run in parallel with A2/A3 once A1 has landed; A3's wizard branch ships without the
  payment step if B1 has not landed yet.
- Deployment to the box is a separate, deliberate decision (Sept-15 demo runs on today's state).
- **Externals:** counsel (N:1 document coherence, terms-doc/doola-OA duality, Series LLC, DAO
  supplement); Haliny (asked 2026-08-27: who files the annual report and at what cost, registered-
  agent renewal price from year two and how reminders arrive — no renewal webhook event exists;
  expedited-EIN per-use price; where the state-accepted name is readable when a lower-ranked
  option is filed — the company object has no filed-name field). Settled without asking: state
  fee outside the pack (WY $100), pack includes EIN + RA year one + OA, SSN once on the
  responsible party, BOI moot (domestic entities exempt since March 2025).

## 11. Out of scope (explicit)

Multi-member companies (single member = guardian); company detach/deletion and dissolution
paperwork (counsel list; `company_id` is write-once meanwhile); automatic refunds; Stripe/fiat.

## 12. 2026-08-29 gate — findings and where each is resolved

| # | Finding (verified against code) | Resolved in |
|---|---|---|
| 1 | `paying` stored though derivable; payment union never enumerated; `released` undefined | §2 status, §6.1/6.5 |
| 2 | `legacy_key_prefix` dead by step 1's own refusal predicate | §2 keys |
| 3 | Migration synthesized companies only for FORMED entities → unopened/live/abandoned-with-ref parties erased | §2 step 2 + step 4 assertion |
| 4 | Verbatim-timestamp rule on the wrong table; `formation_requests` rebuild would re-stamp `updated_at` | §2 step 3 |
| 5 | `forming` is not a status; attach predicate missed `none` | §2, §3 attach |
| 6 | `naics_code` dead; synthesized marker in JSON; circular "§2.2 rule"; no operator abandon; three `name_options` shapes | §2 |
| 7 | `companyName` baseline gate can never bootstrap; inverts derive-before-load | §2 manifest |
| 8 | Refund recorded into the S5 meter exceeds the 200 USDC ceiling and blocks all funding | §6.6 |
| 9 | No actor resumes `settling`; no backoff; primitives unnamed | §6.4 |
| 10 | Superseded authorization never cancelled → double charge; `validAfter` unspecified | §6.1/6.3/6.4 |
| 11 | One-payment index covered terminal statuses → forbids `maintenance_year` and re-quote | §2 index |
| 12 | Party single-use rule deleted with no company-scope replacement | §2, §7 |
| 13 | Synthetic-PII refusals lost their enforcer | §7 |
| 14 | Identity floor asserted env strings; gate not on the paying doors; ceiling counted agents | §6.7 |
| 15 | Spend controls in A2 left `POST /companies` uncontrolled in A1; quota counted drafts | §6.7, §7, §10 |
| 16 | SSN TTL clause unreachable; clock-manufactured `abandoned` erased adoptable parties; `erase` skipped `ssn_*` | §1, §4.6 |
| 17 | Documents entity-keyed while company-scoped fetch can precede any entity | §2 documents |
| 18 | Proxy path predicates silently miss the new document route | §7 |
| 19 | `listDue` batch starvation under N:1; polls invalidate the anchor gate | §3 |
| 20 | Compliance-calendar table and unspecified NAICS cache | §5, §7 |
