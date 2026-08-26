# Formation, production-ready — companies as first-class, real intake, USDC payments

> **Status:** DESIGN, ADVERSARIALLY AUDITED 2026-08-26 (3 passes: fact-check — 45 claims, 33
> confirmed, 10 corrected below; security — 14 findings incl. 1 critical; completeness — 18
> findings). All findings folded into this revision. Combined verdict after amendments: sound to
> build. Successor to `2026-08-19-doola-formation-provider-design.md` (four PRs + fix merged;
> E2E proven on testnet 2026-08-26 — capture of that run as a runbook artifact is an A1
> prerequisite, §10).
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
- Erasure rules (C7): party erasable only when `create_provider` has no `provider_ref` AND
  `await_filing` never confirmed AND (formation abandoned OR party unbound > 7 days).
- `assertGuardianAllowed` is a no-op unless `WORLD_REQUIRE_GUARDIAN`; `maxEntitiesPerHuman`
  optional.

## 2. Data model + THE MIGRATION (specified to the query)

`companies` as previously drafted, with amendments:
- `industry_label TEXT NOT NULL` replaces `naics_code` (store doola's label; keep an optional
  `naics_code` informational column, nullable).
- `status` is restricted to the dimension only the company owns: `'draft' | 'paying' | 'ready' |
  'abandoned'`. Filing progress (`forming/filed/complete/failed`) stays DERIVED from the step
  rows via `deriveFormationStatus` — never stored (the anti-drift rule the status module states).
- `legal_name_filed TEXT NULL` — set ONLY by matching doola's reported name against OUR stored
  `name_options` (§5); never doola free text.
- Unique partial index `idx_companies_one_payment` on `formation_payments(company_id) WHERE
  status IN ('quoted','settling','settled','released')`.
- `formation_requests` PK becomes `(company_id, step)`; `formation_parties` gains `company_id`
  (+ `ssn_ciphertext BLOB NULL`, `ssn_iv BLOB NULL`, `ssn_key_id TEXT NULL`,
  `ssn_deleted_at TEXT NULL`); `documents` gains `company_id`; `entities` gains
  `company_id` (WRITE-ONCE — anchored manifests carry `legal.providerCompanyId`, so re-attach
  would make a permanent on-chain claim false; detach/dissolution is out of scope and on the
  counsel list).
- **Idempotency keys:** existing keys are DERIVED (`formation:<entityKey>:<step>:<attempt>[:endpoint]`).
  The migration MUST NOT rotate a live key: it stores the derived pre-migration key prefix on
  each migrated `create_provider` row (`legacy_key_prefix`), and key derivation uses the stored
  prefix when present. New companies use `company:<companyId>:…`.

**Migration steps (one guarded transaction, meta-marker, refuses loudly rather than guessing):**
1. **Refusal predicate:** any `create_provider` row non-terminal (`pending`/`submitted`/`failed`
   with no `provider_ref`) → REFUSE with a message naming the entity ("finish or abandon in-flight
   formations before upgrading") — re-keying a live create can file a second real LLC.
2. Per formed entity: synthesize a `companies` row copying `created_at`/`updated_at` **verbatim**
   (never re-default — a fresh timestamp makes `factsMovedSince` true for every formed entity and
   opens a fleet-wide amendment storm on the first sweep tick); status `ready`; NOT-NULL intake
   columns synthesized by the SAME rule the A1 shim uses (§10): `name_options` =
   `[{name: <agent name>, position: 1}]` marked `synthesized: true`, `business_purpose` = the
   forwarded description or the default, `industry_label` = "Software development".
3. Re-key `formation_requests` (table REBUILD — SQLite cannot alter a PK; the house precedent for
   populated-table rebuilds is refuse-unless-clean, which step 1 guarantees), `documents.company_id`
   backfill (index ids and file paths are NOT re-derived — paths stay entity-keyed as opaque
   locators; manifests commit to `{type, sha256, name}`, so bytes and hashes are untouched),
   `formation_parties.company_id` backfill.
4. **Re-keyed queries, each named because each silently breaks otherwise:** `listStaleUnbound`
   (`entity_key IS NULL` → `company_id IS NULL` — otherwise EVERY party looks unbound and the
   7-day sweep NULLs the responsible party of every real filing), `listAbandoned` (join on
   `company_id`, restating both C7 conditions at company scope), `countByTenant` (counts
   `companies` rows), `oa_anchors.listDue`'s UNION arm, `listUnopened` (companies-keyed — this is
   the crash-recovery query that starts a stuck filing).
5. Fixture tests: a PR-4-era DB with formed entities migrates losslessly; a party bound to a
   filed company is NOT erasable after 8 days; a migrated entity's next anchor pass computes an
   UNCHANGED manifest hash (no storm); the in-flight fixture refuses.

**Manifest `companyName` gating:** additive field, but `deriveLegalBlock` is a pure function of
facts and `sameLegal` compares canonicalized blocks — so the field is emitted ONLY when the
entity's last anchored manifest already carries it OR no anchor cycle exists yet (schema-presence
check on the loaded baseline). Existing anchors stay byte-stable; entities gain the field
naturally on their next REAL fact change.

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
from config. Attach is allowed for status `ready` + derived filing status any of
forming/filed/complete; refused for `draft`, `paying`, `abandoned`, or derived `failed`.
**Caps:** `FORMATION_MAX_AGENTS_PER_COMPANY` (default 10) — each attached agent is an anchor
sequence per late fact, sponsored on-chain writes through timelocks; and because the formation
quota now bounds companies, a per-human entity ceiling remains via `maxEntitiesPerHuman`
(REQUIRED set in production — see §6 identity floor).

Late facts (e.g. EIN) fire one amendment cycle per attached entity through its own timelock —
accepted, bounded by the agents-per-company cap.

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
3. Forwarded ONLY in `createCompany` (`responsibleParty.ssn`; `createCustomer` takes no SSN —
   whether `members[0].ssn` should also carry it is a one-line doola question, default: no).
4. Deleted (`ssn_ciphertext = NULL`, `ssn_deleted_at = now`) in the SAME transaction that
   persists `doola_company_id` — both the create-persist and the adopt path; idempotent. Not
   earlier (same-key retry must rebuild a byte-identical body or doola 409s; consequence is a
   parked-for-human state, not a wedge — the key_reused handler adopts where it can).
5. **`expedited` is frozen into `create_provider.detail` at first send** and read from there
   forever — it is a function of the SSN, and PII erasure must never mutate a body under a live
   key.
6. **TTL (replaces the flat 30 days):** erase when `doola_company_id IS NOT NULL` (doola holds
   what it needs) OR the company is terminal; if a TTL of 7 days (aligned with the row's other
   PII) fires on a company with NO provider_ref, the formation is ABANDONED in the same
   transaction — never left retrying a body it can no longer rebuild.
7. Intake immutability: name options, purpose, party fields and SSN are frozen once the first
   create is sent; the edit-and-retry UX is offered ONLY when the last failure was `rejected`
   (the one case where doola releases the key — verified). Values are canonicalized (trim/NFC)
   at intake, stored canonical, sent verbatim. **Merge-gate probe (A1):** same key, same values,
   re-ordered JSON keys — settles byte-vs-semantic comparison in one request.

## 5. Intake details

- Names ×3, validated (length, charset, WY restricted words as data + test, no duplicates).
  Adopt lookup matches ANY of the three stored candidates, not just the first.
- **Filed name:** doola's full-company response carries `nameOptions` with no winner flag; the
  LIST item carries `name`. The processor matches the reported name against OUR stored candidates
  — on match, `legal_name_filed` = OUR candidate string (never doola free text — the anchor
  imports from the filer, it never hashes partner-controlled text); on no match → required-action
  to the owner, `legal_name_filed` stays NULL, `manifest.legal.companyName` stays null (honest)
  until resolved. **A1 merge gate: a live sandbox probe pinning where the filed name is actually
  readable** (list item vs `getCustomer.companies[]` vs AOO), recorded in the runbook.
- Business purpose: own required field; agent description no longer doola-visible. Industry:
  picker fed by a NEW `listNaicsCodes` client method (cached); stored as label.

## 6. Payments (rebuilt from the real primitive; built now, OFF for beta)

**Primitive: genuine EIP-3009 on the USDC token contract** (`transferWithAuthorization` — native
USDC feature). NOT the Gateway batching scheme (wrong domain, requires an on-chain Gateway
deposit, library-generated nonce, server-side signer). No facilitator, no Circle service in the
path, no new external dependency.

Flow:
1. `POST /companies` (payment ON) → company `paying` + quote `{amountUsdc, payTo:
   FORMATION_REVENUE_ADDRESS, nonce, validUntil}`. `nonce` = random 32 bytes, stored on the
   `formation_payments` row (uniqueness from the row, NOT derived from companyId — a derived
   nonce is one-shot and bricks the company after any failed attempt). `validBefore` in the
   authorization = `validUntil`.
2. Guardian signs with wagmi `useSignTypedData` against the **USDC domain** — NEW frontend work,
   budgeted as such (no typed-data signing exists in the interface; SIWE is personal_sign).
3. Backend verifies LOCALLY before touching the chain: recipient == revenue address, value ==
   the STORED quote amount (never live config — a fee change between quote and settle must not
   re-price a signature), validBefore in the future, signature recovers the guardian.
4. **Crash-window discipline (same class as the doola create):** persist `settling` + the
   broadcast intent BEFORE submitting; executor submits `transferWithAuthorization` (gas is
   USDC cents on Arc — the platform pays it, stated); persist the tx hash; confirm receipt →
   `settled` → company `ready` in one transaction. On resume with `settling`: check
   `authorizationState(from, nonce)` on USDC + the persisted tx before any re-quote. Re-quoting
   (expired/failed) issues a NEW row with a NEW nonce; the unique partial index prevents two
   live payments per company.
5. `create_provider` refuses while `paying` (CAS-guarded). With payment OFF the states are
   skipped entirely and beta copy says formation is included.
6. **Refunds:** manual CLI, but METERED — `formation_refund` joins the `OutflowPath` enum under
   the S5 meter and ceiling (the CLI-outside-the-meter hole is exactly what S5 closed once
   already). **Revenue custody named:** `FORMATION_REVENUE_ADDRESS` is receive-only with NO key
   on the box (Circle DevC wallet under a SEPARATE entity secret, or hardware); refunds are paid
   from a small capped hot float wallet listed in the S4 key inventory. Boot invariants: revenue
   address ≠ executor and ≠ every operational key; payment cannot be required in sandbox.
7. **Identity floor (the anonymous-USDC-buys-real-LLCs finding):** production formation
   (`DOOLA_ENVIRONMENT=production` OR payment required) boot-requires `WORLD_REQUIRE_GUARDIAN=on`
   AND `maxEntitiesPerHuman` set. The per-tenant formation quota is KEPT when paying (raised via
   config, never removed — payment is a price, not a brake); the platform daily ceiling stays;
   doola's KYB/KYC is the named contractual identity control on the filing itself; formation
   velocity per tenant/human is opsLogged and alertable. `payer_address` recorded on every
   payment.
8. `/config` gains `formationPaymentRequired` + `formationFeeUsdc` (deliberate departure from
   the booleans-only rule — public pricing; the revenue address stays OFF it, the quote carries
   `payTo` on an authenticated route).
9. **B1 merge gate: a live probe settling a real signed authorization to a test revenue address
   on Arc testnet** (the house six-probes precedent; B1 touches no doola so it needs its own
   live gate).

## 7. Surfaces and doors

- **Doors (three: REST, MCP, CLI):** onboard carries `companyId` ONLY — **"inline creation" is
  wizard SEQUENCING (`POST /companies` then `POST /onboard`), never a company payload on the
  onboard door** (PII, now including SSN potential, stays off it). MCP gains `create_company`
  (no ssn) + `list_companies`; `create_formation_party` folds into `create_company` (party args
  remain a separate dedicated call shape, consistent with the existing rule: PII never in `spec`
  or spec-shaped args). CLI keeps its hard refusal. Message constants renamed and re-worded:
  `formationPartyRequiredMessage` → company-based; `formationPartyUnavailableMessage`'s
  single-use arm ("already bound") is REPLACED by ownership+environment+status checks;
  `legacyDoorRefusalMessage` reworded. **Spend controls MOVE to `POST /companies`** (quota +
  ceiling count `companies` rows — onboard is where filings *don't* happen under N:1).
- **Wizard:** legal-body phase branches (picker default = last-used, an API-level ordering
  contract shared by `list_companies`; create form; payment step when ON). localStorage
  allowlist: `companyId` added; `partyId`/`partySynthetic` retired; the sandbox label signal
  moves to the company's `environment`/`synthetic` (AgreementStep no longer keys on
  `partySynthetic`). SSN joins the never-persisted PII slice. Resume gate keys on
  `session.companyId`.
- **Companies section:** list + detail with explicit states (empty, draft, paying, forming,
  filed, complete, failed, abandoned, all-agents-detached); documents; compliance calendar
  (FIRST consumption of `getComplianceCalendar`: A3 adds fetch + 24h cache + storage); attached
  agents; annual-report row with "handled by: (ask doola)" placeholder.
- **Sharing labels — the exact surfaces:** authenticated only: `EntityView.formation` gains
  `sharedWith: <count>`, rendered by `FormationCard` and mirrored by the three MCP entity tools.
  The PUBLIC surfaces (`/transparency`, `/metadata`) do NOT carry the count. **Honest privacy
  note (stated in-product):** manifests already publish `legal.providerCompanyId`, so two agents
  sharing a company are publicly linkable via their anchored manifests — the reuse picker says
  this before the user confirms.
- Document routes move to `/companies/:id/documents/:docId`; the entity alias is dropped
  immediately (the index route has zero client consumers; `downloadDocument` is updated in the
  same PR).
- opsLog events (new): `company_created`, `company_reused`, `company_attach`, `company_draft_expired`,
  `formation_payment_{quoted,settling,settled,released,refund}`, `formation_ssn_erased`,
  `formation_velocity_warn`.
- Runbooks updated in the same PRs: `doola-deploy.md` (door table AGAIN), `doola-webhooks.md`
  (provider_ref → company), `.env.example`/`.env.sandbox.example`, S4 key inventory (revenue +
  refund float), S5 outflow paths (`formation_refund`).

## 8. Threat model (delta, amended)

SSN as §4 (adopt-safe, encrypted, AAD-bound, TTL-abandon rule). Payment: signature binds
amount+recipient+validBefore+nonce; local verification against the stored quote; nonce uniqueness
from the row; settle crash-window persisted; unique live-payment index; velocity alerts.
Reuse: door + claim-transaction CAS; pin from company row; write-once company_id. Revenue
custody: receive-only, no key on the box; refund float capped + metered (S5) + inventoried (S4).
Identity: World personhood boot-invariant + per-human entity ceiling + kept quotas + doola KYB
named. Migration: refusal predicates, verbatim timestamps, key-prefix preservation, PII-query
re-keys with fixture proofs. Public linkability of shared companies disclosed, not hidden.

## 9. Test plan (amended)

Everything previously listed, PLUS: nonce-after-indeterminate-settle (crash mid `settling`,
resume must read `authorizationState` and never re-sign the same nonce); MCP↔REST parity across
ALL new company fields on all three entity tools; migrated-entity manifest hash UNCHANGED on the
next anchor pass; PII-sweeper fixture (bound party not erasable at day 8); the reordered-JSON
idempotency probe; attach-CAS race (abandon between door and claim loses); companyName gating
(anchored baseline without the field ⇒ candidate block omits it).

## 10. Rollout

- **A1** — schema + migration (as §2, with its refusal predicates and fixtures) + company-keyed
  sub-saga + company CRUD + **shim**: a party-only onboard auto-creates a 1:1 company that lands
  in `ready` (never draft/paying), consumes the tenant quota, synthesizes the NOT-NULL intake
  columns by the §2.2 rule, and is removed in A3. A1 merge gates: filed-name live probe;
  reordered-JSON probe; FormationE2E_1 run captured as a runbook artifact (it is the migration's
  golden fixture).
- **A2** — production intake (names/purpose/industry/SSN) + REST/MCP surfaces + messages +
  spend-control move.
- **A3** — wizard branch + Companies section + labels + document-route move + shim removal +
  compliance-calendar consumption.
- **B1** — payments (flag off) + revenue/refund custody + metered refund CLI + live settle probe.
- Deployment to the box is a separate, deliberate decision (Sept-15 demo runs on today's state).
- **Externals:** counsel (N:1 document coherence, terms-doc/doola-OA duality, Series LLC, DAO
  supplement); Halyna (annual-report/BOI ownership under packs; FinCEN BOI status — likely
  domestic-exempt since 2025, verify; where the filed name is authoritatively readable; whether
  `members[0].ssn` should carry the SSN too); pricing (fee amount, state-fee pass-through).

## 11. Out of scope (explicit)

Multi-member companies (single member = guardian); company detach/deletion and dissolution
paperwork (counsel list; `company_id` is write-once meanwhile); automatic refunds; Stripe/fiat.
