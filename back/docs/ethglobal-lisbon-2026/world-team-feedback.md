# Feedback for the World team — DRAFT, not yet sent

Written 2026-07-29, after the post-hackathon audit. Intended recipient: MrSauron (World, Discord).
**Status: held, awaiting send.**

Everything below was verified before drafting — see "Evidence" at the bottom for what is fact,
what is a well-supported question, and what is inference. Deliberately contains **no bug reports
about our own code**: the sybil-binding gap the audit found was ours, not World's, and including
it would confuse whose problem it was.

Item 5 from the original list (the AgentBook CLI failing once, then succeeding with no change)
was **dropped** by user decision — too thin to be worth their time.

---

## The message

Hey! Following up now that things have settled. Thanks again for the prize.

We shipped a full World integration over the weekend. World ID gates every legal entity we
create, which matters for us because a Wyoming DAO LLC legally needs a real person behind it, so
personhood is doing real work here rather than being a badge. We also put AgentBook and AgentKit
on our x402 seller. It's live and runs itself if you want a look:
**project-alpha-pi.vercel.app/proof**

We audited the whole thing afterwards and three things came up that I thought were worth passing
back.

**1. AgentBook registration is Orb only.** World ID takes NFC passports now, but registering an
agent still needs an Orb, so someone can be fully verified and still not able to register. We ran
into this ourselves. France isn't in the passport list, so nobody on our team can use that route
at all. It ended up shaping the product too: we made document attestation optional instead of
required, because requiring it would have locked out most of Europe including us. Is opening
registration to passport verified users on the roadmap?

**2. The client can't handle a seller that refuses before payment.** We built a seller that turns
away agents nobody vouches for. It returns 403 with instructions on how to become eligible,
rather than 402, since "pay me" would be a lie when payment isn't the thing that's missing. But
the client only reacts to 402 (`if (response.status !== 402) return response;`, and 403 doesn't
appear anywhere in either package), so the agent never gets the chance to present its proof. That
rules out the whole accountability before commerce category. We worked around it by handling the
challenge manually and it's public in our repo. If the client could also recover from a 403
carrying an agentkit extension, that whole category opens up.

**3. On Identity Check, are we missing a field?** The verify response confirms the proof is
genuine but doesn't tell us which attributes were actually satisfied. In what we captured,
`identity_attested` only shows up on the payload the user's own browser sends us. That's fine for
a mini app where you control the client, but weaker for a website where the visitor controls
their browser. We implemented it exactly as documented and treat it internally as a claim rather
than proof.

Related question: what is `expires_at_min`? We assumed it was the credential expiry and nearly
shipped a check against it. Turns out that across four real proofs it consistently lands 19 to 44
seconds in the past, before the verification that produced it, so reading it as an expiry would
have refused every one of our users. Is it the proof's own validity window? And if we want to
know when someone's credential actually lapses, what should we be reading?

Happy to go deeper on number 2, we've already built the workaround and could share it properly.
The Arc and World combination has been working really well for us.

---

## Evidence behind each claim

Grade matters: #2 is stated as fact because it is checkable in their own source; #3 and #4 are
phrased as questions so that if we missed a field, we asked well rather than claimed wrongly.

**#1 — Orb-only registration. LIVED.** The user could not complete a document attestation at all;
World's passport-credential coverage is roughly a dozen countries and excludes France. This is
also why `WORLD_ATTEST_ACTION` gates an optional step-up rather than a requirement
(see spec-world-2.md).

**#2 — SDK ignores 403. CONFIRMED IN THEIR SOURCE.**
`node_modules/@worldcoin/agentkit/dist/esm/index.mjs:130`:
```js
if (response.status !== 402) return response;
```
`grep 403` across both `@worldcoin/agentkit` and `@worldcoin/agentkit-core` returns nothing. Our
workaround is the hand-rolled probe-and-mint in `src/api/routes/x402Demo.ts` (the /proof runner).

**#3 — attestation flag is client-side. CONFIRMED, single sample.** From our own captured
round-trip (`test/world/fixtures/attest-verify-response.json`, staging, 2026-07-25):
- World's response keys: `success, action, nullifier, created_at, environment, results, message`
  — no `identity_attested`, and `results[0]` is only `{identifier, nullifier, success}`.
- The client payload keys include `identity_attested: true`.

⚠ One response, one environment, one request type. Hence "are we missing a field?" rather than
"you don't return it."

**#4 — `expires_at_min` is in the past. MEASUREMENT CONFIRMED (4 points), MEANING INFERRED.**
Three production `guardian_verifications` rows plus the staging attestation fixture. Deltas
(`verified_at − expires_at_min × 1000`): **+29s, +19s, +44s**, and the fixture value 1785005211
decodes as seconds to its own capture date. Spread is consistent with proof-generation-to-record
latency. Read as minutes it lands in the year 5363.

We nearly shipped a gate on this field (PR #58's first attempt) which would have refused **every**
guardian; the reversal and a regression test are in `worldId.ts` / `guardianEntityCap.test.ts`.
That near-miss is why this is asked as a question, not asserted as a bug.

## If it needs to be shorter

Cut the second half of #3 (the `expires_at_min` question) and send it as a follow-up once they
reply. It is the least important of the four and stands alone fine.
