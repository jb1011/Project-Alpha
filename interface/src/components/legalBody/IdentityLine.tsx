import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";

/**
 * "Your agent's identity" and its agent id, near the top of the link and pointer steps, where a
 * person looks for the id once it is chosen. Nothing is shown until the step knows the id
 * (`identityOnStep`).
 */
export function IdentityLine({ agentId }: { agentId: string | null }) {
  if (agentId === null) return null;
  return (
    <p className="mb-6 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="font-mono text-[11.5px] uppercase tracking-[0.12em] text-muted-2">
        {LEGAL_BODY_COPY.identity.yourIdentity}
      </span>
      <span className="break-all font-mono text-[13.5px] text-ink">{agentId}</span>
    </p>
  );
}
