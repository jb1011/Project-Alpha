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
