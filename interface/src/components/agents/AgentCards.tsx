import Link from "next/link";
import type { EntityView } from "@/lib/api/types";
import { addressUrl } from "@/lib/chain";
import { AgentPersona } from "@/components/agents/AgentPersona";
import { agentMood, agentMoodLabel, type AgentMood } from "@/components/agents/persona";
import { cx } from "@/components/onboarding/primitives";
import { shortAddress } from "@/components/onboarding/types";

const PILL: Record<AgentMood, string> = {
  ready: "border-accent/30 bg-accent/15 text-accent-soft",
  setting: "hairline-strong bg-paper-3/80 text-muted",
  attention: "border-[#ff8a84]/40 bg-[#ff8a84]/10 text-[#ff8a84]",
};

export function AgentCards({ entities }: { entities: EntityView[] }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {entities.map((entity) => (
        <AgentCard key={entity.id} entity={entity} />
      ))}
    </ul>
  );
}

function AgentCard({ entity }: { entity: EntityView }) {
  const mood = agentMood(entity.status);
  return (
    <li className="relative rounded-3xl border hairline bg-paper-2/30 p-5 transition-colors hover:border-accent/25 hover:bg-paper-2/60 focus-within:border-accent/40">
      <div className="flex items-center gap-4">
        <AgentPersona seed={entity.id} mood={mood} className="h-16 w-16 shrink-0" />
        <div className="min-w-0">
          <Link
            href={`/agents/${encodeURIComponent(entity.id)}`}
            className="text-[18px] font-medium text-ink after:absolute after:inset-0 focus-visible:outline-none"
          >
            <span className="block truncate">{entity.name}</span>
          </Link>
          <span
            className={cx(
              "mt-2 inline-flex rounded-full border px-2.5 py-0.5 text-[12px]",
              PILL[mood],
            )}
          >
            {agentMoodLabel(mood)}
          </span>
          <div className="relative z-10 mt-2 font-mono text-[11.5px] text-muted-2">
            {entity.treasury ? (
              <a
                href={addressUrl(entity.treasury)}
                target="_blank"
                rel="noreferrer"
                className="hover:text-accent-soft"
              >
                {shortAddress(entity.treasury)}
              </a>
            ) : (
              "Deploying…"
            )}
            {entity.agentId ? <> · agent #{entity.agentId}</> : null}
          </div>
        </div>
      </div>
    </li>
  );
}
