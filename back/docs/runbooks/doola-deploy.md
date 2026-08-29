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
# Any row here blocks the migration. Empty = the upgrade will run clean.
sqlite3 "$DATA_DIR/legalbody.db" \
  "SELECT entity_key, state, provider_ref FROM formation_requests
    WHERE step='create_provider'
      AND (state IN ('pending','submitted') OR (state='failed' AND provider_ref IS NULL));"
```

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
