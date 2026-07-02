"use client";

import { use } from "react";
import { AgentSettings } from "@/components/agents/AgentSettings";
import { AgentShell } from "@/components/agents/AgentShell";
import { RequireAuth } from "@/components/agents/RequireAuth";

export default function AgentSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const entityId = decodeURIComponent(id);

  return (
    <RequireAuth>
      <AgentShell entityId={entityId} title="Settings">
        <AgentSettings entityId={entityId} />
      </AgentShell>
    </RequireAuth>
  );
}
