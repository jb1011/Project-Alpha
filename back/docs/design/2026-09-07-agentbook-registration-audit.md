# AgentBook registration design: second audit (2026-09-07)

**Subject:** `2026-08-25-agentbook-registration-design.md` (v2), audited against `main` at `4bb5660`.
**Method:** four independent auditors (architecture fit, security design review, product relevance and
hackathon fit, live re-check of World-side facts), every finding grounded in a file:line or a live
source, then the top findings re-verified by hand. The live fact-check auditor was cut off by a
session limit; its scope was covered by hand (RPC reads of the contract, npm, GitHub, the live
transparency API).
**Outcome:** the design is sound in its shape and its honesty framing. It needs one chain decision,
one dependency decision, one prerequisite deploy, and a set of code-level corrections before an
implementation plan is written. The corrections are folded into the design as v3, marked ✎✎, with
traceability in its §12.

---

## 1. Verdict in five lines

1. **Architecture:** fits. Pocket EOA on both custody paths, config gating, monitor split, error
   taxonomy, test layout all match. Six sections were stale or under-specified (persistence shape,
   reconciliation owner, existing route residues, submitter key, IDKit path, precondition wording).
2. **Security:** no critical hole. The largest real risk is not gas but shared RPC quota: the two new
   routes hit the same public World Chain endpoint the payment path depends on, and the API has no
   rate limiter. D8 was over-credited. Logging would leak proofs and pseudonyms if the existing
   `String(e)` pattern were followed.
3. **Relevance:** the flow is table stakes for the World track; the legal-body verifier is the
   submission. As designed, a registered Novi agent still cannot pass any third-party AgentKit seller,
   because our signer advertises Arc and the ecosystem advertises World Chain. One-line fix.
4. **Facts:** the contract is unchanged (groupId 1, same owner and router, 3569 bytes, re-read by RPC
   today). World's registration guide and hosted relay are Base-first while the verifier library
   sellers install still hard-codes World Chain. The design missed that on 25 August. Register on
   World Chain, parameterise, pin, and ask World.
5. **Prerequisite:** PR #98 is merged but **not deployed**. The live transparency API returns
   `humanVerified: true` for the two waiver guardians (agents 881014 and 845996). Nothing with a trust
   chip ships before that deploy is verified by curl.

---

## 2. Facts re-verified today

| Fact | Result 2026-09-07 | Source |
|---|---|---|
| AgentBook on World Chain `0xA23a…44dA`: `groupId()` | 1 (Orb group) | `cast call` via Alchemy public RPC |
| `owner()` / `pendingOwner()` | `0xE340b00B…Cb39D` / zero | same |
| `worldIdRouter()` | `0x17B354dD2595411ff79041f930e491A4Df39A278` | same |
| Runtime code | 3569 bytes, same on Base `0xE1D1…61a4` and Base Sepolia `0xA23a…44dA` | `cast code` |
| Gas price | 0.0015 gwei (unchanged) | `cast gas-price` |
| `worldcoin/agentkit` main | last commit 2026-08-24; RFC #37 open, 0 comments; #12 open; PR #38 "feat!: agentkit cli v0.2" open since 2026-09-01 (breaking: CLI-generated agent key, RFC 9421 signatures, `humanId` → `lookupId`) | `gh api` |
| Registration guide `cli/REGISTRATION.md` (main) | Supported networks `base`, `base-sepolia`; default flow = hosted relay on Base; World Chain listed only as an address | raw.githubusercontent |
| Verifier `core/src/agent-book.ts` (main) and installed `agentkit-core` | `worldchain` + `0xA23a…44dA` hard-coded | raw + `node_modules` grep |
| npm | `@worldcoin/agentkit` 0.2.1 (2026-08-31), `agentkit-core` 0.2.1, `agentkit-cli` 0.2.0; installed here 0.2.0; `idkit-core@2.1.0` **deprecated** ("Old-versions moved to new ones"), deps `ox ^0.1.0`, `zustand ^4.5`, `buffer ^6` | `npm view` |
| Live `api.novicorpus.com/transparency` | 15 entities, 13 `proof_of_human`, 2 `waiver`; all 15 `humanVerified: true` | curl |
| IDKit v4 request in this repo | `makeRpContext` signs with **our** `rpSigningKey` for **our** `rp_id` (`guardianGate.ts:50-57`) | code |
| AgentKit signer chain | `eip155:${cfg.chainId}` = Arc (`agentkitSigner.ts:27-33`, `entityPayment.ts:145,152`); our seller advertises Arc only (`worldVerifier.ts` `network`) | code |
| World App request name / Face Auth / `max_verifications: 1` | reported by the product auditor from World's precheck; not reproduced by hand (endpoint returned non-JSON to a bare POST) | auditor |

---

## 3. Findings, merged and deduplicated

Severity is the highest any auditor assigned after hand verification. IDs: A architecture, S security,
P product, F facts.

### HIGH

**H1. Chain divergence (S-5, P-9, F).** World's registration docs and relay default to Base; every
verifier in the wild reads World Chain. Registering on the wrong chain is the "permanent write to an
address nobody queries" class the design itself caught for the operator SCA.
→ D3 stands: register on World Chain, because that is what `createAgentBookVerifier` reads today.
Registrar parameterised by `(chainId, contract)` from one constant shared with `agentBookReader`. CI
test asserting the installed verifier dist still contains `worldchain` and `0xA23a…44dA`. Question to
World in the feedback doc: which chain will the verifier read next. Dual registration on Base is a
later option, not now.

**H2. IDKit path (A-1, S-8).** §4.6 option (b) "rebuild on v4" is unavailable, not merely risky: v4
`IDKit.request` needs an `rp_context` signed by the app owner's key, and the AgentBook app is
World's. Option (a) pins a deprecated package with stale deps and needs an npm alias because two
versions of one name cannot coexist. A third option, running the v2 bridge in Node as the MCP-first
guardian flow does, would make the backend the sole author of the signal, which D8 exists to avoid.
→ Decision (a): `"idkit-core-v2": "npm:@worldcoin/idkit-core@2.1.0"`, exact pin, dynamic import so it
loads only in the vouch dialog, browser only, pinned to CLI commit `434407c`. State why (b) and (c)
are out.

**H3. Shared RPC quota is the drain, not gas (S-1).** Session creation is a free `getNextNonce`
read; register is a nonce re-read plus `simulate`. Both hit `WORLD_CHAIN_RPC`, the public Alchemy
endpoint that the buyer and seller trust dials also use, and a throttled reader makes those dials
refuse. The API has no generic rate limiter (only the per-tenant job cap and a demo throttle).
→ Per-entity lifetime cap (3 registrations), per-tenant window on session creation (5 per hour),
process-wide token bucket on World Chain calls from these routes, budget consumed before the RPC
read, and a separate `WORLDCHAIN_SUBMITTER_RPC` for writes.

**H4. Registration buys nothing outside our own seller (P-1).** Our AgentKit signer advertises
`eip155:5042002`; sellers advertise `eip155:480` (live Exa 402). The SDK client skips the proof on a
chain mismatch and pays instead. EIP-191 is chain-agnostic for a key, and the chain id only selects
the RPC for ERC-1271 checks.
→ Signer chain id `eip155:480` by default; our seller advertises both 480 and Arc. Without this the
video can only show "Novi agent passes Novi's seller".

**H5. PR #98 not deployed (P-2).** Live JSON says `humanVerified: true` for waiver guardians. The
interface page looks amber because it checks `credential` first; the API lies.
→ Deploy to novi-prod and verify by curl before any AgentBook surface; write "deployed and verified"
into the plan's prerequisites.

**H6. Persistence shape does not carry the flow (A-2, S-3, S-7).** §3 needs a session row, §4.4 has
none; no `expires_at`, no `disputed` status although §4.5 writes it, no CHECK constraint (every table
has one), no `raw_tx` although the house rule is "sign and persist before broadcast", no CAS
transitions, and "receipt status 0 → failed" cannot resolve a dropped or never-broadcast tx, so a
stuck `submitted` row blocks the entity forever through the partial index. One submitter EOA with
two concurrent guardians also races the nonce.
→ v3 §4.4: statuses `pending | submitted | confirmed | disputed | failed | expired` with CHECK;
`session_id UNIQUE`, `expires_at`, `raw_tx`, `submitter_nonce`, `confirmed_block`; nullifier written
at the claim INSERT; every move a CAS; in-flight index on `submitted` only; `withKeyedLock
("worldchain-submitter")`; reconcile from `getNextNonce` first (nonce still equal after 10 min →
nothing landed), receipts as fast path, `safe` block tag for `confirmed`.

### MEDIUM

**M1. D8 over-credited (A-5, S-2).** The browser has no independent source for the pocket address;
`EntityView` does not carry it, so the "recompute locally" check compares two values from the same
backend. World App shows app name and action, never the address.
→ Restate D8 as "detects route inconsistency". Add `pocketAddress` to `EntityView` as a stored fact,
show it beside the ERC-8004 agent id with an Arcscan link ("the address that paid this agent's x402
invoices"), trust-on-first-use pin in the browser with a warning on change. The on-chain metadata
anchor is deferred; a Circle 7702 single address makes it moot.

**M2. Reconciliation owner (A-6, S-4).** Only an owner opening the dashboard promotes or disputes a
row; the query has no refetch interval; the monitor is read-only by construction and has no World
Chain client. The public transparency chip would keep saying "Vouched" after a $0.0015 overwrite.
→ In-process reconciler in `api/main.ts` (boot `reconcileInFlight` plus interval, same shape as the
formation sweeper) with GET as an extra trigger through the same CAS method. Transparency chip in
past tense with a timestamp ("Registration submitted on <date>, last checked <ts>"), suppressed when
not `confirmed` or when the last check is older than an hour. Monitor rule deferred; when built it
polls one `getLogs(AgentRegistered)` per tick on a second chain client and pages only.

**M3. Existing route residues (A-3, P-10, S-11).** The GET route is gated on the x402 demo flag,
uses the SDK verifier that returns null on outage (rendered as "not registered", which §6 forbids),
caches positives 10 minutes, and writes nothing to the cache on dispute, so seller dials keep the
stale human id for up to an hour.
→ Move the route onto `ApiDeps.agentBook` (built iff `canRegisterAgentBook(cfg)`), use
`createAgentBookReader`, response union `registered | unregistered | unknown | disputed`, bypass the
cache for reconciliation reads, `cacheLookup(pocket, foreignHumanId)` immediately on dispute.

**M4. Submitter key under-specified (A-8, S-9).** The hardening batch it was sequenced against is
spec-only. Nothing in the repo funds or reads ETH on any chain; the S5 outflow meter counts USDC only;
no nonce manager exists. Every registration tx has `from = submitter`, so anyone can enumerate every
pocket Novi ever vouched for and join them to pseudonyms. That fact is public and not in §8 or the
dialog.
→ Add the key now following the spec's pattern: `privKeySchema.optional()`, boot refuses equality
with any other key by address, key present without `cfg.world` in production refuses boot, `redact()`
entry, `.env.example`, pre-submit balance check with `opsLog("agentbook_submitter_low")`, runbook
"never fund this address on any other chain", World Chain ETH documented as outside the S5 ceiling
and bounded by the caps in H3. Dialog gains "and that Novi Corpus submitted it".

**M5. Logs would leak the proof and the pseudonym (S-6).** `String(e)` on a viem contract error
prints the call args: `agent, root, nonce, nullifierHash, proof[8]`. The existing World routes use
that pattern for both the ops log and the 4xx body. A failed attempt's nullifier is not public.
→ `opsLog` with `{entity, tenant prefix, errorName}` only; a test asserting neither the log line nor
the 4xx body contains `nullifierHash` or any `proof[i]`.

**M6. Sandbox reality (P-4).** The vouch cannot run in World's Sandbox (mainnet router, World's app,
Orb group). The track's remote test can cover only the guardian verification and the eligibility
gate. Nothing is deployed with `WORLD_ENVIRONMENT=sandbox`.
→ Plan item, not design: a sandbox-pointed backend process plus a Vercel preview with
`NEXT_PUBLIC_API_URL` at it; the feedback doc states plainly that AgentBook has no sandbox and the
live registration was done on mainnet with the founder's World ID.

**M7. D9 already violated on prod (P-6, S-4, P-12).** Dashboard chip "AgentBook · human-backed" in
green; personhood page repeats the wording; `TenantRecord` shows a waiver guardian as green
"Human-backed" with no waiver branch; two old decks claim every agent is registered.
→ Chip becomes neutral "Vouched in AgentBook ↗" / "Not in AgentBook" / "Could not check" /
"Disputed" in the same PR as the button; personhood sentence updated; `TenantRecord` waiver branch;
decks marked superseded in the plan.

**M8. World App copy and the one-proof question (P-5).** The requester shown in World App is
"AgentKit", not "AgentBook"; Face Auth may be requested; the action is configured with
`max_verifications: 1`, though second proofs per human have been observed in the wild and the CLI
never calls cloud verify. The founder's World ID already produced one AgentBook proof for the demo
key.
→ Copy fixed. The one live registration happens on day one of the build, before UI polish, because
it settles constants, copy and the many-agents-per-human question at once. `max_verifications` goes
into the feedback doc as a question.

**M9. Precondition 2 re-opens the seed read path (A-4).** `rec.pocketAddress ?? derivePocketAddress
(key)` in a read route contradicts the Tier-0 rule that read paths never touch the master seed, and
is a no-op on mainnet.
→ `rec.pocketAddress` is a stored fact; null → `unavailable` with reason `no-pocket-yet` (what PR
#102 already emits). Never derive at read time.

**M10. Legal-body verifier depends on a pocket-keyed lookup that does not exist (P-7).** AgentKit
hands the verifier the challenge signer, our pocket; our legal-body trust root is keyed by treasury.
→ Plan item for the verifier work: `findByPocket` plus index, public `GET /lookup/legal-body/:address`,
`legal-bodies-only` seller policy, 30-line verifier object. Skip the ERC-8004 payer-metadata write
for the hackathon.

### LOW and INFO

- **L1 (A-7).** Monitor rule shape when built: second `MonitorRpc` for World Chain (viem ships
  `worldchain`), read-only `agentbook_registrations` projection behind `assertLookupSchema` (API
  deploys before monitor), per-tick rules `agentbook_disputed` and `agentbook_registry_changed` with
  stable dedup keys; the monitor pages, the API reconciler flips state.
- **L2 (A-9, S-11).** `EntityView.agentBook` is a synchronous DB projection `{status, txHash,
  submittedAt} | null` through `EntityViewDeps`, so REST and MCP render the same; the chain-derived
  outcome stays on the GET route; the nullifier never reaches MCP.
- **L3 (A-10).** Names: `ApiDeps.agentBook?: AgentBookDeps`, `/config.agentBookRegistrationAvailable`,
  `PublicConfig.agentBookRegistrationAvailable?: boolean`, routes mounted only when present.
- **L4 (A-11, P-8).** Precondition 3 is `credential ∈ {"orb", "proof_of_human"}`; prod today: 13
  Orb-grade guardians, 2 waivers, no passport or MNC. One ineligibility message for every non-Orb
  guardian; the passport/MNC copy branch has zero users and is cut.
- **L5 (S-10).** Input validation: `proof` exactly 8 strings matching `/^(0x[0-9a-fA-F]{1,64}|[0-9]
  {1,78})$/`, same for `root`, `nonce`, `nullifierHash`; `nonce` must equal the session's; body limit
  8 KiB on both routes via `hono/body-limit`; `frame-ancestors 'none'` on the interface. CSRF is not
  applicable: Bearer token from `sessionStorage`, no cookies.
- **L6 (S-12).** The live registration: runbook records the World ID used, the accepted permanent
  linkage between that pseudonym, the throwaway or real agent, and the demo key; the tx hash; the
  pocket; `NODE_ENV=production`; pinned submitter RPC; the packed-signal golden vector captured from
  the run. Prefer a circle agent (pocket stored).
- **L7 (S).** Threat model edits: HIGH-4 front-running → LOW, merged into HIGH-1 (World Chain has a
  private sequencer; there is nothing to snipe, only HIGH-1 in a five-minute window). New entries:
  shared-RPC denial (H3), a lying RPC can flip `confirmed` ↔ `disputed` and make the public chip lie
  (read `lookupHuman` from a second RPC before flipping the public chip only), submitter `from`
  enumeration (M4), verifier chain migration (H1).
- **L8 (P-11).** Over-engineered for the week: router/groupId drift watch, passport/MNC copy, MCP
  plumbing, the Graph as a dependency of "disputed" (a single compare needs no history). Consent line
  "We watch for that and will tell you" becomes "Your agent's dashboard will show it" while the monitor
  rule is deferred.
- **I1 (A-12).** Stale citations: `worldId.ts:365-403` → `415-455`; `env.ts:756` → `815`;
  `onboarding.ts:489` → `479`; `app.ts:172-187` → `172-192`. A1 (#108) changed nothing the design
  depends on: ownership idiom, status set and route family are intact.
- **I2 (P-9).** Relay facts: it is the AgentKit app's registered `integration_url`, hosted from
  `andy-t-wang/x402-worldchain`, sponsor cap 0.0002 ETH, returns 409 `ALREADY_REGISTERED` on any
  existing binding (contradicting the contract's upsert; RFC #37 phase 0). Unusable for a re-vouch,
  which is one more reason for D3.

---

## 4. Checked and sound (kept from v2 without change)

Pocket EOA signs AgentKit challenges on both custody paths (Circle MPC signer exists). `lookupHuman`
reader that throws on transport. Packed 52-byte signal and `register` argument order match World's
CLI. Proof cannot be retargeted; a replayed register body reverts `InvalidNonce()`; the contract
supplies `EXTERNAL_NULLIFIER_HASH`, so `simulate` fully guards wrong constants. Partial unique index
semantics verified on the bundled SQLite. Authn/authz idiom (Bearer JWT, uniform 404 on foreign
entity). Orb gate implementable from stored credential identifiers. Metadata privacy split: our
guardian nullifier hash and the AgentBook pseudonym are different pseudonyms, no new cross-app link.
Consent copy factual claims all check out against contract and CLI source. Per-agent placement is
right after A1: companies have no address and no page. Config gating, error codes, `opsLog`, test
layout, biome conventions as described. No code assumes pocket ≠ operator, so Circle's 7702 holds.

---

## 5. Recommended scope for 13 September

**Minimal honest scope.** Deploy PR #98 and verify by curl. Registrar (nonce, packed signal with the
golden vector, simulate, submit under the keyed lock, own key with boot invariants and redaction).
Two routes plus the moved GET with reconcile-on-read producing `submitted → confirmed | failed |
disputed`. Frontend dialog (trimmed), QR and deeplink through the pinned v2 bridge, local signal
recompute, states `unavailable / not-registered / awaiting / submitting / vouched / disputed / failed /
unknown`, chip renamed and neutralised in the same PR. One ineligibility message. Rate caps from H3
at their simplest (per-entity lifetime 3, per-tenant 5 sessions per hour). Signer chain id 480 and
seller advertising 480. The one live registration, done first. Then the legal-body verifier work
(`findByPocket`, public lookup, `legal-bodies-only`, verifier object and one doc page), the
sandbox-pointed deployment, and the feedback doc.

**If time remains.** "You have already vouched for N agents" line. `agentBook` on `EntityView` for
MCP. Transparency chip in past tense. `TenantRecord` waiver branch. In-process reconciler interval.

**Defer.** Monitor rules and router/groupId watch. Attempt budgets beyond the simple caps.
Passport/MNC copy. Onboarding integration, bulk, MCP-initiated registration. ERC-8004 payer metadata.
Dual registration on Base.

---

## 6. Decisions for the founder

1. **Chain.** Register on World Chain now, parameterised and pinned, and ask World which chain the
   verifier will read. Recommended. Alternative: wait for World's answer, which risks the deadline.
2. **Which agent and which World ID** for the live registration, with the permanent linkage accepted.
   Recommended: a circle agent on prod, the founder's World ID.
3. **Testnet registration.** Prod runs Arc testnet until the 16th; a real pseudonym vouching for a
   testnet agent's pocket is permanent. Recommended: allow, and say "this agent runs on Arc testnet"
   in the dialog. Alternative: gate on `ARC_NETWORK=mainnet` and register after the 16th.
4. **Who deploys PR #98** to novi-prod, since deploys are in colleagues' hands.
5. **Sandbox deployment** for the judge's remote test: a second backend process plus a Vercel preview
   (about half a day), or a recorded local sandbox session.

---

## 7. Traceability

| Finding | Design v3 section |
|---|---|
| H1 | §1.3 ✎✎, D3 ✎✎, §4.1, §7, §8 |
| H2 | §4.6 ✎✎, D14 |
| H3 | §4.2, §4.7, D13, §8 |
| H4 | D10, §9 |
| H5 | §5.4 ✎✎ |
| H6 | §3, §4.1, §4.4 ✎✎, §4.5, §6 |
| M1 | D8 ✎✎, §4.5, §5.1, §8 HIGH-3 |
| M2 | §4.5, §5.4, §6 ✎✎, D12 |
| M3 | §1.1 ✎✎, §4.5 |
| M4 | §4.2 ✎✎, §5.1, §8 MEDIUM-2, D11 |
| M5 | §4.7, §7 |
| M6 | plan doc (`pitch/ethonline-2026-plan.md`) |
| M7 | §5.4 ✎✎, §9 |
| M8 | §1.3, §5.1 ✎✎, §7 |
| M9 | §3 precondition 2 ✎✎ |
| M10 | §9 |
| L1 to L8, I1, I2 | §4.3, §4.5, §5.2, §5.3, §6, §7, §8, §11 |
