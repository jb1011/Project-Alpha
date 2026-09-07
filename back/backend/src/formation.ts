import { randomUUID } from "node:crypto";
import { type Config, canFormEntities } from "./config/env";
import { describeIndustryLabels } from "./formation/naicsLabels";
import { deriveFormationStatus, hasLivePayment } from "./formation/status";
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

/** Formation is mandatory here and the caller sent neither a company nor a party handle. */
export function formationPartyRequiredMessage(): string {
  return "formation is required on this deployment: create or reuse a company (POST /companies, or the create_company tool) and pass its companyId to onboard — or pass a partyId and one will be created for you";
}

/** The company handle is unknown, not yours, or not in a state an agent may attach to. ONE
 *  message for all of them, for the reason `formationPartyUnavailableMessage` gives. */
export function companyUnavailableMessage(): string {
  return "companyId is unknown, not yours, or not available for attachment (a draft, an abandoned or a failed company cannot take new agents)";
}

/** The per-company agent bound (design §3). Each attached agent is an anchor sequence per late
 *  fact, sponsored on-chain through its own timelock, so the fan-out has to be bounded. */
export function companyAgentCapMessage(max: number): string {
  return `this company already has ${max} agent(s) attached (FORMATION_MAX_AGENTS_PER_COMPANY) — create another company for further agents`;
}

/**
 * May an agent attach to this company (design §3)?
 *
 * `status` must be `ready` — a `draft` still owes its payment step and an `abandoned` one is
 * over — and the DERIVED filing status must be one of `none | in_progress | filed | complete`.
 * `none` is in the list deliberately: a `ready` company whose `create_provider` row is not yet
 * open derives `none`, and that is the happy path for both the shim and the hybrid flow. A
 * derived `failed` is refused because the agent would be attaching to a filing that will not
 * happen, and a live payment is refused because the company is not paid for yet.
 */
export function companyAcceptsAgents(
  company: { status: "draft" | "ready" | "abandoned" },
  derivedStatus: import("./formation/status").FormationStatus,
  hasLivePayment: boolean,
): boolean {
  if (company.status !== "ready") return false;
  if (hasLivePayment) return false;
  return (
    derivedStatus === "none" ||
    derivedStatus === "in_progress" ||
    derivedStatus === "filed" ||
    derivedStatus === "complete"
  );
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
  return "partyId is unknown, not yours, or already bound to another company — create a new formation party";
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

// ── INTAKE VALIDATION (design 2026-08-26 §5) ────────────────────────────────────────────────
//
// Every one of these names the FIELD and, where there is one, the offending value. That is the
// whole design of them: the alternative is a caller who cannot proceed and cannot tell why, on a
// form whose next step spends real money. They live here with the door's other refusals for the
// reason the file header gives — REST and MCP must refuse the same things in the same words, and
// A3's UI renders these strings rather than inventing its own.

/** Exactly three, always. The alternates are not a nicety: Wyoming refuses a name that is
 *  already taken, and a second attempt is a second filing. */
export function companyNamesRequiredMessage(): string {
  return "names must be exactly three company name candidates, in order of preference — Wyoming refuses a name that is already taken, and the two alternates are what let the filing proceed without a second fee";
}

export function companyNameBlankMessage(position: number): string {
  return `names[${position - 1}] is blank — all three candidates are required`;
}

export function companyNameTooLongMessage(position: number, max: number): string {
  return `names[${position - 1}] is longer than ${max} characters`;
}

/**
 * The charset refusal. It names the character, because "invalid characters" on a form is not
 * something a caller can act on.
 */
export function companyNameCharsetMessage(position: number, char: string): string {
  return `names[${position - 1}] contains ${JSON.stringify(char)}, which Wyoming does not accept in an entity name (letters, digits, spaces and & ' - , . ( ) + only)`;
}

/** "LLC" is the ENTITY ENDING, carried in its own field. A name that is nothing else has no
 *  name in it at all, and would be filed as "LLC LLC". */
export function companyNameEndingOnlyMessage(position: number): string {
  return `names[${position - 1}] must contain something other than an entity ending`;
}

/**
 * THE A1 SHIM's refusals, spelled for the door the caller is actually standing at.
 *
 * A party-only `POST /onboard` (or `onboard_agent`) sends an AGENT NAME. There is no `names`
 * array anywhere in that request — the shim derives a 1:1 company from the agent's name — so
 * "names[0] is blank, all three candidates are required" told that caller to fix a field they
 * had never heard of and could not have sent. A refusal a caller cannot act on is a dead end
 * even when the underlying rule is right, and the underlying rule IS right: "LLC" alone would be
 * filed with Wyoming as "LLC LLC".
 *
 * Same rules, same order, different sentence. They go away with the shim in A3.
 */
export function shimAgentNameBlankMessage(): string {
  return "name is blank — this agent's name becomes its company's name, so it has to say something";
}

export function shimAgentNameTooLongMessage(max: number): string {
  return `name is longer than ${max} characters, which is the limit Wyoming files a company name under — this agent's name becomes its company's name`;
}

export function shimAgentNameEndingOnlyMessage(): string {
  return 'name must contain something other than an entity ending — this agent\'s name becomes its company\'s name, and "LLC" on its own would be filed as "LLC LLC"';
}

/** Wyoming reserves this word to licensed or chartered entities (see wyRestrictedWords.ts). */
export function companyNameRestrictedMessage(position: number, word: string): string {
  return `names[${position - 1}] contains the restricted word "${word}" — Wyoming will not file it without a licence or charter we cannot supply on your behalf, so it would come back rejected after the fee was paid`;
}

/** Three candidates that are really one candidate leave the filing with no fallback at all. */
export function companyNameDuplicateMessage(position: number): string {
  return `names[${position - 1}] repeats an earlier candidate — three identical options give the filing no alternative if the first is taken`;
}

export function businessPurposeRequiredMessage(): string {
  return "businessPurpose is required: a short description of what the company does, which is filed with it";
}

export function businessPurposeTooLongMessage(max: number): string {
  return `businessPurpose is longer than ${max} characters`;
}

export function industryLabelRequiredMessage(): string {
  return "industryLabel is required";
}

/**
 * An unlisted label reaches doola and comes back rejected on a real fee, so it is refused here.
 *
 * The message NAMES the acceptable labels, because an enumerated field whose values a caller
 * cannot discover is a field they cannot fill in — and REST has no discovery surface for this one
 * yet (MCP's tool description carries them). Capped, so a refreshed list of hundreds does not
 * produce an error nobody can read.
 */
export function industryLabelUnknownMessage(label: string): string {
  return `industryLabel ${JSON.stringify(label)} is not one of the industries we can file under — pick one of: ${describeIndustryLabels()}`;
}

// ── THE SSN (design §4.1) ───────────────────────────────────────────────────────────────────

/** doola's documented format. Validated at the door so a typo is a specific 400 rather than a
 *  blob nobody can inspect and a rejected filing. */
export function ssnFormatMessage(): string {
  return "ssn must be formatted XXX-XX-XXXX";
}

/**
 * A sandbox or synthetic deployment refuses the field OUTRIGHT — never merely ignores it.
 *
 * The same reasoning as `syntheticPiiRefusedMessage`, one field down: quietly dropping an SSN
 * would leave a caller believing they had supplied one, and quietly accepting it would put a real
 * person's Social Security Number in a partner's DEVELOPMENT environment.
 */
export function ssnRefusedHereMessage(): string {
  return "ssn is refused on this deployment: an SSN is collected only for a real production filing, and never sent to doola's development environment";
}

/** The door cannot encrypt, so it must not accept. Unreachable on a correctly-booted production
 *  box (`FORMATION_PII_KEY` is a boot invariant) — it exists so the failure is a refusal rather
 *  than a plaintext write. */
export function ssnUnavailableMessage(): string {
  return "ssn cannot be accepted: this deployment has no FORMATION_PII_KEY configured, and an SSN is never stored unencrypted";
}

/** MCP does not take one, permanently (§4.1). */
export function ssnNotOnThisDoorMessage(): string {
  return "ssn is not accepted over MCP — an SSN in a tool argument would sit in an LLM client's context window and its logs. Use the web form (POST /companies)";
}

/**
 * The §4.1 optional-but-recommended copy, as a CONSTANT so A3's form and this door say the same
 * thing. It is the whole of what a caller is told before they decide.
 *
 * Optional because the filing genuinely proceeds without one: doola derives US-vs-non-US
 * applicant status from its presence, and a non-US applicant is expected not to have one.
 * Recommended because supplying it is what gets the EIN issued in days rather than weeks — the
 * alternative is the SS-4 signature route.
 */
export const SSN_COPY = {
  label: "Social Security Number or ITIN (optional)",
  help: "US persons: supplying this lets the IRS issue your EIN in days instead of weeks. It is encrypted immediately, sent once to our filing partner, and deleted from our records the moment the company is filed. Leave it blank if you are not a US person — we will file the SS-4 signature route instead.",
  /** What the surface may say about retention, and it is literally true (§4.4/§4.6a). */
  retention:
    "Deleted in the same transaction that records your company id, and in any case within 7 days if the filing never starts.",
} as const;

/**
 * The §4.7 freeze, refused in the caller's terms.
 *
 * It names the one case that IS editable, because that is the actionable half: a filing doola
 * refused releases its idempotency key, and only then can a new body be sent under it.
 */
export function companyIntakeFrozenMessage(): string {
  return "this company's intake can no longer be changed: a filing has already been sent for it. Intake is re-openable only after the provider REJECTED the filing, which is the one case that releases the request — otherwise create a new company";
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
  /** The attach predicate's steps read. Optional so the pre-company fakes still satisfy it. */
  stepsOf?(companyId: string): import("./persistence/formationRepository").FormationRequestRecord[];
}

/** Everything the door needs. Absent `formation` = this deployment forms nothing. */
export interface FormationDoorDeps {
  formation?: {
    required: boolean;
    maxPerTenant: number;
    dailyCeiling: number;
    maxAgentsPerCompany: number;
    parties: import("./persistence/formationPartyRepository").FormationPartyRepository;
    /** The sub-saga rows. Typed as the narrow COUNTING surface here — the door needs nothing
     *  else from them, and the full repository satisfies it structurally. */
    requests: FormationQuotaReader;
    /** Companies: what an ATTACH resolves against. The door's check is advisory — the binding
     *  answer is the CAS inside the claim transaction (§3) — but refusing here means an
     *  unattachable company never costs a claim. */
    companies: import("./persistence/companyRepository").CompanyRepository;
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
  input: { tenantId: string; partyId?: string; companyId?: string },
): string | null {
  const f = deps.formation;
  const now = deps.now ?? Date.now;

  // 1. A deployment that forms nothing. A party or company handle here is a caller who believes
  //    a legal body is being filed; say so instead of dropping it.
  if (!f) return input.partyId || input.companyId ? formationUnavailableMessage() : null;

  // 2. Mandatory formation with no handle of either kind.
  if (f.required && !input.partyId && !input.companyId) return formationPartyRequiredMessage();

  // 3. ATTACH (§3). An existing company costs nothing new — the filing is already paid for and
  //    already open — so it short-circuits the spend controls below entirely. Billing is per
  //    COMPANY: attaching an agent to one is free. The binding check is the CAS inside the claim
  //    transaction; this one exists so an unattachable company never costs a claim.
  if (input.companyId) {
    // Both at once would be ambiguous about which identity the filing is under.
    if (input.partyId)
      return "pass either companyId (attach to an existing company) or partyId (create one), not both";
    const company = f.companies.findOwned(input.tenantId, input.companyId);
    if (!company) return companyUnavailableMessage();
    if (
      !companyAcceptsAgents(
        company,
        deriveFormationStatus(f.requests.stepsOf?.(input.companyId) ?? []),
        hasLivePayment(f.companies, input.companyId),
      )
    )
      return companyUnavailableMessage();
    if (f.companies.countAgents(input.companyId) >= f.maxAgentsPerCompany)
      return companyAgentCapMessage(f.maxAgentsPerCompany);
    return null;
  }

  // 4. Ownership + single-use. Uniform message (see formationPartyUnavailableMessage).
  if (input.partyId) {
    const party = f.parties.findOwned(input.tenantId, input.partyId);
    if (!party || party.companyId) return formationPartyUnavailableMessage();
  }

  // 5. Spend controls, only when a filing will ACTUALLY be initiated — which is exactly when a
  //    party handle is passed and a NEW company will be minted for it, on EVERY deployment (the
  //    opt-in semantic). Keyed on the partyId rather than on `required`, because an opt-in filing
  //    on a `required=false` box costs the same $100–150 as a mandatory one and must count
  //    against the same limits. `createCompany` re-checks all of it inside the claim.
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

/**
 * Within 20% of a limit AFTER this request: the operator hears about it while there is still
 * headroom, not when the door starts refusing.
 *
 * EXPORTED, because `createCompany` had a second copy with its own signature and its own
 * hardcoded event name — two definitions of "near" is how one door starts warning at 80% and the
 * other at 90% without anyone noticing.
 */
export function warnIfNearLimit(
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
 * The legacy door's refusal (design §5, door matrix).
 *
 * `cli create-entity` bypasses the claim, the World gate and the custody gate entirely — and it
 * has no way to carry a `partyId`. On a deployment where formation is MANDATORY it would
 * therefore mint entities that are pinned to a provider, owe a filing, and have no legal identity
 * to file with: a permanently stuck entity, created by a door that never learned formation exists.
 *
 * So it refuses, loudly, at command time.
 *
 * There used to be TWO such doors. The standalone onboarding server
 * (`src/onboarding/{server,main}.ts`) was RETIRED in PR 3 — the design recorded the
 * recommendation and left the decision to review, and the decision was to retire it. It had no
 * auth, no World gate and no custody gate, and it bypassed `claimKey`, which is the cross-process
 * mutex that stops two runners minting the same entity. Nothing shipped depended on it: the
 * wizard API (`POST /onboard`) and the MCP `onboard_agent` tool are the doors, and both carry the
 * full gate order. Keeping a fifth entry point alive purely so it could refuse was more surface,
 * not less.
 *
 * The CLI stays. It is a separate process on the same database, it is how an operator mints on a
 * box with no browser, and its hard refusal is intact — and, being the only one left, this message
 * names it rather than taking it as a parameter.
 */
export function legacyDoorRefusalMessage(): string {
  return "cli create-entity cannot onboard on a deployment where formation is required: it carries no company handle (POST /companies) and would mint an entity that can never be filed. Use the wizard API (POST /onboard) or the MCP onboard_agent tool.";
}

/** True when the legacy door must refuse: formation is configured AND mandatory. */
export function legacyDoorRefused(cfg: Pick<Config, "doola" | "formation">): boolean {
  return canFormEntities(cfg) && Boolean(cfg.formation?.required);
}
