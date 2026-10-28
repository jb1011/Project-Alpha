import type { Hono } from "hono";
import { getAddress } from "viem";
import { z } from "zod";
import type { AuthVars } from "../../auth/middleware";
import { computePolicyId } from "../../policy/policyId";
import { usdToUnits } from "../../policy/units";
import type { Address } from "../../types";
import type { ApiDeps } from "../app";
import { ApiError } from "../errors";

const ScheduleBody = z.object({
  capUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  periodSeconds: z.coerce.number().int().positive(),
  allowlistOn: z.boolean(),
  payoutAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

/** Manager-signed treasury policy changes (cap/period). Guardian actions stay client-side (wagmi). */
export function mountPolicyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  /**
   * The vault AND the manager it obeys. `AgentTreasury.manager` is immutable, so an agent minted
   * before the NoviController cutover is still managed by the old platform EOA: the adapter needs
   * this agent's OWN manager to decide whether the call relays through the controller or goes
   * direct. Reading the treasury without it would relay every legacy agent's policy update into a
   * `NotManager` revert.
   */
  function ownedTreasury(id: string, tenantId: string): { treasury: Address; manager: Address } {
    const rec = deps.repo.findByIdempotencyKey(id);
    if (!rec || rec.ownerTenantId !== tenantId)
      throw new ApiError("not_found", 404, "entity not found");
    if (!rec.treasury) throw new ApiError("not_ready", 409, "treasury not deployed yet");
    return { treasury: rec.treasury as Address, manager: rec.manager as Address };
  }

  app.post("/entities/:id/policy", async (c) => {
    const id = c.req.param("id");
    const { treasury, manager } = ownedTreasury(id, c.get("tenantId"));
    const b = ScheduleBody.parse(await c.req.json());
    const change = {
      newCap: usdToUnits(b.capUsdc),
      newPeriod: BigInt(b.periodSeconds),
      allowlistOn: b.allowlistOn,
      newPayout: b.payoutAddress as Address,
    };
    // Confirmed on chain when it returns (`sendManagerCallConfirmed`).
    const txHash = await deps.arc.schedulePolicyUpdate(treasury, change, manager);
    // Remember what was scheduled, so the pending change survives a page reload (design
    // 2026-10-23, section 4.5). The id is the treasury's own, computed from the same tuple; the
    // interface shows the record only after the treasury confirms it is still pending.
    // Checksummed first: viem refuses a mixed-case address with a wrong checksum, and a throw here,
    // after the transaction, would answer an error for a change that is scheduled.
    const payout = getAddress(change.newPayout);
    deps.repo.setScheduledPolicy(id, {
      policyId: computePolicyId({
        cap: change.newCap,
        period: change.newPeriod,
        allowlistOn: change.allowlistOn,
        payout,
      }),
      cap: change.newCap.toString(),
      period: change.newPeriod.toString(),
      allowlistOn: change.allowlistOn,
      payout,
      txHash,
      scheduledAt: new Date((deps.now ?? Date.now)()).toISOString(),
    });
    return c.json({ txHash });
  });

  app.post("/entities/:id/policy/execute", async (c) => {
    const id = c.req.param("id");
    const { treasury, manager } = ownedTreasury(id, c.get("tenantId"));
    const { policyId } = z
      .object({ policyId: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
      .parse(await c.req.json());
    const txHash = await deps.arc.executePolicyUpdate(treasury, policyId as `0x${string}`, manager);
    // The executed change is no longer pending. Only the matching record is cleared: executing
    // some other id leaves the record of this backend's own schedule for the chain to judge.
    const scheduled = deps.repo.findByIdempotencyKey(id)?.scheduledPolicy;
    if (scheduled && scheduled.policyId.toLowerCase() === policyId.toLowerCase())
      deps.repo.setScheduledPolicy(id, null);
    return c.json({ txHash });
  });
}
