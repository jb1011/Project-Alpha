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
  useCompaniesQuery,
  useCompanyQuery,
  useCreateCompanyMutation,
  useCreateFormationPartyMutation,
  useFormationEnvironment,
  useIndustriesQuery,
  usePublicConfigQuery,
  useRetryPublicConfig,
} from "@/lib/api/hooks";
import {
  filingEnvironment,
  isKnownEnvironment,
  type FormationEnvironment,
} from "@/lib/api/formationEnvironment";
import type { CompanyView } from "@/lib/api/types";
import {
  companyLabel,
  isCompanyIntakeValid,
  legalBodyBranch,
  validateCompanyIntake,
  type CompanyIntakeForm,
} from "@/lib/formation/companyIntake";
import { CompanyStatePill } from "@/components/agents/CompanyStatePill";
import { legalBodyTitle } from "@/lib/formation/honesty";
import { formationCopyOf } from "@/lib/formation/copy";
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
  Textarea,
  TextInput,
  cx,
} from "../primitives";
import { IndustryPicker } from "./IndustryPicker";
import { PartyFields } from "./PartyFields";

type Props = {
  eyebrow: string;
  /** The non-persisted PII slice. It lives in the flow's memory, never in storage, and the flow
   *  clears it the moment the backend hands back a company id. */
  party: FormationParty;
  onParty: (party: FormationParty) => void;
  /** The company's own intake — names, purpose, industry. Not PII, and not persisted either: it
   *  is typed once, consumed by one call, and afterwards it lives on the server. */
  intake: CompanyIntakeForm;
  onIntake: (intake: CompanyIntakeForm) => void;
  companyId: string | null;
  /** The picked company's ROW, when the flow is carrying one — see `OnboardingSession.company`. */
  company: CompanyView | null;
  /** The handle, and the ROW when the branch that produced it had one. The attach branch picked
   *  its row out of a list; a create has only the handle until somebody reads it back. */
  onCompany: (companyId: string, company?: CompanyView) => void;
  onBack: () => void;
  onComplete: () => void;
  /** Drop the recorded company and choose again. */
  onClear: () => void;
};

/**
 * THE LEGAL BODY (design §5/§7) — pick a company you already own, or create one.
 *
 * It replaces `LegalIdentityStep`, which collected one person and handed A1's shim a party
 * handle. With the shim gone the wizard SEQUENCES the two calls it always should have:
 * `POST /formation-party` → `POST /companies` → `POST /onboard` with the company id. A company
 * payload never rides the onboard door, which is what keeps personal data — and, since A2, a
 * potential SSN — off it entirely.
 *
 * It is still the one screen in the wizard that touches personal data, so it still behaves
 * differently from every other one:
 *
 * - nothing typed here is persisted. Neither the PII slice nor the intake is named in the
 *   persistence allowlist, and the SSN is not even held in the same object as the rest;
 * - on success the wizard keeps a COMPANY id and forgets everything else immediately;
 * - in sandbox no identity is collected at all: the deployment files with a labeled demo fixture,
 *   and the screen says so in amber. A demo filing must never look like a real one;
 * - ATTACHING to a company you already own is free, and it is disclosed before it is confirmed —
 *   agents that share a company are publicly linkable through their anchored manifests.
 */
export function LegalBodyStep({
  eyebrow,
  party,
  onParty,
  intake,
  onIntake,
  companyId,
  company,
  onCompany,
  onBack,
  onComplete,
  onClear,
}: Props) {
  const { data: publicConfig } = usePublicConfigQuery();
  const environment = useFormationEnvironment();
  const { retry, retrying } = useRetryPublicConfig();
  const createParty = useCreateFormationPartyMutation();
  const createCompany = useCreateCompanyMutation();
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  /**
   * ⚠ THE SSN LIVES HERE AND NOWHERE ELSE.
   *
   * Its own `useState`, deliberately outside the `party` slice: `party` is passed up to the flow,
   * and the one thing that must never happen to a Social Security Number is that it becomes a
   * field on an object somebody later decides to persist. It is read once, at submit, handed to
   * the mutation, and cleared on the next line.
   */
  const [ssn, setSsn] = useState("");

  const resolved = isKnownEnvironment(environment);
  const required = publicConfig?.formationRequired === true;
  // Served where the backend answered, bundled where it did not — one table, one helper. The
  // fields below are NEVER gated on it: a sentence that has not arrived is a sentence, and a
  // form field that disappears with it is a route silently taken away.
  const copy = formationCopyOf(publicConfig);
  // Absent means false, and that is the honest reading: a backend that predates the field takes
  // no payment. B1 ships the field and the payment step together.
  const paymentRequired = publicConfig?.formationPaymentRequired === true;

  // The environment THIS SCREEN may claim: the attached company's row when there is one, the
  // deployment's own answer while the next action is still to create a company. One function,
  // shared with the confirm screen, so the two cannot describe the same filing differently.
  const attachedCompany = useCompanyQuery(companyId, { enabled: companyId !== null && !company });
  const attachedRow = company ?? attachedCompany.data ?? null;
  const { environment: attachedEnvironment } = filingEnvironment({
    forming: companyId !== null,
    deployment: environment,
    company: {
      environment: attachedRow?.environment,
      hasData: attachedRow !== null,
      isError: attachedCompany.isError,
    },
  });

  const companies = useCompaniesQuery(resolved && !companyId);
  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<"attach" | "create" | null>(null);
  // The whole branch state, in ONE pure function so it can be asserted: which branch, what is
  // attachable, and which row is selected. See `legalBodyBranch` for each of the three rules.
  const {
    mode: effectiveMode,
    attachable,
    selected,
  } = legalBodyBranch(companies.data?.companies ?? [], mode, picked);

  const industries = useIndustriesQuery(resolved && effectiveMode === "create");
  const industryOptions = industries.data?.industries ?? [];

  const partyErrors = validateParty(party);
  const intakeErrors = validateCompanyIntake(intake, industryOptions);
  const busy = createParty.isPending || createCompany.isPending;

  function setPartyField<K extends keyof FormationParty>(key: K, value: FormationParty[K]) {
    onParty({ ...party, [key]: value });
  }

  /**
   * The whole create, in the ONE order that keeps PII off the doors it must not touch:
   * register the person, then create the company with the handle it returned.
   *
   * A failure between the two leaves an UNBOUND party row, which is harmless and erasable: the
   * backend's C7 sweep destroys a party that was never bound to a company after seven days.
   */
  async function create(syntheticParty: boolean) {
    setShowErrors(true);
    if (!isCompanyIntakeValid(intake, industryOptions)) return;
    if (!syntheticParty && !isPartyValid(party)) return;
    setError(null);
    try {
      const { partyId } = await createParty.mutateAsync(
        syntheticParty ? { synthetic: true } : toFormationPartyInput(party),
      );
      const { companyId: created } = await createCompany.mutateAsync({
        partyId,
        names: intake.names.map((n) => n.trim()),
        businessPurpose: intake.businessPurpose.trim(),
        industryLabel: intake.industryLabel,
        // PRODUCTION ONLY, and optional even there. `undefined` rather than `""`: the backend
        // refuses a malformed value, and an empty string is a value.
        ...(environment === "production" && ssn.trim() ? { ssn: ssn.trim() } : {}),
        ...(syntheticParty ? { synthetic: true as const } : {}),
      });
      // Belt and braces on top of the allowlist: once the backend holds all of it, there is no
      // reason for this browser to keep a copy in memory either.
      setSsn("");
      onCompany(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the company.");
    }
  }

  return (
    <div>
      <StepHeader
        eyebrow={eyebrow}
        // ⚠ "(demo filing)" is a CLAIM, and once a company is attached it is a claim about THAT
        // COMPANY. `attachedEnvironment` is the row's, which is stamped at creation and immutable
        // after; the deployment's answer is used only while the next action is still to create
        // one, because a new company takes the deployment's pin.
        title={legalBodyTitle({
          environment: attachedEnvironment,
          attached: companyId !== null,
          mode: effectiveMode,
        })}
        intro={
          !resolved
            ? "Checking what this deployment can file."
            : attachedEnvironment === "sandbox"
              ? "This deployment files in doola's sandbox, so no real identity is collected or sent. The filing uses a labeled demo identity and produces a demo company — nothing legally exists at the end of it."
              : "Your agent acts through a Wyoming LLC. One company can carry several agents, and attaching a new agent to a company you already have costs nothing."
        }
      />

      {companyId ? (
        <AttachedPanel
          companyId={companyId}
          state={attachedRow?.state ?? null}
          environment={attachedRow?.environment ?? null}
          onClear={onClear}
        />
      ) : !resolved ? (
        <UnresolvedPanel environment={environment} retrying={retrying} onRetry={retry} />
      ) : (
        <div className="flex flex-col gap-6">
          {attachable.length > 0 && (
            <ModeTabs mode={effectiveMode} count={attachable.length} onMode={setMode} />
          )}

          {effectiveMode === "attach" ? (
            <AttachPicker
              companies={attachable}
              selected={selected}
              onSelect={setPicked}
              disclosure={copy.reuseDisclosure}
            />
          ) : (
            <>
              {environment === "sandbox" && <SandboxPanel />}
              <Card className="p-6">
                <SectionTitle n="A">The company</SectionTitle>
                <p className="mt-3 text-[12.5px] leading-[1.6] text-muted-2">
                  Wyoming refuses a name that is already taken, so the filing carries three in
                  order of preference. The alternates are what let it proceed without a second fee.
                </p>
                <div className="mt-5 flex flex-col gap-5">
                  {[0, 1, 2].map((i) => (
                    <Field
                      key={i}
                      label={i === 0 ? "Company name (first choice)" : `Alternative ${i}`}
                      htmlFor={`company-name-${i}`}
                      hint="LLC is added by the filing"
                      error={showErrors ? (intakeErrors.names[i] ?? undefined) : undefined}
                    >
                      <TextInput
                        id={`company-name-${i}`}
                        autoComplete="off"
                        value={intake.names[i] ?? ""}
                        invalid={showErrors && !!intakeErrors.names[i]}
                        onChange={(e) => {
                          const names = [...intake.names];
                          names[i] = e.target.value;
                          onIntake({ ...intake, names });
                        }}
                      />
                    </Field>
                  ))}
                  <Field
                    label="What the company does"
                    htmlFor="company-purpose"
                    hint="Filed with the company"
                    error={showErrors ? (intakeErrors.businessPurpose ?? undefined) : undefined}
                  >
                    <Textarea
                      id="company-purpose"
                      rows={3}
                      placeholder="Operating autonomous software agents."
                      value={intake.businessPurpose}
                      invalid={showErrors && !!intakeErrors.businessPurpose}
                      onChange={(e) => onIntake({ ...intake, businessPurpose: e.target.value })}
                    />
                  </Field>
                  <IndustryPicker
                    value={intake.industryLabel}
                    options={industryOptions}
                    loading={industries.isPending}
                    error={showErrors ? (intakeErrors.industryLabel ?? undefined) : undefined}
                    onChange={(industryLabel) => onIntake({ ...intake, industryLabel })}
                  />
                </div>
              </Card>

              {environment === "production" && (
                <PartyFields
                  party={party}
                  errors={showErrors ? partyErrors : {}}
                  set={setPartyField}
                  ssn={ssn}
                  onSsn={setSsn}
                  ssnCopy={copy.ssn}
                />
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <Callout tone="warn" className="mt-5" title="Could not set up the legal body">
          {error}
        </Callout>
      )}

      {environment === "production" && !companyId && effectiveMode === "create" && (
        <Callout tone="info" className="mt-6" title="Where this goes">
          Straight to doola, the filing agent, and into one table on this deployment that no view,
          no log, no metadata document and no on-chain record ever reads from. Your agent&apos;s
          public surfaces carry the company — never the person behind it.
          {!paymentRequired && " Formation is included during the beta."}
        </Callout>
      )}

      <StepNav onBack={onBack}>
        {/* No skip until we know whether this deployment allows one. An affordance that appears
            and then vanishes is worse than one that arrives a beat late — and a skip offered on a
            deployment that REQUIRES a filing walks the user into a refused submit two steps on. */}
        {resolved && !required && !companyId && (
          <Button variant="subtle" disabled={busy} onClick={onComplete}>
            Skip — no legal filing
          </Button>
        )}
        {companyId ? (
          <Button onClick={onComplete}>
            Continue
            <CheckIcon className="h-4 w-4" />
          </Button>
        ) : !resolved ? (
          // Neutral: no create, no attach, no skip — just the way to ask again.
          <Button variant="ghost" loading={retrying} onClick={retry}>
            {environment === "loading" ? "Checking…" : "Retry"}
          </Button>
        ) : effectiveMode === "attach" ? (
          <Button
            disabled={!selected}
            onClick={() => {
              const row = attachable.find((c) => c.companyId === selected);
              if (row) onCompany(row.companyId, row);
            }}
          >
            Use this company
            <CheckIcon className="h-4 w-4" />
          </Button>
        ) : (
          <Button loading={busy} onClick={() => void create(environment === "sandbox")}>
            {environment === "sandbox" ? "Create the demo company" : "Create the company"}
            {!busy && <CheckIcon className="h-4 w-4" />}
          </Button>
        )}
      </StepNav>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ModeTabs({
  mode,
  count,
  onMode,
}: {
  mode: "attach" | "create";
  count: number;
  onMode: (mode: "attach" | "create") => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {(
        [
          ["attach", `Use a company I have (${count})`],
          ["create", "Create a new company"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onMode(id)}
          className={cx(
            "cursor-pointer rounded-full border px-4 py-2 text-[12.5px] transition-colors",
            mode === id
              ? "hairline-strong bg-paper-2 text-ink"
              : "hairline text-muted hover:text-ink",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The reuse picker — and the DISCLOSURE that has to come before the confirm.
 *
 * Attaching is free and it is the fast path, and it has one consequence nobody would guess: every
 * agent's anchored manifest publishes the company it is filed under, so two agents sharing one are
 * publicly linkable to each other by anyone reading the chain. That is a property of anchoring the
 * legal body honestly rather than a bug, and the design's rule is that it is disclosed, not
 * hidden. The sentence comes from `/config` so it is versioned with the manifest field it
 * describes.
 */
function AttachPicker({
  companies,
  selected,
  onSelect,
  disclosure,
}: {
  companies: CompanyView[];
  selected: string | null;
  onSelect: (companyId: string) => void;
  /** Always present — served or bundled. It is the sentence the picker owes before a confirm. */
  disclosure: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2.5">
        {companies.map((c) => (
          <li key={c.companyId}>
            <button
              type="button"
              onClick={() => onSelect(c.companyId)}
              className={cx(
                "w-full cursor-pointer rounded-xl border px-4 py-3.5 text-left transition-colors",
                c.companyId === selected
                  ? "border-accent/40 bg-accent/[0.06]"
                  : "hairline hover:bg-paper-2",
              )}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13.5px] text-ink">{companyLabel(c)}</span>
                <CompanyStatePill state={c.state} environment={c.environment} />
              </div>
              <div className="mt-1.5 text-[11.5px] text-muted-2">
                {/* The SHARING LABEL. The field is the TOTAL including agents already attached,
                    so the sentence subtracts nothing — it names the number as what it is. */}
                {c.agents === 0
                  ? "No agents attached yet"
                  : `${c.agents} agent${c.agents === 1 ? "" : "s"} already filed under it`}
                {" · "}
                {c.industryLabel}
              </div>
            </button>
          </li>
        ))}
      </ul>
      <Callout tone="warn" title="Agents that share a company are publicly linkable">
        {disclosure}
      </Callout>
    </div>
  );
}

/**
 * The company this agent will be filed under — after a create OR an attach.
 *
 * It used to render a green tick and an opaque handle, with no word about WHAT had been created.
 * A sandbox company and a real Wyoming LLC produced the identical screen, in the identical
 * colour, on the step whose entire subject is which of the two this is. The pill is the same one
 * the list, the detail page and the reuse picker render, so the four cannot describe one row
 * differently — and until the row is in hand it says so rather than guessing.
 */
function AttachedPanel({
  companyId,
  state,
  environment,
  onClear,
}: {
  companyId: string;
  state: string | null;
  environment: string | null;
  onClear: () => void;
}) {
  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13px] text-emerald-300">
          <CheckIcon className="h-4 w-4" />
          This agent will be filed under the company below
        </div>
        {state !== null && environment !== null ? (
          <CompanyStatePill state={state} environment={environment} />
        ) : (
          <AmberPill>Reading this company&apos;s filing state…</AmberPill>
        )}
      </div>
      <p className="mt-3 text-[12.5px] leading-[1.6] text-muted">
        The wizard kept the company handle and nothing else — no identity is held in this browser.
        The handle travels with the onboarding request; it identifies a filing, not a person.
      </p>
      <code className="mt-4 block break-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink">
        {companyId}
      </code>
      <button
        type="button"
        onClick={onClear}
        className="mt-4 cursor-pointer text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        Use a different company
      </button>
    </Card>
  );
}

/**
 * The environment is not known yet — so this panel claims NOTHING about it.
 *
 * No demo wording, no real-filing wording, no form and no synthetic-identity button: the panels
 * below are all assertions about what this deployment does, and none can be made from here. What
 * it does offer is the way out — asking `/config` again, without losing the wizard state a page
 * reload would throw away.
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
 *  Rendered only for a CONFIRMED sandbox — an unreported environment gets `UnresolvedPanel`. */
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
          No real name, email, phone, address or SSN is collected here, or sent anywhere — the
          zero-PII discipline, kept. The company&apos;s own details below are still yours to
          choose, because they are what the demo files under.
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

function Point({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-2" />
      <span>{children}</span>
    </li>
  );
}
