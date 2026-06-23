# Track C — Autonomous ERC-8183 Proof-of-Life — Design

> Status: design approved 2026-06-22. Branch `feat/track-c-erc8183-proof-of-life`.
> This is the last **primary** Circle-grant backend deliverable (original "Phase 4").
> Builds additively on the live legal body (contracts + onboarding "brain" unchanged).

## 1. Goal

Demonstrate an agent's on-chain legal body **autonomously earning USDC** through the ERC-8183
agentic-commerce job flow: a job is created and funded → the agent (the *provider*) does the work and
submits a deliverable → the job is evaluated and settled → real USDC is released to the agent → the
agent **earns reputation** on the ERC-8004 ReputationRegistry. All on Arc testnet, runnable as a
one-command demo.

The grant value is the **commerce loop** (accept → escrow → deliver → settle → reputation), not the
cleverness of the work itself.

## 2. Roles

Our agent is the **provider**. `createJob` takes `provider` and `evaluator` as distinct addresses, so
the three roles use three distinct signers:

| Role | Signs / sends | Key | Notes |
|---|---|---|---|
| **Client** (requester) | `createJob`, `setBudget`, `fund` | `JOB_CLIENT_PRIVATE_KEY`, default = the funded `PLATFORM` key | needs USDC for the escrow budget + gas |
| **Provider** (the agent) | `submit` | the agent's **per-agent operator enclave key** | non-custodial; reuses the "enclave sends txs" wallet client (`buildOperatorWalletClient`, from the nanopayment work); operator EOA needs a one-time USDC gas seed |
| **Evaluator** | `complete` | `JOB_EVALUATOR_PRIVATE_KEY` (dedicated, must differ from provider) | needs gas |

**Where earnings land:** ERC-8183 `complete()` releases escrow to the **`provider` address**, which
must be the operator EOA (since `submit` requires `msg.sender == provider`). An **optional final
step sweeps the earned USDC → the agent's governed treasury** (a plain ERC-20 transfer, operator →
vault) so the demo shows the agent earning *into its own legal-body treasury*. Toggled by
`JOB_SWEEP_TO_TREASURY`.

## 3. Components

Each is a focused, independently testable unit.

1. **`JobAdapter`** (`backend/src/adapters/arc/jobAdapter.ts`) — viem bindings for the ERC-8183 Job
   contract (`createJob`, `setBudget`, `fund`, `submit`, `complete`; `getJob`/`jobCounter` reads),
   following the existing `ArcAdapter` pattern: `simulate` → `writeContract` → `waitForTransactionReceipt`
   → `parseEventLogs`. Kept separate so the already-large `ArcAdapter` does not grow further.
2. **`ReputationAdapter`** (`backend/src/adapters/arc/reputationAdapter.ts`) — bindings for the ERC-8004
   ReputationRegistry. Exact ABI/flow **verified on-chain before wiring** (see §7).
3. **`JobWorker`** (the pluggable seam) — interface `produceDeliverable(job) => { content, deliverableHash }`.
   Default `TrivialWorker` returns deterministic canned content, `keccak256(content)` → the on-chain
   `bytes32` deliverable. Content is stored off-chain via the existing `DocumentStore`; only the hash
   goes on-chain. An insight-agent worker can be dropped in later behind this interface (v2).
4. **Job saga (`runJob`) + `JobRunner`** — orchestrates the loop, mirroring the onboarding saga
   (persisted, idempotent, resumable).

## 4. State machine & saga

```
pending → created → funded → submitted → completed → reputed
                                              └──────────────────→ failed
```

`runJob` (one job per `jobKey`), each step skipped if status is already past it:

| # | Step | Signer | → status | Persists |
|---|---|---|---|---|
| 0 | create record | — | `pending` | jobKey, entity (provider), client/evaluator, budget, description |
| 1 | `createJob` | client | `created` | on-chain `jobId`, createTx |
| 2 | `setBudget` + `fund` | client | `funded` | fundTx (USDC in escrow) |
| 3 | work + `submit` | operator (enclave) | `submitted` | deliverable hash + off-chain content path, submitTx |
| 4 | `complete` | evaluator | `completed` | completeTx — **USDC released to provider** |
| 4.5 | *(optional)* sweep → treasury | operator | *(event only)* | sweepTx |
| 5 | record reputation | per verified ABI | `reputed` | reputationTx |

**`createJob` parameters (v1):** `provider` = the agent's operator EOA, `evaluator` = the evaluator
key's address, `hook` = `address(0)` (no hook contract in v1), `expiredAt` = chain time + a configurable
window (default ~1h), `description` = supplied by the CLI/HTTP caller or a sensible default.

**Settlement and reputation are decoupled.** Once at `completed`, money has irreversibly moved, so
reputation (step 5) is **best-effort**: if it fails, the job stays at `completed` with a recorded,
*retryable* error — we never roll back or mark `failed` over a reputation hiccup. `completed` is a
safe resting state.

Each on-chain call runs a pre-flight `simulate` to surface a decoded revert reason before broadcasting
(the `ArcAdapter` pattern). `JobRunner.reconcileInFlight()` resumes non-terminal jobs on startup.

**Known v1 limitation (shared with onboarding):** the create→persist gap — `createJob` mints `jobId`
on-chain, so a crash between mining and persisting could re-create on resume. Documented, not fixed in
v1 (same class as the onboarding saga's create gap; hardening lives in the v2 backlog).

## 5. Persistence

Two new SQLite tables (additive, idempotent migration in `persistence/db.ts:migrate()`, mirroring
`entities`/`events`):

- **`jobs`**: `jobKey` (PK), `jobId` (on-chain, null until `created`), `entityKey`
  (FK → `entities.idempotency_key`; the provider agent), `ownerTenantId`, `status`, `clientAddress`,
  `evaluatorAddress`, `providerAddress`, `budgetAmount` (decimal string), `description`,
  `deliverableHash`, `deliverablePath`, `createTxHash`, `fundTxHash`, `submitTxHash`, `completeTxHash`,
  `sweepTxHash`, `reputationTxHash`, `error`, `createdAt`, `updatedAt`.
- **`job_events`**: `id`, `jobKey` (FK), `step`, `status`, `txHash`, `detail`, `createdAt`.

Jobs carry `ownerTenantId` so the HTTP surface stays tenant-scoped exactly like entities. A secret-free
`JobView` projection is returned by the API (mirroring `EntityView`).

## 6. Trigger / observe surface

- **CLI (demo driver):** `run-job --entity <entityKey> [--budget 1.00] [--description …]` runs the full
  loop for an onboarded agent; `get-job <jobKey>` and `list-jobs` to observe.
- **HTTP** (tenant-scoped, auth'd, reuses the API composition root): `POST /entities/:id/jobs` →
  `202 { jobKey, status }` (saga runs in the background via the runner, like onboarding);
  `GET /jobs/:jobKey` to poll; `GET /entities/:id/jobs` to list.
- **MCP tool:** deferred to Track B (slots in trivially later — same composition root).

## 7. Verification-first tasks (on-chain unknowns, resolved before wiring)

Resolved via the arcscan verified-ABI API + `eth_call` probes against the live contracts — the same
method that de-risked the onboarding integration (faithful interfaces beat lenient mocks):

1. **ReputationRegistry** — exact address + ABI, who records reputation (evaluator/client), and args;
   whether it is a separate call or emitted by `complete()`.
2. **`fund` mechanism** — does it pull via `transferFrom` (needs the client to `approve` the Job
   contract first) or expect a prior USDC transfer? Confirm `optParams` usage.
3. **`complete()`** — confirm it releases escrow to `provider`; meaning of the `reason` (`bytes32`).
4. **`submit` access control** — confirm `msg.sender == provider` (this drives the enclave-sends-tx +
   operator gas-seed requirement).

Known constants to reuse: ERC-8183 Job proxy `0x0747EEf0706327138c69792bF28Cd525089e4583`
(our `IERC8183Job` interface already matched its canonical ABI exactly); ReputationRegistry
`0x8004B66…` (confirm exact in task 1).

## 8. Configuration

`env.ts` + `.env.example` additions:

- `JOB_CONTRACT_ADDRESS` (default = `0x0747EEf0706327138c69792bF28Cd525089e4583`)
- `REPUTATION_REGISTRY_ADDRESS` (default = `0x8004B66…`, confirm exact in §7.1)
- `JOB_CLIENT_PRIVATE_KEY` (optional; default = `PLATFORM_PRIVATE_KEY`)
- `JOB_EVALUATOR_PRIVATE_KEY` (required for live runs; must differ from the provider)
- `JOB_SWEEP_TO_TREASURY` (bool; toggles step 4.5)
- `ARC_JOB_LIVE=1` — opt-in gate for the real on-chain run (mirrors `ARC_E2E`)

## 9. Error handling

- Each saga step: try → on error persist `failed` + the error message → rethrow; resumable.
- Pre-flight `simulate` on every on-chain call for decoded revert reasons before broadcasting.
- Settlement/reputation decoupling (§4): a reputation failure never unwinds settlement or marks
  `failed` — it leaves `completed` with a retryable error.
- Distinct, funded signers per role; the operator EOA's one-time USDC gas seed is a documented
  pre-req for the live run.

## 10. Testing

Mirrors the onboarding strategy:

- **Deterministic `npm test`:** faithful mocks of the Job + ReputationRegistry contracts, **diffed
  against the verified on-chain ABI** (lenient mocks previously hid reverts — explicit lesson from the
  ERC-8004/8183 integration). Cover: the full saga (create→fund→submit→complete→reputation), the three
  role signers, the settlement-vs-reputation decoupling (reputation failure → stays `completed`),
  idempotency/resume, HTTP tenant scoping, the `TrivialWorker`, and the optional sweep.
- **anvil integration** where real EVM execution of the mocks adds value.
- **Env-gated live run** against the real Arc-testnet contracts (spends USDC) — the truth oracle *and*
  the demo, like `test/e2e.arc.live.test.ts`. Gated by `ARC_JOB_LIVE=1`.

## 11. Scope boundaries — deferred to v2

- **Approach C — event-driven provider** that watches the chain for jobs assigned to it and reacts
  autonomously (no orchestrator driving it). The autonomy in v1 is the agent doing the work and
  submitting with no human in the loop; the client/evaluator are simulated counterparties. Full
  event-driven multi-actor separation is **explicitly deferred to v2**.
- **Insight-agent work function** — the `JobWorker` seam is built; the default stays `TrivialWorker`.
  Wiring the Phase-3 Claude insight agent as a worker is a v2 enhancement.
- **MCP job tool** — belongs to Track B (not yet built).
- **Crash-safety / concurrency hardening** — the create→persist gap and single-runner-per-job
  limitations are shared with the onboarding v2 backlog (`docs/V2_HARDENING_BACKLOG.md`).
</content>
