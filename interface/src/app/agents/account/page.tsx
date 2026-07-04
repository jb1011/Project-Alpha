"use client";

import { AgentShell } from "@/components/agents/AgentShell";
import { RequireAuth } from "@/components/agents/RequireAuth";
import { ActiveConnectionsPanel } from "@/components/agents/ActiveConnectionsPanel";
import { GuardianPasskeysPanel } from "@/components/agents/GuardianPasskeysPanel";
import { Card } from "@/components/onboarding/primitives";

export default function AccountPage() {
  return (
    <RequireAuth>
      <AgentShell title="Account" subtitle="Tenant-wide connections & guardian passkeys">
        <div className="mx-auto flex max-w-[720px] flex-col gap-6">
          <Card>
            <p className="text-[12px] text-muted-2">
              These operate across your whole tenant. Bootstrap connections can act on any of your
              agents; guardian passkeys authorize creating new agents. Per-agent connections live on
              each agent&apos;s dashboard.
            </p>
          </Card>
          <Card>
            <ActiveConnectionsPanel filter={{ mode: "tenant" }} />
          </Card>
          <Card>
            <GuardianPasskeysPanel />
          </Card>
        </div>
      </AgentShell>
    </RequireAuth>
  );
}
