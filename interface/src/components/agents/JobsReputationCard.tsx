"use client";

import { useJobsReputationQueries } from "@/lib/api/hooks";
import type { JobView } from "@/lib/api/types";
import { txUrl } from "@/lib/chain";
import { Card, cx, ExternalIcon } from "@/components/onboarding/primitives";
import { formatUsdc } from "@/components/onboarding/types";

export function JobsReputationCard({ entityId }: { entityId: string }) {
  const { reputation, jobs } = useJobsReputationQueries(entityId);

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b hairline px-5 py-3.5">
        <span className="text-[13px] font-medium text-ink">Jobs &amp; reputation</span>
        <span className="text-[11.5px] text-muted-2">ERC-8183 track record</span>
      </div>

      {reputation.data && (
        <div className="grid grid-cols-3 gap-px border-b hairline bg-line">
          <RepStat label="Total jobs" value={String(reputation.data.totalJobs)} />
          <RepStat label="Completed" value={String(reputation.data.completed)} />
          <RepStat label="Reputed" value={String(reputation.data.reputed)} />
        </div>
      )}

      {!jobs.data || jobs.data.length === 0 ? (
        <div className="px-5 py-10 text-center text-[12.5px] text-muted-2">
          No on-chain jobs yet — jobs are created outside the dashboard.
        </div>
      ) : (
        <ul>
          {jobs.data.map((job) => (
            <JobRow key={job.jobKey} job={job} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function RepStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-paper px-4 py-3 text-center">
      <div className="text-[20px] font-medium tabular-nums text-ink">{value}</div>
      <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.14em] text-muted-2">{label}</div>
    </div>
  );
}

function JobRow({ job }: { job: JobView }) {
  const budget = formatUsdc(Number(job.budgetAmount) / 1e6);
  const terminal = job.status === "completed" || job.status === "reputed" || job.status === "failed";
  const tx = job.reputationTxHash ?? job.completeTxHash ?? job.createTxHash;

  return (
    <li className="border-b hairline px-5 py-3.5 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] text-ink">{job.description}</div>
          <div className="mt-0.5 text-[11.5px] text-muted-2">
            Budget {budget} USDC
            {job.deliverableHash && <> · deliverable {job.deliverableHash.slice(0, 10)}…</>}
          </div>
        </div>
        <span
          className={cx(
            "shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.08em]",
            job.status === "failed"
              ? "border-[#ff5f57]/30 text-[#ff8a84]"
              : job.status === "reputed"
                ? "border-accent/30 text-accent-soft"
                : terminal
                  ? "border-line-strong text-muted"
                  : "border-accent/20 bg-accent/5 text-accent-soft",
          )}
        >
          {job.status}
        </span>
      </div>
      {tx && (
        <a
          href={txUrl(tx)}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-2 hover:text-accent-soft"
        >
          View tx <ExternalIcon className="h-3 w-3" />
        </a>
      )}
      {job.error && (
        <p className="mt-1.5 text-[11px] leading-snug text-[#ff8a84]">{job.error}</p>
      )}
    </li>
  );
}
