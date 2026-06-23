# Track C — Autonomous ERC-8183 Proof-of-Life Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An onboarded agent autonomously fulfills an ERC-8183 job — a funded job is created, the agent (provider) does pluggable work and submits a deliverable, an evaluator settles real USDC to the agent, and the agent earns ERC-8004 reputation — runnable as a one-command demo on Arc testnet.

**Architecture:** A persisted, resumable job saga mirroring the existing onboarding saga. ERC-8183 + ERC-8004-reputation calls live in dedicated viem adapters. The agent's "work" is a pluggable `JobWorker` (trivial default). Three role signers (client, provider=agent enclave operator, evaluator). Exposed via CLI + tenant-scoped HTTP. Deterministic tests use faithful Solidity mocks diffed against the verified on-chain ABI; an env-gated live run is the truth oracle and the demo.

**Tech Stack:** TypeScript (ESM, run via `tsx`), viem, Hono, better-sqlite3 (synchronous), `@turnkey/sdk-server` + `@turnkey/viem`, Foundry (forge/anvil) for mocks, vitest + biome.

**Design doc:** `docs/design/2026-06-22-track-c-erc8183-proof-of-life-design.md`

## Global Constraints

- Node ≥ 20.18.2; ESM modules; server runs via `tsx` (no build step).
- `npx tsc --noEmit` and `npx biome check .` must stay clean after every task.
- Additive only — do NOT change existing onboarding/contract behavior; the onboarding saga, contracts, and Turnkey signer are unchanged.
- better-sqlite3 API is synchronous (no `await` on repo calls).
- Strict TDD: failing test → minimal impl → green → commit. Frequent commits.
- Feature branch: `feat/track-c-erc8183-proof-of-life` (already created). Rebase on `origin/master` before any push.
- Known constants: chainId `5042002`; USDC `0x3600000000000000000000000000000000000000` (6 decimals); ERC-8183 Job proxy `0x0747EEf0706327138c69792bF28Cd525089e4583`; ReputationRegistry `0x8004B66…` (confirm exact in Task 0.1). USD↔atomic conversion via existing `src/policy/units.ts` (`usdToUnits`).
- **Phase 0 (verification) is a hard prerequisite for Phases 1–3.** Tasks 1.x–3.x reference the ABIs/semantics confirmed in Task 0.1; where this plan shows an expected ABI fragment, replace it with the exact one from the findings doc if it differs.

---

## Phase 0 — Verify on-chain unknowns

### Task 0.1: Probe the live ERC-8183 Job + ReputationRegistry

**Files:**
- Create: `backend/scripts/probe-erc8183.mts`
- Create (deliverable): `docs/research/2026-06-22-erc8183-reputation-findings.md`

**Interfaces:**
- Produces (as documented findings, consumed by Tasks 1.x–3.x): exact ReputationRegistry address + ABI + the recording function (name, args, which role signs); whether `fund` pulls USDC via `transferFrom` (requires client `approve` first) or expects a prior transfer; whether `complete` releases escrow to `provider`; whether `submit` requires `msg.sender == provider`; the `getJob`/`jobs` read shape and `jobCounter()` getter.

- [ ] **Step 1: Write the probe script**

```ts
// backend/scripts/probe-erc8183.mts
import "dotenv/config";
import { createPublicClient, http } from "viem";

const RPC = process.env.ARC_TESTNET_RPC_URL!;
const JOB = "0x0747EEf0706327138c69792bF28Cd525089e4583";
const client = createPublicClient({ transport: http(RPC) });

async function fetchAbi(address: string) {
  const url = `https://testnet.arcscan.app/api?module=contract&action=getabi&address=${address}`;
  const res = await fetch(url);
  return res.json();
}

async function main() {
  console.log("Job ABI:", JSON.stringify(await fetchAbi(JOB)).slice(0, 4000));
  console.log("jobCounter:", await client.readContract({
    address: JOB, abi: [{ type: "function", name: "jobCounter", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
    functionName: "jobCounter",
  }).catch((e) => `read failed: ${(e as Error).message}`));
  // Inspect the verified source for the ReputationRegistry address referenced by the job,
  // and for fund/submit/complete bodies (transferFrom? msg.sender==provider? release to provider?).
  console.log("Fetch getsourcecode for 0x0747... and the ReputationRegistry it references; record findings.");
}
main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Run the probe**

Run: `cd backend && npx tsx scripts/probe-erc8183.mts`
Expected: prints the verified Job ABI and `jobCounter`; you then read the verified source via the `getsourcecode` API for `fund`/`submit`/`complete`/reputation wiring.

- [ ] **Step 3: Write the findings doc**

Record, with exact signatures, the five answers from the Interfaces block. Include the confirmed `ReputationRegistry` address and its recording function signature, the `fund` funding mechanism, and the `getJob` return tuple.

- [ ] **Step 4: Commit**

```bash
git add backend/scripts/probe-erc8183.mts docs/research/2026-06-22-erc8183-reputation-findings.md
git commit -m "research(track-c): verify live ERC-8183 + ReputationRegistry ABIs/semantics"
```

---

## Phase 1 — Solidity mocks + generated ABIs

### Task 1.1: MockERC8183Job + generated Job ABI

**Files:**
- Create: `test/mocks/MockERC8183Job.sol` (Foundry contracts root)
- Modify: `backend/scripts/gen-abis.mts:14-22` (add targets)
- Test: `backend/test/abis/jobAbi.test.ts`

**Interfaces:**
- Produces: `iErc8183JobAbi` and `mockErc8183JobAbi` exported from `backend/src/abis/generated.ts`; a deployable mock with faithful escrow semantics confirmed in Task 0.1.

- [ ] **Step 1: Write the faithful mock (semantics per Task 0.1 findings)**

```solidity
// test/mocks/MockERC8183Job.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 { function transferFrom(address,address,uint256) external returns (bool); function transfer(address,uint256) external returns (bool); }

contract MockERC8183Job {
    struct Job { address client; address provider; address evaluator; uint256 budget; uint256 expiredAt; bytes32 deliverable; uint8 status; }
    IERC20 public immutable usdc;
    uint256 public jobCounter;
    mapping(uint256 => Job) public jobs;
    event JobCreated(uint256 indexed jobId, address indexed provider, address indexed evaluator);
    event Submitted(uint256 indexed jobId, bytes32 deliverable);
    event Completed(uint256 indexed jobId, address indexed provider, uint256 amount);

    constructor(address _usdc) { usdc = IERC20(_usdc); }

    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata, address) external returns (uint256 jobId) {
        jobId = jobCounter++;
        jobs[jobId] = Job(msg.sender, provider, evaluator, 0, expiredAt, bytes32(0), 1);
        emit JobCreated(jobId, provider, evaluator);
    }
    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external { require(msg.sender == jobs[jobId].client, "not client"); jobs[jobId].budget = amount; }
    function fund(uint256 jobId, bytes calldata) external { Job storage j = jobs[jobId]; require(msg.sender == j.client, "not client"); require(usdc.transferFrom(msg.sender, address(this), j.budget), "transferFrom"); j.status = 2; }
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external { Job storage j = jobs[jobId]; require(msg.sender == j.provider, "not provider"); j.deliverable = deliverable; j.status = 3; emit Submitted(jobId, deliverable); }
    function complete(uint256 jobId, bytes32, bytes calldata) external { Job storage j = jobs[jobId]; require(msg.sender == j.evaluator, "not evaluator"); require(j.status == 3, "not submitted"); j.status = 4; require(usdc.transfer(j.provider, j.budget), "payout"); emit Completed(jobId, j.provider, j.budget); }
    function getJob(uint256 jobId) external view returns (Job memory) { return jobs[jobId]; }
}
```

- [ ] **Step 2: forge build + add ABI targets**

In `backend/scripts/gen-abis.mts` add to `TARGETS`:
```ts
  iErc8183JobAbi: "IERC8183Job.sol/IERC8183Job.json",
  mockErc8183JobAbi: "MockERC8183Job.sol/MockERC8183Job.json",
```
Run: `forge build && cd backend && npm run gen:abis`
Expected: `wrote .../generated.ts (8 ABIs)`.

- [ ] **Step 3: Write the failing test**

```ts
// backend/test/abis/jobAbi.test.ts
import { describe, expect, test } from "vitest";
import { iErc8183JobAbi, mockErc8183JobAbi } from "../../src/abis/generated";

describe("job ABIs", () => {
  test("expose createJob and complete", () => {
    const names = [...iErc8183JobAbi, ...mockErc8183JobAbi].filter((x) => x.type === "function").map((x) => x.name);
    expect(names).toContain("createJob");
    expect(names).toContain("complete");
  });
});
```

- [ ] **Step 4: Run it**

Run: `cd backend && npx vitest run test/abis/jobAbi.test.ts`
Expected: PASS (ABIs generated in Step 2).

- [ ] **Step 5: Commit**

```bash
git add test/mocks/MockERC8183Job.sol backend/scripts/gen-abis.mts backend/src/abis/generated.ts backend/test/abis/jobAbi.test.ts
git commit -m "feat(track-c): MockERC8183Job + generated Job ABI"
```

### Task 1.2: MockReputationRegistry + interface + generated ABI

**Files:**
- Create: `src/interfaces/IERC8183Reputation.sol` (signature per Task 0.1)
- Create: `test/mocks/MockReputationRegistry.sol`
- Modify: `backend/scripts/gen-abis.mts` (add `reputationRegistryAbi`, `mockReputationRegistryAbi`)
- Test: `backend/test/abis/reputationAbi.test.ts`

**Interfaces:**
- Produces: `reputationRegistryAbi`, `mockReputationRegistryAbi` in `generated.ts`. The interface mirrors the verified recording function from Task 0.1 — the example below assumes `giveFeedback(uint256 agentId, uint8 score, bytes32 ref)`; **replace with the verified signature if it differs.**

- [ ] **Step 1: Write the interface + mock (signature from Task 0.1)**

```solidity
// src/interfaces/IERC8183Reputation.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IERC8183Reputation { function giveFeedback(uint256 agentId, uint8 score, bytes32 ref) external; }
```
```solidity
// test/mocks/MockReputationRegistry.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract MockReputationRegistry {
    event Feedback(uint256 indexed agentId, address indexed from, uint8 score, bytes32 ref);
    mapping(uint256 => uint256) public count;
    function giveFeedback(uint256 agentId, uint8 score, bytes32 ref) external { count[agentId]++; emit Feedback(agentId, msg.sender, score, ref); }
}
```

- [ ] **Step 2: gen ABIs + write failing test**

Add the two targets to `gen-abis.mts`, run `forge build && npm run gen:abis`, then:
```ts
// backend/test/abis/reputationAbi.test.ts
import { describe, expect, test } from "vitest";
import { reputationRegistryAbi } from "../../src/abis/generated";
test("reputation abi exposes the recording fn", () => {
  expect(reputationRegistryAbi.filter((x) => x.type === "function").map((x) => x.name)).toContain("giveFeedback");
});
```

- [ ] **Step 3: Run it**

Run: `cd backend && npx vitest run test/abis/reputationAbi.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/interfaces/IERC8183Reputation.sol test/mocks/MockReputationRegistry.sol backend/scripts/gen-abis.mts backend/src/abis/generated.ts backend/test/abis/reputationAbi.test.ts
git commit -m "feat(track-c): MockReputationRegistry + interface + ABI"
```

---

## Phase 2 — JobAdapter

### Task 2.1: JobAdapter scaffold + reads

**Files:**
- Create: `backend/src/adapters/arc/jobAdapter.ts`
- Test: `backend/test/adapters/arc/jobAdapter.int.test.ts` (anvil)

**Interfaces:**
- Consumes: `iErc8183JobAbi`, `mockErc8183JobAbi`.
- Produces: `class JobAdapter` with deps `{ publicClient, clientWallet, evaluatorWallet?, providerWalletFor?, jobContract: Address }`; `getJob(jobId: bigint): Promise<{ client; provider; evaluator; budget: bigint; deliverable: Hex; status: number }>`; `jobCounter(): Promise<bigint>`.

- [ ] **Step 1: Write the failing test (anvil; follow `arcAdapter` anvil test setup)**

```ts
// backend/test/adapters/arc/jobAdapter.int.test.ts
import { describe, expect, test } from "vitest";
import { startAnvil, deployMockJob, makeClients } from "../../helpers/anvilJob"; // helper added below
import { JobAdapter } from "../../../src/adapters/arc/jobAdapter";

describe("JobAdapter reads", () => {
  test("jobCounter starts at 0", async () => {
    const { publicClient, clientWallet, jobAddr, stop } = await deployMockJob();
    const a = new JobAdapter({ publicClient, clientWallet, jobContract: jobAddr });
    expect(await a.jobCounter()).toBe(0n);
    await stop();
  });
});
```
(Add `backend/test/helpers/anvilJob.ts` mirroring the existing anvil helper used by `arcAdapter` tests: boot anvil, deploy `MockUSDC` + `MockERC8183Job`, return viem public/wallet clients for client/provider/evaluator accounts.)

- [ ] **Step 2: Run it**

Run: `cd backend && npx vitest run test/adapters/arc/jobAdapter.int.test.ts`
Expected: FAIL (`JobAdapter` not defined).

- [ ] **Step 3: Implement reads**

```ts
// backend/src/adapters/arc/jobAdapter.ts
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { iErc8183JobAbi } from "../../abis/generated";

export interface JobAdapterDeps {
  publicClient: PublicClient;
  clientWallet: WalletClient;       // signs createJob/setBudget/fund
  evaluatorWallet?: WalletClient;   // signs complete
  jobContract: Address;
}

export class JobAdapter {
  constructor(private readonly d: JobAdapterDeps) {}
  get jobContract(): Address { return this.d.jobContract; }

  async jobCounter(): Promise<bigint> {
    return this.d.publicClient.readContract({ address: this.d.jobContract, abi: iErc8183JobAbi, functionName: "jobCounter" }) as Promise<bigint>;
  }
  async getJob(jobId: bigint) {
    const j = (await this.d.publicClient.readContract({ address: this.d.jobContract, abi: iErc8183JobAbi, functionName: "getJob", args: [jobId] })) as { client: Address; provider: Address; evaluator: Address; budget: bigint; deliverable: Hex; status: number };
    return j;
  }
}
```
(If the verified Job exposes `jobs(jobId)` rather than `getJob`, use that read per Task 0.1.)

- [ ] **Step 4: Run it**

Run: `cd backend && npx vitest run test/adapters/arc/jobAdapter.int.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/arc/jobAdapter.ts backend/test/adapters/arc/jobAdapter.int.test.ts backend/test/helpers/anvilJob.ts
git commit -m "feat(track-c): JobAdapter reads (getJob/jobCounter) + anvil helper"
```

### Task 2.2: JobAdapter client writes — createJob / setBudget / fund

**Files:**
- Modify: `backend/src/adapters/arc/jobAdapter.ts`
- Test: `backend/test/adapters/arc/jobAdapter.int.test.ts`

**Interfaces:**
- Produces: `createJob(p: { provider: Address; evaluator: Address; expiredAt: bigint; description: string; hook?: Address }): Promise<{ jobId: bigint; txHash: Hex }>`; `setBudget(jobId: bigint, amount: bigint): Promise<Hex>`; `approveAndFund(jobId: bigint, usdc: Address, amount: bigint): Promise<Hex>` (the `approve` is included iff Task 0.1 says `fund` pulls via `transferFrom`).

- [ ] **Step 1: Write the failing test**

```ts
test("createJob mints jobId 0 and fund moves USDC into escrow", async () => {
  const { publicClient, clientWallet, providerAddr, evaluatorAddr, usdcAddr, jobAddr, mintUsdc, stop } = await deployMockJob();
  await mintUsdc(clientWallet.account!.address, 1_000_000n);
  const a = new JobAdapter({ publicClient, clientWallet, jobContract: jobAddr });
  const { jobId } = await a.createJob({ provider: providerAddr, evaluator: evaluatorAddr, expiredAt: 9_999_999_999n, description: "demo" });
  expect(jobId).toBe(0n);
  await a.setBudget(jobId, 500_000n);
  await a.approveAndFund(jobId, usdcAddr, 500_000n);
  expect((await a.getJob(jobId)).status).toBe(2);
  await stop();
});
```

- [ ] **Step 2: Run it** — Run: `npx vitest run test/adapters/arc/jobAdapter.int.test.ts` — Expected: FAIL (`createJob` not defined).

- [ ] **Step 3: Implement (simulate → write → wait → parse event), mirroring `ArcAdapter.createEntity`**

```ts
// add imports: parseEventLogs; erc20 approve fragment
import { parseEventLogs } from "viem";
const erc20ApproveAbi = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

async createJob(p: { provider: Address; evaluator: Address; expiredAt: bigint; description: string; hook?: Address }): Promise<{ jobId: bigint; txHash: Hex }> {
  const { request } = await this.d.publicClient.simulateContract({
    address: this.d.jobContract, abi: iErc8183JobAbi, functionName: "createJob",
    args: [p.provider, p.evaluator, p.expiredAt, p.description, p.hook ?? "0x0000000000000000000000000000000000000000"],
    account: this.d.clientWallet.account!,
  });
  const txHash = await this.d.clientWallet.writeContract(request);
  const receipt = await this.d.publicClient.waitForTransactionReceipt({ hash: txHash });
  const [ev] = parseEventLogs({ abi: iErc8183JobAbi, eventName: "JobCreated", logs: receipt.logs });
  if (!ev) throw new Error("createJob: JobCreated not emitted");
  return { jobId: (ev.args as { jobId: bigint }).jobId, txHash };
}
async setBudget(jobId: bigint, amount: bigint): Promise<Hex> {
  const { request } = await this.d.publicClient.simulateContract({ address: this.d.jobContract, abi: iErc8183JobAbi, functionName: "setBudget", args: [jobId, amount, "0x"], account: this.d.clientWallet.account! });
  const h = await this.d.clientWallet.writeContract(request); await this.d.publicClient.waitForTransactionReceipt({ hash: h }); return h;
}
async approveAndFund(jobId: bigint, usdc: Address, amount: bigint): Promise<Hex> {
  const ap = await this.d.publicClient.simulateContract({ address: usdc, abi: erc20ApproveAbi, functionName: "approve", args: [this.d.jobContract, amount], account: this.d.clientWallet.account! });
  await this.d.publicClient.waitForTransactionReceipt({ hash: await this.d.clientWallet.writeContract(ap.request) });
  const { request } = await this.d.publicClient.simulateContract({ address: this.d.jobContract, abi: iErc8183JobAbi, functionName: "fund", args: [jobId, "0x"], account: this.d.clientWallet.account! });
  const h = await this.d.clientWallet.writeContract(request); await this.d.publicClient.waitForTransactionReceipt({ hash: h }); return h;
}
```

- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): JobAdapter createJob/setBudget/approveAndFund"`

### Task 2.3: JobAdapter provider submit + evaluator complete

**Files:** Modify `jobAdapter.ts`; Test `jobAdapter.int.test.ts`

**Interfaces:**
- Produces: `submit(jobId: bigint, deliverable: Hex, providerWallet: WalletClient): Promise<Hex>` (provider is `msg.sender`); `complete(jobId: bigint, reason: Hex): Promise<Hex>` (uses `evaluatorWallet`).

- [ ] **Step 1: Write the failing test**

```ts
test("provider submits, evaluator completes, USDC released to provider", async () => {
  const { publicClient, clientWallet, providerWallet, evaluatorWallet, providerAddr, evaluatorAddr, usdcAddr, jobAddr, mintUsdc, usdcBalanceOf, stop } = await deployMockJob();
  await mintUsdc(clientWallet.account!.address, 1_000_000n);
  const a = new JobAdapter({ publicClient, clientWallet, evaluatorWallet, jobContract: jobAddr });
  const { jobId } = await a.createJob({ provider: providerAddr, evaluator: evaluatorAddr, expiredAt: 9_999_999_999n, description: "x" });
  await a.setBudget(jobId, 400_000n); await a.approveAndFund(jobId, usdcAddr, 400_000n);
  await a.submit(jobId, ("0x" + "11".repeat(32)) as `0x${string}`, providerWallet);
  await a.complete(jobId, ("0x" + "00".repeat(32)) as `0x${string}`);
  expect(await usdcBalanceOf(providerAddr)).toBe(400_000n);
  await stop();
});
```

- [ ] **Step 2: Run it** — Expected: FAIL.
- [ ] **Step 3: Implement**

```ts
async submit(jobId: bigint, deliverable: Hex, providerWallet: WalletClient): Promise<Hex> {
  const { request } = await this.d.publicClient.simulateContract({ address: this.d.jobContract, abi: iErc8183JobAbi, functionName: "submit", args: [jobId, deliverable, "0x"], account: providerWallet.account! });
  const h = await providerWallet.writeContract(request); await this.d.publicClient.waitForTransactionReceipt({ hash: h }); return h;
}
async complete(jobId: bigint, reason: Hex): Promise<Hex> {
  if (!this.d.evaluatorWallet) throw new Error("complete: evaluatorWallet not configured");
  const { request } = await this.d.publicClient.simulateContract({ address: this.d.jobContract, abi: iErc8183JobAbi, functionName: "complete", args: [jobId, reason, "0x"], account: this.d.evaluatorWallet.account! });
  const h = await this.d.evaluatorWallet.writeContract(request); await this.d.publicClient.waitForTransactionReceipt({ hash: h }); return h;
}
```

- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): JobAdapter submit (provider) + complete (evaluator)"`

---

## Phase 3 — ReputationAdapter

### Task 3.1: ReputationAdapter record + read

**Files:** Create `backend/src/adapters/arc/reputationAdapter.ts`; Test `backend/test/adapters/arc/reputationAdapter.int.test.ts`

**Interfaces:**
- Consumes: `reputationRegistryAbi`, `mockReputationRegistryAbi`.
- Produces: `class ReputationAdapter` deps `{ publicClient; recorderWallet: WalletClient; registry: Address }`; `record(agentId: bigint, score: number, ref: Hex): Promise<Hex>`; `feedbackCount(agentId: bigint): Promise<bigint>`. (Method shape follows Task 0.1; the recorder role is whichever role Task 0.1 confirms — default the evaluator.)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { deployMockReputation } from "../../helpers/anvilJob";
import { ReputationAdapter } from "../../../src/adapters/arc/reputationAdapter";
test("record increments feedback count", async () => {
  const { publicClient, evaluatorWallet, registryAddr, stop } = await deployMockReputation();
  const r = new ReputationAdapter({ publicClient, recorderWallet: evaluatorWallet, registry: registryAddr });
  await r.record(656785n, 5, ("0x" + "ab".repeat(32)) as `0x${string}`);
  expect(await r.feedbackCount(656785n)).toBe(1n);
  await stop();
});
```

- [ ] **Step 2: Run it** — Expected: FAIL.
- [ ] **Step 3: Implement**

```ts
// backend/src/adapters/arc/reputationAdapter.ts
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { reputationRegistryAbi } from "../../abis/generated";
export interface ReputationAdapterDeps { publicClient: PublicClient; recorderWallet: WalletClient; registry: Address; }
export class ReputationAdapter {
  constructor(private readonly d: ReputationAdapterDeps) {}
  async record(agentId: bigint, score: number, ref: Hex): Promise<Hex> {
    const { request } = await this.d.publicClient.simulateContract({ address: this.d.registry, abi: reputationRegistryAbi, functionName: "giveFeedback", args: [agentId, score, ref], account: this.d.recorderWallet.account! });
    const h = await this.d.recorderWallet.writeContract(request); await this.d.publicClient.waitForTransactionReceipt({ hash: h }); return h;
  }
  feedbackCount(agentId: bigint): Promise<bigint> {
    return this.d.publicClient.readContract({ address: this.d.registry, abi: reputationRegistryAbi, functionName: "count", args: [agentId] }) as Promise<bigint>;
  }
}
```
(Adjust `giveFeedback`/`count` names + args to the verified ABI from Task 0.1.)

- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): ReputationAdapter record/read"`

---

## Phase 4 — JobWorker (pluggable work seam)

### Task 4.1: JobWorker interface + TrivialWorker

**Files:** Create `backend/src/jobs/worker.ts`; Test `backend/test/jobs/worker.test.ts`

**Interfaces:**
- Produces: `interface JobWorker { produceDeliverable(input: { jobKey: string; description: string }): Promise<{ content: string; deliverableHash: Hex }> }`; `class TrivialWorker implements JobWorker`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { keccak256, toHex } from "viem";
import { TrivialWorker } from "../../src/jobs/worker";
test("trivial worker is deterministic and hashes content", async () => {
  const w = new TrivialWorker();
  const a = await w.produceDeliverable({ jobKey: "k1", description: "summarize" });
  const b = await w.produceDeliverable({ jobKey: "k1", description: "summarize" });
  expect(a.content).toBe(b.content);
  expect(a.deliverableHash).toBe(keccak256(toHex(a.content)));
});
```

- [ ] **Step 2: Run it** — Expected: FAIL.
- [ ] **Step 3: Implement**

```ts
// backend/src/jobs/worker.ts
import { type Hex, keccak256, toHex } from "viem";
export interface JobWorker { produceDeliverable(input: { jobKey: string; description: string }): Promise<{ content: string; deliverableHash: Hex }>; }
export class TrivialWorker implements JobWorker {
  async produceDeliverable(input: { jobKey: string; description: string }) {
    const content = `Deliverable for job ${input.jobKey}: ${input.description} — completed by the agent.`;
    return { content, deliverableHash: keccak256(toHex(content)) };
  }
}
```

- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): JobWorker seam + TrivialWorker"`

---

## Phase 5 — Persistence

### Task 5.1: Job types + jobs/job_events migration

**Files:** Create `backend/src/jobs/types.ts`; Modify `backend/src/persistence/db.ts:16-85` (extend `migrate()`); Test `backend/test/jobs/migration.test.ts`

**Interfaces:**
- Produces: `type JobStatus = "pending" | "created" | "funded" | "submitted" | "completed" | "reputed" | "failed"`; `interface JobRecord { jobKey; jobId; entityKey; ownerTenantId?; status; clientAddress; evaluatorAddress; providerAddress; budgetAmount; description; deliverableHash; deliverablePath; createTxHash; fundTxHash; submitTxHash; completeTxHash; sweepTxHash; reputationTxHash; error?; createdAt?; updatedAt? }` (string/Hex/null types mirroring `EntityRecord`).

- [ ] **Step 1: Write the failing test**

```ts
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
test("migrate creates jobs and job_events tables", () => {
  const db = new Database(":memory:"); migrate(db);
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
  expect(names).toContain("jobs"); expect(names).toContain("job_events");
});
```

- [ ] **Step 2: Run it** — Expected: FAIL (tables absent).
- [ ] **Step 3: Add the tables to `migrate()` (append inside the `db.exec` block)**

```sql
CREATE TABLE IF NOT EXISTS jobs (
  job_key TEXT PRIMARY KEY,
  job_id TEXT,
  entity_key TEXT NOT NULL,
  owner_tenant_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','created','funded','submitted','completed','reputed','failed')),
  client_address TEXT NOT NULL,
  evaluator_address TEXT NOT NULL,
  provider_address TEXT NOT NULL,
  budget_amount TEXT NOT NULL,
  description TEXT NOT NULL,
  deliverable_hash TEXT, deliverable_path TEXT,
  create_tx_hash TEXT, fund_tx_hash TEXT, submit_tx_hash TEXT, complete_tx_hash TEXT, sweep_tx_hash TEXT, reputation_tx_hash TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (entity_key) REFERENCES entities(idempotency_key)
);
CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT NOT NULL,
  step TEXT NOT NULL, status TEXT NOT NULL, tx_hash TEXT, detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (job_key) REFERENCES jobs(job_key)
);
```
Also create `backend/src/jobs/types.ts` with the `JobStatus`/`JobRecord` shapes from Interfaces.

- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): job types + jobs/job_events migration"`

### Task 5.2: SqliteJobRepository

**Files:** Create `backend/src/jobs/jobRepository.ts`; Test `backend/test/jobs/jobRepository.test.ts`

**Interfaces:**
- Consumes: `JobRecord`, `JobStatus`.
- Produces: `interface JobRepository { upsert(r: JobRecord): void; findByKey(k: string): JobRecord | undefined; listByEntity(entityKey: string): JobRecord[]; listByTenant(tenantId: string): JobRecord[]; listInFlight(): JobRecord[]; recordEvent(k, step, status, txHash, detail): void; transaction<T>(fn: () => T): T }`; `class SqliteJobRepository`.

- [ ] **Step 1: Write the failing test**

```ts
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import type { JobRecord } from "../../src/jobs/types";

const base: JobRecord = { jobKey: "t:k", jobId: null, entityKey: "t:agent", ownerTenantId: "0xT", status: "pending", clientAddress: "0xC", evaluatorAddress: "0xE", providerAddress: "0xP", budgetAmount: "500000", description: "d", deliverableHash: null, deliverablePath: null, createTxHash: null, fundTxHash: null, submitTxHash: null, completeTxHash: null, sweepTxHash: null, reputationTxHash: null, error: null };

test("upsert + find + tenant scope", () => {
  const db = new Database(":memory:"); migrate(db);
  const repo = new SqliteJobRepository(db);
  repo.upsert(base);
  expect(repo.findByKey("t:k")?.status).toBe("pending");
  repo.upsert({ ...base, status: "funded" });
  expect(repo.findByKey("t:k")?.status).toBe("funded");
  expect(repo.listByTenant("0xT").length).toBe(1);
  expect(repo.listByTenant("0xOTHER").length).toBe(0);
});
```

- [ ] **Step 2: Run it** — Expected: FAIL.
- [ ] **Step 3: Implement** (mirror `SqliteEntityRepository`: INSERT…ON CONFLICT upsert, `toRecord` mapper, prepared reads; `listInFlight` = status IN `('pending','created','funded','submitted')`; `recordEvent` inserts into `job_events`; `transaction` wraps `db.transaction`).

- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): SqliteJobRepository"`

---

## Phase 6 — Job saga (`runJob`)

### Task 6.1: Saga — create → fund

**Files:** Create `backend/src/jobs/runJob.ts`; Test `backend/test/jobs/runJob.test.ts`

**Interfaces:**
- Consumes: `JobAdapter`, `ReputationAdapter`, `JobWorker`, `JobRepository`, `DocumentStore`, `EntityRepository` (to look up the provider entity), `buildOperatorWalletClientForEntity`.
- Produces: `runJob(d: RunJobDeps): Promise<JobRecord>` where `RunJobDeps = { jobKey; entityKey; tenantId?; budget: bigint; description; usdc: Address; jobs: JobRepository; entities: EntityRepository; job: JobAdapter; reputation: ReputationAdapter; worker: JobWorker; docStore: DocumentStore; providerWalletFor: (e: { subOrgId: string; operator: string }) => Promise<WalletClient>; sweepToTreasury: boolean; expiryWindowSec?: number; now?: () => number }`.

- [ ] **Step 1: Write the failing test (fake adapters/repo)**

```ts
import Database from "better-sqlite3";
import { describe, expect, test, vi } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { SqliteEntityRepository } from "../../src/persistence/entityRepository";
import { runJob } from "../../src/jobs/runJob";
// fakeJob: createJob→{jobId:0n,txHash}, setBudget/approveAndFund→hashes; fakeDeps factory in helper
import { makeRunJobDeps, seedBoundEntity } from "../helpers/runJobDeps";

test("create → fund advances to funded", async () => {
  const db = new Database(":memory:"); migrate(db);
  const jobs = new SqliteJobRepository(db); const entities = new SqliteEntityRepository(db);
  seedBoundEntity(entities, "t:agent");
  const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:k", entityKey: "t:agent", budget: 500000n });
  // stop the fake worker so we can assert intermediate state
  deps.worker.produceDeliverable = vi.fn().mockRejectedValueOnce(new Error("stop after fund"));
  await expect(runJob(deps)).rejects.toThrow("stop after fund");
  expect(jobs.findByKey("t:k")?.status).toBe("funded");
});
```
(Add `backend/test/helpers/runJobDeps.ts`: a `makeRunJobDeps` returning fakes — `job` with stubbed `createJob/setBudget/approveAndFund/submit/complete/getJob`, `reputation.record`, an in-memory `worker`, a `providerWalletFor` returning a dummy wallet, and `seedBoundEntity` inserting a `bound` EntityRecord with `turnkeySubOrgId`/`operator`.)

- [ ] **Step 2: Run it** — Expected: FAIL (`runJob` not defined).
- [ ] **Step 3: Implement Steps 0–2 of the saga**

```ts
// backend/src/jobs/runJob.ts (steps 0-2 shown; later tasks append)
import type { Address, Hex, WalletClient } from "viem";
import type { DocumentStore } from "../persistence/documentStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type { JobAdapter } from "../adapters/arc/jobAdapter";
import type { ReputationAdapter } from "../adapters/arc/reputationAdapter";
import type { JobRepository } from "./jobRepository";
import type { JobRecord } from "./types";
import type { JobWorker } from "./worker";

export interface RunJobDeps { jobKey: string; entityKey: string; tenantId?: string; budget: bigint; description: string; usdc: Address; jobs: JobRepository; entities: EntityRepository; job: JobAdapter; reputation: ReputationAdapter; worker: JobWorker; docStore: DocumentStore; providerWalletFor: (e: { subOrgId: string; operator: string }) => Promise<WalletClient>; sweepToTreasury: boolean; expiryWindowSec?: number; now?: () => number; }

export async function runJob(d: RunJobDeps): Promise<JobRecord> {
  const entity = d.entities.findByIdempotencyKey(d.entityKey);
  if (!entity || entity.status !== "bound" && entity.status !== "funded") throw new Error(`entity ${d.entityKey} is not a bound agent`);
  if (!entity.operator || !entity.turnkeySubOrgId) throw new Error(`entity ${d.entityKey} has no per-agent operator vault`);

  let rec = d.jobs.findByKey(d.jobKey);
  if (!rec) {
    rec = { jobKey: d.jobKey, jobId: null, entityKey: d.entityKey, ownerTenantId: d.tenantId, status: "pending", clientAddress: "0x" as Address, evaluatorAddress: "0x" as Address, providerAddress: entity.operator, budgetAmount: d.budget.toString(), description: d.description, deliverableHash: null, deliverablePath: null, createTxHash: null, fundTxHash: null, submitTxHash: null, completeTxHash: null, sweepTxHash: null, reputationTxHash: null, error: null };
    d.jobs.upsert(rec);
  }
  // Step 1: createJob
  if (rec.status === "pending") {
    const now = d.now ? d.now() : Math.floor(Date.now() / 1000);
    const expiredAt = BigInt(now + (d.expiryWindowSec ?? 3600));
    const { jobId, txHash } = await d.job.createJob({ provider: entity.operator as Address, evaluator: d.job.evaluatorAddress(), expiredAt, description: d.description });
    rec = { ...rec, status: "created", jobId: jobId.toString(), createTxHash: txHash, clientAddress: d.job.clientAddress(), evaluatorAddress: d.job.evaluatorAddress() };
    d.jobs.transaction(() => { d.jobs.upsert(rec!); d.jobs.recordEvent(d.jobKey, "createJob", "created", txHash, JSON.stringify({ jobId: jobId.toString() })); });
  }
  // Step 2: setBudget + fund
  if (rec.status === "created") {
    await d.job.setBudget(BigInt(rec.jobId!), d.budget);
    const fundTx = await d.job.approveAndFund(BigInt(rec.jobId!), d.usdc, d.budget);
    rec = { ...rec, status: "funded", fundTxHash: fundTx };
    d.jobs.transaction(() => { d.jobs.upsert(rec!); d.jobs.recordEvent(d.jobKey, "fund", "funded", fundTx, null); });
  }
  // (steps 3-5 appended in Tasks 6.2, 6.3)
  return rec;
}
```
Add `clientAddress()` and `evaluatorAddress()` accessors to `JobAdapter` returning `this.d.clientWallet.account!.address` and `this.d.evaluatorWallet!.account!.address`.

- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): runJob saga create+fund steps"`

### Task 6.2: Saga — work + submit, then complete

**Files:** Modify `runJob.ts`; Test `runJob.test.ts`

**Interfaces:**
- Consumes: `providerWalletFor`, `worker`, `docStore`.
- Produces: saga advances `funded → submitted → completed`; stores deliverable content via `docStore.put('job-<jobKey>.txt', content)`.

- [ ] **Step 1: Write the failing test**

```ts
test("funded → submitted → completed (full fakes)", async () => {
  const db = new Database(":memory:"); migrate(db);
  const jobs = new SqliteJobRepository(db); const entities = new SqliteEntityRepository(db);
  seedBoundEntity(entities, "t:agent");
  const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:k", entityKey: "t:agent", budget: 500000n });
  await runJob(deps);
  const r = jobs.findByKey("t:k")!;
  expect(["completed", "reputed"]).toContain(r.status);
  expect(r.submitTxHash).toBeTruthy(); expect(r.completeTxHash).toBeTruthy();
  expect(r.deliverableHash).toBeTruthy();
});
```

- [ ] **Step 2: Run it** — Expected: FAIL (stops at `funded`).
- [ ] **Step 3: Append steps 3 + 4**

```ts
// Step 3: work + submit (provider = the agent's enclave operator)
if (rec.status === "funded") {
  const { content, deliverableHash } = await d.worker.produceDeliverable({ jobKey: d.jobKey, description: d.description });
  const put = d.docStore.put(`job-${d.jobKey}.txt`, content);
  const providerWallet = await d.providerWalletFor({ subOrgId: entity.turnkeySubOrgId!, operator: entity.operator! });
  const submitTx = await d.job.submit(BigInt(rec.jobId!), deliverableHash, providerWallet);
  rec = { ...rec, status: "submitted", deliverableHash, deliverablePath: put.path, submitTxHash: submitTx };
  d.jobs.transaction(() => { d.jobs.upsert(rec!); d.jobs.recordEvent(d.jobKey, "submit", "submitted", submitTx, null); });
}
// Step 4: evaluator complete → USDC released to provider
if (rec.status === "submitted") {
  const completeTx = await d.job.complete(BigInt(rec.jobId!), ("0x" + "00".repeat(32)) as Hex);
  rec = { ...rec, status: "completed", completeTxHash: completeTx };
  d.jobs.transaction(() => { d.jobs.upsert(rec!); d.jobs.recordEvent(d.jobKey, "complete", "completed", completeTx, null); });
}
```

- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): runJob submit+complete steps"`

### Task 6.3: Saga — optional sweep + reputation (decoupled)

**Files:** Modify `runJob.ts`; Test `runJob.test.ts`

**Interfaces:**
- Produces: optional sweep (operator → treasury USDC transfer) recorded as an event + `sweepTxHash`; reputation step advances `completed → reputed`; **a reputation failure leaves status `completed` with a retryable `error`, never `failed`.**

- [ ] **Step 1: Write the failing tests**

```ts
test("reputation failure leaves job at completed (retryable), not failed", async () => {
  const db = new Database(":memory:"); migrate(db);
  const jobs = new SqliteJobRepository(db); const entities = new SqliteEntityRepository(db);
  seedBoundEntity(entities, "t:agent");
  const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:k", entityKey: "t:agent", budget: 500000n });
  deps.reputation.record = async () => { throw new Error("rep down"); };
  await runJob(deps); // must NOT throw
  const r = jobs.findByKey("t:k")!;
  expect(r.status).toBe("completed");
  expect(r.error).toContain("rep down");
});
test("reputation success advances to reputed", async () => {
  const db = new Database(":memory:"); migrate(db);
  const jobs = new SqliteJobRepository(db); const entities = new SqliteEntityRepository(db);
  seedBoundEntity(entities, "t:agent");
  const deps = makeRunJobDeps({ db, jobs, entities, jobKey: "t:k", entityKey: "t:agent", budget: 500000n });
  await runJob(deps);
  expect(jobs.findByKey("t:k")?.status).toBe("reputed");
});
```

- [ ] **Step 2: Run it** — Expected: FAIL (no sweep/reputation yet; failure path may throw).
- [ ] **Step 3: Append step 4.5 + step 5 (with decoupling)**

```ts
// Step 4.5 (optional): sweep earnings operator -> treasury
if (rec.status === "completed" && d.sweepToTreasury && !rec.sweepTxHash && entity.treasury) {
  const providerWallet = await d.providerWalletFor({ subOrgId: entity.turnkeySubOrgId!, operator: entity.operator! });
  const sweepTx = await d.job.transferUsdc(providerWallet, d.usdc, entity.treasury as Address, d.budget);
  rec = { ...rec, sweepTxHash: sweepTx };
  d.jobs.transaction(() => { d.jobs.upsert(rec!); d.jobs.recordEvent(d.jobKey, "sweep", "completed", sweepTx, null); });
}
// Step 5: reputation (best-effort; never unwinds settlement)
if (rec.status === "completed") {
  try {
    const repTx = await d.reputation.record(BigInt(entity.agentId!), 5, rec.deliverableHash as Hex);
    rec = { ...rec, status: "reputed", reputationTxHash: repTx, error: null };
    d.jobs.transaction(() => { d.jobs.upsert(rec!); d.jobs.recordEvent(d.jobKey, "reputation", "reputed", repTx, null); });
  } catch (e) {
    rec = { ...rec, error: `reputation pending: ${(e as Error).message}` };
    d.jobs.upsert(rec); // stays 'completed' — retryable
  }
}
return rec;
```
Add `transferUsdc(wallet: WalletClient, usdc: Address, to: Address, amount: bigint): Promise<Hex>` to `JobAdapter` (plain ERC-20 transfer via the given wallet — reuse the `erc20` transfer fragment).

- [ ] **Step 4: Run it** — Expected: PASS (both tests).
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): runJob optional sweep + decoupled reputation"`

---

## Phase 7 — JobRunner

### Task 7.1: JobRunner (start / reconcileInFlight / settled)

**Files:** Create `backend/src/jobs/jobRunner.ts`; Test `backend/test/jobs/jobRunner.test.ts`

**Interfaces:**
- Consumes: `JobRepository`, a `RunJobFn = (input: { jobKey; entityKey; tenantId?; budget: bigint; description: string }) => Promise<JobRecord>`.
- Produces: `class JobRunner` with `start(p): { jobKey; status }` (writes a `pending` row, runs in background, 409 if already in-flight/exists), `reconcileInFlight(): number`, `settled(): Promise<void>`. Mirrors `OnboardingRunner` (background run wrapper sets `failed` on throw unless terminal `reputed`/`completed`/`failed`).

- [ ] **Step 1: Write the failing test**

```ts
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { migrate } from "../../src/persistence/db";
import { SqliteJobRepository } from "../../src/jobs/jobRepository";
import { JobRunner } from "../../src/jobs/jobRunner";

test("start runs the saga and reaches a terminal status", async () => {
  const db = new Database(":memory:"); migrate(db);
  const jobs = new SqliteJobRepository(db);
  const runJobFn = async (i: { jobKey: string }) => { const r = jobs.findByKey(i.jobKey)!; const done = { ...r, status: "reputed" as const }; jobs.upsert(done); return done; };
  const runner = new JobRunner({ jobs, runJob: runJobFn });
  const { jobKey } = runner.start({ jobKey: "t:k", entityKey: "t:agent", tenantId: "0xT", budget: 1n, description: "d", clientAddress: "0xC", evaluatorAddress: "0xE", providerAddress: "0xP" });
  await runner.settled();
  expect(jobs.findByKey(jobKey)?.status).toBe("reputed");
});
```

- [ ] **Step 2: Run it** — Expected: FAIL.
- [ ] **Step 3: Implement** (mirror `OnboardingRunner`: `inFlight` Set, `pending[]`, `start` upserts a `pending` `JobRecord` then `run(...)`; `TERMINAL = ["reputed","failed"]`; background wrapper sets `failed` on throw if current status not terminal; `reconcileInFlight` re-runs rows in `listInFlight()`).

- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): JobRunner"`

---

## Phase 8 — Config

### Task 8.1: JOB_* config + .env.example

**Files:** Modify `backend/src/config/env.ts:17-46,48-81,93-134`; Modify `backend/.env.example`; Test `backend/test/config/jobConfig.test.ts`

**Interfaces:**
- Produces on `Config`: `jobContract: Address` (default `0x0747EEf0706327138c69792bF28Cd525089e4583`), `reputationRegistry: Address` (default from Task 0.1), `jobClientPrivateKey: Hex` (default = `platformPrivateKey`), `jobEvaluatorPrivateKey?: Hex`, `jobSweepToTreasury: boolean` (default false).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../src/config/env";
const base = { ARC_TESTNET_RPC_URL: "https://x.test", PLATFORM_PRIVATE_KEY: "0x" + "1".repeat(64) };
test("job config defaults", () => {
  const cfg = loadConfig(base as Record<string, string>);
  expect(cfg.jobContract).toBe("0x0747EEf0706327138c69792bF28Cd525089e4583");
  expect(cfg.jobClientPrivateKey).toBe(cfg.platformPrivateKey);
  expect(cfg.jobSweepToTreasury).toBe(false);
});
```

- [ ] **Step 2: Run it** — Expected: FAIL.
- [ ] **Step 3: Implement** — add `JOB_CONTRACT_ADDRESS` (addressSchema, default the proxy), `REPUTATION_REGISTRY_ADDRESS` (addressSchema, default Task-0.1 value), `JOB_CLIENT_PRIVATE_KEY` (privKeySchema optional), `JOB_EVALUATOR_PRIVATE_KEY` (privKeySchema optional), `JOB_SWEEP_TO_TREASURY` (`z.coerce.boolean().default(false)`) to `EnvSchema`; map onto `Config` (`jobClientPrivateKey: e.JOB_CLIENT_PRIVATE_KEY ?? e.PLATFORM_PRIVATE_KEY`). Add the keys + comments to `.env.example` including `ARC_JOB_LIVE`.

- [ ] **Step 4: Run it** — Expected: PASS. Also run `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): JOB_* config + .env.example"`

---

## Phase 9 — HTTP surface

### Task 9.1: JobView projection

**Files:** Create `backend/src/api/jobViews.ts`; Test `backend/test/api/jobViews.test.ts`

**Interfaces:**
- Produces: `interface JobView` (secret-free subset of `JobRecord`); `toJobView(r: JobRecord): JobView`.

- [ ] **Step 1–4: TDD** — test asserts `toJobView` maps `jobKey/jobId/status/.../reputationTxHash/error` and omits nothing secret (there are no secrets in `JobRecord`, so it's a faithful 1:1 projection; the View exists for API stability). Implement the mapper.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): JobView projection"`

### Task 9.2: Job routes + mount

**Files:** Create `backend/src/api/routes/jobs.ts`; Modify `backend/src/api/app.ts:32-38` (mount + `requireAuth`); Modify `backend/src/api/app.ts` `ApiDeps` (add `jobs: JobRepository`, `jobRunner: JobRunner`); Test `backend/test/api/jobs.routes.test.ts`

**Interfaces:**
- Consumes: `JobRunner`, `JobRepository`, `toJobView`, `requireAuth`, `usdToUnits`.
- Produces routes: `POST /entities/:id/jobs` (auth; body `{ budget?: string; description?: string }` → `202 { jobKey, status }`; guardian/tenant must own the entity); `GET /jobs/:jobKey` (auth; 404 if not owned); `GET /entities/:id/jobs` (auth; tenant-scoped list).

- [ ] **Step 1: Write the failing test** (Hono app with fake `jobRunner`/`jobs`/auth — mirror `backend/test/api/*` style: build the app via `buildApiApp` with fakes + a signed JWT, assert `202` + `{ jobKey }`, and `404` cross-tenant).

```ts
// asserts: POST /entities/:id/jobs returns 202 {jobKey}; GET /jobs/:jobKey returns the view;
// a different tenant's token gets 404 on both. (Use the existing test JWT helper.)
```

- [ ] **Step 2: Run it** — Expected: FAIL.
- [ ] **Step 3: Implement routes**

```ts
// backend/src/api/routes/jobs.ts
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { usdToUnits } from "../../policy/units";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";
import { toJobView } from "../jobViews";

export function mountJobRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.post("/entities/:id/jobs", async (c) => {
    const tenantId = c.get("tenantId");
    const entity = deps.repo.findByIdempotencyKey(c.req.param("id"));
    if (!entity || entity.ownerTenantId !== tenantId) throw new ApiError("not_found", 404, "entity not found");
    let body: { budget?: unknown; description?: unknown } = {};
    try { body = await c.req.json(); } catch { /* empty body ok */ }
    const budget = typeof body.budget === "string" ? usdToUnits(body.budget) : usdToUnits("1.00");
    const description = typeof body.description === "string" ? body.description : "demo job";
    const jobKey = `${entity.idempotencyKey}:${Date.now()}`; // entity.idempotencyKey already = `${tenantId}:${userKey}`
    const { status } = deps.jobRunner.start({ jobKey, entityKey: entity.idempotencyKey, tenantId, budget, description, clientAddress: deps.jobClientAddress, evaluatorAddress: deps.jobEvaluatorAddress, providerAddress: entity.operator ?? "0x" });
    return c.json({ jobKey, status }, 202);
  });
  app.get("/jobs/:jobKey", (c) => {
    const rec = deps.jobs.findByKey(c.req.param("jobKey"));
    if (!rec || rec.ownerTenantId !== c.get("tenantId")) throw new ApiError("not_found", 404, "job not found");
    return c.json(toJobView(rec));
  });
  // `:id` is the full entityKey (`${tenantId}:${userKey}`), exactly as in GET /entities/:id.
  app.get("/entities/:id/jobs", (c) =>
    c.json(deps.jobs.listByEntity(c.req.param("id")).filter((j) => j.ownerTenantId === c.get("tenantId")).map(toJobView)),
  );
}
```
In `app.ts`: extend `ApiDeps` with `jobs`, `jobRunner`, `jobClientAddress`, `jobEvaluatorAddress`; add `app.use("/jobs/*", requireAuth(...))`; call `mountJobRoutes(app, deps)` after `mountProtectedRoutes`. (The `/entities/*` routes are already auth-guarded.)

- [ ] **Step 4: Run it** — Expected: PASS. Run full `npm test` + `npx tsc --noEmit` + `npx biome check .`.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): job HTTP routes (trigger/poll/list)"`

---

## Phase 10 — CLI

### Task 10.1: run-job / get-job / list-jobs

**Files:** Modify `backend/src/cli/index.ts`; Test `backend/test/cli/jobCli.test.ts` (light — assert the command parses + dispatches via a fake)

**Interfaces:**
- Consumes: the composition root (Task 11.1 factory) — CLI builds the same `JobAdapter`/`ReputationAdapter`/repo/worker/runner.
- Produces: `run-job --entity <entityKey> [--budget 1.00] [--description "…"]` (runs `runJob` to completion, prints the final `JobView`); `get-job <jobKey>`; `list-jobs [--entity <entityKey>]`.

- [ ] **Step 1: Write the failing test** — parse `["run-job","--entity","t:agent","--budget","2.00"]` through the arg parser and assert it calls a injected `runJob` with `budget = usdToUnits("2.00")` and `entityKey="t:agent"`.
- [ ] **Step 2: Run it** — Expected: FAIL.
- [ ] **Step 3: Implement** the three subcommands in the existing CLI switch, reusing the composition-root factory from Task 11.1 and `usdToUnits`.
- [ ] **Step 4: Run it** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): run-job/get-job/list-jobs CLI"`

---

## Phase 11 — Composition root + live demo

### Task 11.1: Wire jobs into the API + CLI composition root

**Files:** Create `backend/src/jobs/composition.ts` (a `buildJobDeps(cfg, db, ...)` factory); Modify `backend/src/api/main.ts:74-88`; Test `backend/test/jobs/composition.test.ts` (smoke: factory builds without throwing when config present)

**Interfaces:**
- Produces: `buildJobDeps(cfg, db)` → `{ jobs, jobRunner, jobAdapter, reputationAdapter, worker, jobClientAddress, jobEvaluatorAddress, runJob }`, wiring: client wallet from `jobClientPrivateKey`, evaluator wallet from `jobEvaluatorPrivateKey`, `providerWalletFor = (e) => buildOperatorWalletClientForEntity(cfg, e)`, `worker = new TrivialWorker()`, `runJob` partially applied with these deps + `cfg.usdc`/`cfg.jobSweepToTreasury`.

- [ ] **Step 1: Write the failing test** — with a minimal `cfg` (turnkey present, evaluator key set), `buildJobDeps(cfg, db)` returns an object exposing `jobRunner.start` and `runJob`.
- [ ] **Step 2: Run it** — Expected: FAIL.
- [ ] **Step 3: Implement** the factory; in `main.ts` call it and pass `jobs`, `jobRunner`, `jobClientAddress`, `jobEvaluatorAddress` into `buildApiApp({...})`, and call `jobRunner.reconcileInFlight()` next to the onboarding reconcile.
- [ ] **Step 4: Run it** — Expected: PASS. Boot smoke: `npm run api` still logs `Wizard API listening on :8789`.
- [ ] **Step 5: Commit** — `git commit -m "feat(track-c): jobs composition root + API wiring"`

### Task 11.2: Live Arc-testnet e2e (the demo, gated)

**Files:** Create `backend/test/jobs.arc.live.test.ts`

**Interfaces:**
- Consumes: real config + a `bound` entity in the DB (an onboarded agent under the current Turnkey org), the live ERC-8183 Job + ReputationRegistry.
- Produces: a gated test that runs the full `runJob` against the real contracts and asserts `reputed` + provider USDC increased.

- [ ] **Step 1: Write the gated test**

```ts
import "dotenv/config";
import { describe, expect, test } from "vitest";
const gated = process.env.ARC_JOB_LIVE === "1";
const run = gated ? describe : describe.skip;
run("live ERC-8183 job loop", () => {
  test("agent earns USDC + reputation end-to-end", async () => {
    // build real deps via buildJobDeps(loadConfig(), openDatabase(cfg.dbPath));
    // pick a bound entityKey from the DB; pre-seed operator gas + client USDC per the runbook;
    // run runJob({...}); assert final status === 'reputed' and provider balance increased.
  }, 180_000);
});
```
Document the pre-reqs in the test header: client key funded with Arc USDC; operator EOA gas-seeded; evaluator key funded for gas; `JOB_EVALUATOR_PRIVATE_KEY` distinct from the provider.

- [ ] **Step 2: Run gated-off** — Run: `npx vitest run test/jobs.arc.live.test.ts` — Expected: SKIPPED.
- [ ] **Step 3: (manual, when ready) Run live** — `ARC_JOB_LIVE=1 npx vitest run test/jobs.arc.live.test.ts` against a funded agent — Expected: PASS, real USDC settled + reputation recorded.
- [ ] **Step 4: Commit** — `git commit -m "test(track-c): gated live Arc job e2e (demo)"`

---

## Final verification (after all tasks)

- [ ] `cd backend && npm test` — all deterministic tests green (live tests skipped)
- [ ] `npx tsc --noEmit` and `npx biome check .` — clean
- [ ] `npm run api` boots; `POST /entities/:id/jobs` → `202`; `GET /jobs/:jobKey` polls to `reputed`
- [ ] Update `docs/README.md` index with the design + plan + findings docs
- [ ] Open PR to `master` (rebased on `origin/master`)
</content>
