"use client";

import type {
  CompanyIntakeErrors,
  CompanyIntakeForm,
  IndustryIndex,
} from "@/lib/formation/companyIntake";
import { Field, Textarea, TextInput } from "../primitives";
import { IndustryPicker } from "./IndustryPicker";

/**
 * THE COMPANY'S OWN INTAKE — three ranked names, a purpose, an industry (design §5).
 *
 * Two screens collect exactly these five fields: the wizard's create form, and the company page's
 * edit-and-retry form on a filing doola refused. They held two copies, and the copies had already
 * diverged in the way that matters least on a good day and most on a bad one — the wizard
 * explained WHY three names are asked for and the retry form did not, on the screen where a
 * founder has just had their first choice rejected.
 *
 * The three name inputs are a loop over positions rather than three literals, because the
 * position is a real thing: Wyoming refuses a taken name, the alternates are what let the filing
 * proceed without a second fee, and the backend's refusals are indexed by position.
 */
export function CompanyIntakeFields({
  form,
  errors,
  showErrors,
  industries,
  loading,
  idPrefix,
  onChange,
}: {
  form: CompanyIntakeForm;
  errors: CompanyIntakeErrors;
  showErrors: boolean;
  industries: IndustryIndex;
  loading?: boolean;
  /** Two of these can be mounted in one document (never at once, but ids are cheap to keep unique). */
  idPrefix: string;
  onChange: (form: CompanyIntakeForm) => void;
}) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <Field
          key={i}
          label={i === 0 ? "Company name (first choice)" : `Alternative ${i}`}
          htmlFor={`${idPrefix}-name-${i}`}
          hint="LLC is added by the filing"
          error={showErrors ? (errors.names[i] ?? undefined) : undefined}
        >
          <TextInput
            id={`${idPrefix}-name-${i}`}
            autoComplete="off"
            value={form.names[i] ?? ""}
            invalid={showErrors && !!errors.names[i]}
            onChange={(e) => {
              const names = [...form.names];
              names[i] = e.target.value;
              onChange({ ...form, names });
            }}
          />
        </Field>
      ))}
      <Field
        label="What the company does"
        htmlFor={`${idPrefix}-purpose`}
        hint="Filed with the company"
        error={showErrors ? (errors.businessPurpose ?? undefined) : undefined}
      >
        <Textarea
          id={`${idPrefix}-purpose`}
          rows={3}
          placeholder="Operating autonomous software agents."
          value={form.businessPurpose}
          invalid={showErrors && !!errors.businessPurpose}
          onChange={(e) => onChange({ ...form, businessPurpose: e.target.value })}
        />
      </Field>
      <IndustryPicker
        value={form.industryLabel}
        industries={industries}
        loading={loading}
        error={showErrors ? (errors.industryLabel ?? undefined) : undefined}
        onChange={(industryLabel) => onChange({ ...form, industryLabel })}
      />
    </>
  );
}
