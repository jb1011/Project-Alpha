# Asking AgentKit's question and ours in the same call

For a seller already running World's AgentKit. Nothing here needs a change on World's side.

## What it answers

AgentKit answers one question about the agent paying you: does a verified unique human vouch for
this address? `createLegalBodyAgentBook` adds the second: is this address the payment address of a
Novi legal body in good standing? It answers both through one object, because AgentKit takes one
object. A non-null answer now means both are true; `null` means at least one is not, which is the
only refusal shape AgentKit has.

## The swap

Verified against the installed packages, `@worldcoin/agentkit` 0.2.0 and
`@worldcoin/agentkit-core` 0.2.0.

`createAgentkitHooks(options)` takes `options.agentBook: AgentBookVerifier`
(`node_modules/@worldcoin/agentkit/dist/cjs/index.d.ts`, `CreateAgentkitHooksOptions` at line 111,
the `agentBook` field at line 112, the factory at line 119). `AgentBookVerifier` is just the return
type of `createAgentBookVerifier(options?)` from `@worldcoin/agentkit-core`
(`dist/cjs/index.d.ts:188`), which is an object with a single method,
`lookupHuman(address: string): Promise<string | null>` (line 194); the type alias is on line 196.
So anything with that one method is a valid `agentBook`, and the swap is three lines:

```ts
import { createAgentkitHooks } from "@worldcoin/agentkit";
import { createAgentBookVerifier } from "@worldcoin/agentkit-core";
import { createLegalBodyAgentBook } from "./legalBodyAgentBook";

const hooks = createAgentkitHooks({
  agentBook: createLegalBodyAgentBook({
    agentBook: createAgentBookVerifier(),          // the real World Chain read, unchanged
    lookupBaseUrl: "https://api.novicorpus.com",   // your Novi deployment
  }),
});
```

`createAgentBookVerifier()` still takes its usual `AgentBookOptions` (`client`, `contractAddress`,
`rpcUrl`, lines 180-186) — the wrapper does not touch them.

The same object fits a seller that verifies the header itself instead of using the hooks. Our
backend's `verifyAgentkitRequest` accepts an optional `agentBook` of exactly this shape
(`back/backend/src/payments/worldVerifier.ts:66`) and calls `verifier.lookupHuman(agentAddress)`
with the address recovered from the proof's signature (line 167), so passing
`createLegalBodyAgentBook({ ... })` as `cfg.agentBook` turns that gate into a legal-body gate with
no other change.

## The lookup contract

`GET <lookupBaseUrl>/legal-bodies/<address>`, no auth, CORS open. A known address answers 200:

```json
{
  "address": "0x…",
  "legalBody": true,
  "standing": "active",
  "agentId": 843704,
  "publicId": "…",
  "name": "…",
  "network": "testnet",
  "links": { "transparency": "https://www.novicorpus.com/transparency", "metadata": "https://…" },
  "formation": { "filed": false },
  "checkedAt": "2026-09-10T…Z"
}
```

An address we have no entity for answers 200 with `legalBody: false`, `standing: null`. A malformed
address answers 400.

`standing` has three values and only three:

- `active` — the entity's on-chain legal status is good and its treasury is not paused. This is the
  only value the checker treats as a yes.
- `inactive` — a definitive negative read: suspended, dissolved, or a paused treasury.
- `unknown` — the chain read failed. It is not a yes and not a no, and it is never guessed or
  remembered. Treat it as "we do not know", and refuse if your policy is fail-closed.

`formation` reports the filing state of the company behind the entity. It is reported, never
gating: what a seller can verify is the on-chain legal body.

## What you may say

The lookup reports what the chain says and no more. When the checker returns an id, the honest
sentence is:

> a registered legal body in good standing stands behind this address

and, if you want to name it, the `agentId` from the lookup. Never "verified company", never
"KYC'd", never "licensed". Show `standing: "unknown"` as unknown. Nothing here says who vouched for
the agent: the human identifier stays anonymous.

## Spoofing

The check is about an address, so only ask it about an address someone has just proved they
control. AgentKit hands `lookupHuman` the signer recovered from the proof, which is why wrapping
the verifier is safe: an attacker cannot present a legal body it cannot sign for. Calling the
lookup with an address out of a request body, a query string or a form field proves nothing —
anyone can name a legal body they do not control.

## When something goes wrong

Every doubt is `null`: no human, an AgentBook read that threw, any status other than 200, a body
that is not the contract above, unparseable JSON, a network error, or no answer within `timeoutMs`
(default 5000). The checker never throws, so it cannot take your 402 path down with it.

If the extra call costs you too much, cache it yourself — but cache positive answers only (a
negative is a state the agent is actively trying to leave), and keep the TTL short: a suspension
takes effect on the next lookup, so a long cache is how you keep trading with an entity that is no
longer in good standing. Our own lookup already memoises definitive answers for 15 seconds.

## Copying the file

`back/backend/src/payments/legalBodyAgentBook.ts` imports nothing — not from this backend, not from
npm. Copy it into your project, keep the header comment (it carries the two rules above), and it
compiles as-is. It is not published to npm today.
