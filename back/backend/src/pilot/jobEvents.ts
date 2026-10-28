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
