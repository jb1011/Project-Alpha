# FormationE2E_1 — the golden run (testnet box, doola sandbox), 2026-08-26 → 2026-08-29

The first end-to-end formation on the prod-testnet box under the PR-4 (entity-keyed) schema: a
wizard-created agent, a real doola sandbox company, three documents, and all three OA-bundle
manifest versions anchored on Arc testnet through the NoviController timelock. It is the migration's
golden fixture for A1 (`2026-08-26-formation-prod-ready-design.md` §10): the fixture tests build a
pre-migration DB from a frozen copy of the PR-4 schema, and this capture is what proves that copy
matches a box that actually ran it.

## Identity

| What | Value |
|---|---|
| Entity key | `0x172B7952b0F711b8B372410E81d51Dcba7D4BB02:a0d22e9a-37a5-48ef-bdcd-b2bbb9c8e763` |
| doola company | `3IRxPLrPz7JBWH2PF6WF6UMCfT2` (sandbox, `FormationE2E_1 LLC`, WY) |
| Filing number | `PLAYGROUND-FILING`, filing date 2026-08-26 |
| EIN | `12-3456789` (sandbox fixed value), issued via the playground 2026-08-29 |
| Deployment | `DOOLA_ENVIRONMENT=sandbox`, `FORMATION_REQUIRED=false`, box `novi-prod`, main at `e7a8ebb` (#103) |

## Timeline (from `journalctl -u legalbody-api`, UTC)

| At | Event |
|---|---|
| 08-26 10:45:43 | `oa_anchors` v1 created at `createEntity` (manifest `0x68b065cfe6e7…`), executed in the creation tx |
| 08-26 10:45:55 | `create_provider` submitted (attempt 0) |
| 08-26 10:45:57 | `create_provider` confirmed, `provider_ref = 3IRxPLrPz7JBWH2PF6WF6UMCfT2` |
| 08-26 10:46:00 | webhook `company_formation_submitted` (event `3IRxPfzX…`) → `doola_webhook_unknown_event` (not a name the receiver acts on; wake-up only, redelivered 10:46:12, both acknowledged) |
| 08-26 10:48:32 | webhook `company_formation_completed` (`3IRxiwjr…`) → `await_filing` confirmed |
| 08-26 10:48:33 | `ArticlesOfOrganization` stored (doola doc `3IRxivkanrmn01t4kXnK9xHQ6Gu`, sha256 `4bf0c7c90f51…`) |
| 08-26 10:48:35 | webhook `document_aoo_uploaded` (`3IRxjGRH…`) |
| 08-26 10:48:36 | `OperatingAgreement` stored (doc `3IRxjJGkBlezYxZg76keyGtGTcK`, sha256 `b4f6c48519ba…`); `fetch_documents` confirmed; **v2 opened** (manifest `0x1f2e352fb6c4…`) |
| 08-26 10:48:36 | webhook `document_operatingagreement_uploaded` (`3IRxjOZ9…`) |
| 08-26 10:48:38 | v2 `scheduleOaAmendment` broadcast, tx `0xc4b70322846e0d9c…` |
| 08-26 10:48:42 | v2 scheduled (1h timelock) |
| 08-26 11:49:00 | v2 `executeOaAmendment` broadcast, tx `0x35ed374a804cb83e…` |
| 08-26 11:49:04 | **v2 executed** |
| 08-29 10:42:14 | playground `eincreation/complete` fired by the operator → webhook `company_ein_issued` (`3IaQKK9e…`) |
| 08-29 10:42:15 | `EinLetter` stored (doc `3IaQKRctuxBYmQKOSrsd2JK3yAZ`); `await_ein` confirmed; **v3 opened** (manifest `0xd6e2c0e840db…`) |
| 08-29 10:42:17 | webhook `document_einletter_uploaded` (`3IaQKhpq…`) |
| 08-29 10:42:18 | v3 schedule broadcast, tx `0x9375a5e5897798f1…`; scheduled 10:42:22 |
| 08-29 11:42:34 | v3 execute broadcast, tx `0x6b77688c655a4afb…` |
| 08-29 11:42:38 | **v3 executed** — the run is complete |

Eight seconds from the EIN webhook to the v3 schedule broadcast, unattended. Every advance was
webhook-woken and fact-refetched; no payload was trusted.

## Rows on the box after the run (PR-4 schema)

`formation_requests` (entity-keyed PK):

| step | state | attempt | provider_ref | created_at | updated_at |
|---|---|---|---|---|---|
| create_provider | confirmed | 0 | 3IRxPLrPz7JBWH2PF6WF6UMCfT2 | 2026-08-26 10:45:55 | 2026-08-26 10:45:57 |
| await_filing | confirmed | 0 | | 2026-08-26 10:45:55 | 2026-08-29 10:42:22 |
| fetch_documents | confirmed | 0 | | 2026-08-26 10:45:55 | 2026-08-29 10:42:22 |
| await_ein | confirmed | 0 | | 2026-08-26 10:45:55 | 2026-08-29 10:42:15 |

Note the `updated_at` of the two already-confirmed steps was re-stamped by the 08-29 webhook
advance. That is the observation behind design finding #19 (`facts_updated_at`): `updated_at` is
not a fact clock.

`documents` (entity-keyed id + path; `oa_hash` empty):

| doc_type | provider_doc_id | sha256 (prefix) | path |
|---|---|---|---|
| ArticlesOfOrganization | 3IRxivkanrmn01t4kXnK9xHQ6Gu | 4bf0c7c90f516254a08… | `doc-0x172B…-ArticlesOfOrganization-3IRxivkanrmn01t4kXnK9xHQ6Gu.pdf` |
| OperatingAgreement | 3IRxjJGkBlezYxZg76keyGtGTcK | b4f6c48519ba2696c9d… | `doc-0x172B…-OperatingAgreement-3IRxjJGkBlezYxZg76keyGtGTcK.pdf` |
| EinLetter | 3IaQKRctuxBYmQKOSrsd2JK3yAZ | 4bf0c7c90f516254a08… | `doc-0x172B…-EinLetter-3IaQKRctuxBYmQKOSrsd2JK3yAZ.pdf` |

(The sandbox EIN letter and the sandbox AOO are the same placeholder PDF bytes, hence the equal
sha256; a real filing produces distinct documents.)

`oa_anchors`:

| version | state | manifest_hash (prefix) | created_at | updated_at |
|---|---|---|---|---|
| 1 | executed | 0x68b065cfe6e7 | 2026-08-26 10:45:43 | 2026-08-26 10:45:43 |
| 2 | executed | 0x1f2e352fb6c4 | 2026-08-26 10:48:36 | 2026-08-26 11:49:04 |
| 3 | executed | 0xd6e2c0e840db | 2026-08-29 10:42:15 | 2026-08-29 11:42:38 |

## What the A1 migration must do with exactly these rows

- Synthesize ONE `companies` row for the entity (formed: `provider_ref` set, all four steps
  confirmed), status `ready`, `intake_synthesized = 1`, `name_options =
  companyNameOptions("FormationE2E_1")` → `[{name: "FormationE2E_1", entityTypeEnding: "LLC",
  position: 1}]`, `created_at`/`updated_at` copied from the entity.
- Rebuild the four `formation_requests` rows under `(company_id, step)` with every column above
  copied VERBATIM, `facts_updated_at` initialised from `updated_at`.
- Backfill `documents.company_id` on the three rows; ids and paths stay exactly as listed.
- Leave `oa_anchors` untouched; the next anchor pass must compute an UNCHANGED v3 manifest hash
  (`legal_name_filed` is NULL, so `companyName` is absent and the legal block is byte-identical).
- The party bound to this entity (`formation_parties.entity_key` set) gets `company_id` backfilled
  and is NOT erasable (the post-migration assertion: zero rows with `entity_key` set and `company_id`
  NULL).
