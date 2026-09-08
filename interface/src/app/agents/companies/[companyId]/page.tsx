"use client";

import { use } from "react";
import { CompanyDetail } from "@/components/agents/CompanyDetail";
import { AgentShell } from "@/components/agents/AgentShell";
import { RequireAuth } from "@/components/agents/RequireAuth";

/** One legal body, in full — documents, compliance, the agents sharing it, and the park state
 *  with the form that clears it (design §7). */
export default function CompanyDetailPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  const { companyId } = use(params);

  return (
    <RequireAuth>
      <AgentShell>
        <CompanyDetail companyId={decodeURIComponent(companyId)} />
      </AgentShell>
    </RequireAuth>
  );
}
