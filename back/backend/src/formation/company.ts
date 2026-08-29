import { assertGuardianAllowed } from "../api/routes/worldId";
import {
  formationCeilingReachedMessage,
  formationPartyUnavailableMessage,
  formationQuotaExhaustedMessage,
  sqliteUtcTimestamp,
  syntheticPiiRefusedMessage,
  syntheticPiiRequiredMessage,
  truncateTenant,
} from "../formation";
import { opsLog } from "../observability/opsLog";
import type { CompanyRepository, CompanyStatus } from "../persistence/companyRepository";
import type { FormationPartyRepository } from "../persistence/formationPartyRepository";
import type { CompanyPin } from "./intake";
import { synthesizeIntake } from "./intake";

/**
 * `createCompany` — THE domain function every company creation goes through (design §7).
 *
 * Three doors call it: REST `POST /companies`, MCP `create_company`, and the A1 shim inside the
 * onboarding claim. One function because the SPEND CONTROLS live here: the tenant quota, the
 * platform daily ceiling, the World-ID gate on the door that spends the money, the synthetic-PII
 * refusals and the party bind. Three copies of that order is three ways for the surfaces to
 * disagree about what a company costs, and this is real money in production.
 *
 * Everything refuses BEFORE any row is minted (the `formationDoorRefusal` "cannot drift"
 * precedent), and the mint itself — the company INSERT and the party bind CAS — is one
 * transaction: a party that loses the CAS rolls the company back with it, so a person's identity
 * can never end up spent on two companies.
 *
 * ⚠ It deliberately imports `assertGuardianAllowed` from the API layer. The rule the design gives
 * is "the gate is on the doors that spend the money", and the gate's implementation is a request
 * refusal (an `ApiError`). Re-implementing it here would be a second personhood check, which is
 * exactly the drift this module exists to prevent. The layering test forbids `src/workflow` →
 * `src/api`; this is `src/formation`, which is the door layer's own domain module.
 */

export interface CreateCompanyDeps {
  companies: CompanyRepository;
  parties: FormationPartyRepository;
  /** The platform DAILY ceiling still counts `create_provider` rows — where the fee is actually
   *  incurred. With payment on, a company can sit in draft for days before its create fires. */
  requests: { createRequestsSince(sinceUtc: string): number };
  /** What this deployment pins a company to. Never caller input. */
  pin: CompanyPin;
  /** True = this deployment files with a labeled sandbox identity and refuses real PII. */
  sandboxSyntheticPii: boolean;
  maxPerTenant: number;
  dailyCeiling: number;
  /** The company INSERT and the party bind CAS commit together, or not at all. */
  transaction: <T>(fn: () => T) => T;
  /** The World gate. Absent (or unwired) = no personhood check, exactly as on every other door —
   *  which is why production formation has a BOOT invariant that this is constructed. */
  world?: import("../api/routes/worldId").WorldIdDeps;
  now?: () => number;
}

/**
 * The A1 intake shape.
 *
 * A1 accepts the SYNTHESIZED intake only — one name derived from the agent's name, the default
 * purpose, the default industry — but it is stored in the canonical `{name, entityTypeEnding,
 * position}` shape with `intake_synthesized = 1`, so A2's real three-name form changes the door
 * and not the row.
 */
export interface CompanyIntakeInput {
  partyId: string;
  /** The company name seed. A2 replaces this with three validated candidates. */
  name: string;
  /** Optional business purpose; absent takes the default. */
  businessPurpose?: string;
  /** The caller's CLAIM about the deployment, checked against it — never the stored value. */
  synthetic?: boolean;
}

export type CreateCompanyResult = { companyId: string } | { error: string };

const DAY_MS = 24 * 60 * 60 * 1000;

export function createCompany(
  deps: CreateCompanyDeps,
  tenantId: string,
  intake: CompanyIntakeInput,
): CreateCompanyResult {
  const now = deps.now ?? Date.now;

  // 1. PERSONHOOD, first, and on this door specifically (§6.7): `POST /companies` is where the
  //    money is spent, and an anonymous caller with a wallet must not be able to buy real
  //    Wyoming LLCs. Throws (403) rather than returning a message — it is the same refusal
  //    onboard makes, and both surfaces already render it.
  assertGuardianAllowed(deps.world, tenantId, { scope: "company" });

  // 2. The synthetic-PII refusals, in BOTH directions and never as a substitution (§3, audit H7).
  //    Keyed on the DEPLOYMENT: quietly swapping in a fixture would leave the caller believing
  //    their data had been filed, and quietly accepting `synthetic` in production would file a
  //    real Wyoming LLC naming a person who does not exist.
  if (intake.synthetic === true && !deps.sandboxSyntheticPii)
    return { error: syntheticPiiRefusedMessage() };
  if (intake.synthetic !== true && deps.sandboxSyntheticPii)
    return { error: syntheticPiiRequiredMessage() };

  // 3. The party: owned, alive, and NOT already spent on a company (the single-use rule). One
  //    message for unknown / not-yours / already-bound, so the door is not an existence oracle
  //    over other tenants' party ids.
  const party = deps.parties.findOwned(tenantId, intake.partyId);
  if (!party || party.companyId) return { error: formationPartyUnavailableMessage() };
  // A real identity on a synthetic deployment (or the reverse) is the same refusal as above, one
  // layer down: the party row was minted through the same gate, so a mismatch is a bug, not a
  // request — but it would be a bug that files the wrong kind of company.
  if (party.synthetic !== deps.sandboxSyntheticPii)
    return {
      error: party.synthetic ? syntheticPiiRefusedMessage() : syntheticPiiRequiredMessage(),
    };

  // 4. The per-tenant quota, which SURVIVES payment (§6.7 — payment is a price, not a brake).
  //    It counts companies this tenant has spent or committed on (`ready`, or carrying a live
  //    payment) and never drafts: with payment on a company can sit in draft for days.
  const used = deps.companies.countChargeableByTenant(tenantId);
  if (used >= deps.maxPerTenant) {
    opsLog("formation_quota_rejected", {
      reason: "tenant-company-quota",
      tenantId: truncateTenant(tenantId),
      used,
      limit: deps.maxPerTenant,
    });
    return { error: formationQuotaExhaustedMessage(deps.maxPerTenant) };
  }

  // 5. The platform daily ceiling, still on `create_provider` rows.
  const inWindow = deps.requests.createRequestsSince(sqliteUtcTimestamp(now() - DAY_MS));
  if (inWindow >= deps.dailyCeiling) {
    opsLog("formation_ceiling_rejected", {
      reason: "platform-formation-ceiling",
      windowCount: inWindow,
      limit: deps.dailyCeiling,
    });
    return { error: formationCeilingReachedMessage(deps.dailyCeiling) };
  }

  // 6. Intake validation. A1's shape is one name; the stored shape is already canonical.
  const name = intake.name?.trim();
  if (!name) return { error: "a company name is required" };
  if (name.length > 120) return { error: "a company name may be at most 120 characters" };
  const built = synthesizeIntake(name, intake.businessPurpose);
  if (built.nameOptions.every((o) => !o.name))
    return { error: "a company name must contain something other than an entity ending" };

  // 7. The mint. The INSERT and the bind CAS are ONE transaction: losing the CAS — another
  //    request took this party between step 3 and here — rolls the company back with it.
  //
  //    A1 lands `ready` unconditionally, because payment is off: a `draft` company would owe a
  //    payment step that does not exist yet and would never be filed. B1 is what makes `draft`
  //    reachable, together with the quote that leaves it.
  const status: CompanyStatus = "ready";
  let companyId: string | undefined;
  const bound = deps.transaction(() => {
    const id = deps.companies.create({
      tenantId,
      status,
      provider: deps.pin.provider,
      environment: deps.pin.environment,
      // From the DEPLOYMENT, never from caller input — the caller only gets to be WRONG about it.
      synthetic: deps.sandboxSyntheticPii,
      nameOptions: built.nameOptions,
      businessPurpose: built.businessPurpose,
      industryLabel: built.industryLabel,
      intakeSynthesized: built.synthesized,
    });
    if (!deps.parties.bindToCompany(intake.partyId, id, tenantId)) return false;
    companyId = id;
    return true;
  });
  if (!bound || !companyId) return { error: formationPartyUnavailableMessage() };

  opsLog("company_created", {
    companyId,
    tenantId: truncateTenant(tenantId),
    environment: deps.pin.environment,
    synthetic: deps.sandboxSyntheticPii,
    intakeSynthesized: built.synthesized,
  });
  warnIfNearLimit(used + 1, deps.maxPerTenant, truncateTenant(tenantId));
  return { companyId };
}

/** Within 20% of the quota AFTER this company: the operator hears about it while there is still
 *  headroom, not when the door starts refusing. The door gate's own rule, at company scope. */
function warnIfNearLimit(used: number, limit: number, tenantId: string): void {
  if (limit - used > limit * 0.2) return;
  opsLog("formation_quota_warning", {
    level: "warn",
    used,
    limit,
    remaining: limit - used,
    tenantId,
  });
}
