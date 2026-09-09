"use client";

import { useMemo, useState } from "react";
import {
  usePublicConfigQuery,
  useUpdateCompanyIntakeMutation,
  useUpdateCompanyPartyMutation,
} from "@/lib/api/hooks";
import type { CompanyDetailView } from "@/lib/api/types";
import {
  industryIndex,
  intakeFormOf,
  intakeRulesOf,
  isCompanyIntakeValid,
  validateCompanyIntake,
  type CompanyIntakeForm,
} from "@/lib/formation/companyIntake";
import { emptyParty, isPartyValid, toFormationPartyInput, validateParty, type FormationParty } from "@/components/onboarding/types";
import { CompanyIntakeFields } from "@/components/onboarding/steps/CompanyIntakeFields";
import { PartyFields } from "@/components/onboarding/steps/PartyFields";
import { SsnInput } from "@/components/onboarding/steps/SsnInput";
import {
  Button,
  Callout,
  Card,
} from "@/components/onboarding/primitives";
import { useFormationRulesQuery } from "@/lib/api/hooks";
import { formationCopyOf } from "@/lib/formation/copy";

/**
 * A PARKED FILING, and the one thing its owner can do about it (design §4.6a/§4.7/§7).
 *
 * A2 gave a filing three ways to stop and wait for a human. All three were correct and none was
 * visible: from outside, a company that had simply stopped. Two of the three have an exit only
 * the owner can take, and this panel is where they take it.
 *
 * The three are rendered SEPARATELY rather than as one "something is wrong" banner, because they
 * have three different exits and pointing somebody at the wrong form is worse than saying nothing:
 *
 *  - `awaitingIntakeEdit` — the provider refused the COMPANY. Re-submit names, purpose, industry;
 *  - `awaitingPartyEdit` — it refused the PERSON. None of the intake fields is what it objected to;
 *  - `awaitingSsnDecision` — the retention clock destroyed an SSN before the filing was sent, and
 *    the choice between re-supplying it and the slower route is the owner's to make.
 *
 * Every sentence comes from `/config`, so the description of a behaviour is versioned with the
 * backend that implements it rather than with this bundle.
 */
export function CompanyParkPanel({ company }: { company: CompanyDetailView }) {
  const { data: config } = usePublicConfigQuery();
  // Served where the backend answered, bundled where it did not (`formationCopyOf`). It used to
  // be `config?.formationCopy?.park` with a bare fallback TITLE and no fallback sentences, so a
  // deployment that had not shipped the field showed a parked filing as a heading and a form
  // with nothing saying what had happened or what one edit buys.
  const copy = formationCopyOf(config).park;
  const { awaitingIntakeEdit, awaitingPartyEdit, awaitingSsnDecision } = company.park;
  if (!awaitingIntakeEdit && !awaitingPartyEdit && !awaitingSsnDecision) return null;

  return (
    <div className="flex flex-col gap-5">
      {awaitingIntakeEdit && (
        <ParkCard copy={copy.awaitingIntakeEdit}>
          <IntakeEditForm company={company} />
        </ParkCard>
      )}
      {awaitingSsnDecision && (
        <ParkCard copy={copy.awaitingSsnDecision}>
          <SsnDecisionForm company={company} />
        </ParkCard>
      )}
      {awaitingPartyEdit && (
        <ParkCard copy={copy.awaitingPartyEdit}>
          <PartyEditForm company={company} />
        </ParkCard>
      )}
    </div>
  );
}

function ParkCard({
  copy,
  children,
}: {
  /** Always present — served or bundled, resolved once by `formationCopyOf`. */
  copy: { title: string; what: string; youCan: string };
  children: React.ReactNode;
}) {
  return (
    <Card className="border-[#febc2e]/30 bg-[#febc2e]/[0.05] p-6">
      <div className="text-[14px] font-medium text-ink">{copy.title}</div>
      <p className="mt-2.5 text-[12.5px] leading-[1.65] text-muted">{copy.what}</p>
      <p className="mt-2 text-[12.5px] leading-[1.65] text-[#f3cd72]">{copy.youCan}</p>
      <div className="mt-5">{children}</div>
    </Card>
  );
}

/* ── awaitingIntakeEdit: `PATCH /companies/:id` ───────────────────────────── */

function IntakeEditForm({ company }: { company: CompanyDetailView }) {
  const rulesQuery = useFormationRulesQuery();
  const rules = intakeRulesOf(rulesQuery.data);
  const industries = useMemo(
    () => industryIndex(rulesQuery.data?.industries),
    [rulesQuery.data?.industries],
  );
  const update = useUpdateCompanyIntakeMutation(company.companyId);
  // Pre-filled from what was FILED, so a caller fixes the one field the provider objected to
  // rather than retyping three names from memory. ONE mapping, shared with the SSN-decision form
  // below — which re-sends the intake UNCHANGED, so a difference between the two would be a
  // silent rewrite of a filing's names.
  const [form, setForm] = useState<CompanyIntakeForm>(() => intakeFormOf(company));
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = validateCompanyIntake(form, rules, industries.known);

  async function submit() {
    setShowErrors(true);
    if (!isCompanyIntakeValid(form, rules, industries.known)) return;
    setError(null);
    try {
      await update.mutateAsync({
        names: form.names.map((n) => n.trim()),
        businessPurpose: form.businessPurpose.trim(),
        industryLabel: form.industryLabel,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the company.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <CompanyIntakeFields
        form={form}
        errors={errors}
        showErrors={showErrors}
        industries={industries}
        loading={rulesQuery.isPending}
        idPrefix="edit"
        onChange={setForm}
      />
      {error && <Callout tone="warn" title="The filing agent refused this too">{error}</Callout>}
      <div>
        <Button loading={update.isPending} onClick={() => void submit()}>
          Save and try the filing again
        </Button>
      </div>
    </div>
  );
}

/* ── awaitingSsnDecision: the two exits from §4.6a ────────────────────────── */

function SsnDecisionForm({ company }: { company: CompanyDetailView }) {
  const { data: config } = usePublicConfigQuery();
  const ssnCopy = formationCopyOf(config).ssn;
  const update = useUpdateCompanyIntakeMutation(company.companyId);
  // ⚠ Its own state, never merged into anything that leaves this component.
  const [ssn, setSsn] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The field only exists where the backend accepts one. On sandbox it refuses the value outright
  // rather than ignoring it, so a box on screen would be collecting a number nothing will take.
  const production = company.environment === "production";

  /**
   * `intake` is UNCHANGED — this PATCH exists to carry the SSN decision, not to rewrite names.
   *
   * The SAME mapping the edit form above pre-fills with. Two spellings of "the intake as stored"
   * is how a decision about an SSN quietly renames a company.
   */
  const unchanged = intakeFormOf(company);

  async function submit(withSsn: boolean) {
    setError(null);
    try {
      await update.mutateAsync({
        ...unchanged,
        ...(withSsn ? { ssn: ssn.trim() } : { proceedWithoutSsn: true as const }),
      });
      setSsn("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the decision.");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* The gate is the ENVIRONMENT and nothing else: the backend refuses the field outright on
          a sandbox company, and the copy always resolves. Gating a field on the presence of its
          own label is how a form silently loses the fast-EIN route.

          `showHelp` off: the park card above has just explained the choice in full, and repeating
          it under the box would be the same paragraph twice. */}
      {production && (
        <SsnInput id="park-ssn" value={ssn} onChange={setSsn} copy={ssnCopy} showHelp={false} />
      )}
      {error && <Callout tone="warn" title="Could not record the decision">{error}</Callout>}
      <div className="flex flex-wrap gap-3">
        {production && (
          <Button
            loading={update.isPending}
            disabled={!ssn.trim()}
            onClick={() => void submit(true)}
          >
            Use this number and file
          </Button>
        )}
        <Button variant="subtle" loading={update.isPending} onClick={() => void submit(false)}>
          File without one — the slower EIN route
        </Button>
      </div>
    </div>
  );
}

/* ── awaitingPartyEdit: `PATCH /companies/:companyId/party` ───────────────── */

/**
 * The responsible person, corrected.
 *
 * ⚠ The form starts EMPTY, and that is not laziness: no surface in this system ever serves a
 * stored identity back — not this one, not the entity view, not the company detail. The person
 * correcting it is the person whose details they are, and the alternative is an endpoint that
 * echoes PII into a response body and into every client that caches one.
 *
 * ⚠ There is NO party-handle field. The door is addressed by COMPANY and resolves the party from
 * it, so the form has nothing to ask for — where it used to demand a uuid this system never
 * serves back, on a page the owner reached precisely because their filing had stopped.
 *
 * It also takes NO SSN: that number is captured by the company doors, which mint the (party,
 * company) pair it is sealed under. There is no field for one here on either surface.
 */
function PartyEditForm({ company }: { company: CompanyDetailView }) {
  const update = useUpdateCompanyPartyMutation(company.companyId);
  const [party, setParty] = useState<FormationParty>(emptyParty);
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = validateParty(party);

  async function submit() {
    setShowErrors(true);
    if (!isPartyValid(party)) return;
    setError(null);
    try {
      await update.mutateAsync(toFormationPartyInput(party));
      // The identity leaves this browser the moment the backend has it, exactly as at intake.
      setParty(emptyParty());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the responsible person.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PartyFields
        party={party}
        errors={showErrors ? errors : {}}
        set={(key, value) => setParty({ ...party, [key]: value })}
        sectionLetter="A"
      />
      {error && (
        <Callout tone="warn" title="Could not update the responsible person">
          {error}
        </Callout>
      )}
      <div>
        <Button loading={update.isPending} onClick={() => void submit()}>
          Save and try the filing again
        </Button>
      </div>
    </div>
  );
}
