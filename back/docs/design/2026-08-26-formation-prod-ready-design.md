# Formation, production-ready — companies as first-class, real intake, USDC payments

> **Status:** DESIGN, pending adversarial audit. Successor to
> `2026-08-19-doola-formation-provider-design.md` (all four PRs merged, E2E proven on testnet
> 2026-08-26: real sandbox LLC filed, real OA fetched + hashed, manifest v2 anchored on-chain
> through the timelock). This design closes the gap between "the loop works" and "a stranger can
> file a real company through the wizard".
> **Decisions locked (Martin, 2026-08-26 brainstorm + analysis pass):**
> 1. **Company : agents = user's choice** — 1:1, N:1, or many companies; reuse is the SUGGESTED
>    default; plain-language labeling wherever agents share a company. No feature flag on the
>    choice; the coherence of OUR document structure under N:1 goes to counsel (does not block).
> 2. **SSN/ITIN: collect (US persons), forward, DELETE adopt-safely** — only after `provider_ref`
>    is persisted (§4), encrypted at rest before that (Litestream replicates the DB to R2).
> 3. **Payments: FREE for beta, but BUILT production-ready now**, flag-gated off — the third
>    instance of the custody/formation gating pattern.
> 4. **Rail: USDC on Arc**, reusing the proven x402/settlement infrastructure. No Stripe, no
>    fiat, no entity dependency on the critical path.
> 5. **Company legal name: explicit field + 2 REQUIRED alternates** (doola has no availability
>    check; collisions surface post-filing as a required-action). Never auto-generated.
> 6. **Flow: hybrid** — company creation inline in the first onboarding; a Companies section for
>    management + reuse afterwards.
> 7. (2026-08-26 follow-up) **One doola OA per company, generated once at formation.** Agents
>    attach beneath it without any doola interaction — the OA describes the company (member,
>    management), never an agent. Attaching agent #2 = our terms doc + manifest only: instant.

## 0. TL;DR

A `companies` table becomes the home of everything doola-related — the filing, the party, the
documents, the compliance calendar — and entities point at it many-to-one. The formation sub-saga
(`create_provider` → `await_filing` → `fetch_documents` → `await_ein`) re-keys from entity to
company and runs ONCE per company; per-agent work (terms doc, manifest, anchors) is untouched and
per-agent forever. Production intake becomes real: legal company name + two alternates (validated
against Wyoming's rules), business purpose, NAICS, responsible party, and — for US persons — an
encrypted, write-once SSN that is deleted in the same transaction that persists the doola company
id (the adopt-safe point; deleting earlier makes same-key retries 409 forever). A formation
payment path is built on the existing x402/USDC settlement rails and shipped OFF
(`FORMATION_PAYMENT_REQUIRED=false`): quote → guardian signs an EIP-3009 authorization in the
browser → the existing facilitator settles to a dedicated revenue address (never the executor
key) → the company saga refuses `create_provider` until settled. Refunds are a manual CLI. The
wizard's legal-identity phase becomes a branch — pick an existing company (default when one
exists) or create one — and a Companies section shows documents, the compliance calendar, the
agents attached, and the honest "shares its legal body with N other agents" label.

## 1. What exists today (all merged, live on testnet)

| Piece | State | Where |
|---|---|---|
| Formation sub-saga, entity-keyed | live | `formation_requests (entity_key, step)`, driven by `workflow/formationProvider.ts` + `formationProcessor.ts` + `formationSweeper.ts` |
| Party intake, entity-scoped | live | `formation_parties` (party_id PK, `entity_key` UNIQUE bound at claim), `POST /formation-party`, MCP `create_formation_party`; synthetic mode in sandbox |
| doola client | live, path-verified | `adapters/doola/doolaClient.ts` — creates take `Idempotency-Key`; per-endpoint namespace verified live; failed create releases the key; `E_IDEMPOTENCY_KEY_REUSED` on same-key-different-body |
| Documents | live, entity-keyed | `documents` table + `GET /entities/:id/documents/:docId`; fetched per entity |
| Anchoring (B+) | live, per-agent | `oa_anchors`, `workflow/anchorLoop.ts`; manifest `legal` block carries providerCompanyId, filing facts, doc hashes |
| Payments infra | live for agents | x402 exact settlement via facilitator (`payments/`), EIP-3009 flows proven on Arc; NOT yet used for platform revenue |
| Wizard | live | `legal-identity` phase (synthetic panel in sandbox, real form in prod), `useFormationEnvironment` fail-neutral hook |
| Spend controls | live | per-tenant formation quota + rolling daily ceiling at the doors |
| Intake gaps | — | no SSN, one name candidate, agent "purpose" reused as business description, hardcoded NAICS 541511, agent name silently becomes "<name> LLC" |

## 2. Data model

Additive tables + a migration; SQLite conventions as established (TEXT timestamps, ALTER-if-missing,
CAS transitions).

```sql
CREATE TABLE IF NOT EXISTS companies (
  company_id        TEXT PRIMARY KEY,          -- uuid, OUR id
  tenant_id         TEXT NOT NULL,
  environment       TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
  status            TEXT NOT NULL CHECK (status IN
                    ('draft','paying','forming','filed','complete','failed','abandoned')),
  doola_customer_id TEXT,
  doola_company_id  TEXT,                      -- provider_ref
  name_options      TEXT NOT NULL,             -- JSON [{name, position}] ×3, validated
  legal_name_filed  TEXT,                      -- learned from doola AFTER filing (which candidate won)
  entity_type       TEXT NOT NULL DEFAULT 'LLC',
  us_state          TEXT NOT NULL DEFAULT 'WY',
  business_purpose  TEXT NOT NULL,
  naics_code        TEXT NOT NULL,
  filing_number     TEXT, filed_at INTEGER, ein TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_companies_tenant ON companies(tenant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_provider ON companies(doola_company_id)
  WHERE doola_company_id IS NOT NULL;
```

- `formation_parties`: gains `company_id` (bound at company creation, replaces the entity bind);
  gains `ssn_ciphertext BLOB NULL` + `ssn_deleted_at TEXT NULL`. `entity_key` column retained for
  migration, no longer written.
- `formation_requests`: re-keyed `(company_id, step)`. Same steps, same states, same CAS/backoff
  columns. Idempotency keys become `company:<companyId>:<step>:<attempt>:<endpoint>`.
- `documents`: gains `company_id`; documents are fetched ONCE per company and shared by every
  attached entity (today's per-entity fetch is the migration's only data movement).
- `entities`: gains `company_id` (nullable = stub/legacy). `formation_provider`/`formation_environment`
  pins remain per-entity (they gate provider calls); the pin rule becomes **bound company ⇒
  pinned + company must be filed-or-forming**.
- `formation_payments` (§6): `payment_id PK, company_id, tenant_id, amount_usdc, settlement_id,
  payer_address, status ('quoted','settled','released','refund_pending','refunded'), created_at,
  updated_at`.
- `oa_anchors`, manifests, terms docs: UNCHANGED (per-agent). Manifest `legal` block gains
  `companyName` (the FILED name — null until known) — additive JCS field, new manifests only.

**Migration:** for every existing entity with `formation_provider` set, synthesize a `companies`
row from its rows (provider_ref, filing facts, party, documents), set `entities.company_id`,
re-key its `formation_requests` and `documents`. Idempotent, guarded by the `meta` marker
pattern; refuses on inconsistency rather than guessing (the PR-2 C10 rule). Existing testnet
entities (incl. FormationE2E_1) are the test corpus.

## 3. The company sub-saga (re-keyed, one per company)

`create_provider`/`await_filing`/`fetch_documents`/`await_ein` operate on a company. All the
hardened semantics carry over verbatim (adopt-on-resume, transport-vs-terminal classification,
poll backoff, abandonment, environment-pin refusal, webhook wake-ups mapping `provider_ref` →
company now). The processor writes filing facts onto `companies`; entities attached to the
company derive their formation status from it (view join; `deriveFormationStatus` takes company
rows). **Reuse path:** onboarding with an existing `companyId` performs zero doola work — it
verifies tenant ownership + environment match + company not failed/abandoned, sets
`entities.company_id`, and proceeds; manifests reference the company's existing facts and
documents. Second-agent onboarding is thereby instant (no filing, no EIN wait).

Anchor interplay: N entities on one company anchor N manifests referencing the same filing facts
and document hashes. When a LATE fact lands (EIN issued after agents attached), the anchor loop's
existing trigger (facts newer than anchored version) fires per entity — N amendment cycles, each
through its own timelock. That is correct and unchanged; the due-work query joins through
`company_id`.

## 4. SSN lifecycle (the exact rules)

1. **Collect** only in the production create-company form, only when the responsible party is a US
   person (country USA); optional-but-recommended copy explains the trade ("without it, the IRS
   path takes 4–6 weeks"). Sandbox/synthetic: never collected, field absent.
2. **Encrypt immediately** — AES-256-GCM, key from `FORMATION_PII_KEY` (env, via the `SecretStore`
   seam; boot invariant: required when doola is production). Ciphertext to
   `formation_parties.ssn_ciphertext`. Plaintext exists only in the request body and the doola
   call. Never in `spec_json`, `detail` JSON, logs, views, or errors (extend the opsLog
   discipline tests).
3. **Forward** — decrypted at call time into `createCustomer`/`createCompany` responsibleParty.
4. **Delete adopt-safely** — `ssn_ciphertext = NULL, ssn_deleted_at = now` **in the same repo
   transaction that persists `doola_company_id`** (create_provider confirm/adopt). NOT earlier:
   a crash before `provider_ref` persists retries with the SAME idempotency key, and the rebuilt
   body must be byte-identical or doola answers `409 E_IDEMPOTENCY_KEY_REUSED` forever (verified
   contract). NOT later: nothing else needs it (the SS-4/EIN path runs at doola with what they
   hold).
5. **Terminal cleanup** — the sweeper's PII erasure extends to: `ssn_ciphertext` deleted whenever
   the company reaches `abandoned`, plus an absolute TTL (30 days) regardless of state, with an
   opsLog `formation_ssn_erased {companyId, reason}` (never the value).
6. **Key rotation** — `FORMATION_PII_KEY_PREVIOUS` accepted for decryption only (the dual-secret
   pattern from the webhook design).

## 5. Intake: names, purpose, NAICS

- **Names:** three candidates, each validated client- AND server-side: length, charset, required
  ending appended by doola, and a Wyoming forbidden/restricted-word list (`bank`, `insurance`,
  `trust`, `university`, …) shipped as data with a test; duplicates among the three rejected.
  Stored in `companies.name_options`; sent as doola's ranked `nameOptions`. The FILED name is
  read back from `getCompany` after `await_filing` confirms → `legal_name_filed` → manifest
  `legal.companyName` → every surface labels the company by it (never by the agent name).
- **Business purpose:** its own required field (min length, plain-language hint, goes on a state
  filing); the agent's `metadata.description` is no longer forwarded anywhere doola-visible.
- **NAICS:** picker fed by the (cached) doola reference endpoint; default remains 541511 but the
  user confirms it. Stored per company.
- **Labels (the original complaint):** the agent wizard's "Name" is agent-branding only, and says
  so; the company form's name field is titled "Company legal name — this is what Wyoming files";
  descriptions are two distinct fields with distinct explanations.

## 6. Payments (built now, OFF for beta)

Config: `FORMATION_PAYMENT_REQUIRED` (default false), `FORMATION_FEE_USDC` (e.g. "300"),
`FORMATION_REVENUE_ADDRESS` — boot invariants: required together when payment is on; revenue
address must differ from the executor and every platform operational key (S4 hygiene); payment
cannot be required in sandbox.

Flow (reusing the proven agent-payment rails, browser-side):
1. `POST /companies` with payment ON returns the company in `status='paying'` + a quote
   `{amountUsdc, payTo, reference: companyId, validUntil}`.
2. The wizard's payment step has the guardian sign an **EIP-3009 `transferWithAuthorization`**
   with wagmi (the exact primitive our x402 flow already settles), authorization bound to the
   quote amount + revenue address + a nonce derived from `companyId` (replay-proof, reference-
   bound — no fragile "match by amount" reconciliation).
3. The backend settles it through the existing facilitator path, records
   `formation_payments.settled` with the settlement id, flips the company to `forming`, and the
   sub-saga proceeds. `create_provider` REFUSES to run for a `paying` company (CAS-guarded), so
   no filing ever precedes its payment.
4. **Refunds are manual, v1**: `cli refund-formation <companyId>` prints the payment, requires an
   explicit flag, executes a USDC transfer from the revenue address, records
   `refunded` + tx. No automatic refund engine (a self-serve refund path is a new outflow attack
   surface and would need its own S5-style ceiling — deliberately out of scope).
5. **Quota interplay:** when payment is required, the free-tier per-tenant quota does not apply
   (payment is the brake); the platform daily ceiling REMAINS as the runaway guard.
6. Beta posture: flag off ⇒ the paying status/step is skipped entirely; copy says formation is
   included during beta.

## 7. Surfaces

- **APIs:** `POST /companies` (create: full intake, returns company + quote when paying),
  `GET /companies`, `GET /companies/:id` (detail incl. documents, calendar, attached agents),
  document download moves to `GET /companies/:id/documents/:docId` (entity route kept as an
  alias, deprecated). `POST /onboard` + MCP `onboard_agent`: `partyId` is REPLACED by
  `companyId`; MCP gains `create_company` / `list_companies` (schema mirrors REST; the
  formation-party tool folds into `create_company`). Mandatory-formation rule becomes: door
  requires a `companyId` (or inline creation) when `FORMATION_REQUIRED`.
- **Wizard:** the legal-identity phase becomes **"Legal body"**: if the tenant has usable
  companies → picker (default = most recent, with the shared-label warning and "form a new
  company instead"); else → the create form (names ×3, purpose, NAICS, party, conditional SSN,
  then payment step when ON). Sandbox keeps the one-click synthetic company. All gating via the
  existing `useFormationEnvironment` + `/config` (which gains `formationPaymentRequired`,
  `formationFeeUsdc`).
- **Companies section** (`/companies`): list + detail — filed name, status, filing number, EIN,
  documents (downloads), compliance calendar (the doola endpoint we already consume), attached
  agents, and the sharing label. The annual-report due date renders with an "handled by: (ask
  doola)" placeholder until the Halyna answer (§10).
- **Honest labeling:** every surface showing an agent whose company has >1 attached agent carries
  "shares its legal body with N other agents"; sandbox amber rules unchanged; a `paying` company
  renders "awaiting payment", never "forming".

## 8. Threat model (delta)

- **SSN**: encrypted before persistence (backups/Litestream carry ciphertext only); key not in
  the DB; adopt-safe deletion (§4); absolute TTL; log/view exclusion enforced by the existing
  PII-guard test pattern (typed, compile-time where possible). Residual: plaintext transits the
  API process memory + doola TLS call — accepted (unavoidable for a forwarder), stated honestly.
- **Payment forgery/replay**: EIP-3009 authorization is amount+recipient+nonce-bound; the nonce
  derives from `companyId` (one payment per company), settlement verified through the existing
  facilitator verification, not by watching transfers. Double-settlement blocked by the unique
  `formation_payments.company_id` row + CAS.
- **Reuse authorization**: `companyId` must be tenant-owned, environment-matched, and in a usable
  status — checked at the door AND at claim (the custody two-layer pattern).
- **Revenue custody**: dedicated address, never the executor; movements out of it are manual
  (refund CLI) — no automated outflow path exists.
- **Name-collision griefing**: three candidates bound at creation; a required-action for
  exhausted names surfaces to the owner only.
- **Migration**: refuses on ambiguity; never deletes source rows until the company row is
  verified complete.

## 9. Test plan (pattern-inherited)

Unit: company sub-saga re-key (all the PR-2/PR-3 crash-window + CAS suites re-pointed at
company scope); SSN — encryption round-trip, deletion in the provider_ref transaction (test the
409 trap explicitly: crash before persist → retry with same key + identical body succeeds),
TTL erasure, log/view exclusion (typed guard); name validation table tests; payment — quote/
authorization binding, settle-then-release CAS, refuse-create-while-paying, refund CLI dry-run;
reuse — ownership/environment/status matrix; migration — golden DB fixtures (a PR-4-era DB with
formed entities migrates losslessly; ambiguous fixture refuses). Interface: picker vs create
branch, label matrix (shared count, paying state, sandbox amber), payment step gating.
Integration (anvil + sandbox): company formed once, TWO entities attached, both anchor manifests
referencing the same docs; EIN late-arrival triggers both entities' v3 cycles. Live sandbox
smoke before merge (the standing rule): company-scoped keys verified against real doola.

## 10. Rollout + externals

- **PR A1** — schema + migration + company sub-saga re-key + company CRUD APIs (no UI change;
  `partyId` door contract kept working via a compatibility shim that auto-creates a 1:1 company).
- **PR A2** — production intake (names/purpose/NAICS/SSN) + MCP surface + labels backend-side.
- **PR A3** — wizard branch + Companies section + honest labels + document-route move.
- **PR B1** — payments (flag off) + revenue-address invariants + refund CLI.
- Each PR: Opus builds, 8-angle gate, live sandbox smoke where doola is touched. **Deployment to
  the box is a separate, deliberate decision** (the Sept-15 demo runs on today's proven state;
  nothing here deploys before it without an explicit call).
- **Externals (not blockers):** counsel session — N:1 document coherence, our terms-doc-vs-doola-
  OA duality, Wyoming Series LLC option, DAO supplement; Halyna — who files annual report/BOI
  under the packs + current FinCEN BOI status (likely exempt for domestic since 2025 — verify,
  don't build); doola volume answer for DAO API support once beta numbers exist.

## 11. Open questions

1. Fee amount + whether the Wyoming state fee is passed through visibly or bundled ($FORMATION_FEE_USDC covers both?) — pricing decision, config either way.
2. Company deletion/dissolution UX when the last agent detaches — out of scope here (dissolution
   is an existing on-chain path; the paperwork side goes on the counsel list).
3. Multi-member companies — explicitly OUT (single member = guardian, matches the locked legal
   model); revisit only with counsel.
