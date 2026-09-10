# Runbook — the legal-body check

A seller on World's AgentKit can ask whether a verified unique human vouches for the address about to pay
it; this ships the second question, "is that address the payment address of a Novi legal body in good
standing?", as a public lookup, a seller policy and a demo (design 2026-09-10, D1–D8). The lookup is
unauthenticated and says only what the chain says; the configured seller is untouched (the wall pins its own).

## The public lookup

`GET /legal-bodies/:address` is mounted on the API app at the root, beside `/transparency`
(`api/app.ts` → `mountLegalBodyRoutes`), so it answers wherever the API answers. Two hosts reach it:

- `https://api.novicorpus.com/legal-bodies/<address>` — the box directly, and the URL the code hands out wherever
  `PUBLIC_API_URL` is set (`main.ts` composes `how.lookup` from `cfg.publicApiUrl ?? cfg.metadataBaseUrl`). Use it
  for anything that reads response headers, caches, or runs in a browser.
- `https://www.novicorpus.com/backend/legal-bodies/<address>` — the Vercel proxy every other public surface uses.
  Reachable, but it forwards allowlists only (`interface/src/lib/proxyHeaders.ts`): no CORS header (a browser-side
  seller gets a CORS error instead of an answer), no `Cache-Control` (freshness lost) and no `X-NOVI-LEGAL-BODY`
  until the interface at HEAD is deployed — this branch adds that one to `FORWARDED_RESPONSE_HEADERS`. Fine for a
  curl. The answer's `links.metadata` stays on `METADATA_BASE_URL` (that proxy): the documents live there.

**A known active body** — agent 843704 (TestMB2), the first Novi legal body registered in AgentBook (2026-09-09).
An address we have no entity for answers 200 with four keys and nothing else, the address echoed
EIP-55-checksummed; a bad address answers 400 (all-lowercase or valid EIP-55 only, viem `isAddress(a,
{strict:true})` — an all-uppercase address is refused rather than silently re-cased).

```bash
curl -s https://api.novicorpus.com/legal-bodies/0xeE85Fd00521d1Aa4c510BDdAb78F375830119354
# {"address":"0xeE85Fd00521d1Aa4c510BDdAb78F375830119354","legalBody":true,"standing":"active",
#  "agentId":"843704","publicId":null,"name":"TestMB2","network":"testnet","links":{"transparency":
#  "https://www.novicorpus.com/transparency","metadata":null},"formation":null,"checkedAt":"…"}
curl -s https://api.novicorpus.com/legal-bodies/0x000000000000000000000000000000000000dead
# {"address":"0x000000000000000000000000000000000000dEaD","legalBody":false,"standing":null,"checkedAt":"…"}
curl -s https://api.novicorpus.com/legal-bodies/0xnope
# {"error":"validation_error","message":"address must be a 20-byte hex address, either all-lowercase or EIP-55 checksummed"}
```

`agentId` is a decimal STRING (a uint256 token id). That row carries no `publicId` on prod today, so
`links.metadata` is null; a row with one gets `<METADATA_BASE_URL>/metadata/<publicId>`, and `formation` is
null when the entity has no company. `standing` is whatever the chain says at that moment: `active` only when
`legalStatus == 0` and the treasury is not paused, `inactive` on a definitive negative, `unknown` when the
read failed — never guessed, never memoised.

**Throttling, freshness, 503.** Two token buckets, both spent on a memo MISS only (a hit makes no chain read and
costs nothing): a per-client `TokenBucket(10, 0.5)` keyed by the first `X-Forwarded-For` entry (`"direct"` when
there is none; 2000 keys, coldest evicted), in front of one process-wide `TokenBucket(30, 1)`. Either refuses
identically — `{"error":"rate_limited","message":"try again in a few seconds"}`, 429 — so a caller never learns
which it hit, plus one ops line per 60 s naming the bucket. A definitive 200 (`active`, `inactive`, `legalBody:
false`) carries `Cache-Control: public, max-age=15`, matching the 15 s per-address memo; `standing: "unknown"`,
the 400, the 429 and the 503 carry `no-store` (worst case, 30 s of staleness). The 503 —
`{"error":"unavailable","message":"could not check right now; try again shortly"}` — can only come from the local
database read: every chain failure is `unknown`, not a throw.

## The seller policy

`X402_TRUST_POLICY=legal-bodies-only` (third value, `config/env.ts`) applies to the deployment's configured
wall at `/x402-demo/quote`. It requires, in order: an `agentkit` config AND a resolver wired — either one missing
and EVERY request is refused 503, ahead of the no-proof 403 (`accountable-only` still degrades to `open` without
its `agentkit` config — pre-existing); an `agentkit` header; a valid proof of a verified unique human; then
`resolveLegalBody()` on the PROOF'S SIGNER, never anything the caller asserted, returning a public-on-chain Novi
entity — matched by pocket or treasury — whose `legalStatus == 0` and whose treasury is not paused. The four
refusal bodies, verbatim (`payments/seller.ts`, re-verified at HEAD):

- **403** no proof, an invalid proof or no human — unchanged from `accountable-only` (`reason` is then the
  verifier's own):
  `{"error":"human_backing_required","detail":"this seller trades only with agents a verified unique human answers for","reason":"no-proof-presented","how":{"register":"npx @worldcoin/agentkit-cli register <your-agent-address>","agentBook":"<configured AgentBook address>","chain":"world-chain"},"extensions":{…}}`
- **429** the per-human budget, unchanged: `{"error":"rate-capped","detail":"per-human request budget exhausted for this window"}`, with `X-AGENTKIT-HUMAN` set.
- **403** human-backed, no legal body:
  `{"error":"legal_body_required","detail":"this seller trades only with agents that a registered legal body in good standing stands behind","reason":"not-legal-body","how":{"lookup":"https://api.novicorpus.com/legal-bodies/<checked address>","onboard":"https://www.novicorpus.com/","transparency":"https://www.novicorpus.com/transparency"},"extensions":{…}}`
  — `reason` is `legal-body-inactive` for a suspended body; everything else is identical, and
  `how.lookup` is `<PUBLIC_API_URL or METADATA_BASE_URL>/legal-bodies/<the proof's signer>`.
- **503** the check could not be MADE (fail closed, nothing remembered):
  `{"error":"legal_body_check_unavailable","detail":"the legal-body check could not be completed just now"}` — and
  with no resolver or no `agentkit` config: `"detail":"this seller's legal-body check is not configured right now"`.

**The per-human meter, under this policy only.** Exhaustion is checked BEFORE any chain read (an exhausted human
gets the 429 above and no Arc read happens); the unit is spent only once the legal answer is DEFINITIVE — on the
402 invoice a passing check leads to (the paid request that follows, carrying a valid payment, is never charged again, so a completed purchase costs one unit), and on both legal 403s, since a refusal still cost a signature check, an
AgentBook read and two Arc reads — and NEVER on the 503, whose retry must stay free (the store has no release).
`X-AGENTKIT-AUTHORIZATION` reports the charge, so it is absent from the 503; `accountable-only` still charges
inside the proof verification, unchanged.

Served: `X-AGENTKIT-HUMAN`, `X-AGENTKIT-AUTHORIZATION: <used>/<limit>` and `X-NOVI-LEGAL-BODY: <agentId>` (omitted,
never blank, when the record has no agent id) — all three already on the 402 invoice a passing check leads to. The
200 body adds `humanBacked: true` and `legalBody: {"agentId": …}`; `X-PAYMENT-RESPONSE` carries the transfer id.

## The demo

Both demo URLs come from one base — `<PUBLIC_API_URL>/x402-demo`, falling back to the directory `resourceUrl` sits
in (`https://www.novicorpus.com/backend/x402-demo`) when the env is unset. With `PUBLIC_API_URL` set on the box: the
pinned wall (its own policy regardless of `X402_TRUST_POLICY`; settles) is
`https://api.novicorpus.com/x402-demo/legal-bodies-wall`, advertised and signed against at the very URL it is served
on; the run is `https://api.novicorpus.com/x402-demo/legal-bodies-run` (one per 5 s, else
`{"error":"slow-down","detail":"one run every 5 seconds"}`).

The run returns `{policy, resource, runUrl, statement, legs, expected, thirdLeg}`: leg 1 `anonymous` = 403
`human_backing_required` / `no-proof-presented`; leg 2 `human-backed, no legal body` = 403 `legal_body_required` /
`not-legal-body` with the `how` block, signed live by the Lisbon proof agent from leg 1's own challenge. It spends
neither money nor budget: the instance it probes has no `settle`, its own rate key (`…#legal-bodies-run`) and
`allowancePerHuman: 10_000`, an effectively unlimited meter — so runs never turn leg 2 into a 429, and the real
wall keeps `WORLD_ALLOWANCE_PER_HUMAN` (3 per 24 h). Record it any time.

**Leg 3, the payment that goes through — from the product.** Use agent 843704 (TestMB2): AgentBook-registered AND
a Novi legal body in good standing, exactly what the wall asks for. There is no dashboard button; the payment
surface is the MCP tool `pay`, and the pocket needs Gateway float (`fund_pocket`) first:

```
pay { id: "<the entity's idempotency key>", to: "https://api.novicorpus.com/x402-demo/legal-bodies-wall",
      amountUsdc: "10000",  /* atomic USDC = 0.01 */  idempotencyKey: "<fresh>" }
```

In order (`payments/buyer.ts`, the strict-wall recovery): (1) the first request carries NO `agentkit` header —
deliberately, or a non-strict but AgentKit-aware seller would spend one of the human's allowance units on every
purchase — so the wall answers **403** `human_backing_required` / `no-proof-presented`, challenge in
`extensions.agentkit`; (2) the buyer mints the proof from it with the agent's own pocket AgentKit signer (World Chain,
`eip155:480`) and retries the SAME request ONCE with it, signing nothing for money;
(3) human-backed AND a legal body → **402** invoice, already carrying `X-AGENTKIT-HUMAN`, `X-AGENTKIT-AUTHORIZATION`
and `X-NOVI-LEGAL-BODY: 843704`; (4) authorize → the paid retry carries a FRESH proof minted from the 402's own challenge (the seller consumes each nonce on first use) and adds `X-PAYMENT` →
**200**, same header, `legalBody: {"agentId":"843704"}` in the body, and `pay` returns `{"ok":true,
"txOrTransferId":"<settlement id>"}`. Pay the `api.novicorpus.com` URL: on the proxy that header is dropped unless
the interface at HEAD is live.

**What a failed leg 3 looks like.** A second 403 (proof in hand, no legal body behind the payer) is terminal and
`pay` quotes the seller: `{"ok":false,"txOrTransferId":null,"reason":"resource-403-after-proof: legal_body_required
(not-legal-body): this seller trades only with agents that a registered legal body in good standing stands behind"}`.
Nothing was signed, so the claim is released and the same key retries once the agent has a body. A bare `resource-403`
means no usable challenge (or no World layer here: no signer, no recovery); `resource-503`, that the check could not
be made — retry, it costs no allowance.

## Acceptance (design §6)

```bash
API=https://api.novicorpus.com
# 1, 2 — a known active body, then an address we have no entity for
curl -s $API/legal-bodies/0xeE85Fd00521d1Aa4c510BDdAb78F375830119354 | jq '.legalBody, .standing, .agentId'
curl -s $API/legal-bodies/0x000000000000000000000000000000000000dead | jq '.legalBody, .standing'
# 3 — the two refusal legs
curl -s $API/x402-demo/legal-bodies-run | jq '.legs[] | {name, status, error: .body.error, reason: .body.reason}'
# 4 — the third leg, from the product: MCP `pay` from 843704 to $API/x402-demo/legal-bodies-wall, amountUsdc "10000"
# 5 — the buyer dial is unchanged by the refactor
cd back/backend && npx vitest run test/payments/sellerTrust.test.ts
```

## Deploy

ONE env addition on the box, then the usual deploy (`ssh novi-prod`, pull, build) and a restart:

```bash
# as novi, in /home/novi/Project-Alpha/back/backend
echo 'PUBLIC_API_URL=https://api.novicorpus.com' >> .env
sudo systemctl restart legalbody-api
```

It is optional — unset, every public link falls back to `METADATA_BASE_URL` (the www proxy) and nothing fails to
boot — but without it `how.lookup` and the advertised wall point at the hop that strips CORS, `Cache-Control` and
`X-NOVI-LEGAL-BODY`. `X402_TRUST_POLICY` stays `open`: the demo wall pins its own policy. **Redeploy the interface
too** (Vercel): only that lets `X-NOVI-LEGAL-BODY` survive the `www/backend` hop. Then run the acceptance legs.

## What to watch — `journalctl -u legalbody-api -f | grep opslog`

- `legal_body_lookup` — one JSON line per memo MISS: `{"matchedBy":"pocket"|"treasury"|"none","standing":…}`. Never the address.
- `legal_body_lookup_throttled` — `{"bucket":"client"|"shared"}`, at most once per 60 s whatever the volume.
- The seller logs nothing per request. It warns ONCE at boot (`console.warn`, same unit log) when
  `legal-bodies-only` has no `agentkit` config or no resolver: "every request is refused 503", and it is.

## Records

| Date (UTC) | Agent | Wall | Payer address | Settlement id | Header seen | Notes |
|---|---|---|---|---|---|---|
| _(first successful third leg goes here)_ | | | | | | |
