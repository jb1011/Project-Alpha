# AgentBook registration — letting a Novi agent trade with sellers that require human backing

**Status:** v3, after a second four-lens audit (architecture fit, security, product relevance,
live facts) on 2026-09-07, code-grounded on `main` at `4bb5660`. Corrections from that audit are
marked ✎✎ and recorded in §11, with traceability to the audit report
(`2026-09-07-agentbook-registration-audit.md`) in §12. v2 followed a four-lens adversarial audit
(security, fact-check, consent/honesty, architecture) on 2026-08-25; v1 was written the same day and
was wrong about several load-bearing facts; those corrections are recorded in §10 and marked ✎.

---

## 0. TL;DR

Our agents can already *check* whether a counterparty is human-backed (AgentBook reader, buyer and
seller trust dials, live). Nobody can check *us*: no Novi agent is registered, so a seller that
gates on AgentBook rejects or downgrades our agents. This design closes that.

**What changed after the audit, and it changes the point of the feature.** AgentBook's `register`
is permissionless and unconditional: any Orb-verified human may (re)register any address, and the
contract has no deletion. This is deliberate on World's part, not an oversight — see §1.2 — but the
consequence for us is real. A registration does **not** prove that *our* guardian backs an agent.
It proves that *some* World ID human vouches for that address right now, and that claim can be
reassigned by anyone for about $0.0015. A seller's check still passes after a reassignment (a unique
human is still there); what is lost is any claim about *which* human, and that is the claim we
wanted.

Therefore this is an **interoperability feature, not a trust feature**: it lets our agents transact
with sellers who demand an AgentBook entry. Our own `verified-legal-bodies-only` tier remains the
load-bearing proof that a specific human and a specific legal entity stand behind an agent.

The shape:

- A **dashboard action per agent** ("Vouch for this agent in AgentBook"), never automatic, never bulk.
- Available only to guardians holding an **Orb-grade** World ID: the registry pins `groupId = 1`,
  so passport, MNC and document credentials cannot produce a valid proof, and neither can a waiver.
- The **frontend** builds and verifies the signal; the guardian approves in World App; **we** submit
  on World Chain and pay the gas.
- We register the agent's **pocket EOA**, the address that signs AgentKit challenges.

**✎✎ v3 (2026-09-07).** Five things changed after the second audit, none of them the shape:

1. We register on **World Chain**, which is what every verifier reads today, even though World's
   registration guide and hosted relay have moved to Base. The registrar is parameterised by chain and
   contract and the verifier chain is pinned by a test (§1.3, D3).
2. The interface pins `@worldcoin/idkit-core@2.1.0` under an npm alias. The v4 request path is not
   available for World's own app (§4.6, D14).
3. The AgentKit signer advertises `eip155:480`; without that a registered agent still cannot pass any
   third-party seller (D10).
4. Persistence carries the session, the signed transaction and compare-and-swap moves, and
   reconciliation has an owner that is not a browser (§4.4, §4.5, D12).
5. PR #98 is merged but was **not deployed** on 2026-09-07. Nothing here ships before that is verified
   live (§5.4).


---

## 1. Verified facts

Everything in this section was checked against source or live chain on 2026-08-25, twice, by
independent auditors. Figures corrected from v1 are marked ✎.

### 1.1 Our code

| Fact | Where |
|---|---|
| Pocket EOA signs AgentKit challenges on both custody paths; circle agents sign through Circle's MPC `signMessage`; no agent is registered today, only the `/x402-demo/proof-run` key | `src/adapters/worldid/agentkitSigner.ts:12-15`; `src/adapters/circle/circleWallets.ts:272-288`; wiring `src/payments/entityPayment.ts:131-152,325` |
| ✎✎ The signer advertises **Arc** (`eip155:${cfg.chainId}`) and our seller's 402 advertises Arc only; live third-party sellers (Exa) advertise `eip155:480`, and the SDK client skips the proof on a chain mismatch and pays instead | `agentkitSigner.ts:27-33`; `entityPayment.ts:145,152`; `src/payments/worldVerifier.ts` (`network`); `worldcoin/agentkit x402/src/client.ts:113` |
| `lookupHuman` reader, deliberately not the SDK, so "could not tell" ≠ "not registered" | `src/payments/agentBookReader.ts` |
| Buyer and seller dials consume it; **any non-null humanId counts as verified**; positive cache 1 h, negative 1 min | `src/payments/sellerTrust.ts:39,62,70`, `src/payments/entityPayment.ts` |
| Pocket EOA exists on both custody paths (turnkey derives from `POCKET_MASTER_SEED`; circle creates an EOA beside the SCA, sequentially, so no orphan pocket) | `src/adapters/x402/pocketDerivation.ts:9`, `src/adapters/circle/circleWallets.ts:197-227` |
| ✎✎ `pocketAddress` is a **stored fact**: written at provisioning for circle rows, backfilled for legacy rows by Tier-0 so that read paths never touch the seed; the seed is absent on mainnet by construction | `src/types.ts:77-78`, `src/workflow/onboarding.ts:282,297,479`, `src/persistence/tier0.ts:9-12` |
| ✎✎ `GET /entities/:id/agentbook`: the operator-address bug and the CLI hint were **fixed by PR #102** (`28085cc`, 2026-08-26). Residues: the route exists only when the x402 demo is enabled (`deps.x402Demo?.agentkit`), it uses the SDK verifier that turns an outage into "not registered", and it caches positives for 10 min | `src/api/routes/worldId.ts:415-455`; `test/api/agentBookRoute.test.ts` |
| ✎✎ `EntityView` carries `operator` and `guardian` but **no `pocketAddress`**; the only browser-visible pocket comes from the agentbook route itself | `src/api/views.ts:144-236` |
| ✎✎ Dashboard chip reads "AgentBook · human-backed" in green; the personhood page repeats the wording; `TenantRecord` shows a waiver guardian as green "Human-backed" | `interface/src/components/agents/AgentDashboard.tsx:191-221`; `interface/src/app/personhood/page.tsx:64-71`; `interface/src/components/agents/TenantRecord.tsx:31,56` |
| Config gating pattern (`formationAvailable`, `turnkeyCustodyAvailable`, optional for deploy-order safety) is real; the predicates `canProvisionTurnkey` / `canFormEntities` are the precedent | `src/api/app.ts:172-192`, `src/config/env.ts:443,451`, `interface/src/lib/api/types.ts:153-175` |
| ✎✎ No rate limiter and no body limit exist in the API beyond the per-tenant job cap, a demo throttle and the doola webhook cap | `src/api/routes/jobs.ts:31`, `routes/x402Demo.ts:102-104`, `routes/doolaWebhook.ts:189,230` |
| ✎✎ IDKit v4 requests are signed with **our** relying-party key for **our** `rp_id` | `src/adapters/worldid/guardianGate.ts:50-57` |
| ✎✎ The existing World routes log and return `String(e)`, which for a viem contract error prints the call arguments | `src/api/routes/worldId.ts:212,252,390` |
| ✎✎ Helpers that already exist and are reused here: `withKeyedLock` (`src/payments/keyedMutex.ts`); in-process periodic drivers (`formationSweeper.start()`, `reconcileInFlight()` at `src/api/main.ts:440,496,636`); the `ContractRevertError` taxonomy (`src/adapters/arc/relay.ts:88-123`); `simulateContract → writeContract → waitForTransactionReceipt` (`src/adapters/arc/arcAdapter.ts:161-168,519-529`) | |

✎✎ v2 called the existing route "a live bug, not just a collision". PR #102 resolved it. What remains
of §4.5's route work is the session and register endpoints, the reader swap, the `unknown` outcome
and reconciliation.

**Registration never touches an agent private key.** It needs the pocket *address* only. The
guardian's World App produces the proof; our submitter key signs the transaction.

### 1.2 The contract (World Chain, `0xA23aB2712eA7BBa896930544C7d6636a96b944dA`)

Source: `worldcoin/agentkit`, `contracts/src/AgentBook.sol`, matching the deployed dispatcher.

```solidity
function register(address agent, uint256 root, uint256 nonce, uint256 nullifierHash, uint256[8] calldata proof) external {
    if (nonce != getNextNonce[agent]) revert InvalidNonce();
    getNextNonce[agent] = nonce + 1;
    lookupHuman[agent] = nullifierHash;          // unconditional: no emptiness check, no same-human check
    worldIdRouter.verifyProof(root, groupId, abi.encodePacked(agent, nonce).hashToField(), nullifierHash, EXTERNAL_NULLIFIER_HASH, proof);
    emit AgentRegistered(agent, nullifierHash);
}
```

- **Permissionless.** No access control. The only gate is a valid group-1 World ID proof over
  `(agent, nonce)`. Nothing proves the prover controls `agent` — vouching is accepting
  responsibility, not asserting ownership.
- **Overwrite is intended, documented and tested.** `testCanReRegisterAgent` re-registers the same
  agent "with a different nullifier" and asserts the new value wins; `testMultipleAgentsSameHuman`
  asserts one human may back many agents. The interface natspec calls the nonce "a nonce included in
  the signal to ensure proof freshness" — a one-shot registration would need no nonce sequence at
  all, so its presence is itself evidence that repeat registration is a feature.
- **Why last-write-wins is defensible.** Since nothing proves control of an address and nothing can
  be deleted, a sticky first registration would let anyone permanently squat any address, including
  addresses that do not exist yet, with no remedy for the rightful party ever. Overwrite is the only
  reclaim path and the only handover path, and every registration emits an indexed
  `AgentRegistered(agent, humanId)` so the sequence is publicly auditable. **Do not propose
  "first registration is sticky" to World: it trades a griefing edge for a permanent squatting
  attack.**
- **No deletion.** ✎ 12 external functions, all identified: `register`, `lookupHuman`,
  `getNextNonce`, `owner`, `pendingOwner`, `transferOwnership`, `acceptOwnership`,
  `renounceOwnership` (always reverts), `worldIdRouter`, `groupId`, `setWorldIdRouter`, `setGroupId`.
- ✎ **`groupId() = 1` — the Orb group.** Only Orb-grade credentials can produce a valid proof.
- ✎ **Owner is a bare EOA** (`0xE340b00B6B622C136fFA5CFf130eC8edCdDCb39D`, no code, no timelock,
  ownership can never be renounced) and can call `setWorldIdRouter` and `setGroupId` at will.
- `EXTERNAL_NULLIFIER_HASH` is immutable with **no getter**, so our app-id/action constants cannot
  be verified on-chain before a live attempt (§7).
- ✎ Runtime bytecode is **3569 bytes** (v1 reported the hex-string length as bytes).
- A second deployment exists on Base (`0xE1D1D3526A6FAa37eb36bD10B933C1b77f4561a4`, same owner).
  The SDK's verifier *always* resolves World Chain, so Base is invisible to verifiers.

✎✎ **Re-verified by RPC on 2026-09-07:** `groupId() = 1`, `owner() =
0xE340b00B6B622C136fFA5CFf130eC8edCdDCb39D`, `pendingOwner() = 0`, `worldIdRouter() =
0x17B354dD2595411ff79041f930e491A4Df39A278`, runtime code 3569 bytes. The Base deployment
`0xE1D1…61a4` and a Base Sepolia deployment at the same `0xA23a…44dA` address carry the same code
size. `worldcoin/agentkit` main has had no commit since 2026-08-24; RFC #37 (re-registration,
revocation, wallet rotation) is open with no comments; PR #38 "feat!: agentkit cli v0.2"
(CLI-generated agent key, RFC 9421 request signatures, `humanId` renamed `lookupId`) is open since
2026-09-01. Build against the published 0.2.x; note PR #38 in the feedback document as the question
"identity key versus wallet" for platform-managed agents.


### 1.3 World's client

```
APP_ID   = 'app_a7c3e2b6b83927251a0db5345bd7146a'
ACTION   = 'agentbook-registration'
NETWORK  = 'eip155:480'                             // published CLI 0.2.0 and agentkit-core 0.2.1
signal   = abi.encodePacked(address, uint256)       // 52 bytes, PACKED, then hashToField = keccak >> 8
relay    = POST https://x402-worldchain.vercel.app/register
poll cap = 300_000 ms
```

✎✎ **Chain divergence (found 2026-09-07; the guide predates v2 and was missed).** World's
registration guide on main (`cli/REGISTRATION.md`) lists the supported networks as `base` and
`base-sepolia`, defaults to Base through the hosted relay, and lists World Chain only as an address.
The published CLI, `agentkit-core` 0.2.1 and therefore every seller's verifier still hard-code World
Chain and `0xA23a…44dA`, and the live Exa 402 advertises `eip155:480`. Registrations are per chain: a
Base entry is invisible to a World Chain verifier and vice versa. **D3 ✎✎:** register on World Chain,
because that is what verifiers read; parameterise the registrar by `(chainId, contract)` from the
one constant `agentBookReader` uses; add a test that fails when the installed `agentkit-core` dist
stops containing `worldchain` and `0xA23a…44dA`; ask World in the feedback document which chain the
verifier will read next. Dual registration on Base is a later option, not now.

✎✎ **The relay.** It is the AgentKit app's registered `integration_url`, hosted from
`andy-t-wang/x402-worldchain`, with a sponsor cap of 0.0002 ETH, and it answers
`409 ALREADY_REGISTERED` for any address that already has a binding, which contradicts the
contract's upsert and makes it unusable for a re-vouch. D3 stands for that reason too.

✎✎ **What World App shows.** The precheck for this app returns the name **"AgentKit"**, cloud
engine, Face Auth enabled, and `max_verifications: 1` for the action (reported by the product
auditor, not reproduced by hand). Second proofs per human have been observed in the wild (issue #23,
the contract test `testMultipleAgentsSameHuman`, Exa's "100 free requests per month across all agents
they back"), and the CLI never calls cloud verify, so enforcement is unproven. The founder's World ID
has already produced one AgentBook proof for the `/proof` demo key. The copy names "AgentKit" and
mentions Face Auth (§5.1); the one live registration is done first (§7) because it settles this.

✎ **Version trap** (unchanged). World's CLI pins `@worldcoin/idkit-core@2.1.0` for
`createWorldBridgeStore` and `solidityEncode`. This repo ships idkit **v4.2.x**, which exports
neither (v4 uses `IDKit.request()` with a backend-signed `rp_context`, and its `hashing` subpath
exports only `hashSignal`). §4.6 records the decision.

### 1.4 Cost

World Chain is an OP Stack L2; gas is **ETH**, not WLD. Live gas price 0.0015 gwei; a Groth16
verification plus two storage writes lands near 300–400k gas, so roughly **$0.0015 per
registration**. Cheap for us — and equally cheap for an attacker (§8).

✎✎ Re-read 2026-09-07: 0.0015 gwei, unchanged.


---

## 2. Decision record

| # | Decision | Why |
|---|---|---|
| D1 | Register the **pocket EOA** | It signs AgentKit challenges and is what a seller looks up. It survives an EIP-7702 upgrade, which preserves the address; a move to a classic SCA would strand the binding at an address nobody can unregister. ✎✎ Circle is considering 7702 single-address accounts for prod: the address stays and the vouch stays; the only condition is that Circle's delegate answers ERC-1271 for the account key, which verifiers use once code is attached. In the single-address case pocket and operator collapse into one field; no code may assume they differ. |
| D2 | **Dashboard action**, not an onboarding step | Onboarding doors were rewritten by doola PR 4. Permanence and hijackability both demand deliberate consent. A dashboard action also serves existing agents. ✎✎ Still per agent after A1: companies have no address and no page; a company-level button would be the bulk action D4 forbids. |
| D3 ✎✎ | **We submit on World Chain**, parameterised by `(chainId, contract)` and pinned by a test; World's relay is a documented manual fallback only | World Chain is what every verifier reads today; the relay is Base-first and refuses re-vouches (§1.3). |
| D4 | **Never automatic, never bulk** | Irreversible, publicly linkable, and per §8 not even durable. |
| D5 ✎ | Gate on an **Orb-grade credential**: ✎✎ `credential ∈ {"orb", "proof_of_human"}` | `groupId = 1`. A passport/MNC/document guardian would pass every server-side check and then fail inside World App with no explanation. ✎✎ One ineligibility message for every other tier (§5.3); on prod today 13 guardians are Orb-grade, 2 are waivers, none passport or MNC. |
| D6 ✎ | **Persist the nullifier we submitted**, ✎✎ at the claim INSERT | v1 refused to store it for privacy. That benefit was illusory: it is public on-chain, we already link pocket → guardian in our own DB, and the backend receives it in the request body anyway. Without it we cannot tell our own binding from an attacker's (§8, CRITICAL-2). ✎✎ Written when the row is claimed, not after submit, or a crash after broadcast can never be matched. |
| D7 | Consent copy is part of this design, verbatim (§5) | Every honesty failure in this project happened downstream of a design that was right in intent and unfinished in copy. |
| D8 ✎✎ | **The frontend recomputes the signal and shows the pocket beside the ERC-8004 agent id** | v2 credited this with closing the confused-deputy path. It does not: both values come from the same backend. It detects an inconsistency between two of our routes. The independent anchor is the guardian's own comparison of the displayed address with the address that paid the agent's x402 invoices on Arc (Arcscan link), plus a trust-on-first-use pin in the browser that warns on change. The on-chain metadata anchor is deferred; a Circle 7702 single address makes it moot. |
| D9 | **Claims ceiling** (§5.4). No surface may say the *guardian* vouched, or imply control, removal or permanence | We cannot prove who vouched, we cannot remove, and the binding can be replaced. |
| D10 ✎✎ | **AgentKit signer chain id `eip155:480`; our seller advertises 480 and Arc** | EIP-191 is chain-agnostic for a key; the chain id only selects the RPC for ERC-1271 checks, and for an EOA without code on that chain the verifier falls back to ecrecover. Without this a registered Novi agent cannot pass Exa or any other seller and the demo is "Novi passes Novi". |
| D11 ✎✎ | **Submitter key added now**, following the hardening spec's pattern, with its own write RPC | The batch it was sequenced against is spec-only (§4.2). |
| D12 ✎✎ | **Reconciliation is owned by an in-process reconciler**; GET is an extra trigger; the monitor pages only | Nothing else runs without a browser; the monitor is read-only by construction (§4.5, §6). |
| D13 ✎✎ | **Caps**: per-entity lifetime 3, per-tenant 5 sessions per hour, process-wide token bucket on World Chain calls from these routes, budget consumed before any RPC read | The drain is shared RPC quota, not gas (§4.7). |
| D14 ✎✎ | **IDKit: option (a)** under an npm alias, browser only, dynamically imported | (b) is unavailable, (c) makes the backend the sole signal author (§4.6). |

---

## 3. The flow

Preconditions, enforced server-side before anything is shown:

1. Caller owns the entity; entity is at least `bound`.
2. ✎✎ `rec.pocketAddress` is present. It is a stored fact (§1.1); null → `unavailable` with reason
   `no-pocket-yet`, the value PR #102 already emits. Never derived at read time: read paths do not
   touch `POCKET_MASTER_SEED`, and mainnet has none.
3. ✎✎ The guardian's stored credential is `orb` or `proof_of_human` (D5).
4. The deployment has registration configured (§4.3).
5. ✎ **Not** "is this address registered". It is: *do we have a confirmed registration of our own
   whose nullifier still matches `lookupHuman`?* A non-null lookup that we did not write means
   someone else vouched, which is a **disputed** state, not a finished one (§8, CRITICAL-2).
6. ✎✎ The caps in D13 are not exhausted; the tenant's session budget is consumed before any RPC read.

```
Guardian clicks "Vouch for this agent in AgentBook"
  → confirmation dialog (§5.1), checkbox gate, full pocket address + ERC-8004 agent id shown
  → POST /entities/:id/agentbook/session
       server: re-checks preconditions, consumes the tenant's session budget,
               reads getNextNonce(pocket) on World Chain,
               INSERTs a `pending` row (session_id, entity, tenant, address, nonce, expires_at),
               returns { sessionId, appId, action, signal, nonce, pocketAddress, agentId, expiresAt }
  → frontend: recomputes buildSignal(pocketAddress, nonce) LOCALLY and aborts on mismatch (D8),
              compares pocketAddress with the trust-on-first-use pin and warns on change,
              opens the World ID request through the v2 bridge, renders QR + deeplink, polls (300s)
  → guardian approves in World App (request shown as "AgentKit", Face Auth possible)
  → POST /entities/:id/agentbook/register  { sessionId, root, nonce, nullifierHash, proof[8] }
       server: validates shape (§4.7); loads the pending row for this tenant+entity+session, not expired;
               re-reads getNextNonce and requires equality with the row's nonce;
               simulates the call; under withKeyedLock("worldchain-submitter"): signs, then
               CAS pending → submitted writing nullifier, raw_tx, submitter_nonce (the partial
               unique index on `submitted` is the atomic claim), then broadcasts and stores tx_hash
  → reconciler (D12): submitted → confirmed | disputed | failed (§6), also triggered by GET
```

---

## 4. Backend

### 4.1 `src/adapters/worldid/agentBookRegistrar.ts`

`getNextNonce`, `isRegistered` (reusing `agentBookReader.lookupHuman`, never reimplementing its
definitive-vs-unknown discipline), `buildSignal`, `simulate`, `submitRegistration`, `reconcile`.

**`buildSignal` is the silent-failure risk.** The contract hashes `abi.encodePacked(address,uint256)`
— **52 bytes, packed**. viem's `encodeAbiParameters` produces the padded 64-byte form, which
type-checks, encodes, and then reverts on-chain *after* the guardian has done the work. Use IDKit's
own helper, or `encodePacked` with a comment saying why. §7 pins this with a golden vector.

The `register` argument order (`agent, root, nonce, nullifierHash, proof`) must be vendored as a
named-args ABI, not reconstructed from the selector: three adjacent uint256s reorder silently.

Failure taxonomy follows `src/adapters/arc/relay.ts`: a revert is not a transport failure.

✎✎ **Client and submission.** One World Chain public client from viem's `worldchain` definition
(`chainFor` in `src/adapters/arc/chains.ts` is Arc-specific and is not reused), reads through
`WORLD_CHAIN_RPC`, writes through `WORLDCHAIN_SUBMITTER_RPC`. Address, contract and chain come from
one exported constant shared with `agentBookReader`. Submission follows `arcAdapter.ts:161-168`:
`simulateContract → sign → persist raw_tx and submitter_nonce → sendRawTransaction →
waitForTransactionReceipt`, the whole sequence under `withKeyedLock("worldchain-submitter")`
(`src/payments/keyedMutex.ts`), because there is no nonce manager and two guardians vouching at once
would otherwise race `eth_getTransactionCount`. `attempt` is bumped only on a deterministic revert
(`ContractRevertError`, `relay.ts:99-113`), never on transport, following `oaAnchorRepository.ts`.

✎✎ **Reconcile order** (§6): contract state first, `getNextNonce(pocket)`; receipts as a fast path;
`confirmed` is written from a read at `blockTag: "safe"`, never `latest`, and records
`confirmed_block`.


### 4.2 Key

✎✎ `WORLDCHAIN_SUBMITTER_PRIVATE_KEY: privKeySchema.optional()` in `env.ts`, added now (D11), following
`2026-08-24-mainnet-hardening-batch-spec.md` §1–2 even though that batch is not implemented: no
fallback to `PLATFORM_PRIVATE_KEY`; boot refuses equality, by address, with every other configured
key (platform, customer, job client, funding, x402 proof key, ENS signer); in production a submitter
key present **without** `cfg.world` refuses boot (half-configured feature, the doola all-or-nothing
pattern at `env.ts:613-623`); an entry in `redact()` (`env.ts:815`) and in `.env.example`; a row in
the key table of `2026-08-11-mainnet-readiness.md`. `WORLDCHAIN_SUBMITTER_RPC` (defaults to
`WORLD_CHAIN_RPC`) lets ops pin a paid endpoint for writes without exposing it to the read path.

The key holds World Chain ETH only and has no authority over any Novi contract. Runbook rule: never
fund this address on any other chain, because an EOA key is valid on every chain. Pre-submit
`getBalance` check → `unavailable` 503 plus `opsLog("agentbook_submitter_low")`. World Chain ETH is
outside the S5 USDC outflow ceiling; it is bounded by the caps in D13 and by the float (0.005 ETH is
roughly three thousand registrations at today's gas).

Public fact recorded in §8 MEDIUM-2 and in the dialog: every registration transaction has
`from = submitter`, so anyone can list every address Novi Corpus ever vouched for.

### 4.3 Availability

✎ One exported predicate `canRegisterAgentBook(cfg)` = submitter key present **and** `cfg.world`
present (the credential check needs `WorldStore`). `WORLD_CHAIN_RPC` and `WORLD_AGENTBOOK_ADDRESS`
have schema defaults and are never absent, so they cannot be part of the test. ✎✎ Names, following
`canProvisionTurnkey` / `canFormEntities`: `ApiDeps.agentBook?: AgentBookDeps` (registrar,
repository, reader), built iff the predicate holds; `/config.agentBookRegistrationAvailable =
Boolean(deps.agentBook)`; `PublicConfig.agentBookRegistrationAvailable?: boolean` (optional for
deploy-order safety); the three routes are mounted only when the deps object is present. The
existing GET route moves onto the same deps object and stops depending on `ENABLE_X402_DEMO`.

### 4.4 Persistence

✎✎ Rewritten: v2's table could not carry §3's session, had no `expires_at`, no `disputed` although
§4.5 writes it, no CHECK constraint although every table has one, no `raw_tx` although the house
rule (`db.ts:191-193`) is "persist the signed transaction before broadcast", and no compare-and-swap
moves although every unattended repository here uses them.

```
CREATE TABLE IF NOT EXISTS agentbook_registrations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL UNIQUE,
  entity_key      TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  address         TEXT NOT NULL,            -- the pocket, lower-cased
  nonce           TEXT NOT NULL,            -- AgentBook getNextNonce at session time
  status          TEXT NOT NULL CHECK (status IN
                    ('pending','submitted','confirmed','disputed','failed','expired')),
  nullifier       TEXT,                     -- ours, written at the claim (D6)
  raw_tx          BLOB,                     -- signed before broadcast
  submitter_nonce INTEGER,                  -- EVM nonce used, for replacement detection
  tx_hash         TEXT,
  confirmed_block INTEGER,
  attempt         INTEGER NOT NULL DEFAULT 0,
  error_code      TEXT,
  expires_at      INTEGER NOT NULL,         -- session expiry (epoch ms), like world_requests
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- The insert IS the concurrency guard: one in-flight submission per entity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agentbook_inflight
  ON agentbook_registrations(entity_key) WHERE status = 'submitted';
CREATE INDEX IF NOT EXISTS idx_agentbook_entity ON agentbook_registrations(entity_key, created_at);
```

`pending` rows are sessions; they are not in the in-flight index, so an abandoned session never
blocks a restart, and expiry is their guard. Repository `src/persistence/agentBookRepository.ts`
(`SqliteAgentBookRepository`): every transition is `UPDATE … WHERE status = ?` and reports whether
this caller won, as in `formationRepository.ts:14-17` and `oaAnchorRepository.ts:9-13`. `attempt`
follows the `bridge_legs` / `oa_anchors` convention. `submitted` with `tx_hash IS NULL` means
"signed and claimed, broadcast unknown", and the stored `raw_tx` is what the reconciler
re-broadcasts. The lifetime cap of D13 is a count of rows per entity with status in
`('submitted','confirmed','disputed')`.

### 4.5 Routes ✎

- `POST /entities/:id/agentbook/session` → `pending` row, `{ sessionId, appId, action, signal, nonce,
  pocketAddress, agentId, expiresAt }`.
- `POST /entities/:id/agentbook/register` → CAS `pending → submitted`, broadcast, `{ status, txHash }`.
- `GET  /entities/:id/agentbook` → the moved route. ✎✎ It sits on `ApiDeps.agentBook`, uses
  `createAgentBookReader` (never the SDK verifier that returns null on an outage), and returns a
  **superset** of today's shape so the deployed frontend keeps rendering across the deploy window:
  `registered` and `humanId` kept; `status`, `txHash`, `disputed` added; and an explicit outcome union
  `registered | unregistered | unknown | disputed`, where `unknown` is a transport failure and renders
  as "could not check", never as "not registered". Reconciliation reads bypass `world_human_cache`.
  `entityAgentBook` / `useEntityAgentBookQuery` get tolerant parsing.

✎✎ **Reconciliation owner (D12).** The monitor is read-only by construction (`monitor/entityLookup.ts:
8-11,135`, `monitor/rpc.ts`) and the formation sweeper is doola code we do not touch, but the API
process already hosts in-process drivers (`reconcileInFlight()` at boot, `formationSweeper.start()`
on an interval, `api/main.ts:440,496,636`). Reconciliation is a small reconciler of the same shape:
`reconcileAgentBook()` at boot and on an interval, and GET calls the same CAS'd repository method so
a page open is never stale. Rules in §6. On `disputed`, write `cacheLookup(pocket, foreignHumanId)`
immediately so the seller and buyer dials stop serving the stale human id for up to an hour
(`sellerTrust.ts:39`); alert the guardian once per `(entity, foreign nullifier)`.

✎✎ **Views.** `toEntityView` is a synchronous projection (`views.ts:255`), so `EntityView.agentBook`
is DB truth only: `{ status, txHash, submittedAt } | null` from a sync `agentBookLookup(entityKey)`
plus a batched `agentBookMany` in `EntityViewDeps`, which REST and MCP both inherit
(`McpToolDeps extends EntityViewDeps`, `mcp/server.ts:40`). The chain-derived outcome stays on the
GET route. `EntityView` also gains `pocketAddress` (a stored fact, public on-chain as the x402
payer), which D8 and the dashboard need. The nullifier never reaches MCP or the transparency page; it
is readable on the owner route only, as minimisation rather than secrecy.

### 4.6 The IDKit version decision ✎

✎✎ **Decision: (a).** Rewritten after the second audit.

- **(a) Pin `@worldcoin/idkit-core@2.1.0` beside v4** and use `createWorldBridgeStore` and
  `solidityEncode` exactly as World's CLI does, pinned to CLI commit `434407c`. Two versions of one
  package name cannot coexist in `interface/package.json`, so it is installed as an npm alias,
  `"idkit-core-v2": "npm:@worldcoin/idkit-core@2.1.0"`, exact version, lockfile integrity. The
  package is deprecated on npm ("Old-versions moved to new ones") and carries `ox ^0.1.0`,
  `zustand ^4.5` and `buffer ^6` beside the interface's `ox` 0.14 and `zustand` 5, so it is imported
  dynamically and only by the vouch dialog, never on the server (the WASM shim in
  `guardianGate.ts:67-96` shows why), and `npm audit` gates it.
- **(b) Rebuild on the v4 request API is not available.** v4 `IDKit.request` needs an `rp_context`
  signed by the app owner's relying-party key (`guardianGate.ts:50-57` signs with ours, for our
  `rp_id`), and the AgentBook app is World's. The v4 portal flow also never hands the `uint256[8]`
  proof back to the client. It becomes possible only if World publishes an `rp_context` endpoint for
  AgentBook or accepts legacy proofs; that is a question for the feedback document.
- **(c) Run the v2 bridge in Node**, as the MCP-first guardian flow does (`startGuardianVerification`),
  would keep 2.1.0 out of the browser bundle but makes the backend the sole author of the signal,
  which is the confused-deputy shape D8 exists to narrow. Rejected for this design.

### 4.7 Validation, caps, logging ✎✎

- **Input.** zod: `proof` is exactly 8 strings, each matching `/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/`;
  `root`, `nonce`, `nullifierHash` the same; `nonce` must equal the session row's; `sessionId` a
  UUID. Body limit 8 KiB on both POST routes via `hono/body-limit` (no route has one today).
- **Caps (D13).** Per-entity lifetime cap of 3 rows in `('submitted','confirmed','disputed')`
  → `limit_exceeded`. Per-tenant 5 session creations per rolling hour, counted from `pending` rows.
  A process-wide token bucket on World Chain calls made by these three routes, because they share
  `WORLD_CHAIN_RPC` with the buyer and seller trust dials and a throttled reader makes those dials
  refuse (`sellerTrust.ts:62-68`). The budget is consumed before the nonce read, so an unauthenticated
  or over-budget caller never costs an RPC call.
- **Logging.** Never `String(e)` or `e.message` for simulate or submit errors: a viem contract error
  prints the call arguments, which are `agent, root, nonce, nullifierHash, proof[8]`, and a failed
  attempt's nullifier is not public. `opsLog` carries `{ entity, tenantPrefix, errorName ?? code }`
  only; the 4xx body carries the code. §7 pins this with a test.
- **Transport.** Auth is a Bearer token from `sessionStorage`, no cookies, so CSRF does not apply.
  Add `Content-Security-Policy: frame-ancestors 'none'` in `interface/next.config.ts` as hygiene.


---

## 5. Frontend and copy

### 5.1 Confirmation dialog (verbatim)

✎✎ Trimmed after the second audit: a headline, four bold one-liners and one closing paragraph, with
the v2 long form behind "Details". Every factual claim was checked against the contract and the CLI
source and is unchanged; two were wrong and are fixed: the requester World App shows is **AgentKit**,
not "AgentBook", and Face Auth may be requested. The line "We watch for that and will tell you" is
replaced while the monitor rule is deferred (§6).

> **Vouch for this agent in AgentBook**
>
> You are about to publicly vouch for this agent, as a person.
>
> **Public, forever.** A pseudonym from your World ID is written to a public blockchain next to this
> agent's payment address `0x…` (agent #`<agentId>`, the address that pays its x402 invoices). It
> cannot be removed, by you, by us or by World.
>
> **The same pseudonym every time.** Anyone can see that every agent you vouch for in AgentBook,
> here or anywhere else, shares one backer, and that Novi Corpus submitted it.
>
> **Someone else can replace it.** Any World ID verified person can vouch for this address and
> overwrite yours. Your agent's dashboard will show it; we cannot prevent or undo it.
>
> **Not a proof of control, not a legal signature.** It says one thing: a verified human chose to
> stand behind this address.
>
> Novi Corpus pays the network fee. World App will show a request from **AgentKit**, World's
> registry app, and may ask for Face Auth. Approving it is the vouch.
>
> [Details ▾]
>
> ☐ I understand this is public, permanent, and can be replaced by someone else.
>
> [Cancel] [Vouch permanently]

"Details" expands to the v2 paragraphs, verbatim:

> **What this does.** It writes a record in AgentBook, a public registry on World Chain, saying that
> a World ID verified human stands behind this agent's payment address. Sellers who check AgentBook
> will see this agent as human-backed.
>
> **What becomes public, forever.** A pseudonym derived from your World ID is published on a public
> blockchain, linked to this address. It does not reveal your name. But it is the same pseudonym
> every time you vouch in AgentBook, here or anywhere else, so anyone can see that every agent you
> vouch for shares one backer. The transaction is sent by Novi Corpus, so anyone can also list every
> address Novi Corpus has vouched for.
>
> **You cannot remove this.** AgentBook has no removal function. Not you, not us, not World. The
> record outlives this agent and your account.
>
> **Someone else can replace it.** AgentBook lets any World ID verified person vouch for any address,
> including this one, which overwrites the current vouch. Your agent's dashboard shows that state as
> "disputed"; we cannot prevent it or undo it.
>
> **What this does not do.** It does not prove you control this address, and it is not a legal
> signature.

Two conditional lines, inserted before the checkbox:

- If the guardian already has confirmed registrations: *"You have already vouched for N agents from
  this account. This vouch will be publicly linkable to them."*
- ✎✎ If the deployment runs on Arc testnet: *"This agent runs on Arc testnet. The vouch is on World
  Chain mainnet and is just as permanent."*

### 5.2 States

`unavailable` (with the reason) → `not-registered` → `awaiting-approval` (QR, deeplink, countdown,
and the line "Approving in World App completes a public vouch") → `submitting` → `vouched` →
`disputed` → `failed`, plus ✎✎ `unknown` ("could not check", the transport-failure outcome of §4.5).
✎ The UI may never show a terminal `failed` or `not-registered` for an entity with any `submitted`
row until the reconciler has re-read the registry: a false "it didn't happen" is a false statement
about what is permanently public about a person. Failure copy: *"We could not confirm the
registration. It may still have gone through; we are checking the registry and will update this."*

✎✎ **After `disputed`** the guardian may re-vouch exactly once per dispute, deliberately, through the
same dialog with the linkage line; after that the button is hidden with "contact support". Never
automatic (§8). The chip on the dashboard shows `disputed` plainly.

### 5.3 Not eligible

✎✎ One message for every non-Orb guardian (waiver, passport, MNC, document), because the
passport/MNC branch of v2 had no users and the reason is the same:

> **AgentBook vouching needs a World ID from an Orb.** Your access here is unaffected. AgentBook is
> World's public registry and only accepts Orb-verified proofs. There is nothing we can substitute
> for that, and we will not fake it.

The copy names the constraint as World's, not ours. The check reads `/world-id/me.credential`; no
new endpoint.

### 5.4 Claims ceiling (D9)

Permitted: *"A World ID verified human has vouched for this agent's payment address in AgentBook."*
Forbidden anywhere, including the deck and the transparency page: "your guardian vouched", "proves
control", "human-backed" as a chip label, "manage your listing", "remove", "permanent proof", and
any implication that most Novi agents are registered.

✎✎ **Already violated on prod, fixed in the same PR as the button:** the dashboard chip reads
"AgentBook · human-backed" in emerald (`AgentDashboard.tsx:191-221`); the personhood page repeats
the wording (`personhood/page.tsx:64-71`); `TenantRecord.tsx:31,56` shows a waiver guardian as green
"Human-backed" with no waiver branch while `/world-id/me` returns `verified: true, credential:
"waiver"`; the dial labels at `AgentSettings.tsx:357` and `AgentDashboard.tsx:399` say "verified
sellers". The chip becomes neutral: "Vouched in AgentBook ↗" / "Not in AgentBook" / "Could not check"
/ "Disputed in AgentBook". The two old decks that claim every agent is registered
(`pitch/novi-corpus-world-call-deck.html:321,392`, `pitch/novi-corpus-deck.html:233-238`) are marked
superseded in the plan and are not reused in the video.

Transparency chip: ✎✎ rendered in the past tense with a timestamp, because the public page cannot be
kept current by an owner's dashboard visit: **"Registration submitted to AgentBook on <date> ↗ · last
checked <time>"**, linking to the transaction, neutral styling, not green, not adjacent to the
human-verified chip, in its own column; suppressed unless the row is `confirmed` and was checked
within the last hour. Before flipping the public chip to `disputed`, the reconciler confirms
`lookupHuman` from a second RPC (§8).

✎✎ **PR #98 is merged (`bb86471`, 2026-08-29) but was not deployed on 2026-09-07:** the live
`/transparency` returns `humanVerified: true` for the two waiver guardians (agents 881014 and
845996) while `transparency.ts:96` on main computes `Boolean(gv) && gv?.credential !== "waiver"`. The
gate is therefore "deployed to novi-prod and verified by curl", not "merged". Adding a second trust
chip to a page whose first one is wrong compounds exactly the failure this design cites.

---

## 6. Failure modes

| Mode | Handling |
|---|---|
| Concurrent submits | Partial unique index on `submitted` (§4.4) is the atomic claim; the submitter lock serialises the EVM nonce. |
| Nonce moved between session and submit | `conflict` 409, restart the session. Prevents wasted gas; does **not** prevent hijack (§8). |
| Proof rejected / bad encoding | `simulate` before broadcast; never pay gas for a certain revert. Caps per D13. |
| Guardian abandons | `pending` row expires (`expired` on next reconcile), nothing public; cancel aborts cleanly and a late proof for an expired session is refused. |
| Address vouched by someone else | `disputed`, not `registered`. Alert the guardian once. Do **not** auto re-register (§8). Cache the foreign id immediately (§4.5). |
| Crash after signing, before broadcast | `submitted` + `raw_tx` + null `tx_hash`: the reconciler re-broadcasts the same signed transaction. |
| Transaction dropped or replaced | ✎✎ detected from contract state, not receipts: see rules below. |
| RPC unavailable | "Could not tell" is never rendered as "not registered" (`unknown`). |
| Submitter out of ETH | Pre-submit balance check + `unavailable` 503 + ops log line. |
| Lying or compromised RPC | Bounded: no funds at risk; worst case wasted gas or a false public statement. The public chip flips to `disputed` only after a second RPC agrees. |

✎✎ **Reconciliation rules** (`reconcileAgentBook`, D12), for every `submitted` row:

1. Read `getNextNonce(pocket)` at `blockTag: "safe"`. If it still equals the row's nonce and
   `submitted_at` is older than 10 minutes, nothing landed: re-broadcast `raw_tx` if the submitter's
   account nonce has not passed `submitter_nonce`, else mark `failed` with `error_code = replaced`
   (retryable through a new session).
2. If the nonce moved, read `lookupHuman(pocket)` at `safe`: equal to our nullifier → `confirmed`
   with `confirmed_block`; different → `disputed`.
3. Receipts are a fast path only: a receipt with status 0 → `failed` immediately.
4. `pending` rows past `expires_at` → `expired`.
5. `confirmed` rows are re-checked on every tick with one `getLogs(AgentRegistered)` filtered by our
   addresses (indexed topic), not N `lookupHuman` calls; a newer event with a different nullifier →
   `disputed`.

**Monitoring.** ✎✎ The monitor rule is deferred for the hackathon; the reconciler above already
produces `disputed`. When built: a second `MonitorRpc` for World Chain (viem ships `worldchain`), a
read-only `agentbook_registrations` projection behind `assertLookupSchema` (API deploys before
monitor), per-tick rules `agentbook_disputed` (CRITICAL, `dedupKey = agentbook:${entity}:
${observedNullifier}`) and `agentbook_registry_changed` for `worldIdRouter()` / `groupId()` drift
(WARN, `dedupKey = agentbook:${router}:${groupId}`). ✎ The design states plainly that the dispute
alarm has **no remediation**: re-registering starts a war an attacker wins at $0.0015 a round. The
runbook action is: notify the guardian, the reconciler flips the chip, do not auto-respond. The
monitor pages; it never writes.

---

## 7. Test plan

- **Golden vector, packed.** Assert `buildSignal` byte-equals a fixture captured from World's CLI
  for a fixed (address, nonce): 52 bytes, packed, not 64 padded. Extend it to full `register`
  calldata so the argument order is pinned too. ✎✎ Re-capture it from the live registration.
- ✎✎ **Verifier chain pin.** A test that fails when the installed `@worldcoin/agentkit-core` dist no
  longer contains `worldchain` and `0xA23aB2712eA7BBa896930544C7d6636a96b944dA` (H1 of the audit).
- Preconditions matrix, including the Orb-grade gate on stored credentials, the disputed state, the
  stored-fact pocket address (null → `no-pocket-yet`, never derived), and the caps (per entity, per
  tenant, token bucket consumed before the RPC read).
- Boot invariants: submitter key equal to any other configured key refuses boot; key present without
  `cfg.world` in production refuses boot; absent key ⇒ unavailable + 503; redaction test.
- ✎✎ **Log and body redaction.** Force a simulate revert with a known nullifier and proof; assert
  neither the ops log line nor the 4xx body contains `nullifierHash` or any `proof[i]`.
- Concurrency: two simultaneous registers, exactly one submits; two entities at once, distinct
  submitter nonces.
- Restart: `submitted` row with `raw_tx` and no `tx_hash`, the reconciler re-broadcasts; `submitted`
  row whose nonce moved with a foreign nullifier → `disputed`; nonce unmoved after 10 min → `failed`.
- ✎✎ Reconciliation reads use `blockTag: "safe"`; the public chip flips to `disputed` only after two
  RPCs agree.
- Route supersede: the old response shape still parses; the `unknown` outcome renders "could not
  check".
- Transparency and metadata non-leak tests (no nullifier on `/transparency`, `/metadata`, MCP);
  interface status-union drift test; input validation matrix (proof length, hex and decimal forms,
  body over 8 KiB).
- ✎✎ **Signer chain.** The AgentKit signer emits `eip155:480`; our seller's 402 lists both 480 and
  Arc; a proof from an Orb-vouched pocket passes our seller and World's example server.
- **One deliberate live registration**, done **first**, on a circle agent whose guardian explicitly
  consents to a permanent public vouch. ✎✎ The runbook records: the World ID used and the accepted
  permanent linkage between that pseudonym, the agent and the `/proof` demo key; the tx hash; the
  pocket; `NODE_ENV=production`; the pinned submitter RPC; whether World App requested Face Auth;
  whether a second proof from the same human was accepted (`max_verifications: 1`); and the packed
  signal captured for the golden vector. It is also the only validation that our app-id and action
  constants are right (§1.2: no getter). Note that a third party may overwrite it, and that this is
  expected, not a failure.

---

## 8. Threat model

**HIGH-1 — the binding names *a* human, not *our* human, and a third party can reassign it.** The
pocket address is public (it is the on-chain x402 payer). Any Orb-verified person reads
`getNextNonce`, proves over `(pocket, nonce)` with their own World ID, and overwrites `lookupHuman`
for ~$0.0015. Note what this does **not** break: the seller's check still passes, because a unique
human is still vouching, which is all AgentBook claims to answer. The real damage is narrower and
worth stating precisely:

1. **Reputation poisoning.** An attacker writes a humanId that sellers have already blocklisted over
   our agent's address, and our agent inherits the bad identity.
2. **Quota capture.** AgentKit's free tier is metered per human across all agents they back, so a
   reassignment moves our agent onto a stranger's meter.
3. **Any claim that names a person.** Anything we build that reads the binding as "this specific
   accountable human" — the proof-of-legal-entity idea above all — is unsound without a second
   source of truth that we control.

Conversely the attack is largely self-harm: the attacker attaches their own scarce identity to an
agent they do not control and inherits its misbehaviour. That is why this is HIGH and not CRITICAL,
and why the mitigation is honest claims (D9) plus detection (§6), not an attempt to hold the slot.

**HIGH-2 — pre-registration locks our guardian out.** If an attacker vouches first, a
precondition of "is it registered?" reads true and our own UI would refuse to let the guardian
register, while showing a chip whose on-chain human is a stranger. Resolved by D6 (store our
nullifier) plus the disputed state, and by treating a stranger's binding as something our
guardian may overwrite rather than a closed door — which is exactly what last-write-wins intends.
v1 contained a genuine contradiction here, since it wanted both
"already registered ⇒ done" and "never store the nullifier".

**HIGH-3 — confused deputy.** World App shows an app name and action, not the address. A compromised
backend could return a signal over an attacker's address and the guardian would vouch for a
scammer's wallet, permanently, with no way to notice. Mitigated by D8 (frontend computes and
verifies the signal against `entity.pocketAddress`) and by showing the full address in the dialog.
Residual trust in World App's opacity is documented, not solved.

**HIGH-4 — front-running.** An attacker can land the same nonce first while the guardian is in World
App. The stale-nonce check saves our gas, not our binding. No client-side flow can win this race
against a permissionless `register`.

**MEDIUM-1 — we inherit World's key risk.** The registry owner is a single EOA that can repoint the
World ID router or change the group, with no timelock, and ownership can never be renounced. A
compromised owner key could rewrite every binding. Detection only (§6).

**MEDIUM-2 — fleet deanonymization.** The nullifier is deterministic per human per action, so
vouching for N agents publicly and permanently links them as one backer, on any platform using
AgentBook. This is the largest privacy fact and it is now in the dialog copy.

**Not findings, checked and sound:** the proof cannot be retargeted to a different agent after
production, because the address is inside the signed signal; a leaked proof only performs the
registration we wanted; `register` writing state before verifying is safe because the whole
transaction reverts; the submitter key genuinely holds nothing but gas and has no authority over
any Novi contract.

✎✎ **Edits after the second audit.**

- **HIGH-3** stays HIGH, but its mitigation is restated: D8 detects an inconsistency between two of
  our routes; it does not defend against a compromised backend, which supplies both values. The
  residual mitigation is the guardian's own comparison of the displayed pocket with the address that
  paid the agent's x402 invoices on Arc, plus the trust-on-first-use pin. The on-chain anchor is
  deferred; a 7702 single address makes it moot.
- **HIGH-4 → LOW**, merged into HIGH-1: World Chain has a private sequencer mempool, so there is
  nothing to snipe. "Same nonce first while the guardian is in World App" is HIGH-1 inside a
  five-minute window.
- **New, HIGH: shared-RPC denial.** The session and register routes hit the same public World Chain
  endpoint the buyer and seller trust dials use. Without caps, one authenticated tenant can throttle
  the endpoint and make every human-backed trade refuse platform-wide. Mitigated by D13 and the
  separate write RPC.
- **New, MEDIUM: a lying RPC** can flip `confirmed` ↔ `disputed` and make the public chip lie.
  Bounded: no funds at risk, at worst wasted gas or a false public statement. The public chip changes
  only after a second RPC agrees; the nonce read for a session needs no second source.
- **MEDIUM-2 addition: submitter enumeration.** Every registration has `from = submitter`, so anyone
  can list every pocket Novi Corpus ever vouched for and join them to pseudonyms. Public by
  construction; now stated in the dialog.
- **New, MEDIUM: verifier chain migration.** World's registration tooling is Base-first while
  verifiers read World Chain (§1.3). If the verifier default flips, every World Chain registration
  becomes invisible. Detected by the chain-pin test; answered by parameterisation and the question
  to World.


---

## 9. Scope

✎✎ Rewritten for the ETHOnline deadline (13 September 2026, 12:00 EDT). The design above is the
full shape; this section says what ships first.

**Prerequisite.** PR #98 deployed to novi-prod and verified by curl (§5.4).

**In, minimal honest scope.** The registrar (§4.1) with the golden vector and the chain-pin test; the
submitter key with its boot invariants and redaction (§4.2); the three routes with reconcile-on-read
producing `submitted → confirmed | failed | disputed` (§4.5, §6 rules 1–4); the dialog (§5.1), the
QR and deeplink through the pinned v2 bridge (§4.6), the local signal recompute and the address pin
(D8), the state machine including `unknown` (§5.2); the chip renamed and neutralised, the personhood
sentence and the `TenantRecord` waiver branch (§5.4); one ineligibility message (§5.3); the caps at
their simplest (§4.7); the AgentKit signer on `eip155:480` and the seller advertising both chains
(D10); the one live registration, done first (§7).

**If time remains.** The in-process reconciler interval (D12) and rule 5; the "already vouched for N
agents" line; `agentBook` and `pocketAddress` on `EntityView` for MCP; the transparency chip in past
tense.

**Deferred.** The monitor rules and the router/groupId watch; caps beyond the simple ones; bulk,
onboarding integration, MCP-initiated registration; building against World's relay; dual
registration on Base; the ERC-8004 payer-metadata write (7702 makes it moot).

**Out of this design, in the World plan.** The "has a legal body" attestation is the submission
this flow is the prerequisite for: a composite verifier that answers only when AgentBook says human
and our registry says active legal body, a public `GET /lookup/legal-body/:address` keyed by the
**pocket** (`findByPocket` does not exist yet; the buyer trust root is keyed by treasury), and a
`legal-bodies-only` policy on our seller. Per §8 it is *more* valuable than it looked, because it
fixes the exact weakness AgentBook has. Also in the plan, not here: a sandbox-pointed deployment for
the judge's remote test (the vouch itself cannot run in World's Sandbox) and the feedback document.

---

## 10. What v1 got wrong

Recorded so the next reader trusts the corrections rather than the confident prose: the existing
`/entities/:id/agentbook` route was missed entirely; "no unregister, therefore permanent" was half
right and the overwrite path was called unverifiable when World's own test proves it; the Orb-only
constraint was missed, so D5 gated on the wrong thing; the IDKit dependency was claimed present when
the shipped major version lacks the functions; the double-submit guard was asserted without a
constraint; the confirmation loop had no owner; D6 forbade the very data needed to detect tampering;
the bytecode size was the hex-string length; the function count was wrong; and the consent copy was
described rather than written.


---

## 11. What v2 got wrong (2026-09-07 audit)

Recorded so the next reader trusts the corrections rather than the confident prose. Full findings in
`2026-09-07-agentbook-registration-audit.md`.

- The existing route was still described as a live bug; PR #102 had fixed it a day after v2 was
  written. Three residues remained (demo-flag gate, SDK verifier, 10-minute cache).
- World's registration guide and hosted relay were already Base-first on 25 August and v2 missed it;
  the relay was called "a demo-app deployment" when it is the app's registered integration URL, and
  it refuses re-vouches.
- §4.6 presented "rebuild on IDKit v4" as a cleaner alternative; it is unavailable, because v4
  requests must be signed by the app owner's key and the app is World's. Option (a) needs an npm
  alias and pins a deprecated package.
- D8 was credited with closing the confused-deputy path; it compares two values from the same backend
  and the browser had no independent source for the pocket address.
- §4.4 could not carry §3: no session row, no expiry, no `disputed`, no CHECK, no signed transaction
  stored before broadcast, no compare-and-swap moves, and receipts alone cannot resolve a dropped or
  replaced transaction, so a stuck row blocked the entity forever.
- Reconciliation had no owner that runs without a browser; the transparency chip would have kept a
  present-tense claim after an overwrite.
- The threat model missed the real drain: shared RPC quota, not gas; and the public fact that the
  submitter address enumerates every vouch.
- A registered agent still could not pass any third-party seller: the signer advertised Arc, the
  ecosystem advertises World Chain.
- §5.4 said "PR #98 must be merged"; it was merged and not deployed, and the live API still reports
  waiver guardians as human verified.
- Precondition 2 re-opened the master-seed read path that Tier-0 closed.
- The consent copy named the wrong requester ("AgentBook" instead of "AgentKit"), omitted Face Auth,
  and promised monitoring the first release does not ship.
- Logging by the existing `String(e)` pattern would have written proofs and pseudonyms to journald.
- Citations drifted: `worldId.ts:365-403` → `415-455`; `env.ts:756` → `815`; `onboarding.ts:489` →
  `479`; `app.ts:172-187` → `172-192`.

## 12. Traceability (audit finding → section)

| Audit finding | Section |
|---|---|
| H1 chain divergence | §1.3, D3, §4.1, §7, §8 |
| H2 IDKit path | §4.6, D14 |
| H3 shared RPC quota | §4.7, D13, §8 |
| H4 signer chain | D10, §7, §9 |
| H5 PR #98 not deployed | §5.4, §9 |
| H6 persistence and reconciliation | §3, §4.1, §4.4, §4.5, §6 |
| M1 D8 over-credited | D8, §3, §4.5, §5.1, §8 |
| M2 reconciliation owner | §4.5, §5.4, §6, D12 |
| M3 route residues | §1.1, §4.3, §4.5 |
| M4 submitter key | §4.2, §5.1, §8, D11 |
| M5 log leakage | §4.7, §7 |
| M6 sandbox | §9 (plan) |
| M7 D9 on prod | §5.4, §9 |
| M8 World App copy | §1.3, §5.1, §7 |
| M9 precondition 2 | §3, §1.1 |
| M10 pocket lookup | §9 |
| L1 monitor shape | §6 |
| L2 views | §4.5 |
| L3 names | §4.3 |
| L4 eligibility | D5, §3, §5.3 |
| L5 validation | §4.7 |
| L6 live registration | §7 |
| L7 threat edits | §8 |
| L8 over-engineering | §5.1, §6, §9 |
| I1 citations | §1.1, §11 |
| I2 relay | §1.3 |
