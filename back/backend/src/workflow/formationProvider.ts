import {
  type DoolaApi,
  type DoolaFailureKind,
  classifyDoolaFailure,
  describeDoolaError,
} from "../adapters/doola/doolaClient";
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
  parseDetail,
} from "../persistence/formationRepository";
import type { AgentSpec } from "../policy/agentSpec";
import type { EntityRecord } from "../types";
import { failFormationStep, logFormationStep, parkFormationStep } from "./formationStep";

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
  /**
   * The `attempt` under which `POST /companies` was last SENT — written BEFORE the call, so it
   * survives a crash inside it (C1).
   *
   * It is what makes "did a create ever go out with the key we are about to use again?"
   * answerable. When it equals the row's current attempt, doola may be holding a committed
   * company for that key, an empty pre-create lookup proves NOTHING (their list is eventually
   * consistent with their creates), and the only safe move is to re-send the SAME key and let
   * doola replay. It is compared against `attempt` rather than stored as a boolean precisely so
   * that a legitimate re-key — after doola REJECTED the body — starts clean.
   */
  companySentAttempt?: number;
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

/**
 * The two idempotency keys of one attempt — one per ENDPOINT (C1 hardening).
 *
 * The customer create and the company create are different requests with different bodies, and a
 * single shared key made "same key, different body" — doola's `E_IDEMPOTENCY_KEY_REUSED` — a
 * shape our own traffic could produce. Suffixing costs nothing and removes the ambiguity.
 */
export function createProviderKeys(
  entityKey: string,
  attempt: number,
): { customer: string; company: string } {
  return {
    customer: SqliteFormationRepository.idempotencyKey(
      entityKey,
      "create_provider",
      attempt,
      "customer",
    ),
    company: SqliteFormationRepository.idempotencyKey(
      entityKey,
      "create_provider",
      attempt,
      "company",
    ),
  };
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

function logStep(
  entityKey: string,
  state: FormationState,
  attempt: number,
  extra: Record<string, unknown> = {},
): void {
  logFormationStep(entityKey, "create_provider", state, attempt, extra);
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
      message: describeDoolaError(e).message,
    });
  }
}

async function runStep(d: FormationCreateDeps, row: FormationRequestRecord): Promise<void> {
  const { entityKey, rec, requests, parties } = d;

  // ── Environment pinning (audit M5). BEFORE anything else, and never a doola call: an entity
  //    pinned to sandbox must not be routed at api.doola.com by a config flip, and one pinned to
  //    production must not be quietly re-filed in a playground.
  //
  //    PARKED, not failed (C7): no request was made, so there is nothing to be idempotent about,
  //    and this is a configuration error rather than a formation that is going badly. Burning
  //    attempts on it would `abandon` the formation after eight ticks of a wrong env var — and
  //    `abandoned` is what makes the sweeper erase the responsible party's personal data.
  if (rec.formationEnvironment !== d.environment) {
    parkFormationStep(
      d,
      entityKey,
      "create_provider",
      environmentPinMismatchError(rec.formationEnvironment ?? null, d.environment),
      { reason: "environment_pin" },
    );
    d.repo.recordEvent(
      entityKey,
      "formationCreate",
      d.rec.status,
      null,
      "formation create skipped: environment pin mismatch",
    );
    return;
  }

  const party = parties.findByEntityKey(entityKey);
  if (!party) {
    failStep(d, row, noFormationPartyError());
    return;
  }
  let detail = parseDetail<CreateProviderDetail>(row.detail);

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
  // we already know will come back 400. (The intake refuses it too, since C6 — this guards the
  // parties that were already in the table.)
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

  // ONE key per endpoint, both derived from THIS attempt. Nothing below rotates them: an attempt
  // moves only when doola has told us, in as many words, that it refused the request.
  const keys = createProviderKeys(entityKey, row.attempt);

  // ── 1. The customer. Persisted immediately: it is what the pre-create lookup searches by, and
  //       what part B re-fetches with. A lost answer here leaves no id and does NOT bump, so the
  //       retry re-sends the same key and doola replays the customer it already made.
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
          keys.customer,
        )
      ).doolaCustomerId;
    } catch (e) {
      onCallFailure(d, row, e, "createCustomer");
      return;
    }
    detail = { ...detail, customerId };
    persistDetail(d, detail);
  }

  // ── 2. Pre-create lookup fallback (completeness 9). ADOPT-ONLY, always: `GET /companies` is
  //       eventually consistent with the creates (verified live — see the runbook), so an empty
  //       result is NOT evidence that nothing was filed and can never authorize a fresh create.
  //       It runs whenever a previous attempt already had a customer, because that is exactly the
  //       shape of "we asked doola to file and lost the answer".
  if (hadCustomer) {
    const found = await lookupExistingCompany(d, customerId, nameOptions[0]!.name);
    if (found) {
      await adopt(d, row, found.doolaCompanyId, { ...detail, adopted: true }, found);
      return;
    }
  }

  // ── 3. Record that a company create is going out under THIS key, BEFORE it goes out.
  //
  //       This is the marker that survives a crash inside the call. On the next pass it says: a
  //       create with this exact key may be committed at doola, so an empty lookup proves
  //       nothing and the only safe move is to re-send the SAME key. Which is precisely what the
  //       code below does — the key is a pure function of an attempt that indeterminate failures
  //       never move.
  if (detail.companySentAttempt !== row.attempt) {
    detail = { ...detail, companySentAttempt: row.attempt };
    persistDetail(d, detail);
  }

  // ── 4. The company. THE call that costs money.
  let company: DoolaCompany;
  try {
    company = await d.doola.createCompany(
      buildCompanyInput(d, party, customerId, nameOptions, expedited),
      keys.company,
    );
  } catch (e) {
    // A key conflict means SOMETHING exists under this key. Look before parking — the lookup is
    // adopt-only, so the worst case is that we learn nothing and a human is told.
    if (classifyDoolaFailure(e) === "key_reused") {
      const found = await lookupExistingCompany(d, customerId, nameOptions[0]!.name);
      if (found) {
        await adopt(d, row, found.doolaCompanyId, { ...detail, adopted: true }, found);
        return;
      }
    }
    onCallFailure(d, row, e, "createCompany");
    return;
  }

  // ── 5. Persist the id BEFORE treating the create as done. A crash between here and the
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

/**
 * The ONE place a failed doola CALL decides whether the attempt moves (C1).
 *
 * Only `rejected` — doola looked at the request and refused it — burns an attempt and therefore
 * rotates the key. `lost` and `key_reused` park the row without bumping, so the retry re-sends
 * the same key and doola replays whatever it committed. Getting this backwards is the
 * double-filing bug: an entity whose create timed out would come back with a fresh key and file a
 * second real Wyoming LLC, with a second real fee, under a second real name.
 */
function onCallFailure(
  d: FormationCreateDeps,
  row: FormationRequestRecord,
  e: unknown,
  endpoint: "createCustomer" | "createCompany",
): void {
  const kind: DoolaFailureKind = classifyDoolaFailure(e);
  const described = describeDoolaError(e);
  if (kind === "rejected") {
    failStep(d, row, described.message, e);
    return;
  }
  const reason =
    kind === "key_reused"
      ? `doola reports this idempotency key was already used with a different body (${endpoint}) — NOT re-keying: something exists under it and re-filing could be a second company. ${described.message}`
      : `doola ${endpoint} gave no usable answer (${described.message}) — the request may have COMMITTED, so the attempt is NOT burned and the same idempotency key will be re-sent`;
  parkFormationStep(d, d.entityKey, "create_provider", reason, {
    providerRef: row.providerRef ?? undefined,
    endpoint,
    kind,
    code: described.code,
  });
  d.repo.recordEvent(
    d.entityKey,
    "formationCreate",
    d.rec.status,
    null,
    `formation create parked (${kind}): ${reason}`,
  );
  opsLog("formation_create_parked", {
    entityKey: d.entityKey,
    // A key conflict is a real bug and needs a human; a lost answer is ordinary weather.
    level: kind === "key_reused" ? "error" : "warn",
    ...(kind === "key_reused" ? { severity: "CRITICAL" as const } : {}),
    kind,
    endpoint,
    code: described.code,
    requestId: described.requestId,
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
      ...describeDoolaError(e),
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
      // The company EXISTS — we hold its id — and we simply could not read it right now. Parked
      // without burning the attempt (C1/C3): this is a read, it attempted nothing and committed
      // nothing, and eight transient read failures must not `abandon` a company Wyoming has
      // already filed (which is also what would erase the responsible party's data).
      const described = describeDoolaError(e);
      parkFormationStep(
        d,
        d.entityKey,
        "create_provider",
        `could not read the company we already filed (${companyId}): ${described.message}`,
        { providerRef: companyId, code: described.code },
      );
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
  const described: { code?: string; requestId?: string } = cause ? describeDoolaError(cause) : {};
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
