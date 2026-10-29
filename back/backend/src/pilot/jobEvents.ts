import { type Hex, type Log, parseEventLogs } from "viem";

/**
 * The job contract's `JobSubmitted` event, as the deployed contract declares it.
 *
 * The job contract on Arc testnet (0x0747EEf0706327138c69792bF28Cd525089e4583) is an upgradeable
 * proxy to the verified `AgenticCommerce` implementation at
 * 0xA316fd02827242D537F84730F8a37D0BA5fd351a, whose ABI declares
 * `JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)`. The
 * backend's interface ABI (`iErc8183JobAbi`) declares no events, and the local mock emits a
 * different `Submitted(jobId, deliverable)`, so this is the one definition the pilot reads the
 * submit's log with.
 */
export const jobSubmittedEventAbi = [
  {
    type: "event",
    name: "JobSubmitted",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "deliverable", type: "bytes32", indexed: false },
    ],
  },
] as const;

/**
 * The deliverable hash a submit put on chain, read from its receipt's logs: the `deliverable` of
 * the `JobSubmitted` log that `jobContract` emitted for `jobId`, or undefined when the receipt
 * holds no such log (for example a contract that emits another shape). Logs of other contracts
 * and other jobs are ignored. Throws when two such logs carry different hashes, since the
 * receipt then does not say which one the job holds. No chain read: pass `receipt.logs`.
 */
export function submittedDeliverableOf(
  logs: readonly Log[],
  jobContract: string,
  jobId: bigint,
): Hex | undefined {
  const found = parseEventLogs({ abi: jobSubmittedEventAbi, logs: [...logs] })
    .filter((l) => l.address.toLowerCase() === jobContract.toLowerCase() && l.args.jobId === jobId)
    .map((l) => l.args.deliverable.toLowerCase() as Hex);
  const distinct = [...new Set(found)];
  if (distinct.length > 1)
    throw new Error(
      `the receipt holds ${distinct.length} JobSubmitted logs for job ${jobId} with different deliverable hashes: ${distinct.join(", ")}`,
    );
  return distinct[0];
}

/**
 * The job contract's `JobCreated` event, as the deployed `AgenticCommerce` implementation (see
 * {jobSubmittedEventAbi}) declares it:
 * `JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address
 * evaluator, uint256 expiredAt, address hook)`. The local mock emits a `JobCreated` of another
 * shape (three indexed fields), which this definition never matches.
 */
export const jobCreatedEventAbi = [
  {
    type: "event",
    name: "JobCreated",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "client", type: "address", indexed: true },
      { name: "provider", type: "address", indexed: true },
      { name: "evaluator", type: "address", indexed: false },
      { name: "expiredAt", type: "uint256", indexed: false },
      { name: "hook", type: "address", indexed: false },
    ],
  },
] as const;

/**
 * The id of the job a create made, read from its receipt's logs: the `jobId` of the one
 * `JobCreated` log that `jobContract` emitted whose client, provider, evaluator and expiry are
 * the ones given. Undefined when there is none (for example a contract that emits another
 * shape); throws when two match, since the receipt then does not say which job is ours. No
 * chain read: pass `receipt.logs`. A simulated id can name another job on a busy contract; this
 * one is the job that was mined.
 */
export function createdJobIdOf(
  logs: readonly Log[],
  jobContract: string,
  ours: { client: string; provider: string; evaluator: string; expiredAt: bigint },
): bigint | undefined {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const ids = parseEventLogs({ abi: jobCreatedEventAbi, logs: [...logs] })
    .filter(
      (l) =>
        same(l.address, jobContract) &&
        same(l.args.client, ours.client) &&
        same(l.args.provider, ours.provider) &&
        same(l.args.evaluator, ours.evaluator) &&
        l.args.expiredAt === ours.expiredAt,
    )
    .map((l) => l.args.jobId);
  if (ids.length > 1)
    throw new Error(
      `the receipt holds ${ids.length} JobCreated logs that match this job: ids ${ids.join(", ")}`,
    );
  return ids[0];
}
