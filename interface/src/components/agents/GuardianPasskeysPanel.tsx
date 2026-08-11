"use client";

import { useMemo, useState } from "react";
import { usePasskeysQuery, useRevokePasskeyMutation } from "@/lib/api/hooks";
import { RevokeButton } from "@/components/agents/connectionRow";

export function GuardianPasskeysPanel({ hideHeader = false }: { hideHeader?: boolean } = {}) {
  const { data: allPasskeys = [] } = usePasskeysQuery();
  const revokePasskey = useRevokePasskeyMutation();
  const [error, setError] = useState<string | null>(null);

  const passkeys = useMemo(
    () => allPasskeys.filter((p) => !p.revokedAt),
    [allPasskeys],
  );

  async function onRevoke(id: string) {
    setError(null);
    try {
      await revokePasskey.mutateAsync(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke.");
    }
  }

  return (
    <div>
      {!hideHeader && (
        <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">Guardian passkeys</div>
      )}
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
                disabled={revokePasskey.isPending}
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
