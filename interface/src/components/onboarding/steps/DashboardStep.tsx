"use client";

import { AgentDashboard } from "@/components/agents/AgentDashboard";
import type { AgentConfig } from "@/components/onboarding/types";

/** Onboarding wizard wrapper — delegates to the shared agent dashboard. */
export function DashboardStep({
  config,
  entity,
  onRestart,
}: {
  config: AgentConfig;
  entity: { id: string } | null;
  onRestart: () => void;
}) {
  if (!entity?.id) {
    return (
      <div className="py-12 text-center text-[13px] text-muted-2">
        No agent deployed yet.
      </div>
    );
  }

  return (
    <AgentDashboard entityId={entity.id} config={config} onRestart={onRestart} />
  );
}
