"use client";

import * as React from "react";
import { listPasskeys, revokePasskey } from "@/lib/api/client";
import type { PasskeyView } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { RevokeButton } from "@/components/agents/connectionRow";

export function GuardianPasskeysPanel() {
  const { ensureSession } = useAuth();
  const [passkeys, setPasskeys] = React.useState<PasskeyView[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadKey, setReloadKey] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const auth = await ensureSession();
        const list = await listPasskeys(auth.token);
        if (!cancelled) setPasskeys(list.filter((p) => !p.revokedAt));
      } catch {
        /* keep the prior list on a transient failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureSession, reloadKey]);

  async function onRevoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      await revokePasskey(auth.token, id);
      setReloadKey((k) => k + 1); // re-trigger the load effect
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">Guardian passkeys</div>
      {passkeys.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted-2">No guardian passkeys yet.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {passkeys.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-xl border hairline px-3 py-2.5 text-[12px]"
            >
              <div className="min-w-0">
                <div className="truncate text-ink">{p.name ?? "Guardian passkey"}</div>
                <div className="font-mono text-[10.5px] text-muted-2">{p.id.slice(0, 8)}…</div>
              </div>
              <RevokeButton
                disabled={busy}
                confirmMessage="Revoking stops this passkey from creating new agents. Existing agents are unaffected. Continue?"
                onRevoke={() => void onRevoke(p.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-2 text-[11.5px] text-[#ff8a84]">{error}</p>}
    </div>
  );
}
