"use client";

import Link from "next/link";
import { useCompaniesQuery } from "@/lib/api/hooks";
import type { CompanyView } from "@/lib/api/types";
import { companyLabel } from "@/lib/formation/companyIntake";
import { formatDate } from "@/lib/format";
import { CompanyStatePill } from "@/components/agents/CompanyStatePill";
import { LoadingState } from "@/components/agents/RequireAuth";
import { Card } from "@/components/onboarding/primitives";

/**
 * THE COMPANIES SECTION (design §7) — the legal bodies, as their own thing.
 *
 * Until A3 a company existed only as a block on an agent's dashboard, which was the wrong shape
 * in both directions: a company can be filed, have its documents fetched and its EIN issued
 * before any agent attaches to it (nothing could show it), and ten agents can share one (each
 * showed it separately, and none of them said so).
 *
 * `empty` is §7's ninth state and the only one that belongs to the LIST rather than to a row.
 */
export function CompaniesList() {
  const { data, isPending, error } = useCompaniesQuery();
  const message = error instanceof Error ? error.message : error ? "Failed to load companies." : null;
  const companies = data?.companies ?? [];

  return (
    <>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-medium text-ink">Legal bodies</h1>
          <p className="mt-1 text-[13px] text-muted">
            The Wyoming LLCs your agents are filed under. One company can carry several agents.
          </p>
        </div>
      </div>

      {isPending && !message ? (
        <LoadingState label="Loading companies…" />
      ) : message ? (
        <p className="py-12 text-center text-[13px] text-[#ff8a84]">{message}</p>
      ) : companies.length === 0 ? (
        <Card className="p-10 text-center">
          <h2 className="text-[18px] font-medium text-ink">No legal bodies yet</h2>
          <p className="mx-auto mt-2 max-w-md text-[13px] leading-[1.6] text-muted">
            A company is created as part of onboarding an agent — the wizard&apos;s legal-body step
            collects the responsible person and files the LLC. Agents you add afterwards can attach
            to the same company for free.
          </p>
          <Link
            href="/onboarding?new=1"
            className="mt-6 inline-flex rounded-full bg-ink px-5 py-2.5 text-[13px] font-medium text-paper transition-colors hover:bg-ink-hover"
          >
            Create an agent
          </Link>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {companies.map((c) => (
            <li key={c.companyId}>
              <CompanyRow company={c} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CompanyRow({ company }: { company: CompanyView }) {
  return (
    <Link
      href={`/agents/companies/${encodeURIComponent(company.companyId)}`}
      className="block rounded-xl border hairline bg-paper/40 px-5 py-4 transition-colors hover:bg-paper-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-[14px] text-ink">{companyLabel(company)}</span>
        <CompanyStatePill state={company.state} environment={company.environment} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted-2">
        {/* The SHARING LABEL. The count is the TOTAL attached, named as what it is rather than
            subtracted into "others" — an off-by-one in a label is an off-by-one everywhere. */}
        <span>
          {company.agents === 0
            ? "No agents attached"
            : `${company.agents} agent${company.agents === 1 ? "" : "s"}`}
        </span>
        <span aria-hidden>·</span>
        <span>{company.industryLabel}</span>
        <span aria-hidden>·</span>
        <span>
          {company.filedAt ? `Filed ${formatDate(company.filedAt * 1000)}` : "Not filed yet"}
        </span>
      </div>
    </Link>
  );
}
