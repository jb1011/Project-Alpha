# NoviController — one governed root for platform authority

> **Status:** DESIGN, ADVERSARIALLY AUDITED 2026-08-13 (fact-check + attack passes; all findings
> folded in — see §8). Verdict: **sound to build**; 🔴 mainnet deploy blocked on hardware/multisig
> admin (§8). Pending user review, then build.
> **Why:** S4 / mainnet gate. Every agent's `manager` (treasury + legal), the factory owner, and the
> beacon owner are today one hot EOA in a server `.env`. `AgentTreasury.manager` is `immutable` —
> unrotatable, so one leaked key = permanent manager capture of every vault. Must ship before the
> mainnet deploy (2026-09-16) or mainnet agents inherit the flaw forever.
> **Decisions locked (user, 2026-08-13):** scope = EVERYTHING (per-agent manager + factory owner +
> beacon owner) routes to one controller; admin = MetaMask `0x4819…F6e0` now, designed for a
> two-step handoff to a hardware wallet.

## 0. TL;DR

One small contract, `NoviController`, becomes the immutable `manager` of every new agent's
`AgentTreasury` + `LegalManager`, the owner of the (new) factory and its beacon, and the holder of
each agent's ERC-8004 identity NFT. It is a **selector-allowlisted relay** (Euler v2
`GovernorAccessControl` pattern, built from audited OZ primitives): a cold **admin** manages roles
and can rotate everything; a hot **executor** (the backend key) may call exactly the selectors it is
granted, on any vault, with zero per-agent configuration. **No delays in the controller** — the
vaults already timelock + guardian-veto internally (MetaMorpho-validated shape). Agent contracts
never change again; all future governance (hardware wallet, multisig, timelock) is a role change in
the controller.

## 1. What "manager" is today (verified against source)

| Layer | Power | Bounded by |
|---|---|---|
| AgentTreasury | `schedulePolicyUpdate` / `executePolicyUpdate` | vault timelock ≥1h + guardian veto + `payout != operator` recheck |
| LegalManager | schedule/execute OA amendment | vault timelock + permanent guardian veto |
| LegalManager | `initiateDissolution` → `sweep`/`sweepNative` to ANY address after window; also `cancelDissolution` (veto a guardian-initiated wind-down) and `finalizeDissolution` | dissolution cancel = whichever role did NOT initiate, any time pre-finalize |
| Identity | **owns the agent's ERC-8004 NFT** (factory `transferFrom`s it to manager); authorized caller for `setAgentWallet` AND `setMetadata` (the ENS reverse-bind, called in EVERY onboarding — arcAdapter.ts:201, onboarding.ts:467); can also `approve`/`setApprovalForAll` (alternate path to move/bind) | **nothing — unbounded**. Live-registry behavior: any NFT transfer CLEARS the agentWallet binding (fork-test verified) |
| Factory | `createEntity` (Ownable2Step, renounce disabled) | — |
| Beacon | `upgradeTo` — rewrite every agent's LegalManager logic | moved to `0x4819…F6e0` (2026-08-11) |

Design consequence: the vaults' dangerous powers are ALREADY bounded on-chain. The fix moves
**mutability** out of the agent contracts — it must not add mutable roles to the vaults.

## 2. Decision record — substrate

**Chosen: minimal custom selector-relay** (~100 lines composed from OZ 5.1.0 `AccessControl` +
`AccessControlDefaultAdminRules`), modeled on Euler v2's `GovernorAccessControl` (audited across
the OZ/Spearbit-Cantina/Certora/ToB campaign; same factory-deployed-immutable-role shape).

Rejected:
- **OZ AccessManager**: permission config is per-(target, selector) and `setTargetFunctionRole` is
  hard-wired to ADMIN — every factory-deployed vault is a new target, so every onboarding needs a
  cold-admin ceremony (or a hot admin key, defeating the design). Its delay/guardian machinery
  duplicates what the vaults already do. Documented as the LATER upgrade path if the permission
  matrix ever grows (controller admin can be handed to it without touching vaults).
- **TimelockController as manager**: single global `minDelay`, no per-op zero-delay → double-delays
  the already-timelocked vault ops; at `minDelay=0` it's a worse relay (no selector granularity).
  Correct future use: as a role-holder ON the controller (Euler's exact usage).

## 3. Contract design — `back/src/NoviController.sol`

```text
contract NoviController is AccessControlDefaultAdminRules, IERC721Receiver
```

### Roles
- `DEFAULT_ADMIN_ROLE` — via `AccessControlDefaultAdminRules(uint48 initialDelay, address admin_)`
  (verified in vendored OZ 5.1.0): **two-step + time-delayed admin handover built in**
  (`beginDefaultAdminTransfer` / wait / `acceptDefaultAdminTransfer`, cancellable during the
  window), single-admin enforced. DEFAULT_ADMIN is the role-admin of every selector role (that is
  the OZ semantic — it grants/revokes everything); what the extension guarantees is that no OTHER
  role can manage DEFAULT_ADMIN itself. `initialDelay` = **24h**; ⚠ the admin can lower it later
  via `changeDefaultAdminDelay` (honoring the old delay before the change bites, increases capped
  at 5 days) — monitor that call. ⚠ On admin transfer, ONLY the admin role moves: any selector/
  WILDCARD roles the outgoing admin held SURVIVE — the handoff ceremony must include an explicit
  revoke-sweep of the outgoing key's other roles (asserted in tests). Launch admin = MetaMask
  `0x4819…F6e0`; Ledger handoff later = the same two-step ceremony, no redeploy.
- **Selector roles** — `role id = bytes32(bytes4 selector)` (Euler pattern, coarse by design:
  a granted selector works on EVERY target; that IS the platform-operator semantics). Granted to
  the backend **executor** key at deploy:
  - `AgentTreasury.schedulePolicyUpdate` / `executePolicyUpdate`
  - `LegalManager.scheduleOperatingAgreementUpdate` / `executeOperatingAgreementUpdate`
  - `LegalManagerFactory.createEntity`
  - `IdentityRegistry.setAgentWallet` (the bind; controller = NFT owner, relay makes
    `msg.sender == ownerOf(agentId)` hold — fork-test against live registry state, P2-style.
    ⚠ the EIP-712 `AgentWalletSet` struct includes `owner`: the operator wallet must sign over
    **owner = CONTROLLER** — flows from `rec.manager` in onboarding.ts:387, fork-test asserts it)
  - `IdentityRegistry.setMetadata` (**fact-check catch**: the ENS reverse-bind inside EVERY
    onboarding is owner-gated — omitting this selector breaks all onboarding at cutover)
- `WILDCARD_ROLE = bytes32(uint256(1))` (any-selector relay) — **granted to NO ONE at deploy**.
  (Deliberate deviation from Euler, whose WILD_CARD = bytes32(uint256 max); ours is equally
  collision-free vs left-aligned selector roles and DEFAULT_ADMIN_ROLE = 0x00.) Break-glass:
  admin `grantRole`s it (or a specific selector) to a chosen key for rare/emergency ops, then
  revokes. Standing surface stays minimal. Deliberately NOT granted selectors:
  `initiateDissolution`, `cancelDissolution`, `sweep`, `sweepNative`, `finalizeDissolution`,
  registry `transferFrom`/`safeTransferFrom`/**`approve`/`setApprovalForAll`** (identity moves —
  including by approval; note a transfer also CLEARS the wallet binding on the live registry),
  `UpgradeableBeacon.upgradeTo` **and `renounceOwnership`** (the beacon is single-step Ownable;
  renounce would freeze fleet upgrades forever), factory `transferOwnership`/`acceptOwnership`.

### Relay (the whole runtime surface)
Euler encoding — calldata = target-function calldata with the **target address appended as the
final 20 bytes**:

```text
fallback() external {
    if (msg.data.length < 24) revert MsgDataInvalid();          // 4 selector + 20 target min
    address target = address(bytes20(msg.data[msg.data.length - 20:]));
    bytes4 selector = bytes4(msg.data[0:4]);
    if (!hasRole(bytes32(selector), msg.sender) && !hasRole(WILDCARD_ROLE, msg.sender))
        revert NotAuthorized(selector, msg.sender);
    emit Relayed(msg.sender, target, selector);
    (bool ok, bytes memory ret) = target.call(msg.data[0:msg.data.length - 20]);
    if (!ok) _bubble(ret);                                       // bubble the vault's revert verbatim
    _return(ret);
}
```

Rules baked in:
- Guard tightened vs Euler (deliberate deviation — Euler's actual guard is `<= 20`): we require
  `>= 24` bytes so a bare selector + target is the minimum well-formed relay.
- **No ETH/value forwarding** (`fallback` non-payable; no `receive`) — the controller never holds
  or moves native value. Arc-native dust sent to it is refused.
- **Return data and reverts bubble verbatim** (assembly copy — Euler's implementation) so vault
  custom errors surface intact to the backend SDK.
- Controller's OWN function selectors (AccessControl surface, `onERC721Received`) are dispatched
  before `fallback` by the ABI — the relay only sees selectors that match nothing local. Test
  asserts the local surface is disjoint from every vault/factory/registry selector we relay.
- The controller **never holds ERC-20 approvals and never has selector roles granted to itself**
  (the Socket/LiFi arbitrary-call lesson). Its only asset custody is the identity NFTs, whose
  transfer selectors are ungranted (admin break-glass only).
- `onERC721Received` returns the selector (accepts custody; factory currently uses
  `transferFrom`, but `_safeMint`-style flows must not brick).

### Contract hardenings (adversarial-audit findings, all in-scope for v1)
- **M1 — zero-selector guard**: `bytes32(bytes4(0x00000000)) == DEFAULT_ADMIN_ROLE`, so a
  zero-selector relay would pass `hasRole` for the admin without any grant. The fallback reverts
  on `selector == 0x00000000` (and on `bytes32(selector) == WILDCARD_ROLE`), keeping the selector
  namespace partitioned from the admin/wildcard namespace. Test: zero selector reverts EVEN for
  the admin.
- **M2 — no self-roles, enforced on-chain**: `_grantRole` reverts when `account == address(this)`.
  Without this, a granted selector relayed WITH the controller as target would bounce through the
  fallback with `msg.sender == controller` — total escalation. Two lines converts "operational
  care" into a guarantee; with it, relay reentrancy is fully neutralized.
- **M4 — factory pins the manager**: `createEntity` requires `manager == owner()` (the
  controller). Closes the rogue-agent vector where a stolen executor mints a legal body with
  `manager = attacker` in Novi's registry namespace. Zero flexibility cost — bespoke platform
  factory.
- **M5 — registry selectors are target-bound**: the ERC-8004 registry is a THIRD-PARTY UPGRADEABLE
  proxy — its future ABI could grow a colliding selector we can't audit today. The controller
  supports an optional admin-set `boundTarget[selector]`; when set, the relay requires
  `target == boundTarget`. Set for `setAgentWallet` + `setMetadata` → the registry address.
  Vault/factory selectors stay unbound (coarse-by-design across our own audited contracts).
- **Non-contract targets revert**: `target.code.length == 0` reverts (a bare `call` to an EOA
  returns success — silently-successful decoy relays would pollute the event log).
- Break-glass ceremonies use a **one-shot helper pattern**: admin grants to a purpose-built
  single-use contract that executes and self-revokes in ONE transaction (grant+act+revoke atomic),
  never leaving a dangerous selector live across blocks under a single-EOA admin.

### What it does NOT do
No delays (vaults have them). No pause (guardian pause lives in each vault; controller compromise
is handled by admin revoking roles). No upgradeability (it's ~100 lines; if it's wrong, deploy a
new one — WAIT: per-agent `manager` is immutable → a controller replacement requires new factory +
new agents. Accepted and documented: this is the same immutability bet the vaults make; the
mitigation is smallness + audit + the fact that admin can always re-key every ROLE inside it).

## 4. Factory + wiring changes

`LegalManagerFactory` (new deployment, constructor unchanged in shape):
- `createEntity(manager=CONTROLLER, …)` — backend passes the controller as manager for every agent,
  and the factory ENFORCES `manager == owner()` (M4 — supersedes this section's earlier "keep it
  generic" stance; the audit showed a stolen executor could otherwise mint a rogue-managed body in
  Novi's registry namespace). Side effect, deliberate: the identity NFT's destination in step 5 is
  thereby pinned to the owner (the controller).
- Step 5 hands the identity NFT to `manager` = controller (unchanged code path, new destination).
- **Factory owner** = controller (deploy with deployer key, `transferOwnership(controller)`,
  `acceptOwnership` relayed via admin-granted selector, one ceremony).
  → `createEntity` is then callable ONLY through the controller → executor role. The backend's
  create call becomes `controller.relay(createEntity… + factory-address-suffix)`.
- **Beacon owner** (`BEACON_OWNER` constructor param) = controller from day one. `upgradeTo` is
  ungranted → fleet upgrades = admin break-glass ceremony (grant → upgrade → revoke). The 24h
  admin-transfer delay + explicit grant event = the human-visible upgrade gate S4 wanted.
- Old testnet factory/beacon/agents: untouched, legacy (13 agents keep the old manager EOA;
  accepted — testnet). Old beacon stays owned by `0x4819…F6e0`.

## 5. Backend changes (vitest scope)

- **Decouple the manager ADDRESS from the signing KEY** (fact-check catch: there is no
  `PLATFORM_MANAGER_ADDRESS` env — `platformManagerAddress` is DERIVED from the signing key at
  `api/main.ts:99` (`managerAccount(cfg).address`), flowing to both onboard doors, and
  `onboard.ts:45-47` documents the very invariant this design breaks: manager "must equal the
  wallet the saga signs txs as"). New config: `CONTROLLER_ADDRESS`. `roles.manager` = controller;
  the signing key becomes the EXECUTOR identity (unchanged key at cutover — rotation becomes
  possible, not mandatory). Boot invariant: refuse `CONTROLLER_ADDRESS` unset when
  `FACTORY_ADDRESS` is the new factory. Side effect to update: `ensGateway.ts:92` resolves the
  ENS apex to `platformManagerAddress` — decide whether the apex should now resolve to the
  controller or to a nominated address (explicit config, not an accident).
- `FACTORY_ADDRESS` → new factory.
- Arc adapter: every manager-signed **role-gated** call wraps calldata Euler-style
  (`encodeFunctionData(...) + target20`) via one helper (`relayThrough(controller, target, data)`)
  + tests. Complete relay list (fact-checked against every manager-signed call site):
  `createEntity` (arcAdapter.ts:103), `setAgentWallet` (:180), **`setMetadata` (:201 — the ENS
  reverse-bind in the onboarding saga)**, `schedulePolicyUpdate` (:225), `executePolicyUpdate`
  (:242). NOT relayed (not role-gated, signer-direct): `fundTreasury` (plain USDC transfer,
  :256) and the liveRunner native gas seeds — unchanged.
- `eth_call` simulation before send (bubbled vault errors make relay mistakes debuggable).
- Registry event parsing: `EntityCreated`'s `manager` topic now = controller (indexers/tests that
  asserted the EOA update accordingly).

### Implementation adjustments (review round, 2026-08-17)

Five corrections from the 8-angle review of the built branch. All are implemented; they change
§5's shape, not its intent.

1. **Relay routing is PER AGENT, keyed on the entity's PERSISTED `manager` — not a per-deployment
   flag.** The draft above reads as "controller set ⇒ relay everything", which would have broken
   all 11 legacy prod agents the moment `CONTROLLER_ADDRESS` was set: `AgentTreasury.manager` is
   immutable and the identity NFT has one owner, so an agent minted before the cutover obeys the
   old EOA forever and a relayed call reaches it as `msg.sender == controller` → `NotManager`.
   `sendManagerCall` therefore takes `agentManager` and relays only when a controller is configured
   AND (no agent is implied — deployment-level calls like `createEntity`, where the doors force the
   controller — OR the agent's manager IS the controller). Every call site threads the manager it
   persisted: `rec.manager` in the saga, the entity's `manager` column in the policy routes.
   `confirmCreateEntity`'s "manager must be the controller" assertion is gated on the SAME
   predicate, so a create broadcast before the flip and resumed after it confirms against the
   manager it was actually minted with instead of throwing forever.
2. **Boot-time ON-CHAIN verification** (`adapters/arc/bootVerify.ts`, called from `api/main.ts`;
   `loadConfig` stays pure). Controller mode reads `factory.owner()`, `hasRole` for each of the
   seven granted selectors (derived from the generated ABIs with `toFunctionSelector`, never
   hardcoded), and `boundTarget` for the two registry pins; any mismatch refuses the boot, naming
   the failing check and the env vars involved. Legacy mode with a factory configured asserts
   `factory.owner() == the signing key`, which catches "flipped the factory, forgot
   `CONTROLLER_ADDRESS`" and the pending-`acceptOwnership` window. A read failure is reported as
   "could not verify", never as a misconfiguration.
3. **Break-glass is spend-and-revoke EVEN ON FAILURE.** `BreakGlassOneShot.execute` used to bubble
   the target's revert — which rolled back `used` AND both `renounceRole`s, leaving the dangerous
   grant standing on the controller after a ceremony the admin believed was over. It now captures
   `(ok, data)`, renounces both roles unconditionally, emits
   `BreakGlassExecuted(target, selector, ok, data)` and returns `(ok, data)`. **The admin must read
   `ok`** — a failed action needs a fresh grant and a fresh helper. The `hasRole` pre-checks and
   `RoleNotGranted` are gone: the controller's fallback is the canonical authority, and OZ's
   `renounceRole` is a no-op for a role the account does not hold.
4. **M5 pins are CONSTRUCTOR arguments** (`pinSelectors`/`pinTargets`), not a post-deploy ceremony.
   The pins exist from block 0, closing the window in which a registry selector was relayable at
   any target, and removing a ceremony step that could be forgotten. `setBoundTarget` remains for
   later changes (a registry migration, an unpin). §7's "MANUAL STEP (b)" is therefore deleted;
   `acceptOwnership` remains the one ceremony.
5. **ENS apex must be named in controller mode.** `CONTROLLER_ADDRESS` + `ENS_GATEWAY_SIGNER_KEY`
   now require `ENS_APEX_RESOLVES_TO` (boot invariant, in `loadConfig` — pure env logic). Without
   it the apex resolves to the platform signing key, which is exactly the address this design makes
   ROTATABLE: rotating the executor would silently repoint `novicorpus.eth` at the new key.

Also folded in: the relay preflight is `eth_estimateGas` (one round-trip that both proves the call
and produces the gas limit, instead of an `eth_call` followed by viem estimating — a double
execution); only a genuine revert is re-dressed with a decoded reason, so an RPC timeout is
rethrown untouched rather than reading as "reverted in simulation"; and the decode covers the
controller's own errors (`NotAuthorized`, `TargetNotBound`, …) so relay-level failures name
themselves. The standalone onboarding server (`src/onboarding/server.ts`) — the third door — now
forces `roles.manager` like the REST and MCP doors; it was passing caller-supplied specs verbatim,
which M4 rejects in controller mode.

## 6. Test plan

**New Foundry suite `test/NoviController.t.sol`:**
- role gating: ungranted selector reverts `NotAuthorized`; granted selector relays; WILDCARD works
  and is revocable; admin has NO implicit relay rights (must self-grant — asserted!)
- encoding: `msg.data.length < 24` reverts; trailing-target extraction exact; return data + custom
  errors bubble byte-identical (assert against `AgentTreasury.CapExceeded` etc.)
- admin lifecycle: `beginDefaultAdminTransfer` → 24h wait enforced → accept; cancel during window;
  **only DEFAULT_ADMIN moves on transfer — the outgoing admin's other roles SURVIVE** (asserted),
  and the handoff ceremony's revoke-sweep is tested; `changeDefaultAdminDelay` monitoring hook
- selector-disjointness, correctly stated (audit M3): local selectors ∩ **RELAYED** selectors
  (granted + break-glass sets) = ∅, and each intended-relay selector routes to `fallback`.
  (Full-ABI disjointness is FALSE and must not be asserted: `owner()` and `supportsInterface`
  exist on both the controller and relayed targets — harmless, they only shadow un-relayed reads)
- M1 zero-selector reverts even for admin; M2 `grantRole(…, address(this))` reverts; M4 factory
  rejects `manager != owner()`; M5 bound-target enforcement for registry selectors; non-contract
  target reverts; one-shot break-glass helper executes grant+act+revoke atomically
- non-payable: value transfer reverts; NFT receive works
- **integration**: full agent lifecycle where manager = controller — create via relay, bind, policy
  schedule→veto and schedule→execute, dissolution break-glass (grant → initiate → guardian cancels)
- **fork test (anvil, live Arc state)**: `setAgentWallet` bind relayed by the controller-as-NFT-owner
  against the LIVE registry (the P2-style known-unknown, proven before any deploy) — asserting the
  EIP-712 signature is produced over **owner = controller**, and absorbing walletSet.ts's standing
  caveat that the AgentWalletSet typehash is inferred ("confirm before mainnet" — this test is that
  confirmation). Also fork-test `setMetadata` through the relay (the every-onboarding path).
  Note: the fork suite requires shanghai EVM (`_supportsPush0` guard in IdentityRegistryFork.t.sol).
- fuzz: relay with random calldata/targets never touches storage except events; role checks hold

**Updated:** factory tests (manager=contract paths, event topics), any test asserting the manager
EOA. **Gas snapshot**: relay overhead budget ≤ 10k vs direct call (forge snapshot in CI). User hot
paths (`spend`, `fundOperator`, guardian ops) are UNTOUCHED — zero user-facing gas change.

## 7. Deploy & migration sequence (testnet rehearsal = mainnet script)

1. Deploy `NoviController(initialDelay=24h, admin=0x4819…F6e0)`; grant executor selectors to the
   backend key (one tx batch).
2. Deploy new `LegalManagerFactory(implementation, registry, beaconOwner=CONTROLLER)` with the
   deployer key; `transferOwnership(controller)`; admin break-glass `acceptOwnership` through the
   controller; verify `owner() == controller` and old deployer's `createEntity` reverts.
3. Backend env flip: `FACTORY_ADDRESS`, `PLATFORM_MANAGER_ADDRESS=controller` → restart → onboard
   one probe agent end-to-end (create relay → bind relay → policy relay → job) from the box.
4. Wizard onboarding test (the user-surface path — the lesson of fix #87).
5. Mainnet: same script, fresh addresses; admin = Ledger if arrived (else MetaMask, documented
   interim + scheduled handoff ceremony).

## 8. Threat model — corrected by the adversarial audit (2026-08-13)

**The 24h admin delay is NOT an admin-compromise mitigation.** `grantRole` is instant: a hijacked
admin grants WILDCARD and relays `upgradeTo` in one block — fleet-wide logic replacement. The
delay only gates admin-role HANDOVER. Consequences, stated plainly:

- 🔴 **MAINNET BLOCKER: the admin must be hardware-backed (Ledger, ideally inside a Safe
  multisig) AT LAUNCH.** A hot MetaMask admin re-opens the exact S4 gate this design closes —
  "the same hot key, relocated." Testnet on MetaMask: fine. Mainnet: no.
  Admin key LOSS is equally terminal (no one can rotate roles; manager is immutable → frozen
  governance forever) — multisig also answers that. Never renounce; monitor
  `beginDefaultAdminTransfer(address(0))` and `changeDefaultAdminDelay`.
- **Custody-domain analysis (verified in code):** guardian = the USER's wallet (onboard.ts forces
  `guardian = tenantId`) — independently custodied ✓. Executor + operator (Circle entity secret)
  BOTH live in the backend domain — deliberately, that's the managed product. So a full backend
  breach = schedule a malicious policy (≥1h vault timelock) THEN spend/withdraw up to it. **The
  guardian veto is the designed line of defense, and it only works if the guardian NOTICES** →
  guardian-facing notification on `PolicyUpdateScheduled` is a launch requirement, not a
  nice-to-have (see monitoring). `setAgentWallet` is the one granted op with no timelock/veto —
  same power the manager EOA has today (executor is still strictly weaker overall), covered by
  monitoring below.

**Monitoring spec (deploy prerequisite, not follow-up):** alert on `RoleGranted`/`RoleRevoked`
(page if a dangerous-selector/WILDCARD grant outlives N minutes); `DefaultAdminTransfer`
begin/cancel/accept; beacon `Upgraded`; factory `OwnershipTransferred`; registry `AgentWalletSet`
where the new wallet ≠ the recorded operator; treasury `PolicyUpdateScheduled` on ANY payout
change (notify the guardian directly). Key off TARGET events, not the controller's `Relayed`.

## 9. Adversarial-review checklist (original, for reference — findings folded above)

The audit agents should attack at minimum: relay reentrancy (controller as manager re-entering a
vault mid-relay), selector-collision between controller surface and relayed targets, the
`RolesMustDiffer` interactions with a contract manager, NFT custody edge cases (what can move the
identity, who can bind after a break-glass), executor-key blast radius vs today (must be strictly
smaller), admin-key blast radius (rotation window semantics of DefaultAdminRules), the
double-immutability bet (controller bug ⇒ new factory), Euler-encoding malleability (can a granted
selector be smuggled onto an unintended TARGET class — yes by design across vaults; attack the
registry/factory cross-target cases specifically), and event/monitoring sufficiency.
