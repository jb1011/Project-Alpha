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
import {
  type CompanyNameOption,
  DEFAULT_DESCRIPTION,
  DEFAULT_INDUSTRY,
  FORMATION_ENTITY_TYPE,
  FORMATION_STATE,
  companyNameOptions,
} from "../formation/intake";
import { type PiiKeyring, type Secret, decryptSsn } from "../formation/pii";
import { opsLog } from "../observability/opsLog";
import type { CompanyRecord, CompanyRepository } from "../persistence/companyRepository";
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
import {
  failFormationStep,
  logFormationStep,
  parkFormationStep,
  recordCompanyEvent,
} from "./formationStep";

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
  /**
   * True when the §9 expedited-EIN service was requested (non-US applicant only).
   *
   * FROZEN at first send and read from there forever (§4.5). It is a function of the SSN, and the
   * SSN is deleted in the transaction that persists `provider_ref` — so recomputing it on a
   * same-key retry could produce a DIFFERENT body under a key doola is already holding.
   */
  expedited?: boolean;
  /**
   * Whether the create body we SENT carried `responsibleParty.ssn` — frozen at first send, for
   * exactly the reason `expedited` is (§4.5), and reasoned through against doola's 409 in the
   * `resolveSsn` comment below.
   *
   * The VALUE is never here. This is a boolean about the shape of a request, and the design's
   * "never in `detail`" rule is about the number itself.
   */
  ssnIncluded?: boolean;
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
  /** The COMPANY being filed. The saga runs once per company, whatever number of agents (zero
   *  included) happen to be attached to it. */
  company: CompanyRecord;
  companies: CompanyRepository;
  /** Still here for the ENTITY AUDIT TRAIL and for the transaction primitive. Every attached
   *  agent gets the same event; a company with no agents attached simply gets none. */
  repo: EntityRepository;
  requests: FormationRepository;
  parties: FormationPartyRepository;
  doola: DoolaApi;
  /** The environment THIS DEPLOYMENT is configured for. Compared against the company's pin. */
  environment: DoolaEnvironment;
  /**
   * The SSN keyring (§4.2). Absent on every deployment that never collected one — which is every
   * deployment but production doola.
   *
   * Absent WITH a stored ciphertext is a box that has lost its key, and the step parks rather
   * than sending a body without the SSN: see `resolveSsn`.
   */
  pii?: PiiKeyring;
}

/**
 * The jurisdiction constants and the intake defaults now live in `formation/intake.ts`, because
 * the DATABASE MIGRATION synthesizes a company with the same values and a persistence module must
 * not reach up into the workflow layer for them. Re-exported here so the anchor loop — which must
 * import `legal.entityType`/`legal.state` from the FILER rather than re-typing them, or reading
 * them back off a provider response — keeps its existing import.
 */
export { FORMATION_STATE, FORMATION_ENTITY_TYPE, companyNameOptions, DEFAULT_INDUSTRY };

/** The refusal when the company's pinned environment is not this deployment's (audit M5). It is
 *  its own distinct sentence because it must never read as a doola failure: nothing was called. */
export function environmentPinMismatchError(pinned: string | null, deployment: string): string {
  return `formation environment pin mismatch: this entity is pinned to "${pinned ?? "none"}" and this deployment runs "${deployment}" — refusing to call doola`;
}

export function noFormationPartyError(): string {
  return "no formation party is bound to this company — nothing can be filed without a legal identity";
}

/** The refusal when the company's stored intake carries NO name candidates — an empty or
 *  unreadable `name_options` blob. Its own sentence, like the pin mismatch, because nothing was
 *  called and nothing is wrong with doola: the ROW is unreadable, and a filing must never invent
 *  the name it asks the state for. */
export function noNameOptionsError(): string {
  return "the company's stored name candidates are empty or unreadable — refusing to file, because a filing must never invent the name it asks the state for";
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
 * applicant's own: no SSN AND a country of residence outside the US.
 *
 * It takes `hasSsn` rather than the value, deliberately: the SSN is a secret that lives in
 * plaintext for the length of one function call, and a predicate that ACCEPTED one would be one
 * more place it could end up in a stack trace or a snapshot. Nothing here needs the number.
 */
export function isNonUsResponsibleParty(p: { hasSsn: boolean; country: string }): boolean {
  return !p.hasSsn && p.country.toUpperCase() !== "USA";
}

/** The refusal when a create body cannot be rebuilt as it was SENT (§4.5). Its own sentence,
 *  like the pin mismatch, because nothing is wrong with doola and nothing was called: the SSN
 *  the frozen body carried can no longer be read, and sending the body WITHOUT it would be a
 *  different body under an idempotency key doola is already holding. */
export function ssnUnreadableError(): string {
  return "this company's create body carried an SSN that can no longer be read, and re-sending the same idempotency key with a different body would be refused by the provider — a human must resolve it (restore FORMATION_PII_KEY_PREVIOUS, or abandon and re-file)";
}

/**
 * The two idempotency keys of one attempt — one per ENDPOINT (C1 hardening).
 *
 * The customer create and the company create are different requests with different bodies, and a
 * single shared key made "same key, different body" — doola's `E_IDEMPOTENCY_KEY_REUSED` — a
 * shape our own traffic could produce. Suffixing costs nothing and removes the ambiguity.
 */
export function createProviderKeys(
  companyId: string,
  attempt: number,
): { customer: string; company: string } {
  return {
    customer: SqliteFormationRepository.idempotencyKey(
      companyId,
      "create_provider",
      attempt,
      "customer",
    ),
    company: SqliteFormationRepository.idempotencyKey(
      companyId,
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
  companyId: string,
  state: FormationState,
  attempt: number,
  extra: Record<string, unknown> = {},
): void {
  logFormationStep(companyId, "create_provider", state, attempt, extra);
}

/**
 * Run the create_provider step. **Never throws** — every exit is a recorded state.
 *
 * Returns nothing: the caller is the saga, and the saga's only correct reaction to any outcome
 * here is to carry on.
 */
export async function runFormationCreateProvider(d: FormationCreateDeps): Promise<void> {
  const { requests } = d;
  const companyId = d.company.companyId;
  try {
    // All four steps, in one transaction (the bridge-legs pattern): "is a formation in flight for
    // this entity?" then reads rows that provably all exist, instead of guessing which of them a
    // crash created. Idempotent — a resume claims nothing and finds everything.
    requests.claimAllSteps(companyId);

    const row = requests.find(companyId, "create_provider");
    if (!row) return; // unreachable after claimAllSteps; a missing row is never a reason to file
    if (row.state === "confirmed") return;
    // `abandoned` is the sweeper's terminal verdict (part B). The saga does not overrule it.
    if (row.state === "abandoned") return;

    await runStep(d, row);
  } catch (e) {
    // The last line of defense. Everything below already handles its own failures, so reaching
    // here means the BOOKKEEPING itself failed — and even that must not fail an onboarding.
    opsLog("formation_create_failed", {
      companyId,
      code: "E_UNEXPECTED",
      message: describeDoolaError(e).message,
    });
  }
}

async function runStep(d: FormationCreateDeps, row: FormationRequestRecord): Promise<void> {
  const { requests, parties } = d;
  const companyId = d.company.companyId;

  // ── Environment pinning (audit M5). BEFORE anything else, and never a doola call: an entity
  //    pinned to sandbox must not be routed at api.doola.com by a config flip, and one pinned to
  //    production must not be quietly re-filed in a playground.
  //
  //    PARKED, not failed (C7): no request was made, so there is nothing to be idempotent about,
  //    and this is a configuration error rather than a formation that is going badly. Burning
  //    attempts on it would `abandon` the formation after eight ticks of a wrong env var — and
  //    `abandoned` is what makes the sweeper erase the responsible party's personal data.
  if (d.company.environment !== d.environment) {
    parkFormationStep(
      d,
      companyId,
      "create_provider",
      environmentPinMismatchError(d.company.environment, d.environment),
      { reason: "environment_pin" },
    );
    recordCompanyEvent(
      d.repo,
      d.company.companyId,
      "formationCreate",
      "formation create skipped: environment pin mismatch",
    );
    return;
  }

  const party = parties.findByCompanyId(companyId);
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

  // The candidates we STORED at intake — never re-derived here. The migration, the shim and the
  // real form all wrote the same canonical shape, and the matcher that decides `legal_name_filed`
  // compares against exactly these rows.
  //
  // An EMPTY list is a corrupt or unparseable `name_options` blob (`parseNameOptions` maps one to
  // `[]`), and there is exactly one safe answer: file NOTHING. Deriving a substitute would ask
  // Wyoming for a name nobody chose, under a real fee, and store it as the company's own
  // candidate — the matcher that decides `legal_name_filed` compares against these rows, so the
  // invented name would go on to be published in an anchored manifest. It PARKS rather than
  // burning an attempt, for the environment pin's reason: nothing was sent, a human has to fix
  // the row, and eight ticks of `failed` would `abandon` the formation and erase the party.
  //
  // A BLANK candidate is the same fact wearing a different shape, and the list being non-empty
  // is no comfort: an agent named "LLC" strips to nothing, so the canonical row is
  // `[{ name: "", entityTypeEnding: "LLC", position: 1 }]`. `createCompany` refuses that intake
  // at the door, but the migration and the shim write `name_options` through other paths, and
  // the filer is the last thing standing between a nameless company and a real filing.
  const nameOptions: CompanyNameOption[] = d.company.nameOptions;
  if (nameOptions.length === 0 || nameOptions.some((n) => !n.name.trim())) {
    parkFormationStep(d, companyId, "create_provider", noNameOptionsError(), {
      reason: "intake_unreadable",
    });
    recordCompanyEvent(
      d.repo,
      d.company.companyId,
      "formationCreate",
      "formation create parked: intake unreadable",
    );
    opsLog("formation_intake_unreadable", {
      level: "error",
      severity: "CRITICAL",
      companyId,
      environment: d.environment,
    });
    return;
  }
  // ── THE FROZEN BODY (§4.5). Everything that shapes the create request is decided ONCE, at the
  //    first send under the current attempt, and read back from `detail` on every pass after it.
  const resolved = resolveSsn(d, row, detail, party);
  if ("park" in resolved) {
    parkFormationStep(d, companyId, "create_provider", resolved.park, { reason: resolved.reason });
    recordCompanyEvent(
      d.repo,
      d.company.companyId,
      "formationCreate",
      `formation create parked: ${resolved.reason}`,
    );
    opsLog("formation_ssn_unreadable", {
      level: "error",
      severity: "CRITICAL",
      companyId,
      reason: resolved.reason,
      environment: d.environment,
    });
    return;
  }
  const { ssn, ssnIncluded, expedited } = resolved;
  detail = {
    ...detail,
    nameOptions: nameOptions.map((n) => `${n.name} ${n.entityTypeEnding}`),
    expedited,
    ssnIncluded,
  };

  // `submitted` means "we are about to talk to doola". Written BEFORE the first call so a crash
  // during it is distinguishable from one before it — and written from WHATEVER state we found,
  // because a RETRY arrives at `failed`, not `pending`. Every persist below CASes on
  // `submitted`: leaving the row parked elsewhere would make each of them a silent no-op, and
  // the company id — the one thing that must survive — would never be written. The CAS on the
  // observed state is also what stops two drivers from racing one entity's create.
  if (row.state !== "submitted") {
    if (
      !requests.transition(companyId, "create_provider", row.state, "submitted", {
        detail: JSON.stringify(detail),
        error: null,
      })
    )
      return;
    logStep(companyId, "submitted", row.attempt);
  }

  // ONE key per endpoint, both derived from THIS attempt. Nothing below rotates them: an attempt
  // moves only when doola has told us, in as many words, that it refused the request.
  const keys = createProviderKeys(companyId, row.attempt);

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
  //
  //       It is also the write that FREEZES the body's shape: `companySentAttempt` goes down
  //       beside the `ssnIncluded` and `expedited` already written above, so a resume knows both
  //       that a create went out under this key AND what it looked like.
  if (detail.companySentAttempt !== row.attempt) {
    detail = { ...detail, companySentAttempt: row.attempt };
    persistDetail(d, detail);
  }

  // ── 4. The company. THE call that costs money.
  let company: DoolaCompany;
  try {
    company = await d.doola.createCompany(
      buildCompanyInput(d, party, customerId, nameOptions, expedited, ssn),
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
  //
  //       And this is the transaction §4.4 names: the SSN dies with the write that records the
  //       company id. It has been forwarded, once; nothing downstream ever needs it again.
  detail = { ...detail, companyId: company.doolaCompanyId };
  persistRefAndEraseSsn(d, () =>
    requests.transition(companyId, "create_provider", "submitted", "submitted", {
      providerRef: company.doolaCompanyId,
      detail: JSON.stringify(detail),
    }),
  );
  logStep(companyId, "submitted", row.attempt, { providerRef: company.doolaCompanyId });

  confirm(d, row, company.doolaCompanyId, {
    ...detail,
    submissionStatus: company.formationSubmissionStatus,
  });
}

/**
 * What the create body says about the SSN, on THIS pass (§4.4/§4.5).
 *
 * ── THE RULE, and why it is shaped like this ───────────────────────────────────────────────
 *
 * An `Idempotency-Key` is a pure function of the attempt, and doola answers a REPEAT of a key
 * with the committed response — but only for the SAME body. A different body under a live key is
 * a 409 `E_IDEMPOTENCY_KEY_REUSED`, which this module deliberately never re-keys past: it looks
 * for an existing company and otherwise parks for a human. So on any pass where doola may already
 * hold a body under the key we are about to use, the body has to be rebuilt BYTE-IDENTICALLY.
 *
 * The SSN is part of that body, and §4.4 deletes it in the very transaction that persists
 * `provider_ref`. Those two facts have to be reconciled, and this is the reconciliation:
 *
 *  - `frozen` is `detail.companySentAttempt === row.attempt` — "a company create has ALREADY gone
 *    out under the key we would use next". That is exactly the condition under which the body may
 *    not change;
 *  - when frozen, `ssnIncluded` and `expedited` are READ FROM `detail`, never recomputed. The row
 *    may have been erased since; the body must not notice;
 *  - when not frozen (a first send, or a retry after a `rejected` that burned the attempt and so
 *    released the key), both are computed from the row as it is NOW. A `rejected` create is the
 *    one case doola releases the key, which is also the one case §4.7 re-opens the intake — the
 *    two rules are the same rule seen from two sides;
 *  - if the body was frozen WITH an SSN and the SSN can no longer be read, there is no safe
 *    move: sending without it is a different body under a live key, and re-keying is a second
 *    real Wyoming LLC. It PARKS, CRITICAL, for a human.
 *
 * Is the last case reachable? Only by an operator or a bug: the erase and the `provider_ref`
 * write commit together, so "erased but no ref" cannot happen through the normal path — a pass
 * that finds a ref takes the ADOPT branch and never rebuilds a body at all. The §4.6a TTL clause
 * cannot cause it either: it erases only when the company is terminal or when nothing was ever
 * submitted. It is written out anyway, because the alternative to a park here is a silent 409 or
 * a duplicate filing.
 */
function resolveSsn(
  d: FormationCreateDeps,
  row: FormationRequestRecord,
  detail: CreateProviderDetail,
  party: FormationPartyRecord,
): { ssn?: Secret; ssnIncluded: boolean; expedited: boolean } | { park: string; reason: string } {
  const companyId = d.company.companyId;
  const stored = d.parties.findSsnByCompanyId(companyId);
  const frozen = detail.companySentAttempt === row.attempt;
  const ssnIncluded = frozen ? Boolean(detail.ssnIncluded) : Boolean(stored);
  // A function of the SSN, so it is frozen by the same rule (§4.5).
  const expedited = frozen
    ? Boolean(detail.expedited)
    : isNonUsResponsibleParty({ hasSsn: ssnIncluded, country: party.country });

  if (!ssnIncluded) return { ssnIncluded: false, expedited };
  // Frozen WITH an SSN, and the row no longer has one (or this box has lost the key).
  if (!stored || !d.pii)
    return { park: ssnUnreadableError(), reason: stored ? "ssn_no_key" : "ssn_erased" };
  try {
    return {
      // Decrypted HERE, at send time, and held for the length of the call and no longer. A
      // `Secret`, so the only way it reaches the wire is the explicit `reveal()` in
      // `buildCompanyInput` — every accidental stringification on the way is "[redacted]".
      ssn: decryptSsn(d.pii, stored, { partyId: stored.partyId, companyId }),
      ssnIncluded: true,
      expedited,
    };
  } catch {
    // The message is deliberately NOT propagated: it names a key id, which is fine, but the catch
    // is broad and this is the one path where a stack could carry ciphertext.
    return { park: ssnUnreadableError(), reason: "ssn_undecryptable" };
  }
}

/**
 * Persist a `provider_ref` and ERASE the SSN, in ONE transaction (§4.4).
 *
 * The atomicity is the whole point, in both directions. If the ref committed without the erase, a
 * filed company would keep an SSN it no longer needs — a retention breach with no clock to catch
 * it but the §4.6a backstop. If the erase committed without the ref, the next pass would rebuild
 * a frozen body it can no longer complete and park for a human (see `resolveSsn`).
 *
 * The erase is NOT conditional on the CAS winning. A lost CAS means another driver persisted the
 * same ref in the same instant, so the design's condition — "the transaction that persists
 * `doola_company_id`" — holds either way, and `eraseSsn` is idempotent.
 *
 * The reason is not a parameter. Both call sites are this one fact — a `provider_ref` reached the
 * row — and a single-literal argument is a knob nobody may turn.
 */
function persistRefAndEraseSsn(d: FormationCreateDeps, write: () => boolean): boolean {
  let moved = false;
  d.repo.transaction(() => {
    moved = write();
    if (d.parties.eraseSsn(d.company.companyId))
      // The reason, the company, and nothing else. An erasure line that named the person would be
      // the one place their data outlived the erasure.
      opsLog("formation_ssn_erased", {
        companyId: d.company.companyId,
        reason: "provider_persisted",
        environment: d.environment,
      });
  });
  return moved;
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
  parkFormationStep(d, d.company.companyId, "create_provider", reason, {
    providerRef: row.providerRef ?? undefined,
    endpoint,
    kind,
    code: described.code,
  });
  recordCompanyEvent(
    d.repo,
    d.company.companyId,
    "formationCreate",
    `formation create parked (${kind}): ${reason}`,
  );
  opsLog("formation_create_parked", {
    companyId: d.company.companyId,
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
  nameOptions: CompanyNameOption[],
  expedited: boolean,
  ssn: Secret | undefined,
): CreateCompanyInput {
  const address = toDoolaAddress(party);
  return {
    doolaCustomerId: customerId,
    entityType: FORMATION_ENTITY_TYPE,
    state: FORMATION_STATE,
    // Position is stored, not recomputed: the ranking IS the intake, and `position` is a required
    // column of the canonical shape — a fallback here would be a second opinion about the order.
    nameOptions: nameOptions.map((n) => ({
      name: n.name,
      entityTypeEnding: n.entityTypeEnding,
      position: n.position,
    })),
    // The company's OWN intake, not the agent's description: the purpose describes the legal
    // body, and from A2 it is a required field on the create form.
    industry: d.company.industryLabel || DEFAULT_INDUSTRY,
    description: d.company.businessPurpose || DEFAULT_DESCRIPTION,
    responsibleParty: {
      legalFirstName: party.legalFirstName,
      legalLastName: party.legalLastName,
      email: party.email,
      address,
      // THE ONE PLACE an SSN leaves this system (§4.3), and it leaves it ONCE. doola derives
      // US-vs-non-US from any one person's `ssn`, and the responsible party is the IRS-relevant
      // one, so sending it here is sufficient — `createCustomer` takes none and `members[].ssn`
      // is never populated, which is the minimum exposure that still gets the EIN issued.
      //
      // Spread conditionally so an absent SSN produces a body with NO `ssn` key at all: an
      // explicit `ssn: undefined` serializes away in JSON, but the shape of the object is what a
      // reader of this file has to trust, and "the key is not there" is the honest one.
      //
      // ⚠ THE ONLY `.reveal()` IN THE SYSTEM. Everywhere else the decrypted value is a `Secret`
      // that stringifies to "[redacted]"; this line is the wire boundary, and a second caller of
      // `reveal()` is a review question by construction (`grep -rn "\.reveal()" src`).
      ...(ssn !== undefined ? { ssn: ssn.reveal() } : {}),
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
      companyId: d.company.companyId,
      level: "warn",
      count: companies.length,
    });
    return undefined;
  } catch (e) {
    opsLog("formation_lookup_failed", {
      companyId: d.company.companyId,
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
  doolaCompanyId: string,
  detail: CreateProviderDetail,
  known?: DoolaCompany,
): Promise<void> {
  let company = known;
  if (!company) {
    try {
      company = await d.doola.getCompany(doolaCompanyId);
    } catch (e) {
      // The company EXISTS — we hold its id — and we simply could not read it right now. Parked
      // without burning the attempt (C1/C3): this is a read, it attempted nothing and committed
      // nothing, and eight transient read failures must not `abandon` a company Wyoming has
      // already filed (which is also what would erase the responsible party's data).
      const described = describeDoolaError(e);
      parkFormationStep(
        d,
        d.company.companyId,
        "create_provider",
        `could not read the company we already filed (${doolaCompanyId}): ${described.message}`,
        { providerRef: doolaCompanyId, code: described.code },
      );
      return;
    }
  }
  confirm(d, row, doolaCompanyId, {
    ...detail,
    companyId: doolaCompanyId,
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
  doolaCompanyId: string,
  detail: CreateProviderDetail,
): void {
  const { requests } = d;
  const companyId = d.company.companyId;
  // CAS on the state the row is ACTUALLY in, re-read here rather than assumed to be `submitted`.
  //
  // The create path does arrive at `submitted`, but the ADOPT path does not: adoption happens
  // BEFORE the body preconditions (a company that exists must be adopted whatever the party data
  // looks like now), so a row the sweeper is retrying arrives here still parked in `failed`. A
  // hardcoded `from` made that transition a silent no-op — the company existed, was read, and the
  // row stayed `failed` until it burned through eight attempts and was abandoned. Found by part
  // B's sweeper test; the retry path had no coverage before it.
  const from = requests.find(companyId, "create_provider")?.state ?? row.state;
  if (from === "confirmed" || from === "abandoned") return;
  // §4.4's transaction again, and this is the arm that covers the ADOPT path: a company found by
  // the pre-create lookup, or resumed from a persisted ref, reaches its `provider_ref` here and
  // nowhere else. `eraseSsn` is idempotent, so the create path passing through both writes is a
  // no-op the second time.
  persistRefAndEraseSsn(d, () =>
    requests.transition(companyId, "create_provider", from, "confirmed", {
      providerRef: doolaCompanyId,
      detail: JSON.stringify(detail),
      error: null,
    }),
  );
  recordCompanyEvent(
    d.repo,
    d.company.companyId,
    "formationCreate",
    JSON.stringify({
      providerRef: doolaCompanyId,
      submissionStatus: detail.submissionStatus ?? null,
      adopted: Boolean(detail.adopted),
      environment: d.environment,
    }),
  );
  logStep(companyId, "confirmed", row.attempt, {
    providerRef: doolaCompanyId,
    adopted: Boolean(detail.adopted),
  });
}

/** Write the current detail back without moving the row (a CAS on `submitted` -> `submitted`). */
function persistDetail(d: FormationCreateDeps, detail: CreateProviderDetail): void {
  d.requests.transition(d.company.companyId, "create_provider", "submitted", "submitted", {
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
  const companyId = d.company.companyId;
  const described: { code?: string; requestId?: string } = cause ? describeDoolaError(cause) : {};
  // The bump-then-park sequence itself lives in `formationStep.ts`: the webhook processor and the
  // sweeper park rows too, and three copies of that contract would be three chances to burn an
  // attempt without parking the row (or the reverse). What stays HERE is what is specific to the
  // create: the entity audit event, and doola's own error code on the ops line.
  failFormationStep(d, companyId, "create_provider", error, { code: described.code });
  recordCompanyEvent(
    d.repo,
    d.company.companyId,
    "formationCreate",
    `formation create failed: ${error}`,
  );
  opsLog("formation_create_failed", {
    companyId,
    level: "warn",
    code: described.code,
    requestId: described.requestId,
  });
}
