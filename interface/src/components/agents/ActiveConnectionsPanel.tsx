"use client";

import * as React from "react";
import { listApiKeys, revokeApiKey } from "@/lib/api/client";
import type { ApiKeyView } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { cx } from "@/components/onboarding/primitives";

// Note: the prod DB was deployed fresh, so there are no pre-BYOA API keys;
// every listed key is a `connect:`/`bootstrap:` connection. The unfiltered variant
// (on `/agents/connect`) still lists any key for full revocability.
export function ActiveConnectionsPanel({ entityId }: { entityId?: string }) {
  const { ensureSession } = useAuth();
  const [keys, setKeys] = React.useState<ApiKeyView[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const auth = await ensureSession();
        const all = await listApiKeys(auth.token);
        if (!cancelled)
          setKeys(entityId ? all.filter((k) => (k.label ?? "") === `connect:${entityId}`) : all);
      } catch {
        /* keep the prior list on a transient failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureSession, entityId, reloadKey]);

  async function onRevoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      await revokeApiKey(auth.token, id);
      setReloadKey((k) => k + 1); // re-trigger the load effect
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
              <div className="min-w-0">
                <div className="truncate text-ink">{k.label ?? "Unlabeled"}</div>
                <div className="font-mono text-[10.5px] text-muted-2">{k.id.slice(0, 8)}…</div>
              </div>
              <button
                type="button"
                disabled={busy || !!k.revokedAt}
                onClick={() => void onRevoke(k.id)}
                className={cx(
                  "shrink-0 text-[11.5px] underline-offset-2 hover:underline",
                  k.revokedAt ? "text-muted-2" : "text-[#ff8a84]",
                )}
              >
                {k.revokedAt ? "Revoked" : "Revoke"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[11.5px] text-[#ff8a84]">{error}</p>}
    </div>
  );
}
