"use client";

import Link from "next/link";
import { useEntitiesQuery } from "@/lib/api/hooks";
import type { EntityView } from "@/lib/api/types";
import { addressUrl } from "@/lib/chain";
import { AgentShell } from "@/components/agents/AgentShell";
import { LoadingState, RequireAuth } from "@/components/agents/RequireAuth";
import { Card, cx } from "@/components/onboarding/primitives";
import { shortAddress } from "@/components/onboarding/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";

export default function AgentsPage() {
  return (
    <RequireAuth>
      <AgentsList />
    </RequireAuth>
  );
}

function AgentsList() {
  const { data: entities, isPending, error } = useEntitiesQuery();
  const errorMessage = error instanceof Error ? error.message : error ? "Failed to load agents." : null;

  return (
    <AgentShell>
      {isPending && !errorMessage ? (
        <LoadingState label="Loading agents…" />
      ) : errorMessage ? (
        <p className="py-12 text-center text-[13px] text-[#ff8a84]">{errorMessage}</p>
      ) : !entities || entities.length === 0 ? (
        <Card className="p-10 text-center">
          <h2 className="text-[20px] font-medium text-ink">No agents yet</h2>
          <p className="mt-2 text-[13px] text-muted">
            Create your first autonomous agent — passkey, policy, treasury, and
            governance in one flow.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link
              href="/onboarding"
              className="inline-flex rounded-full bg-ink px-5 py-2.5 text-[13px] font-medium text-paper hover:bg-ink-hover"
            >
              Create a new agent
            </Link>
            <Link
              href="/legal-body"
              className="inline-flex rounded-full border hairline-strong bg-paper/40 px-5 py-2.5 text-[13px] font-medium text-ink hover:bg-paper-2"
            >
              {LEGAL_BODY_COPY.entry.button}
            </Link>
          </div>
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap justify-end gap-2">
            <Link
              href="/legal-body"
              className="inline-flex h-10 items-center rounded-full border hairline-strong bg-paper/40 px-5 text-[13px] font-medium leading-none text-ink hover:bg-paper-2"
            >
              {LEGAL_BODY_COPY.entry.button}
            </Link>
            <Link
              href="/agents/connect"
              className="inline-flex h-10 items-center rounded-full border hairline-strong bg-paper/40 px-5 text-[13px] font-medium leading-none text-ink hover:bg-paper-2"
            >
              Connect an agent
            </Link>
            <Link
              href="/onboarding?new=1"
              className="inline-flex h-10 items-center rounded-full border border-transparent bg-ink px-5 text-[13px] font-medium leading-none text-paper hover:bg-ink-hover"
            >
              Create another agent
            </Link>
          </div>
          <ul className="flex flex-col gap-3">
            {entities.map((e) => (
              <AgentRow key={e.id} entity={e} />
            ))}
          </ul>
        </>
      )}
    </AgentShell>
  );
}

function AgentRow({ entity }: { entity: EntityView }) {
  const statusCls =
    entity.status === "failed"
      ? "border-[#ff5f57]/30 text-[#ff8a84]"
      : entity.status === "funded" || entity.status === "bound"
        ? "border-accent/30 text-accent-soft"
        : "border-line-strong text-muted-2";

  return (
    <li className="relative rounded-2xl border hairline bg-paper-2/30 transition-colors hover:border-accent/25 hover:bg-paper-2/60">
      <div className="px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link
              href={`/agents/${encodeURIComponent(entity.id)}`}
              className="text-[15px] font-medium text-ink after:absolute after:inset-0"
            >
              {entity.name}
            </Link>
            <div className="mt-1 font-mono text-[11.5px] text-muted-2">
              {entity.treasury ? (
                <a
                  href={addressUrl(entity.treasury)}
                  target="_blank"
                  rel="noreferrer"
                  className="relative z-10 hover:text-accent-soft"
                >
                  {shortAddress(entity.treasury)}
                </a>
              ) : (
                "Deploying…"
              )}
              {entity.agentId && <> · agent #{entity.agentId}</>}
            </div>
          </div>
          <span
            className={cx(
              "rounded-full border px-2.5 py-0.5 text-[10px] uppercase tracking-[0.1em]",
              statusCls,
            )}
          >
            {entity.status}
          </span>
        </div>
      </div>
    </li>
  );
}
