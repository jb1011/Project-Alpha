"use client";

import { useState } from "react";
import {
  usePublicConfigQuery,
  useUpdateCompanyIntakeMutation,
  useUpdateFormationPartyMutation,
} from "@/lib/api/hooks";
import type { CompanyDetailView } from "@/lib/api/types";
import {
  isCompanyIntakeValid,
  validateCompanyIntake,
  type CompanyIntakeForm,
} from "@/lib/formation/companyIntake";
import { emptyParty, isPartyValid, toFormationPartyInput, validateParty, type FormationParty } from "@/components/onboarding/types";
import { IndustryPicker } from "@/components/onboarding/steps/IndustryPicker";
import { PartyFields } from "@/components/onboarding/steps/PartyFields";
import {
  Button,
  Callout,
  Card,
  Field,
  SectionTitle,
  TextInput,
  Textarea,
} from "@/components/onboarding/primitives";
import { useIndustriesQuery } from "@/lib/api/hooks";

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
  const copy = config?.formationCopy?.park;
  const { awaitingIntakeEdit, awaitingPartyEdit, awaitingSsnDecision } = company.park;
  if (!awaitingIntakeEdit && !awaitingPartyEdit && !awaitingSsnDecision) return null;

  return (
    <div className="flex flex-col gap-5">
      {awaitingIntakeEdit && (
        <ParkCard copy={copy?.awaitingIntakeEdit} fallbackTitle="This filing is waiting on you">
          <IntakeEditForm company={company} />
        </ParkCard>
      )}
      {awaitingSsnDecision && (
        <ParkCard
          copy={copy?.awaitingSsnDecision}
          fallbackTitle="This filing is waiting on a decision about the SSN"
        >
          <SsnDecisionForm company={company} />
        </ParkCard>
      )}
      {awaitingPartyEdit && (
        <ParkCard
          copy={copy?.awaitingPartyEdit}
          fallbackTitle="The filing agent refused the responsible person"
        >
          <PartyEditForm company={company} />
        </ParkCard>
      )}
    </div>
  );
}

function ParkCard({
  copy,
  fallbackTitle,
  children,
}: {
  copy?: { title: string; what: string; youCan: string };
  fallbackTitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border-[#febc2e]/30 bg-[#febc2e]/[0.05] p-6">
      <div className="text-[14px] font-medium text-ink">{copy?.title ?? fallbackTitle}</div>
      {/* A backend that predates `/config.formationCopy` serves no sentences, and this renders
          none rather than a stale one of its own — the whole reason the copy is served. */}
      {copy && (
        <>
          <p className="mt-2.5 text-[12.5px] leading-[1.65] text-muted">{copy.what}</p>
          <p className="mt-2 text-[12.5px] leading-[1.65] text-[#f3cd72]">{copy.youCan}</p>
        </>
      )}
      <div className="mt-5">{children}</div>
    </Card>
  );
}

/* ── awaitingIntakeEdit: `PATCH /companies/:id` ───────────────────────────── */

function IntakeEditForm({ company }: { company: CompanyDetailView }) {
  const industries = useIndustriesQuery();
  const options = industries.data?.industries ?? [];
  const update = useUpdateCompanyIntakeMutation(company.companyId);
  const [form, setForm] = useState<CompanyIntakeForm>(() => ({
    // Pre-filled from what was FILED, so a caller fixes the one field the provider objected to
    // rather than retyping three names from memory.
    names: [0, 1, 2].map((i) => {
      const o = company.nameOptions[i];
      return o ? `${o.name} ${o.entityTypeEnding}`.trim() : "";
    }),
    businessPurpose: company.businessPurpose,
    industryLabel: company.industryLabel,
  }));
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = validateCompanyIntake(form, options);

  async function submit() {
    setShowErrors(true);
    if (!isCompanyIntakeValid(form, options)) return;
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
      {[0, 1, 2].map((i) => (
        <Field
          key={i}
          label={i === 0 ? "Company name (first choice)" : `Alternative ${i}`}
          htmlFor={`edit-name-${i}`}
          error={showErrors ? (errors.names[i] ?? undefined) : undefined}
        >
          <TextInput
            id={`edit-name-${i}`}
            value={form.names[i] ?? ""}
            invalid={showErrors && !!errors.names[i]}
            onChange={(e) => {
              const names = [...form.names];
              names[i] = e.target.value;
              setForm({ ...form, names });
            }}
          />
        </Field>
      ))}
      <Field
        label="What the company does"
        htmlFor="edit-purpose"
        error={showErrors ? (errors.businessPurpose ?? undefined) : undefined}
      >
        <Textarea
          id="edit-purpose"
          rows={3}
          value={form.businessPurpose}
          invalid={showErrors && !!errors.businessPurpose}
          onChange={(e) => setForm({ ...form, businessPurpose: e.target.value })}
        />
      </Field>
      <IndustryPicker
        value={form.industryLabel}
        options={options}
        loading={industries.isPending}
        error={showErrors ? (errors.industryLabel ?? undefined) : undefined}
        onChange={(industryLabel) => setForm({ ...form, industryLabel })}
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
  const update = useUpdateCompanyIntakeMutation(company.companyId);
  // ⚠ Its own state, never merged into anything that leaves this component.
  const [ssn, setSsn] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The field only exists where the backend accepts one. On sandbox it refuses the value outright
  // rather than ignoring it, so a box on screen would be collecting a number nothing will take.
  const production = company.environment === "production";

  /** `intake` is UNCHANGED — this PATCH exists to carry the SSN decision, not to rewrite names. */
  const unchanged = {
    names: [0, 1, 2].map((i) => {
      const o = company.nameOptions[i];
      return o ? `${o.name} ${o.entityTypeEnding}`.trim() : "";
    }),
    businessPurpose: company.businessPurpose,
    industryLabel: company.industryLabel,
  };

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
      {production && config?.formationCopy?.ssn && (
        <Field label={config.formationCopy.ssn.label} htmlFor="park-ssn">
          <TextInput
            id="park-ssn"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder="XXX-XX-XXXX"
            className="max-w-[220px] font-mono"
            value={ssn}
            onChange={(e) => setSsn(e.target.value)}
          />
          <p className="mt-1 text-[11.5px] leading-[1.55] text-muted-2">
            {config.formationCopy.ssn.retention}
          </p>
        </Field>
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

/* ── awaitingPartyEdit: `PATCH /formation-party/:partyId` ─────────────────── */

/**
 * The responsible person, corrected.
 *
 * ⚠ The form starts EMPTY, and that is not laziness: no surface in this system ever serves a
 * stored identity back — not this one, not the entity view, not the company detail. The person
 * correcting it is the person whose details they are, and the alternative is an endpoint that
 * echoes PII into a response body and into every client that caches one.
 *
 * It also takes NO SSN: that number is captured by the company doors, which mint the (party,
 * company) pair it is sealed under. There is no field for one here on either surface.
 */
function PartyEditForm({ company }: { company: CompanyDetailView }) {
  const update = useUpdateFormationPartyMutation(company.companyId);
  const [party, setParty] = useState<FormationParty>(emptyParty);
  const [partyId, setPartyId] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = validateParty(party);

  async function submit() {
    setShowErrors(true);
    if (!isPartyValid(party) || !partyId.trim()) return;
    setError(null);
    try {
      await update.mutateAsync({ partyId: partyId.trim(), body: toFormationPartyInput(party) });
      // The identity leaves this browser the moment the backend has it, exactly as at intake.
      setParty(emptyParty());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the responsible person.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Card className="p-5">
        <SectionTitle>Which identity</SectionTitle>
        <p className="mt-2 text-[12px] leading-[1.6] text-muted-2">
          The handle this company was created with. We do not serve it back with the company — no
          surface in this system ever returns a stored identity — so paste the one the create
          returned, or ask the operator.
        </p>
        <Field label="Party handle" htmlFor="party-handle" className="mt-4">
          <TextInput
            id="party-handle"
            autoComplete="off"
            placeholder="00000000-0000-0000-0000-000000000000"
            className="font-mono text-[12px]"
            value={partyId}
            onChange={(e) => setPartyId(e.target.value)}
          />
        </Field>
      </Card>
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
        <Button
          loading={update.isPending}
          disabled={!partyId.trim()}
          onClick={() => void submit()}
        >
          Save and try the filing again
        </Button>
      </div>
    </div>
  );
}
