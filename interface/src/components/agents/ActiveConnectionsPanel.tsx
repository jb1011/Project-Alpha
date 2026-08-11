"use client";

import { useMemo, useState } from "react";
import { useApiKeysQuery, useRevokeApiKeyMutation } from "@/lib/api/hooks";
import { CapabilityBadge, RevokeButton } from "@/components/agents/connectionRow";

type ConnectionFilter = { mode: "entity"; entityId: string } | { mode: "tenant" };

export function ActiveConnectionsPanel({
  filter,
  hideHeader = false,
}: {
  filter: ConnectionFilter;
  /** The tenant record supplies its own section header. */
  hideHeader?: boolean;
}) {
  const { data: allKeys = [] } = useApiKeysQuery();
  const revokeKey = useRevokeApiKeyMutation();
  const [error, setError] = useState<string | null>(null);

  const mode = filter.mode;
  const entityId = filter.mode === "entity" ? filter.entityId : null;

  const keys = useMemo(
    () =>
      allKeys.filter(
        (k) => !k.revokedAt && (mode === "tenant" ? k.entityId === null : k.entityId === entityId),
      ),
    [allKeys, mode, entityId],
  );

  async function onRevoke(id: string) {
    setError(null);
    try {
      await revokeKey.mutateAsync(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke.");
    }
  }

  return (
    <div>
      {!hideHeader && (
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">Active connections</div>
      )}
      {keys.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted-2">No active connections yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between gap-3 rounded-xl border hairline px-3 py-2.5 text-[12px]"
            >
              <div className="flex min-w-0 items-center gap-2">
                <CapabilityBadge capability={k.capability} />
                <span className="truncate text-ink">{mode === "tenant" ? "Tenant-wide" : "This agent"}</span>
                <span className="shrink-0 font-mono text-[10.5px] text-muted-2">{k.id.slice(0, 8)}…</span>
              </div>
              <RevokeButton
                disabled={revokeKey.isPending}
                confirmMessage="Revoking disconnects any agent using this connection. Continue?"
                onRevoke={() => void onRevoke(k.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[11.5px] text-[#ff8a84]">{error}</p>}
    </div>
  );
}
