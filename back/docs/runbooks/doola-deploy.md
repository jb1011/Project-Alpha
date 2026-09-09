# Runbook — deploying the doola formation provider

> Design: `back/docs/design/2026-08-19-doola-formation-provider-design.md` §2 (the pin), §5 (the
> doors), §7 (the sweeper), **superseded for the KEY by
> `back/docs/design/2026-08-26-formation-prod-ready-design.md` §2/§3/§7 (companies)**.
> Webhook receiver: `docs/runbooks/doola-webhooks.md`.
> Code: `back/backend/src/formation.ts`, `back/backend/src/formation/company.ts`,
> `back/backend/src/workflow/runner.ts`, `back/backend/src/api/main.ts`.

## ⚠ A1 (2026-08-26): the filing belongs to a COMPANY, not to an agent

Everything below still holds, with one substitution: a filing is keyed by a **company**, and
entities attach to it many-to-one. `formation_requests` is `(company_id, step)`, documents are
company-scoped, and the legal facts (`filed_at`, `filing_number`, `ein`, `legal_name_filed`) live
on the `companies` row rather than on `entities`.

What that changes for an operator:

- **the upgrade REFUSES to run while a create is in flight.** The boot throws, names the entity,
  and names the command below. That is not a bug: re-keying a live create rotates its idempotency
  key, and doola would file a SECOND real Wyoming LLC under a second real fee;
- **`npm run cli -- formation:abandon <entityKey>`** is the escape. It moves a parked
  `create_provider` row to `abandoned` (ops-logged, CRITICAL) so the migration can proceed, and it
  **refuses when the row holds a doola company id** — a create that reached doola is adopted, never
  abandoned by hand, because abandoning it is what erases the responsible party's data for a
  company that may really exist in Wyoming's records. Run it, then restart;
- **A1 kept every existing client working with a SHIM** — a party-only onboard minted a 1:1
  company inside the claim transaction. **A3 REMOVED IT.** `POST /onboard` and `onboard_agent`
  now take a `companyId` and nothing else: a `partyId` on either is REFUSED, with a message
  naming the door that mints a company. Every client that onboards has to create or pick a
  company first. See the door table below, which is the version to trust;
- **new doors:** `POST /companies` + `GET /companies` + `GET /companies/:id`, and MCP
  `create_company` + `list_companies` + `get_company`. Attaching is free; only creating a company
  costs a filing.

Before the upgrade, on the box:

```bash
# Run these against the PRE-migration shape (formation_requests is still entity-keyed here).
# Any row from either query blocks the migration. Empty from both = the upgrade will run clean.

# 1. A create still in flight. Re-keying it would file a SECOND real Wyoming LLC.
sqlite3 "$DATA_DIR/legalbody.db" \
  "SELECT entity_key, state, provider_ref FROM formation_requests
    WHERE step='create_provider'
      AND (state IN ('pending','submitted') OR (state='failed' AND provider_ref IS NULL));"

# 2. An entity that holds formation state but carries NO pin. `companies.environment` is what
#    routes a filing at sandbox or at production, and the migration will not invent one. Expected
#    to be empty: the claim writes the pin, the company and the party bind in one transaction.
#    A row here needs a human to set formation_provider/formation_environment deliberately (or to
#    erase the party bound to it) before the upgrade can run.
sqlite3 "$DATA_DIR/legalbody.db" \
  "SELECT e.idempotency_key, e.formation_provider, e.formation_environment
     FROM entities e
     LEFT JOIN formation_parties p
       ON p.entity_key = e.idempotency_key AND p.deleted_at IS NULL
    WHERE (e.formation_provider IS NULL OR e.formation_environment IS NULL)
      AND (p.party_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM formation_requests f WHERE f.entity_key = e.idempotency_key)
           OR EXISTS (SELECT 1 FROM documents d WHERE d.entity_key = e.idempotency_key))
    GROUP BY e.idempotency_key;"
```

After the upgrade, a synthesized company mirrors its legacy `create_provider` verdict: an
`abandoned` create yields an `abandoned` company (not attachable, not re-opened by the sweeper),
and everything else yields `ready`.

`formation:abandon` resolves its database through the same config the API does (`DATA_DIR`);
there is no `DB_PATH` override.

## The one sentence

**A company handle is always honoured. `FORMATION_REQUIRED` decides only whether the onboard door
REFUSES a request that carries none.**

This is PR 2's decision #2, superseded twice: first at party scope (a caller who posted a real
legal identity and handed over its `partyId` got an unpinned stub, and their identity was silently
dropped), then at COMPANY scope in A3, when the party stopped being an onboard-door concept at
all. A `companyId` on a `required=false` box is pinned and filed exactly as on a `required=true`
one; the flag is about the ABSENCE of a handle and nothing else.

## What each setting actually does

| `DOOLA_API_KEY` + `DOOLA_WEBHOOK_SECRET` | `FORMATION_REQUIRED` | Result |
|---|---|---|
| unset | (must be unset) | No formation anywhere. A `companyId` (or a `partyId`) on an onboard is **refused**, never ignored. No webhook route, no sweeper. |
| set | `false` | Formation is **available, not mandatory**. An onboard with no `companyId` succeeds and files nothing. An onboard WITH one attaches to that company, on any deployment. |
| set | `true` (the default when the block is present) | An onboard **without** a `companyId` is refused at the door (REST 400 / MCP `isError`). `cli create-entity` refuses every request, because it cannot carry one. |

### The doors, as of A3

**A3 removed the A1 shim.** Onboard ATTACHES; it never creates. Everything that spends money is
behind the company-create door, and a `partyId` at the onboard door is refused rather than
ignored — the field is still read (and still DECLARED in MCP's schema) precisely so that passing
one is a loud refusal instead of a silent strip.

| Action | REST | MCP | CLI |
|---|---|---|---|
| register a responsible person | `POST /formation-party` | `create_formation_party` | — |
| **edit** that person | `PATCH /companies/:companyId/party` | `update_company_party` | — |
| create a company (**spends**) | `POST /companies` | `create_company` | — |
| edit a company's intake (+ SSN) | `PATCH /companies/:companyId` | — (**never**: an SSN would sit in an LLM client's context) | — |
| list companies | `GET /companies` | `list_companies` | — |
| one company, in full | `GET /companies/:companyId` | `get_company` | — |
| compliance calendar | `GET /companies/:companyId/compliance` | — | — |
| legal documents | `GET /companies/:companyId/documents[/:docId]` | (metadata on the entity views) | — |
| the intake RULES (public) | `GET /formation/rules` | (industries named in `create_company`'s description, capped) | — |
| **attach** an agent (free) | `POST /onboard` with `companyId` | `onboard_agent` with `companyId` | **refuses** (`legacyDoorRefusalMessage`) |
| abandon a parked filing | — | — | `npm run cli -- formation:abandon <entityKey>` |
| read a formation payment | `GET /companies/:companyId/payment` | `get_company_payment` | — |
| settle it (guardian's signature) | `POST /companies/:companyId/payment/settle` | `submit_company_payment` | — |
| cancel a stuck one (2nd signature) | `POST /companies/:companyId/payment/cancel` | `cancel_company_payment` | — |
| re-quote once nothing is live | `POST /companies/:companyId/payment/requote` | `requote_company_payment` | — |
| resolve one payment from the chain | — | — | `npm run cli -- formation:reconcile <paymentId>` |
| RECORD a Ledger refund | — | — | `npm run cli -- formation:refund --payment-id <id> --tx <hash> --yes` |

The three ACTION doors (settle, cancel, re-quote) exist only where `FORMATION_PAYMENT_REQUIRED` is
on: REST answers 404 and the MCP tools are not registered at all, so an agent cannot discover a
tool whose every call would fail.

⚠ **The READ surfaces are NOT gated on the flag.** `GET /companies/:id/payment`,
`get_company_payment` and the Companies-page panel answer wherever a payment row exists, so
turning charging OFF after taking money does not make those payments invisible — a guardian who
paid $399 can still see it, and support has something to point at. Rolling a flag back must not
erase history. Such a payment carries no `quote` and a null `domain` (the token's domain is read
at boot only where the box charges), so nothing on it is signable.

Two of those doors are the exits from a PARKED filing, and each clears its OWN flag:
`PATCH /companies/:companyId` clears `awaitingIntakeEdit`, `PATCH /companies/:companyId/party`
clears `awaitingPartyEdit`, and neither touches the other's. `GET /companies/:companyId` is where
an operator (or the owner) sees which park a company is in, including the §4.6a SSN decision,
which is not a flag at all.

⚠ **The party-edit door is addressed by COMPANY, not by party handle.** It took a `partyId` first,
which meant a mistyped uuid could rewrite the responsible person of a DIFFERENT company mid-filing
— the only thing in the way was the freeze, which an unopened filing passes. The party is now
RESOLVED from the company's UNIQUE `company_id`, so touching another company's person is not a
request this API can express, and the browser form no longer has to ask a human to paste a handle
no surface ever serves back. An UNBOUND party (registered, never spent on a company) therefore has
no edit door: it has no filing, no park and nothing to correct, and the C7 sweep erases it after
seven days.

⚠ **An unchanged party edit is REFUSED** (`partyUnchangedMessage`). SQLite's `changes` counts rows
MATCHED, not rows whose values differ, so re-submitting the details already on file used to clear
the park and hand doola a retry of the exact body it refused. The freeze also rides in the
`UPDATE formation_parties` WHERE clause now (`PARTY_EDIT_ALLOWED_SQL`), not only above the write.

⚠ **`GET /formation/industries` was RENAMED to `GET /formation/rules`** in the same phase, and it
now serves the four intake limits (`nameOptionCount`, `nameMaxLength`, `purposeMaxLength`,
`nameCharset`) beside the labels — the interface used to mirror those as constants of its own.
Wyoming's restricted words stay server-only: the matcher is the rule, not the data. The route is
ETag-validated, and the Vercel proxy forwards `if-none-match`/`etag` for that one path.

⚠ **The wizard's localStorage key moved to `pa-onboarding-v3`.** A v2 blob is migrated once on
read: the phase `legal-identity` becomes `legal-body`, `done["legal-identity"]` is dropped (its
product was a party handle, which is no longer what "the legal body is settled" means), and
`partyId`/`partySynthetic` are dropped with it. A v2 session that carried a party and no company
is sent back to the legal-body step on any deployment that forms. "Start over" clears both keys.

⚠ **The document routes MOVED in A3**, from `/entities/:id/documents…` to
`/companies/:companyId/documents…`, with no alias. Anything pointing at the old path — a bookmark,
a script, a monitoring probe — gets a 404. The interface's proxy predicates moved with them, and
`interface/test/proxyHeaders.test.ts` imports and RUNS those predicates against real paths, so a
half-done rename fails CI. (The backend's text-scraped version of that guard is gone: its failure
mode was that the extractor stopped matching and it passed vacuously.)

The standalone onboarding server (`src/onboarding/{server,main}.ts`) was **RETIRED in PR 3** and is
no longer a door: it had no auth, no World gate and no custody gate, and it bypassed `claimKey`,
the cross-process mutex that stops two runners minting the same entity. Nothing shipped depended
on it. If you are reading an older copy of this table that lists it, this row supersedes it.

`ARC_NETWORK=mainnet` forces the block present and `FORMATION_REQUIRED=true`; a mainnet
deployment cannot mint stub entities, and it cannot point at doola sandbox.

## Deploy note — the testnet box

**Keep `FORMATION_REQUIRED=false` on the testnet box.**

A3's wizard DOES collect a legal identity and DOES create a company, so `true` is finally a
workable setting — but `false` is still the right one on testnet, for the reason it always was:
every filing costs a real fee even in sandbox terms of operator attention, and with `false`:

- the wizard's legal-body phase is an OPTION rather than a gate, so an agent can be onboarded
  without one;
- a caller who does supply a `companyId` is pinned and filed exactly as on a `required=true` box;
- the sandbox end-to-end can be exercised on demand without every test agent costing a filing.

⚠ On `true`, EVERY onboard now needs a company — including any script that used to pass a
`partyId`. That combination is refused since A3.

Boot says so out loud, and this warning is the one to look for in journald after a deploy (its
wording still says "partyId"; since A3 the handle is a `companyId`):

```
⚠ doola formation ENABLED (sandbox, required=false)
⚠ FORMATION_REQUIRED=false — formation is AVAILABLE, not mandatory: an onboard is only pinned
  and filed when it carries a partyId, and the wizard does not send one yet
```

Without the second line, an operator who expected every new entity to become a Wyoming LLC would
only find out from an empty `formation_requests` table a week later.

## Flipping it on

When the wizard's legal-body step is live (A3):

1. confirm the wizard sends **`companyId`** on `POST /onboard` (the `/config` response already
   advertises `formationRequired`, and the wizard branches on it). ⚠ NOT `partyId`: A3 removed the
   A1 shim, so the onboard door ATTACHES and never creates, and a `partyId` there is REFUSED
   rather than ignored — a checklist that told an operator to look for one would have them
   confirming the exact field that now fails the door;
2. set `FORMATION_REQUIRED=true` and restart;
3. check the boot line no longer carries the second warning;
4. onboard one agent end-to-end and confirm `formation_requests` has four rows for it and
   `create_provider` reaches `confirmed`.

Nothing about entities already minted changes: the pin is stamped at the claim and is immutable
after (audit M5), so an entity minted while the flag was `false` — with or without a party — keeps
whatever it was pinned to, forever.

## Spend controls

`FORMATION_MAX_PER_TENANT` (default 3) and `FORMATION_DAILY_CEILING` (default 10) are checked
before any row is minted, **whenever a company would be created** — on every deployment,
`required` or not. An opt-in filing costs the same $100–150 as a mandatory one.

Since A1 the two count different things, on purpose:

- the **per-tenant quota** counts CHARGEABLE COMPANIES (`status='ready'`, or carrying a live
  payment). Drafts do not count: with payment on, a company can sit in draft for days, and an
  abandoned form must not exhaust a real quota;
- the **daily ceiling** counts `create_provider` ROWS — where the fee is actually incurred —
  including FAILED ones, deliberately: a create that failed after doola committed has already cost
  a real company and a real fee.

`FORMATION_MAX_AGENTS_PER_COMPANY` (default 10) bounds how many agents may share one filing. Each
attached agent is its own anchor sequence per late fact — two sponsored on-chain writes through
its own timelock, plus a guardian notification — so an EIN arriving on a ten-agent company is
about 60 transactions (~$0.54 at the measured $0.009/op).

`WORLD_MAX_COMPANIES_PER_HUMAN` bounds FILINGS per verified human, separately from
`WORLD_MAX_ENTITIES_PER_HUMAN`, which bounds agents. **Production formation (`DOOLA_ENVIRONMENT=
production`) BOOT-FAILS** without all three `WORLD_*` credentials, without
`WORLD_REQUIRE_GUARDIAN`, and without `WORLD_MAX_COMPANIES_PER_HUMAN`: the guardian gate silently
passes everyone when the World block is only half-configured, so the invariant asserts the wired
dependency rather than the env strings.

## A2: `FORMATION_PII_KEY` — the SSN encryption key

Production formation collects the responsible party's SSN on the same request that mints the
company, encrypts it immediately (AES-256-GCM, per-record IV, AAD = `party_id || company_id`), and
deletes it in the transaction that records the doola company id. This is the key that does it.

**It is a boot invariant.** `DOOLA_ENVIRONMENT=production` refuses to start without it. A sandbox
deployment refuses to start WITH it — a sandbox box refuses the SSN field outright, so a key there
is at best dead weight and at worst a production key pasted into the wrong `.env`.

### Generating one

```
openssl rand -base64 32
```

32 bytes, base64 or hex. Anything that does not decode to exactly 32 bytes fails at boot with the
variable named. The key's ID (a truncated SHA-256 of the material, prefixed `fpk1:`) appears in the
boot log and in the ops trail; the material never does — `redact()` covers it, which matters
because an un-redacted `Buffer` stringifies to its bytes.

### Rotating

Rotation is a two-key window, and it is a LOOKUP rather than a trial decrypt: every stored row
names the key it was written with, so the previous key is *selected* for the rows that need it.

1. generate a new key;
2. set `FORMATION_PII_KEY` to the NEW key and `FORMATION_PII_KEY_PREVIOUS` to the one being
   retired. **Both, in one restart** — `_PREVIOUS` alone is refused at boot, and the same key in
   both slots is refused too (that is a rotation somebody believes they have done);
3. restart. New captures use the new key immediately; existing rows keep decrypting under the old
   one. In practice the window is short: an SSN's whole life is from the create-company request to
   the moment doola returns a company id, and any that outlive 7 days without a filing are erased
   by the sweeper;
4. once `SELECT COUNT(*) FROM formation_parties WHERE ssn_key_id = '<old id>'` is zero, drop
   `FORMATION_PII_KEY_PREVIOUS` and restart again. Two distinct key ids in the ops trail is how
   you can see the rotation actually happening.

### If the key is LOST

Every SSN written under it is unrecoverable, permanently. That is the intended property of the
scheme, and the consequences are bounded but real:

- companies whose filing already returned a company id lose NOTHING: their SSN was deleted at that
  moment. This is the overwhelming majority of rows;
- a company whose create is still in flight — sent under a live idempotency key, no company id
  back — will PARK with `formation_ssn_unreadable` (CRITICAL) rather than re-send. It cannot send
  the body without the SSN (a different body under a live key is a 409 `E_IDEMPOTENCY_KEY_REUSED`)
  and it must not re-key (that would file a SECOND real Wyoming LLC). Resolve it by restoring the
  key as `FORMATION_PII_KEY_PREVIOUS`, or — only if the key is genuinely gone —
  `npm run cli -- formation:abandon <entityKey>` and re-file with a fresh intake.

**Back the key up where you back up the JWT secret and the doola API key, and nowhere else.**

### What this key does and does not defend

Stated honestly, because the runbook is where an operator forms their mental model: the key lives
in the same `.env` as everything else on the box. Encryption at rest here defends the
**Litestream→R2 replica** and any copy of the database file that leaves the machine. It does not
defend against a compromised box. The controls that do the work there are the short retention (the
SSN exists for minutes in the happy path) and the fact that it is forwarded exactly once.

### The SSN's clocks (design §4.6a)

Two, and they are separate on purpose:

| Trigger | What happens |
|---|---|
| `provider_ref` persisted (create or adopt) | SSN erased in the SAME transaction. `formation_ssn_erased` with `reason: provider_persisted`. |
| Company terminal (`abandoned`, or `create_provider` `confirmed`/`abandoned`) | SSN erased by the sweeper. `reason: terminal`. The `confirmed` arm is an idempotent backstop to the row above. |
| SSN older than 7 days AND the filing never reached doola | SSN erased. `reason: ttl`. |
| Day 7, filing DID reach doola, still no company id | **Nothing is erased.** `formation_stale` (CRITICAL) + a required-action event on every attached agent. A NULL `provider_ref` is not proof no company exists at doola, and an erased party makes the adopt path unrecoverable. |

**No clock ever sets `abandoned`.** That still has exactly three writers: draft expiry (B1), the
max-attempt path, and `formation:abandon`.

Useful queries:

```sql
-- how many SSNs are we holding right now, and under which key?
SELECT ssn_key_id, COUNT(*) FROM formation_parties
 WHERE ssn_ciphertext IS NOT NULL GROUP BY ssn_key_id;

-- anything stuck past its clock (should be empty; each row is a formation_stale alert)
SELECT p.company_id, c.created_at
  FROM formation_parties p JOIN companies c ON c.company_id = p.company_id
 WHERE p.ssn_ciphertext IS NOT NULL
   AND c.created_at < datetime('now', '-7 days');
```

## The industry list

`src/formation/naicsLabelsData.ts` is a GENERATED build-time constant, and the create door accepts
only labels that are in it. A2 shipped it holding ONE label ("Software development", the only one
verified live against doola's reference table at the time); it was refreshed for A3 on 2026-09-07
and now holds doola's full table, **821 labels**. To refresh it again:

```
DOOLA_API_KEY=dk_test_… npx tsx scripts/refresh-naics.mts
```

and commit the result. The script refuses to write an empty list, and refuses to write one that no
longer contains `DEFAULT_INDUSTRY` — every migrated company carries that label, so losing it would
make our own rows unedittable at our own door.

Three surfaces read the list, and all three read the SAME array: the REST refusal and the MCP tool
description name it CAPPED at eight plus a count (uncapped, 821 labels is an error nobody reads and
a tool description that crowds out every other tool in an agent's context window), and A3's form
reads it whole from **`GET /formation/rules`** — public, day-cacheable, ETag-validated, and deliberately not a
`/config` field, since `/config` is fetched by every page before auth and cached for the life of
the tab.

## A2: the SSN wire shape cannot be smoke-tested

Every other consequential doola contract here was settled by a sandbox probe. The SSN cannot be: a
sandbox deployment refuses the field by invariant and the synthetic fixture omits it by design, so
there is no way to send a real SSN to a sandbox and no way to send a fake one to production. It is
pinned against doola's published OpenAPI instead — `test/adapters/doola/ssnWireShape.test.ts`
records the field, its format (`XXX-XX-XXXX`) and the date it was fetched. **If doola changes the
field, that file is where the change gets recorded.**

## A1 merge gates — the three things a human still has to run

None of these can be a test: two of them cost real sandbox companies and need a live key, and no
test in this repo makes a live doola call.

1. **`npx tsx scripts/doola-filed-name-probe.mts`** — files a sandbox company with THREE distinct
   name candidates, completes it through the playground, and prints which surface actually
   carries the accepted name (list item `.name` / full `.nameOptions` / the AOO document). Until
   this is recorded, the §5 matcher is pointed at the list item on the strength of one 2026-08-27
   observation, and `legal_name_filed` stays NULL whenever it does not match — which is honest,
   but it means `manifest.legal.companyName` never appears.
2. **`npx tsx scripts/doola-idempotency-reorder-probe.mts`** — one request settles whether
   doola's idempotency comparison is byte-wise or semantic: same key, same values, keys
   reordered. A `409` means the stored body must be replayed VERBATIM, which is what makes
   intake immutability and the frozen `expedited` flag load-bearing rather than tidy.
3. **The FormationE2E_1 run, captured as a runbook artifact.** It is the migration's golden
   fixture: the fixtures in `test/persistence/companyMigration.test.ts` are built from a frozen
   copy of the PR-4 schema, and the capture is what proves that copy matches the box.

Both probes are sandbox-only by construction (they refuse a key that is not `dk_test_…`) and read
`DOOLA_API_KEY` from the environment, writing it to no file.

## B1: FORMATION PAYMENTS — the whole procedure (design §6)

**Shipped OFF.** With `FORMATION_PAYMENT_REQUIRED` unset, every company lands `ready` exactly as
it does today, no `formation_payments` row is ever written, `hasLivePayment` keeps answering
false, and the wizard says formation is included during the beta. Nothing below is live until the
flag is deliberately set.

### The four env vars

| Variable | Default | What it is |
|---|---|---|
| `FORMATION_PAYMENT_REQUIRED` | **false** | Whether a company must be paid for before it can be filed. Nothing derives it on — unlike `FORMATION_REQUIRED`, which turns itself on with the provider. |
| `FORMATION_FEE_USDC` | `399` | The all-in fee in WHOLE dollars. Public: served on `/config` and rendered verbatim. The Wyoming state fee ($100, outside doola's pack) is a BREAKDOWN LINE in copy, never added at checkout. |
| `FORMATION_REVENUE_ADDRESS` | — | The Ledger account. Required when payment is required. |
| `FORMATION_SETTLE_SUBMITTER_KEY` | — | The DEDICATED EOA that submits guardians' authorizations. Required when payment is required. Its own nonce space, its own USDC gas float, no authority anywhere. |
| `FORMATION_QUOTE_TTL_MS` | `1800000` | How long a QUOTE stands (30 min) — the countdown a guardian is shown, and the deadline the settle door enforces. |
| `FORMATION_SETTLE_GRACE_MS` | `900000` | How much longer the AUTHORIZATION stays valid (15 min). `validBefore = TTL + this`, so a signature given at the last second still has time to be broadcast, mined and (after a crash) re-composed. |

### ⚠ S4 KEY INVENTORY — the revenue address

`FORMATION_REVENUE_ADDRESS` **is a Ledger hardware-wallet account, and NO PRIVATE KEY FOR IT
EXISTS ON THE BOX.** It is receive-only. That is the decision (2026-08-27), and it is what makes
every other rule here follow:

- the box can never move formation revenue, so a compromise of the server cannot drain it;
- refunds are therefore signed by a human at the device (below) and only RECORDED here;
- three boot invariants enforce the separation and refuse to start otherwise: the address must not
  equal the EXECUTOR (`PLATFORM_PRIVATE_KEY`), must not equal any other key in the env set
  (`CUSTOMER_`, `OPERATOR_`, `JOB_CLIENT_`, `JOB_EVALUATOR_`, `X402_PROOF_AGENT_`,
  `ENS_GATEWAY_SIGNER_`, `WORLDCHAIN_SUBMITTER_`), and must not be any agent operator, rotated-away
  operator or pocket address in the database.

Add it to the S4 inventory as: **formation revenue — Ledger, receive-only, no key on any server,
holder: Martin.**

### ⚠ S4 KEY INVENTORY — the settle submitter

`FORMATION_SETTLE_SUBMITTER_KEY` is a **dedicated hot EOA on the box whose only job is to submit
`transferWithAuthorization` and `cancelAuthorization`**. It is deliberately NOT the platform key:

- **nonce space.** The platform key signs registry writes, sweeps and job transactions. Two
  producers on one nonce lets unrelated traffic starve or replace a settle at the moment a
  guardian is watching a spinner;
- **gas.** On Arc the gas token IS USDC, so this address holds a small, visible, single-purpose
  float. **Keep it funded** — a dry submitter does not fail loudly, it leaves payments `settling`
  with authorizations already signed. The boot line prints the address and its balance, and warns
  below ~1 USDC;
- **authority.** It has none. Not the factory owner, not the controller, not a treasury signer.
  A compromise wastes gas and nothing more, which is the point of separating it.

Boot refuses it if it equals `PLATFORM_PRIVATE_KEY`'s address, `FORMATION_REVENUE_ADDRESS`, any
other key in the env set, or any agent operator / rotated-away operator / pocket address in the
database.

Add it to the S4 inventory as: **formation settle submitter — hot EOA on the API box, gas-only,
no authority, funded with a few USDC.**

### Flip-on checklist

Run in this order. Steps 1–3 are refused at boot if they are wrong, which is the point.

0. **This box must be able to FILE.** `DOOLA_API_KEY` + `DOOLA_WEBHOOK_SECRET` present, i.e.
   `canFormEntities`. Charging without them is refused at boot: every formation door is closed
   behind that predicate, so the fee would be the only thing on the box that worked.
1. **The identity floor must already be satisfied** — `WORLD_APP_ID` + `WORLD_RP_ID` +
   `WORLD_RP_SIGNING_KEY` all present, `WORLD_REQUIRE_GUARDIAN=true`,
   `WORLD_MAX_COMPANIES_PER_HUMAN` set. Charging is production formation whatever the provider
   credentials say, so the floor now fires on the payment switch as well as on
   `DOOLA_ENVIRONMENT`. A box that charges without it is anonymous USDC buying real Wyoming LLCs.
2. **`DOOLA_ENVIRONMENT=production`.** A sandbox filing is a DEMO-watermarked record that is not a
   legal body, and the invariant refuses to boot rather than let one be charged for. It is keyed
   on the raw value, so the box with no doola credentials at all (whose value is the `sandbox`
   DEFAULT) is covered too.
3. **Set `FORMATION_REVENUE_ADDRESS`** to the Ledger account and confirm it against the device
   before restarting. It is printed in the boot line — `redact()` does not hide it, deliberately,
   because this is exactly the value an operator must be able to check.
3b. **Generate `FORMATION_SETTLE_SUBMITTER_KEY`** — a fresh key used for nothing else — and fund
   its address with a few USDC for gas. The KEY is redacted from the boot log; the ADDRESS and its
   balance are printed. If it collides with anything this box signs with, the boot refuses.
4. **The gas constants are already PINNED from the live probe** (2026-09-09, Arc testnet):
   `TRANSFER_WITH_AUTHORIZATION_GAS = 140_000` (measured 117,079) and
   `CANCEL_AUTHORIZATION_GAS = 86_000` (measured 71,265), in `src/adapters/arc/gas.ts`. Nothing to
   do unless the token is upgraded — in which case re-run `scripts/formation-settle-probe.mts` and
   set each to the new figure plus ~20%. Transcript and what it establishes:
   `docs/runbooks/formation-settle-probe-2026-09.md`.
5. `FORMATION_PAYMENT_REQUIRED=true`, restart, and confirm the boot line:
   `⚠ FORMATION PAYMENTS ENABLED: $399 USDC to 0x… (USDC domain "USDC" v2, pinned on-chain)`,
   and the line after it naming the settle submitter and its gas balance.
   The domain is READ from the token and checked against its own `DOMAIN_SEPARATOR()` at boot — a
   box that cannot read it does not start, which is better than one that quotes a price for a
   signature it could not settle.
6. Create one company end to end and watch the ops trail:
   `formation_payment_quoted` → `formation_payment_settling` → `formation_payment_settled`, then
   the company moving `draft → ready` and `create_provider` opening.

### The manual refund procedure

There is **no fund-moving refund path in the software, by design.** To refund a formation fee:

1. **Decide and record why**, outside this system (the fee is real money and the decision is not
   the software's).
2. **Read the payment** you are refunding — `GET /companies/:companyId/payment`, or:
   ```sql
   SELECT payment_id, status, amount_usdc, payer_address, tx_hash
     FROM formation_payments WHERE company_id = '<companyId>' ORDER BY created_at DESC;
   ```
   `payer_address` is where the money came from and is where it goes back. `amount_usdc` is
   ATOMIC (6 decimals): 399000000 = $399.
3. **Sign the transfer from the Ledger.** A plain USDC transfer on Arc from
   `FORMATION_REVENUE_ADDRESS` to `payer_address` for exactly `amount_usdc`. Confirm the
   destination on the DEVICE SCREEN, not in the wallet UI.
4. **Record it**, so the system stops believing the fee was kept:
   ```
   npm run cli -- formation:refund --payment-id <paymentId> --tx <ledgerTxHash>        # prints, records nothing
   npm run cli -- formation:refund --payment-id <paymentId> --tx <ledgerTxHash> --yes  # records it
   ```
   It moves nothing. Without `--yes` it PRINTS the payment, the payer, the amount and the two
   hashes and writes nothing — read that before confirming. With `--yes` it flips that `settled`
   row to `refunded`, stores the hash beside the settlement hash, and writes a CRITICAL
   `formation_payment_refunded` ops line.

   It **names the PAYMENT, never the company**: a company with two settled rows is the double
   charge, and "the most recent settled row" would be a guess made silently about somebody's $399.
   It refuses a malformed hash (that hash is the only record of the transfer you just signed), a
   row that is not `settled` (run `formation:reconcile` first and let the chain say so), and a
   second recording — naming the hash already on the row, so an operator who re-runs it does not
   read "no settled payment" and go and make a second transfer.
5. ⚠ **The refund is NOT a platform outflow and never enters `platform_outflows`.** A 399 USDC row
   in the S5 meter would exceed the 200 USDC rolling ceiling on its own and block every agent's
   treasury funding, gas seeds and job funding for 24 hours — a refund taking the fleet down. The
   `formation_refund` outflow path arrives only with the later hot-float phase, together with an
   env invariant that `PLATFORM_OUTFLOW_CEILING_USDC >= FORMATION_FEE_USDC`.
6. The company stays `ready` and its filing is untouched. Refunding does not un-file a Wyoming
   LLC, and pretending otherwise in the data would be the dishonest part.

### Reconciling ONE payment against the chain

```
npm run cli -- formation:reconcile <paymentId>
```

It runs the same log-based resolver the sweeper does — `AuthorizationUsed` + a matching `Transfer`
to the payee, or `AuthorizationCanceled`, filtered on both indexed topics over a bounded window —
PRINTS what the chain said, and only then writes:

- **settled** → the row goes `settled` with the OBSERVED transaction hash (which may not be ours:
  a signed authorization is public, and anyone holding it can mine it) and the company moves
  `draft → ready`. If the company then has more than one paid row it says so, CRITICAL;
- **cancelled** → the row goes `expired`, and the guardian can re-quote;
- **unknown** → **nothing is written**. A payment whose outcome nobody can see is exactly the one
  that must not be written off.

### ⚠ If `formation_payment_duplicate` appears

A CRITICAL ops line (and an event on every agent attached to the company) saying one company has
more than one `settled`/`refunded` payment. It is written on every terminal transition and by an
amortised sweep, and it is the measurement behind everything else here — the invariants are an
argument that this cannot happen, and an argument is not a measurement.

It changes nothing on its own, deliberately: reversing money automatically on the strength of a
COUNT would be a worse bug than the one it watches for. Read both rows
(`formation:reconcile <paymentId>` on each if their state is unclear), decide, refund the
duplicate from the Ledger by the procedure above, and record it against **that payment id**.

### When a payment is stuck

| What you see | What it means | What to do |
|---|---|---|
| `quoted`, past its TTL | The guardian never signed, or signed too late. | Nothing, for a few minutes. The row can only be expired once the CHAIN's clock is past `validBefore` (TTL + grace) by the 120-second finality margin, because an authorization signed at the last second is still live. The guardian may cancel to skip the wait, then re-quote. |
| `settling`, `formation_payment_pending` lines | Broadcast, outcome not observed. | Nothing, at first. The sweeper re-broadcasts the PERSISTED bytes each pass with backoff. **Never re-quote:** the signature is still live and a second one is a double charge. |
| `settling` for a long time, guardian waiting | The bytes may never have been accepted (e.g. the executor's nonce moved past them). | The guardian signs a `CancelAuthorization` in the UI (`POST /companies/:id/payment/cancel`); the executor submits it and the row expires at once. Then re-quote. |
| `failed` | The transfer REVERTED on chain — usually an insufficient USDC balance. | The guardian re-quotes and pays again. Nothing was taken. |

### B1 merge gate — the live probe

```
PROBE_GUARDIAN_PRIVATE_KEY=0x…   # a TEST EOA holding a few testnet USDC
PROBE_REVENUE_ADDRESS=0x…        # a test destination, NOT the production Ledger
npx tsx scripts/formation-settle-probe.mts
```

It builds the quote's typed data from the REAL on-chain domain, signs it as the guardian, verifies
it through the same shared helper the settle route uses, submits `transferWithAuthorization` via
the executor path, confirms the receipt, reads back `authorizationState == true`, prints the
`gasUsed`, and then signs and submits a `cancelAuthorization` for a SECOND unused nonce and
confirms that too. It refuses any chain id that is not Arc testnet.

The two `gasUsed` figures it prints are the ones step 4 of the flip-on checklist already carries —
see `docs/runbooks/formation-settle-probe-2026-09.md` for the 2026-09-09 run, including the finding
that Arc's token reports `name: "USDC"` and not the `"USD Coin"` every reference implementation
quotes.

## Boot ordering (C4)

The formation sweeper starts **after** the HTTP port is listening, and its first loop iteration is
the boot reconcile. Nothing about doola is on the boot path: a doola outage must never be able to
delay `/healthz`, because a load balancer would mark the box down and fail the deploy for a reason
unrelated to whether the process can serve requests.
