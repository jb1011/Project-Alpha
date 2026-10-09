# Runbook — the legal-body check

A seller on World's AgentKit can ask whether a verified unique human vouches for the address
about to pay it; this ships the second question, "does a registered legal body stand behind
that address, and does Novi state its standing as active?", as a public lookup, a
seller policy and a demo (design 2026-09-10, D1–D8). The configured seller is untouched: the wall pins its own.

## The public lookup

`GET /legal-bodies/:address` is mounted on the API app at the root, beside `/transparency` (`api/app.ts` →
`mountLegalBodyRoutes`), so it answers wherever the API answers. Two hosts reach it.
`https://api.novicorpus.com/legal-bodies/<address>` is the box directly, and the URL the code hands out wherever
`PUBLIC_API_URL` is set (`main.ts` composes `how.lookup` from `cfg.publicApiUrl ?? cfg.metadataBaseUrl`) — use it for
anything that reads headers, caches or runs in a browser. `https://www.novicorpus.com/backend/legal-bodies/<address>`,
the Vercel proxy other public surfaces use, forwards allowlists only (`interface/src/lib/proxyHeaders.ts`): no CORS
header (a browser-side seller gets a CORS error, not an answer), no `Cache-Control`, and no `X-NOVI-LEGAL-BODY` until
the interface at HEAD is deployed. `links.metadata` stays on `METADATA_BASE_URL` either way.

**A known active body** — agent 843704 (TestMB2), the first Novi legal body registered in AgentBook (2026-09-09). An
address we have no entity for answers 200 with four keys and nothing else, echoed EIP-55-checksummed; a bad one
answers 400 (all-lowercase or EIP-55 only, viem `isAddress(a, {strict:true})`, never silently re-cased).

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

**Every field of the 200 for a body**: `address` (echoed EIP-55), `legalBody`, `standing`, `agentId` (a decimal STRING
— a uint256 token id), `publicId`, `name`, `network`, `links` (`transparency`, plus `metadata` =
`<METADATA_BASE_URL>/metadata/<publicId>`, null when the row has no `publicId`, as above), `formation`, `checkedAt`,
and nothing else. `formation` is null when the entity has no company and otherwise carries FOUR fields — `filed`,
`einIssued`, `status`, `environment` (`sandbox` beside the status on purpose, so a sandbox filing can never read as a
Wyoming company) — never the EIN, never the filing number. `standing` is what the chain says at that moment: `active`
only when `legalStatus == 0` and the treasury is not paused, `inactive` on a definitive negative, `unknown` when the
read failed — never guessed, never memoised.

**Throttling, freshness, 503, 404.** Two token buckets, both spent on a memo MISS only (a hit reads no chain): a
per-client `TokenBucket(10, 0.5)` keyed by the LAST `X-Forwarded-For` entry, the one the proxy in front of the API
appended (`"direct"` if none; 2000 keys), in front of one process-wide `TokenBucket(30, 1)`. Either refuses identically —
`{"error":"rate_limited","message":"try again in a few seconds"}`, 429 — so a caller never learns which, and one ops
line per 60 s names it. A definitive 200 carries `Cache-Control: public, max-age=15`, matching the 15-second
per-address memo; `standing: "unknown"`, the 400, the 429 and the 503 carry `no-store`. The 503 —
`{"error":"unavailable","message":"could not check right now; try again shortly"}` — comes only from the local
database read; every chain failure is `unknown`, not a throw. A deployment with NO resolver wired never mounts the
route, so it answers 404 — a fourth non-200, read as `null` by the checker like the other three.

**A Minimal legal body** (one the legal-body factory created for an ERC-8004 agent whose owner brought an existing
Wyoming LLC). The branch exists only where the legal-body feature is on (`LEGAL_BODY_FACTORY_ADDRESS` and
`CONTROLLER_ADDRESS`) AND `NOVI_ATTESTATION_KEY` is set: `main.ts` builds `legalBodyStatements` from those. Without it
the address route answers exactly as above and `GET /legal-bodies/by-agent/:agentId` is a 404. It is asked only for an
address the full-product resolver does not know, so every full-product answer is unchanged. Its candidates are the
agents whose legal-body rows record the address as the identity owner, then those whose logged statements record it
as the agent's wallet (at most 5); one snapshot reads their wallets, and only an agent whose `getAgentWallet` is that
address, read fresh and again at the statement's own block, gets a statement (the first 3 confirmed; an `active` one
is preferred). The answer then carries the signed statement (`docs/identity/legal-body-statement.md`): `standing` may
also be `pending`, `name` is the statement's `legalName` (empty until it may be shown), `links.metadata` and
`formation` are null, and `links.statement` is the by-agent URL. A signed statement is memoised and served
`public, max-age=15` whatever its standing, a signed `unknown` included. A chain failure answers `unknown` with
`statement: null` and `agentId: null`: `no-store`, never memoised, no statement-log row. It can rest on candidates the
chain could not confirm, so it is not a yes. The 503 still means the local database. The by-agent route has its own
15-second memo, and shares both token buckets: one token from each per miss, however many reads the miss makes. Its
400 is
`{"error":"validation_error","message":"agentId must be a decimal token id of at most 78 digits, without leading zeros"}`.
A wallet that is not the identity owner is found by address only after a by-agent miss has logged it, and after the
address's own 15-second memo of `legalBody: false` has passed.

```bash
curl -s https://api.novicorpus.com/legal-bodies/by-agent/<agentId> | jq '.legalBody, .standing, .statement.message.bindingState'
```

## The seller policy

`X402_TRUST_POLICY=legal-bodies-only` (third value, `config/env.ts`) applies to the deployment's configured wall at
`/x402-demo/quote`. It requires, in order: an `agentkit` config AND a resolver wired — either one missing and EVERY
request is refused 503, ahead of the no-proof 403 (`accountable-only` still degrades to `open` without it —
pre-existing); an `agentkit` header; a valid proof of a verified unique human (that AgentBook answer is memoised 1 h
positive / 60 s negative, as under `accountable-only`, so a REVOKED vouch can clear this first gate for up to an
hour); then `resolveLegalBody()` on the PROOF'S SIGNER, read fresh every time, never anything the caller asserted,
returning a public-on-chain Novi entity — matched by pocket or treasury — whose `legalStatus == 0` and treasury is not
paused. The four refusal bodies, verbatim (`payments/seller.ts`):

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

**The per-human meter: one unit per purchase, one per refusal, zero on a 503.** Exhaustion is checked BEFORE any chain
read (the 429 above), and the unit is spent once the legal answer is DEFINITIVE. The 402 a passing check leads to is
charged; the paid request that follows is exempt ONLY because it is SERVED — that skip needs a payment we can verify
locally (recipient, amount, expiry, signature, unspent nonce) AND a settlement that succeeds. Everything else charges:
both legal 403s whatever rode along, and a payment that fails to settle; only the 503 charges nothing, so
`X-AGENTKIT-AUTHORIZATION` is absent from it. Each issued 402 buys exactly ONE paid attempt: past that a
payment-carrying request is refused 429 before the facilitator and before the Arc reads, capping settle attempts per
human per window at the allowance. `accountable-only` gets that bound and one unit per PURCHASE, refusals unchanged.

Served: `X-AGENTKIT-HUMAN`, `X-AGENTKIT-AUTHORIZATION: <used>/<limit>` and `X-NOVI-LEGAL-BODY: <agentId>` (omitted,
never blank, when the record has no agent id) — all three already on the 402 invoice a passing check leads to. The 200
body adds `humanBacked: true` and `legalBody: {"agentId": …}`; `X-PAYMENT-RESPONSE` carries the transfer id.

## The demo

Both demo URLs come from one base — `<PUBLIC_API_URL>/x402-demo`, falling back to the directory `resourceUrl` sits in
(`https://www.novicorpus.com/backend/x402-demo`) when the env is unset. With it set: the pinned wall (its own policy
regardless of `X402_TRUST_POLICY`; settles) is `https://api.novicorpus.com/x402-demo/legal-bodies-wall`, advertised
and signed against at the very URL it is served on; the run is `https://api.novicorpus.com/x402-demo/legal-bodies-run`
(one per 5 s, else `{"error":"slow-down","detail":"one run every 5 seconds"}`).

The run returns `{policy, resource, runUrl, statement, legs, expected, thirdLeg}`: leg 1 `anonymous` = 403
`human_backing_required` / `no-proof-presented`; leg 2 `human-backed, no legal body` = 403 `legal_body_required` /
`not-legal-body` with the `how` block, signed live by the Lisbon proof agent from leg 1's own challenge. It spends
neither money nor budget — no `settle`, its own rate key (`…#legal-bodies-run`), `allowancePerHuman: 10_000` — so runs
never turn leg 2 into a 429 and the real wall keeps `WORLD_ALLOWANCE_PER_HUMAN` (3 per 24 h). Record it any time.

**Leg 3, the payment that goes through — from the product.** Use agent 843704 (TestMB2): AgentBook-registered AND a
Novi legal body whose lookup answers yes: "a registered legal body stands behind this address, and Novi states
its standing as active". There is no dashboard button; the payment surface is the MCP tool `pay`, and the
pocket needs Gateway float (`fund_pocket`) first:

```
pay { id: "<the entity's idempotency key>", to: "https://api.novicorpus.com/x402-demo/legal-bodies-wall",
      amountUsdc: "10000",  /* atomic USDC = 0.01 */  idempotencyKey: "<fresh>" }
```

In order (`payments/buyer.ts`, the strict-wall recovery): (1) the first request carries NO `agentkit` header —
deliberately: a non-strict but AgentKit-aware seller would otherwise spend an allowance unit on every purchase — so
the wall answers **403** `human_backing_required` / `no-proof-presented`, challenge in `extensions.agentkit`; (2) the
buyer checks that challenge names the host it is buying from, mints the proof with the agent's own pocket AgentKit
signer (World Chain, `eip155:480`) and retries the SAME request ONCE, nothing signed for money; (3) human-backed AND a
legal body → **402** invoice, carrying `X-AGENTKIT-HUMAN`, `X-AGENTKIT-AUTHORIZATION` and `X-NOVI-LEGAL-BODY: 843704`;
(4) authorize → the paid retry carries a FRESH proof from the 402's own challenge (the seller consumes each nonce on
first use) plus `X-PAYMENT` → **200**, same header, `legalBody: {"agentId":"843704"}`, and `pay` returns
`{"ok":true,"txOrTransferId":"<id>"}`. Pay the `api.novicorpus.com` URL: on the proxy the header is dropped unless the
interface at HEAD is live.

**What a failed leg 3 looks like.** A second 403 (proof in hand, no body behind the payer) is terminal and `pay`
quotes the seller:
`{"ok":false,"txOrTransferId":null,"reason":"resource-403-after-proof: legal_body_required (not-legal-body): this seller trades only with agents that a registered legal body in good standing stands behind"}`.
Nothing was signed, so the claim is released and the key retries once the agent has a body. A bare `resource-403`
means no usable challenge (or no World layer: no signer, no recovery); `challenge-origin-mismatch`, a challenge naming
another site; `resource-503`, that the check could not be made — retry, it costs no allowance.

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

ONE env addition on the box, then the usual deploy (pull, build) and a restart:

```bash
# in the backend directory, as the service user
echo 'PUBLIC_API_URL=https://api.novicorpus.com' >> .env
sudo systemctl restart legalbody-api
```

It is optional — unset, every public link falls back to `METADATA_BASE_URL` (the www proxy) and nothing fails to boot
— but without it `how.lookup` and the advertised wall point at the hop that strips CORS, `Cache-Control` and
`X-NOVI-LEGAL-BODY`. The wall mints its challenges for whatever base it advertises. `X402_TRUST_POLICY` stays `open`
(the demo wall pins its own), and **redeploy the interface too** (Vercel): only that lets `X-NOVI-LEGAL-BODY` survive
the `www/backend` hop. Then run the acceptance legs.

## What to watch — `journalctl -u legalbody-api -f | grep opslog`

- `legal_body_lookup` — one JSON line per memo MISS: `{"matchedBy":"pocket"|"treasury"|"statement"|"none","standing":…}`
  (`statement` for a Minimal legal body). Never the address.
- `legal_body_lookup_throttled` — `{"bucket":"client"|"shared"}`, at most once per 60 s whatever the volume.
- `attestation_key_loaded`: once at boot, `{"attestor":"0x…"}`, the attestor's public address; compare it with the ENS
  record `com.novicorpus.attestor`. `legal_body_statements_off` `{"reason":"no_attestation_key"}` instead: the
  legal-body feature is on and no statement can be signed.
- `legal_body_statement`: one line per signed statement, `{"agentId","standing","bindingState"}`.
- `legal_body_statement_unavailable`: `{"stage":"snapshot"|"code"|"sign","errorName"}`, a chain read or the signature
  failed, so the answer was an unsigned `unknown` (or `/transparency` could not read its legal-body section).
  Repeating: a node problem.
- `legal_body_statement_integrity` (`{"legalBodyId","problem"}`: the chain disagrees with a row, or the row is not one
  this deployment states) and `legal_body_statement_unlisted_body` (`{"agentId"}`: the chain links a body with no
  public row here): no statement is made. Both are worth an alarm.
- `legal_body_statement_log_failed`: `{"legalBodyId","errorName"}`, the statement was served and its log row not
  written.
- `legal_body_statement_throttled`: the by-agent route's throttle line, `{"bucket"}`, at most once per 60 s.
- `legal_body_statement_db_failed`: `{"errorName"}`, a database read of the statement failed: the 503 of the by-agent
  route, or of the address route's Minimal branch (the full-product resolver's own 503 writes no line).
- The seller logs nothing per request. It warns ONCE at boot (`console.warn`, same unit log) when
  `legal-bodies-only` has no `agentkit` config or no resolver: "every request is refused 503", and it is.

## Records

| Date (UTC) | Agent | Wall | Payer address | Settlement id | Header seen | Notes |
|---|---|---|---|---|---|---|
| _(first successful third leg goes here)_ | | | | | | |
