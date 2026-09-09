import type { GuardianPasskey } from "../adapters/turnkey/provisioner";
import { ApiError } from "../errors";
import {
  companyAcceptsAgents,
  companyAgentCapMessage,
  companyUnavailableMessage,
} from "../formation";
import { deriveFormationStatus, formationSummary, hasLivePayment } from "../formation/status";
import { opsLog } from "../observability/opsLog";
import type { CompanyRepository } from "../persistence/companyRepository";
import type { EntityRepository } from "../persistence/entityRepository";
import type { FormationRepository } from "../persistence/formationRepository";
import type { AgentSpec } from "../policy/agentSpec";
import type { Address, EntityRecord, EntityStatus } from "../types";

export type RunSaga = (input: {
  spec: AgentSpec;
  idempotencyKey: string;
  tenantId: string;
  guardianPasskey?: GuardianPasskey;
  specJson: string;
  fundAmount?: bigint;
  /** Tier-0 custody choice for a NEW record (a resumed record's persisted provider wins). */
  custody?: "turnkey" | "circle";
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
      /** S5 aggregate platform-outflow brake; absent in tests that predate it -> unmetered. */
      outflows?: { check(amountAtomic: bigint): void };
      /**
       * doola formation, re-keyed to COMPANIES (2026-08-26 §3).
       *
       * The pin is no longer a deployment constant the runner stamps: it is COPIED FROM THE
       * COMPANY ROW inside the claim transaction, so a company minted in sandbox can never become
       * a production filing because a flag moved between its creation and an attach.
       *
       * Absent (no doola credentials) = stub mode: `company_id` and `formation_provider` stay
       * null and nothing in the saga changes.
       */
      formation?: {
        companies: CompanyRepository;
        requests: FormationRepository;
        /** FORMATION_MAX_AGENTS_PER_COMPANY, re-checked inside the transaction. */
        maxAgentsPerCompany: number;
      };
    },
  ) {}

  start(p: {
    spec: AgentSpec;
    userKey: string;
    tenantId: string;
    guardianPasskey: GuardianPasskey;
    /** Tier-0 custody choice, resolved by the caller (route/tool applies the platform default).
     *  Recorded on the claim so a restart resumes the RIGHT provider path. */
    custody?: "turnkey" | "circle";
    /**
     * ATTACH: the company this agent joins (design §3).
     *
     * The ONLY formation handle this method takes. A1's shim also accepted a `partyId` and minted
     * a 1:1 company for it inside the claim; A3 removed it, so a company is created at its own
     * door and this one only ever attaches to a company that already exists. Validated at the
     * door and re-validated by a CAS inside the claim transaction.
     */
    companyId?: string;
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
      // The durable WebAuthn credential id of the guardian passkey this agent was born with.
      // Both call sites (REST body, MCP store lookup) carry the full passkey, so recording it
      // here covers every path with no call-site changes. Defensive: REST input is caller-shaped.
      rootPasskeyId: p.guardianPasskey?.attestation?.credentialId ?? null,
      // Tier-0: custody is claimed here, immutably — the saga and the reconciler both read it.
      walletProvider: p.custody ?? null,
      // Formation, the custody twin: pinned at the claim and never re-derived from config. The
      // pin and `company_id` are written together, below, from the COMPANY ROW — so "pinned" and
      // "attached to a filing" are one fact rather than two that can disagree.
      companyId: null,
      formationProvider: null,
      formationEnvironment: null,
    };
    // Atomic claim: the INSERT-or-nothing is the single gate. Two concurrent starts (or processes
    // racing the same key) can never both win — the loser sees changes()==0 and gets a 409, before
    // any on-chain side effect. Replaces the old non-atomic inFlight/find pre-check.
    const f = this.deps.formation;
    const claim = () => {
      // A company handle is honoured only where there is a formation block to VALIDATE it
      // against. Without one there is nothing to re-read, nothing to copy a pin from, and no cap
      // to check — so attaching would write an unresolvable `company_id` onto the row, and
      // `entities.company_id` is write-once by trigger and published in the anchored manifest,
      // so it has no repair. The door refuses this combination up front
      // (`formationUnavailableMessage`); this is what the claim does if it ever gets past it.
      const companyId = f ? p.companyId : undefined;

      // ── The ATTACH CAS (design §3). Re-read the company HERE, in the transaction, because the
      //    door's check happened before it: a company abandoned, paid-for or filled to its agent
      //    cap in between must lose, and losing means the whole claim rolls back.
      let company:
        | { provider: string; environment: EntityRecord["formationEnvironment"] }
        | undefined;
      /** What the filing looked like AT THE MOMENT OF ATTACH — the joining agent's history. */
      let attachedSummary: string | undefined;
      /** Agents already on this company, read inside the transaction — the cap check and the
       *  `company_attach` ops line are two readings of one number, not two queries. */
      let attachedAgents = 0;
      if (companyId && f) {
        const fresh = f.companies.findOwned(p.tenantId, companyId);
        const steps = f.requests.stepsOf(companyId);
        if (
          !fresh ||
          !companyAcceptsAgents(
            fresh,
            deriveFormationStatus(steps),
            hasLivePayment(f.companies, companyId),
          )
        )
          throw new ApiError("validation_error", 400, companyUnavailableMessage());
        attachedAgents = f.companies.countAgents(companyId);
        if (attachedAgents >= f.maxAgentsPerCompany)
          throw new ApiError("limit_exceeded", 400, companyAgentCapMessage(f.maxAgentsPerCompany));
        // Pin fields FROM THE COMPANY ROW, never from config.
        company = { provider: fresh.provider, environment: fresh.environment };
        attachedSummary = JSON.stringify({
          companyId,
          ...formationSummary(fresh, steps),
          // PRESENCE only, never the number: an EIN is a tax identifier, and the audit trail is
          // the one place the processor deliberately keeps it out of (`formationEin` does the
          // same). "Has one" is the fact an owner reading the history needs.
          ein: Boolean(fresh.ein),
        });
      }

      if (
        !this.deps.repo.claimKey(
          company
            ? {
                ...initial,
                formationProvider: company.provider,
                formationEnvironment: company.environment,
              }
            : initial,
        )
      )
        throw new ApiError("conflict", 409, `onboarding already exists for "${p.userKey}"`);

      // WRITE-ONCE, and a separate statement on purpose: `attachCompany` is the only writer of
      // `entities.company_id` anywhere, so the write-once rule lives in one CAS rather than in
      // every caller's memory.
      if (companyId && !this.deps.repo.attachCompany(id, companyId))
        throw new ApiError("validation_error", 400, companyUnavailableMessage());
      // The ops trail for sharing (§7). Ids only — a company id is an opaque handle, and nothing
      // about the party behind it belongs in a log line.
      //
      // ONE event, carrying the count. §7 also names `company_reused`, and it was written as a
      // second line whose only difference from this one was that it fired when `agents > 0` — the
      // same ids, the same number, on the same attach. Two lines saying one thing is two lines to
      // keep in step and twice the journald volume, and the fan-out question is a QUERY over this
      // event rather than a second event: `company_attach agents>0` is the N:1 sharing actually
      // happening, which is what bounds the anchor traffic (`agents × late facts × 2 sponsored
      // writes`) and what makes two agents publicly linkable through their manifests.
      //
      // `agents` is the count BEFORE this attach, read in the same transaction as the cap check.
      if (companyId) opsLog("company_attach", { companyId, entityKey: id, agents: attachedAgents });
      // ONE event on the JOINING entity, carrying the filing as it stands right now (§3).
      //
      // The sub-saga's own events are fanned out at the moment each fact lands, over whichever
      // agents are attached THEN. An agent that joins a company afterwards — the whole point of
      // N:1 — was attached to a real, filed Wyoming LLC and had a completely empty formation
      // history, because every event that describes that filing had already been written. This
      // is the row that says what it joined.
      //
      // Every attach records one, now that every attach IS a join: A1's shim created the company
      // it attached to milliseconds earlier and had no prior history to describe, which is why
      // this used to be gated on the caller's own `companyId` rather than the local one. With the
      // shim gone the two are the same value.
      if (attachedSummary)
        this.deps.repo.recordEvent(id, "formationAttached", "pending", null, attachedSummary);
    };
    // Only an ATTACH takes the transaction: without a company there is exactly one write, and
    // every pre-formation caller (including the tests that hand in a repo stub) keeps its
    // existing single-statement path.
    if (p.companyId) this.deps.repo.transaction(claim);
    else claim();
    this.run(id, () =>
      this.deps.runSaga({
        spec: p.spec,
        idempotencyKey: id,
        tenantId: p.tenantId,
        guardianPasskey: p.guardianPasskey,
        specJson,
        custody: p.custody,
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
    // S5: the platform-wide rolling-window brake, after the per-tenant checks (most specific
    // reason first). Synchronous, before the saga spawns — nothing to unwind on refusal.
    try {
      this.deps.outflows?.check(p.amount);
    } catch {
      throw new ApiError("limit_exceeded", 400, "platform outflow ceiling reached");
    }
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

  /** Resume non-terminal records after a restart. Provider-aware (Tier-0): turnkey records need
   *  their sub-org (pre-provision ones fail — the passkey wasn't persisted); circle records can
   *  resume even pre-provision (provisioning needs no passkey — a crash there re-provisions,
   *  orphaning at most one tagged, unused wallet pair). */
  reconcileInFlight(): number {
    let resumed = 0;
    for (const rec of this.deps.repo.listInFlight()) {
      if (this.inFlight.has(rec.idempotencyKey)) continue;
      const circle = rec.walletProvider === "circle";
      if (!circle && !rec.turnkeySubOrgId) {
        // Turnkey path crashed before the vault existed: can't resume without the (unpersisted)
        // passkey.
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
