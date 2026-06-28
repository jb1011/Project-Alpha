import type { AgentRunStore, RunPaymentInput } from "../persistence/agentRunStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type { LiveRunResult } from "./liveRunner";

/** Persist one completed live run as a job receipt + its payments. Entity resolved from the treasury;
 *  falls back to the treasury address as the key so a run is never silently dropped. */
export function persistAgentRun(
  deps: { runs: AgentRunStore; entities: EntityRepository },
  treasury: string,
  query: string,
  result: LiveRunResult,
  payments: RunPaymentInput[],
): string {
  const entityKey = deps.entities.findByTreasury(treasury)?.idempotencyKey ?? treasury;
  return deps.runs.record(
    {
      entityKey,
      query,
      cost: result.totalCost.toString(),
      revenue: result.price.toString(),
      pnl: result.pnl.toString(),
      status: result.sold ? "completed" : "failed",
    },
    payments,
  );
}
