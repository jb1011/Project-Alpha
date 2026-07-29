# The Graph × Novi Corpus — Complete Build Reference (ETHGlobal Lisbon 2026)

**Verified: 2026-07-24 (live probes against the gateways, npm, the Networks Registry, and this repo).**
Companion to `technical-blueprints.md` §1 — this is the offline, at-the-venue working document.
**Read §10 (Corrections) first if you built a mental model from the blueprint: the x402 leg changed materially.**

Pinned facts used throughout:

| Thing | Value |
|---|---|
| Factory | `LegalManagerFactory` `0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902`, **startBlock 46739165** |
| Network (Graph name) | `arc-testnet` (registry v0.7.107; caip2 `eip155:5042002`; alias `evm-5042002`) |
| Arc RPCs (registry) | `https://rpc.testnet.arc.network`, `https://arc-testnet.drpc.org` · explorer `https://testnet.arcscan.app` |
| Toolchain | `@graphprotocol/graph-cli@0.98.1` (pub. 2026-07-23) · `@graphprotocol/graph-ts@0.38.2` |
| Manifest | `specVersion: 1.3.0`, `apiVersion: 0.0.9` |
| Studio dev endpoint | `https://api.studio.thegraph.com/query/<USER_ID>/<SLUG>/version/latest` (3,000 q/day; ≤3 unpublished subgraphs/account) |
| x402 gateway (testnet) | `https://gateway.testnet.thegraph.com/api/x402/subgraphs/id/<ID>` — **NOT** `testnet.gateway.…` (that host does not resolve) |
| x402 gateway (mainnet) | `https://gateway.thegraph.com/api/x402/subgraphs/id/<ID>` |
| x402 protocol version | **v2** — challenge in `PAYMENT-REQUIRED` response header, pay via `PAYMENT-SIGNATURE` request header (NOT v1 `X-PAYMENT` + JSON body) |
| Base Sepolia | chainId **84532** (`eip155:84532`), RPC `https://sepolia.base.org` |
| Base Sepolia USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` — EIP-712 domain **name `"USDC"`, version `"2"`** (mainnet Base differs: `"USD Coin"`) |
| Observed testnet price | `amount: "42"` atomic (= $0.000042/query) on 2026-07-24 — mainnet is `"10000"` ($0.01). Re-read from the live challenge; don't hardcode |
| Circle faucet | `https://faucet.circle.com` — Base Sepolia USDC, **20 USDC / 2h / address / chain**, no login |
| Subgraph MCP | `https://subgraphs.mcp.thegraph.com/sse`, `Authorization: Bearer <Studio Gateway API key>` |

---

## 1. Build sequence checklist (skeleton first)

Total ≈ 14–20 h. Every step leaves a demoable state.

- [ ] **T+0:00 (≤1h) — Walking skeleton.** `graph init` factory-only (no templates), codegen, build, deploy `v0.0.1` to Studio, watch it sync on `arc-testnet`. *This de-risks the single biggest unknown (upgrade-indexer support for a 3-week-old network). If sync stalls >20 min → §5.4 self-hosted fallback, then continue identically.*
- [ ] **T+1:00 (2–3h) — Full schema + templates.** Drop in §3 manifest/schema, write factory handlers instantiating both templates, all Treasury + LegalBody handlers, `policyId` recompute, `try_` snapshot reads. Deploy `v0.0.2`. Verify counts vs `testnet.arcscan.app` (factory had ~45 logs pre-event).
- [ ] **T+3:30 (1h) — Timeseries + aggregations.** `SpendPoint` from both `Spent` and `OperatorFunded`; `SpendStats` hour/day. Deploy `v0.0.3`; validate with `interval: "hour", current: include`.
- [ ] **T+4:30 (2–3h) — Guardian watcher.** ~80-LOC cursor poll (§6.3 queries) every ~15 s → dashboard/webhook. Demo moment: guardian pause on stage → `Incident` appears → alert fires.
- [ ] **T+7:00 (3–5h) — Governed x402 pay-per-query.** New `signEip3009.ts` + `payments/graphQuery.ts` speaking **x402 v2** (§7 — do NOT reuse `buyWithX402` as-is). Fund payer from Circle faucet. One real paid query against the testnet gateway EARLY — it's the newest piece on their side.
- [ ] **T+11:00 (2–3h) — MCP tools.** `treasury_history` (read) + `query_subgraph_x402` (spend, policy-gated) in `mcp/server.ts` idiom (§8.1). Wire official Subgraph MCP into the demo Claude config (§8.2).
- [ ] **T+13:00 (2–3h) — SKILL + plugin packaging** (§8.3) and the 2–4 min demo video (hard requirement, all tracks).
- [ ] **Continuously:** small commits on `hackathon/ethglobal-lisbon-2026` (continuity-track judging requirement).

---

## 2. Project setup (commands, files)

### 2.1 Prereqs & ABIs

```bash
npm install -g @graphprotocol/graph-cli@0.98.1   # or use npx @graphprotocol/graph-cli@0.98.1
# ABIs from Foundry artifacts (back/ is the Foundry root):
cd ~/Project-Alpha/back && forge build
mkdir -p /tmp/abis
jq '.abi' out/LegalManagerFactory.sol/LegalManagerFactory.json > /tmp/abis/LegalManagerFactory.json
jq '.abi' out/AgentTreasury.sol/AgentTreasury.json           > /tmp/abis/AgentTreasury.json
jq '.abi' out/LegalManager.sol/LegalManager.json             > /tmp/abis/LegalManager.json
```

### 2.2 Init (CLI 0.98.1 — **no `--product` flag anymore**)

```bash
graph init novi-corpus-arc ./novi-corpus-arc \
  --protocol ethereum \
  --network arc-testnet \
  --from-contract 0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902 \
  --contract-name LegalManagerFactory \
  --abi /tmp/abis/LegalManagerFactory.json \
  --start-block 46739165 \
  --skip-git
```

Flags that exist in 0.98.1: `--protocol`, `--network`, `--from-contract`, `--contract-name`, `--abi`, `--start-block`, `--index-events`, `--skip-install`, `--skip-git`, `--from-example`, `--from-subgraph`, `-g/--node`, `-i/--ipfs`. (`--product subgraph-studio` from older guides is **gone** — Studio is the default deploy target via `graph auth` + `graph deploy`.)

### 2.3 Studio (do tonight)

1. `https://thegraph.com/studio/` → connect wallet → **Create a Subgraph** → name `novi-corpus-arc`, network Arc Testnet. The subgraph page shows the **slug**, your **USER_ID** (in the query URL), and the **Deploy Key**.
2. Also create a **Gateway API key** (Studio → API Keys) — needed for the Subgraph MCP (§8.2) and gateway free-plan queries (100k/mo).

### 2.4 Daily loop

```bash
graph codegen            # generated/ types from schema + ABIs — rerun after ANY schema/ABI/manifest change
graph build              # compiles mappings to WASM (catches type errors)
graph auth <DEPLOY_KEY>  # once per machine
graph deploy novi-corpus-arc            # prompts for version label — use v0.0.N, bump every deploy
# non-interactive: graph deploy novi-corpus-arc -l v0.0.4 --deploy-key <KEY>
```

Redeploy semantics: a new version label **archives the previous version** and triggers a **full resync** (fine here: startBlock is recent and event volume is tiny — sync is minutes). Reusing a label is refused; always bump. Account limit: 3 deployed unpublished subgraphs.

Project layout after init: `subgraph.yaml`, `schema.graphql`, `src/mapping.ts` (split into `src/factory.ts`, `src/treasury.ts`, `src/legalBody.ts`), `abis/`, `generated/` (never edit), `build/`, `networks.json`.

---

## 3. Manifest + schema (final drafts for OUR contracts)

### 3.1 `subgraph.yaml` — complete

Event strings below are transcribed from the actual declarations in `back/src/*.sol` (verified 2026-07-24). Rules: **no `indexed` keyword, no parameter names, no spaces**; parameterless events are written with empty parens (`Paused()`).

```yaml
specVersion: 1.3.0
description: Novi Corpus agent legal bodies — governance & custody observability on Arc testnet
repository: https://github.com/jb1011/Project-Alpha
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum/contract
    name: LegalManagerFactory
    network: arc-testnet
    source:
      address: '0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902'
      abi: LegalManagerFactory
      startBlock: 46739165
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      file: ./src/factory.ts
      entities: [AgentEntity, Treasury]
      abis:
        - name: LegalManagerFactory
          file: ./abis/LegalManagerFactory.json
        - name: AgentTreasury          # needed for the try_ snapshot reads in handleTreasuryCreated
          file: ./abis/AgentTreasury.json
      eventHandlers:
        - event: EntityCreated(indexed uint256,indexed address,indexed address)
          handler: handleEntityCreated
        - event: TreasuryCreated(indexed uint256,indexed address,indexed address)
          handler: handleTreasuryCreated
templates:
  - name: Treasury
    kind: ethereum/contract
    network: arc-testnet
    source:
      abi: AgentTreasury               # templates have NO address — bound per-instance via .create()
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      file: ./src/treasury.ts
      entities: [Treasury, SpendEvent, PolicyProposal, Incident, SpendPoint]
      abis:
        - name: AgentTreasury
          file: ./abis/AgentTreasury.json
      eventHandlers:
        - event: Spent(indexed address,uint256)
          handler: handleSpent
        - event: OperatorFunded(indexed address,uint256)
          handler: handleOperatorFunded
        - event: Paused()
          handler: handlePaused
        - event: Unpaused()
          handler: handleUnpaused
        - event: OperatorRotated(indexed address,indexed address)
          handler: handleOperatorRotated
        - event: AllowlistUpdated(indexed address,bool)
          handler: handleAllowlistUpdated
        - event: EmergencyWithdrawn(indexed address,uint256)
          handler: handleEmergencyWithdrawn
        - event: PolicyUpdateScheduled(indexed bytes32,uint256,uint256,bool,address,uint256)
          handler: handlePolicyUpdateScheduled
        - event: PolicyUpdateVetoed(indexed bytes32)
          handler: handlePolicyUpdateVetoed
        - event: VetoLifted(indexed bytes32)
          handler: handleVetoLifted
        - event: PolicyUpdated(uint256,uint256,bool,address)
          handler: handlePolicyUpdated
  - name: LegalBody
    kind: ethereum/contract
    network: arc-testnet
    source:
      abi: LegalManager
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.9
      language: wasm/assemblyscript
      file: ./src/legalBody.ts
      entities: [AgentEntity, Incident]
      abis:
        - name: LegalManager
          file: ./abis/LegalManager.json
      eventHandlers:
        - event: AmendmentScheduled(indexed bytes32,uint256)
          handler: handleAmendmentScheduled
        - event: AmendmentVetoed(indexed bytes32)
          handler: handleAmendmentVetoed
        - event: VetoLifted(indexed bytes32)
          handler: handleLmVetoLifted
        - event: OperatingAgreementUpdated(indexed bytes32)
          handler: handleOperatingAgreementUpdated
        - event: DissolutionInitiated(indexed address,uint256)
          handler: handleDissolutionInitiated
        - event: DissolutionVetoed(indexed address)
          handler: handleDissolutionVetoed
        - event: AssetsSwept(indexed address,indexed address,uint256)
          handler: handleAssetsSwept
        - event: NativeSwept(indexed address,uint256)
          handler: handleNativeSwept
        - event: Dissolved()
          handler: handleDissolved
```

Notes:
- `indexed` in the event string: graph-cli ≥0.30 accepts and normalizes both forms; **current codegen scaffolds emit `indexed`** as shown. If validation complains, drop the `indexed` keywords (`EntityCreated(uint256,address,address)`) — topic matching only uses types.
- `VetoLifted(bytes32)` exists on BOTH contracts. Fine — separate templates/ABIs — but the generated event classes share names; keep the two mapping files separate and never cross-import (§4.5 trap 10).
- No `features:` entry is needed for timeseries/aggregations (they gate on `specVersion >= 1.1.0`). Only add `features: [grafting]` / `[nonFatalErrors]` if you use those (§5.3). **Do not ship `nonFatalErrors`** — unsupported on the network per official docs.
- Timeline within `createEntity` tx: `EntityCreated` is emitted before `TreasuryCreated` (same tx, ascending logIndex), so the `AgentEntity` row always exists when `handleTreasuryCreated` runs.
- Templates index **from their creation block onward** — correct here (a treasury cannot emit before it exists).

### 3.2 `schema.graphql` — complete

```graphql
enum LegalStatus { ACTIVE, WINDING_DOWN, DISSOLVED }
enum ProposalStatus { SCHEDULED, VETOED, EXECUTED }
enum IncidentKind {
  PAUSED, UNPAUSED, EMERGENCY_WITHDRAWN, OPERATOR_ROTATED,
  POLICY_VETOED, VETO_LIFTED, AMENDMENT_VETOED,
  DISSOLUTION_INITIATED, DISSOLUTION_VETOED, DISSOLVED
}
enum SpendKind { SPEND, OPERATOR_FUNDED }

type AgentEntity @entity(immutable: false) {
  id: ID!                      # agentId (uint256 as string) — human-readable, so String id is fine
  agentId: BigInt!
  legalManager: Bytes!         # beacon proxy address
  manager: Bytes!
  treasury: Treasury           # linked by handleTreasuryCreated
  legalStatus: LegalStatus!
  createdAt: BigInt!           # block timestamp (seconds)
  createdAtBlock: BigInt!
  operatingAgreementHash: Bytes
  incidents: [Incident!]! @derivedFrom(field: "agentEntity")
}

type Treasury @entity(immutable: false) {
  id: Bytes!                   # treasury address
  agentEntity: AgentEntity!
  operator: Bytes!
  guardian: Bytes              # nullable: filled by try_ read
  payoutAddress: Bytes         # nullable: filled by try_ read
  cap: BigInt                  # nullable: TreasuryCreated doesn't carry it; try_ read at creation
  period: BigInt
  allowlistEnabled: Boolean
  paused: Boolean!
  totalSpent: BigInt!          # lifetime Spent + OperatorFunded (both consume cap on-chain)
  spendCount: Int!
  spends: [SpendEvent!]! @derivedFrom(field: "treasury")
  proposals: [PolicyProposal!]! @derivedFrom(field: "treasury")
}

type SpendEvent @entity(immutable: true) {
  id: Bytes!                   # tx.hash.concatI32(logIndex)
  treasury: Treasury!
  kind: SpendKind!
  to: Bytes!                   # payee (Spent) or operator (OperatorFunded)
  amount: BigInt!              # atomic USDC (6 decimals)
  timestamp: BigInt!
  block: BigInt!
  txHash: Bytes!
}

type PolicyProposal @entity(immutable: false) {
  id: Bytes!                   # policyId (bytes32) — see §4.3 recompute for PolicyUpdated
  treasury: Treasury!
  cap: BigInt!
  period: BigInt!
  allowlistOn: Boolean!
  payoutAddress: Bytes!
  executableAt: BigInt!
  status: ProposalStatus!
  scheduledAt: BigInt!
  resolvedAt: BigInt           # veto or execute time
}

type Incident @entity(immutable: true) {
  id: Bytes!                   # tx.hash.concatI32(logIndex)
  kind: IncidentKind!
  agentEntity: AgentEntity!
  treasury: Treasury           # null for LegalManager-side incidents
  actor: Bytes                 # e.g. dissolution initiator/vetoer
  amount: BigInt               # e.g. EmergencyWithdrawn amount
  detail: String
  timestamp: BigInt!
  block: BigInt!
  txHash: Bytes!
}

# ── timeseries (id + timestamp are AUTO-SET by graph-node; never set them) ──
type SpendPoint @entity(timeseries: true) {
  id: Int8!
  timestamp: Timestamp!        # microseconds; auto = block timestamp
  treasury: Bytes!             # dimension (grouping key)
  amount: BigInt!
}

type SpendStats @aggregation(intervals: ["hour", "day"], source: "SpendPoint") {
  id: Int8!
  timestamp: Timestamp!        # start of the bucket, auto-set
  treasury: Bytes!             # dimension
  total: BigInt! @aggregate(fn: "sum", arg: "amount")
  txCount: Int8! @aggregate(fn: "count")
  maxSingle: BigInt! @aggregate(fn: "max", arg: "amount")
  lifetimeTotal: BigInt! @aggregate(fn: "sum", arg: "amount", cumulative: true)
}
```

Schema rules that bite:
- `Bytes!` ids are faster than `String!`; use `Bytes` everywhere except `AgentEntity` (agentId is human-meaningful).
- Immutable entities are much faster and can still be modified **within their creation block** only.
- Timeseries entities are **always immutable**; `id: Int8!` + `timestamp: Timestamp!` are mandatory and **auto-populated** (values you set are silently overridden).
- Intervals: **only `"hour"` and `"day"` exist.**
- `@aggregate` args must be numeric (`Int`, `Int8`, `BigInt`, `BigDecimal`); `arg` may be an SQL-ish expression (`"greatest(amount, 0)"`); `count` needs no `arg`; `cumulative: true` = running total across all buckets.
- `@derivedFrom` fields are virtual (query-only, never set in mappings).

---

## 4. Mappings guide

### 4.1 `src/factory.ts`

```ts
import { DataSourceContext } from '@graphprotocol/graph-ts'
import { EntityCreated, TreasuryCreated } from '../generated/LegalManagerFactory/LegalManagerFactory'
import { AgentTreasury } from '../generated/LegalManagerFactory/AgentTreasury'
import { AgentEntity, Treasury } from '../generated/schema'
import { Treasury as TreasuryTemplate, LegalBody as LegalBodyTemplate } from '../generated/templates'

export function handleEntityCreated(event: EntityCreated): void {
  const e = new AgentEntity(event.params.agentId.toString())
  e.agentId = event.params.agentId
  e.legalManager = event.params.proxy
  e.manager = event.params.manager
  e.legalStatus = 'ACTIVE'
  e.createdAt = event.block.timestamp
  e.createdAtBlock = event.block.number
  e.save()

  const ctx = new DataSourceContext()
  ctx.setString('agentId', event.params.agentId.toString())
  LegalBodyTemplate.createWithContext(event.params.proxy, ctx)
}

export function handleTreasuryCreated(event: TreasuryCreated): void {
  const t = new Treasury(event.params.treasury)
  t.agentEntity = event.params.agentId.toString()
  t.operator = event.params.operator
  t.paused = false
  t.totalSpent = BigInt.zero()
  t.spendCount = 0

  // TreasuryCreated doesn't carry cap/period/allowlist/payout/guardian → snapshot via try_ calls.
  // NEVER load-bearing: leave null on revert (fresh-chain integrations can fail eth_call).
  const c = AgentTreasury.bind(event.params.treasury)
  const cap = c.try_cap();            if (!cap.reverted)  t.cap = cap.value
  const period = c.try_period();      if (!period.reverted) t.period = period.value
  const al = c.try_allowlistEnabled();if (!al.reverted)   t.allowlistEnabled = al.value
  const po = c.try_payoutAddress();   if (!po.reverted)   t.payoutAddress = po.value
  const gu = c.try_guardian();        if (!gu.reverted)   t.guardian = gu.value
  t.save()

  const ae = AgentEntity.load(event.params.agentId.toString())
  if (ae != null) { ae.treasury = event.params.treasury; ae.save() }  // EntityCreated precedes in-tx

  const ctx = new DataSourceContext()
  ctx.setString('agentId', event.params.agentId.toString())
  TreasuryTemplate.createWithContext(event.params.treasury, ctx)
}
```

### 4.2 `src/treasury.ts` — spends, incidents, timeseries

```ts
import { BigInt, Bytes, dataSource } from '@graphprotocol/graph-ts'
import { Spent, OperatorFunded, Paused, /* … */ } from '../generated/templates/Treasury/AgentTreasury'
import { Treasury, SpendEvent, Incident, SpendPoint } from '../generated/schema'

function eventId(event: ethereum.Event): Bytes {
  return event.transaction.hash.concatI32(event.logIndex.toI32())
}

export function handleSpent(event: Spent): void {
  recordSpend(event, 'SPEND', event.params.to, event.params.amount)
}
export function handleOperatorFunded(event: OperatorFunded): void {
  recordSpend(event, 'OPERATOR_FUNDED', event.params.operator, event.params.amount)
}

function recordSpend(event: ethereum.Event, kind: string, to: Address, amount: BigInt): void {
  const treasuryAddr = dataSource.address()          // the per-instance template address
  const s = new SpendEvent(eventId(event))
  s.treasury = treasuryAddr
  s.kind = kind
  s.to = to
  s.amount = amount
  s.timestamp = event.block.timestamp
  s.block = event.block.number
  s.txHash = event.transaction.hash
  s.save()

  const t = Treasury.load(treasuryAddr)
  if (t != null) {
    t.totalSpent = t.totalSpent.plus(amount)
    t.spendCount = t.spendCount + 1
    t.save()
  }

  // timeseries point — id/timestamp auto-set; pass 0 as a dummy id
  const p = new SpendPoint(0)
  p.treasury = treasuryAddr
  p.amount = amount
  p.save()
}

export function handlePaused(event: Paused): void {   // parameterless event: class still has block/tx
  const t = Treasury.load(dataSource.address())
  if (t != null) { t.paused = true; t.save() }
  mkIncident(event, 'PAUSED')                          // Incident with agentEntity from context
}
```

`agentId` for incidents comes from `dataSource.context().getString('agentId')`.

### 4.3 The `policyId` recompute (for `PolicyUpdated`, which lacks it)

On-chain: `keccak256(abi.encode(cap, period, allowlistOn, payoutAddress))` (`AgentTreasury._policyId`, all four types static). `ethereum.encode` of a tuple of static values is byte-identical to Solidity `abi.encode` of those arguments:

```ts
import { Bytes, ethereum, crypto } from '@graphprotocol/graph-ts'
import { PolicyUpdated } from '../generated/templates/Treasury/AgentTreasury'

export function handlePolicyUpdated(event: PolicyUpdated): void {
  const vals: Array<ethereum.Value> = [
    ethereum.Value.fromUnsignedBigInt(event.params.cap),        // uint256
    ethereum.Value.fromUnsignedBigInt(event.params.period),     // uint256
    ethereum.Value.fromBoolean(event.params.allowlistOn),       // bool
    ethereum.Value.fromAddress(event.params.payoutAddress),     // address
  ]
  const encoded = ethereum.encode(ethereum.Value.fromTuple(changetype<ethereum.Tuple>(vals)))!
  const policyId = Bytes.fromByteArray(crypto.keccak256(encoded))   // == on-chain _policyId

  const prop = PolicyProposal.load(policyId)
  if (prop != null) {
    prop.status = 'EXECUTED'
    prop.resolvedAt = event.block.timestamp
    prop.save()
  }
  // …also refresh Treasury.cap/period/allowlistEnabled/payoutAddress from event.params (no eth_call needed)
}
```

Caveat: this identity holds because all four members are **static** types. (For dynamic members, `abi.encode` adds head/tail offsets — docs note you'd prepend offsets manually. Not our case.)
Sanity-check once against a real pair: `PolicyUpdateScheduled.policyId` vs recompute from its own params.

`handlePolicyUpdateScheduled` creates `PolicyProposal` keyed by the **emitted** `policyId` with `status: 'SCHEDULED'`; `handlePolicyUpdateVetoed` flips to `VETOED`. `VetoLifted` (treasury side) → `Incident(kind: VETO_LIFTED)` (the proposal was deleted on-chain at veto; the manager must re-schedule).

### 4.4 `src/legalBody.ts`

Straightforward `Incident` writers + `AgentEntity.legalStatus` transitions:
`DissolutionInitiated` → `WINDING_DOWN`; `DissolutionVetoed` → back to `ACTIVE`; `Dissolved` → `DISSOLVED`; `OperatingAgreementUpdated` → set `operatingAgreementHash`. Note: **`AgentTreasury.Paused()` is the guardian spend-freeze; the legal-status gate lives on LegalManager `status()`** — there is no LegalManager event for treasury pause; keep the two concepts separate in the UI.

### 4.5 AssemblyScript trap list (first-timer classics)

Official "common issues" doc lists (1)–(2); the rest are AssemblyScript-language behavior you WILL hit:

1. **No closure scope inheritance** — variables declared outside a closure can't be used inside it. Write top-level named functions; pass everything as parameters.
2. **`private` is not enforced** on class fields.
3. **Nullability is compile-checked**: `Treasury.load(id)` returns `Treasury | null` — you must `if (t == null)` (or `!` assert) before member access. There is **no `undefined`**, no optional chaining.
4. **No try/catch.** Any assertion failure (null deref, out-of-bounds, failed `changetype`) aborts the handler → **the whole subgraph fails fatal** (Studio shows the error; sync stops). The only recoverable failure is `try_` contract calls.
5. **`==` vs `.equals()`**: graph-ts `BigInt`/`Bytes`/`Address` define operator overloads, so `==` works on those — but on plain reference types it's reference equality. Safest habit: `.equals()` for values, and compare addresses via `a.equals(b)` or normalized `a.toHexString()` (always lowercase — never compare against a checksummed literal).
6. **`Address.fromString()` aborts on bad input** (and is for 20-byte addresses only); `Bytes.fromHexString()` needs `0x` prefix.
7. **Integer literals are `i32`** — `amount * 1000000` overflows silently; keep everything `BigInt` (`BigInt.fromI32`, `.times`, `.plus`). No native `**`.
8. **No `JSON.parse`**, no `Math.random`, no `Date.now`, no dynamic imports — determinism is enforced. Use `event.block.timestamp` for time.
9. **Save what you mutate** — entity objects are plain rows; forgetting `.save()` loses the write. Arrays: pull field into a local, `push`, reassign, save (in-place mutation of `entity.field` doesn't persist).
10. **Generated-name collisions**: both templates have a `VetoLifted` event class — import each only in its own mapping file (`../generated/templates/Treasury/AgentTreasury` vs `../generated/templates/LegalBody/LegalManager`).
11. **`graph codegen` before `graph build`** after any schema/manifest/ABI change; stale `generated/` gives incomprehensible type errors.
12. **Logging**: `log.info('cap {} period {}', [cap.toString(), period.toString()])` — args are ALWAYS `Array<string>`; five levels (`debug/info/warning/error/critical`); `critical` fails the subgraph deliberately.

---

## 5. Deploy, monitor, fallback

### 5.1 Studio monitoring

- Subgraph page → **Logs** tab: mapping `log.*` output + indexing errors with block numbers. **Details** shows sync %, latest indexed block, failed status.
- From GraphQL (works on any endpoint):

```graphql
{ _meta { hasIndexingErrors deployment block { number timestamp } } }
```

- A fatally-failed deployment keeps serving up to the failure block, `hasIndexingErrors: true`. Fix mapping → deploy new version label → full resync (minutes, tiny history).

### 5.2 Query endpoints

| Surface | URL | Auth | Limits |
|---|---|---|---|
| Studio dev | `https://api.studio.thegraph.com/query/<USER_ID>/novi-corpus-arc/version/latest` (or `/v0.0.N`) | none | 3k q/day, testing only |
| Network gateway (after Publish) | `https://gateway.thegraph.com/api/subgraphs/id/<SUBGRAPH_ID>` w/ `Authorization: Bearer <API key>` | Studio API key | free plan 100k q/mo |
| x402 gateway | §7 | pay-per-query | — |
| Self-hosted | §5.4 | none | — |

Backend consumption: plain `fetch` POST `{"query": "...", "variables": {...}}` (graph-client is maintenance-mode; add no deps).

### 5.3 Grafting (iterate without resync)

```yaml
features: [grafting]
graft:
  base: QmTheDeploymentIdOfThePreviousVersion   # "Deployment ID" on the Studio page
  block: 46750000                               # copy state up to here, index forward from block+1
```

- Docs: "should only be used during development or during an emergency"; base must be **indexed to ≥ that block by the same indexer** and not pruned past it (`indexerHints: prune: auto` is default — fine at our scale).
- On Studio/arc-testnet the base sits on the Edge & Node upgrade indexer; grafting a Studio deployment is expected to work but **unverified on this 3-week-old network**. Honestly: with startBlock 46,739,165 and double-digit event counts, a full resync is minutes — **you probably never need grafting**. Keep it for the case where the chain head has moved millions of blocks by Sunday.

### 5.4 Self-hosted graph-node fallback (~1h, the insurance policy)

`docker-compose.yml` (upstream `graphprotocol/graph-node/docker/docker-compose.yml`, with the Arc RPC substituted — **the `ethereum:` network name MUST equal the manifest's `network:`**):

```yaml
version: '3'
services:
  graph-node:
    image: graphprotocol/graph-node
    ports: ['8000:8000', '8001:8001', '8020:8020', '8030:8030', '8040:8040']
    depends_on: [ipfs, postgres]
    extra_hosts: ['host.docker.internal:host-gateway']
    environment:
      postgres_host: postgres
      postgres_user: graph-node
      postgres_pass: let-me-in
      postgres_db: graph-node
      ipfs: 'ipfs:5001'
      ethereum: 'arc-testnet:https://rpc.testnet.arc.network'
      GRAPH_LOG: info
  ipfs:
    image: ipfs/kubo:v0.17.0
    ports: ['5001:5001']
    volumes: ['./data/ipfs:/data/ipfs:Z']
  postgres:
    image: postgres
    ports: ['5432:5432']
    command: ['postgres', '-cshared_preload_libraries=pg_stat_statements', '-cmax_connections=200']
    environment:
      POSTGRES_USER: graph-node
      POSTGRES_PASSWORD: let-me-in
      POSTGRES_DB: graph-node
      PGDATA: '/var/lib/postgresql/data'
      POSTGRES_INITDB_ARGS: '-E UTF8 --locale=C'
    volumes: ['./data/postgres:/var/lib/postgresql/data:Z']
```

```bash
docker compose up -d
graph create novi-corpus-arc --node http://localhost:8020
graph deploy novi-corpus-arc --node http://localhost:8020 --ipfs http://localhost:5001 -l v0.0.1
```

Query URLs change to:
- HTTP: `http://localhost:8000/subgraphs/name/novi-corpus-arc` · WS: `:8001` (same path)
- Indexing status API: `http://localhost:8030/graphql` — `{ indexingStatuses { subgraph synced health fatalError { message block { number } } chains { latestBlock { number } } } }`
- Metrics: `:8040`. Logs: `docker compose logs -f graph-node`.
Fallback RPC if `rpc.testnet.arc.network` rate-limits: `https://arc-testnet.drpc.org`.

---

## 6. Query layer (watcher + dashboard)

### 6.1 Dashboard basics

```graphql
{ agentEntities(orderBy: createdAt, orderDirection: desc) {
    id legalStatus createdAt
    treasury { id cap period paused allowlistEnabled totalSpent spendCount operator }
} }

{ spendEvents(first: 25, orderBy: timestamp, orderDirection: desc,
              where: { treasury: "0x<treasury>" }) {
    kind to amount timestamp txHash
} }
```

### 6.2 Aggregations (hour/day spend curves)

Top-level field = camelCase of the aggregation type → **`spendStats`**. `interval` is mandatory; `current: include` adds the in-progress bucket (computed on the fly — the demo-friendly option); **timestamps are µs-since-epoch strings**:

```graphql
{ spendStats(interval: "hour", current: include,
             where: { treasury: "0x<treasury>",
                      timestamp_gte: "1753290000000000" }) {   # µs !
    timestamp total txCount maxSingle lifetimeTotal
} }
```

JS: `usec = String(BigInt(Date.now()) * 1000n)`. Buckets align to the hour/day boundary; default order is timestamp+id descending.

### 6.3 Guardian watcher (~80 LOC poll, every ~15 s)

```graphql
query Watch($sinceTs: BigInt!, $now: BigInt!) {
  incidents(first: 50, orderBy: timestamp, orderDirection: asc,
            where: { timestamp_gt: $sinceTs }) {
    id kind agentEntity { id } treasury { id } actor amount timestamp txHash
  }
  policyProposals(where: { status: SCHEDULED, executableAt_lt: $now }) {
    id treasury { id } cap period allowlistOn payoutAddress executableAt   # executable NOW = act or veto
  }
  _meta { block { number } hasIndexingErrors }
}
```

Cursor = last seen `timestamp` (persist in SQLite). Alert classes: any `Incident` (pause/claw/veto/dissolution…) → red; `SCHEDULED` proposal past `executableAt` → amber "manager can execute now"; `hasIndexingErrors` → ops-amber. Demo: guardian hits pause in the dashboard → `Paused()` → Incident row within one poll.

---

## 7. Governed x402 pay-per-query (the differentiator) — **PROTOCOL IS v2**

### 7.1 Live-verified wire format (probed 2026-07-24 ~17:30 UTC)

`POST https://gateway.testnet.thegraph.com/api/x402/subgraphs/id/<ID>` with a GraphQL JSON body, no payment → **HTTP 402, EMPTY body**, challenge base64-JSON in the **`payment-required` response header**:

```json
{ "x402Version": 2,
  "error": "Payment-Signature header is required",
  "resource": { "url": "http://gateway.testnet.thegraph.com/subgraphs/id/<ID>" },
  "accepts": [ {
      "scheme": "exact", "network": "eip155:84532",
      "amount": "42",                                   ← atomic USDC; field is amount, NOT maxAmountRequired
      "payTo": "0x301672eEf23F0e5f165cfba26762702F20A74430",
      "maxTimeoutSeconds": 300,
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "extra": { "assetTransferMethod": "eip3009", "name": "USDC", "version": "2" } } ] }
```

Mainnet (`gateway.thegraph.com`, `eip155:8453`): `amount "10000"` ($0.01), `payTo 0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB`, asset `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, extra name **`"USD Coin"`** — take the EIP-712 domain from `extra`, never hardcode.

v2 HTTP transport (x402-foundation spec, `specs/transports-v2/http.md`):
- 402 ↦ `PAYMENT-REQUIRED` header (base64 `PaymentRequired`)
- client retry ↦ **`PAYMENT-SIGNATURE` request header** (base64 `PaymentPayload`)
- settlement ↦ `PAYMENT-RESPONSE` response header (base64 `{success, transaction, network, payer}`; 200 = success, 402 = payment failed, 400 = invalid payment)

`PaymentPayload` (client → gateway):

```json
{ "x402Version": 2,
  "resource": { "url": "<echo of resource.url>" },
  "accepted": { …full echo of the chosen accepts[i]… },
  "payload": {
    "signature": "0x…",                       ← EIP-712 sig
    "authorization": { "from": "0x<payer>", "to": "0x<payTo>", "value": "42",
                       "validAfter": "0", "validBefore": "<nowSec+maxTimeoutSeconds>",
                       "nonce": "0x<32 random bytes>" } } }
```

EIP-3009 typed data (what `signature` covers):

```ts
domain = { name: extra.name /*"USDC"*/, version: extra.version /*"2"*/,
           chainId: 84532, verifyingContract: accepts.asset }
types  = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' } ] }
primaryType = 'TransferWithAuthorization'
```

Gasless for the payer (gateway submits `transferWithAuthorization`); payer needs **USDC only, no ETH**.

### 7.2 Why `buyWithX402` cannot be pointed at this as-is

`payments/buyer.ts` implements x402 **v1**: parses `(await res.json()).accepts` (v2's body is empty → throws), reads `maxAmountRequired` (v2: `amount`), sends `X-PAYMENT` (v2: `PAYMENT-SIGNATURE`), and our `signX402.ts` signs the **Circle batching scheme against Arc's GatewayWallet** — a different EIP-712 payload entirely. **Keep both stacks; share only the policy chokepoint.**

### 7.3 Build plan (mirrors `entityPayment.ts`, ~150 LOC total)

New `backend/src/adapters/x402/signEip3009.ts` — viem `privateKeyToAccount(payerKey).signTypedData(...)` per §7.1 (dedicated Base-Sepolia payer key in `.env`, e.g. `GRAPH_PAYER_KEY`; viem `^2.21` already pinned).

New `backend/src/payments/graphQuery.ts` — v2 sibling of `buyWithX402` + `entityPayment.pay` composition, same order of operations: **idempotency claim → 402 probe → `evaluatePolicy` via `authorizePayment` (pending-ledger + per-tx cap + treasury paused/legal gates) → sign → retry with `PAYMENT-SIGNATURE` → parse `PAYMENT-RESPONSE` → `ledger.markSettled(tx)`**. Deny before signing when `BigInt(req.amount) > maxAmount`. The "signed-but-unconfirmed ⇒ cache, never release" discipline carries over verbatim.

```ts
const res1 = await fetchImpl(url, init)
if (res1.status !== 402) return res1
const hdr = res1.headers.get('payment-required')          // case-insensitive
if (!hdr) throw new Error('402 without PAYMENT-REQUIRED header (not x402 v2)')
const pr = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8'))
const req = (pr.accepts ?? []).find(a =>
  a.scheme === 'exact' && a.network === 'eip155:84532' &&
  a.asset.toLowerCase() === BASE_SEPOLIA_USDC && a.extra?.assetTransferMethod === 'eip3009')
// …policy gate → signEip3009 → payload per §7.1…
const res2 = await fetchImpl(url, { ...init, headers: { ...init.headers,
  'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payload)).toString('base64') } })
const settle = res2.headers.get('payment-response')       // base64 {success, transaction, network, payer}
```

**Stock-tooling alternative:** the gateway is spec-v2, and the repo already resolves `@x402/evm ^2.15.0` → 2.19.0; `@x402/fetch@2.19.0` + `@x402/evm` (x402-foundation, `npm i @x402/core @x402/evm @x402/fetch`) can drive the wire format. But our differentiator is the **policy chokepoint before signing**, which stock wrappers don't expose cleanly — hand-roll the ~60-line client; keep `@x402/fetch` as the debugging cross-check. Note the repo ALSO pins legacy v1 `x402@1.2.0`/`x402-fetch@1.2.0` (used by the Arc seller path) — different package names, no install conflict, but **never mix the two wire formats in one code path**.

### 7.4 Funding + economics

- `https://faucet.circle.com` → Base Sepolia → USDC → payer address. **20 USDC / 2 h / address**, no login. At the observed 42-atomic price that's ~476k queries — one drip covers the weekend (even at mainnet's $0.01 it's 2,000).
- Balance check: `cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "balanceOf(address)(uint256)" $PAYER --rpc-url https://sepolia.base.org`.

### 7.5 Which subgraph ID + fallback ladder

The x402 path takes a **subgraph/deployment id**, echoed unvalidated pre-payment (probe used `QmTest`) — **a paid query for OUR subgraph through the x402 gateway may require the subgraph to be PUBLISHED to the network** (Studio-only deployments are served by `api.studio.thegraph.com`, not the gateway). Test with our real deployment id immediately after first deploy; if unreachable: (a) publish (Studio → Publish, wallet tx — publishing to the network serves testnet subgraphs via the upgrade indexer), or (b) demo governed pay-per-query against any published subgraph id while OUR data is served free from Studio — the governance story (policy gate + treasury accountability + guardian clawback) is unchanged. Last resort: $0.05 of real USDC on Base mainnet. No refunds on empty results — send valid GraphQL.

---

## 8. MCP tools + SKILL packaging

### 8.1 Our two tools (in `buildMcpServer`, `mcp/server.ts` idiom)

Follow the optional-deps pattern (`payments?`/`pocketFunding?` — undefined ⇒ tool reports unavailable instead of boot failure). Add `graphQuery?: GraphQueryService` to `McpToolDeps`.

```ts
server.registerTool(
  'treasury_history',
  { title: 'Treasury history',
    description: 'On-chain spend history + hourly/daily aggregates + incidents for one of your entities, from the Novi Corpus subgraph.',
    inputSchema: { id: z.string(), interval: z.enum(['hour', 'day']).optional(),
                   sinceIso: z.string().optional() } },
  async ({ id, interval, sinceIso }) => {
    const rec = deps.repo.findByIdempotencyKey(id)
    if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
      return { content: [{ type: 'text', text: 'entity not found' }], isError: true }
    // free Studio endpoint; filter by rec.treasury; µs timestamps (Date.parse(sinceIso)*1000)
  },
)

server.registerTool(
  'query_subgraph_x402',
  { title: 'Paid subgraph query (governed)',
    description: 'Run a GraphQL query against any subgraph via The Graph x402 gateway, paying USDC per query THROUGH THIS ENTITY’S POLICY ENGINE (spend capability required; policy may deny).',
    inputSchema: { id: z.string(), subgraphId: z.string(), query: z.string(),
                   variables: z.record(z.unknown()).optional(),
                   maxUsdc: z.string().optional(), idempotencyKey: z.string().optional() } },
  async (args) => { /* capability 'spend' + entityInScope gate → graphQuery.pay(...) → return data + settlement tx + ledger id */ },
)
```

Judge-bait detail: on policy denial return the machine-readable reason (`policy-denied: over-cap` etc.) — the demo shows an agent being REFUSED a paid query by its own legal body's policy.

### 8.2 Official Subgraph MCP in the demo Claude

```bash
claude mcp add --transport sse graph-subgraphs https://subgraphs.mcp.thegraph.com/sse \
  --header "Authorization: Bearer <GATEWAY_API_KEY>"     # key: Studio → API Keys
```

Claude Desktop (`claude_desktop_config.json`, from official docs):

```json
{ "mcpServers": { "subgraph": {
      "command": "npx",
      "args": ["mcp-remote", "--header", "Authorization:${AUTH_HEADER}",
               "https://subgraphs.mcp.thegraph.com/sse"],
      "env": { "AUTH_HEADER": "Bearer GATEWAY_API_KEY" } } } }
```

Tools: schema retrieval (by deployment id `0x…`, subgraph id, or IPFS `Qm…`), query execution, discovery by keyword/contract, 30-day query volumes. If resources aren't auto-detected, add `graphql://subgraph` from the context menu. Debug: append `--verbose true`.

### 8.3 `skills/governed-graph-query/` (Agent Skills open standard)

```
skills/governed-graph-query/
├── SKILL.md
└── references/
    ├── schema.md            # our subgraph schema + entity semantics
    ├── query-cookbook.md    # §6 queries ready to paste
    └── x402-v2-flow.md      # §7 wire format
.claude-plugin/
└── manifest.json            # (repo root) plugin wrapper
```

`SKILL.md` frontmatter — only `description` is load-bearing (Claude's trigger); `name` optional (defaults to dir name); keep description+when_to_use under 1,536 chars:

```markdown
---
name: governed-graph-query
description: Query the Novi Corpus agent-legal-body subgraph (treasury spends, policy
  proposals, incidents, hourly/daily aggregates) and make POLICY-GOVERNED paid x402
  queries to The Graph gateway. Use when the user asks about an agent's on-chain
  spending behavior, guardian incidents, or wants to pay-per-query any subgraph
  through a governed treasury.
version: 1.0.0
---
# Governed Graph Query
Endpoints, entity model and rules … (body loads only when triggered; deep material in references/)
```

Plugin manifest (`.claude-plugin/manifest.json`, format proven by `graphprotocol/subgraphs-skills`):

```json
{ "name": "novi-corpus-graph", "version": "1.0.0",
  "description": "Governed observability + x402 pay-per-query tooling for agent legal bodies on The Graph",
  "author": "Novi Corpus",
  "skills": [ { "name": "governed-graph-query", "path": "skills/governed-graph-query",
                "description": "Policy-governed subgraph queries and x402 pay-per-query" } ],
  "keywords": ["thegraph", "subgraph", "x402", "erc-8004", "agent"] }
```

Install line for the README/video: `claude plugins add jb1011/Project-Alpha` (same shape the official skills repo documents). Optional frontmatter that exists if needed: `when_to_use`, `allowed-tools`, `disable-model-invocation`, `context: fork`.

---

## 9. Track rules (fetched verbatim 2026-07-24 from ethglobal.com/events/lisbon2026/prizes/the-graph)

**Track 1 — Best AI Tooling for The Graph, $5,000** (1st $2,500 / 2nd $1,500 / 3rd $1,000)
- "Submit reusable tooling or infrastructure (MCP server, SKILL, plugin, client config, or payment tooling), not a single end-user app."
- "The tooling must work against live blockchain data" from Graph providers or self-hosted indexers. "Purely mocked or static datasets do not qualify."
- Public repo, **2–4 minute demo video**, open-source with README/SKILL.md.
- Judging: **Usefulness to builders 30% · Reusability & completeness 25% · Effective Graph use 20% · Technical execution 15% · Innovation 10%.**

**Track 2 — Best AI Use Case of The Graph, $3,000** (1st $2,000 / 2nd $1,000)
- "Use The Graph as a load-bearing source of blockchain data" + "an AI/agent component that reasons over or acts on the data, not just prints a raw query result."
- "Consume live data from a Graph provider. Mocked or static data does not qualify."
- Public repo, 2–4 min video, brief description of Graph usage.
- Judging: **Effective Graph use 35% · Usefulness & impact 25% · Technical execution 20% · Innovation 10% · Demo clarity 10%.**

**Track 3 — Best Use of Composable or Standardized Graph Products, $3,000** (1st $2,000 / 2nd $1,000)
- "Either compose two or more of The Graph's products, or build meaningfully on a standardized schema." — "Simply querying one Subgraph with no composition or standardization does not qualify." Live-data rule as above.
- Judging: **Leverage of composability/standards 35% · Breadth 20% · Technical execution 20% · Usefulness 15% · Demo clarity 10%.**
- What formally counts as "products" is **not enumerated on the page** — our stack touches Subgraph + x402 gateway + official Subgraph MCP (arguably 3); **confirm at the booth** (pre-hackathon checklist item 7 stands).

**Track 4 — Best AI Use Case of The Graph (Continuity), $4,000** (1st $2,000 / 2nd $1,000 / 3rd $1,000)
- "Requirements identical to Track 2" (load-bearing Graph data, live data only, AI reasoning component, public repo, 2–4 min demo). This is the continuity pot confirmed in play for us.

Plus the general continuity rules (README.md): documented pre-existing vs hackathon work, incremental commit history, per-partner eligibility confirmed at the booth.

---

## 10. Corrections & deltas vs `technical-blueprints.md` §1

**⚠ 1. Testnet gateway hostname is WRONG in the blueprint.** `testnet.gateway.thegraph.com` **does not resolve** (NXDOMAIN, checked 2026-07-24). The live host is **`https://gateway.testnet.thegraph.com/api/x402/subgraphs/id/<ID>`** (mainnet unchanged).

**⚠ 2. The gateway speaks x402 v2, not v1 — `buyWithX402` cannot be "pointed at" it.** Challenge arrives in the `PAYMENT-REQUIRED` **header** with an **empty body** (v1 `first.json()` throws); amount field is `amount` (not `maxAmountRequired`); payment goes in `PAYMENT-SIGNATURE` (not `X-PAYMENT`); settlement in `PAYMENT-RESPONSE`; payload echoes the chosen `accepts` entry as `accepted`. Build the small v2 sibling (§7.3); the Arc-side Circle-batching `signX402` is a different EIP-712 payload and stays untouched. The `authorize`/policy/ledger chokepoint is reused unchanged — the governance story survives intact.

**3. Price:** testnet challenge quoted **42 atomic units ($0.000042)**, not $0.01 (that's mainnet's 10000). Blueprint's "1 USDC = 100 queries" underestimates by ~4 orders of magnitude on testnet; one 20-USDC faucet drip covers everything. Price is per-challenge data — read it, don't assume.

**4. EIP-712 domain of Base Sepolia USDC is `name: "USDC"`**, version `"2"` (Base MAINNET uses `"USD Coin"`). Both are handed to you in `extra` — consume it.

**5. `graph init --product subgraph-studio` no longer exists** in graph-cli 0.98.1 — drop the flag (§2.2 has the working invocation).

**6. Timeseries mechanics the blueprint didn't spell out:** `id`/`timestamp` are auto-set (don't set them), timestamps are **microseconds** everywhere (storage AND `timestamp_*` filters), aggregation query field is camelCase of the type (`spendStats`), `interval` is mandatory, and `current: include` returns the in-progress bucket — use it for the live demo. `cumulative: true` gives lifetime running totals for free.

**7. x402-gateway reachability of OUR subgraph is unproven:** a Studio-only deployment may not be queryable through the gateway (it serves network subgraphs; the pre-payment probe doesn't validate ids). Plan for Publish, or demo the paid leg against a published subgraph id (§7.5). This subsumes blueprint risk 3.

**8. Continuity confirmed:** The Graph's Track 4 (AI Use Case Continuity, $4k, 3 places) has requirements identical to Track 2 — we're eligible with this build as-is.

**New risks found:**
- If any leg of the x402 call is ever routed through the Vercel proxy, the proxy must pass `PAYMENT-REQUIRED`/`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE` headers (it stripped `X-PAYMENT` once before). Call the gateway **directly from the backend** to sidestep entirely.
- Legacy `x402@1.2.0`/`x402-fetch@1.2.0` (v1) and `@x402/*@2.19.0` (v2) now coexist in `package.json` — no install conflict, but never mix wire formats in one path.
- Subgraph MCP needs a Studio **Gateway API key** (free plan 100k q/mo) — create it tonight with the deploy key.
- graph-node fatal-error semantics (§4.5 trap 4): one aborting handler halts indexing for everyone — `try_` everything callable, null-check every `load()`.
