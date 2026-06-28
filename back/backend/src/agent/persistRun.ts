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
  const matched = deps.entities.findByTreasury(treasury);
  if (!matched) {
    console.warn(
      `[activity] no entity matches treasury ${treasury}; recording run under the raw address — it will NOT appear in any dashboard. Set TREASURY_ADDRESS to an onboarded agent.`,
    );
  }
  const entityKey = matched?.idempotencyKey ?? treasury;
  // Honest receipt: a run that did not sell earned no revenue, so revenue is 0 and P&L is the full
  // cost as a loss. result.price / result.pnl carry the *asked* price even on a failed sell — never
  // persist those as earnings.
  const revenue = result.sold ? result.price.toString() : "0";
  const pnl = result.sold ? result.pnl.toString() : (-result.totalCost).toString();
  return deps.runs.record(
    {
      entityKey,
      query,
      cost: result.totalCost.toString(),
      revenue,
      pnl,
      status: result.sold ? "completed" : "failed",
    },
    payments,
  );
}
