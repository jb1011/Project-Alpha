import { type DoolaApi, DoolaApiError } from "../adapters/doola/doolaClient";
import type {
  CreateCompanyInput,
  DoolaAddress,
  DoolaCompany,
  DoolaEnvironment,
} from "../adapters/doola/types";
import { opsLog } from "../observability/opsLog";
import type { EntityRepository } from "../persistence/entityRepository";
import type {
  FormationPartyRecord,
  FormationPartyRepository,
} from "../persistence/formationPartyRepository";
import {
  type FormationRepository,
  type FormationRequestRecord,
  type FormationState,
  SqliteFormationRepository,
} from "../persistence/formationRepository";
import type { AgentSpec } from "../policy/agentSpec";
import type { EntityRecord } from "../types";
import { failFormationStep, logFormationStep } from "./formationStep";

/**
 * The `create_provider` step of the formation sub-saga (design §5, audit H5 / M5, completeness 9).
 *
 * It runs at the very END of onboarding — after funding, after ENS — and it **never throws**.
 * A doola outage, a validation failure, an exhausted formation pack: all of them record a
 * `failed` row and an ops alert, and none of them blocks funding, ENS, or the 202 the caller
 * already holds. Formation never gates `bound`/`funded`; the sweeper (part B) retries.
 *
 * The crash-window rule is the reason this file exists as its own module rather than as another
 * `if` in the saga. A real Wyoming LLC and a real fee sit behind `POST /companies`, so the
 * ordering is: persist the company id BEFORE treating the create as done, and on any later pass
 * ADOPT what is persisted instead of filing again. `Idempotency-Key` is the primary guard (the
 * contract is verified live — docs/runbooks/doola-idempotency-verification-2026-08.md); the
 * persisted ref is what makes a crash between the response and the commit survivable; and the
 * pre-create lookup is belt-and-braces on top of both.
 */

/**
 * `formation_requests.create_provider.detail`, as JSON. **Never PII** — that lives in
 * `formation_parties` and is read only through `FormationPartyRepository`.
 *
 * Part B reads this shape: `customerId` is what a poll re-fetches by, `companyId` mirrors
 * `provider_ref`, and `submissionStatus` is doola's INTAKE status (PENDING | SUBMITTED | FAILED)
 * — never "the company is formed", which is what `await_filing` tracks.
 */
export interface CreateProviderDetail {
  /** doola customer id. Persisted BEFORE the company create (crash-window rule). */
  customerId?: string;
  /** doola company id. Mirrors `provider_ref` so `detail` is self-describing in the ops trail. */
  companyId?: string;
  /** doola's formationSubmissionStatus at the moment we last read it. */
  submissionStatus?: string;
  /** The name preferences we filed, in order. */
  nameOptions?: string[];
  /** True when the §9 expedited-EIN service was requested (non-US applicant only). */
  expedited?: boolean;
  /** True when the company was ADOPTED — a crash-window resume or the pre-create lookup — rather
   *  than created by this attempt. The one field that says "we did not file this one twice". */
  adopted?: boolean;
}

export interface FormationCreateDeps {
  entityKey: string;
  rec: EntityRecord;
  spec: AgentSpec;
  repo: EntityRepository;
  requests: FormationRepository;
  parties: FormationPartyRepository;
  doola: DoolaApi;
  /** The environment THIS DEPLOYMENT is configured for. Compared against the entity's pin. */
  environment: DoolaEnvironment;
}

/** We form Wyoming LLCs. Both are constants rather than spec fields on purpose: the jurisdiction
 *  is a product decision, and a caller-chosen state would file into a legal regime the OA, the
 *  treasury contracts and the compliance calendar were not written for. */
const FORMATION_STATE = "WY";
const ENTITY_TYPE_ENDING = "LLC";

/** A NAICS `industry` label from `GET /v1/partner/references/naics-codes` (verified live
 *  2026-08-21; maps to 541511). `industry` or `naicsCode` is REQUIRED by the create. */
const DEFAULT_INDUSTRY = "Software development";

/** `description` is REQUIRED by the create. The spec's own description wins when the caller
 *  wrote one; this is the fallback, and it is deliberately a true statement about the entity. */
const DEFAULT_DESCRIPTION =
  "An autonomous software agent operating under an on-chain governed operating agreement.";

/** The refusal when the entity's pinned environment is not this deployment's (audit M5). It is
 *  its own distinct sentence because it must never read as a doola failure: nothing was called. */
export function environmentPinMismatchError(pinned: string | null, deployment: string): string {
  return `formation environment pin mismatch: this entity is pinned to "${pinned ?? "none"}" and this deployment runs "${deployment}" — refusing to call doola`;
}

export function noFormationPartyError(): string {
  return "no formation party is bound to this entity — nothing can be filed without a legal identity";
}

/** doola REQUIRES a phone on a natural person's address (live sandbox, 2026-08-21). Refused
 *  HERE, with a named reason, rather than sending a body we know will come back 400. */
export function partyPhoneRequiredError(): string {
  return "the bound formation party has no phone number — doola requires one on the responsible party's address";
}

/**
 * §9: the expedited EIN is offered ONLY to a non-US applicant.
 *
 * As a deployment default it would break every US-founder formation, so the signal is the
 * applicant's own: no SSN AND a country of residence outside the US. `ssn` is not collected by
 * the intake today, which makes the first conjunct vacuously true — it is written out anyway so
 * that the day an SSN is collected, this rule already reads correctly.
 */
export function isNonUsResponsibleParty(p: { ssn?: string | null; country: string }): boolean {
  return !p.ssn && p.country.toUpperCase() !== "USA";
}

/** The company name doola files, WITHOUT its entity ending (`entityTypeEnding` carries that).
 *  A trailing "LLC" in the agent's name would otherwise be filed as "Acme LLC LLC". */
export function companyNameOptions(specName: string): { name: string; entityTypeEnding: string }[] {
  const base = specName.replace(/[\s,]+(l\.?l\.?c\.?)$/i, "").trim() || specName.trim();
  return [{ name: base, entityTypeEnding: ENTITY_TYPE_ENDING }];
}

function toDoolaAddress(p: FormationPartyRecord): DoolaAddress {
  return {
    line1: p.line1,
    line2: p.line2 ?? undefined,
    city: p.city,
    // `region` here, `state` on the wire — most countries have no state/province, which is why
    // our column is the more general word.
    state: p.region ?? undefined,
    postalCode: p.postalCode,
    country: p.country,
    phone: p.phone ?? undefined,
  };
}

function parseDetail(raw: string | null): CreateProviderDetail {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as CreateProviderDetail;
  } catch {
    // A corrupt detail blob must not strand the entity: the authoritative facts are the
    // provider_ref column and doola itself, both of which survive an unreadable blob.
    return {};
  }
}

function logStep(
  entityKey: string,
  state: FormationState,
  attempt: number,
  extra: Record<string, unknown> = {},
): void {
  logFormationStep(entityKey, "create_provider", state, attempt, extra);
}

/** doola's machine code + correlation id, for the ops line and the persisted error. */
function describe(e: unknown): { message: string; code?: string; requestId?: string } {
  if (e instanceof DoolaApiError)
    return { message: `${e.code}: ${e.message}`, code: e.code, requestId: e.requestId };
  return { message: (e as Error).message };
}

/**
 * Run the create_provider step. **Never throws** — every exit is a recorded state.
 *
 * Returns nothing: the caller is the saga, and the saga's only correct reaction to any outcome
 * here is to carry on.
 */
export async function runFormationCreateProvider(d: FormationCreateDeps): Promise<void> {
  const { entityKey, requests } = d;
  try {
    // All four steps, in one transaction (the bridge-legs pattern): "is a formation in flight for
    // this entity?" then reads rows that provably all exist, instead of guessing which of them a
    // crash created. Idempotent — a resume claims nothing and finds everything.
    requests.claimAllSteps(entityKey);

    const row = requests.find(entityKey, "create_provider");
    if (!row) return; // unreachable after claimAllSteps; a missing row is never a reason to file
    if (row.state === "confirmed") return;
    // `abandoned` is the sweeper's terminal verdict (part B). The saga does not overrule it.
    if (row.state === "abandoned") return;

    await runStep(d, row);
  } catch (e) {
    // The last line of defense. Everything below already handles its own failures, so reaching
    // here means the BOOKKEEPING itself failed — and even that must not fail an onboarding.
    opsLog("formation_create_failed", {
      entityKey,
      code: "E_UNEXPECTED",
      message: describe(e).message,
    });
  }
}

async function runStep(d: FormationCreateDeps, row: FormationRequestRecord): Promise<void> {
  const { entityKey, rec, requests, parties } = d;

  // ── Environment pinning (audit M5). BEFORE anything else, and never a doola call: an entity
  //    pinned to sandbox must not be routed at api.doola.com by a config flip, and one pinned to
  //    production must not be quietly re-filed in a playground.
  if (rec.formationEnvironment !== d.environment) {
    failStep(d, row, environmentPinMismatchError(rec.formationEnvironment ?? null, d.environment));
    return;
  }

  const party = parties.findByEntityKey(entityKey);
  if (!party) {
    failStep(d, row, noFormationPartyError());
    return;
  }
  let detail = parseDetail(row.detail);

  // ── ADOPT (crash-window rule). A persisted provider_ref means the company create ALREADY
  //    returned — whatever happened next. Filing again would be a second real LLC and a second
  //    real fee, so this path only ever reads. Checked BEFORE the body preconditions below: a
  //    company that exists must be adopted whatever the party's data looks like now.
  if (row.providerRef) {
    await adopt(d, row, row.providerRef, { ...detail, adopted: true });
    return;
  }

  // Everything from here builds a request body, and doola REQUIRES a phone on a natural person's
  // address (live sandbox, 2026-08-21). Refused HERE, with a named reason, rather than by a body
  // we already know will come back 400.
  if (!party.phone) {
    failStep(d, row, partyPhoneRequiredError());
    return;
  }

  // Did a PREVIOUS attempt already get past the customer create? That — not the row's state — is
  // what makes the pre-create lookup meaningful: a customer id with no company id is an attempt
  // that asked doola to file and lost the answer. It is the same shape whether the row was left
  // `submitted` by a crash or `failed` by an error the sweeper is now retrying.
  const hadCustomer = Boolean(detail.customerId);

  const nameOptions = companyNameOptions(d.spec.name);
  const expedited = isNonUsResponsibleParty(party);
  detail = {
    ...detail,
    nameOptions: nameOptions.map((n) => `${n.name} ${n.entityTypeEnding}`),
    expedited,
  };

  // `submitted` means "we are about to talk to doola". Written BEFORE the first call so a crash
  // during it is distinguishable from one before it — and written from WHATEVER state we found,
  // because a RETRY arrives at `failed`, not `pending`. Every persist below CASes on
  // `submitted`: leaving the row parked elsewhere would make each of them a silent no-op, and
  // the company id — the one thing that must survive — would never be written. The CAS on the
  // observed state is also what stops two drivers from racing one entity's create.
  if (row.state !== "submitted") {
    if (
      !requests.transition(entityKey, "create_provider", row.state, "submitted", {
        detail: JSON.stringify(detail),
        error: null,
      })
    )
      return;
    logStep(entityKey, "submitted", row.attempt);
  }

  const key = SqliteFormationRepository.idempotencyKey(entityKey, "create_provider", row.attempt);

  // ── 1. The customer. Persisted immediately: it is what the pre-create lookup searches by, and
  //       what part B re-fetches with.
  let customerId = detail.customerId;
  if (!customerId) {
    try {
      customerId = (
        await d.doola.createCustomer(
          {
            firstName: party.legalFirstName,
            lastName: party.legalLastName,
            email: party.email,
            countryOfResidence: party.country,
            phoneNumber: party.phone ?? undefined,
          },
          key,
        )
      ).doolaCustomerId;
    } catch (e) {
      failStep(d, row, describe(e).message, e);
      return;
    }
    detail = { ...detail, customerId };
    persistDetail(d, detail);
  }

  // ── 2. Pre-create lookup fallback (completeness 9). Only when a previous attempt already had
  //       a customer, and it may only ever ADOPT: `GET /companies` is eventually consistent with
  //       the creates (verified live — see the runbook), so
  //       an empty result is NOT evidence that nothing was filed and can never authorize a
  //       fresh create. The Idempotency-Key is what makes that safe; this is belt-and-braces.
  if (hadCustomer) {
    const found = await lookupExistingCompany(d, customerId, nameOptions[0]!.name);
    if (found) {
      await adopt(d, row, found.doolaCompanyId, { ...detail, adopted: true }, found);
      return;
    }
  }

  // ── 3. The company. THE call that costs money.
  let company: DoolaCompany;
  try {
    company = await d.doola.createCompany(
      buildCompanyInput(d, party, customerId, nameOptions, expedited),
      key,
    );
  } catch (e) {
    failStep(d, row, describe(e).message, e);
    return;
  }

  // ── 4. Persist the id BEFORE treating the create as done. A crash between here and the
  //       confirm below resumes into the ADOPT branch above, never into a second create.
  detail = { ...detail, companyId: company.doolaCompanyId };
  requests.transition(entityKey, "create_provider", "submitted", "submitted", {
    providerRef: company.doolaCompanyId,
    detail: JSON.stringify(detail),
  });
  logStep(entityKey, "submitted", row.attempt, { providerRef: company.doolaCompanyId });

  confirm(d, row, company.doolaCompanyId, {
    ...detail,
    submissionStatus: company.formationSubmissionStatus,
  });
}

function buildCompanyInput(
  d: FormationCreateDeps,
  party: FormationPartyRecord,
  customerId: string,
  nameOptions: { name: string; entityTypeEnding: string }[],
  expedited: boolean,
): CreateCompanyInput {
  const address = toDoolaAddress(party);
  return {
    doolaCustomerId: customerId,
    entityType: "LLC",
    state: FORMATION_STATE,
    nameOptions: nameOptions.map((n, i) => ({ ...n, position: i + 1 })),
    industry: DEFAULT_INDUSTRY,
    description: d.spec.metadata?.description || DEFAULT_DESCRIPTION,
    responsibleParty: {
      legalFirstName: party.legalFirstName,
      legalLastName: party.legalLastName,
      email: party.email,
      address,
    },
    // doola's own registered agent provides both addresses. This is not a convenience: an AGENT
    // has no premises, and a mailing address it does not control is the difference between a
    // filing that can be served and one that cannot.
    addresses: [
      { provider: "registeredAgent", type: "mailing" },
      { provider: "registeredAgent", type: "business" },
    ],
    members: [
      {
        legalFirstName: party.legalFirstName,
        legalLastName: party.legalLastName,
        isNaturalPerson: true,
        address,
        ownershipPercent: 100,
      },
    ],
    // §9: conditional on the applicant, never a deployment default.
    requestedServices: expedited ? [{ service: "EinCreation", variant: "Expedite" }] : undefined,
  };
}

/** Best-effort: find a company doola already holds for our customer. Never throws — a failed
 *  lookup falls through to the create, which the idempotency key still protects. */
async function lookupExistingCompany(
  d: FormationCreateDeps,
  customerId: string,
  wantedName: string,
): Promise<DoolaCompany | undefined> {
  try {
    const companies = await d.doola.listCompanies(customerId);
    if (companies.length === 0) return undefined;
    // We mint one customer per entity, so anything under it is ours. Prefer an exact name match
    // and fall back to the single company case; two unexplained companies under one of our
    // customers is a situation to alert on, not to guess at.
    const byName = companies.find(
      (c) => (c.name ?? "").trim().toLowerCase() === `${wantedName} llc`.toLowerCase(),
    );
    if (byName) return byName;
    if (companies.length === 1) return companies[0];
    opsLog("formation_lookup_ambiguous", {
      entityKey: d.entityKey,
      level: "warn",
      count: companies.length,
    });
    return undefined;
  } catch (e) {
    opsLog("formation_lookup_failed", {
      entityKey: d.entityKey,
      level: "warn",
      ...describe(e),
    });
    return undefined;
  }
}

/** Adopt a company doola already has: read its current state, then confirm. No create, ever. */
async function adopt(
  d: FormationCreateDeps,
  row: FormationRequestRecord,
  companyId: string,
  detail: CreateProviderDetail,
  known?: DoolaCompany,
): Promise<void> {
  let company = known;
  if (!company) {
    try {
      company = await d.doola.getCompany(companyId);
    } catch (e) {
      // The company exists (we hold its id); we simply could not read it right now. Fail the row
      // so the sweeper retries — it will land in this same branch and read again.
      failStep(d, row, describe(e).message, e);
      return;
    }
  }
  confirm(d, row, companyId, {
    ...detail,
    companyId,
    submissionStatus: company.formationSubmissionStatus,
  });
}

/**
 * The step's success terminal.
 *
 * Deliberately writes NO legal facts onto the entity: `ein_real`, `formation_filed_at` and
 * `formation_filing_number` stay null until the state has actually filed and the IRS has
 * actually issued — which is what `await_filing` and `await_ein` are for (part B). doola's
 * `formationSubmissionStatus` records only that doola accepted the REQUEST, and it is kept in
 * `detail` where nothing can mistake it for a filing.
 */
function confirm(
  d: FormationCreateDeps,
  row: FormationRequestRecord,
  companyId: string,
  detail: CreateProviderDetail,
): void {
  const { entityKey, requests } = d;
  // CAS on the state the row is ACTUALLY in, re-read here rather than assumed to be `submitted`.
  //
  // The create path does arrive at `submitted`, but the ADOPT path does not: adoption happens
  // BEFORE the body preconditions (a company that exists must be adopted whatever the party data
  // looks like now), so a row the sweeper is retrying arrives here still parked in `failed`. A
  // hardcoded `from` made that transition a silent no-op — the company existed, was read, and the
  // row stayed `failed` until it burned through eight attempts and was abandoned. Found by part
  // B's sweeper test; the retry path had no coverage before it.
  const from = requests.find(entityKey, "create_provider")?.state ?? row.state;
  if (from === "confirmed" || from === "abandoned") return;
  requests.transition(entityKey, "create_provider", from, "confirmed", {
    providerRef: companyId,
    detail: JSON.stringify(detail),
    error: null,
  });
  d.repo.recordEvent(
    entityKey,
    "formationCreate",
    d.rec.status,
    null,
    JSON.stringify({
      providerRef: companyId,
      submissionStatus: detail.submissionStatus ?? null,
      adopted: Boolean(detail.adopted),
      environment: d.environment,
    }),
  );
  logStep(entityKey, "confirmed", row.attempt, {
    providerRef: companyId,
    adopted: Boolean(detail.adopted),
  });
}

/** Write the current detail back without moving the row (a CAS on `submitted` -> `submitted`). */
function persistDetail(d: FormationCreateDeps, detail: CreateProviderDetail): void {
  d.requests.transition(d.entityKey, "create_provider", "submitted", "submitted", {
    detail: JSON.stringify(detail),
  });
}

/**
 * Park the row in `failed`, with the reason, and burn the attempt.
 *
 * Both, and in this order, inside one transaction. `bumpAttempt` is the repository's
 * failure primitive — it resets to `pending` so a retry derives a FRESH idempotency key, which
 * is what keeps a retry with a corrected body out of doola's `E_IDEMPOTENCY_KEY_REUSED`. But
 * `pending` is not the state an operator should see for a step that failed, so the row is then
 * moved to `failed` carrying the error. The transaction is what makes the intermediate `pending`
 * unobservable.
 */
function failStep(
  d: FormationCreateDeps,
  row: FormationRequestRecord,
  error: string,
  cause?: unknown,
): void {
  const { entityKey } = d;
  const described: { code?: string; requestId?: string } = cause ? describe(cause) : {};
  // The bump-then-park sequence itself lives in `formationStep.ts`: the webhook processor and the
  // sweeper park rows too, and three copies of that contract would be three chances to burn an
  // attempt without parking the row (or the reverse). What stays HERE is what is specific to the
  // create: the entity audit event, and doola's own error code on the ops line.
  failFormationStep(d, entityKey, "create_provider", error, { code: described.code });
  d.repo.recordEvent(
    entityKey,
    "formationCreate",
    d.rec.status,
    null,
    `formation create failed: ${error}`,
  );
  opsLog("formation_create_failed", {
    entityKey,
    level: "warn",
    code: described.code,
    requestId: described.requestId,
  });
}
