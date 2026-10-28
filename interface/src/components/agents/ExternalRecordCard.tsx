"use client";

import { Button, Callout, Card, SectionTitle } from "@/components/onboarding/primitives";
import { useEntityExternalRecordQuery, usePublicConfigQuery } from "@/lib/api/hooks";
import { type CardInput, externalRecordCardModel } from "@/lib/externalRecord/cardModel";
import { formatDate } from "@/lib/format";

/**
 * The agent's track record graded by an independent provider (design 2026-10-23, section 4.6),
 * shown on the settings screen beside a pending limit change so the guardian reads it as part of
 * the decision. Rendered only where the deployment configures a provider and the agent has an
 * identity. Every word and every state comes from `externalRecordCardModel`; this only lays it out.
 */
export function ExternalRecordCard({ entityId, agentId }: { entityId: string; agentId: string | null }) {
  const config = usePublicConfigQuery();
  const available = Boolean(config.data?.externalRecord?.available) && agentId !== null;
  const providerName = config.data?.externalRecord?.providerName ?? null;
  const query = useEntityExternalRecordQuery(entityId, available);

  if (!available || !providerName) return null;

  // A failed refetch keeps the previous answer in `data`: it is still shown, and said to be old.
  const input: CardInput = query.data
    ? { phase: "ready", view: query.data, refreshFailed: query.isError }
    : query.isError
      ? { phase: "failed" }
      : { phase: "loading" };
  const m = externalRecordCardModel(input, providerName, formatDate);

  return (
    <Card className="p-5">
      <SectionTitle>{m.title}</SectionTitle>
      <p className="mt-1 text-[12px] leading-relaxed text-muted-2">{m.intro}</p>
      <p className="mt-1 text-[11.5px] text-muted-2">{m.sandbox}</p>

      {m.status && <p className="mt-4 text-[13px] text-muted">{m.status}</p>}

      {m.figures.length > 0 && (
        <dl className="mt-4 grid grid-cols-1 gap-3 text-[12.5px] sm:grid-cols-2">
          {m.figures.map((f) => (
            <div key={f.label}>
              <dt className="text-muted-2">{f.label}</dt>
              <dd className="mt-0.5 text-ink">
                <span className="font-mono tabular-nums">{f.value}</span>{" "}
                <span className="text-[11.5px] text-muted-2">({f.source})</span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {m.notices.length > 0 && (
        <Callout tone="muted" className="mt-4">
          {m.notices.map((n) => (
            <p key={n} className="text-[12px]">
              {n}
            </p>
          ))}
        </Callout>
      )}

      {(m.link || m.retry) && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {m.link && (
            <a
              href={m.link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12.5px] text-accent-soft underline-offset-2 hover:underline"
            >
              {m.link.label}
            </a>
          )}
          {m.retry && (
            <Button
              variant="ghost"
              size="md"
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
