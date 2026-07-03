"use client";

import * as React from "react";
import Link from "next/link";
import { listEntities } from "@/lib/api/client";
import type { EntityView } from "@/lib/api/types";
import { addressUrl } from "@/lib/chain";
import { AgentShell } from "@/components/agents/AgentShell";
import { LoadingState, RequireAuth } from "@/components/agents/RequireAuth";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Card, cx } from "@/components/onboarding/primitives";
import { shortAddress } from "@/components/onboarding/types";

export default function AgentsPage() {
  return (
    <RequireAuth>
      <AgentsList />
    </RequireAuth>
  );
}

function AgentsList() {
  const { ensureSession } = useAuth();
  const [entities, setEntities] = React.useState<EntityView[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const auth = await ensureSession();
        const list = await listEntities(auth.token);
        if (!cancelled) setEntities(list);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load agents.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureSession]);

  return (
    <AgentShell title="My agents" subtitle="All agents for your guardian wallet">
      {entities === null && !error ? (
        <LoadingState label="Loading agents…" />
      ) : error ? (
        <p className="py-12 text-center text-[13px] text-[#ff8a84]">{error}</p>
      ) : !entities || entities.length === 0 ? (
        <Card className="p-10 text-center">
          <h2 className="text-[20px] font-medium text-ink">No agents yet</h2>
          <p className="mt-2 text-[13px] text-muted">
            Create your first autonomous agent — passkey, policy, treasury, and governance in one flow.
          </p>
          <Link
            href="/onboarding"
            className="mt-6 inline-flex rounded-full bg-ink px-5 py-2.5 text-[13px] font-medium text-paper hover:bg-ink-hover"
          >
            Create a new agent
          </Link>
        </Card>
      ) : (
        <>
          <div className="mb-4 flex justify-end gap-2">
            <Link
              href="/agents/connect"
              className="inline-flex rounded-full border hairline-strong bg-paper/40 px-5 py-2.5 text-[13px] font-medium text-ink hover:bg-paper-2"
            >
              Connect an agent
            </Link>
            <Link
              href="/onboarding?new=1"
              className="inline-flex rounded-full bg-ink px-5 py-2.5 text-[13px] font-medium text-paper hover:bg-ink-hover"
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
    <li>
      <Link
        href={`/agents/${encodeURIComponent(entity.id)}`}
        className="block rounded-2xl border hairline bg-paper-2/30 px-5 py-4 transition-colors hover:border-accent/25 hover:bg-paper-2/60"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] font-medium text-ink">{entity.name}</div>
            <div className="mt-1 font-mono text-[11.5px] text-muted-2">
              {entity.treasury ? (
                <a
                  href={addressUrl(entity.treasury)}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(ev) => ev.stopPropagation()}
                  className="hover:text-accent-soft"
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
      </Link>
    </li>
  );
}
