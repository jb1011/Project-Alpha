"use client";

import * as React from "react";
import { ActiveConnectionsPanel } from "@/components/agents/ActiveConnectionsPanel";
import { AgentShell } from "@/components/agents/AgentShell";
import { GuardianPasskeysPanel } from "@/components/agents/GuardianPasskeysPanel";
import { RequireAuth } from "@/components/agents/RequireAuth";
import { TenantRecord } from "@/components/agents/TenantRecord";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { listEntities, worldIdMe } from "@/lib/api/client";
import type { WorldIdMe } from "@/lib/api/types";

export default function AccountPage() {
  return (
    <RequireAuth>
      <AgentShell title="Account" subtitle="The tenant behind your agents.">
        <AccountBody />
      </AgentShell>
    </RequireAuth>
  );
}

function AccountBody() {
  const { session, address } = useAuth();
  const [me, setMe] = React.useState<WorldIdMe | null>(null);
  const [entityCount, setEntityCount] = React.useState<number | null>(null);

  // Reads only — the stored session is enough, and rendering must never provoke a signature.
  React.useEffect(() => {
    const token = session?.token;
    if (!token) return;
    let live = true;
    worldIdMe(token)
      .then((v) => live && setMe(v))
      .catch(() => {}); // deployments without World simply show no guardian standing
    listEntities(token)
      .then((es) => live && setEntityCount(es.length))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [session?.token]);

  return (
    <TenantRecord
      address={address}
      me={me}
      entityCount={entityCount}
      connections={<ActiveConnectionsPanel filter={{ mode: "tenant" }} hideHeader />}
      passkeys={<GuardianPasskeysPanel hideHeader />}
    />
  );
}
