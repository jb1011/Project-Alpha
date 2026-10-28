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
import { jobSubmittedEventAbi, submittedDeliverableOf } from "../../src/pilot/jobEvents";

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
