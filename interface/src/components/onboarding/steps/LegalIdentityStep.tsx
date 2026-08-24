"use client";

import { useState, type ReactNode } from "react";
import { StepNav } from "../OnboardingFlow";
import {
  isPartyValid,
  toFormationPartyInput,
  validateParty,
  type FormationParty,
} from "../types";
import {
  useCreateFormationPartyMutation,
  useFormationEnvironment,
  usePublicConfigQuery,
  useRetryPublicConfig,
} from "@/lib/api/hooks";
import {
  isKnownEnvironment,
  type FormationEnvironment,
} from "@/lib/api/formationEnvironment";
import {
  AmberPill,
  Button,
  Callout,
  Card,
  CheckIcon,
  Field,
  SectionTitle,
  Spinner,
  StepHeader,
  TextInput,
  cx,
} from "../primitives";

type Props = {
  eyebrow: string;
  /** The non-persisted PII slice. It lives in the flow's memory, never in storage, and the flow
   *  clears it the moment the backend hands back a handle. */
  party: FormationParty;
  onParty: (party: FormationParty) => void;
  partyId: string | null;
  synthetic: boolean;
  onCreated: (partyId: string, synthetic: boolean) => void;
  onBack: () => void;
  onComplete: () => void;
  /** Drop the recorded handle and collect an identity again. */
  onClear: () => void;
};

/**
 * The responsible natural person (design §3/§5/§8).
 *
 * A Wyoming LLC filing names a human being. This is where that human is collected — and the ONE
 * screen in the wizard that touches personal data, which is why it behaves differently from every
 * other one:
 *
 * - Nothing typed here is persisted. The slice lives in wizard memory and the persistence
 *   allowlist (`lib/onboarding/storage.ts`) does not name a single field of it.
 * - On success the wizard keeps a HANDLE (`partyId`) and forgets the identity immediately.
 * - In sandbox no identity is collected at all: the deployment files with a labeled demo fixture,
 *   and the screen says so in amber. A demo filing must never look like a real one.
 *
 * Whether this step BLOCKS comes from the server (`formationRequired`), never from here — the same
 * gate guards the MCP path, and a UI-only gate would be theatre (the guardian-step precedent).
 */
export function LegalIdentityStep({
  eyebrow,
  party,
  onParty,
  partyId,
  synthetic,
  onCreated,
  onBack,
  onComplete,
  onClear,
}: Props) {
  const { data: publicConfig } = usePublicConfigQuery();
  const environment = useFormationEnvironment();
  const { retry, retrying } = useRetryPublicConfig();
  const createParty = useCreateFormationPartyMutation();
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  // Which of the two modes this screen is IS the honesty question, so it renders NEITHER until it
  // has the answer. The old shape had two ways of getting this wrong and took both: a `/config`
  // still in flight showed the demo panel for a beat, and a `/config` that had FAILED showed it
  // permanently — telling a real founder on a production box that nothing they type is real, and
  // offering them a synthetic-identity button and a skip on a deployment that allows neither.
  const resolved = isKnownEnvironment(environment);
  const required = publicConfig?.formationRequired === true;
  const busy = createParty.isPending;
  const errors = validateParty(party);

  function set<K extends keyof FormationParty>(key: K, value: FormationParty[K]) {
    onParty({ ...party, [key]: value });
  }

  async function create(body: { synthetic: true } | ReturnType<typeof toFormationPartyInput>) {
    setError(null);
    try {
      const { partyId: id } = await createParty.mutateAsync(body);
      onCreated(id, "synthetic" in body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not record the legal identity.");
    }
  }

  async function submitReal() {
    setShowErrors(true);
    if (!isPartyValid(party)) return;
    await create(toFormationPartyInput(party));
  }

  return (
    <div>
      <StepHeader
        eyebrow={eyebrow}
        title={
          !resolved
            ? "Legal identity"
            : environment === "sandbox"
              ? "Legal identity (demo filing)"
              : "Who is filing this company?"
        }
        intro={
          !resolved
            ? "Checking what this deployment can file."
            : environment === "sandbox"
              ? "This deployment files in doola's sandbox, so no real identity is collected or sent. The filing uses a labeled demo identity and produces a demo company — nothing legally exists at the end of it."
              : "A Wyoming LLC is filed in the name of a real, responsible person. doola files it on your behalf, so this identity goes to doola as the filing agent and is never written into your agent's public record, its on-chain metadata, or its operating agreement."
        }
      />

      {/* A recorded handle FIRST: it is a fact the backend already gave us, and hiding it behind a
          `/config` blip would strand somebody who has already done this step. */}
      {partyId ? (
        <RecordedPanel
          partyId={partyId}
          synthetic={synthetic}
          onClear={() => {
            setShowErrors(false);
            onClear();
          }}
        />
      ) : !resolved ? (
        <UnresolvedPanel environment={environment} retrying={retrying} onRetry={retry} />
      ) : environment === "sandbox" ? (
        <SandboxPanel />
      ) : (
        <RealForm party={party} errors={showErrors ? errors : {}} set={set} />
      )}

      {error && (
        <Callout tone="warn" className="mt-5" title="Could not record the legal identity">
          {error}
        </Callout>
      )}

      {environment === "production" && !partyId && (
        <Callout tone="info" className="mt-6" title="Where this goes">
          Straight to doola, the filing agent, and into one table on this deployment that no view,
          no log, no metadata document and no on-chain record ever reads from. Your agent&apos;s
          public surfaces carry the company — never the person behind it.
        </Callout>
      )}

      <StepNav onBack={onBack}>
        {/* No skip until we know whether this deployment allows one. An affordance that appears and
            then vanishes is worse than one that arrives a beat late — and a skip offered on a
            deployment that REQUIRES a filing walks the user into a refused submit two steps on. */}
        {resolved && !required && !partyId && (
          <Button variant="subtle" disabled={busy} onClick={onComplete}>
            Skip — no legal filing
          </Button>
        )}
        {partyId ? (
          <Button onClick={onComplete}>
            Continue
            <CheckIcon className="h-4 w-4" />
          </Button>
        ) : environment === "sandbox" ? (
          <Button loading={busy} onClick={() => void create({ synthetic: true })}>
            Use the demo identity
          </Button>
        ) : environment === "production" ? (
          <Button loading={busy} onClick={() => void submitReal()}>
            Record identity
            {!busy && <CheckIcon className="h-4 w-4" />}
          </Button>
        ) : (
          // Neutral: no synthetic POST, no real submit, no skip — just the way to ask again.
          <Button variant="ghost" loading={retrying} onClick={retry}>
            {environment === "loading" ? "Checking…" : "Retry"}
          </Button>
        )}
      </StepNav>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/**
 * The environment is not known yet — so this panel claims NOTHING about it.
 *
 * No demo wording, no real-filing wording, no identity form and no synthetic-identity button: the
 * two panels below are both assertions about what this deployment does, and neither can be made
 * from here. What it does offer is the way out — asking `/config` again, without losing the
 * wizard state a page reload would throw away.
 */
function UnresolvedPanel({
  environment,
  retrying,
  onRetry,
}: {
  environment: FormationEnvironment;
  retrying: boolean;
  onRetry: () => void;
}) {
  const checking = environment === "loading";
  return (
    <Card className="p-6">
      <div className="flex items-center gap-2.5 text-[13px] text-muted">
        {(checking || retrying) && <Spinner className="h-3.5 w-3.5" />}
        {checking
          ? "Checking this deployment's filing environment…"
          : "Can't verify this deployment's filing environment"}
      </div>
      <p className="mt-3 text-[12.5px] leading-[1.6] text-muted-2">
        Whether a filing here is real or a labeled demo decides what this screen collects and what
        it tells you afterwards, so it says neither until the deployment answers. Nothing has been
        recorded and nothing has been sent.
      </p>
      {!checking && (
        <Button className="mt-5" variant="ghost" loading={retrying} onClick={onRetry}>
          Retry
        </Button>
      )}
    </Card>
  );
}

/** AMBER, never green (the honesty invariant, §2 — the guardian-waiver precedent). A sandbox
 *  filing is a demo, and every surface that shows it says so in the same colour.
 *
 *  Rendered only for a CONFIRMED sandbox — an unreported environment gets `UnresolvedPanel`, not
 *  this one, which is why there is no "environment not reported" caveat left inside it. */
function SandboxPanel() {
  return (
    <Card className="border-[#febc2e]/30 bg-[#febc2e]/[0.05] p-6">
      <div className="flex flex-wrap items-center gap-2.5">
        <AmberPill size="label">Demo formation (sandbox)</AmberPill>
      </div>
      <p className="mt-4 text-[13px] leading-[1.65] text-muted">
        Nothing is filed with the State of Wyoming and no company legally exists at the end of
        this. The filing goes to doola&apos;s sandbox under a labeled synthetic identity, and the
        documents that come back are demo documents.
      </p>
      <ul className="mt-4 flex flex-col gap-2 text-[12.5px] leading-[1.5] text-muted-2">
        <Point>
          No real name, email, phone or address is collected here, or sent anywhere — the zero-PII
          discipline, kept.
        </Point>
        <Point>
          The demo company, its documents and its EIN are labeled &ldquo;sandbox&rdquo; on every
          surface that shows them, including your dashboard and the public transparency page.
        </Point>
        <Point>
          A production deployment collects a real identity here instead, behind an explicit consent
          screen naming doola as the processor.
        </Point>
      </ul>
    </Card>
  );
}

function RecordedPanel({
  partyId,
  synthetic,
  onClear,
}: {
  partyId: string;
  synthetic: boolean;
  onClear: () => void;
}) {
  return (
    <Card className={cx("p-6", synthetic && "border-[#febc2e]/30 bg-[#febc2e]/[0.05]")}>
      <div
        className={cx(
          "flex items-center gap-2 text-[13px]",
          synthetic ? "text-[#f3cd72]" : "text-emerald-300",
        )}
      >
        <CheckIcon className="h-4 w-4" />
        {synthetic
          ? "Demo identity attached — this filing is a sandbox demo"
          : "Legal identity recorded with the filing agent"}
      </div>
      <p className="mt-3 text-[12.5px] leading-[1.6] text-muted">
        The wizard kept the handle below and nothing else — the identity itself is no longer held
        in this browser. The handle travels with the onboarding request; it identifies a row, not
        a person.
      </p>
      <code className="mt-4 block break-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink">
        {partyId}
      </code>
      <button
        type="button"
        onClick={onClear}
        className="mt-4 text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        Use a different identity
      </button>
    </Card>
  );
}

function RealForm({
  party,
  errors,
  set,
}: {
  party: FormationParty;
  errors: ReturnType<typeof validateParty>;
  set: <K extends keyof FormationParty>(key: K, value: FormationParty[K]) => void;
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
        <SectionTitle n="A">Responsible person</SectionTitle>
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
        </div>
      </Card>

      <Card className="p-6">
        <SectionTitle n="B">Address</SectionTitle>
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

function Point({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-2" />
      <span>{children}</span>
    </li>
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
