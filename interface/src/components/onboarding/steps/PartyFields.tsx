"use client";

import { useState } from "react";
import type { FormationParty, PartyFieldErrors } from "../types";
import { Card, Field, SectionTitle, TextInput } from "../primitives";
import { SsnInput } from "./SsnInput";

/**
 * THE RESPONSIBLE PERSON, and the one optional field that is a Social Security Number.
 *
 * Lifted out of `LegalIdentityStep` when A3 folded that screen into `LegalBodyStep`: the same
 * fields are now collected as PART OF creating a company rather than as a step of their own, and
 * the Companies section's party-edit form renders them again. Two copies of a form that collects
 * a legal identity is two places for a field to be forgotten, mislabelled, or persisted.
 *
 * ⚠ The SSN is passed in and out as its OWN prop, never as a field of `FormationParty`. That type
 * is handed up to the wizard flow, and the one thing that must never happen to a Social Security
 * Number is that it becomes a key on an object somebody later decides to persist.
 */
export function PartyFields({
  party,
  errors,
  set,
  ssn,
  onSsn,
  ssnCopy,
  sectionLetter = "B",
}: {
  party: FormationParty;
  errors: PartyFieldErrors;
  set: <K extends keyof FormationParty>(key: K, value: FormationParty[K]) => void;
  /**
   * The SSN, or undefined where the field must not be rendered AT ALL (§4.1).
   *
   * `undefined` is not "empty": a sandbox deployment, an unknown one, and the party-edit form all
   * pass it, and the field does not exist on the screen. That is the honest rendering — the
   * backend REFUSES the value outright on those doors rather than ignoring it, and a form that
   * showed the box would be collecting a number nothing will accept.
   */
  ssn?: string;
  onSsn?: (ssn: string) => void;
  /**
   * The §4.1 copy — served by `/config` where the backend answered, bundled where it did not
   * (`formationCopyOf`). REQUIRED wherever the field is rendered.
   *
   * It used to be optional and to GATE the field, which meant a deployment whose `/config`
   * predates `formationCopy` — or whose `/config` had not arrived yet — rendered a production
   * create form with no SSN input at all. That is not a cosmetic degradation: the field is the
   * fast-EIN route, and its absence silently files every US person under the slow one. The
   * gate is the ENVIRONMENT, and it is the caller's (see `ssn`).
   */
  ssnCopy?: { label: string; help: string; retention: string };
  sectionLetter?: string;
}) {
  // Local to the form, because that is the only thing that can see it: "is the country one of the
  // listed ones or typed in by hand" is a fact about this `<select>`, not about the wizard. It was
  // hoisted to the step so a prop pair could carry it back down, and the step then had to reset it
  // in a callback beside the field's own value — two places to keep in step for one dropdown.
  const [otherCountry, setOtherCountry] = useState(
    () => party.country !== "" && !COUNTRIES.some((c) => c.code === party.country),
  );
  const onOtherCountry = (on: boolean) => {
    setOtherCountry(on);
    set("country", "");
  };
  const isUs = party.country.trim().toUpperCase() === "USA";
  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <SectionTitle n={sectionLetter}>Responsible person</SectionTitle>
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Legal first name" htmlFor="party-first" error={errors.legalFirstName}>
            <TextInput
              id="party-first"
              autoComplete="given-name"
              value={party.legalFirstName}
              invalid={!!errors.legalFirstName}
              onChange={(e) => set("legalFirstName", e.target.value)}
            />
          </Field>
          <Field label="Legal last name" htmlFor="party-last" error={errors.legalLastName}>
            <TextInput
              id="party-last"
              autoComplete="family-name"
              value={party.legalLastName}
              invalid={!!errors.legalLastName}
              onChange={(e) => set("legalLastName", e.target.value)}
            />
          </Field>
          <Field label="Email" htmlFor="party-email" error={errors.email}>
            <TextInput
              id="party-email"
              type="email"
              autoComplete="email"
              value={party.email}
              invalid={!!errors.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </Field>
          <Field
            label="Phone"
            htmlFor="party-phone"
            hint="Required by the filing agent"
            error={errors.phone}
          >
            <TextInput
              id="party-phone"
              type="tel"
              autoComplete="tel"
              placeholder="+1 307 555 0100"
              value={party.phone}
              invalid={!!errors.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
          </Field>
          {/* ⚠ THE SSN (§4.1) — rendered when the CALLER passes a value and a setter, which
              happens on exactly one screen of one kind of deployment: the create form on a
              confirmed PRODUCTION box. Sandbox and unknown never pass them, because the backend
              refuses the field there outright rather than ignoring it, and a box on screen would
              be collecting a number nothing will accept.

              It is NOT gated on the copy, which always resolves (served, else bundled): gating a
              field on the presence of its own label is how a form silently loses the fast-EIN
              route on a deployment that simply had not shipped `/config.formationCopy` yet.

              The INPUT itself is shared with the §4.6a re-capture screen — one box for the single
              worst field in this codebase to get wrong. */}
          {ssn !== undefined && onSsn && ssnCopy && (
            <SsnInput
              id="party-ssn"
              value={ssn}
              onChange={onSsn}
              copy={ssnCopy}
              className="sm:col-span-2"
            />
          )}
        </div>
      </Card>

      <Card className="p-6">
        <SectionTitle n={nextLetter(sectionLetter)}>Address</SectionTitle>
        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field
            label="Street address"
            htmlFor="party-line1"
            error={errors.line1}
            className="sm:col-span-2"
          >
            <TextInput
              id="party-line1"
              autoComplete="address-line1"
              value={party.line1}
              invalid={!!errors.line1}
              onChange={(e) => set("line1", e.target.value)}
            />
          </Field>
          <Field
            label="Apartment, suite (optional)"
            htmlFor="party-line2"
            className="sm:col-span-2"
          >
            <TextInput
              id="party-line2"
              autoComplete="address-line2"
              value={party.line2}
              onChange={(e) => set("line2", e.target.value)}
            />
          </Field>
          <Field label="City" htmlFor="party-city" error={errors.city}>
            <TextInput
              id="party-city"
              autoComplete="address-level2"
              value={party.city}
              invalid={!!errors.city}
              onChange={(e) => set("city", e.target.value)}
            />
          </Field>
          <Field label="Postal code" htmlFor="party-postal" error={errors.postalCode}>
            <TextInput
              id="party-postal"
              autoComplete="postal-code"
              value={party.postalCode}
              invalid={!!errors.postalCode}
              onChange={(e) => set("postalCode", e.target.value)}
            />
          </Field>
          <Field label="Country" htmlFor="party-country" error={errors.country}>
            <select
              id="party-country"
              value={otherCountry ? OTHER : party.country}
              onChange={(e) => {
                if (e.target.value === OTHER) {
                  onOtherCountry(true);
                  return;
                }
                if (otherCountry) onOtherCountry(false);
                set("country", e.target.value);
              }}
              className="w-full rounded-md border hairline bg-transparent px-3 py-2 text-[13px] text-ink"
            >
              <option value="">Select a country…</option>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.code})
                </option>
              ))}
              {/* Never a closed list: the countries below are the common ones, not the legal
                  ones. A founder from anywhere else types their code rather than being told
                  their country does not exist. */}
              <option value={OTHER}>Other — enter an ISO-3 code</option>
            </select>
          </Field>
          <Field
            label={isUs ? "State" : "State / province (optional)"}
            htmlFor="party-region"
            hint={isUs ? "2 letters, e.g. WY" : "Leave blank if your country has none"}
            error={errors.region}
          >
            <TextInput
              id="party-region"
              autoComplete="address-level1"
              value={party.region}
              invalid={!!errors.region}
              onChange={(e) => set("region", e.target.value)}
            />
          </Field>
          {otherCountry && (
            <Field
              label="Country code"
              htmlFor="party-country-code"
              hint="ISO-3166-1 alpha-3, e.g. FRA"
              className="sm:col-span-2"
            >
              <TextInput
                id="party-country-code"
                maxLength={3}
                className="max-w-[140px] uppercase"
                value={party.country}
                invalid={!!errors.country}
                onChange={(e) => set("country", e.target.value.toUpperCase())}
              />
            </Field>
          )}
        </div>
      </Card>
    </div>
  );
}


const OTHER = "__other";

/**
 * The common countries, in doola's alpha-3 convention — a CONVENIENCE, not the allowed set.
 * Anything else is typed in through "Other", and the backend validates any well-formed ISO-3.
 */
const COUNTRIES: { code: string; name: string }[] = [
  { code: "USA", name: "United States" },
  { code: "ARE", name: "United Arab Emirates" },
  { code: "ARG", name: "Argentina" },
  { code: "AUS", name: "Australia" },
  { code: "AUT", name: "Austria" },
  { code: "BEL", name: "Belgium" },
  { code: "BRA", name: "Brazil" },
  { code: "CAN", name: "Canada" },
  { code: "CHE", name: "Switzerland" },
  { code: "CHL", name: "Chile" },
  { code: "COL", name: "Colombia" },
  { code: "CZE", name: "Czechia" },
  { code: "DEU", name: "Germany" },
  { code: "DNK", name: "Denmark" },
  { code: "ESP", name: "Spain" },
  { code: "EST", name: "Estonia" },
  { code: "FIN", name: "Finland" },
  { code: "FRA", name: "France" },
  { code: "GBR", name: "United Kingdom" },
  { code: "GRC", name: "Greece" },
  { code: "HRV", name: "Croatia" },
  { code: "HUN", name: "Hungary" },
  { code: "IDN", name: "Indonesia" },
  { code: "IND", name: "India" },
  { code: "IRL", name: "Ireland" },
  { code: "ISR", name: "Israel" },
  { code: "ITA", name: "Italy" },
  { code: "JPN", name: "Japan" },
  { code: "KEN", name: "Kenya" },
  { code: "KOR", name: "South Korea" },
  { code: "LTU", name: "Lithuania" },
  { code: "LUX", name: "Luxembourg" },
  { code: "LVA", name: "Latvia" },
  { code: "MEX", name: "Mexico" },
  { code: "NGA", name: "Nigeria" },
  { code: "NLD", name: "Netherlands" },
  { code: "NOR", name: "Norway" },
  { code: "NZL", name: "New Zealand" },
  { code: "PHL", name: "Philippines" },
  { code: "POL", name: "Poland" },
  { code: "PRT", name: "Portugal" },
  { code: "ROU", name: "Romania" },
  { code: "SGP", name: "Singapore" },
  { code: "SVK", name: "Slovakia" },
  { code: "SVN", name: "Slovenia" },
  { code: "SWE", name: "Sweden" },
  { code: "THA", name: "Thailand" },
  { code: "TUR", name: "Türkiye" },
  { code: "UKR", name: "Ukraine" },
  { code: "VNM", name: "Vietnam" },
  { code: "ZAF", name: "South Africa" },
];

/** "A" → "B". The two cards are lettered in order wherever this form is rendered, and the caller
 *  decides where that order starts — the wizard's create screen already has a card above it. */
function nextLetter(letter: string): string {
  return String.fromCharCode(letter.charCodeAt(0) + 1);
}
