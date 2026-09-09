# Runbook — doola webhooks

> ⚠ **A1 (2026-08-26):** a webhook's `doolaCompanyId` now maps to a **company**, not to an entity.
> `formation_requests.provider_ref` is unchanged on the wire and in the table — what changed is the
> row it sits on, which is keyed `(company_id, step)`. One wake-up therefore advances ONE company,
> where it used to advance one entity, and every agent attached to that company sees the result.
> Ops lines that used to carry `entityKey` carry `companyId`; a journald filter written against
> the old field name will come back empty rather than wrong. To find the agents behind a company:
>
> ```bash
> sqlite3 "$DATA_DIR/legalbody.db" \
>   "SELECT idempotency_key FROM entities WHERE company_id =
>      (SELECT company_id FROM formation_requests WHERE provider_ref = '<doolaCompanyId>');"
> ```

> Covers the inbound receiver shipped in PR 2 part B.
> Design: `back/docs/design/2026-08-19-doola-formation-provider-design.md` §6 (receiver), §5
> (event handling), §7 (sweeper), §10 (threat model).
> Code: `back/backend/src/api/routes/doolaWebhook.ts`,
> `back/backend/src/workflow/formationProcessor.ts`,
> `back/backend/src/workflow/formationSweeper.ts`.

## What the endpoint is

```
POST https://api.novicorpus.com/webhooks/doola/sandbox
POST https://api.novicorpus.com/webhooks/doola/production
```

Per-environment paths, so a rotation or the mainnet flip can never mix signature domains. A
request whose path environment is not the deployment's `DOOLA_ENVIRONMENT` gets a **404** before
any signature work — a portal pointed at the wrong environment should look like a wrong URL, not
like a secret problem.

**Use the backend origin directly. Not the Vercel proxy.** The proxy
(`interface/src/app/backend/[[...path]]/route.ts`) forwards a fixed allowlist of request headers
and `x-doola-signature` is not on it — every delivery through the proxy would 401, and five of
those disable the endpoint.

## Behaviour, by case

| Case | Status | Why |
|---|---|---|
| Valid signature, fresh event | 200 | Row persisted, processing scheduled in the background |
| Valid signature, duplicate `eventId` | 200 | `INSERT OR IGNORE`; no second processing task |
| Valid signature, body older than 48h | 200 + `doola_webhook_stale` WARN | A 4xx here would re-disable an endpoint a clock skew or a backlog just brought back (audit M3) |
| Valid signature, unparsable body | 200 + `doola_webhook_unparsable` WARN | Already authenticated as doola's; spending a strike on it is self-harm |
| Missing / malformed / wrong-length / wrong-secret signature | **401**, one constant body | The endpoint is not an oracle for which check failed |
| Body over 256 KiB (declared or streamed) | **413**, constant body | A size refusal is not a signature verdict; conflating them hides a misconfigured sender behind "your secret is wrong". doola's real envelopes are kilobytes, so this can only fire for something that is not doola |
| Wrong environment in the path | 404 | See above |
| Deployment with no doola credentials | 404 | Route is not mounted at all |

`timestamp` in the envelope is **Unix epoch milliseconds**. A seconds assumption rejects
everything doola sends.

## ⚠ Deploy-time checklist

This PR cannot receive a real webhook before it ships, so half of the design's PR 2 merge gate is
a **deploy-time** step. Do these in order.

### 1. Ship, then verify the route is live — BEFORE touching the portal

A portal endpoint pointing at a 404 gets disabled before launch.

```bash
# From anywhere. Expect 401 (route is live, signature is wrong) — NOT 404.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' \
  -H 'x-doola-signature: 00' \
  --data '{}' \
  https://api.novicorpus.com/webhooks/doola/sandbox

# And confirm the other environment is NOT served by this box. Expect 404.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' --data '{}' \
  https://api.novicorpus.com/webhooks/doola/production
```

`401` then `404` means the route is mounted and pinned to the right environment.

### 2. Configure the endpoint in doola's partner portal

The portal holds the **URL and the event subscriptions only**. The signing secret is issued and
rotated by doola over email — it is not self-served (fact-check correction to the original
design prose).

Subscribe at minimum to: `company_formation_completed`, `company_formation_failed`,
`company_ein_issued`, and the `document_*_uploaded` family. Unsubscribed events cost nothing —
the sweeper's daily poll is the backstop for every one of them — but they cost latency.

### 3. PIN THE LIVE SIGNATURE FORMAT against the first real sandbox event

This is the outstanding half of the merge gate. Everything shipped assumes doola's documented
format: **`X-Doola-Signature`, lower-case hex, HMAC-SHA256 over the raw request body**. The code
additionally tolerates a `sha256=` prefix and surrounding whitespace, because that is the most
common variation across providers and we could not observe the real one before deploying.

After the first sandbox formation, trigger an event (`npm run cli -- ...` playground call, or
doola's portal "send test event") and check:

```bash
# Did anything arrive at all?
journalctl -u legalbody-api --since '15 min ago' | grep -E 'doola_webhook_(received|unauthorized)'
```

* `doola_webhook_received` — **the format is confirmed.** Tick this checklist item off in the PR
  and note the date here.
* `doola_webhook_unauthorized` — the format differs. Capture one raw delivery (doola's portal
  shows the headers it sent), then change **exactly two places**:
  `DOOLA_SIGNATURE_HEADER` and `decodeSignature` in
  `back/backend/src/api/routes/doolaWebhook.ts`. Both are exported constants/functions with tests
  next to them; nothing else in the receiver hard-codes the format.
* Nothing at all — the portal is not pointed here, or the endpoint is already disabled. See
  *Recovering from `partner_webhook_disabled`* below.

> Status: **NOT YET PINNED.** Record the confirming date and the observed header format here once
> the first real sandbox event lands.

### 4. NTP

Signature verification does not depend on the clock, but the 48-hour staleness bound does. A box
whose clock is more than two days out will silently drop every event into
`doola_webhook_stale` and progress will fall back to the (much slower) sweeper poll.

```bash
timedatectl status | grep -E 'System clock synchronized|NTP service'
```

Both should read `yes` / `active`. This is a standing requirement, not a one-off check.

## Rotating the webhook secret (zero downtime)

The secret is issued by doola over email. Both the current and the previous secret are verified
on every request, so the window is genuinely zero-downtime.

1. Request a new secret from doola support. Do **not** let them cut over until step 4.
2. On the box, move the current secret into `_PREVIOUS` and put the new one in place:

   ```
   DOOLA_WEBHOOK_SECRET=<new secret>
   DOOLA_WEBHOOK_SECRET_PREVIOUS=<the secret currently in use>
   ```

3. `systemctl restart legalbody-api`, then re-run the step-1 curl (expect 401 — the route is
   live).
4. Tell doola to cut over. Deliveries signed with either secret verify from this moment.
5. Watch for one full delivery cycle:

   ```bash
   journalctl -u legalbody-api -f | grep -E 'doola_webhook_(received|unauthorized)'
   ```

6. Once only `doola_webhook_received` appears, remove `DOOLA_WEBHOOK_SECRET_PREVIOUS` and restart.
   Leaving it set indefinitely keeps a retired credential live.

Both secrets are always evaluated (no early return), so the time a request takes does not reveal
which secret matched.

## Recovering from `partner_webhook_disabled`

doola disables an endpoint after **five consecutive failures**. Recovery is manual.

Symptom, in journald:

```
{"opslog":"doola_webhook_disabled","severity":"CRITICAL", ... }
```

Or, less obviously: no `doola_webhook_received` lines for 24h while formations are in flight.

1. **Nothing is lost.** The sweeper polls doola daily for every in-flight entity, so formations
   keep progressing — just slowly. Fix the endpoint, do not fix the data.
2. Find out *why* it was disabled:

   ```bash
   journalctl -u legalbody-api --since '3 days ago' \
     | grep -E 'doola_webhook_(unauthorized|oversize)' | tail -50
   ```

   Repeated `doola_webhook_unauthorized` means a secret mismatch (a rotation that cut over before
   the box had the new secret is the usual cause). No lines at all means the failures were 5xx or
   connection errors — check whether the API process was down or the TLS certificate expired.
3. Fix the cause. Re-run the step-1 curl and confirm `401`.
4. **Re-enable the endpoint by hand in doola's partner portal.** There is no API for this.
5. Confirm recovery: trigger a playground event and look for `doola_webhook_received`.

A backlog delivered right after a re-enable may be more than 48h old. Those answer 200 and log
`doola_webhook_stale` — that is correct and requires no action; the sweeper has already been
carrying those entities.

## Reading the ops trail

Every line is one JSON object on stdout → journald.

| Event | Meaning |
|---|---|
| `doola_webhook_received` | Verified, deduped, queued |
| `doola_webhook_duplicate` | A redelivery; no work scheduled |
| `doola_webhook_unauthorized` | Signature failed. Repeated ⇒ auto-disable risk |
| `doola_webhook_oversize` | Body over 256 KiB |
| `doola_webhook_stale` | Older than 48h; ignored, not failed |
| `doola_webhook_unparsable` | Verified but not a readable envelope |
| `doola_webhook_unmapped` | No entity owns that company id **yet**; kept for the sweeper |
| `doola_webhook_unknown_event` | An event name we have no route for; the sweeper drives it |
| `doola_webhook_disabled` | **CRITICAL** — see above |
| `formation_step` | A step changed state |
| `formation_document_stored` | A legal PDF was fetched, hashed and indexed |
| `formation_failed` | doola's fetched state says the formation failed |
| `formation_abandoned` | **CRITICAL** — a step burned all 8 attempts |
| `formation_stale` | A step has been in flight > 14 days, OR (A2 §4.6a, `reason: ssn_ttl_no_provider_ref`, **CRITICAL**) an SSN has been held 7 days on a filing that reached doola and never got a company id back. Once per row per day. The A2 arm erases NOTHING and abandons nothing — a NULL `provider_ref` is not proof no company exists at doola |
| `formation_party_erased` | PII destroyed for a filing that never happened |
| `formation_ssn_erased` | The SSN was destroyed. `reason`: `provider_persisted` (the transaction that recorded the company id — the normal path), `terminal`, `ttl`, or `intake_reopened` (an edit-and-retry re-capture). Never carries the value or the person |
| `formation_ssn_unreadable` | **CRITICAL** — a create body frozen WITH an SSN can no longer be rebuilt (the key is gone, or the row was erased out from under a live idempotency key). The filing is PARKED without burning the attempt: sending the body without the SSN is a different body under a live key, and re-keying would file a SECOND real Wyoming LLC. See `doola-deploy.md`, "If the key is LOST" |
| `company_intake_updated` | An intake was re-opened after a rejected filing (§4.7) |
| `formation_party_rejected` | **CRITICAL** — doola refused the responsible PERSON's body, not the company's. The row parks under `awaitingPartyEdit`, and since A3 its exit is `PATCH /companies/:companyId/party` (or MCP `update_company_party`), NOT `PATCH /companies/:companyId` — none of the four fields that door rewrites is one `createCustomer` reads |
| `formation_party_updated` | A responsible party was corrected through the A3 door. Carries the tenant (truncated), the `partyId` and the `companyId` — never a name, an address, an email, and never a diff, which would be the whole identity in a log line |
| `formation_ssn_erased_before_send` | **CRITICAL**, and NOT an engineering failure — the §4.6a retention clock destroyed an SSN before the filing was ever sent. The row parks WITHOUT burning an attempt, and the two exits are the OWNER's: re-supply the number, or `proceedWithoutSsn`. `GET /companies/:companyId` reports it as `park.awaitingSsnDecision`, which is what the Companies section explains |
| `company_attach` | An agent joined a company. `agents` is the count BEFORE this attach |
| `company_attach` with `agents>0` | **A QUERY, not an event.** The N:1 fan-out actually happening: an agent joined a company that ALREADY had one. §7 named a separate `company_reused` line for this; it carried the same ids and the same number as `company_attach` on the same attach, so it was dropped and the question is asked of the count instead (`journalctl … \| grep company_attach \| grep -v '"agents":0'`). It is what bounds anchor traffic (`agents × late facts × 2 sponsored writes`), and what makes two agents publicly linkable through their anchored manifests — a fact the reuse picker discloses before the owner confirms |
| `formation_intake_unreadable` | **CRITICAL** — the company's stored `name_options` blob is empty or unreadable. The filing is PARKED and nothing was sent; it never files under an invented name. Fix the row, then let the sweeper retry |
| `anchor_batch_full` | INFO. One anchor page hit `ANCHOR_BATCH`; the cursor carries the rest to the next tick. Reports `companies` (how much of the due set the page covered) and `entities` (what the tick actually drove). Full on EVERY tick ⇒ the deployment has outgrown `ANCHOR_BATCH` |

Useful queries:

```bash
# Is the channel healthy?
journalctl -u legalbody-api --since today | grep doola_webhook_received | wc -l

# Anything CRITICAL, ever
journalctl -u legalbody-api | grep '"severity":"CRITICAL"'

# What is stuck? (A1: the sub-saga is keyed by COMPANY — there is no entity_key column any more)
sqlite3 /var/lib/legalbody/legalbody.db \
  "SELECT company_id, step, state, attempt, updated_at FROM formation_requests
    WHERE state IN ('failed','abandoned') ORDER BY updated_at DESC;"

# …and which agents (if any) share each of those filings
sqlite3 /var/lib/legalbody/legalbody.db \
  "SELECT f.company_id, f.step, f.state, group_concat(e.idempotency_key)
     FROM formation_requests f
     LEFT JOIN entities e ON e.company_id = f.company_id
    WHERE f.state IN ('failed','abandoned') GROUP BY f.company_id, f.step;"

# Which filings are PARKED waiting on a human, and on WHICH of the three decisions (A2/A3).
# `GET /companies/:companyId` answers the same question for one company, in the owner's words.
sqlite3 /var/lib/legalbody/legalbody.db \
  "SELECT f.company_id,
          json_extract(f.detail,'$.awaitingIntakeEdit') AS intake_edit,
          json_extract(f.detail,'$.awaitingPartyEdit')  AS party_edit,
          p.ssn_erased_reason
     FROM formation_requests f
     LEFT JOIN formation_parties p
       ON p.company_id = f.company_id AND p.deleted_at IS NULL
    WHERE f.step = 'create_provider'
      AND json_valid(f.detail)
      AND (json_extract(f.detail,'$.awaitingIntakeEdit') = 1
           OR json_extract(f.detail,'$.awaitingPartyEdit') = 1
           OR (p.ssn_erased_reason = 'ttl' AND p.ssn_ciphertext IS NULL));"

# Events the sweeper still owes work on
sqlite3 /var/lib/legalbody/legalbody.db \
  "SELECT event_id, event_name, provider_ref, received_at FROM doola_webhook_events
    WHERE processed_at IS NULL ORDER BY received_at;"
```

## Data handling

- `doola_webhook_events.payload` holds the **raw envelope**, verbatim, for forensics. Nothing
  reads it: every fact is re-fetched from doola's API (audit H2). It is swept after 30 days.
- The payload can contain personal data. It is never projected into a view, the transparency
  surface, served metadata, or an ops line. Treat a manual `SELECT payload` as reading PII.
- Formation-party PII is erased automatically for filings that provably never happened (an
  abandoned `create_provider`, or an unbound handle older than 7 days) — see
  `formation_party_erased`.
- **The SSN is a SHORTER clock over a different fact** (A2 §4.6a) and is erased separately, most
  often within seconds: the transaction that records the doola company id destroys it. It is
  stored AES-256-GCM encrypted, bound by its AAD to its `(party_id, company_id)` pair, and never
  appears in a log line, an ops field, a `detail` blob or an error — a provider error that echoes
  it back is redacted before it is stored. See `doola-deploy.md` for the key and its rotation.

```bash
# How many SSNs are we holding right now, and under which key?
sqlite3 /var/lib/legalbody/legalbody.db \
  "SELECT ssn_key_id, COUNT(*) FROM formation_parties
    WHERE ssn_ciphertext IS NOT NULL GROUP BY ssn_key_id;"
```

## Related

- `back/docs/runbooks/doola-idempotency-verification-2026-08.md` — the other half of the PR 2
  merge gate (the create-endpoint idempotency contract, verified live).
- Backup: `data/documents/` now holds real legal PDFs and must be in the Litestream/backup set.
  doola remains the system of record (every row keeps its `provider_doc_id`), but a lost local
  copy invalidates a hash an on-chain anchor commits to.
