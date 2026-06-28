# x401 (Proof × Circle) — what it is, and how Project-Alpha is positioned

> Written 2026-06-28. Source: Proof's launch announcement (https://www.proof.com/blog/identity-infrastructure-agentic-internet-x401)
> + press coverage. Companion to `POSITIONING.md`. Bottom line: **x401 is adjacent and
> complementary to what we build — validation + an integration opportunity, not a competitor.**

## What x401 is

An **open identity / authorization protocol** for AI agents, authored by **Proof.com**, **co-contributed
by Circle** (also backed by OpenAI, Google, Okta; heading to the FIDO Alliance). The name is deliberate:
HTTP **401 = Unauthorized**, the sibling of **402 = Payment Required**. Circle's framing:

> *"x402 answers how an agent pays, x401 answers who it is."*

- **Mechanism:** W3C **Verifiable Credentials** over **OID4VC**, with **selective disclosure + zero-knowledge
  proofs**. An agent presents a credential proving its principal's verified identity, age,
  **organizational affiliation**, **signing authority**, or "proof of humanness"; the service verifies
  issuer/claim/scope before proceeding.
- **Proof's role:** wrote the spec + shipped the first live implementation (a "Digital ID" product), NIST
  **IAL2** identity proofing (strong KYC) + biometric reauth, WebTrust-audited CA, transaction signing →
  verifiable records.
- **It is off-chain.** NO wallets, NO on-chain components, NO LLC / legal-entity formation, NO spending
  caps/governance, no ERC-8004, no Turnkey. It answers *"is there a verified human/org behind this agent?"*
  at request time.

## The emerging agentic stack — and where we sit

| Layer | Question | Who |
|---|---|---|
| Payment | *How does it pay?* | **x402** (Circle) — we build on it |
| Identity / authz | *Who/what authorized it?* | **x401** (Proof + Circle) — new |
| Intent | *What exactly was approved?* | AP2 / Verifiable Intent |
| **Legal entity + governed treasury** | ***What is the agent legally, and how is its money bounded?*** | **Project-Alpha** |

x401 is a **horizontal credential protocol + an identity-verification product**. Project-Alpha is a
**vertical product that gives the agent a legal body** — a Wyoming DAO LLC with limited liability, asset
ownership, enforceable-contract standing, EIN/banking access — plus on-chain ERC-8004/8183 identity, a
governed `AgentTreasury` (caps/guardian), Turnkey non-custodial signing, and the Payment Authority.

**x401 proves who's behind an agent; it does not give the agent legal personhood, limited liability, or a
balance sheet.** Different mechanism entirely (verifiable credentials / KYC vs. legal incorporation +
on-chain governance).

## Strategic read (for the grant + the Circle relationship)

1. **Tailwind, not threat.** Circle backing an *identity/accountability* standard right next to its
   *payment* standard validates our whole thesis — that agents need verifiable accountability and a
   responsible principal. The market is converging on the problem we solve.
2. **It plugs a hole we already have.** Our user-of-record legal gate makes a **KYC'd natural-person
   controller mandatory**. x401 is precisely a verified-identity + signing-authority credential. **Adopt
   x401 as the controller-verification step in onboarding** → lets us claim "built on Circle's *full*
   agentic stack: x402 + x401 + Gateway + USDC + Arc," and cleanly satisfies the KYC requirement we already
   carry.
3. **The one-liner.** *"x402 is how the agent pays, x401 is who's behind it — Project-Alpha is what the
   agent legally **is** and how its treasury is **governed**."* We own the layer neither protocol touches.
4. **Watch-item.** x401 includes "organizational affiliation / signing authority" credentials. If Proof or
   others extend that toward "this agent represents legal entity X," there's marginally more overlap on the
   *attestation* of entity membership — but Proof is an identity-verification/notarization company (IAL2,
   CA infra), not an LLC-formation + on-chain-treasury company. Forming the entity and binding it to a
   governed on-chain treasury is not their business. The core moat stays defensible.

## Concrete next step (post-demo)

Sketch x401 as the **controller-KYC / signing-authority layer** in the onboarding flow: the human controller
proves identity + authority over the legal body via an x401 verifiable credential before the agent is
provisioned. Makes the legal body a **consumer and showcase** of x401 (great Circle-grant story), not a
competitor.
