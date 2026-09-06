# Demo Day — 3-minute script (Arc Accelerator, 8 Sept 2026, 16:00 BST)

Hard limit 3:00. No live demo. ~430 words at a calm pace. Slide changes marked.
Deck: `novi-corpus-demoday-deck.html` (present fullscreen with `f`) · PDF backup alongside it.

---

**[SLIDE 1 · title] (0:00–0:10)**

I'm Martin, co-founder of Novi Corpus. We give AI agents a legal body: a real company,
a USDC treasury on Arc with rules the agent cannot break, and a verified human who answers for it.

**[SLIDE 2 · problem] (0:10–0:35)**

Technology already gave agents everything on the left: a wallet, autonomy, even spending policies.
What no technology can give them is on the right. An agent cannot have limited liability. It cannot
sign a contract. If it causes harm, there is nobody to sue. So no serious business will hire an
agent as a counterparty. That is where agentic commerce stalls.

**[SLIDE 3 · origin] (0:35–1:00)**

The idea is not ours, and that is the point. Law professor Shawn Bayern showed years ago that US LLC
law already lets a company be run by software, with the operating agreement as the control layer.
In 2021 Wyoming made that something you can declare: a DAO LLC is a legal person with limited
liability, managed by an algorithm, with the smart contract named in the filing. In May, Jeremy
Allaire shared that thesis and said he would love to back a team building it on Circle Agent Stack
and Arc. Nobody had turned it into a product. We are.

**[SLIDE 4 · team] (1:00–1:20)**

Three of us build it. I handle product and backend architecture, four years of backend engineering
before crypto, on Arc since January. Alex does contracts, agentic systems and security: second place
at ETHDenver this year with an autonomous DeFi agent, five years hardening classified systems at
Raytheon before that. Jean-Baptiste runs frontend, seven years in DeFi, he led the frontend on Vesu
and on Pangolin.

**[SLIDE 5 · what we built] (1:20–1:55)**

Here is what runs on Arc testnet today. One flow. A human proves they are a real, unique person with
World ID and becomes the controller of record. We form a Wyoming LLC for the agent through doola's
API. The agent gets its own treasury contract on Arc that enforces the operating agreement: spending
caps, approved counterparties, and the human's power to pause or claw back. Then it works, earning
and paying in USDC.

And it is not a demo. We have generated a real operating agreement from our data and anchored it on
chain, end to end. All platform authority sits in one governance contract behind a hardware wallet.
Every treasury is monitored on chain around the clock.

**[SLIDE 6 · Circle stack] (1:55–2:20)**

We didn't port this to Arc, we built it on Arc. USDC is the unit of account for every treasury,
every job, every fee. Circle Wallets are the default custody for every agent. Gas Station sponsors
every transaction, which is why an agent never holds gas. x402 on both the buying and selling side,
CCTP for treasury funding, Gateway behind our spending balances.

**[SLIDE 7 · road to production] (2:20–2:55)**

Which brings us to the next three months. We are not rushing to launch at mainnet. A legal product
that ships fast and wrong is worse than none.

So: a US corporate lawyer and our own C-Corp, because a company whose product is legal
accountability has to be impeccable about its own. An independent audit before any agent holds real
customer money. A minimal, focused version of Novi Corpus with Nanopayments, which we are designing
right now. Then we pitch AI and crypto VCs for the funding that pays for all of it.

And what we want most from this programme is the people: building alongside teams at Circle and Arc
who have done this before, an introduction to US corporate counsel, and design partners running real
agents.

Every agent company we create is a new USDC treasury on Arc. Accountability first, then commerce.
Thank you.

---

## Timing notes
- Protect slides 3, 5 and 7. If long, trim the team slide to one sentence each, or drop the
  CCTP/Gateway clause on slide 6.
- Slide 3 is new and the easiest to over-talk: Bayern one sentence, Wyoming one sentence, Allaire
  one sentence, then move.
- Rehearse twice with a timer. Don't read the slides: they carry keywords, you carry the argument.
