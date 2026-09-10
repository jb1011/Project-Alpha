# The legal-body check: AgentBook's "is there a human?" plus Novi's "is there a legal body?"

Status: design v1, 2026-09-10. Scope: ETHOnline 2026, World track, "our side" only (the half that
needs nothing from World). The World-side half (an attestation slot in AgentBook or the 402
extension) is a proposal in the hackathon feedback document, linked from §7.

## 1. Goal

A seller on World's AgentKit can today ask one question about the agent paying it: does a verified
unique human vouch for this address (AgentBook)? We add the second question the design of
2026-08-25 already names as the "second source of truth": is this address the payment address of a
Novi legal body in good standing? Three deliverables make that real without World changing anything:

1. a public lookup any seller can call for any address;
2. a drop-in checker object a seller hands to AgentKit's hooks in place of the AgentBook reader;
3. a third trust policy in our own x402 seller, `legal-bodies-only`, with a three-leg demo.

Mateo (World) confirmed 2026-09-09 that this is "just what we are looking for".

## 2. What exists (verified in code)

- `payments/sellerTrust.ts` — the BUYER-side dial already defines "legal body in good standing":
  `findByTreasury(payee)` → a record with `proxy` and `treasury` → fresh on-chain reads
  `legalStatus(proxy) === 0 && !treasuryPaused(treasury)` → `verified`; else `legal-body-inactive`;
  no record → `not-legal-body`; read failure → `unavailable`. Never cached in either direction.
- `payments/worldVerifier.ts` — the SELLER-side AgentKit gate: `verifyAgentkitRequest(header, cfg)`
  returns `{ authorized, humanId, agentAddress, reason }`. `agentAddress` is the proof's signer, the
  agent's payer address (design 2026-08-25 D1: the pocket is what is registered in AgentBook).
- `@worldcoin/agentkit-core` (installed) accepts any `agentBook` object with
  `lookupHuman(address): Promise<string | null>` (dist/cjs/index.d.ts:194).
- `payments/seller.ts` — trust policies `open` and `accountable-only`; the refusal body is
  `{ error, detail, reason, how: {...}, extensions }` with status 403.
- `api/routes/x402Demo.ts` — a flag-gated demo seller with an `accountable-only` wall and a
  `proof-run` that signs an AgentKit header with `X402_PROOF_AGENT_KEY` (the Lisbon proof agent:
  human-backed, no legal body).
- `api/routes/transparency.ts` — the public list of on-chain entities (`repo.listPublicOnChain()`),
  with the waiver honesty rule (`humanVerified` false for waivers) and per-company formation facts.
- `types.ts` `EntityRecord` has `pocketAddress`, `treasury`, `proxy`, `companyId`, `publicId`.
- Public, auth-free routes are enumerated in `api/app.ts` (CORS `*` for `/metadata/`, `/ensgateway`,
  `/transparency`); the AgentBook status route has the `TokenBucket` pattern for public read load.

## 3. Decisions

**D1. One resolver, one definition of standing.** `payments/legalBody.ts` exports
`resolveLegalBody(address)` → `{ kind: "none" } | { kind: "body", entity, standing }` with
`standing ∈ { "active", "inactive", "unknown" }`. `active` is exactly the existing rule
(`legalStatus === 0 && !treasuryPaused`), `inactive` is a definitive negative read, `unknown` is a
read failure. `sellerTrust.ts` is refactored onto it with behaviour and tests unchanged. Formation
facts (doola filing state, EIN presence) are reported by the lookup, never gating: the on-chain
legal body is what the seller can verify, the filing is what the transparency page shows.

**D2. Keyed by payer OR treasury.** The AgentKit proof carries the payer address; the buyer dial
carries the treasury. `resolveLegalBody` tries `findByPocketAddress(address)` first (new repository
method, exact-match on the lowercased stored form) then `findByTreasury(address)`. Only entities
that are public on chain count (the same `listPublicOnChain` rule as `/transparency`); an entity
below `created` is `none`.

**D3. Public lookup.** `GET /legal-bodies/:address` — no auth, CORS `*`, added to the public list in
`app.ts`. Validation: EIP-55 or lowercase 20-byte address, else 400. Response 200:

```json
{
  "address": "0x…",
  "legalBody": true,
  "standing": "active",
  "agentId": 843704,
  "publicId": "…",
  "name": "TestMB2",
  "network": "testnet",
  "links": { "transparency": "https://www.novicorpus.com/transparency", "metadata": "https://…/metadata/<publicId>" },
  "formation": { "filed": false } ,
  "checkedAt": "2026-09-10T…Z"
}
```

For an unknown address: `{ address, legalBody: false, standing: null, checkedAt }`. For a known body
whose chain read failed: `legalBody: true, standing: "unknown"` (never a guess). Load: one
`TokenBucket(30, 1)` for the route plus a 15-second per-address memo of the LAST DEFINITIVE answer
(a judge refreshing a page must not drain the RPC; a suspension still lands within 15 s). The memo
never stores `unknown`.

**D4. Seller policy `legal-bodies-only`.** `X402_TRUST_POLICY` gains the value; `seller.ts` gains the
branch: (1) no `agentkit` header → 403 `human_backing_required`, reason `no-proof-presented`
(unchanged shape); (2) proof invalid or no human → 403 `human_backing_required` (unchanged); (3)
human OK → `resolveLegalBody(outcome.agentAddress)`: `none` → 403 `legal_body_required`, reason
`not-legal-body`; `inactive` → 403 `legal_body_required`, reason `legal-body-inactive`; `unknown` →
503 `{ error: "legal_body_check_unavailable" }` (fail closed, nothing remembered); `active` → serve,
with the existing `X-AGENTKIT-*` headers plus `X-NOVI-LEGAL-BODY: <agentId>`. The `legal_body_required`
body carries `how: { lookup: "<public lookup url for that address>", onboard: "https://www.novicorpus.com/", transparency: "https://www.novicorpus.com/transparency" }`
and `detail: "this seller trades only with agents that a registered legal body in good standing stands behind"`.
The per-human allowance meter stays as it is (a legal body does not change the human's budget).

**D5. Demo routes.** `x402Demo.ts` mounts, beside the existing wall, `<base>/legal-bodies-wall`
(policy pinned to `legal-bodies-only` regardless of `X402_TRUST_POLICY`, so prod's configured seller
is untouched) and `<base>/legal-bodies-run`, which performs and returns the two refusal legs
server-side: anonymous (403 `no-proof-presented`) and the proof agent (403 `not-legal-body`, with
the `how` block). The third leg, a Novi agent going through, is a real payment from an
AgentBook-registered Novi agent (agent 843704 since 2026-09-09) via the product flow (`pay` from the
MCP or the dashboard), recorded for the video. The run endpoint spends nothing and signs only with
the proof key it already uses.

**D6. Drop-in checker for other sellers.** `payments/legalBodyAgentBook.ts` exports
`createLegalBodyAgentBook({ agentBook, lookupBaseUrl, fetch? })` returning `{ lookupHuman }`:
returns the human id only when AgentBook has a human AND `GET <lookupBaseUrl>/legal-bodies/<address>`
answers `legalBody: true, standing: "active"`; any other answer, and any failure of either read,
returns `null` (AgentKit's only refusal shape). No dependency beyond `fetch`. The file is written to
be copied: no imports from the rest of the backend. A doc, `back/docs/integrations/agentkit-legal-body-check.md`,
shows the swap (`createAgentkitHooks({ agentBook: createLegalBodyAgentBook({...}) })` or whatever
the installed factory is named — the implementer verifies against `agentkit-core`'s types), the
lookup contract, and the honesty rules below.

**D7. Claims ceiling for the new surface.** The lookup and the refusal say "a registered legal body
in good standing" and name the agent id; they never say "verified company", "KYC'd", "licensed" or
anything the on-chain status does not carry. `standing: "unknown"` is shown as unknown. The
human-claims rule of the AgentBook design (D9) is untouched: nothing here says who vouched.

**D8. Failure discipline.** Same as the buyer dial: a definitive answer may be acted on; a failed
read is `unknown`, refused fail-closed by the seller, reported as unknown by the lookup, never
memoised. The memo in D3 is the only cache and holds definitive answers only.

## 4. Threat model

- **Enumeration.** The lookup reveals whether an address belongs to a Novi entity. Every such entity
  is already listed on `/transparency` with its treasury, so nothing new leaks. Pocket addresses are
  new in the response only as the key the caller supplied.
- **RPC drain.** Two chain reads per miss; bounded by the token bucket and the 15-second memo.
- **Spoofing.** A seller checks the PROOF's signer address; an attacker cannot present a body it
  does not control because it cannot sign as that body's payer. The lookup alone proves nothing
  about the caller; the doc says so.
- **Stale standing.** The seller path reads fresh; the lookup memo is 15 s. A suspension is visible
  to sellers on the next request and to the lookup within 15 s.
- **Overclaim.** D7. The refusal names the remediation, not a guarantee.

## 5. Out of scope

The World-side attestation slot (proposal only). Publishing the checker to npm (the file is
copy-ready; publishing is a follow-up). Interface changes (none needed). The Graph subgraph.

## 6. Acceptance

1. `curl <api>/legal-bodies/0xeE85Fd00521d1Aa4c510BDdAb78F375830119354` → `legalBody: true, standing: "active", agentId: 843704`.
2. `curl <api>/legal-bodies/0x000…dead` → `legalBody: false`.
3. `<base>/legal-bodies-run` → two legs, 403 `no-proof-presented` and 403 `not-legal-body` with `how.lookup`.
4. A payment from agent 843704 to `<base>/legal-bodies-wall` → 200 with `X-NOVI-LEGAL-BODY: 843704`.
5. `sellerTrust` tests unchanged and green after the refactor.

## 7. The proposal to World

Written in the hackathon feedback document: an `attestations` field in the AgentKit 402 extension
(issuer address, schema id, subject = agent address, revocable), or a slot in a versioned AgentBook
(issue #37), so a seller asks AgentBook once and gets both answers. Our lookup is the working
reference implementation of the issuer side.

## 8. Corrections after implementation

Written against the code as it landed (tasks 1–6, branch `feat/legal-body-check`). Each item names
the decision it amends; §1–§7 above are the design as it was gated, unedited.

**D1 — "behaviour and tests unchanged" is wrong in two places, both deliberate.** Refactoring
`sellerTrust.verifyLegalBody` onto the shared resolver moved the buyer dial in opposite directions
at once, and both deltas were accepted (ledger ruling T1-R1):

- *a loosening.* The dial used to ask `findByTreasury(payee)` only; the resolver tries
  `findByPocketAddress` first (D2), so paying a Novi agent's POCKET now resolves to that legal body
  instead of `not-legal-body`. It is the same body's address, which is why D2 applies in both
  directions; the cost if that judgement is wrong is a buyer paying a Novi pocket it previously
  refused.
- *a tightening.* `isPublicOnChain` excludes entities whose status is `failed`, which the old narrow
  deps path never looked at: an entity that reached the chain and then failed a later step used to
  be asked about on chain and now resolves to `none`. Strictly more conservative, and consistent
  with not listing it publicly.

The `sellerTrust` TEST expectations are unchanged (no existing case covers either delta; two cases
were added).

**D2 — "an entity below `created` is `none`" is not the rule that shipped.** The rule is
`listPublicOnChain`'s, verbatim: `proxy` set, `treasury` set, and status ∈ {`created`, `bound`,
`funded`}. `failed` is reachable — `runner.ts`'s TERMINAL set omits `created`, so a crash in the
bind leg can leave a row that reached the chain marked `failed` — and it is excluded, which is the
tightening named under D1 (ruling T1-R2). Matching is case-insensitive (`COLLATE NOCASE`): stored
pockets are not uniformly lowercased (turnkey/backfilled rows are viem-checksummed, Circle's are
whatever the API returned).

**D3 — three additions to the lookup.**

1. *A 503 the design did not name.* A resolver that THROWS answers
   `503 {"error":"unavailable","message":"could not check right now; try again shortly"}`, in the
   route's flat error shape, with no `standing` invented. Only the local database read can throw:
   every chain failure is already `unknown`. Consumers of the lookup — the D6 checker included —
   must therefore expect 400, 429 and 503 beside the 200s (ruling T2-R5).
2. *A per-client bucket in front of the shared one* (ruling T2-R2). The single process-wide
   `TokenBucket(30, 1)` would let one scanner hold the route empty for everyone, and the checker
   reads a 429 as `null` — our own agents refused by every seller using it. So: `TokenBucket(10,
   0.5)` per caller, keyed by the first `X-Forwarded-For` entry (else `"direct"`), a bounded
   least-recently-used map of 2000 keys, asked BEFORE the shared bucket, with the same 429 body
   from either and one `legal_body_lookup_throttled` ops line per 60 s naming the bucket. Memo hits
   spend from neither.
3. *`Cache-Control` on every answer* (ruling T2-R1). A definitive 200 carries `public, max-age=15`,
   matching the memo; `standing: "unknown"`, the 400, the 429 and the 503 carry `no-store`. The
   worst case is a downstream cache holding an answer this process had already memoised — 30 s,
   which is the window D3's threat model was chosen against.

**D3 — `agentId` is a decimal STRING** (`"843704"`), not the sketch's unquoted number: it is a
uint256 token id, a JSON number loses precision above 2^53, and `/transparency` and `/metadata`
already serve it as a string.

**D4 — the unavailable check runs FIRST.** Under `legal-bodies-only` with no resolver wired, the
503 is returned before the no-proof 403, not after the human gate: a policy the deployment cannot
evaluate authorizes nobody, and refusing later would make a broken strict seller look like a
working one.

**D5 — the run probes its OWN wall instance.** `/legal-bodies-run` does not probe the settling wall;
it builds a second paywall from the same deps with no `settle` and its own rate key
(`…#legal-bodies-run`). The per-human allowance is spent on every definitive answer, refusals
included, so sharing the settling wall's key would turn leg 2 into a 429 after a few page views —
the same reason `/proof-run` keeps its own key. Leg 2 signs leg 1's own challenge, not a second one.

**D5 — the run wall's meter.** The run's instance is also built with `allowancePerHuman: 10_000`, an
effectively unlimited meter (ruling T3-R2). Its own rate key is not enough on its own: the allowance
is per human per window, and at the production default of 3 per 24 h the second leg would answer 429
from the fourth page view onward — beside an `expected` block still promising 403, contradicting
itself mid-demo. The settling wall keeps the deployment's allowance, because that budget protects
something; this one settles nothing.

**D4 — `PUBLIC_API_URL`, a new optional env** (ruling T3-R1/R5). Every public link this deployment
hands to a STRANGER — the refusal's `how.lookup`, the advertised demo wall, the run url — is composed
from `cfg.publicApiUrl ?? cfg.metadataBaseUrl`. `METADATA_BASE_URL` is the `www/backend` proxy in
production, and that hop forwards allowlists only: no CORS header, no `Cache-Control`, and (until the
interface carrying this branch is deployed) no `X-NOVI-LEGAL-BODY`. Unset, everything behaves exactly
as before, so no box has to change to boot. `interface/src/lib/proxyHeaders.ts` gains
`x-novi-legal-body` on the response allowlist for buyers that do come through the proxy.

**D4 — the meter is charged AFTER the decision, and exhaustion is checked first.** Under
`legal-bodies-only` the AgentKit verification runs with `chargeAllowance: false`: the human is
identified and an exhausted one is still refused 429 — before any Arc read — but the unit is spent
only once the legal answer is definitive. On the 402 a passing check leads to, and on both legal
403s, one unit is charged and reported in `X-AGENTKIT-AUTHORIZATION`; on the 503 nothing is charged,
because the store has no release and an RPC blip would otherwise lock out the buyer this policy
exists to serve for the rest of the window (ruling T3-R3).

**D4 — `legal-bodies-only` without `agentkit` fails CLOSED.** Missing EITHER half (the AgentKit
config or the resolver) refuses every request 503, ahead of the no-proof 403, each with its own
mount-time warning. Without this, a box that lost its World config would have fallen through to
`open` and sold to anonymous payers while its own env still said `legal-bodies-only` (ruling T3-R4).
`accountable-only`'s pre-existing fail-open is untouched here — see the plan's Deferred list.

**D5 — the buyer recovers from a strict wall's 403, once** (ruling T6, Task 6). `buyWithX402` answers
a 403 whose body carries `extensions.agentkit`: it mints the human-backing proof with the agent's own
pocket AgentKit signer and retries the SAME request ONCE, then continues down the unchanged 402 →
authorize → pay path with the proof header still attached. Never on the first request — a non-strict
but AgentKit-aware seller would otherwise spend one of the human's allowance units on every purchase
— and never twice: a second 403 is terminal and throws
`resource-403-after-proof: <error> (<reason>): <detail>`, quoting the seller so the reason a user
reads names the missing thing. Nothing is signed for money on the proof leg, so the idempotency claim
is released and the same key retries cleanly. This is what makes design D5's third leg reachable from
the product (`pay`), which it was not when §1–§7 were written: World's own client returns any
non-402 response untouched.
