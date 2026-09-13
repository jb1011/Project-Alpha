# Building on AgentBook at ETHOnline 2026: what we made, what we noticed, and an idea

From the Novi Corpus team, September 2026. For the World AgentKit and AgentBook team.

Hello, and thank you for the work you put into AgentKit and AgentBook. We have been in touch with Mateo over the past weeks and talked together about an idea we both liked: letting a seller know not only that a real person stands behind an agent, but also that a real company does. We thought the best way to show how useful that could be was to build around it during the hackathon. This document is our thank-you note, a few observations from the build, and the idea written down properly so your team can look at it whenever the time is right.

## What we built

**Vouching for an agent from inside our product.** A guardian with an Orb-verified World ID can now vouch for their agent's payment address in AgentBook without leaving our dashboard. We pay the network fee, so the guardian does not need any ETH on World Chain. We used it for real on 9 September: one of our agents is now in AgentBook (agent 843704, transaction `0x31f50a24…3ac545` on World Chain), and our dashboard only shows "Vouched in AgentBook" once it has read the registry back and the block is final.

**The "is there a company behind this agent?" question.** AgentBook answers whether a verified human stands behind an address. We added the second half on our side:

- A public web address any seller can call to ask whether an address belongs to a Novi legal body in good standing. It reads the live state from the chain, so if we suspend a company, the answer changes within seconds.
- A small piece of code a seller can drop into AgentKit in place of the usual AgentBook check. It asks both questions at once and only says "yes" when both answers are yes. It has no dependencies, so it can simply be copied.
- A new option in our own seller, "legal bodies only", with a live demo: an anonymous agent is turned away, a human-backed agent with no company is turned away with a friendly "here is how to get a legal body", and a Novi agent that is also in AgentBook goes through.

Nothing on your side had to change for any of this, which is a nice property of how AgentKit is put together.

## What we noticed along the way

The overall experience was good: the contract is small and easy to read, the "look up the human" call is exactly the right building block, the challenge-and-sign flow in AgentKit is simple to implement on both ends, and paying the registration fee from our own server needed no special support. Everything below is the kind of small thing we would have loved to find in the docs, offered as suggestions in case they are useful.

1. **Which chain is which.** The registration guide starts on Base, while the registry sellers read lives on World Chain. A sentence at the top of the guide saying "AgentBook lives on World Chain; Base is the staging router" would make that clear from the first minute.
2. **A place to practise.** Every registration is a real, permanent write on World Chain. A test copy of AgentBook on a testnet, or a documented way to run the contract locally, would let teams rehearse the full flow before touching the real registry.
3. **Vouching into someone else's registry with the newest World ID kit.** The newest kit expects a context signed by the app owner, which a third-party product like ours cannot produce. We happily used the previous version through a pinned alias. A short recipe for "my app vouches into your registry" on the newest kit would remove that step.
4. **One address, two chains.** The signature check takes a single RPC address, so a seller accepting proofs from more than one chain has to pick the address per proof. Accepting a small map keyed by chain would match how sellers advertise themselves.
5. **When a seller asks for proof first.** If a seller refuses an unproven first request and includes the challenge in its answer, the AgentKit client today stops there. We taught our own client to answer the challenge and try once more, which made strict sellers usable. If the reference client did the same, any seller could ask for proof up front without breaking anyone.
6. **What one "unit" of the allowance means.** With the SDK helper in the loop, one purchase used three of a person's daily allowance units at our seller, because each verified request counted. We now count one per purchase. A line in the docs about what a unit is meant to count (a request, an authorization, a purchase) would help sellers land on the same answer.
7. **Fresh proof for every challenge.** Proofs are single-use, which is exactly right, and easy to miss on the paying step. One sentence in the client docs, "mint a new header for every challenge", would save a small surprise.
8. **How long until a vouch is final.** We show "vouched" only after reading the registry at the safe block, which trailed the transaction by about three minutes for us. That is fine; it would just be good to state it in the guide so nobody reads the latest block and shows a vouch that could still move.
9. **What World App shows.** The request appeared under the name "AgentKit" and did not ask for a face check on our device. Our consent text says it "may ask"; if the rule can be stated in advance, we would gladly write the exact wording.
10. **What a registration costs.** About 0.00000048 ETH all-in for us. Putting that number in the guide would reassure teams deciding who pays.
11. **A small status note.** During the event the repository was quiet, an open RFC had no reply yet, and a breaking CLI change was open. A short "what is stable, what is changing" note in the README would help teams building against a deadline.

To be clear, none of this blocked us. We finished both features in the event, and the pieces fit together well.

**On the Developer Portal.** Creating the app, the actions and the signing key was straightforward, and keeping separate action names per environment (our production action, a dedicated sandbox one) kept the portal analytics and our logs easy to read. Two small wishes: a search box that also finds actions and keys by name, and a "where do I debug this?" pointer next to each action showing the last few verification attempts and why they failed. That would have shortened our first afternoon.

**On the Sandbox App.** It gave us the one thing production never can: fresh identities on demand, each with its own nullifier, so we could rehearse onboarding a new guardian as often as we liked. Requesting tester access through the portal worked well. A couple of things worth knowing are easy to miss: an identity that already proved a uniqueness action cannot prove it again (World App refuses before anything leaves the phone, which is the sybil protection doing its job, so the answer is to reset the sandbox account), and the sandbox has no AgentBook, so the registration and seller flows still need the real registry. A note on both in the sandbox guide, and a sandbox registry one day, would round it out.

## The idea: a company behind the agent, inside AgentBook

**The gap.** AgentBook answers one question: does a verified, unique person stand behind this address? Sellers increasingly need a second one: does a legal body stand behind it, someone a contract can name and a court can reach? Today a seller has to go and find each issuer separately. We built our half; the seller still needs to know Novi exists.

**What we would love to see.** AgentBook, or the AgentKit payment extension, carrying "attestations" about an agent address next to the human vouch, so a seller asks once and gets both answers. Two ways this could look:

- **In the payment extension**, the smaller change: an `attestations` list in what the seller requires and in what the agent presents. Each entry says who issued it, which kind of claim it is (for example "legal body in good standing"), which agent it is about, when it expires, and carries the issuer's signature. The seller lists the kinds it wants; the agent presents the ones it holds; the verifier checks the signatures against a small list of known issuers. Nothing on chain changes.
- **In a future version of AgentBook**: a slot per address for attestations, written and revocable by the issuer, readable right next to the human lookup. The human vouch keeps its current behaviour; attestations are added on top and can be withdrawn, because a company's status can end.

**Why the issuer signs, not the person.** A "legal body" claim is only as good as the party that can take it back. We suspend a company on chain today, and the claim has to follow that within seconds. A credential signed by the person cannot do that; a claim signed and revocable by the issuer can.

**What we can bring.** A working issuer. Our public lookup already answers the question with the exact meaning the attestation would carry; the drop-in checker shows the seller side; our "legal bodies only" policy shows a seller using it. We would be glad to write the issuer side against whichever shape you prefer and to be the first entry in the list of issuers.

**Why we think it matters for World.** Every seller that wants "a real party behind this agent" today has to leave AgentBook to find it. With attestations, AgentBook becomes the one place that answers who is behind an agent, person and company, and issuers like us bring the second answer to it rather than around it.

## Where to look

- Live lookup for one of our agents: `https://api.novicorpus.com/legal-bodies/0xeE85Fd00521d1Aa4c510BDdAb78F375830119354`
- Live demo of the seller policy: `https://api.novicorpus.com/x402-demo/legal-bodies-run`
- How a seller plugs the check into AgentKit: [back/docs/integrations/agentkit-legal-body-check.md](https://github.com/jb1011/Project-Alpha/blob/main/back/docs/integrations/agentkit-legal-body-check.md)
- Design notes, for the curious: [back/docs/design/2026-08-25-agentbook-registration-design.md](https://github.com/jb1011/Project-Alpha/blob/main/back/docs/design/2026-08-25-agentbook-registration-design.md) and [back/docs/design/2026-09-10-legal-body-check-design.md](https://github.com/jb1011/Project-Alpha/blob/main/back/docs/design/2026-09-10-legal-body-check-design.md)

Thank you again for building something we could build on. We are around if any of this is useful to talk through.
