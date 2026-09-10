# Runbook — the legal-body check

A seller on World's AgentKit can ask whether a verified unique human vouches for the address about
to pay it; this ships the second question, "is that address the payment address of a Novi legal body
in good standing?", as a public lookup, a seller policy and a demo (design 2026-09-10, D1–D8). The
lookup is unauthenticated and answers only what the chain says. Nothing here changes the
deployment's configured seller: the demo wall pins its own policy.

## The public lookup

`GET /legal-bodies/:address` is mounted on the API app at the root, beside `/transparency`
(`api/app.ts` → `mountLegalBodyRoutes`), so it answers wherever the API answers:

- `https://api.novicorpus.com/legal-bodies/<address>` — the box directly;
- `https://www.novicorpus.com/backend/legal-bodies/<address>` — through the proxy every other public
  surface uses, and **the URL the code itself hands out**: `main.ts` composes the seller refusal's
  `how.lookup` and the answer's `links.metadata` from `METADATA_BASE_URL`, which on prod is
  `https://www.novicorpus.com/backend` (read off the live 402 at `.../x402-demo/quote`, whose
  `info.uri` is `<METADATA_BASE_URL>/x402-demo/quote`, checked 2026-09-10).

**A known active body** — agent 843704 (TestMB2), pocket `0xeE85Fd00521d1Aa4c510BDdAb78F375830119354`,
the first Novi legal body registered in AgentBook (2026-09-09):

```bash
curl -s https://api.novicorpus.com/legal-bodies/0xeE85Fd00521d1Aa4c510BDdAb78F375830119354
```
```json
{"address":"0xeE85Fd00521d1Aa4c510BDdAb78F375830119354","legalBody":true,"standing":"active",
 "agentId":"843704","publicId":null,"name":"TestMB2","network":"testnet",
 "links":{"transparency":"https://www.novicorpus.com/transparency","metadata":null},
 "formation":null,"checkedAt":"2026-09-10T…Z"}
```

`agentId` is a decimal STRING (a uint256 token id). That row carries no `publicId` on prod today
(its `/transparency` entry says `"publicId": null`), so `links.metadata` is null; a row with one gets
`https://www.novicorpus.com/backend/metadata/<publicId>`, and `formation` is null when the entity has
no company. `standing` is whatever the chain says at that moment: `active` only when `legalStatus == 0`
and the treasury is not paused, `inactive` on a definitive negative, `unknown` when the read failed —
never guessed, never memoised.

**An address we have no entity for** — 200, four keys and nothing else, the address echoed
EIP-55-checksummed. **A bad address** — 400. All-lowercase or valid EIP-55 only (viem
`isAddress(a, {strict:true})`); an all-uppercase address is refused rather than silently re-cased.

```bash
curl -s https://api.novicorpus.com/legal-bodies/0x000000000000000000000000000000000000dead
# {"address":"0x000000000000000000000000000000000000dEaD","legalBody":false,"standing":null,"checkedAt":"…"}
curl -s https://api.novicorpus.com/legal-bodies/0xnope
# {"error":"validation_error","message":"address must be a 20-byte hex address, either all-lowercase or EIP-55 checksummed"}
```

**Throttling.** Two token buckets, both spent on a memo MISS only (a memo hit makes no chain read and
costs nothing): a per-client `TokenBucket(10, 0.5)` keyed by the first `X-Forwarded-For` entry
(`"direct"` when there is none; bounded at 2000 keys, coldest evicted), in front of one process-wide
`TokenBucket(30, 1)`. Either refuses with `{"error":"rate_limited","message":"try again in a few seconds"}`,
429, `Cache-Control: no-store` — identical, so a caller never learns which limit it hit — plus at most
one ops line per 60 s naming the bucket.

**Freshness.** A definitive 200 (`active`, `inactive`, or `legalBody: false`) carries
`Cache-Control: public, max-age=15`, matching the 15 s per-address memo of the last definitive answer;
`standing: "unknown"`, the 400, the 429 and the 503 carry `no-store`. Worst case is a downstream cache
holding an answer this process had already memoised — 30 s of staleness.

**503.** `{"error":"unavailable","message":"could not check right now; try again shortly"}` when the
resolver throws, which only the local database read can do: every chain failure is `unknown`, not a throw.

## The seller policy

`X402_TRUST_POLICY=legal-bodies-only` (third value, `config/env.ts`) applies to the deployment's
configured wall at `/x402-demo/quote`. It requires, in order: a resolver wired (else every request is
503), an `agentkit` header, a valid proof of a verified unique human, then `resolveLegalBody(<the
proof's signer>)` returning a public-on-chain Novi entity — matched by pocket or treasury — whose
`legalStatus == 0` and whose treasury is not paused. The address checked is always the proof's signer,
never anything the caller asserted. The refusal bodies, verbatim (`payments/seller.ts`):

- **403** no proof, an invalid proof, or no human — unchanged from `accountable-only`:
  `{"error":"human_backing_required","detail":"this seller trades only with agents a verified unique human answers for","reason":"no-proof-presented","how":{"register":"npx @worldcoin/agentkit-cli register <your-agent-address>","agentBook":"<configured AgentBook address>","chain":"world-chain"},"extensions":{…}}`
  (`reason` is the verifier's own reason for an invalid proof).
- **429** the per-human budget, unchanged: `{"error":"rate-capped","detail":"per-human request budget exhausted for this window"}`, with `X-AGENTKIT-HUMAN` set.
- **403** human-backed, no legal body:
  `{"error":"legal_body_required","detail":"this seller trades only with agents that a registered legal body in good standing stands behind","reason":"not-legal-body","how":{"lookup":"https://www.novicorpus.com/backend/legal-bodies/<checked address>","onboard":"https://www.novicorpus.com/","transparency":"https://www.novicorpus.com/transparency"},"extensions":{…}}`
  — `reason` is `legal-body-inactive` for a suspended body; everything else is identical.
- **503** the check could not be MADE (fail closed, nothing remembered):
  `{"error":"legal_body_check_unavailable","detail":"the legal-body check could not be completed just now"}`,
  and with no resolver wired at all, the same error with
  `"detail":"this seller's legal-body check is not configured right now"` — returned BEFORE the
  no-proof refusal, so a policy the box cannot evaluate never looks like a working strict seller.

Served: `X-AGENTKIT-HUMAN`, `X-AGENTKIT-AUTHORIZATION: <used>/<limit>` and `X-NOVI-LEGAL-BODY: <agentId>`
(omitted, never blank, when the record has no agent id) — all three already on the 402 invoice that
follows a passing check. The 200 body adds `humanBacked: true` and `legalBody: {"agentId": …}`;
`X-PAYMENT-RESPONSE` carries the transfer id when settlement returns one.

## The demo

Pinned wall (its own policy regardless of `X402_TRUST_POLICY`; settles):
`https://api.novicorpus.com/x402-demo/legal-bodies-wall`, advertised to clients and signed against as
`https://www.novicorpus.com/backend/x402-demo/legal-bodies-wall`. Run:
`https://api.novicorpus.com/x402-demo/legal-bodies-run` (one run per 5 s, else
`{"error":"slow-down","detail":"one run every 5 seconds"}`).

The run returns `{policy, resource, statement, legs, expected, thirdLeg}`: leg 1 `anonymous` = 403
`human_backing_required` / `no-proof-presented`; leg 2 `human-backed, no legal body` = 403
`legal_body_required` / `not-legal-body` with the `how` block, signed live by the Lisbon proof agent
from leg 1's own challenge. It spends nothing — the instance it probes has no `settle` and its own rate
key — but each run does spend one of the proof agent's per-human allowance tokens on that key, so after
`WORLD_ALLOWANCE_PER_HUMAN` runs in the window leg 2 becomes 429 `rate-capped`. Record early in a window.

**Leg 3, the payment that goes through.** Agent 843704, the AgentBook-registered legal body above,
paying `…/x402-demo/legal-bodies-wall` 0.01 USDC. There is no dashboard button: the product surface for
a payment is the MCP tool `pay` (`{id, to, amountUsdc, idempotencyKey}`, atomic USDC → `"10000"`), and
the agent needs Gateway float (`fund_pocket`) first. ⚠ Verified at HEAD: a plain `pay` stops at the
refusal — the wall answers the first, proofless request 403, and neither World's client
(`@worldcoin/agentkit/dist/cjs/index.js:156`, `if (response.status !== 402) return response`) nor our
`buyWithX402` (`payments/buyer.ts:44`) recovers from a 403, so the receipt is
`{ok:false, reason:"resource-403"}` with nothing signed. Reaching 200 means presenting the proof on the
FIRST request: GET the wall, take `extensions.agentkit` from the 403, mint the header with the agent's
own pocket signer (`createAgentkitClient({signer}).createHeader(ext)` — the pattern in
`routes/x402Demo.ts` leg 2; the signer is the one `entityPayment.ts` uses, derived from
`POCKET_MASTER_SEED` for a turnkey-path agent such as 843704), repeat with `agentkit: <header>` to get
the 402, then pay with `X-PAYMENT`. Look for `X-NOVI-LEGAL-BODY: 843704` beside `X-AGENTKIT-HUMAN`
(already on the invoice) and `legalBody: {"agentId":"843704"}` in the 200 body.

## Acceptance (design §6)

```bash
API=https://api.novicorpus.com
# 1 — a known active body
curl -s $API/legal-bodies/0xeE85Fd00521d1Aa4c510BDdAb78F375830119354 | jq '.legalBody, .standing, .agentId'
# 2 — an address we have no entity for
curl -s $API/legal-bodies/0x000000000000000000000000000000000000dead | jq '.legalBody, .standing'
# 3 — the two refusal legs
curl -s $API/x402-demo/legal-bodies-run | jq '.legs[] | {name, status, error: .body.error, reason: .body.reason}'
# 4 — the third leg: the proof-first sequence above; read the headers
curl -sD - -o /dev/null $API/x402-demo/legal-bodies-wall -H "agentkit: <header signed by 0xeE85Fd…9354>"
# 5 — the buyer dial is unchanged by the refactor
cd back/backend && npx vitest run test/payments/sellerTrust.test.ts
```

## Deploy

Code only: no env change on the box. The lookup mounts itself wherever `main.ts` runs, the demo wall
pins `legal-bodies-only` itself (so `X402_TRUST_POLICY` stays `open` on prod), and the interface is
untouched. Deploy as usual (`ssh novi-prod`, pull, build, restart `legalbody-api`), then run the
acceptance legs.

## What to watch

`journalctl -u legalbody-api -f | grep opslog`

- `legal_body_lookup` — one JSON line per memo MISS: `{"matchedBy":"pocket"|"treasury"|"none","standing":…}`. Never the address.
- `legal_body_lookup_throttled` — `{"bucket":"client"|"shared"}`, at most once per 60 s whatever the volume.
- The seller logs nothing per request. It warns ONCE at boot (`console.warn`, same unit log) when the
  policy is set with no `agentkit` config ("is INERT … behaves as 'open'") or with no resolver wired.

## Records

| Date (UTC) | Agent | Wall | Payer address | Settlement id | Header seen | Notes |
|---|---|---|---|---|---|---|
| _(first successful third leg goes here)_ | | | | | | |
