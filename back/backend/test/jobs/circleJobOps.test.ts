import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, test, vi } from "vitest";
import { deterministicIdempotencyKey } from "../../src/adapters/circle/circleExec";
import { CIRCLE_REF_ID_MAX, CircleRefIdTooLongError } from "../../src/adapters/circle/circleRefId";
import { circleJobOps, jobRefIdParts } from "../../src/jobs/circleJobOps";
import type { JobOpAttempts } from "../../src/persistence/jobOpAttempts";
import type { Address } from "../../src/types";

/** In-memory JobOpAttempts — same contract as the sqlite-backed store. */
function makeAttempts(): JobOpAttempts & { bumps: string[] } {
  const m = new Map<string, number>();
  const bumps: string[] = [];
  return {
    bumps,
    get: (jobKey, step) => m.get(`${jobKey}|${step}`) ?? 0,
    bump: (jobKey, step) => {
      const k = `${jobKey}|${step}`;
      const next = (m.get(k) ?? 0) + 1;
      m.set(k, next);
      bumps.push(step);
      return next;
    },
  };
}

const JOB_CONTRACT = "0x1000000000000000000000000000000000000001" as Address;
const USDC = "0x2000000000000000000000000000000000000002" as Address;
const TREASURY = "0x3000000000000000000000000000000000000003" as Address;
/**
 * A REALISTIC job key, as every mint site produces one:
 * `<tenant address>:<entity key>:<timestamp>-<suffix>` — 102 characters, which is why
 * `job:<jobKey>:<step>` was 116 and Circle refused it with a bare "API parameter invalid".
 */
const TENANT = "0x172B7952b0F711b8B372410E81d51Dcba7D4BB02";
const ENTITY_UUID = "f251041a-4128-4674-9eab-eb6fb2503bd9";
const RUN_A = "1758531600000-9f3ab21c";
const RUN_B = "1758531999000-4c0de17b";
const MCP_JOB_KEY = `${TENANT}:${ENTITY_UUID}:${RUN_A}`;
const RUN_C = "1758532400000-7bb1e0da";
/** Two more runs of the SAME entity — distinct jobs, distinct refIds. */
const JOB_KEY_B = `${TENANT}:${ENTITY_UUID}:${RUN_B}`;
const JOB_KEY_C = `${TENANT}:${ENTITY_UUID}:${RUN_C}`;

function makeApi() {
  let n = 0;
  const submits: {
    contractAddress: string;
    callData: `0x${string}`;
    idempotencyKey: string;
    refId?: string;
  }[] = [];
  return {
    submits,
    createContractExecutionTransaction: vi.fn(async (input: (typeof submits)[number]) => {
      submits.push(input);
      n += 1;
      return { data: { id: `tx-${n}` } };
    }),
    getTransaction: vi.fn(async ({ id }: { id: string }) => ({
      data: {
        transaction: { id, state: "CONFIRMED", txHash: `0xhash-${id}`, networkFee: "0.002" },
      },
    })),
  };
}

const CONFIRM = { pollDelayMs: 0, timeoutMs: 1_000, sleep: async () => {} };

describe("circleJobOps", () => {
  test("setBudget/submit target the job contract with real ERC-8183 calldata", async () => {
    const api = makeApi();
    const ops = circleJobOps({
      api,
      operatorWalletId: "op-1",
      jobContract: JOB_CONTRACT,
      jobKey: MCP_JOB_KEY,
      attempts: makeAttempts(),
      confirm: CONFIRM,
    });

    await ops.setBudget(7n, 500_000n);
    await ops.submit(7n, `0x${"ab".repeat(32)}`);

    expect(api.submits.map((s) => s.contractAddress)).toEqual([JOB_CONTRACT, JOB_CONTRACT]);
    const setBudget = decodeFunctionData({
      abi: parseAbi(["function setBudget(uint256 jobId, uint256 amount, bytes optParams)"]),
      data: api.submits[0]!.callData,
    });
    expect(setBudget.args).toEqual([7n, 500_000n, "0x"]);
    const submit = decodeFunctionData({
      abi: parseAbi(["function submit(uint256 jobId, bytes32 deliverable, bytes optParams)"]),
      data: api.submits[1]!.callData,
    });
    expect(submit.args).toEqual([7n, `0x${"ab".repeat(32)}`, "0x"]);
  });

  test("idempotency seeds are per (jobKey, step) — crash-retry replays, never duplicates", async () => {
    const api = makeApi();
    const ops = circleJobOps({
      api,
      operatorWalletId: "op-1",
      jobContract: JOB_CONTRACT,
      jobKey: MCP_JOB_KEY,
      attempts: makeAttempts(),
      confirm: CONFIRM,
    });
    await ops.setBudget(7n, 500_000n);
    await ops.sweepToTreasury(USDC, TREASURY, 123n);
    expect(api.submits[0]!.idempotencyKey).toBe(
      deterministicIdempotencyKey(`job:${MCP_JOB_KEY}:setBudget:0`),
    );
    // Sweep seed carries the amount: a later retry after balances moved gets a FRESH key instead
    // of replaying a stale attempt.
    expect(api.submits[1]!.idempotencyKey).toBe(
      deterministicIdempotencyKey(`job:${MCP_JOB_KEY}:sweep:123:0`),
    );
  });

  test("sweep is a plain ERC-20 transfer from the SCA to the treasury", async () => {
    const api = makeApi();
    const ops = circleJobOps({
      api,
      operatorWalletId: "op-1",
      jobContract: JOB_CONTRACT,
      jobKey: MCP_JOB_KEY,
      attempts: makeAttempts(),
      confirm: CONFIRM,
    });
    const hash = await ops.sweepToTreasury(USDC, TREASURY, 490_000n);
    expect(hash).toBe("0xhash-tx-1");
    expect(api.submits[0]!.contractAddress).toBe(USDC);
    const transfer = decodeFunctionData({
      abi: parseAbi(["function transfer(address to, uint256 amount)"]),
      data: api.submits[0]!.callData,
    });
    expect(transfer.args).toEqual([TREASURY, 490_000n]);
  });

  test("records gas_sponsorship from confirmed fees", async () => {
    const api = makeApi();
    const recorded: { path: string; amount: bigint; ref: string | null }[] = [];
    const ops = circleJobOps({
      api,
      operatorWalletId: "op-1",
      jobContract: JOB_CONTRACT,
      jobKey: MCP_JOB_KEY,
      attempts: makeAttempts(),
      confirm: CONFIRM,
      outflows: { record: (path, amount, ref) => void recorded.push({ path, amount, ref }) },
    });
    await ops.setBudget(7n, 500_000n);
    expect(recorded).toEqual([{ path: "gas_sponsorship", amount: 2_000n, ref: "tx-1" }]);
  });
});

describe("circleJobOps — H1 key-burn escape hatch", () => {
  test("FAILED tx bumps the persisted attempt; the retry derives a FRESH idempotency key", async () => {
    const attempts = makeAttempts();
    let fail = true;
    const submits: { idempotencyKey: string }[] = [];
    const api = {
      createContractExecutionTransaction: vi.fn(async (input: { idempotencyKey: string }) => {
        submits.push(input);
        return { data: { id: `tx-${submits.length}` } };
      }),
      getTransaction: vi.fn(async ({ id }: { id: string }) => ({
        data: {
          transaction: fail
            ? { id, state: "FAILED", errorReason: "revert" }
            : { id, state: "CONFIRMED", txHash: `0xhash-${id}` },
        },
      })),
    };
    const ops = circleJobOps({
      api,
      operatorWalletId: "op-1",
      jobContract: JOB_CONTRACT,
      jobKey: JOB_KEY_B,
      attempts,
      confirm: CONFIRM,
    });

    await expect(ops.setBudget(1n, 100n)).rejects.toThrow(/terminal state FAILED/);
    expect(attempts.bumps).toEqual(["setBudget"]); // burned key ⇒ bumped

    fail = false;
    await ops.setBudget(1n, 100n); // retry succeeds with attempt 1
    expect(submits[0]!.idempotencyKey).toBe(
      deterministicIdempotencyKey(`job:${JOB_KEY_B}:setBudget:0`),
    );
    expect(submits[1]!.idempotencyKey).toBe(
      deterministicIdempotencyKey(`job:${JOB_KEY_B}:setBudget:1`),
    );
    expect(submits[0]!.idempotencyKey).not.toBe(submits[1]!.idempotencyKey);
  });

  test("a TIMEOUT does not bump — the same key must replay the still-in-flight tx", async () => {
    const attempts = makeAttempts();
    const api = {
      createContractExecutionTransaction: vi.fn(async () => ({ data: { id: "tx-1" } })),
      getTransaction: vi.fn(async () => ({
        data: { transaction: { id: "tx-1", state: "QUEUED" } },
      })),
    };
    const ops = circleJobOps({
      api,
      operatorWalletId: "op-1",
      jobContract: JOB_CONTRACT,
      jobKey: JOB_KEY_C,
      attempts,
      confirm: { pollDelayMs: 0, timeoutMs: 0, sleep: async () => {} },
    });
    await expect(ops.setBudget(1n, 100n)).rejects.toThrow(/not confirmed within/);
    expect(attempts.bumps).toEqual([]); // in flight — key stays valid, retry resumes THIS tx
  });
});

function opsFor(jobKey: string, api: ReturnType<typeof makeApi>) {
  return circleJobOps({
    api,
    operatorWalletId: "op-1",
    jobContract: JOB_CONTRACT,
    jobKey,
    attempts: makeAttempts(),
    confirm: CONFIRM,
  });
}

async function refIdsFor(jobKey: string): Promise<string[]> {
  const api = makeApi();
  const ops = opsFor(jobKey, api);
  await ops.setBudget(7n, 500_000n);
  await ops.submit(7n, `0x${"ab".repeat(32)}`);
  await ops.sweepToTreasury(USDC, TREASURY, 490_000n);
  return api.submits.map((s) => s.refId ?? "");
}

describe("circleJobOps — refIds stay inside Circle's 100-character ceiling", () => {
  test("every refId a realistic MCP job key produces fits, with the tenant address dropped", async () => {
    expect(MCP_JOB_KEY).toHaveLength(102); // the shape that broke it
    const refIds = await refIdsFor(MCP_JOB_KEY);
    expect(refIds).toEqual([
      `job:${ENTITY_UUID}:${RUN_A}:setBudget`,
      `job:${ENTITY_UUID}:${RUN_A}:submit`,
      `job:${ENTITY_UUID}:${RUN_A}:sweep:490000`,
    ]);
    for (const refId of refIds) expect(refId.length).toBeLessThanOrEqual(CIRCLE_REF_ID_MAX);
    // The tenant address is redundant for identification (the entity key is already unique) and
    // is exactly what pushed the refId over.
    for (const refId of refIds) expect(refId).not.toContain(TENANT);
  });

  test("distinct across steps AND across two jobs of the same entity", async () => {
    const a = await refIdsFor(MCP_JOB_KEY);
    const b = await refIdsFor(JOB_KEY_B);
    expect(new Set([...a, ...b]).size).toBe(6);
  });

  test("the idempotency seed still carries the WHOLE job key — hashed, so its length never mattered", async () => {
    // Changing the seed would re-key in-flight retries: a crash-retry would derive a different
    // UUID and fire a SECOND transaction instead of replaying the first.
    const api = makeApi();
    await opsFor(MCP_JOB_KEY, api).setBudget(7n, 500_000n);
    expect(api.submits[0]!.idempotencyKey).toBe(
      deterministicIdempotencyKey(`job:${MCP_JOB_KEY}:setBudget:0`),
    );
  });

  test("an entity key with no tenant-address prefix keeps the whole key", async () => {
    const refIds = await refIdsFor(`t:agent1:${RUN_A}`);
    expect(refIds[0]).toBe(`job:t:agent1:${RUN_A}:setBudget`);
  });

  test("a job key whose shape we do not recognise is REFUSED locally, never sent", async () => {
    const api = makeApi();
    // No run tail: the segment that makes a shortened refId unique per job run.
    expect(() => opsFor("j:1", api)).toThrow(/job key/i);
    expect(() => opsFor(`${TENANT}:${ENTITY_UUID}`, api)).toThrow(/job key/i);
    expect(() => opsFor(`${TENANT}::${RUN_A}`, api)).toThrow(/job key/i);
    expect(api.createContractExecutionTransaction).not.toHaveBeenCalled();
  });

  test("an entity key so long that even the bounded refId overflows is refused locally", async () => {
    const api = makeApi();
    const ops = opsFor(`${TENANT}:${"n".repeat(80)}:${RUN_A}`, api);
    await expect(ops.setBudget(7n, 500_000n)).rejects.toThrow(CircleRefIdTooLongError);
    expect(api.createContractExecutionTransaction).not.toHaveBeenCalled();
  });
});

describe("jobRefIdParts — the shapes a job key is minted in", () => {
  test("accepts `<tenant address>:<entity key>:<timestamp>-<suffix>` and drops the tenant", () => {
    expect(jobRefIdParts(MCP_JOB_KEY)).toEqual({ entity: ENTITY_UUID, run: RUN_A });
  });

  test("accepts `<entity key>:<timestamp>-<suffix>` with no tenant prefix", () => {
    expect(jobRefIdParts(`t:agent1:${RUN_A}`)).toEqual({ entity: "t:agent1", run: RUN_A });
    expect(jobRefIdParts(`solo:${RUN_A}`)).toEqual({ entity: "solo", run: RUN_A });
  });

  test("an entity key that merely LOOKS addressy is not mistaken for a tenant prefix", () => {
    expect(jobRefIdParts(`0xabc:agent1:${RUN_A}`)).toEqual({ entity: "0xabc:agent1", run: RUN_A });
  });

  test("refuses anything else, naming the shape it expected", () => {
    for (const bad of ["", "j:1", MCP_JOB_KEY.slice(0, -9), `${RUN_A}`, `x:${RUN_A}-extra`]) {
      expect(() => jobRefIdParts(bad)).toThrow(/job key/i);
    }
  });
});
