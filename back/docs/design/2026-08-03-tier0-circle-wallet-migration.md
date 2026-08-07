# Tier-0: Circle wallet migration — Phase-0 research findings & design

*2026-08-03. Deep-research phase of the smart-account migration: three parallel investigations
(Circle DevC/Gas Station capabilities on Arc · signature-compatibility of every off-chain verifier
· exhaustive codebase EOA-surface map), load-bearing claims re-verified first-hand against
Circle's docs, the SDKs in our node_modules, and our contracts. Vivienne (Circle) confirmed in
writing: smart accounts + Gas Station live on Arc testnet today, Arc mainnet day-1 with DevC;
Circle's policy engine is still in customer discovery (NOT built).*

## The decisive findings (each verified, not just reported)

1. **The pocket CANNOT become a smart account. Blocked by Circle's own Gateway design.**
   Gateway verifies signatures statically off-chain: *"only EOA signatures are accepted"* (their
   technical guide, verbatim; re-fetched). The x402 batched `TransferWithAuthorization` struct has
   no signer/delegate field (verified in `@circle-fin/x402-batching` dist), so the signature must
   recover to the depositor. ERC-1271 is explicitly ruled out. The `addDelegate` escape applies
   to burn intents only, not the x402 scheme.
2. **The operator CAN become a smart account, today.** Every operator surface is an on-chain
   transaction (`msg.sender`); AgentTreasury/LegalManager/Factory contain zero `ecrecover`, zero
   `tx.origin` — pure `msg.sender` roles (verified by grep). The single signature-shaped surface
   is the ERC-8004 `setAgentWallet` bind (REPEATABLE — the fork test re-binds twice; "one-time" only describes the current onboarding flow, and the migration's re-bind step depends on repeatability): our mock mirrors a live ERC-1271 fallback but
   it is UNPROVEN against the live registry → either prove with one fork test or sidestep (bind
   before rotating).
3. **Circle DevC on Arc is real and priced per-wallet, not per-signature.** `ARC-TESTNET` enum
   with EOA ✅ / SCA ✅ / MSCA ✅ (docs table, re-fetched); SCA = ERC-6900 v0.7 / 4337 v0.6,
   UUPS-upgradeable, on-chain ERC-1271 (`SingleOwnerMSCA`). Pricing (re-fetched from
   circle.com/wallets): first **1,000 monthly-active wallets free**, then cents/wallet;
   **no per-signature fees anywhere**; Gas Station = sponsored gas at cost + 5%. This
   categorically ends the Turnkey 25-signatures/month problem for whatever migrates.
4. **AgentKit (World) proofs are SCA-friendly** — seller-side verification is viem
   `publicClient.verifyMessage` (ERC-6492/1271-aware; the SDK's own error text names ERC-1271).
   AgentBook is address-keyed, no EOA assumption on lookup.
5. **Weak spots in Circle's offer today:** DevC's REST API is single-call (no first-class batch
   UserOps — that's the separate Modular Wallets SDK); Gas Station policies are coarse
   (network-level USD caps, no contract allowlists, no per-wallet limits); SCA wallets have a
   documented 1-in-flight-tx queue on listed chains (Arc unlisted); the policy engine is unbuilt.

## The design

### Target architecture (per agent)

| role | today | target | why |
|---|---|---|---|
| operator | Turnkey sub-org EOA (passkey-rooted, metered sigs) | **Circle DevC SCA** (`ARC-TESTNET`, Gas Station) | all surfaces msg.sender; gasless kills operator gas-seeding; no per-sig cost |
| pocket | EOA derived from ONE master seed (S3!) | **Circle DevC EOA** (per-agent, MPC-held) | Gateway demands EOA signatures; a DevC EOA signs plain ECDSA via Circle's `sign/typedData` API → Gateway-compatible, and the master seed dies |
| treasury / LegalManager | our Foundry contracts | **unchanged** | they are the policy layer — Circle's policy engine doesn't exist yet |
| platform/manager | one key, many hats (S4) | phase-split: `JOB_CLIENT`/`CUSTOMER` stop defaulting to the platform key now; manager/factory-owner EOA unchanged this tier (beacon/multisig later) | cheap, immediate risk reduction |

### The new funding flow — and everything it deletes

Target bridge (audit-corrected — THREE legs, not two): `treasury.fundOperator` → operator SCA
**`approve(GatewayWallet)`** → **`GatewayWallet.depositFor(usdc, pocketEOA, amount)`** — Gateway
PULLS via `transferFrom`, so the approve leg is real (verified in the SDK, which auto-fires it on
short allowance). Approve policy must be explicit: exact-amount per bridge (default; +1 op each
bridge) vs one-time infinite approve (standing approval from the float-holding SCA — reject) vs
atomic approve+deposit batch IF `executeBatch` is confirmed (Vivienne Q3). With the possible
1-tx SCA queue these are serialized UserOps — P2 measures the real latency.

`depositFor` (verified in the Gateway ABI) lets anyone credit any depositor — so the **pocket EOA
never holds on-chain funds and never sends a transaction at all**. It only signs off-chain: x402
payment authorizations and burn intents. Consequences, each currently a real subsystem:

- **gas seeder dies** (operator is gasless via Gas Station; pocket never transacts)
- **pocket sweeps die** (nothing ever rests on the pocket EOA)
- **standing exposure simplifies** to Gateway balance + SCA balance
- **the `USDC_TRANSFER_GAS` estimate-gas footgun class dies** for migrated legs (UserOps, not EOA sends)
- **`POCKET_MASTER_SEED` dies** → S3 **transformed, not closed**: keys leave our disk for Circle MPC (+ console controls, IP allowlist), but one platform credential pair (API key + entity secret) still commands the fleet's hot layer — see Secrets & recovery
- **Turnkey signing (and its per-signature bill) exits the hot path** → the meter we just built
  becomes the tool that proves spend went to zero
- the bridge's 2 Turnkey signatures become API calls with no marginal cost

Note the SDK reality (audit-corrected): `GatewayClient` is key-constructed, but `BatchEvmScheme`
already takes a SIGNER OBJECT — and our `signX402` seam already feeds it one (`asBatchEvmSigner`
wraps any `{address, signTypedData}`). So x402 signing needs only a Circle-API-backed signer
dropped into the EXISTING seam; only the Gateway deposit/burn-intent client gets replaced
(deposits move to the operator SCA via `depositFor`, burn intents to Circle `sign/typedData`).

### DECISION (2026-08-03, user): custody becomes a CHOICE, Turnkey stays

Turnkey is NOT retired. `wallet_provider` is a permanent product surface, not migration
scaffolding — the guardian chooses the agent's custody posture at creation, mirroring the
trust-policy dial:

- **`circle` ("Novi-managed") — the DEFAULT for new agents**: platform-controlled hot layer via
  Circle DevC (SCA operator + EOA pocket), gasless, no signature metering.
- **`turnkey` ("passkey-rooted") — the sovereignty option**: the guardian's own passkey stays
  root of the operator's key vault, above the platform. Deliberate opt-in; this path keeps the
  gas-seeder/sweep plumbing and the metered Turnkey signature costs (document both to the user).
- **Model B ("self-custody", later)** — Circle user-controlled wallets; the human holds keys
  outright. Roadmap tier three.

Custody clarification that shapes the split: the POCKET has NO custody implications — it is
already pure platform custody today (derived from OUR master seed), implemented dangerously.
So the pocket migrates to a per-agent Circle EOA for **every** agent, both providers, killing
S3 fleet-wide. Only the OPERATOR carries the custody choice.

Consequence accepted: the plumbing-deletion wins become per-agent rather than codebase-wide —
gasSeeder/sweeps stay in the tree for `turnkey`-path agents, and the funding-path test matrix
covers both providers.

### What this migration honestly does NOT do

- **S2 stays interim.** With Circle's policy engine unbuilt and Gas Station policies coarse, the
  smart account does not yet enforce our allowlist/caps on-chain. Policy remains: treasury
  contract (hard) + backend gates (S1/S5/software). Full S2 closure returns when Circle ships
  policy controls (we are offered as design partner) or if custom ERC-6900 modules become
  installable on their accounts (not documented today). *This corrects an earlier optimistic
  framing — the migration's security wins are S3 + S4 + blast-radius, not S2-full.*
- **Custody does not silently shift — it becomes explicit**: on the `circle` path the operator's
  hot-layer keys are platform-controlled (Circle entity secret) instead of guardian-passkey-rooted;
  the guardian keeps every on-chain power (guardian role, `setOperator`, clawback) +
  `root_passkey_id` (#67) + World personhood. Guardians who want key-level rootship above the
  platform choose the `turnkey` option; full self-custody = Model B, later.

### Migration mechanics for existing agents (the contracts already have the hook)

`AgentTreasury.setOperator(newOperator)` is `onlyGuardian` (verified) — operator rotation is a
first-class on-chain action. Per agent: (1) provision Circle SCA+EOA; (2) drain old float
(`cli:sweep`, proven live); (3) guardian signs `setOperator(newSCA)`; (4) re-bind ERC-8004 wallet
(sign `AgentWalletSet` with the OLD Turnkey EOA before rotation — sidesteps the unproven 1271
path — or prove 1271 first); (5) flip the entity's `walletProvider` column. New pocket address
means AgentBook re-registration for human-backing — cheap today (none of our agents' pockets are
registered; only the standalone proof-demo key is).

## UI & compatibility surface

**Compatibility guarantee (verify in the spec audit, don't just assert):** existing agents stay
on `turnkey` untouched; every external interface keeps its shape — MCP tools (`fund_pocket`,
`pay`, `run_job`, `onboard_agent`), REST, ENS, `/proof`, World flows, trust dials, treasury
contracts. A connected BYOA agent cannot tell which custody path it is on.

**UI work (small, mostly additive):**

1. **Custody selector** — new onboarding step, two cards mirroring the capability selector:
   "Novi-managed (recommended)" vs "Passkey-rooted (sovereign)", with the honest one-line
   trade-off on each (gasless/simple vs your-passkey-outranks-the-platform + metered-signature
   costs). MCP `onboard_agent` takes the platform default unless an optional param overrides.
2. **Passkey step REWORDED, not removed.** Current copy says the passkey provisions the Turnkey
   sub-org; on the `circle` path there is no sub-org, but the step stays on BOTH paths because
   the passkey is the guardian's recorded identity anchor (`root_passkey_id`, #67) for future
   same-guardian re-verification. New copy: "this registers you as the guardian", path-aware.
3. **Dashboard touches:** custody badge on the agent page ("Novi-managed" / "Passkey-rooted");
   standing-exposure labels path-aware (pocket line ~0 on `circle`; "operator (smart account)");
   `fund_pocket`'s tx-hash array has NO interface renderer (audit-verified — callers see raw MCP
   JSON only), so no UI change there; instead the TOOL CONTRACT must be decided: block until all
   legs confirm and return real hashes, or return Circle tx-ids in a tagged shape (see audit
   section — Circle's API is async: tx-id first, hash after confirmation).

**Visible-but-not-breakage differences to expect:** faster funding on `circle` (no gas-seed
waits); `turnkey_sigs` meter reads zero for `circle` agents. Both are the point.

**Known unknown that gates NEW `circle` agents only:** the ERC-8004 `setAgentWallet` bind with a
smart-account (1271) signature against the LIVE registry — proven in P2 before anything ships;
migrating agents sidestep it (bind with the old key pre-rotation).

## Phased plan

- **P1 — build (hermetic, 0 sigs, 0 spend):** `adapters/circle/` (DevC client, wallet-set/create,
  `signTypedData`/`signMessage`/`contractExecution` wrappers satisfying our existing signer +
  wallet seams); `entities.wallet_provider` column (`turnkey` | `circle`, default `turnkey` — the
  flag that makes every later step reversible); parallel composition path; the UI work above ships here behind the same flag. TDD +
  mutation, house method; spec audit before code (incl. the compatibility guarantee).
- **P2 — one testnet experiment** (resolves the cheap unknowns in one sitting): create 1 SCA + 1
  EOA on `ARC-TESTNET`; read `scaCore`; Gas Station sponsorship on Arc's USDC-native gas; 1271
  `isValidSignature` (incl. counterfactual); signature FORMAT from `sign/typedData` on the EOA
  (plain ECDSA? → Gateway `/v1/x402/verify` accepts?); SCA queue behavior; `depositFor` leg;
  live-registry `setAgentWallet` 1271 fork test.
- **P3 — first migrated agent end-to-end** on the flag (a fresh test agent, then one existing via
  the rotation runbook). Compare: bridge legs, signature spend (meter says 0 Turnkey), gas cost.
- **P4 — default `circle` for new onboarding; offer migration to existing agents (guardian's
  choice, not forced); retire ONLY the master-seed pocket path** (S3 dies fleet-wide once all
  pockets are per-agent Circle EOAs). Turnkey adapters STAY as the passkey-rooted option per the
  custody decision above. Onboarding UI/MCP gain the custody selector. S4 split
  (`JOB_CLIENT`/`CUSTOMER` keys) can ship independently and early — small PR.

## Open questions (owners assigned)

**For Vivienne:** (1) EntryPoint/bundler specifics on Arc + current default `scaCore` there;
(2) Gas Station on a USDC-native-gas chain — the paymaster simply pays USDC, 5% on that?
(3) can `contractExecution.callData` target the SCA's own `executeBatch` (atomic multicall)?
(4) SCA in-flight queue limit on Arc; (5) policy-engine design-partner follow-up (already
offered); (6) mainnet "ARC" activation timing. **For the P2 experiment:** counterfactual 1271,
sign/typedData signature format vs Gateway verify, live-registry 1271 fallback. **Design
decision pending:** EIP-7702 on Arc (would give the pocket EOA smart-account powers without
breaking Gateway — their docs explicitly bless 7702-upgraded EOAs) — ask both Vivienne and Arc.

## Sources

Gateway technical guide (EOA-only, delegates, 7702 note) · circle.com/wallets pricing ·
developers.circle.com: supported-blockchains, gas-station, policy-management, wallet-upgrades,
account-types, transaction-limits, api-rate-limits, DevC OpenAPI · circlefin/buidl-wallet-contracts
(`SingleOwnerMSCA`) · docs.arc.io AA providers · our node_modules (`@circle-fin/x402-batching`,
`@worldcoin/agentkit-core`) · our contracts (`AgentTreasury.sol`, `LegalManagerFactory.sol`) ·
full EOA-surface map (agent C report, reproduced as the P1 checklist in the PR that builds it).

## Full-audit corrections (2026-08-03 — 2 adversarial agents, load-bearing findings re-verified first-hand)

Fact-check: ~40 claims verified against contracts/SDKs/live docs; 3 corrected inline above
(BatchEvmScheme signer seam, three-leg bridge, repeatable bind). The following are REQUIRED
ADDITIONS — P1 is gated on them, in severity order:

### Critical

1. **Secrets & recovery (was entirely absent).** New `CIRCLE_ENTITY_SECRET`: added to env schema
   + `redact()` (env.ts's own header warns new secrets silently leak otherwise); all-or-nothing
   `circle` config block (mirror the turnkey block) so a half-config fails at boot; production
   fail-closed: `wallet_provider='circle'` rows present + no circle config → refuse boot. The
   Circle RECOVERY FILE is unrecoverable-by-design: offline custody, ≥2 locations, never on the
   VPS or in the repo. Entity-secret ciphertext is per-request — never cached or logged. Sandbox
   vs prod API keys separated; Circle console IP-allowlist on the prod key (part of the S3
   mitigation story).
2. **Migration quiescence gate (prevents stranded funds — verified race).** `runJob` resumes
   steps from the LIVE entity row while the on-chain job pins the provider at creation: rotating
   mid-job reverts subsequent steps AND releases earnings to the retired key after the drain.
   Runbook preconditions per agent: zero jobs in `pending|created|funded|submitted` (CLI gate);
   no funding in flight (persisted per-entity migration lock — the keyedMutex is in-process
   only); drain the old operator AFTER quiescence; keep the Turnkey sub-org until the old EOA
   reads 0 (the sweep tool signs as it). Code fix in P1: job steps resume from
   `rec.providerAddress`, or hard-refuse when it mismatches `entity.operator`.
3. **Circle async transaction model + bridge-saga persistence.** Circle returns a tx-id first,
   hash after confirmation; `shouldSkipFundOperator`'s balance heuristic is turnkey-only (no
   seed baseline + job earnings confound it on circle), and `retryOnStaleBalance`'s error-string
   classifier never matches Circle states. Circle path uses REAL idempotency: deterministic
   `idempotencyKey` per bridge leg + a persisted `bridge_legs` saga row (leg × circle-tx-id ×
   state) resumed by querying Circle — never by balance inference. Submit→poll with hard
   timeouts and terminal states (`FAILED/DENIED` handling).

### High

4. **Per-surface provider dispatch table.** The compatibility guarantee currently dies at two
   chokepoints that hard-require Turnkey fields (`requireVaultOperator`, `runJob`'s
   `turnkeySubOrgId` guard — verified). P1 enumerates, per surface × provider: fundPocket, job
   steps 2/3/4.5, standingExposure, sweeps, gas seeder. Precision fixes: POCKET seed/sweep die
   fleet-wide (both paths — the pocket never transacts); OPERATOR gas-seed stays turnkey-only;
   the JOB-EARNINGS sweep (operator→treasury) survives on BOTH paths — `complete` still pays
   the operator SCA. "Sweeps die" in the deletions list means pocket sweeps only.
5. **S5 meter integration.** New outflow path `gas_sponsorship` recorded from UserOp receipts
   (recorded-not-checked, like `gas_seed`) so Gas Station spend (cost+5%) stays visible to the
   platform brake; opsLog every Circle mutating call (parity with `turnkey_sig` forensics); a
   MAW counter (distinct active wallet-ids/month) because THAT is Circle's billing axis — not
   per-signature parity.
6. **Concurrency & rate limits.** Per-SCA (= per-entity) serialization must span funding AND
   job provider ops (today only funding takes the keyed lock); global Circle-API limiter with
   backoff (~5-10 rps shared per key); hard poll timeouts so the mutex chain cannot wedge; SCA
   queue-rejection behavior measured in P2 and promoted to a P3 go/no-go gate.
7. **Schema enumeration.** Beyond `wallet_provider`: `circle_wallet_set_id` (decide one-set vs
   per-agent), `circle_operator_wallet_id`, `circle_pocket_wallet_id`, `pocket_address`
   (backfilled for TURNKEY agents too — derive once, store, so read paths stop touching the
   master seed; killing the seed is unbuildable otherwise), `previous_operator` +
   `operator_rotated_at` (rotation forensics + late-residue sweeps; a retired EOA otherwise
   silently exits the S2 exposure reads).

### Medium

8. **Failure-modes table (to write in P1):** Circle API outage = circle-path hot layer fully
   frozen INCLUDING pay signing (turnkey path keeps working — the redundancy argument, made
   concrete); bridge legs resumable from the saga on recovery. Gas Station cap exhaustion: the
   daily USD cap is ACCOUNT-LEVEL PER NETWORK — one runaway agent de-gasleses the whole fleet
   at once (same outage class as the Turnkey quota event); `gas_sponsorship_denied` opsLog line
   + P2 captures the denial shape + Vivienne Q: can the testnet 50 USDC/day default be raised?
9. **Boot invariant is per-path:** `MAX_POCKET_FLOAT >= FUNDING_FLOAT + 2×GAS_SEED_TARGET`
   stays (max over paths) while any turnkey agent exists; relax to `>= FUNDING_FLOAT` only for
   provably circle-only deployments. `shouldSkipFundOperator` documented turnkey-only.
10. **Sovereignty copy scoped:** the passkey outranks the platform for the OPERATOR layer only;
    the payment float is platform-managed (Circle) on BOTH options, capped at the float ceiling.
    Card copy must say so — honest framing extends to the UI.

### Fact-check residue

- In-repo contradiction to fix in P1: `agentkitSigner.ts` comments claim the pocket "is the
  address registered in AgentBook" — aspirational; only the /proof demo key is registered.
  Correct the comment; verify the fleet claim with one `lookupHuman(pocket)` read per agent
  (the agentBookReader makes it a one-liner) before relying on it in the migration.
- `depositFor` "anyone can credit any depositor" is SDK-semantics-corroborated, not proven
  on-chain → add to the P2 experiment.
- DevC single-call API claim: cite the OpenAPI explicitly in P1; note `circle_6900_singleowner_v3`
  docs say the ACCOUNT can batch userOps even if the REST surface doesn't expose it (Vivienne Q3
  sharpened).
- Unverifiable-by-repo items held as assumptions with named owners: Vivienne's mainnet/policy
  statements (private correspondence), Turnkey plan terms (account), pocket non-registration
  (chain read, above).
## P2 EXECUTED — live-experiment results (2026-08-06)

All probes run against Arc testnet with the P1b wallet pair (SCA operator
`0x3e4f9269…9fb2`, EOA pocket `0x2cd3a60a…fc64`), zero Turnkey signatures.
Scripts: `scripts/tier0-p2-experiment.mts` (probes A–E, re-runnable per leg) and
`scripts/tier0-p2-fork-bind.mts` (probe F). Verdicts:

| # | Question | Verdict |
|---|---|---|
| A | Counterfactual 1271 / signing from an undeployed SCA | **NO — Circle refuses to produce ANY signature from an undeployed SCA** ("initiate a transaction to deploy the wallet"). The bind signature therefore requires a prior deploy → **P1 fix shipped**: `activateCircleSca` (one sponsored `approve(gateway, 0)`, deterministic idempotency seed `activate:<operatorWalletId>` (wallet-keyed — an entity-keyed seed replayed the ORPHANED pair's activation on re-provision; caught live in P3 leg 1)) runs inside `provisionCircle` before the record persists. |
| A′ | ERC-1271 on the DEPLOYED SCA | **VALID** — 65-byte MPC signature, `isValidSignature` returns the magic value. |
| B | Gas Station sponsorship on Arc (USDC-native gas) | **FULLY SPONSORED** — SCA native balance 0 before AND after a confirmed contractExecution; fee 0.009188 USDC billed to the platform (cost+5%); confirmed in 2.8s. First op also deploys the SCA. |
| C | The three-leg bridge on-chain | **PROVEN** — platform→SCA fund (0.6), exact `approve(gateway, 0.5)`, `GatewayWallet.depositFor(usdc, pocket, 0.5)`; pocket's on-chain `availableBalance` = 0.5. `depositFor`'s "anyone credits any depositor" now proven on-chain (fact-check residue closed). Circle faucet 403s under our restricted API key — platform-wallet funding used instead (mirrors the real leg 1). |
| D | Facilitator accepts the Circle-MPC pocket signature | **SETTLED** — full x402 flow through our own `buildPaywall` seller: 402 → `signX402` via `circleTypedDataSigner` (617ms) → facilitator verify+settle → 200. The migration's most load-bearing unknown, closed. |
| E | SCA in-flight queue | **NO WEDGE** — two concurrent contractExecutions both accepted and confirmed, 9.1s total. The documented 1-in-flight queue either doesn't apply on Arc or Circle queues internally; our per-entity keyed lock serializes anyway. |
| F | Live-registry `setAgentWallet` with the SCA's 1271 signature | **BIND ACCEPTED** — anvil fork of the LIVE registry code+state (chain-id 5042002), impersonated real owner of agentId 845775, REAL Circle MPC signature over the live EIP-712 domain: `setAgentWallet` succeeded and `getAgentWallet` returns the SCA. The "known unknown that gates NEW circle agents" is closed. Also learned: `register()` reverts for arbitrary EOAs on the live registry (agents mint through the platform flow only). |

**Consequences applied to P1:** `activateCircleSca` in provisioning (above);
`circleOperatorSigner`'s P2 caveat comment updated to the verdict. **Remaining
before flipping the default (P4):** P3 — onboard one real circle test agent through
the full stack (the activation + bind sequence end-to-end in production code paths),
run the funding bridge + a live pay + a job, then the default flip.

## P3 EXECUTED — first circle agent through the production stack (2026-08-07)

Run locally against the live chain (prod carries no Circle creds; P3 on the prod DB is
structurally forbidden — assertCircleCoverage would refuse the next boot). Driver:
`scripts/tier0-p3-live.mts` (production builders only — the same composition api/main wires).
Agent: `P3CircleAgent`, agentId **865083**, custody=circle.

| Leg | Result |
|---|---|
| 1 onboard | **funded** — provision → activate → createEntity → **the FIRST non-fork ERC-1271 bind on the LIVE registry** (`0xdf7d03b6…`; `getAgentWallet` == the SCA) → fundTreasury |
| 2 bridge | **all 3 legs confirmed** — fundOperator → exact approve → depositFor; pocket Gateway balance 0.25. A deliberate duplicate run then FAILED cleanly on-chain (`INSUFFICIENT_TOKEN`, saga-recorded) — the guards working. |
| 3 pay | **SETTLED** — 0.01 USDC to the PROD demo seller through the Vercel proxy, Circle-MPC pocket signature, facilitator transfer id `8f9bce9f…`. Buyer-side prod parity. |
| 4 job | **blocked on test funds only** — the platform test wallet is down to ~0.3 USDC and Arc's fee-reserve precheck (the PR-#33 estimateGas footgun, this time on the job client's contract writes) refuses before sending. Not circle-specific (client escrow is custody-agnostic, proven live in July); re-run after a faucet drip to the platform wallet. |

**Three production bugs P3 caught (all fixed + test-pinned):**
1. `withCircleOpsLog`/`withCircleRateLimit` used `{...api}` spreads — the real SDK client is a
   class instance, so every prototype method not explicitly rewrapped was silently DROPPED
   (`getTransaction` died on the first production-wrapped call; all prior probes used the raw
   client). Both wrappers are now delegation Proxies; regression tests use a prototype-based fake.
2. The activation idempotency seed was entity-keyed — a crash-retry that re-provisions mints a
   FRESH wallet under the SAME entity key, so Circle replayed the ORPHANED pair's activation and
   the new SCA stayed counterfactual (bind then failed "undeployed"). Seed is now wallet-keyed.
3. The SSRF-guard fetch timeout (10s) aborted a healthy prod payment — circle signing latency +
   synchronous facilitator settle + serverless cold start exceed it. Now 20s (the timeout bounds
   slow-loris, not settlement).
