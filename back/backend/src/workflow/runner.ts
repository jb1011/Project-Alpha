import type { GuardianPasskey } from "../adapters/turnkey/provisioner";
import { ApiError } from "../api/errors";
import type { EntityRepository } from "../persistence/entityRepository";
import type { AgentSpec } from "../policy/agentSpec";
import type { Address, EntityRecord, EntityStatus } from "../types";

export type RunSaga = (input: {
  spec: AgentSpec;
  idempotencyKey: string;
  tenantId: string;
  guardianPasskey?: GuardianPasskey;
  specJson: string;
  fundAmount?: bigint;
}) => Promise<EntityRecord>;

const TERMINAL: EntityStatus[] = ["bound", "funded", "failed"];

/** Drives the resumable onboarding saga in-process: immediate pending record + background run. */
export class OnboardingRunner {
  private readonly inFlight = new Set<string>();
  private readonly pending: Promise<unknown>[] = [];

  constructor(
    private readonly deps: {
      repo: EntityRepository;
      runSaga: RunSaga;
      fundCaps: { perCall: bigint; perTenantTotal: bigint };
    },
  ) {}

  start(p: {
    spec: AgentSpec;
    userKey: string;
    tenantId: string;
    guardianPasskey: GuardianPasskey;
  }): {
    id: string;
    status: EntityStatus;
  } {
    const id = `${p.tenantId}:${p.userKey}`;
    const specJson = JSON.stringify(p.spec);
    const initial: EntityRecord = {
      idempotencyKey: id,
      name: p.spec.name,
      status: "pending",
      manager: p.spec.roles.manager as Address,
      guardian: p.tenantId as Address,
      operator: null,
      amendmentDelay: "0",
      ein: "",
      formationDate: 0,
      oaHash: null,
      metadataURI: null,
      docPath: null,
      treasuryConfig: null,
      agentId: null,
      proxy: null,
      treasury: null,
      createTxHash: null,
      bindTxHash: null,
      fundTxHash: null,
      ownerTenantId: p.tenantId,
      error: null,
      specJson,
    };
    // Atomic claim: the INSERT-or-nothing is the single gate. Two concurrent starts (or processes
    // racing the same key) can never both win — the loser sees changes()==0 and gets a 409, before
    // any on-chain side effect. Replaces the old non-atomic inFlight/find pre-check.
    if (!this.deps.repo.claimKey(initial))
      throw new ApiError("conflict", 409, `onboarding already exists for "${p.userKey}"`);
    this.run(id, () =>
      this.deps.runSaga({
        spec: p.spec,
        idempotencyKey: id,
        tenantId: p.tenantId,
        guardianPasskey: p.guardianPasskey,
        specJson,
      }),
    );
    return { id, status: "pending" };
  }

  fund(p: { id: string; tenantId: string; amount: bigint }): { id: string; status: EntityStatus } {
    const rec = this.deps.repo.findByIdempotencyKey(p.id);
    if (!rec || rec.ownerTenantId !== p.tenantId)
      throw new ApiError("not_found", 404, "entity not found");
    // Re-fundable: a "bound" entity can be funded for the first time, and a "funded" one can be
    // topped up again (fundTreasury just moves more USDC in) — audit fix B-safe. Every other status
    // (pending/provisioned/translating/created/failed) is still a 409: the entity isn't bound yet.
    if (rec.status !== "bound" && rec.status !== "funded")
      throw new ApiError(
        "conflict",
        409,
        `cannot fund in status "${rec.status}" (must be "bound" or "funded")`,
      );
    if (this.inFlight.has(p.id)) throw new ApiError("conflict", 409, "entity is busy");
    if (p.amount <= 0n) throw new ApiError("validation_error", 400, "amount must be positive");
    if (p.amount > this.deps.fundCaps.perCall)
      throw new ApiError("limit_exceeded", 400, "amount exceeds the max treasury fund per call");
    const funded = this.deps.repo.sumFundedByTenant(p.tenantId);
    if (funded + p.amount > this.deps.fundCaps.perTenantTotal)
      throw new ApiError("limit_exceeded", 400, "tenant treasury funding quota exhausted");
    const spec = JSON.parse(rec.specJson ?? "{}") as AgentSpec;
    this.run(p.id, () =>
      this.deps.runSaga({
        spec,
        idempotencyKey: p.id,
        tenantId: p.tenantId,
        specJson: rec.specJson ?? "{}",
        fundAmount: p.amount,
      }),
    );
    return { id: p.id, status: rec.status };
  }

  /** Resume non-terminal records after a restart. Records past provisioning resume; pre-provision pending ones fail. */
  reconcileInFlight(): number {
    let resumed = 0;
    for (const rec of this.deps.repo.listInFlight()) {
      if (this.inFlight.has(rec.idempotencyKey)) continue;
      if (!rec.turnkeySubOrgId) {
        // Crashed before the vault existed: can't resume without the (unpersisted) passkey.
        this.deps.repo.upsert({
          ...rec,
          status: "failed",
          error: "interrupted before provisioning; please re-onboard",
        });
        continue;
      }
      const spec = JSON.parse(rec.specJson ?? "{}") as AgentSpec;
      this.run(rec.idempotencyKey, () =>
        this.deps.runSaga({
          spec,
          idempotencyKey: rec.idempotencyKey,
          tenantId: rec.ownerTenantId ?? "",
          specJson: rec.specJson ?? "{}",
        }),
      );
      resumed++;
    }
    return resumed;
  }

  /** Await all background work (tests/shutdown). */
  async settled(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  private run(id: string, fn: () => Promise<unknown>) {
    this.inFlight.add(id);
    const task = (async () => {
      // Yield to the current synchronous frame so callers can observe the `pending` record
      // before the saga mutates it. This also matches real async behaviour (network/chain calls).
      await Promise.resolve();
      try {
        await fn();
      } catch (e) {
        const cur = this.deps.repo.findByIdempotencyKey(id);
        if (cur && !TERMINAL.includes(cur.status))
          this.deps.repo.upsert({
            ...cur,
            status: "failed",
            error: e instanceof Error ? e.message : String(e),
          });
      } finally {
        this.inFlight.delete(id);
      }
    })();
    this.pending.push(task);
  }
}
