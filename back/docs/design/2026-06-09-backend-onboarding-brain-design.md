# Design: Backend "Brain" — Onboarding Milestone

> **Status:** Approved (2026-06-09). Companion to `docs/SPEC.md`, `docs/PROJECT_RECAP.md`, and the
> design docs under `docs/design/`. **Next step:** implementation plan (writing-plans skill).
> **Supersedes** nothing; this is the first backend spec. Phase-2 of the project ("the brain").

## 1. Purpose & scope

Build the **orchestration backend** ("the brain") that turns a described AI agent into a fully-wired
legal body on Arc testnet, in one flow. This spec covers **only the onboarding milestone**:

> *given a structured agent description → generate its operating agreement, register its ERC-8004
> identity, deploy + wire its `LegalManager` and immutable `AgentTreasury` via the Factory, bind its
> wallet, and persist the record — driven by a CLI, fully tested.*

**Explicitly deferred** (separate specs/milestones): the **MCP server**, the **web wizard**, and the
**ERC-8183 proof-of-life** demo agent. The backend is built so those are thin faces over this core.

### Locked decisions (from brainstorming 2026-06-09)
- **Framework-agnostic TypeScript core + CLI first** (no web framework coupling yet).
- **Onboarding brain is the first milestone**; proof-of-life deferred.
- **Account/key setup is an explicit step 0** (Turnkey + Circle + Arc testnet deploy).
- v1 persistence: **SQLite + local file store**, behind swappable interfaces (Postgres/Blob later).

## 2. Architecture overview

Monorepo. Foundry stays at root (`src/`, `test/`, `foundry.toml`). The backend is a new
**`backend/`** TypeScript package (own `package.json`, `tsconfig`, ESM, Node 24, **vitest**, **biome**).
Contract **ABIs are read from Foundry `out/`** and consumed type-safely via **viem + abitype** (no
hand-copied ABIs that drift). The brain is a set of small, independently-testable units wired by one
orchestration saga and exposed through a CLI.

```
backend/
  src/
    config/        # typed env loader + validation; never logs secrets
    secrets/       # secrets interface (.env impl for demo; secrets-manager later)
    adapters/
      arc/         # viem client: factory.createEntity, ERC-8004 register/setMetadata/setAgentWallet, reads
      turnkey/     # per-agent sub-org (registrant=root), operator enclave key, delegated access, EIP-712 sign
      circle/      # wallet-agnostic rails (Gateway/x402/USDC) — THIN in v1 (iface + treasury funding)
    oa/            # operating-agreement template -> rendered doc + canonical oaHash (deterministic)
    policy/        # law->code translator (pure): legal terms -> { TreasuryConfig, amendmentDelay, roles }
    workflow/      # onboarding saga: idempotent, resumable sequencing of the steps
    persistence/   # EntityRepository (SQLite) + document store (local files); swappable interfaces
    cli/           # create-entity, get-entity, bind-wallet, fund-treasury, list-entities
  test/            # vitest unit + anvil integration + env-gated live smoke
```

**Module contracts (what / how-used / depends-on):**

| Module | What it does | Depends on |
|---|---|---|
| `config` | Loads + validates typed env (RPC, keys, addresses); fail-fast at startup | — |
| `secrets` | Returns secrets via an interface; `.env` impl for demo | `config` |
| `adapters/arc` | All Arc reads/writes via viem; holds the **platform manager/deployer signer** | `config`, ABIs from `out/` |
| `adapters/turnkey` | Provisions registrant sub-org + operator key; signs EIP-712 | `secrets` |
| `adapters/circle` | Rails interface; v1 = treasury USDC funding only | `secrets` |
| `oa/generator` | Template → OA document + canonical `oaHash` (deterministic) | — |
| `policy/translator` | **Pure** law→code mapping; heavily unit-tested | — |
| `workflow/onboarding` | Saga sequencing all steps with idempotency + resume | all adapters, oa, policy, persistence |
| `persistence` | Entity records + doc store behind interfaces | SQLite, local FS |
| `cli` | Operator commands over the workflow | `workflow`, `config` |

## 3. Onboarding data flow (the saga)

Input: `agent.json` (structured legal terms + roles). `create-entity --config agent.json`:

1. **translate** — `policy/translator`: legal terms → `TreasuryConfig` (`usdc, payoutAddress, cap, period, allowlistEnabled`) + `amendmentDelay` + roles `{manager, guardian, operator}`.
2. **generate** — `oa/generator`: render OA doc + compute `oaHash`; store doc → `metadataURI`.
3. **turnkey** — ensure registrant sub-org (human registrant = root ⇒ non-custodial) + create the **operator enclave key**; returns `operator` address.
4. **arc** — `factory.createEntity(manager, guardian, operator, amendmentDelay, metadataURI, ein*, formationDate*, oaHash, treasuryConfig)` → `(agentId, proxy, treasury)` in **one atomic tx**. `ein`/`formationDate` are **stubbed + clearly labeled** (demo).
5. **bind** — manager-signed EIP-712 `setAgentWallet(agentId, agentWallet, deadline, sig)` (manager owns the NFT after step 4). For v1, `agentWallet = operator` (the agent's Turnkey key) — the canonical wallet that acts as the agent on-chain.
6. **persist** — write the full record (agentId, proxy, treasury, roles, oaHash, doc path, tx hashes, status).
7. *(optional v1)* **fund** — top up the treasury with testnet USDC.

`createEntity` is atomic on-chain, so partial-failure recovery is purely **off-chain bookkeeping**.
Each step records its result keyed by a client-side **idempotency key** per agent, so a re-run resumes
rather than double-creating (a fresh `createEntity` would mint a new agentId — must never happen twice
for the same logical agent).

## 4. Persistence, secrets, config

- **SQLite** schema: `entities` (one row per agent; status enum `translating → created → bound → funded`),
  `documents` (`oaHash`, path), `events` (audit trail of tx hashes + step outcomes).
- **Document store**: local filesystem for v1 (interface allows S3/Vercel Blob later).
- **Secrets** (`.env`, validated at startup, **never logged**): `PLATFORM_PRIVATE_KEY` (Factory
  owner / manager signer), Turnkey API creds, Circle API key/entity secret, `ARC_TESTNET_RPC_URL`,
  and the deployed contract addresses (Factory, LegalManager impl, IdentityRegistry, USDC).

## 5. Roles in the demo

- **manager** = platform-held signer (also the Factory owner that calls `createEntity`, and the signer
  of the `setAgentWallet` binding). May be a local key in v1; Turnkey-held later.
- **guardian** = the human registrant (on-chain pause/veto/rescue). Demo: a settlor/registrant key.
- **operator** = the agent's **non-custodial Turnkey enclave key** (capped spending; later does
  x402/Gateway). Distinct from manager/guardian (contract enforces `RolesMustDiffer`, and
  `payout ≠ operator`).

## 6. Testing strategy (TDD)

- **Unit**: `policy/translator` (pure), `oa/generator` hash determinism, `config` validation.
- **Integration**: spin up **anvil**, deploy Factory + the Solidity **MockIdentityRegistry**, run the
  full saga via viem — real contract calls, no testnet flakiness.
- **Adapter contract tests**: Turnkey/Circle SDKs mocked for unit tests; one **env-gated live smoke
  test** each against testnet.
- **E2E**: CLI against local anvil; then a scripted run against **Arc testnet**.

## 7. Step 0 — accounts + testnet deploy

1. **Deploy contracts to Arc testnet** via `script/Deploy.s.sol` (LegalManager impl + Factory; platform
   key = Factory owner). Capture addresses into the addresses file + `.env`.
2. **Turnkey**: create org + API keypair; define the per-agent sub-org / delegated-access pattern.
3. **Circle**: developer account + API key/entity secret (for rails; not custody).
4. **Arc**: RPC endpoint + fund the platform EOA with testnet USDC (gas).
5. Wire `.env`; check in a `STACK_REFERENCE`-style addresses file.

## 8. Milestones (writing-plans expands these into the runbook)

- **M0** — Step-0 setup + Arc-testnet contract deploy + addresses file.
- **M1** — `backend/` skeleton: package, tsconfig, vitest/biome, `config` + `secrets` + `persistence` (SQLite/doc store) with tests.
- **M2** — `policy/translator` + `oa/generator` (pure, TDD).
- **M3** — `adapters/arc` + anvil integration of `createEntity` (read/write, type-safe ABIs).
- **M4** — `adapters/turnkey` + the `setAgentWallet` EIP-712 binding.
- **M5** — `workflow/onboarding` saga + `cli` + Arc-testnet E2E run.

Deferred to later specs: MCP server, web wizard, ERC-8183 proof-of-life agent, Circle rails depth,
production auth/multi-tenant/secrets-manager.

## 9. Non-goals (YAGNI)

No web framework/UI, no MCP yet, no proof-of-life job, no Postgres/cloud infra in v1, no production
auth, no multi-jurisdiction, no real EIN/state filing/KYC (stubbed + labeled, Phase 2).

## 10. Risks / carried forward

- **Circle KYC / user-of-record** for an algorithmic LLC — ✅ resolved 2026-06-12: a natural-person controller-of-record is mandatory (triple-locked: WY law + FinCEN CDD + Circle terms), so the entity needs a real human controller and the agent stays a bounded operator. Still mocked in this backend (real EIN/KYC is Phase 2).
- All Arc work is **testnet-era**; mainnet unverified. `via_ir` bytecode re-review still pending.
- Turnkey delegated-access / headless signing pattern ✅ validated 2026-06-12 (supported as Turnkey's documented pattern — see wallet design doc §8). Still confirm exact activity/method names (esp. the *revoke* path) when implementing M4.
