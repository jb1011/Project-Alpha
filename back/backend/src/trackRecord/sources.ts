import type { Address, Hex, PublicClient } from "viem";
import type { ExternalRecordDeps } from "../api/routes/externalRecord";
import type { ExternalRecordConfig } from "../config/env";
import { fetchExplorerJson } from "./explorerLogs";
import { type ExternalRecordSources, readExternalRecord } from "./read";
import { fetchRecordText } from "./recordApi";
import { type ReadAllFeedbackResult, reputationReadAbi } from "./reputationRead";

export interface LiveSourceDeps {
  config: ExternalRecordConfig;
  /** The ordinary read client: these reads may retry, nothing waits behind them. */
  publicClient: PublicClient;
  /** The ERC-8004 Reputation registry (proxy), `cfg.reputationRegistry`. */
  registry: Address;
  /** The identity registry's `getMetadata`, `ArcAdapter.getAgentMetadata`. */
  readMetadata: (agentId: bigint, key: string) => Promise<Hex>;
  fetchImpl?: typeof fetch;
}

/** The four reads against the real chain, explorer and provider. */
export function liveExternalRecordSources(d: LiveSourceDeps): ExternalRecordSources {
  const fetchImpl = d.fetchImpl ?? fetch;
  return {
    readFeedback: (agentId, filter) =>
      d.publicClient.readContract({
        address: d.registry,
        abi: reputationReadAbi,
        functionName: "readAllFeedback",
        // The registry filters on the poster and both tags; `false` drops revoked posts.
        args: [agentId, [filter.poster], filter.tag1, filter.tag2, false],
      }) as Promise<ReadAllFeedbackResult>,
    readMetadata: d.readMetadata,
    readExplorerLogs: (url, signal) => fetchExplorerJson(fetchImpl, url, signal),
    readRecord: (address, signal) => fetchRecordText(fetchImpl, d.config.apiBase, address, signal),
  };
}

/** The route's dependency, built once by the composition root. */
export function externalRecordDeps(d: LiveSourceDeps): ExternalRecordDeps {
  const sources = liveExternalRecordSources(d);
  return {
    providerName: d.config.providerName,
    read: (agentId) =>
      readExternalRecord({ config: d.config, registry: d.registry, sources }, agentId),
  };
}
