# doola `Idempotency-Key` contract — live sandbox verification (2026-08-21)

**Status: PASSED. This is the PR 2 merge gate** named in the design
(`docs/design/2026-08-19-doola-formation-provider-design.md` §5/§12.2).

The `create_provider` step's crash-window rule — *persist the company id before treating the
create as done, and on resume ADOPT it rather than re-file* — rests entirely on doola honoring
`Idempotency-Key` the way their docs describe. A miss in production is a **duplicate real Wyoming
LLC and a real fee**, so the contract was verified against the live host instead of assumed.

- Host: `https://api.test.doola.com` (sandbox), key `dk_test_…` from `DOOLA_API_KEY` (env only;
  the value is in Martin's vault and appears in no file in this repo).
- Probe: `back/backend/scripts/doola-idempotency-probe.mts`, run `1787314288`
  (`DOOLA_API_KEY=… npx tsx scripts/doola-idempotency-probe.mts`). Not a test — it creates real
  sandbox companies, so it never runs in CI. It refuses any key that is not `dk_test_…`.
- Companies it created are named `Novi PR2 Idem Probe <run><A|C>` and are visible in the portal.

## What was verified, and the verbatim results

### 1. Same key + same body → the same object, no duplicate

`POST /v1/partner/customers` twice, one key, one body:

```json
{
  "first":  { "doolaCustomerId": "3IE0C8RwXsleBn2qpt08PHdzicL", "created": true },
  "second": { "doolaCustomerId": "3IE0C8RwXsleBn2qpt08PHdzicL", "created": true },
  "sameId": true
}
```

`POST /v1/partner/companies` twice, one key, one body:

```json
{
  "firstId":  "3IE0C4cPIjQC9pUUZbUJTFTdocL",
  "secondId": "3IE0C4cPIjQC9pUUZbUJTFTdocL",
  "sameId": true
}
```

⚠ **`created: true` is echoed on the replay too.** It is doola's "this customer did not already
exist" flag from the ORIGINAL request, replayed verbatim — it is NOT a signal that this
particular call created something, and must never be used as one.

### 2. Same key + a DIFFERENT body → 409, and nothing is filed

```json
{
  "name": "DoolaApiError",
  "code": "E_IDEMPOTENCY_KEY_REUSED",
  "status": 409,
  "message": "Idempotency-Key was reused with a different request body"
}
```

### 3. A FAILED create RELEASES its key

An invalid body (`nameOptions: []`) under key `probe:<run>:companyC`:

```json
{
  "name": "DoolaApiError",
  "code": "E_VALIDATION_FAILED",
  "status": 400,
  "message": "one or more fields are invalid",
  "fields": {
    "nameOptions": { "code": "E_REQUEST_BODY_INVALID", "message": "Name options cannot be empty" }
  }
}
```

…then a retry with **the same key** and a corrected body:

```json
{ "id": "3IE0CAUsMZ47ul7nK8wnUrMr05u", "formationSubmissionStatus": "PENDING" }
```

So a failed create does not burn its key — but note our code bumps `attempt` on a terminal
failure anyway. The two are not in conflict: the release is what makes the retry legal, and the
bump is what keeps a retry with a *changed* body out of case 2's 409.

### 4. Structural proof: exactly one company per successful key

`GET /v1/partner/companies?customerId=…` after the whole run — three `POST /companies` calls
(a double-create, a 409, and a fail-then-retry) left **two** companies:

```json
{
  "count": 2,
  "companies": [
    { "id": "3IE0CAUsMZ47ul7nK8wnUrMr05u", "name": "Novi PR2 Idem Probe 1787314288C",
      "formationSubmissionStatus": "SUBMITTED" },
    { "id": "3IE0C4cPIjQC9pUUZbUJTFTdocL", "name": "Novi PR2 Idem Probe 1787314288A",
      "formationSubmissionStatus": "SUBMITTED" }
  ]
}
```

## ⚠ Finding: `GET /companies` is EVENTUALLY consistent with the creates

The same query, run immediately after the creates, answered:

```json
{ "count": 0, "companies": [] }
```

and answered correctly 15 seconds later (§4 above). Both reads are in the one transcript.

**Consequence for the code, and it is load-bearing:** the pre-create lookup fallback
(completeness 9) may only ever **ADOPT** a company it finds. An empty result is *not* evidence
that nothing was filed, so it can never be what authorizes a fresh `POST /companies`. The
`Idempotency-Key` is the primary crash-window guard; the lookup is belt-and-braces on top of it.
`workflow/formationProvider.ts` implements exactly that ordering.

## Other live findings folded into the code

- Every partner endpoint is under **`/v1/partner`**; `GET /companies` (unprefixed) answers
  `NoHandlerFoundException`. PR 1's client had unprefixed paths — corrected.
- **A natural person's address REQUIRES a phone** (`E_REQUEST_BODY_INVALID: Address Phone number
  cannot be null or empty` on both `responsibleParty` and `members`). The formation-party intake
  keeps `phone` optional per the design, so `create_provider` refuses a phone-less party with a
  named error BEFORE calling doola rather than shipping a body it knows will 400. **The wizard
  must collect a phone before the first production filing** (PR 4).
- `error.fields` is `{field: {code, message}}`, not the flat `{field: "reason"}` PR 1 assumed.
- `formationSubmissionStatus` is `PENDING` on the create response and flips to `SUBMITTED`
  shortly after. It tracks doola's INTAKE of the request, never "the company is formed".

## Re-running this gate

Before the mainnet flip, re-run against **production** with a `dk_live_` key — the probe refuses
that by design (it creates companies), so a production verification is a *one-company, manual*
exercise against the first real filing, not this script.
