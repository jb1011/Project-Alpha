import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, test, vi } from "vitest";
import { deterministicIdempotencyKey } from "../../src/adapters/circle/circleExec";
import { circleJobOps } from "../../src/jobs/circleJobOps";
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

function makeApi() {
  let n = 0;
  const submits: { contractAddress: string; callData: `0x${string}`; idempotencyKey: string }[] =
    [];
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
      jobKey: "j:1",
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
      jobKey: "j:1",
      attempts: makeAttempts(),
      confirm: CONFIRM,
    });
    await ops.setBudget(7n, 500_000n);
    await ops.sweepToTreasury(USDC, TREASURY, 123n);
    expect(api.submits[0]!.idempotencyKey).toBe(deterministicIdempotencyKey("job:j:1:setBudget:0"));
    // Sweep seed carries the amount: a later retry after balances moved gets a FRESH key instead
    // of replaying a stale attempt.
    expect(api.submits[1]!.idempotencyKey).toBe(deterministicIdempotencyKey("job:j:1:sweep:123:0"));
  });

  test("sweep is a plain ERC-20 transfer from the SCA to the treasury", async () => {
    const api = makeApi();
    const ops = circleJobOps({
      api,
      operatorWalletId: "op-1",
      jobContract: JOB_CONTRACT,
      jobKey: "j:1",
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
      jobKey: "j:1",
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
      jobKey: "j:9",
      attempts,
      confirm: CONFIRM,
    });

    await expect(ops.setBudget(1n, 100n)).rejects.toThrow(/terminal state FAILED/);
    expect(attempts.bumps).toEqual(["setBudget"]); // burned key ⇒ bumped

    fail = false;
    await ops.setBudget(1n, 100n); // retry succeeds with attempt 1
    expect(submits[0]!.idempotencyKey).toBe(deterministicIdempotencyKey("job:j:9:setBudget:0"));
    expect(submits[1]!.idempotencyKey).toBe(deterministicIdempotencyKey("job:j:9:setBudget:1"));
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
      jobKey: "j:10",
      attempts,
      confirm: { pollDelayMs: 0, timeoutMs: 0, sleep: async () => {} },
    });
    await expect(ops.setBudget(1n, 100n)).rejects.toThrow(/not confirmed within/);
    expect(attempts.bumps).toEqual([]); // in flight — key stays valid, retry resumes THIS tx
  });
});
