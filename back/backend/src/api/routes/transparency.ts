import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import type { ApiDeps } from "../app";

/** A job is "settled" once escrowed USDC has paid out on-chain. `reputed` is a settled job that
 *  also earned reputation — same canonical definition as routes/reputation.ts. */
const SETTLED = new Set(["completed", "reputed"]);

/** Public, unauthenticated transparency surface: the platform's on-chain footprint as one JSON.
 *  Everything served here is either already public on Arc (addresses, agent ids, settled jobs) or
 *  already published per-entity via GET /metadata/:publicId (name, humanVerified, credential).
 *  Deliberately NOT included: idempotency keys and tenant ids (they encode tenant identity),
 *  operator/guardian wallets, and anything about in-flight or failed onboardings. */
export function mountTransparencyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  app.get("/transparency", (c) => {
    const entities = deps.repo.listPublicOnChain();
    const jobs = deps.jobs.list();

    const settledByEntity = new Map<string, { jobs: number; usdcAtomic: bigint }>();
    let jobsSettled = 0;
    let usdcSettledAtomic = 0n;
    for (const j of jobs) {
      if (!SETTLED.has(j.status)) continue;
      jobsSettled += 1;
      const amount = BigInt(j.budgetAmount);
      usdcSettledAtomic += amount;
      const agg = settledByEntity.get(j.entityKey) ?? { jobs: 0, usdcAtomic: 0n };
      agg.jobs += 1;
      agg.usdcAtomic += amount;
      settledByEntity.set(j.entityKey, agg);
    }

    const rows = entities.map((e) => {
      const gv =
        deps.worldId && e.ownerTenantId
          ? deps.worldId.store.findByTenant(e.ownerTenantId, deps.worldId.cfg.action)
          : undefined;
      const agg = settledByEntity.get(e.idempotencyKey);
      return {
        publicId: e.publicId,
        name: e.name,
        agentId: e.agentId,
        status: e.status,
        legalManager: e.proxy,
        treasury: e.treasury,
        // null = legacy pre-Tier-0 row, same "behaves as turnkey" convention as EntityView.
        walletProvider: e.walletProvider ?? "turnkey",
        // A waiver grants access, not personhood: it is on record (credential "waiver") but
        // never human-verified — the same rule GET /metadata/:publicId applies, so the two
        // public surfaces cannot disagree about the same guardian.
        humanVerified: Boolean(gv) && gv?.credential !== "waiver",
        credential: gv?.credential ?? null,
        createdAt: e.createdAt,
        jobsSettled: agg?.jobs ?? 0,
        usdcSettledAtomic: (agg?.usdcAtomic ?? 0n).toString(),
      };
    });

    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      stats: {
        entities: rows.length,
        jobsSettled,
        usdcSettledAtomic: usdcSettledAtomic.toString(),
      },
      entities: rows,
    });
  });
}
