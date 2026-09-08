import { assertGuardianAllowed } from "../api/routes/worldId";
import {
  businessPurposeRequiredMessage,
  businessPurposeTooLongMessage,
  companyIntakeFrozenMessage,
  companyNameBlankMessage,
  companyNameCharsetMessage,
  companyNameDuplicateMessage,
  companyNameEndingOnlyMessage,
  companyNameRestrictedMessage,
  companyNameTooLongMessage,
  companyNamesRequiredMessage,
  companyUnavailableMessage,
  formationCeilingReachedMessage,
  formationPartyUnavailableMessage,
  formationQuotaExhaustedMessage,
  industryLabelRequiredMessage,
  industryLabelUnknownMessage,
  partyFrozenMessage,
  sqliteUtcTimestamp,
  ssnFormatMessage,
  ssnRefusedHereMessage,
  ssnUnavailableMessage,
  syntheticPiiRefusedMessage,
  syntheticPiiRequiredMessage,
  truncateTenant,
  warnIfNearLimit,
} from "../formation";
import { opsLog } from "../observability/opsLog";
import type { CompanyRepository, CompanyStatus } from "../persistence/companyRepository";
import type {
  EditablePartyFields,
  FormationPartyRepository,
} from "../persistence/formationPartyRepository";
import { parseDetail } from "../persistence/formationRepository";
import { partyEditAllowed } from "./freeze";
import type { CompanyIntake, CompanyPin } from "./intake";
import {
  NAME_MAX_LENGTH,
  NAME_OPTION_COUNT,
  PURPOSE_MAX_LENGTH,
  canonicalizeIntakeText,
  companyNameOptions,
  duplicateKey,
  firstIllegalNameChar,
  stripEntityEnding,
} from "./intake";
import { isKnownIndustryLabel } from "./naicsLabels";
import { type PiiKeyring, encryptSsn, isWellFormedSsn } from "./pii";
import { eraseSsnLogged } from "./ssnErasure";
import { findRestrictedWord } from "./wyRestrictedWords";

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
  /**
   * The sub-saga rows. Narrow on purpose — the door needs exactly three things from them:
   *
   *  - `createRequestsSince` for the platform DAILY ceiling, which still counts `create_provider`
   *    rows because that is where the fee is actually incurred (with payment on, a company can
   *    sit in draft for days before its create fires);
   *  - `find` + `transition` so a successful edit-and-retry can RE-ARM the filing step it just
   *    unblocked, in the same transaction as the edit (§4.7 — see `updateCompanyIntake`).
   */
  requests: Pick<
    import("../persistence/formationRepository").FormationRepository,
    "createRequestsSince" | "find" | "transition"
  >;
  /** What this deployment pins a company to. Never caller input. */
  pin: CompanyPin;
  /** True = this deployment files with a labeled sandbox identity and refuses real PII. */
  sandboxSyntheticPii: boolean;
  maxPerTenant: number;
  dailyCeiling: number;
  /**
   * The SSN encryption keyring (§4.2). Absent on every deployment that does not collect one —
   * which is every deployment except production doola, where it is a BOOT invariant.
   *
   * Its absence is never a reason to store plaintext: the door refuses the field instead.
   */
  pii?: PiiKeyring;
  /** The company INSERT, the party bind CAS and the SSN write commit together, or not at all. */
  transaction: <T>(fn: () => T) => T;
  /** The World gate. Absent (or unwired) = no personhood check, exactly as on every other door —
   *  which is why production formation has a BOOT invariant that this is constructed. */
  world?: import("../api/routes/worldId").WorldIdDeps;
  now?: () => number;
}

/**
 * The intake, in the ONE shape that exists (design §5) since A3 removed the shim.
 *
 * Three validated name candidates, a purpose of the COMPANY's own — the agent's description is
 * not doola-visible — and an industry from the shipped reference list. A2 kept a second,
 * structurally distinct shape (`synthesizedName`) for the A1 shim, so that no production door
 * could fall into the derived-name path by leaving a field out; with the shim gone the derived
 * path has no callers at all, and the safest version of that rule is that the field does not
 * exist. `intake_synthesized = 1` survives only on rows the MIGRATION wrote, which is exactly
 * what it was for.
 */
export interface CompanyIntakeInput {
  partyId: string;
  /** Exactly three ranked candidates. */
  names?: string[];
  /** Required, and the company's own — never the agent's description. */
  businessPurpose?: string;
  /** One of the shipped NAICS labels. */
  industryLabel?: string;
  /**
   * The responsible party's SSN, in doola's `XXX-XX-XXXX` (§4.1).
   *
   * REST, production, and optional even there. It rides THIS request because the AAD it is
   * sealed under is `party_id || company_id`, and the company id does not exist until this
   * function mints it. MCP never passes it and sandbox deployments refuse it outright.
   */
  ssn?: string;
  /**
   * "File without one" — the §4.6a decision, and the OTHER way out of the park a TTL erasure
   * causes (`updateCompanyIntake` only).
   *
   * It is a deliberate statement rather than the absence of one, because an omitted `ssn` on a
   * PATCH already means something else (see the erase in `updateCompanyIntake`). This is the
   * caller saying: the number I gave you was destroyed by the retention clock, I am not
   * supplying another, file the SS-4 route instead.
   */
  proceedWithoutSsn?: boolean;
  /** The caller's CLAIM about the deployment, checked against it — never the stored value. */
  synthetic?: boolean;
}

export type CreateCompanyResult = { companyId: string } | { error: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The party-bind CAS lost, expressed as an exception because that is the only thing better-sqlite3
 * treats as a rollback.
 *
 * Private to this module and never surfaced: the caller sees `formationPartyUnavailableMessage()`,
 * the same sentence every other arm of the single-use rule returns.
 */
class PartyBindLost extends Error {}

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

  // 6. THE SSN GATE (§4.1), before any validation that could accept it. ONE helper, shared with
  //    the §4.7 re-capture door — see `gateSsn`. The environment here is the DEPLOYMENT's pin,
  //    because the company being gated does not exist yet.
  const ssn = intake.ssn;
  const gated = gateSsn(ssn, deps.pin.environment, deps);
  if ("error" in gated) return gated;
  const sealed = gated.sealed;

  // 7. Intake validation, in whichever of the two shapes this caller sent (§5).
  const validated = validateIntake(intake);
  if ("error" in validated) return validated;
  const built = validated.intake;

  // 8. The mint. The INSERT, the bind CAS and the SSN write are ONE transaction (§4.2):
  //    losing the CAS — another request took this party between step 3 and here — rolls all
  //    three back, and an SSN can never outlive the company row it was sealed against.
  //
  //    A1 lands `ready` unconditionally, because payment is off: a `draft` company would owe a
  //    payment step that does not exist yet and would never be filed. B1 is what makes `draft`
  //    reachable, together with the quote that leaves it.
  const status: CompanyStatus = "ready";
  let companyId: string;
  try {
    companyId = deps.transaction(() => {
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
      // THROWN, not returned. better-sqlite3 rolls a transaction back on an EXCEPTION and on
      // nothing else: a callback that returns `false` COMMITS, and the company row it just
      // inserted survives — orphaned, with no party, counting against the tenant's quota and
      // sitting in `listUnopened`'s reach forever. The sentinel is caught immediately below and
      // converted back into the door's one refusal message.
      if (!deps.parties.bindToCompany(intake.partyId, id, tenantId)) throw new PartyBindLost();
      // The SSN, encrypted HERE because the AAD is `party_id || company_id` and the company id
      // did not exist a line ago. A failed write is a thrown sentinel for the same reason the
      // bind is: an accepted SSN that silently did not persist would leave the caller believing
      // the fast EIN route was in play and the filer sending a body without it.
      if (sealed) {
        const bind = { partyId: intake.partyId, companyId: id };
        if (!deps.parties.storeSsn(intake.partyId, id, encryptSsn(sealed.pii, sealed.ssn, bind)))
          throw new PartyBindLost();
      }
      return id;
    });
  } catch (e) {
    if (e instanceof PartyBindLost) return { error: formationPartyUnavailableMessage() };
    throw e;
  }

  // The ops line carries WHETHER an SSN was taken, never the value and never a fragment of it —
  // "did this filing take the fast EIN route?" is an operational question, and the answer is a
  // boolean. (test/formation/ssnNeverLogged.test.ts asserts the whole create path.)
  opsLog("company_created", {
    companyId,
    tenantId: truncateTenant(tenantId),
    environment: deps.pin.environment,
    synthetic: deps.sandboxSyntheticPii,
    intakeSynthesized: built.synthesized,
    ssnCaptured: ssn !== undefined,
  });
  // The door gate's own rule, at company scope — the SAME function, so "near" cannot mean two
  // different things on two doors that spend the same money.
  warnIfNearLimit("formation_quota_warning", used + 1, deps.maxPerTenant, {
    tenantId: truncateTenant(tenantId),
  });
  return { companyId };
}

/**
 * EDIT-AND-RETRY (design 2026-08-26 §4.7) — re-open a frozen intake, with a fresh SSN capture.
 *
 * The rule is one sentence: intake is FROZEN once the first create has been sent, and re-openable
 * only in the case where the provider REJECTED it. That is not a UX preference, it is the
 * idempotency contract: a `rejected` create is the one failure that releases doola's key (and the
 * only one that burns our attempt — C1), so it is the only one after which a NEW body may be sent
 * at all. Everything else parks with the SAME key, and a changed body under a live key is a 409.
 *
 * The predicate itself lives in `companies.updateIntake`'s WHERE clause, NOT here: three surfaces
 * can reach a company, and a route-level check is a check one more door can forget. This function
 * owns what a repository cannot — ownership, validation, and the SSN re-capture — and reads the
 * repository's answer for the freeze.
 *
 * The whole thing is ONE transaction: a re-opened intake with the old SSN still attached, or a
 * new SSN attached to un-rewritten names, are both worse than either half failing.
 *
 * ⚠ THE STORED SSN IS ERASED UNCONDITIONALLY on a successful re-open, and that is a decision, not
 * a side effect. A `rejected` filing is often rejected BECAUSE of the number — a typo, an ITIN
 * where doola wanted an SSN, a person who turns out not to be a US taxpayer — and "correct it by
 * leaving it out" is the most natural thing a caller can do. If the old value survived an
 * omission, that gesture would silently re-send the very number doola refused. So the retried
 * body carries an SSN only if THIS request supplied one.
 */
export function updateCompanyIntake(
  deps: CreateCompanyDeps,
  tenantId: string,
  companyId: string,
  intake: Omit<CompanyIntakeInput, "partyId">,
): { companyId: string } | { error: string } {
  // Ownership first, and the same not-an-oracle rule the rest of the door follows: an unknown id
  // and somebody else's id get one answer.
  const company = deps.companies.findOwned(tenantId, companyId);
  if (!company) return { error: companyUnavailableMessage() };

  const party = deps.parties.findByCompanyId(companyId);
  if (!party) return { error: formationPartyUnavailableMessage() };

  // The SSN gate — the SAME function the create runs, so the two doors refuse the same things in
  // the same words. The environment is the COMPANY's pin rather than the deployment's: the pin is
  // stamped at claim and immutable after (audit M5), it is what actually routes the filing, and a
  // company pinned to sandbox on a box that has since been re-pointed at production must still
  // refuse the field.
  const ssn = intake.ssn;
  const gated = gateSsn(ssn, company.environment, deps);
  if ("error" in gated) return gated;
  const sealed = gated.sealed;

  const validated = validateIntake(intake);
  if ("error" in validated) return validated;
  const built = validated.intake;
  // A re-opened intake is typed by a human, so the synthesized path has no business here: it
  // would silently discard the three candidates the caller just supplied.
  if (built.synthesized) return { error: companyNamesRequiredMessage() };

  let frozen = false;
  try {
    deps.transaction(() => {
      if (!deps.companies.updateIntake(companyId, built)) {
        frozen = true;
        return;
      }
      // Erase FIRST and ALWAYS — see the ⚠ above. `storeSsn` is write-once while a ciphertext
      // exists, so this is also what makes room for a replacement, and it clears `ssn_deleted_at`
      // so the row never holds a live ciphertext under a deletion stamp.
      eraseSsnLogged(deps.parties, companyId, "intake_reopened", company.environment);
      if (sealed) {
        const bind = { partyId: party.partyId, companyId };
        if (
          !deps.parties.storeSsn(party.partyId, companyId, encryptSsn(sealed.pii, sealed.ssn, bind))
        )
          throw new PartyBindLost();
      } else if (intake.proceedWithoutSsn === true) {
        // §4.6a's second exit: the clock took their number and they have decided to file without
        // one. Recorded as a FACT on the row, which is what lets the parked filing resume.
        deps.parties.proceedWithoutSsn(companyId);
      }
      // …and RE-ARM the filing step this edit exists to unblock, in the same transaction as the
      // edit. A `rejected` create parks for a human precisely so it is never retried with the body
      // doola already refused; the successful PATCH is the evidence that the body has changed, and
      // therefore the only thing that may put the row back in the sweeper's reach.
      //
      // THIS flag and no other: a rejected `createCustomer` parks under `awaitingPartyEdit`, and
      // none of the four fields this door rewrites is one `createCustomer` reads.
      rearmAfterEdit(deps, companyId, "awaitingIntakeEdit");
    });
  } catch (e) {
    // SYMMETRY with the create, which has caught this since A2's first commit. The sentinel is
    // thrown rather than returned because better-sqlite3 rolls back on an EXCEPTION and on
    // nothing else — and an uncaught one leaves the door answering 500 to a race the create door
    // answers with a sentence. It is not reachable through the normal path (the party was read
    // and the freeze checked moments earlier), which is exactly why it must not be the one arm
    // that behaves differently.
    if (e instanceof PartyBindLost) return { error: formationPartyUnavailableMessage() };
    throw e;
  }
  if (frozen) return { error: companyIntakeFrozenMessage() };

  opsLog("company_intake_updated", {
    companyId,
    tenantId: truncateTenant(tenantId),
    environment: company.environment,
    ssnCaptured: ssn !== undefined,
    proceedWithoutSsn: intake.proceedWithoutSsn === true,
  });
  return { companyId };
}

/**
 * THE PARTY-EDIT DOOR (design §7, A3) — correct the responsible person doola refused, ADDRESSED
 * BY COMPANY.
 *
 * A2 left a company that doola rejected on its PARTY parked with no exit at all: the flag was
 * written, `rearmAfterPartyEdit` was exported, and the note on both operator surfaces said
 * "correcting a party is not yet self-service". This is that door.
 *
 * It lives beside `updateCompanyIntake` because it is the same shape and the same three
 * obligations — ownership, validation, and a RE-ARM in the transaction that made the edit — and
 * because the two are the only writes in the system that reopen a parked filing. What differs is
 * WHICH flag it clears, and that is the whole of A2's finding 5b: `PATCH /companies/:id` rewrites
 * names, purpose, industry and the SSN, none of which is what a rejected `createCustomer`
 * objected to. Each door clears its own, and neither touches the other's.
 *
 * ⚠ THE ADDRESS IS THE COMPANY, and that is a security property rather than a convenience. The
 * first version took a `partyId`, which made the door capable of touching ANY party the tenant
 * owns — including the one bound to a DIFFERENT company, mid-filing — with only a
 * `partyEditAllowed` check standing between a mistyped handle and an identity swap on the wrong
 * Wyoming LLC. It also forced the UI to ask a human to paste a uuid that no surface serves, which
 * is a field people get wrong. Addressed by company, the party is RESOLVED (`findByCompanyId`, a
 * UNIQUE column), so touching another company's party is not a rule this function enforces — it
 * is a sentence that cannot be expressed.
 *
 * The cost, stated: an UNBOUND party — created by `POST /formation-party` and never spent on a
 * company — has no edit door. It also has no filing, no park and nothing to correct, and the C7
 * sweep erases it after seven days; the caller's move is to register a new identity.
 *
 * ⚠ NO `ssn`, structurally. The party's SSN is written by `POST /companies` (which mints the AAD
 * the ciphertext is sealed under) and re-captured by `PATCH /companies/:companyId`. There is no
 * field for one here, on either surface, so an SSN cannot arrive at a door that would then have
 * to decide what to do with it.
 *
 * ⚠ It DOES carry the synthetic-PII gate, in both directions, because it is a PII INTAKE and was
 * the one that did not run it. `createFormationParty` refuses real personal data on a
 * `sandboxSyntheticPii` deployment and refuses the synthetic shortcut on a production one, and
 * `createCompany` re-asserts the same rule against the party ROW. This door rewrote the ten
 * identity columns with neither check: on a sandbox box a real name, email, phone and home
 * address could be written over a labeled fixture and then filed to doola's DEVELOPMENT
 * environment as the responsible person — the precise harm the sandbox refusal exists to prevent.
 */
export function updateCompanyParty(
  deps: Pick<
    CreateCompanyDeps,
    "companies" | "parties" | "requests" | "transaction" | "sandboxSyntheticPii"
  >,
  tenantId: string,
  companyId: string,
  fields: EditablePartyFields,
): { partyId: string } | { error: string } {
  // The DEPLOYMENT's half of the gate, first and without a lookup — `createCompany`'s order, and
  // the same words. This door has no synthetic shortcut (the labeled fixture is ours to generate,
  // never a caller's to re-type), so every body reaching it is real personal data and a sandbox
  // deployment refuses all of them.
  if (deps.sandboxSyntheticPii) return { error: syntheticPiiRequiredMessage() };

  // Ownership of the COMPANY, exactly as `updateCompanyIntake` checks it, and with the same
  // not-an-oracle rule: an unknown id and somebody else's get ONE answer.
  const company = deps.companies.findOwned(tenantId, companyId);
  if (!company) return { error: companyUnavailableMessage() };
  // The party is RESOLVED from the company, never named by the caller — `company_id` is UNIQUE on
  // `formation_parties`, so this is the one identity that filing was opened with.
  const party = deps.parties.findByCompanyId(companyId);
  if (!party) return { error: formationPartyUnavailableMessage() };
  // …and the ROW's half of the synthetic gate. A synthetic party on a production box is a bug
  // rather than a request — the row was minted through the same gate — but it is the bug that
  // would put a real person's identity onto a filing labeled synthetic on every surface.
  if (party.synthetic) return { error: syntheticPiiRefusedMessage() };

  const step = deps.requests.find(companyId, "create_provider");
  if (!partyEditAllowed(step)) return { error: partyFrozenMessage() };

  let moved = false;
  deps.transaction(() => {
    moved = deps.parties.update(party.partyId, tenantId, fields);
    if (!moved) return;
    // …and RE-ARM the filing step this edit exists to unblock, in the SAME transaction as the
    // edit — `updateCompanyIntake`'s rule with the other flag. The edit IS the evidence that the
    // next body will be different, and it is the only thing that may put the row back in the
    // sweeper's reach. A no-op for a row that is not parked.
    rearmAfterPartyEdit(deps, companyId);
  });
  // The row vanished between the read and the write (an erasure sweep). Same sentence as above.
  if (!moved) return { error: formationPartyUnavailableMessage() };

  // The ONLY trail this leaves, exactly as the create's: which tenant edited which handle. No
  // name, no address, no email — and no diff, which would be the whole identity in a log line.
  opsLog("formation_party_updated", {
    tenantId: truncateTenant(tenantId),
    partyId: party.partyId,
    companyId,
  });
  return { partyId: party.partyId };
}

/**
 * THE SSN GATE (§4.1), as ONE function for the two doors that can carry one.
 *
 * Three refusals in a fixed order, and every one of them is a REFUSAL rather than a quiet drop:
 *
 *  1. a sandbox or synthetic deployment refuses the FIELD. Quietly dropping it leaves a caller
 *     believing they supplied one; quietly accepting it puts a real person's Social Security
 *     Number in a partner's DEVELOPMENT environment;
 *  2. a malformed value is a specific 400, not a blob nobody can inspect and a `rejected` filing
 *     on a real fee;
 *  3. no keyring is a refusal, not a plaintext write. Unreachable on a correctly-booted
 *     production box — `FORMATION_PII_KEY` is a boot invariant (§4.2) — which is exactly why it
 *     must be here: the failure mode it guards is a misconfiguration.
 *
 * It had two copies, and they had already drifted on the one input that is genuinely different
 * between the doors: WHICH environment is authoritative. That argument is therefore the caller's,
 * and each call site states its reasoning.
 *
 * The success value is a PAIR, narrowed here, so no caller can reach an SSN without the key that
 * seals it — a non-null assertion at the write would be the same claim, unchecked.
 */
function gateSsn(
  ssn: string | undefined,
  environment: string,
  deps: Pick<CreateCompanyDeps, "sandboxSyntheticPii" | "pii">,
): { sealed?: { ssn: string; pii: PiiKeyring } } | { error: string } {
  if (ssn === undefined) return {};
  if (deps.sandboxSyntheticPii || environment !== "production")
    return { error: ssnRefusedHereMessage() };
  if (!isWellFormedSsn(ssn)) return { error: ssnFormatMessage() };
  if (!deps.pii) return { error: ssnUnavailableMessage() };
  return { sealed: { ssn, pii: deps.pii } };
}

/**
 * Put a create step that is PARKED AWAITING AN EDIT back in the sweeper's reach (§4.7).
 *
 * A `rejected` create marks itself parked and the sweeper skips it: re-sending a body doola has
 * already looked at and refused cannot succeed, and the eight backoff retries it used to burn
 * ended in `abandonFormation` — which erases the responsible party's data overnight and forecloses
 * the edit-and-retry the design offers.
 *
 * Clearing the flag is therefore not bookkeeping, it is the whole point of the door: the edit IS
 * the evidence that the next body will be different. It is a CAS from `failed` onto itself, so a
 * row another driver has since moved is left alone, and the error text is preserved — the operator
 * trail should still say what doola refused.
 *
 * ⚠ THE FLAG IS AN ARGUMENT, and each door clears ITS OWN. `create_provider` sends two bodies —
 * the responsible party to `createCustomer`, then the intake to `createCompany` — and either can
 * be the one doola refused. `PATCH /companies/:companyId` changes names, purpose, industry and
 * the SSN; NONE of those is what a rejected `createCustomer` objected to. A door that cleared
 * both flags would re-arm a retry of a customer body that had not changed at all, which is the
 * exact loop this park exists to stop.
 */
function rearmAfterEdit(
  deps: Pick<CreateCompanyDeps, "requests">,
  companyId: string,
  flag: "awaitingIntakeEdit" | "awaitingPartyEdit",
): void {
  const row = deps.requests.find(companyId, "create_provider");
  if (!row || row.state !== "failed") return;
  const detail = parseDetail<Record<string, unknown>>(row.detail);
  if (detail[flag] !== true) return;
  const { [flag]: _cleared, ...rest } = detail;
  deps.requests.transition(companyId, "create_provider", "failed", "failed", {
    detail: JSON.stringify(rest),
    error: row.error ?? null,
    // Nothing about the WORLD moved — a flag came off a row. Moving `facts_updated_at` here
    // would re-derive and re-hash the manifest of every agent attached to this company.
    touchFacts: false,
  });
}

/**
 * The PARTY half of the same hook, EXPORTED and not yet called (review 5b).
 *
 * A `createCustomer` rejection parks under `awaitingPartyEdit`, and there is no door that can
 * clear it: editing a responsible party is A3's route, and until it exists a company parked here
 * needs a person. That is stated on both operator surfaces rather than left to be discovered.
 *
 * This lives here, beside the intake's, so that A3's party-edit door is one call rather than a
 * second opinion about the CAS, the preserved error text and the `touchFacts: false` — every one
 * of which is a decision the intake door had to get right and would otherwise be re-derived.
 * Call it inside the transaction that actually rewrote the party, exactly as
 * `updateCompanyIntake` calls the intake one: the edit is the evidence.
 */
export function rearmAfterPartyEdit(
  deps: Pick<CreateCompanyDeps, "requests">,
  companyId: string,
): void {
  rearmAfterEdit(deps, companyId, "awaitingPartyEdit");
}

/**
 * The intake validator (§5) — ONE function, used by the create and by the §4.7 re-capture.
 *
 * Exported because edit-and-retry writes the same three fields under the same rules, and two
 * validators is how a company ends up holding a name the create door would have refused. It is
 * pure: it canonicalizes and judges, and it touches no repository.
 *
 * Order matters and is deliberate: the SHAPE first (three candidates, present), then each
 * candidate in position order, then the cross-candidate rule (duplicates), then purpose, then
 * industry. A caller fixing a form gets the first thing wrong with it, in the order they typed.
 */
export function validateIntake(
  intake: Pick<CompanyIntakeInput, "names" | "businessPurpose" | "industryLabel">,
): { intake: CompanyIntake } | { error: string } {
  const raw = intake.names;
  if (!Array.isArray(raw) || raw.length !== NAME_OPTION_COUNT)
    return { error: companyNamesRequiredMessage() };

  const names: string[] = [];
  const seen = new Map<string, number>();
  for (const [i, candidate] of raw.entries()) {
    const position = i + 1;
    if (typeof candidate !== "string") return { error: companyNameBlankMessage(position) };
    const name = canonicalizeIntakeText(candidate);
    if (!name) return { error: companyNameBlankMessage(position) };
    if (name.length > NAME_MAX_LENGTH)
      return { error: companyNameTooLongMessage(position, NAME_MAX_LENGTH) };
    const illegal = firstIllegalNameChar(name);
    if (illegal) return { error: companyNameCharsetMessage(position, illegal) };
    // The ending is a separate field on the wire; a name that is nothing else has no name in it.
    if (!stripEntityEnding(name)) return { error: companyNameEndingOnlyMessage(position) };
    const restricted = findRestrictedWord(name);
    if (restricted) return { error: companyNameRestrictedMessage(position, restricted) };
    // Compared in the form Wyoming would compare them: three candidates that are really one
    // leave the filing with no fallback when the first is taken.
    const key = duplicateKey(name);
    if (seen.has(key)) return { error: companyNameDuplicateMessage(position) };
    seen.set(key, position);
    names.push(name);
  }

  const businessPurpose = canonicalizeIntakeText(intake.businessPurpose ?? "");
  if (!businessPurpose) return { error: businessPurposeRequiredMessage() };
  if (businessPurpose.length > PURPOSE_MAX_LENGTH)
    return { error: businessPurposeTooLongMessage(PURPOSE_MAX_LENGTH) };

  const industryLabel = canonicalizeIntakeText(intake.industryLabel ?? "");
  if (!industryLabel) return { error: industryLabelRequiredMessage() };
  // An unlisted label reaches doola and comes back rejected on a real fee.
  if (!isKnownIndustryLabel(industryLabel))
    return { error: industryLabelUnknownMessage(industryLabel) };

  return {
    intake: {
      // ONE producer of the stored shape, exactly as A1 left it: positions 1-3, the ending split
      // off, and the §5 matcher comparing against these rows.
      nameOptions: companyNameOptions(...names),
      businessPurpose,
      industryLabel,
      synthesized: false,
    },
  };
}
