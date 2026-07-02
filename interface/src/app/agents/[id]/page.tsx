"use client";

import { use } from "react";
import { AgentDashboard } from "@/components/agents/AgentDashboard";
import { AgentShell } from "@/components/agents/AgentShell";
import { RequireAuth } from "@/components/agents/RequireAuth";

export default function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <RequireAuth>
      <AgentShell entityId={id}>
        <AgentDashboard entityId={decodeURIComponent(id)} />
      </AgentShell>
    </RequireAuth>
  );
}
