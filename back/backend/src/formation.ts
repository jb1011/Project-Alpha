import { randomUUID } from "node:crypto";
import { type Config, canFormEntities } from "./config/env";
import { opsLog } from "./observability/opsLog";
import type { FormationPin } from "./types";
import { sqliteUtcTimestamp } from "./util/sqliteTime";

/**
 * The ONE resolution of "what CAN this deployment pin a new entity to?" (design §2/§5).
 *
 * ONE condition: the doola block is configured (`canFormEntities`). Nothing can be filed without
 * it, and with it, anything CAN be.
 *
 * ⚠ This supersedes PR 2's decision #2, which also required `FORMATION_REQUIRED`. The two flags
 * were doing one job between them and the seam leaked: a deployment with the credentials and
 * `required=false` resolved a null pin, so an entity onboarded WITH a partyId — a caller who had
 * posted a real legal identity and handed over its handle — was minted unpinned and never filed,
 * while their party sat bound to it. The identity was silently dropped, which is the failure the
 * door's `formationUnavailableMessage` exists to prevent on the OTHER kind of deployment.
 *
 * The semantic that replaces it is one sentence: **a bound party is always pinned and always
 * filed; `FORMATION_REQUIRED` decides only whether the door REFUSES an onboard that carries no
 * party.** So the pin is per-CLAIM (`OnboardingRunner.start` writes it with the bind, in the same
 * transaction) rather than per-deployment, and this function answers the narrower question of
 * what that pin would be. A wizard that sends no partyId keeps working and files nothing, on
 * every deployment; an MCP or REST caller can opt in by passing one.
 *
 * It lives OUTSIDE any composition root on purpose: the API, the CLI and the legacy onboarding
 * server all mint entities, and three copies of this rule is three ways for the doors to
 * disagree about what an entity is. The pin is stamped at CLAIM and immutable after (audit M5),
 * so a door that resolved it differently would produce permanently divergent rows.
 */
export function resolveFormationDeployment(
  cfg: Pick<Config, "doola" | "formation">,
): FormationPin | null {
  if (!canFormEntities(cfg)) return null;
  // canFormEntities is exactly "cfg.doola is present", so the non-null assertion holds by the
  // guard above; the predicate is shared so the two can never drift.
  return { provider: "doola", environment: cfg.doola!.environment };
}

// ── Door gate (design §2/§5) ─────────────────────────────────────────────────────────────────
//
// Every message a formation door can refuse with lives in THIS file, for the reason
// `custodyUnavailableMessage` does: REST /onboard and MCP onboard_agent must stay behaviorally
// identical, tests regex-match these strings, and two copies of a refusal is two ways for the
// surfaces to drift. The gate itself is one function returning `string | null` — REST maps a
// non-null to a 400, MCP to an `isError` text — so the ORDER of the checks cannot differ
// between the surfaces either, which is the property `server.ts:489-491` asks for.

/** Formation is mandatory here and the caller sent no party handle. */
export function formationPartyRequiredMessage(): string {
  return "formation is required on this deployment: create a formation party (POST /formation-party, or the create_formation_party tool) and pass its partyId to onboard";
}

/**
 * ONE message for unknown / not-yours / already-bound, deliberately.
 *
 * Distinguishing them would turn the endpoint into an existence oracle over other tenants'
 * party ids, which is the same reason `GET /entities/:id` answers 404 rather than 403 for a
 * foreign entity. The message names all three conditions so an honest caller can still tell what
 * to fix.
 */
export function formationPartyUnavailableMessage(): string {
  return "partyId is unknown, not yours, or already bound to another entity — create a new formation party";
}

/** A partyId arrived at a deployment that forms nothing. Refused rather than ignored: silently
 *  dropping a legal identity a caller believed they were filing with is the worse failure. */
export function formationUnavailableMessage(): string {
  return "formation is not available on this deployment (doola credentials not configured) — omit partyId";
}

export function formationQuotaExhaustedMessage(maxPerTenant: number): string {
  return `formation quota exhausted: this tenant has already reached the limit of ${maxPerTenant} formation(s)`;
}

export function formationCeilingReachedMessage(dailyCeiling: number): string {
  return `platform formation ceiling reached: ${dailyCeiling} formation(s) in the last 24h — try again later`;
}

/** Sandbox: real personal data is refused outright, never merely replaced. */
export function syntheticPiiRequiredMessage(): string {
  return "this deployment files with SYNTHETIC sandbox identities (FORMATION_SANDBOX_SYNTHETIC_PII): pass { synthetic: true } — real personal data is refused here and is never sent to doola's development environment";
}

/** Production: the synthetic shortcut would file a real Wyoming LLC for a person who does not
 *  exist. Refused for the honesty invariant, not merely for data quality. */
export function syntheticPiiRefusedMessage(): string {
  return "synthetic formation parties are refused on this deployment (FORMATION_SANDBOX_SYNTHETIC_PII is off): a real filing needs a real legal identity";
}

/**
 * The labeled sandbox identity (§3, audit H7).
 *
 * doola's own registered-agent address in Sheridan, WY — the address a formed company already
 * gets — and an address of ours in the email, so nothing here can be mistaken for, or traced to,
 * a real natural person. The name is deliberately not a plausible one.
 */
export function syntheticFormationParty(partyId: string): {
  legalFirstName: string;
  legalLastName: string;
  email: string;
  phone: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
} {
  return {
    legalFirstName: "Novi Sandbox",
    legalLastName: "Guardian",
    email: `sandbox+${partyId}@novicorpus.com`,
    // doola REQUIRES a phone on a natural person's address (live sandbox, 2026-08-21).
    phone: "+13075550142",
    line1: "30 N Gould St",
    line2: "STE R",
    city: "Sheridan",
    region: "WY",
    postalCode: "82801",
    country: "USA",
  };
}

/** Counting surface behind the two spend controls. Implemented by the formation repository. */
export interface FormationQuotaReader {
  /** Lifetime formations opened by one tenant. */
  createRequestsByTenant(tenantId: string): number;
  /** Formations opened across the whole deployment since a UTC "YYYY-MM-DD HH:MM:SS" instant. */
  createRequestsSince(sinceUtc: string): number;
}

/** Everything the door needs. Absent `formation` = this deployment forms nothing. */
export interface FormationDoorDeps {
  formation?: {
    required: boolean;
    maxPerTenant: number;
    dailyCeiling: number;
    parties: import("./persistence/formationPartyRepository").FormationPartyRepository;
    /** The sub-saga rows. Typed as the narrow COUNTING surface here — the door needs nothing
     *  else from them, and the full repository satisfies it structurally. */
    requests: FormationQuotaReader;
  };
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The SQLite TEXT-timestamp formatter, defined beside its parser in `util/sqliteTime` (M4) and
 *  re-exported here for the door's own callers. */
export { sqliteUtcTimestamp };

/**
 * The formation door gate, in the ONE order both surfaces run it (design §2/§5).
 *
 * Returns the refusal message, or null when the request may proceed. Everything here happens
 * BEFORE the entity is claimed: formation is real money in production ($100–150 each), and the
 * user-facing answer to an exhausted quota or pack is a door that refuses, never an entity left
 * live with a mandatory formation that can never happen.
 */
export function formationDoorRefusal(
  deps: FormationDoorDeps,
  input: { tenantId: string; partyId?: string },
): string | null {
  const f = deps.formation;
  const now = deps.now ?? Date.now;

  // 1. A deployment that forms nothing. A partyId here is a caller who believes their legal
  //    identity is being filed with; say so instead of dropping it.
  if (!f) return input.partyId ? formationUnavailableMessage() : null;

  // 2. Mandatory formation with no party handle.
  if (f.required && !input.partyId) return formationPartyRequiredMessage();

  // 3. Ownership + single-use. Uniform message (see formationPartyUnavailableMessage).
  if (input.partyId) {
    const party = f.parties.findOwned(input.tenantId, input.partyId);
    if (!party || party.entityKey) return formationPartyUnavailableMessage();
  }

  // 4. Spend controls, only when a filing will ACTUALLY be initiated for this entity — which is
  //    exactly when a party is bound to it, on EVERY deployment (the opt-in semantic: a bound
  //    party is always pinned and always filed). Keyed on the partyId rather than on `required`,
  //    because an opt-in filing on a `required=false` box costs the same $100–150 as a mandatory
  //    one and must count against the same limits.
  if (!input.partyId) return null;

  const used = f.requests.createRequestsByTenant(input.tenantId);
  if (used >= f.maxPerTenant) {
    opsLog("formation_quota_rejected", {
      reason: "tenant-formation-quota",
      tenantId: truncateTenant(input.tenantId),
      used,
      limit: f.maxPerTenant,
    });
    return formationQuotaExhaustedMessage(f.maxPerTenant);
  }

  const inWindow = f.requests.createRequestsSince(sqliteUtcTimestamp(now() - DAY_MS));
  if (inWindow >= f.dailyCeiling) {
    opsLog("formation_ceiling_rejected", {
      reason: "platform-formation-ceiling",
      windowCount: inWindow,
      limit: f.dailyCeiling,
    });
    return formationCeilingReachedMessage(f.dailyCeiling);
  }

  // Within 20% of either limit AFTER this formation: the operator hears about it while there is
  // still headroom, not when the door starts refusing.
  warnIfNearLimit("formation_quota_warning", used + 1, f.maxPerTenant, {
    tenantId: truncateTenant(input.tenantId),
  });
  warnIfNearLimit("formation_ceiling_warning", inWindow + 1, f.dailyCeiling, {});
  return null;
}

/** Tenant ids are wallet addresses — pseudonymous, but still tenant identity. opsLog carries the
 *  same truncated form the World gate's rejection log uses. */
export function truncateTenant(tenantId: string): string {
  return `${tenantId.slice(0, 10)}…`;
}

function warnIfNearLimit(
  event: string,
  used: number,
  limit: number,
  fields: Record<string, unknown>,
): void {
  if (limit - used > limit * 0.2) return;
  opsLog(event, { level: "warn", used, limit, remaining: limit - used, ...fields });
}

// ── PII intake (design §3/§5) ────────────────────────────────────────────────────────────────

export interface FormationPartyIntakeDeps {
  parties: import("./persistence/formationPartyRepository").FormationPartyRepository;
  /** True = this deployment refuses real PII and files with the labeled sandbox fixture. */
  sandboxSyntheticPii: boolean;
}

/** Either the handle, or the single-sourced refusal both surfaces render. */
export type FormationPartyIntakeResult = { partyId: string } | { error: string };

/**
 * Create a formation party from a validated body, or from the sandbox shortcut.
 *
 * Shared by `POST /formation-party` and the `create_formation_party` MCP tool so the two intake
 * surfaces cannot accept different things — the same reason the door gate is one function.
 *
 * The synthetic rule is a REFUSAL in both directions, never a substitution (§3, audit H7):
 *  - on a sandbox deployment, real names and addresses are refused outright and never reach
 *    doola's development environment. Quietly swapping in a fixture would leave the caller
 *    believing their data had been filed, and would still have accepted (and stored) it;
 *  - on a production deployment, the synthetic shortcut is refused because it would file a real
 *    Wyoming LLC naming a person who does not exist.
 */
export function createFormationParty(
  deps: FormationPartyIntakeDeps,
  tenantId: string,
  body: { synthetic?: unknown; parsed?: import("./policy/agentSpec").FormationPartyInput },
): FormationPartyIntakeResult {
  if (body.synthetic === true) {
    if (!deps.sandboxSyntheticPii) return { error: syntheticPiiRefusedMessage() };
    // The id is minted HERE rather than by the repository because the fixture's email embeds it
    // (`sandbox+<partyId>@novicorpus.com`) — which is what keeps each sandbox filing
    // distinguishable in doola's portal, and unmistakably ours.
    const partyId = randomUUID();
    deps.parties.create({
      tenantId,
      ...syntheticFormationParty(partyId),
      synthetic: true,
      partyId,
    });
    return { partyId };
  }
  if (deps.sandboxSyntheticPii) return { error: syntheticPiiRequiredMessage() };
  if (!body.parsed) return { error: "a formation party body is required" };
  const p = body.parsed;
  return {
    partyId: deps.parties.create({
      tenantId,
      legalFirstName: p.legalFirstName,
      legalLastName: p.legalLastName,
      email: p.email,
      phone: p.phone,
      line1: p.address.line1,
      line2: p.address.line2 ?? null,
      city: p.address.city,
      region: p.address.region ?? null,
      postalCode: p.address.postalCode,
      country: p.address.country,
      synthetic: false,
    }),
  };
}

/**
 * The legacy doors' refusal (design §5, door matrix).
 *
 * `src/onboarding/server.ts` and `cli create-entity` bypass the claim, the World gate and the
 * custody gate entirely — and they have no way to carry a `partyId`. On a deployment where
 * formation is MANDATORY they would therefore mint entities that are pinned to a provider, owe
 * a filing, and have no legal identity to file with: a permanently stuck entity, created by a
 * door that never learned formation exists.
 *
 * So they refuse, loudly, at request/command time. The design records the recommendation to
 * retire the legacy server outright and leaves the decision to this PR's review; the refusal is
 * what makes either outcome safe in the meantime.
 */
export function legacyDoorRefusalMessage(door: "onboarding-server" | "cli create-entity"): string {
  return `${door} cannot onboard on a deployment where formation is required: it carries no formation party (POST /formation-party) and would mint an entity that can never be filed. Use the wizard API (POST /onboard) or the MCP onboard_agent tool.`;
}

/** True when the legacy doors must refuse: formation is configured AND mandatory. */
export function legacyDoorRefused(cfg: Pick<Config, "doola" | "formation">): boolean {
  return canFormEntities(cfg) && Boolean(cfg.formation?.required);
}
