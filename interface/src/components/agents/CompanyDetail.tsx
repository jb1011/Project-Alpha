"use client";

import Link from "next/link";
import { useState } from "react";
import { downloadDocument } from "@/lib/api/client";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { useCompanyComplianceQuery, useCompanyQuery } from "@/lib/api/hooks";
import type { CompanyDetailView, FormationDocument } from "@/lib/api/types";
import { companyLabel } from "@/lib/formation/companyIntake";
import { companyPill, mayRenderConfirmed } from "@/lib/formation/honesty";
import { formatDate } from "@/lib/format";
import { CompanyStatePill } from "@/components/agents/CompanyStatePill";
import { CompanyParkPanel } from "@/components/agents/CompanyParkPanel";
import { LoadingState } from "@/components/agents/RequireAuth";
import { Button, Callout, Card, SectionTitle, Spinner, cx } from "@/components/onboarding/primitives";

/**
 * ONE LEGAL BODY (design §7) — everything about a filing, in the place it belongs.
 *
 * The four things a company's own page can show that an agent's dashboard never could: the
 * agents SHARING it, its documents (which exist whether or not any agent is attached), its
 * compliance calendar, and — the reason the page has to exist — the PARK STATE, with the form
 * that clears it.
 */
export function CompanyDetail({ companyId }: { companyId: string }) {
  // Parked companies are waiting on a human and change only when that human acts, so there is
  // nothing to poll for. The page refetches when the mutations that CAN change it succeed.
  const { data: company, isPending, error } = useCompanyQuery(companyId);
  const message =
    error instanceof Error ? error.message : error ? "Failed to load this company." : null;

  return (
    <>
      <div className="mb-6">
        <Link
          href="/agents/companies"
          className="text-[12px] text-muted transition-colors hover:text-ink"
        >
          ← Legal bodies
        </Link>
      </div>
      {isPending && !message ? (
        <LoadingState label="Loading company…" />
      ) : message || !company ? (
        <p className="py-12 text-center text-[13px] text-[#ff8a84]">
          {message ?? "Company not found."}
        </p>
      ) : (
        <CompanyBody company={company} />
      )}
    </>
  );
}

function CompanyBody({ company }: { company: CompanyDetailView }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-medium text-ink">{companyLabel(company)}</h1>
          <p className="mt-1 text-[12.5px] text-muted-2">
            {/* EPOCH MS on the wire since A3. It used to be the backend's raw SQLite TEXT and
                this line reconstructed the timezone the format had thrown away — a `Z` concatenated
                on in a browser, on a legal surface, where forgetting it shifts a company's
                creation date by the reader's own offset. */}
            {company.industryLabel} · created {formatDate(company.createdAt)}
          </p>
        </div>
        <CompanyStatePill state={company.state} environment={company.environment} />
      </div>

      {/* FIRST, above everything: a parked filing is doing nothing until its owner acts, and
          burying that under the facts is how a company sits stopped for a month. */}
      <CompanyParkPanel company={company} />

      {company.intakeSynthesized && (
        <Callout tone="warn" title="These details were derived, not typed">
          This company&apos;s name, purpose and industry were filled in automatically when it was
          migrated from an older record. Check them before it files — nobody chose them.
        </Callout>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <FilingFacts company={company} />
          <Documents company={company} />
          <Compliance company={company} />
        </div>
        <div className="flex flex-col gap-6">
          <AttachedAgents company={company} />
          <IntakeCard company={company} />
        </div>
      </div>
    </div>
  );
}

function FilingFacts({ company }: { company: CompanyDetailView }) {
  return (
    <Card className="p-5">
      <SectionTitle>Filing</SectionTitle>
      {company.requiredActions.length > 0 && (
        <div className="mt-4 rounded-xl border border-[#febc2e]/30 bg-[#febc2e]/[0.07] px-4 py-3">
          <div className="text-[12px] font-medium text-ink">
            The filing agent is waiting on something
          </div>
          <ul className="mt-2 flex flex-col gap-1.5">
            {company.requiredActions.map((code) => (
              <li key={code} className="font-mono text-[11px] text-[#f3cd72]">
                {code}
              </li>
            ))}
          </ul>
        </div>
      )}
      <dl className="mt-4 flex flex-col gap-3 text-[12.5px]">
        <Row k="Filing agent" v="doola" />
        <Row k="Environment" v={company.environment} />
        {company.providerRef && <Row k="Provider reference" v={company.providerRef} mono />}
        <Row
          k="Filed"
          v={company.filedAt ? formatDate(company.filedAt * 1000) : "—"}
        />
        <Row k="Filing number" v={company.filingNumber ?? "—"} mono={!!company.filingNumber} />
        {/* The name the STATE accepted, which is one of OUR candidates — never provider free
            text. Null until a match is made, which is what keeps the anchored manifest honest. */}
        <Row k="Filed name" v={company.legalNameFiled ?? "—"} />
        {/* ⚠ Owner-visible only. This page is tenant-scoped; no public surface carries it. */}
        <Row k="EIN" v={company.ein ?? "—"} mono={!!company.ein} />
      </dl>
    </Card>
  );
}

function Documents({ company }: { company: CompanyDetailView }) {
  const { session } = useAuth();
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * ⚠ NOT `environment !== "production"`, which is what this was.
   *
   * Two values cannot carry three facts, and the one that got lost was "we don't know" — which
   * this spelling then rendered as "demo", labelling a filing whose environment could not be read
   * as one that legally does not exist. `companyPill` is the shared decision: the demo WORD
   * follows the environment, the COLOUR follows the tone, and an unreported environment says so.
   */
  const { tone, environment } = companyPill(company.state, company.environment);
  const demo = environment === "sandbox";
  const unverified = !mayRenderConfirmed(tone);

  async function download(doc: FormationDocument) {
    const token = session?.token;
    if (!token) {
      setError("Sign in again to download documents.");
      return;
    }
    setError(null);
    setBusyDocId(doc.id);
    try {
      // fetch → blob → objectURL, because an `<a href>` cannot carry a Bearer token and the route
      // is owner-only. Company-keyed since A3: the documents belong to the FILING.
      const { blob, filename } = await downloadDocument(token, company.companyId, doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename ?? doc.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not download the document.");
    } finally {
      setBusyDocId(null);
    }
  }

  return (
    <Card className={cx("p-5", unverified && "border-[#febc2e]/25 bg-[#febc2e]/[0.04]")}>
      <SectionTitle>
        Legal documents
        {demo ? " (demo)" : unverified ? " (environment not reported)" : ""}
      </SectionTitle>
      {company.documents.length === 0 ? (
        <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-2">
          None yet. The filing agent produces the Articles of Organization and the Operating
          Agreement once the company is filed; they appear here, and their hashes go into the next
          version of each attached agent&apos;s on-chain anchor.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {company.documents.map((doc) => (
            <li
              key={doc.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border hairline bg-paper/50 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate text-[12.5px] text-ink">{humanDocType(doc.type)}</div>
                <div className="mt-0.5 truncate font-mono text-[10.5px] text-muted-2">
                  sha256 {doc.sha256.slice(0, 18)}… · {formatBytes(doc.size)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void download(doc)}
                disabled={busyDocId !== null}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border hairline-strong px-3 py-1.5 text-[11.5px] text-muted transition-colors hover:text-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busyDocId === doc.id && <Spinner className="h-3 w-3" />}
                {busyDocId === doc.id ? "Downloading…" : "Download PDF"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[11.5px] leading-[1.4] text-[#ff8a84]">{error}</p>}
    </Card>
  );
}

/**
 * The compliance calendar — lazy on both sides, and it may REFUSE.
 *
 * The backend fetches it from the filing agent on view and caches it for a day. A provider that
 * did not answer is an error here, deliberately: "we could not ask" and "nothing is due" are
 * opposite facts, and rendering the first as the second would tell an owner their annual report
 * is not due when nobody asked.
 */
function Compliance({ company }: { company: CompanyDetailView }) {
  const { data, isPending, error, refetch, isFetching } = useCompanyComplianceQuery(
    company.companyId,
  );
  return (
    <Card className="p-5">
      <SectionTitle>Compliance</SectionTitle>
      {isPending ? (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-muted-2">
          <Spinner className="h-3.5 w-3.5" /> Asking the filing agent…
        </div>
      ) : error ? (
        <div className="mt-3">
          <p className="text-[12px] leading-[1.6] text-[#f3cd72]">
            {error instanceof Error ? error.message : "The filing agent did not answer."}
          </p>
          <Button className="mt-3" variant="ghost" loading={isFetching} onClick={() => void refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          {data?.events.length === 0 ? (
            <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-2">
              {data.providerRef
                ? "The filing agent reports nothing due."
                : "Nothing is due until the company is filed."}
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
              {(data?.events ?? []).map((e, i) => (
                <li
                  key={`${e.type ?? "event"}-${i}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border hairline bg-paper/50 px-3 py-2.5 text-[12px]"
                >
                  <span className="text-ink">{e.type ?? "Unnamed obligation"}</span>
                  <span className="text-muted-2">
                    {e.nextDueDate ? `due ${e.nextDueDate}` : "no date reported"}
                    {e.status ? ` · ${e.status}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* The PLACEHOLDER, always, and visibly not provider data — see the backend constant.
              Omitting the obligation would be worse than admitting we do not know who files it:
              an owner reading an empty calendar concludes there is nothing to do. */}
          {data && (
            <div className="mt-3 rounded-xl border border-dashed hairline-strong px-3 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px]">
                <span className="text-ink">{data.annualReport.label}</span>
                <span className="text-muted-2">
                  {data.annualReport.due} · handled by {data.annualReport.handledBy}
                </span>
              </div>
              <p className="mt-1.5 text-[11px] leading-[1.55] text-muted-2">
                {data.annualReport.note}
              </p>
            </div>
          )}
          {data?.fetchedAt && (
            <p className="mt-3 text-[10.5px] text-muted-2">
              From the filing agent, {formatDate(data.fetchedAt)}.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function AttachedAgents({ company }: { company: CompanyDetailView }) {
  return (
    <Card className="p-5">
      <SectionTitle>Agents</SectionTitle>
      {company.attachedAgents.length === 0 ? (
        <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-2">
          No agents are attached yet. A company can be filed before any agent joins it.
        </p>
      ) : (
        <>
          <ul className="mt-3 flex flex-col gap-2">
            {company.attachedAgents.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/agents/${encodeURIComponent(a.id)}`}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[12.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink"
                >
                  <span className="truncate">{a.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-2">{a.status}</span>
                </Link>
              </li>
            ))}
          </ul>
          {company.attachedAgents.length > 1 && (
            <p className="mt-3 text-[11px] leading-[1.55] text-muted-2">
              These agents are publicly linkable: each one anchors a record naming this company.
            </p>
          )}
        </>
      )}
    </Card>
  );
}

function IntakeCard({ company }: { company: CompanyDetailView }) {
  return (
    <Card className="p-5">
      <SectionTitle>Filed as</SectionTitle>
      <ol className="mt-3 flex flex-col gap-1.5 text-[12.5px]">
        {company.nameOptions.map((o) => (
          <li key={o.position} className="flex gap-2 text-muted">
            <span className="text-muted-2">{o.position}.</span>
            <span className={cx(company.legalNameFiled === o.name && "text-emerald-300")}>
              {o.name} {o.entityTypeEnding}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-4 border-t hairline pt-3">
        <div className="text-[11px] uppercase tracking-[0.16em] text-muted-2">Purpose</div>
        <p className="mt-1.5 text-[12px] leading-[1.6] text-muted">{company.businessPurpose}</p>
      </div>
    </Card>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-2">{k}</dt>
      <dd className={cx("min-w-0 truncate text-right text-ink", mono && "font-mono text-[11.5px]")}>
        {v}
      </dd>
    </div>
  );
}

function humanDocType(type: string): string {
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
