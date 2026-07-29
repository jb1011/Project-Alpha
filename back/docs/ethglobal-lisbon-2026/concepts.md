# The Trust Stack, Explained — Concepts Behind the Three Integrations

This is the non-technical companion to [technical-blueprints.md](./technical-blueprints.md).
It explains what each tool *is*, what problem it solves for Novi Corpus, and how the pieces
fit — the version you use for the pitch, for onboarding a teammate, or for talking to judges.

---

## 1. The Graph — giving our protocol eyes

### The problem

Everything our treasury does happens on the blockchain — spends, pauses, policy changes,
clawbacks. But a blockchain is like a giant paper ledger with no index: to answer a simple
question like "how much did agent X spend this week?" you'd have to flip through millions of
pages (blocks) one by one. Our own security audit flagged "no observability" as our #1 gap —
the guardian currently has no live view of what their agent is doing.

### What The Graph is

A service that reads the blockchain *as it happens* and organizes events into a proper,
searchable database. The thing you build is called a **subgraph** — a recipe file that says:
"watch these contracts, and every time event Y happens, file it away under this category."
Once deployed, anyone can query it instantly ("list all spends over 1 USDC this month",
"show me every time a guardian hit pause") using GraphQL — think SQL for blockchain data.

**The lucky break:** The Graph officially supports Arc Testnet — our chain. It is the only
Lisbon sponsor whose tools reach us directly: no bridges, no second chain, no migration.

### What we build — three layers

1. **The subgraph.** One recipe watching our factory contract. Subtlety: our factory
   *creates* a new treasury contract for every agent, and we can't list addresses that don't
   exist yet. The Graph's **templates** feature solves exactly this: "whenever the factory
   announces a new treasury, automatically start watching that address too." Every future
   agent gets indexed with zero extra work.

2. **A guardian alert watcher.** A small background service that polls the subgraph every few
   seconds — "anything new?" — and pushes alerts to the dashboard: a pause, an emergency
   withdrawal, a spending spike. This is the audit gap actually being fixed, live.

3. **Governed pay-per-query** (the differentiator). The Graph recently made their data
   payable via **x402** — the same "HTTP 402 Payment Required" protocol our agents already
   use. An agent hits their gateway, is told "that'll be 1 cent of USDC," signs a payment,
   gets the data. The catch that becomes our pitch: The Graph's official payment client is a
   black box — you hand it a private key and it pays *whatever* it's asked. No limits, no
   checks. That is exactly the "rogue agent" problem our protocol exists to solve. So we
   route the payment through **our own policy engine** instead: before signing anything, we
   check — is this entity legally active? is it paused? within its cap? A misbehaving agent
   literally cannot buy data. Packaged as a reusable tool (MCP + SKILL) other developers can
   drop into their agents — precisely what The Graph's biggest prize rewards.

### The honest limitation (own it, don't hide it)

A subgraph can only see what contracts *announce* (events). Money flowing **into** a treasury
and the tiny x402 micropayments don't emit announcements — so we frame the subgraph as the
**governance view**, not a complete bank statement. That's a defensible design statement.

---

## 2. World — proving there's a real human behind the agent

### The problem

Our legal model *requires* a real human controller — Wyoming law and US financial regulations
(FinCEN CDD) demand it. Today, our "proof" of that human is a passkey. But a passkey only
proves someone holds a device — not that they're a real, **unique** person. One person could
create a thousand guardian identities. World closes exactly that hole.

### The tools

- **World ID** — proof-of-personhood. A person looks into an Orb (an iris-scanning device;
  Lisbon has several, usually one at the venue), which confirms they're a real, living,
  unique human — without storing who they are. Afterwards they can prove "I am a unique
  human" to any app from their phone, cryptographically.

- **The nullifier** — the concept worth truly understanding. When someone proves their
  humanity to our app, we don't learn their name, iris, or anything identifying. We receive
  one number — the nullifier — with a magical property: *the same human proving themselves to
  the same app always produces the same number, but a different app sees a completely
  different number.* We can't identify or track anyone — but if someone tries to register a
  second guardian identity with us, the same number reappears and we catch it. Anonymity and
  uniqueness at the same time. That's how we enforce "one human backs at most N legal
  entities" without surveillance.

- **AgentKit / AgentBook** — World's newest product, built for exactly our world: a public
  on-chain registry where a verified human links their identity to their agent's wallet
  address. Anyone can then look up a wallet and ask: "is this agent backed by a real, unique
  human?" Registration is a QR scan in the World App and costs nothing.

### What we build — three pieces

1. **The guardian gate.** At entity formation, one new step: scan a QR, prove you're a unique
   human via World ID. Our backend verifies the proof, stores the nullifier, enforces the
   entities-per-human cap — and writes the attestation into the agent's public legal
   metadata. Pitch line: *the legally-required human controller is now cryptographically
   proven, not just claimed.* (Fully developable and demoable with World's simulator — no
   Orb needed for this part.)

2. **The agent side.** Our agent's payment tool learns one trick: when a seller asks "prove
   you're human-backed," it signs a small message with its wallet key. One signature; our
   existing key setup handles it.

3. **The seller side.** Our x402 demo shop learns to check that signature: it looks the
   wallet up in AgentBook (a free, read-only lookup) and, if the agent is human-backed,
   grants a few free trial requests before requiring payment. Crucially — our make-or-break
   research question — **the verification layer is completely separate from the money
   layer.** World's own docs confirm it: the check happens against their registry, but the
   actual payment can settle on any chain. Our Circle/Arc payment flow stays untouched. They
   even list Arc as a supported chain inside their SDK.

### The framing discipline (prize rules)

World's prize explicitly **disqualifies** "verified agents get discounts" and
reputation-based pitches. Our story must stay: **authorization and accountability** — a
seller can demand that a paying agent is backed by a unique verified human *and* a real
legal entity with a governed treasury. World provides the personhood; we provide the
liability layer they don't have. (Nice detail: AgentBook has no "unregister" function — but
our guardian can pause and claw back the treasury. We complete their story.)

### The one real-world dependency

Registering an agent in AgentBook requires a genuinely Orb-verified human, once — a 2-minute
gasless QR scan. Do it before the weekend. Everything else works on simulators and testnets.

---

## 3. ENS — giving every agent a name anyone can verify

### The problem

Verifying one of our agents today means handling raw data — a 42-character wallet address, a
metadata URL on our domain. There's no *name*. ENS (Ethereum Name Service) is the naming
system of the Ethereum world — like DNS turning `google.com` into a server address, ENS turns
`something.eth` into wallet addresses *plus arbitrary public information* (text records).
Wallets, explorers, and libraries across the ecosystem already know how to read it.

### What we build

Every agent that onboards automatically gets a name — `<its-id>.novicorpus.eth` — that anyone
in the world can look up to see: its treasury address, its live legal status, its metadata,
and a cryptographic link to its on-chain identity.

### The two concepts that make it nearly free to operate

1. **The wildcard resolver.** Normally each ENS subname needs its own blockchain transaction
   — costly and slow for hundreds of agents. ENS has a standard where the parent name
   (`novicorpus.eth`) installs one small "resolver" contract that declares: *"I answer for
   ALL subnames under me."* One contract, infinite agent names, zero per-agent transactions.
   An agent gets its name simply by existing in our database.

2. **CCIP-Read — the "ask my server" trick.** Our agents' data lives in our database and on
   Arc — not on Ethereum, where ENS lives. CCIP-Read is the official ENS mechanism for that:
   when someone looks up an agent's name, our resolver contract replies "fetch the answer
   from this URL" — pointing at a new endpoint on our *existing backend*. Our server answers
   live from the database and **cryptographically signs** the response; the client verifies
   that signature against the contract before trusting it. Consequences: the data is always
   fresh (guardian pauses an agent → the name's `legal-status` record flips to `Suspended` on
   the next lookup — great stage demo), we can't be impersonated, and the judges' "no
   hard-coded values" rule is satisfied by construction.

### The verification loop — ENSIP-25

ENS recently published a standard, designed *exactly* for identity registries like our
ERC-8004 setup, that binds a name to an agent registration **in both directions**: the ENS
name carries a record saying "I am agent #845775 in this registry on Arc," and the registry
entry on Arc points back at the ENS name. Why both directions matter: with only one, an
impostor could claim a name or an ID that isn't theirs; with both, a counterparty checks the
loop closes — neither side can be faked alone. Our research found the live registry on Arc
already has the function we need to write our half of the loop (pending a 10-minute check).

### Why judges will like it

The whole thing is a five-step public verification any stranger can run:

1. Resolve the name → the governed **treasury address** (a human-readable name became an
   on-chain-verifiable payment identity).
2. Read `legal-status` → `Active`, live from Arc. Pause on stage → re-resolve → `Suspended`.
3. Read the ENSIP-25 record → the name attests its ERC-8004 registration.
4. Flip direction on Arc → the registry points back at the same name. Loop closed.
5. Read `agent-endpoint[mcp]` → connect to the agent and transact.

Discovery, verification, and payment — from one name. We build on Sepolia (free, fully
supported by ENS tooling); ~$10 optionally claims the name on mainnet so it resolves in
consumer apps like Rainbow at the booth.

---

## How the three become one story

Imagine a stranger deciding whether to do business with one of our agents:

1. **ENS answers "who are you?"** — resolve the name; get the treasury, the live legal
   status, and the verified link to its on-chain identity.
2. **World answers "who's responsible for you?"** — a registry lookup proves a real, unique
   human backs this agent, and our legal layer makes that human the accountable controller
   of a Wyoming LLC.
3. **The Graph answers "how do you behave?"** — a live, queryable history of every spend,
   pause, and policy change; and the agent's own data purchases pass through the same
   spending policy as everything else.

**Identity, accountability, behavior** — the three questions you'd ask about any
counterparty, answered for an AI agent. That is the trust stack. Each layer sits dead-center
in one sponsor's prize track, and none of them touches the Arc treasury core.
