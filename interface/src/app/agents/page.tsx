"use client";

import Link from "next/link";
import { useEntitiesQuery } from "@/lib/api/hooks";
import { AgentShell } from "@/components/agents/AgentShell";
import { AgentCards } from "@/components/agents/AgentCards";
import { LoadingState, RequireAuth } from "@/components/agents/RequireAuth";
import { Card } from "@/components/onboarding/primitives";
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
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-[22px] font-medium text-ink">Your agents</h1>
              <p className="mt-1 text-[13px] text-muted">
                {entities.length === 1 ? "One agent is with you." : `${entities.length} agents are with you.`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
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
          </div>
          <AgentCards entities={entities} />
        </>
      )}
    </AgentShell>
  );
}
