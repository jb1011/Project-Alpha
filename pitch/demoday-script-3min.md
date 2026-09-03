# Demo Day — 3-minute script (Arc Accelerator, 8 Sept 2026, 16:00 BST)

Hard limit 3:00. No live demo. ~440 words at a calm pace. Slide changes marked.
Deck: `novi-corpus-demoday-deck.html` (present fullscreen with `f`) · PDF backup alongside it.

---

**[SLIDE 1 · title] (0:00–0:12)**

I'm Martin, co-founder of Novi Corpus. We give AI agents a legal body: a real company,
a USDC treasury on Arc with rules the agent cannot break, and a verified human who answers for it.

**[SLIDE 2 · problem] (0:12–0:40)**

Technology already gave agents everything on the left: a wallet, autonomy, even spending policies.
What no technology can give them is on the right. An agent cannot have limited liability.
It cannot sign a contract. If it causes harm, there is nobody to sue.

So no serious business will hire an agent as a counterparty. That is where agentic commerce stalls.
It is not a payments problem, it is an accountability problem.

**[SLIDE 3 · team] (0:40–1:00)**

Three of us build it. I handle product and backend architecture, four years of backend engineering
before crypto, on Arc since January. Alex does contracts, agentic systems and security: second place
at ETHDenver this year with an autonomous DeFi agent, and five years hardening classified systems at
Raytheon before that. Jean-Baptiste runs frontend, seven years in DeFi, he led the frontend on Vesu
and on Pangolin at four hundred million in TVL.

**[SLIDE 4 · what we built] (1:00–1:40)**

Here is what we built, live on Arc testnet today.

One flow. A human proves they are a real, unique person with World ID and becomes the controller of
record. We form a Wyoming LLC for the agent through doola's API. The agent gets its own treasury
contract on Arc that enforces the operating agreement: spending caps, approved counterparties, and
the human's power to pause or claw back. Then the agent works, earning and paying in USDC.

Fifteen agent entities are live, every one backed by a verified human, and none of them hold gas.
Every entity is listed publicly, every contract source-verified on Arcscan. You don't have to take
my word for any of it.

**[SLIDE 5 · Circle stack] (1:40–2:10)**

We didn't port this to Arc, we built it on Arc.

USDC is the unit of account for every treasury, every job, every fee. Circle Wallets are the default
custody for every agent. Gas Station sponsors every transaction, which is why an agent never holds
gas. x402 on both the buying and selling side, CCTP for treasury funding, Gateway behind our
spending balances.

**[SLIDE 6 · road to production] (2:10–2:55)**

Which brings us to the next three months. We are not rushing to launch at mainnet. A legal product
that ships fast and wrong is worse than none, because the first operating agreement becomes the
template every agent company inherits.

So: a US corporate lawyer and our own C-Corp, because a company whose product is legal
accountability has to be impeccable about its own. An independent audit of the contracts before any
agent holds real customer money. A minimal, focused version of Novi Corpus with Nanopayments, which
we are designing right now. And pitching AI and crypto VCs for the funding that pays for all of it.

Nine weeks to turn a working testnet product into a business that can hold real customer money.
And what we want most from this programme is the people: building alongside teams at Circle and Arc
who have done this before, an introduction to US corporate counsel, and design partners running real
agents.

Every agent company we create is a new USDC treasury on Arc. Accountability first, then commerce.
Thank you.

---

## Timing notes
- Protect slides 4 and 6. If you're long, trim the team slide to one sentence each,
  or drop the CCTP/Gateway clause on slide 5.
- The natural overrun point is slide 6. Keep the four steps to one clause each; don't read the cards.
- Rehearse twice with a timer. Don't read the slides: they carry keywords, you carry the argument.
