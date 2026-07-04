"use client";

import * as React from "react";
import { listApiKeys, revokeApiKey } from "@/lib/api/client";
import type { ApiKeyView } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { CapabilityBadge, RevokeButton } from "@/components/agents/connectionRow";

type ConnectionFilter = { mode: "entity"; entityId: string } | { mode: "tenant" };

export function ActiveConnectionsPanel({ filter }: { filter: ConnectionFilter }) {
  const { ensureSession } = useAuth();
  const [keys, setKeys] = React.useState<ApiKeyView[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  // Stabilize effect deps (filter is a fresh object each render).
  const mode = filter.mode;
  const entityId = filter.mode === "entity" ? filter.entityId : null;

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const auth = await ensureSession();
        const all = await listApiKeys(auth.token);
        const visible = all.filter(
          (k) => !k.revokedAt && (mode === "tenant" ? k.entityId === null : k.entityId === entityId),
        );
        if (!cancelled) setKeys(visible);
      } catch {
        /* keep the prior list on a transient failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureSession, mode, entityId, reloadKey]);

  async function onRevoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      await revokeApiKey(auth.token, id);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">Active connections</div>
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
                disabled={busy}
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
