"use client";

import { CompaniesList } from "@/components/agents/CompaniesList";
import { AgentShell } from "@/components/agents/AgentShell";
import { RequireAuth } from "@/components/agents/RequireAuth";

/**
 * `/agents/companies` — the Companies section (design §7).
 *
 * A STATIC segment beside `/agents/[id]`, which Next.js resolves in its favour. That is
 * deterministic rather than lucky: an entity id is `0x<tenant>:<name>`, so no agent can ever be
 * addressed as the bare word "companies" and be shadowed by this route.
 */
export default function CompaniesPage() {
  return (
    <RequireAuth>
      <AgentShell>
        <CompaniesList />
      </AgentShell>
    </RequireAuth>
  );
}
