# Audit context: Novi Corpus smart contracts

For a security reviewer of the contracts in `back/src`. It says what is in scope, how to build and
test it, who holds which power, which behaviours are intended even though they may look risky
(and why), what the contracts depend on, and what has been reviewed before. Written 2026-10-21;
it describes the code at the commit it ships in.

Novi Corpus gives an AI agent a legal body: a company bound on chain to the agent's ERC-8004
identity, with a person verified with World ID (the **guardian**) who answers for it. The
contracts are deployed on **Arc testnet** (chain 5042002) and verified on
[explorer.testnet.arc.io](https://explorer.testnet.arc.io); they are not deployed on Arc mainnet
yet. The code of every contract in scope is identical to what is deployed.

---

## 1. Scope

| File | What it is | Deployed (Arc testnet) |
|---|---|---|
| `src/NoviController.sol` | The governed root of platform authority: a selector-allowlisted relay with an admin and an executor. | `0x9526E228E94A125843B2d010c1155780CBBAFb5c` |
| `src/LegalManagerFactory.sol` | Creates a full-product agent: registers its ERC-8004 identity, deploys its `LegalManager` (beacon proxy) and its `AgentTreasury`, and hands the identity to the controller. Deploys the beacon in its constructor. | `0x83D529E813Fe825b84250034A7A63f460A2ECA77` (beacon `0x432ed0814FcDDd03330add098093482128Ad2CfD`) |
| `src/LegalManager.sol` | One agent's legal body: the operating-agreement hash, timelocked amendments with a guardian veto, and dissolution. Used behind the beacon (full product) and as EIP-1167 clones (bring your own). | implementation `0xc2e89ABf562f2EB366e4dde42325af16EeF542a6` |
| `src/AgentTreasury.sol` | One agent's USDC vault: a rolling cap, an optional allowlist, guardian safety powers, timelocked policy changes. Immutable, one per agent. | one per agent, e.g. `0x11FCfd8d6DeB1BC820f7123989fD05EdA245a973` |
| `src/LegalBodyFactory.sol` | Creates a legal body for an identity the customer owns and keeps: an immutable clone of the `LegalManager`, with no treasury, authorised by the identity owner's EIP-712 signature. | `0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456` |
| `src/BreakGlassOneShot.sol` | A single-use helper for one admin action through the controller (grant, act and revoke in one transaction). | one instance (`0x17dfFf8963E18a731f7Ec1c74e49f9d427057Dd1`), used once on 2026-08-18 to accept the factory's ownership |
| `src/libraries/ControllerSelectors.sol` | The selectors the executor is granted, derived from the ABIs. | (library) |
| `src/interfaces/*.sol` | The ERC-8004 identity registry and ERC-8183 interfaces we call or describe. | (interfaces) |

**Out of scope:** `src/ens/*` (an ENS offchain resolver, deployed for names on Ethereum Sepolia, not
on Arc), `test/` and its mocks, the deploy scripts in `script/` (in scope only if you want to
review deployment), the off-chain backend, and the June 2026 legacy contracts (section 7).

All addresses, with owners and deployers: [`../addresses.arc-testnet.json`](../addresses.arc-testnet.json).

## 2. Build and test

Foundry project at `back/` (`foundry.toml`): Solidity 0.8.24, optimizer 200 runs, `via_ir = true`,
`evm_version = "paris"`. Dependencies (no submodules, `lib/` is gitignored), as CI installs them:

```bash
forge install foundry-rs/forge-std@v1.16.1 --no-git
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v5.1.0 --no-git
forge build && forge test
```

The main CI job pins Foundry v1.5.1 (the nightly fork-test workflow does not). The suite has unit, fuzz, invariant (`*Invariant.t.sol`), security and
fork tests; the fork tests run against the live Arc testnet registry
(`ARC_TESTNET_RPC_URL=https://rpc.testnet.arc.io FOUNDRY_EVM_VERSION=shanghai forge test --match-contract Fork`;
shanghai because the live registry uses PUSH0; without the RPC variable the fork tests skip instead
of failing). `slither.config.json` is the static-analysis configuration used before.

## 3. How the pieces fit

- **Full product:** the backend asks `NoviController` to relay `LegalManagerFactory.createEntity`.
  The factory registers the identity, deploys a `LegalManager` beacon proxy and an `AgentTreasury`,
  and transfers the identity NFT to the controller. The controller is the `manager` of
  both: immutable on the treasury; set once at initialisation, with no setter, on the legal body,
  which sits behind the beacon (item 16). The agent's wallet (the treasury's `operator`) spends within the treasury's rules.
- **Bring your own:** the identity stays with its owner. The owner signs a `LegalBodyLink`; the
  backend asks the controller to relay `LegalBodyFactory.createLegalBody`, which clones the
  `LegalManager` with the factory as its `manager`. The owner then writes a pointer to the body in
  their identity's metadata, and `linkedLegalBody(agentId)` is the one predicate anyone uses to
  read the binding.

## 4. Privileged roles

| Role | Held by (testnet) | Can | Limited by |
|---|---|---|---|
| Controller admin (`DEFAULT_ADMIN_ROLE`) | `0x48191Ac42649274C4b3cbeBd16a76B8178e6F6e0`, a single key on testnet; a hardware wallet is planned for mainnet | Grant and revoke any selector role or `WILDCARD_ROLE` (to anyone, including itself), set target pins, start an admin handover | OpenZeppelin `AccessControlDefaultAdminRules`: handing the admin role over takes 24 hours (`defaultAdminDelay`); grants, revocations and pins take effect at once, so the delay protects the handover, not against a compromised admin key; the controller cannot hold a role itself |
| Executor | `0xb43CbdA374e3CD2a3d67827683F81462BaCF703b`, the backend's key | Relay exactly its granted selectors: `AgentTreasury.schedulePolicyUpdate`, `executePolicyUpdate`; `LegalManager.scheduleOperatingAgreementUpdate`, `executeOperatingAgreementUpdate`; `LegalManagerFactory.createEntity`; the registry's `setAgentWallet`, `setMetadata`; `LegalBodyFactory.createLegalBody`, `scheduleOperatingAgreementUpdate` | The selector list; `setAgentWallet`/`setMetadata` are pinned to the identity registry and the two `LegalBodyFactory` selectors to that factory; it holds no role to upgrade, dissolve, sweep, withdraw or transfer ownership; nobody holds `WILDCARD_ROLE` |
| Owner of `LegalManagerFactory`, the beacon, `LegalBodyFactory` | `NoviController` | Factory: `createEntity`. Beacon: `upgradeTo` (every full-product `LegalManager` at once). `LegalBodyFactory`: `createLegalBody`, `scheduleOperatingAgreementUpdate`. The controller also holds every full-product identity NFT (it accepts any ERC-721); moving one needs a `transferFrom` or `approve` grant the executor does not hold | Only through the relay; `upgradeTo` and ownership transfers are not granted to the executor, so they need an admin ceremony; renouncing ownership is disabled on both factories; the beacon is plain `Ownable` (single-step transfer, renounce allowed, which would freeze the implementation for good) |
| Manager of a full-product `LegalManager` and `AgentTreasury` | `NoviController` (immutable on the treasury) | Schedule and execute policy and operating-agreement changes; initiate, cancel, sweep and finalize a dissolution | Every change waits out the delay and the guardian can veto it; the executor has no grant for the dissolution functions |
| Manager of a bring-your-own body | `LegalBodyFactory` | Schedule an amendment the body's guardian signed; execute the last scheduled one | The factory exposes no dissolution or sweep function, so the platform cannot dissolve or sweep a body |
| Guardian | A person verified with World ID, an EOA today, one per agent | Treasury: `pause`, `unpause`, `setOperator`, `setAllowlistEntry`, `emergencyWithdraw` (to the current `payoutAddress`, which the manager can change through a timelocked, vetoable policy update, item 6), `vetoPolicyUpdate`, `liftVeto`. Legal body: veto (`cancelOperatingAgreementUpdate`) and `liftVeto`; initiate, cancel, sweep and finalize a dissolution; sign amendments of a bring-your-own body | Roles must differ (constructor checks); the guardian cannot spend; the guardian cannot be changed on either contract (immutable on the treasury, no setter on the legal body): there is no guardian recovery path, by design |
| Operator | The agent's wallet, run by the platform: a Circle smart account or a Turnkey EOA | `spend`, within the rolling cap and, if on, the allowlist; `fundOperator` (to itself), within the same cap, allowlist not applied | Stops when paused or when the `LegalManager` is not Active; the guardian can rotate it |
| Identity owner (bring your own) | The customer | Sign the `LegalBodyLink`; write and change the pointer in their own identity's metadata | A link names one identity, one guardian, one agreement hash and a deadline at most 24 hours ahead |

## 5. Intended behaviours that may look risky

1. **The controller relays to any target for unpinned selectors.** Our own contracts (treasuries,
   legal managers, the factory) are reached with one grant per selector, with no per-agent setup.
   Only the selectors that land on a third-party, upgradeable contract (the identity registry) or on
   `LegalBodyFactory` are pinned to one target, so a selector added there later cannot be relayed
   elsewhere.
2. **The controller has no timelock and no pause.** The timelocks and the veto live in each
   `AgentTreasury` and `LegalManager`, and the guardian pauses its own treasury; a second layer in
   the controller would only delay the guardian's own safety actions.
3. **The controller is not upgradeable.** It is small enough to replace. Because a treasury's
   `manager` is immutable, replacing it means a new factory and new agents; that is the same
   immutability the vaults rely on.
4. **The admin can grant itself any role, including `WILDCARD_ROLE`.** That is the break-glass path.
   `BreakGlassOneShot` makes one such action atomic: the grant is used and renounced in the same
   transaction, and `execute` reports a failed action instead of reverting, because a revert would
   undo the renounce and leave the grant standing.
5. **`bytes4(0)` and the wildcard value are refused as selectors everywhere** (grants, pins, relay):
   `bytes32(bytes4(0))` is `DEFAULT_ADMIN_ROLE`, so a zero selector would let the admin relay without
   a grant.
6. **The manager can propose a new `payoutAddress`** (the sink `emergencyWithdraw` sends to). It
   takes effect only after `policyDelay`, the guardian can veto it, `executePolicyUpdate` refuses a
   payout equal to the current operator, and only the guardian can trigger `emergencyWithdraw`.
7. **A raised cap applies to the current spending window at once** (the window is not reset). Spend
   within any window never exceeds the cap in effect; this is stated at `executePolicyUpdate`.
8. **Either role of a `LegalManager` can initiate a dissolution, and after the window either can
   sweep to an address it chooses.** The role that did not initiate can cancel at any time before
   the body is finalized, and nothing moves until the window (the amendment delay) has passed; sweeping stays open after dissolution so late assets are never
   stranded and a lost key does not lock them. In the full product the executor holds no grant for
   these functions; in bring-your-own bodies the factory exposes none of them, so only the guardian
   can initiate, sweep and finalize, and a dissolution the guardian starts cannot be cancelled by
   anyone.
9. **A guardian veto is permanent for that hash or policy tuple** until the guardian lifts it, so a
   vetoed change cannot simply be scheduled again.
10. **`LegalBodyFactory` is the manager of every body it creates, on purpose.** Its only power over a
    body is to schedule an amendment the guardian signed, and to execute the last scheduled one;
    `executeOperatingAgreementUpdate` is callable by anyone, because the body only executes a hash
    that was scheduled, not vetoed, and has waited out its delay. A new schedule supersedes any
    older pending one, so an old approval cannot be replayed to roll the agreement back.
11. **`LegalBodyFactory` probes the implementation in its constructor** (`initialize` must revert
    with `InvalidInitialization`, `manager()` must be empty), so it can only ever clone the locked
    `LegalManager` logic, never a proxy that someone could upgrade.
12. **Signatures are checked ECDSA first, then ERC-1271**, the same rule the ERC-8004 registry uses.
    A plain ECDSA signature from an address that has code is accepted, which is what an EIP-7702
    delegated account looks like; nobody holds a key for an ordinary contract address.
13. **Bodies are deterministic clones salted by the link digest**, so one signature creates at most
    one body; an identity may have several bodies over time, and the live one is the one its
    owner's pointer names. The identity owner is read from the registry at creation, so a link
    signed before an identity transfer stops working after it.
14. **`linkedLegalBody` decodes the pointer by hand and never reverts on anything the identity owner
    can write**, returning `address(0)` instead. It still relies on the registry returning
    well-formed data.
15. **`LegalManagerFactory.createEntity` requires `manager == owner`** (the controller), so a stolen
    owner key could not mint a body whose manager sits outside the controller's roles; it transfers
    the identity NFT last, after all state is written.
16. **The beacon owner can upgrade every full-product `LegalManager` at once.** The owner is the
    controller, and `upgradeTo` is not granted to the executor, so an upgrade needs an admin
    ceremony. Bring-your-own bodies are clones and cannot be upgraded at all.
17. **Native value.** The controller has no `receive` and is not payable, so it never holds native
    USDC. A `LegalManager` can receive native value and sweeps it with `sweepNative`.

Two code comments predate later changes: `AgentTreasury` and `LegalManagerFactory` describe the
operator as a "non-custodial" Turnkey EOA. Today the operator may also be a Circle smart account,
and the wallet is run by the platform; we do not describe the product as non-custodial. The
comments are left as they are so the source keeps matching the deployed, verified code.

## 6. External dependencies

- **ERC-8004 IdentityRegistry** on Arc (`0x8004A818BFB912233c491871b3d84c89A494BD9e`), a third-party
  **upgradeable** proxy. In-scope contracts call `register`, `transferFrom`, `ownerOf` and
  `getMetadata`; the controller relays `setAgentWallet` and `setMetadata` to it. We assume it
  behaves as the ERC-8004 standard describes; its upgradeability is why those two selectors are
  pinned.
- **USDC on Arc** (`0x3600000000000000000000000000000000000000`): the ERC-20 interface of Arc's
  native gas token, 6 decimals as a token (native amounts use 18). `AgentTreasury` uses it through
  `SafeERC20`.
- **OpenZeppelin Contracts 5.1.0** and **Contracts Upgradeable 5.1.0**:
  `AccessControlDefaultAdminRules`, `Ownable2Step`, `UpgradeableBeacon`, `BeaconProxy`, `Clones`,
  `EIP712`, `ECDSA`, `SignatureChecker`, `SafeERC20`, `ReentrancyGuard`, `ReentrancyGuardUpgradeable`,
  `Initializable`.
- **ERC-8183:** the job interface in `src/interfaces/` describes Arc's job contract for the backend;
  no in-scope contract calls it.
- **The backend** holds the executor key and assembles every relayed call; signatures it relays
  (the identity owner's link, the guardian's amendment, a wallet's `setAgentWallet`) are produced by
  those parties, not by the backend.

## 7. Legacy generation (out of scope)

The first factory (`0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902`, June 2026) and its beacon
(`0xCbE36eC37673805a185a6883f9597613ABB41c97`) predate the controller. The platform no longer
creates agents with them, but they still govern the 35 test agents created before 2026-08-17:

- the legacy factory's owner is the June key `0xb43CbdA374e3CD2a3d67827683F81462BaCF703b` (the
  controller's executor today), and that key holds directly, with no selector limit, the manager
  role of those agents' legal managers and treasuries, and their identity NFTs;
- the legacy beacon is owned directly by the admin key `0x48191Ac42649274C4b3cbeBd16a76B8178e6F6e0`,
  which can upgrade those 35 proxies without the relay.

Both beacons point at the same `LegalManager` implementation. The legacy factory's code is the
earlier version of `LegalManagerFactory` (before the `manager == owner` rule) in this repository's
git history, not in `src/`.

## 8. Prior reviews

- [`docs/audit/2026-06-09-internal-security-audit.md`](./audit/2026-06-09-internal-security-audit.md):
  internal review of `AgentTreasury`, `LegalManager`, `LegalManagerFactory` and the interfaces, with
  remediation.
- [`docs/audit/2026-06-30-contracts-security-pass.md`](./audit/2026-06-30-contracts-security-pass.md):
  static analysis with Slither and Aderyn, and triage.
- Later internal reviews (team-run, AI-assisted), not published: an adversarial review of
  `NoviController` and the factory changes (August 2026; its findings M1 to M5 are named in the code
  comments where they were addressed), and reviews of `LegalBodyFactory` including fork tests
  against the live registry (late September 2026). The deployed code is the version that followed
  those reviews.
- **No external audit has been done.**
