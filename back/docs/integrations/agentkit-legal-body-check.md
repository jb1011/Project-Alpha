# Asking AgentKit's question and ours in the same call

For a seller already running World's AgentKit. Nothing here needs a change on World's side.

## What it answers

AgentKit answers one question about the agent paying you: does a verified unique human vouch for this
address? `createLegalBodyAgentBook` adds the second: is this address the payment address of a Novi
legal body in good standing? Both go through one object, because AgentKit takes one object. A non-null
answer means both are true; `null` means at least one is not — AgentKit's only refusal shape.

AgentKit reports every `null` as `agent_not_verified`, so if you show the buyer a reason, say the
address did not meet **both** conditions and link the lookup for it — never "no verified human", which
sends an agent with a good human off to fix the wrong thing.

## The swap

Verified against the installed `@worldcoin/agentkit` 0.2.0 and `@worldcoin/agentkit-core` 0.2.0.
`createAgentkitHooks(options)` takes `options.agentBook: AgentBookVerifier`
(`node_modules/@worldcoin/agentkit/dist/cjs/index.d.ts`: `CreateAgentkitHooksOptions` line 111, the
`agentBook` field line 112, the factory line 119). `AgentBookVerifier` is the return type of
`createAgentBookVerifier(options?)` from `@worldcoin/agentkit-core` (`dist/cjs/index.d.ts:188`, alias
on 196): one method, `lookupHuman(address: string): Promise<string | null>` (line 194). So anything
with that method is a valid `agentBook`, and the swap is three lines:

```ts
import { createAgentkitHooks } from "@worldcoin/agentkit";
import { createAgentBookVerifier } from "@worldcoin/agentkit-core";
import { createLegalBodyAgentBook } from "./legalBodyAgentBook";

const hooks = createAgentkitHooks({
  agentBook: createLegalBodyAgentBook({
    // the real World Chain read, untouched — its AgentBookOptions still apply (d.ts 180-186)
    agentBook: createAgentBookVerifier(),
    lookupBaseUrl: "https://api.novicorpus.com", // your Novi deployment
  }),
});
```

## Where the wrapper belongs, and where it does not

The hooks path above is what this is built for: `createAgentkitHooks` calls `lookupHuman` once per
request and caches nothing (its `AgentKitStorage` holds usage counters and nonces only,
`agentkit/dist/cjs/index.d.ts:67-78`), so a suspension is visible on the very next request. Another
gate with the same one-method shape works too, provided it does not cache the answer.

**If your gate caches `lookupHuman` answers, cap positives to seconds and never cache `null`.** A
cached yes keeps a suspended legal body trading for the whole TTL; a cached `null` records a failed
read as a definitive no and refuses an agent in good standing until it expires. Our own
`verifyAgentkitRequest` has this shape (the `agentBook` seam,
`back/backend/src/payments/worldVerifier.ts:57`, read at line 221) but memoises the answer for an
hour, sixty seconds for a negative (the TTL constants, lines 19 and 23), so the wrapper does not go
there; Novi's own `legal-bodies-only` seller verifies the AgentKit proof and then resolves the legal
body directly, fresh, on every request.

## The lookup contract

`GET <lookupBaseUrl>/legal-bodies/<address>`, no auth, CORS open. A known address answers 200:

```json
{
  "address": "0x…",
  "legalBody": true,
  "standing": "active",
  "agentId": "843704",
  "publicId": "…",
  "name": "…",
  "network": "testnet",
  "links": { "transparency": "https://www.novicorpus.com/transparency", "metadata": "https://…" },
  "formation": { "filed": false, "einIssued": false, "status": "…", "environment": "sandbox" },
  "checkedAt": "2026-09-10T…Z"
}
```

An address we have no entity for answers 200 with `legalBody: false`, `standing: null`. `standing` has
three values and only three:

- `active` — on-chain legal status good, treasury not paused. The only value the checker calls yes.
- `inactive` — a definitive negative read: suspended, dissolved, or a paused treasury.
- `unknown` — the chain read failed. Not a yes and not a no; never guessed, never remembered. Treat
  it as "we do not know", and refuse if your policy is fail-closed.

`formation` reports the filing state of the company behind the entity, and never gates anything: what
a seller can verify is the on-chain legal body. It is `null` when the entity has no company and
otherwise carries exactly four fields — `filed`, `einIssued`, `status`, `environment` (`sandbox` or
`production`, inseparable from the status) — never the EIN itself, never the filing number.

**Rate limit, freshness and the four non-200 answers.** Two token buckets brake the route: a
per-client one (10 burst, refilling 0.5/s, keyed by the first `X-Forwarded-For` entry) in front of one
shared by every caller of that API process (30 burst, 1/s). Both are spent on a cache miss only — the
lookup memoises the last definitive answer per address for 15 seconds, and a memo hit costs no token —
and either refuses with 429 and the same body, so keep your volume proportional. The non-200 answers
are exactly four: 400 (the address is neither all-lowercase nor valid EIP-55), that 429, 503 (the
lookup's own read failed) and 404 (that deployment wires no resolver, so the route is not mounted);
the checker reads all four as `null` — fail closed — as it does a 200 whose `standing` is anything but
`active`. A definitive 200 carries `Cache-Control: public, max-age=15`, every other answer `no-store`.

## What you may say

The lookup reports what the chain says and no more, so when the checker returns an id, say:

> a registered legal body in good standing stands behind this address

and, if you want to name it, the `agentId` from the lookup. Never "verified company", never "KYC'd",
never "licensed". Show `standing: "unknown"` as unknown. Nothing here says who vouched for the agent:
the human identifier stays anonymous.

## Spoofing

Only ask this about an address someone just proved they control. AgentKit hands `lookupHuman` the
signer recovered from the proof, so wrapping the verifier is safe: an attacker cannot present a legal
body it cannot sign for. An address from a request body or a query string proves nothing.

## When something goes wrong

Every doubt is `null`: no human, an AgentBook read that threw, any status other than 200 (a throttle
and a 5xx included), a body that is not the contract above, unparseable JSON, a network error, or no
answer within `timeoutMs` (default 5000). The checker never throws, so it cannot take your 402 path
down with it, and it has no cache of its own — if you add one, seconds, positives only.

## Copying the file

`back/backend/src/payments/legalBodyAgentBook.ts` imports nothing, from neither this backend nor npm.
Copy it in, keep the header comment (the two rules above); it compiles against `@types/node` 18+ or
`lib: ["dom"]` — the source of `fetch`, `AbortController`, `setTimeout`. Not on npm today.
