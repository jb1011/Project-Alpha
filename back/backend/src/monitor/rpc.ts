import type { Abi, AbiEvent, Address, Hex, PublicClient } from "viem";

/**
 * The narrow chain surface the monitor needs, so the rules and the scan loop can be tested against
 * a plain object instead of a viem PublicClient with its generic machinery. The real client is
 * adapted once, at the composition root (`fromPublicClient`).
 *
 * READ-ONLY BY CONSTRUCTION: there is no wallet client, no `sendTransaction`, no account anywhere
 * in this module. The monitor observes; the admin acts.
 */

/** A log as the monitor consumes it: raw topics + data, decoded per-rule. */
export interface RawLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

export interface LogQuery {
  address?: Address | Address[];
  /** Optional server-side event filter (topic0 + indexed args). */
  event?: AbiEvent;
  args?: Record<string, unknown>;
  fromBlock: bigint;
  toBlock: bigint;
}

export interface MonitorRpc {
  getBlockNumber(): Promise<bigint>;
  getLogs(query: LogQuery): Promise<RawLog[]>;
  /** Block timestamp in SECONDS, as the chain reports it. */
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
  readContract(p: {
    address: Address;
    abi: Abi | readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
}

export function fromPublicClient(client: PublicClient): MonitorRpc {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    async getLogs(q) {
      // viem's getLogs overloads are keyed on a CONST generic `event`, which a runtime-selected
      // AbiEvent cannot satisfy. We only ever consume raw topics + data (RawLog), so the widening
      // costs nothing: no decoded-args type is being thrown away here.
      const logs = (await client.getLogs(
        q as unknown as Parameters<typeof client.getLogs>[0],
      )) as unknown as RawLog[];
      return logs.map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: l.blockNumber,
        transactionHash: l.transactionHash,
        logIndex: l.logIndex,
      }));
    },
    async getBlockTimestamp(blockNumber) {
      const block = await client.getBlock({ blockNumber });
      return block.timestamp;
    },
    readContract: (p) =>
      client.readContract({
        address: p.address,
        abi: p.abi as Abi,
        functionName: p.functionName,
        args: p.args as unknown[],
      }),
  };
}
