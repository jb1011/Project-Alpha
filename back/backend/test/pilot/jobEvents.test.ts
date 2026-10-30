/**
 * The deployed job contract's `JobSubmitted` event: its signature pinned against the one the
 * contract declares, and the deliverable read from a receipt's logs.
 */
import {
  type Address,
  type Hex,
  type Log,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toBytes,
  toEventSelector,
} from "viem";
import { describe, expect, test } from "vitest";
import {
  createdJobIdOf,
  jobCreatedEventAbi,
  jobSubmittedEventAbi,
  submittedDeliverableOf,
} from "../../src/pilot/jobEvents";

const JOB_CONTRACT = "0x0000000000000000000000000000000000000004" as Address;
const OTHER_CONTRACT = "0x0000000000000000000000000000000000000005" as Address;
const PROVIDER = "0x00000000000000000000000000000000000000aa" as Address;
const HASH_A = `0x${"ab".repeat(32)}` as Hex;
const HASH_B = `0x${"cd".repeat(32)}` as Hex;

/** A `JobSubmitted` log as a receipt carries it. */
function jobSubmittedLog(o: { address?: Address; jobId: bigint; deliverable: Hex }): Log {
  return {
    address: o.address ?? JOB_CONTRACT,
    topics: encodeEventTopics({
      abi: jobSubmittedEventAbi,
      eventName: "JobSubmitted",
      args: { jobId: o.jobId, provider: PROVIDER },
    }) as Log["topics"],
    data: encodeAbiParameters([{ type: "bytes32" }], [o.deliverable]),
    blockNumber: 1n,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"22".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

describe("the JobSubmitted event", () => {
  test("its selector is the deployed contract's JobSubmitted(uint256,address,bytes32)", () => {
    expect(toEventSelector(jobSubmittedEventAbi[0])).toBe(
      keccak256(toBytes("JobSubmitted(uint256,address,bytes32)")),
    );
  });

  test("the job id and the provider are indexed, the deliverable is not", () => {
    expect(jobSubmittedEventAbi[0].inputs.map((i) => [i.name, i.indexed])).toEqual([
      ["jobId", true],
      ["provider", true],
      ["deliverable", false],
    ]);
  });
});

describe("submittedDeliverableOf", () => {
  test("returns the deliverable of the job contract's log for that job", () => {
    const logs = [
      jobSubmittedLog({ jobId: 6n, deliverable: HASH_B }),
      jobSubmittedLog({ jobId: 7n, deliverable: HASH_A }),
    ];
    expect(submittedDeliverableOf(logs, JOB_CONTRACT, 7n)).toBe(HASH_A);
    expect(submittedDeliverableOf(logs, JOB_CONTRACT, 6n)).toBe(HASH_B);
  });

  test("ignores another contract's log with the same topics, matching the address in any case", () => {
    const logs = [
      jobSubmittedLog({ address: OTHER_CONTRACT, jobId: 7n, deliverable: HASH_B }),
      jobSubmittedLog({ jobId: 7n, deliverable: HASH_A }),
    ];
    expect(submittedDeliverableOf(logs, JOB_CONTRACT.toUpperCase(), 7n)).toBe(HASH_A);
    expect(submittedDeliverableOf(logs.slice(0, 1), JOB_CONTRACT, 7n)).toBeUndefined();
  });

  test("returns undefined when the receipt holds no log for the job", () => {
    expect(submittedDeliverableOf([], JOB_CONTRACT, 7n)).toBeUndefined();
    expect(
      submittedDeliverableOf(
        [jobSubmittedLog({ jobId: 6n, deliverable: HASH_A })],
        JOB_CONTRACT,
        7n,
      ),
    ).toBeUndefined();
  });

  test("two logs that agree give that deliverable; two that disagree throw", () => {
    const agree = [
      jobSubmittedLog({ jobId: 7n, deliverable: HASH_A }),
      jobSubmittedLog({ jobId: 7n, deliverable: HASH_A }),
    ];
    expect(submittedDeliverableOf(agree, JOB_CONTRACT, 7n)).toBe(HASH_A);
    const disagree = [
      jobSubmittedLog({ jobId: 7n, deliverable: HASH_A }),
      jobSubmittedLog({ jobId: 7n, deliverable: HASH_B }),
    ];
    expect(() => submittedDeliverableOf(disagree, JOB_CONTRACT, 7n)).toThrow(
      /different deliverable hashes/,
    );
  });
});

const CLIENT = "0x00000000000000000000000000000000000000c1" as Address;
const EVALUATOR = "0x00000000000000000000000000000000000000e1" as Address;
const HOOK = "0x0000000000000000000000000000000000000000" as Address;
const EXPIRES = 1_800_000_000n;
const OURS = { client: CLIENT, provider: PROVIDER, evaluator: EVALUATOR, expiredAt: EXPIRES };

/** A `JobCreated` log as a receipt carries it, ours unless a field is overridden. */
function jobCreatedLog(o: {
  address?: Address;
  jobId: bigint;
  client?: Address;
  provider?: Address;
  evaluator?: Address;
  expiredAt?: bigint;
}): Log {
  return {
    address: o.address ?? JOB_CONTRACT,
    topics: encodeEventTopics({
      abi: jobCreatedEventAbi,
      eventName: "JobCreated",
      args: { jobId: o.jobId, client: o.client ?? CLIENT, provider: o.provider ?? PROVIDER },
    }) as Log["topics"],
    data: encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "address" }],
      [o.evaluator ?? EVALUATOR, o.expiredAt ?? EXPIRES, HOOK],
    ),
    blockNumber: 1n,
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: `0x${"33".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

describe("the JobCreated event", () => {
  test("its topic0 is the deployed contract's JobCreated(uint256,address,address,address,uint256,address)", () => {
    const selector = toEventSelector(jobCreatedEventAbi[0]);
    expect(selector).toBe(
      keccak256(toBytes("JobCreated(uint256,address,address,address,uint256,address)")),
    );
    expect(selector).toBe("0xb0f0239bfdd96453e24733e18bfc24b70d8fadf123dd977473518dd577ee79b9");
  });

  test("the job id, the client and the provider are indexed; the rest are not", () => {
    expect(jobCreatedEventAbi[0].inputs.map((i) => [i.name, i.indexed])).toEqual([
      ["jobId", true],
      ["client", true],
      ["provider", true],
      ["evaluator", false],
      ["expiredAt", false],
      ["hook", false],
    ]);
  });
});

describe("createdJobIdOf", () => {
  test("returns the id of the job contract's log whose parties and expiry are ours", () => {
    expect(createdJobIdOf([jobCreatedLog({ jobId: 9n })], JOB_CONTRACT, OURS)).toBe(9n);
  });

  test.each<[string, Parameters<typeof jobCreatedLog>[0]]>([
    ["another contract", { address: OTHER_CONTRACT, jobId: 9n }],
    ["another client", { jobId: 9n, client: EVALUATOR }],
    ["another provider", { jobId: 9n, provider: EVALUATOR }],
    ["another evaluator", { jobId: 9n, evaluator: CLIENT }],
    ["another expiry", { jobId: 9n, expiredAt: EXPIRES + 1n }],
  ])("ignores a log from %s", (_n, log) => {
    expect(createdJobIdOf([jobCreatedLog(log)], JOB_CONTRACT, OURS)).toBeUndefined();
  });

  test("picks ours among others, matching addresses in any letter case", () => {
    const logs = [
      jobCreatedLog({ jobId: 8n, client: EVALUATOR }),
      jobCreatedLog({ jobId: 9n }),
      jobCreatedLog({ address: OTHER_CONTRACT, jobId: 10n }),
    ];
    const upper = {
      client: CLIENT.toUpperCase(),
      provider: PROVIDER.toUpperCase(),
      evaluator: EVALUATOR.toUpperCase(),
      expiredAt: EXPIRES,
    };
    expect(createdJobIdOf(logs, JOB_CONTRACT.toUpperCase(), upper)).toBe(9n);
  });

  test("returns undefined with no log and with a log of another shape", () => {
    expect(createdJobIdOf([], JOB_CONTRACT, OURS)).toBeUndefined();
    expect(
      createdJobIdOf([jobSubmittedLog({ jobId: 9n, deliverable: HASH_A })], JOB_CONTRACT, OURS),
    ).toBeUndefined();
  });

  test("throws when two logs match", () => {
    const logs = [jobCreatedLog({ jobId: 9n }), jobCreatedLog({ jobId: 10n })];
    expect(() => createdJobIdOf(logs, JOB_CONTRACT, OURS)).toThrow(/2 JobCreated logs/);
  });
});
