import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { formationSummary } from "../../formation/status";
import type { PublicEntityRow } from "../../persistence/entityRepository";
import type { ApiDeps } from "../app";
import { metadataBaseOf } from "./metadata";

/** A job is "settled" once escrowed USDC has paid out on-chain. `reputed` is a settled job that
 *  also earned reputation — same canonical definition as routes/reputation.ts. */
const SETTLED = new Set(["completed", "reputed"]);

/**
 * The Hedera facts a row may carry, or nothing at all.
 *
 * ON THE ROW on purpose: the public page renders a HashScan link per entity, and reading these
 * three strings off `/metadata/:publicId` instead cost one uncached request PER ROW through the
 * www proxy (which drops this route's caching headers) every time the page was opened.
 *
 * Gated exactly like the `hedera` block in `routes/metadata.ts`: this deployment must actually run
 * the rail (`deps.hedera`), and the entity must hold a recorded registration. An absent fact is an
 * ABSENT KEY, never a null — a null reads as "checked, and there is none" where the truth is that
 * nothing was ever registered. The PAID `/verify` url is deliberately not here: this is the free
 * public surface, and a link that answers 402 does not belong on it.
 */
function hederaFactsOf(deps: ApiDeps, e: PublicEntityRow, base: string | null) {
  if (!deps.hedera || !e.hederaAgentId) return undefined;
  // The profile route 404s without a UAID — that is the identifier an HCS-11 reader resolves the
  // document BY — so the url is published only once the entity has one. Same base, and so the
  // same host, as every other per-entity public link (`metadataBaseOf`).
  const profileUrl =
    base && e.publicId && e.uaid ? `${base}/metadata/${e.publicId}/profile` : undefined;
  return {
    agentId: e.hederaAgentId,
    ...(e.hederaRegisterTx ? { registerTx: e.hederaRegisterTx } : {}),
    ...(profileUrl ? { profileUrl } : {}),
    ...(e.uaid ? { uaid: e.uaid } : {}),
  };
}

/** Public, unauthenticated transparency surface: the platform's on-chain footprint as one JSON.
 *  Everything served here is either already public on Arc (addresses, agent ids, settled jobs) or
 *  already published per-entity via GET /metadata/:publicId (name, humanVerified, credential).
 *  Deliberately NOT included: idempotency keys and tenant ids (they encode tenant identity),
 *  operator/guardian wallets, anything about in-flight or failed onboardings — and, since
 *  formation landed, EVERYTHING about the natural person behind an entity (name, email, address,
 *  the partyId that would let one be looked up) together with the EIN and the filing number. The
 *  EIN is the entity owner's tax identifier and is served only to an authenticated owner; the
 *  formation block below carries a derived status and the environment, which are exactly the two
 *  facts the honesty invariant requires a stranger to be able to see. */
export function mountTransparencyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps) {
  /**
   * A very short in-process cache (M5).
   *
   * This route reads every public entity, every job, and now every formation, and it is
   * UNAUTHENTICATED — it is the one surface where request volume is not bounded by how many
   * tenants exist. Ten seconds is chosen to be shorter than anything a human would notice and
   * long enough that a burst (a link doing the rounds, a crawler, a status page polling) costs
   * one pass rather than one per request. The response already advertises `max-age=300` to
   * intermediaries, so the freshness contract is unchanged; this only stops the process doing the
   * work again for a browser that ignored it.
   */
  const CACHE_TTL_MS = 10_000;
  let cached: { at: number; body: unknown } | undefined;

  app.get("/transparency", (c) => {
    const now = (deps.now ?? Date.now)();
    if (cached && now - cached.at < CACHE_TTL_MS) {
      c.header("Cache-Control", "public, max-age=300");
      return c.json(cached.body as Record<string, unknown>);
    }
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

    // ONE formation read for the whole page (M5) — this route used to run a `stepsOf` query per
    // entity, on a public endpoint.
    // De-duplicated by COMPANY: under N:1 a page of agents may share one filing, and asking for
    // its steps once per agent is the N+1 this batch exists to remove.
    const companyIds = [
      ...new Set(entities.map((e) => e.companyId).filter((c): c is string => !!c)),
    ];
    const stepsByCompany = deps.formationStepsMany?.(companyIds);
    const companiesById = deps.companyMany?.(companyIds);
    const stepsOf = (companyId: string) =>
      stepsByCompany
        ? (stepsByCompany.get(companyId) ?? [])
        : (deps.formationSteps?.(companyId) ?? []);
    const companyOf = (companyId: string) =>
      companiesById ? companiesById.get(companyId) : deps.company?.(companyId);

    // ONE base for the whole page, like the formation batch above: it is the same string for
    // every row.
    const metadataBase = metadataBaseOf(deps);

    const rows = entities.map((e) => {
      const gv =
        deps.worldId && e.ownerTenantId
          ? deps.worldId.store.findByTenant(e.ownerTenantId, deps.worldId.cfg.action)
          : undefined;
      const agg = settledByEntity.get(e.idempotencyKey);
      // The SAME derivation the authenticated view uses, minus everything it may not serve.
      const formation = e.companyId
        ? formationSummary(companyOf(e.companyId), stepsOf(e.companyId))
        : null;
      const hedera = hederaFactsOf(deps, e, metadataBase);
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
        // Formation (design §8). Present only for an entity actually pinned to a provider;
        // null for every legacy/stub row, forever. `environment` is inseparable from the
        // status: a sandbox filing must read as a demo here too, not as a Wyoming company.
        formation: formation
          ? { status: formation.status, environment: formation.environment }
          : null,
        // Spread, not `hedera: … ?? null`: an entity with no Hedera registration carries no key
        // here at all (see `hederaFactsOf`).
        ...(hedera ? { hedera } : {}),
        jobsSettled: agg?.jobs ?? 0,
        usdcSettledAtomic: (agg?.usdcAtomic ?? 0n).toString(),
      };
    });

    const body = {
      stats: {
        entities: rows.length,
        jobsSettled,
        usdcSettledAtomic: usdcSettledAtomic.toString(),
      },
      entities: rows,
    };
    cached = { at: now, body };
    c.header("Cache-Control", "public, max-age=300");
    return c.json(body);
  });
}
