"use client";

import { useEffect, useState } from "react";
import { ActiveConnectionsPanel } from "@/components/agents/ActiveConnectionsPanel";
import { AgentShell } from "@/components/agents/AgentShell";
import { GuardianPasskeysPanel } from "@/components/agents/GuardianPasskeysPanel";
import { RequireAuth } from "@/components/agents/RequireAuth";
import { TenantRecord } from "@/components/agents/TenantRecord";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { useEntitiesQuery, useWorldIdMeQuery } from "@/lib/api/hooks";
import { lookupEnsName } from "@/lib/ens";

export default function AccountPage() {
  return (
    <RequireAuth>
      <AgentShell>
        <AccountBody />
      </AgentShell>
    </RequireAuth>
  );
}

function AccountBody() {
  const { session, address } = useAuth();
  const { data: me = null } = useWorldIdMeQuery({ enabled: !!session?.token });
  const { data: entities = [] } = useEntitiesQuery();
  const [ensName, setEnsName] = useState<string | null>(null);

  useEffect(() => {
    if (!address) return;
    let live = true;
    void lookupEnsName(address).then((n) => live && setEnsName(n));
    return () => {
      live = false;
    };
  }, [address]);

  return (
    <TenantRecord
      address={address}
      ensName={ensName}
      me={me}
      entityCount={entities.length}
      connections={
        <ActiveConnectionsPanel filter={{ mode: "tenant" }} hideHeader />
      }
      passkeys={<GuardianPasskeysPanel hideHeader />}
    />
  );
}
