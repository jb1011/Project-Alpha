"use client";

import { BootstrapAgent } from "@/components/agents/BootstrapAgent";
import { AgentShell } from "@/components/agents/AgentShell";
import { RequireAuth } from "@/components/agents/RequireAuth";

export default function ConnectPage() {
  return (
    <RequireAuth>
      <AgentShell title="Connect an agent">
        <BootstrapAgent />
      </AgentShell>
    </RequireAuth>
  );
}
