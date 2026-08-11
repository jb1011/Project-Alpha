"use client";

import * as React from "react";
import { ActiveConnectionsPanel } from "@/components/agents/ActiveConnectionsPanel";
import { AgentShell } from "@/components/agents/AgentShell";
import { GuardianPasskeysPanel } from "@/components/agents/GuardianPasskeysPanel";
import { RequireAuth } from "@/components/agents/RequireAuth";
import { TenantRecord } from "@/components/agents/TenantRecord";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { listEntities, worldIdMe } from "@/lib/api/client";
import { lookupEnsName } from "@/lib/ens";
import type { WorldIdMe } from "@/lib/api/types";

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
  const [me, setMe] = React.useState<WorldIdMe | null>(null);
  const [entityCount, setEntityCount] = React.useState<number | null>(null);
  const [ensName, setEnsName] = React.useState<string | null>(null);

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

  // ENS primary name for the wallet — decoration over the address, so failures stay silent.
  React.useEffect(() => {
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
      entityCount={entityCount}
      connections={
        <ActiveConnectionsPanel filter={{ mode: "tenant" }} hideHeader />
      }
      passkeys={<GuardianPasskeysPanel hideHeader />}
    />
  );
}
