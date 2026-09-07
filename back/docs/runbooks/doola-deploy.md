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
- **every existing client keeps working.** A party-only onboard (which is every client today) mints
  a 1:1 company inside the claim transaction — the A1 shim — so nothing about the wizard changes;
- **new doors:** `POST /companies` + `GET /companies`, and MCP `create_company` + `list_companies`.
  `POST /onboard` and `onboard_agent` now also take `companyId` to ATTACH an agent to a company
  that already exists. Attaching is free; only creating a company costs a filing.

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

**A bound formation party is always pinned and always filed. `FORMATION_REQUIRED` decides only
whether the door REFUSES an onboard that carries no party.**

This supersedes PR 2's decision #2, in which `FORMATION_REQUIRED=false` also meant "pin nothing".
That coupling had a hole: a caller who had posted a real legal identity and handed over its
`partyId` got an unpinned stub entity, and their party sat bound to an entity nothing would ever
file. The identity was silently dropped — which is exactly the failure
`formationUnavailableMessage` exists to prevent on a credential-less box.

## What each setting actually does

| `DOOLA_API_KEY` + `DOOLA_WEBHOOK_SECRET` | `FORMATION_REQUIRED` | Result |
|---|---|---|
| unset | (must be unset) | No formation anywhere. A `partyId` on an onboard is **refused**, never ignored. No webhook route, no sweeper. |
| set | `false` | Formation is **available, not mandatory**. An onboard with no `partyId` succeeds and files nothing. An onboard WITH a `partyId` is pinned and filed, and counts against the spend controls. |
| set | `true` (the default when the block is present) | An onboard **without** a `partyId` is refused at the door (REST 400 / MCP `isError`). `cli create-entity` refuses every request, because it cannot carry a party. |

### The doors, as of PR 3

There are **three**, and only the first two can onboard:

| Door | Carries a `partyId`? | With `FORMATION_REQUIRED=true` |
|---|---|---|
| REST `POST /onboard` (the wizard API) | yes | pins and files; refuses an onboard without one |
| MCP `onboard_agent` | yes | pins and files; refuses an onboard without one |
| `cli create-entity` | no — a separate process with no PII intake | **refuses at command time** (`legacyDoorRefusalMessage`) |

The standalone onboarding server (`src/onboarding/{server,main}.ts`) was **RETIRED in PR 3** and is
no longer a door: it had no auth, no World gate and no custody gate, and it bypassed `claimKey`,
the cross-process mutex that stops two runners minting the same entity. Nothing shipped depended
on it. If you are reading an older copy of this table that lists it, this row supersedes it.

`ARC_NETWORK=mainnet` forces the block present and `FORMATION_REQUIRED=true`; a mainnet
deployment cannot mint stub entities, and it cannot point at doola sandbox.

## Deploy note — the testnet box

**Run `FORMATION_REQUIRED=false` on the testnet box until the PR-4 wizard collects a legal
identity.**

The wizard (`interface/`) does not send a `partyId` today. With `FORMATION_REQUIRED=true` the door
refuses every wizard onboard, so the box's only working onboarding surface would be MCP/REST with
a hand-created party. With `false`:

- the wizard keeps working exactly as it did before formation existed, and pins nothing;
- an MCP or REST caller can opt in by creating a party (`POST /formation-party` or the
  `create_formation_party` tool) and passing its handle — that entity IS pinned and IS filed, in
  the environment the box is configured for;
- the sandbox end-to-end can be exercised on demand without every test agent costing a filing.

Boot says so out loud, and this warning is the one to look for in journald after a deploy:

```
⚠ doola formation ENABLED (sandbox, required=false)
⚠ FORMATION_REQUIRED=false — formation is AVAILABLE, not mandatory: an onboard is only pinned
  and filed when it carries a partyId, and the wizard does not send one yet
```

Without the second line, an operator who expected every new entity to become a Wyoming LLC would
only find out from an empty `formation_requests` table a week later.

## Flipping it on

When PR 4 lands the identity step in the wizard:

1. confirm the wizard sends `partyId` on `POST /onboard` (the `/config` response already
   advertises `formationRequired`, and the wizard branches on it);
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

## A2: the industry list

`src/formation/naicsLabels.ts` is a GENERATED build-time constant, and the create door accepts
only labels that are in it. **It currently holds one label** ("Software development", the only one
verified live against doola's reference table), because no sandbox key was available when A2 was
written. Before A3 ships the industry picker, run:

```
DOOLA_API_KEY=dk_test_… npx tsx scripts/refresh-naics.mts
```

and commit the result. The script refuses to write an empty list, and refuses to write one that no
longer contains `DEFAULT_INDUSTRY` — every migrated and shimmed company carries that label, so
losing it would make our own rows unedittable at our own door.

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

## Boot ordering (C4)

The formation sweeper starts **after** the HTTP port is listening, and its first loop iteration is
the boot reconcile. Nothing about doola is on the boot path: a doola outage must never be able to
delay `/healthz`, because a load balancer would mark the box down and fail the deploy for a reason
unrelated to whether the process can serve requests.
