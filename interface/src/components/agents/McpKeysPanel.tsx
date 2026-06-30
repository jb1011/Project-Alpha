"use client";

import * as React from "react";
import { listApiKeys, mintApiKey, revokeApiKey } from "@/lib/api/client";
import { MCP_URL } from "@/lib/api/config";
import type { ApiKeyView } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Button, Card, Callout, cx } from "@/components/onboarding/primitives";

export function McpKeysPanel() {
  const { ensureSession } = useAuth();
  const [keys, setKeys] = React.useState<ApiKeyView[]>([]);
  const [label, setLabel] = React.useState("");
  const [mintedKey, setMintedKey] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const auth = await ensureSession();
    setKeys(await listApiKeys(auth.token));
  }, [ensureSession]);

  React.useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);

  async function onMint() {
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      const res = await mintApiKey(auth.token, label.trim() || undefined);
      setMintedKey(res.key);
      setLabel("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mint API key.");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      await revokeApiKey(auth.token, id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke key.");
    } finally {
      setBusy(false);
    }
  }

  const snippet = mintedKey
    ? `{
  "mcpServers": {
    "projectAlpha": {
      "url": "${absoluteMcpUrl()}",
      "headers": {
        "Authorization": "Bearer ${mintedKey}"
      }
    }
  }
}`
    : null;

  return (
    <Card className="p-5">
      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">
        Developer / MCP access
      </div>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        Mint an API key to connect Claude, Cursor, or other MCP clients to your agents.
        Keys are account-scoped — one key works for all your agents.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Key label (optional)"
          className="min-w-[180px] flex-1 rounded-xl border hairline-strong bg-paper px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/40"
        />
        <Button onClick={() => void onMint()} loading={busy} disabled={busy}>
          Mint key
        </Button>
      </div>

      {mintedKey && (
        <Callout tone="accent" className="mt-4" title="Copy your key now">
          <p className="text-[12px] text-muted">
            You won&apos;t see this key again. Store it somewhere safe.
          </p>
          <code className="mt-2 block break-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink">
            {mintedKey}
          </code>
          <Button
            variant="ghost"
            size="md"
            className="mt-3"
            onClick={() => void navigator.clipboard.writeText(mintedKey)}
          >
            Copy key
          </Button>
        </Callout>
      )}

      {snippet && (
        <div className="mt-4">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">
            Client config snippet
          </div>
          <pre className="mt-2 overflow-x-auto rounded-xl border hairline bg-paper-2/60 p-3 text-[11px] leading-relaxed text-muted">
            {snippet}
          </pre>
          <Button
            variant="ghost"
            size="md"
            className="mt-2"
            onClick={() => void navigator.clipboard.writeText(snippet)}
          >
            Copy snippet
          </Button>
        </div>
      )}

      {keys.length > 0 && (
        <ul className="mt-5 flex flex-col gap-2 border-t hairline pt-4">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between gap-3 rounded-xl border hairline px-3 py-2.5 text-[12px]"
            >
              <div className="min-w-0">
                <div className="text-ink">{k.label ?? "Unlabeled key"}</div>
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

      {error && <p className="mt-3 text-[11.5px] text-[#ff8a84]">{error}</p>}
    </Card>
  );
}

function absoluteMcpUrl(): string {
  if (MCP_URL.startsWith("http")) return MCP_URL;
  if (typeof window !== "undefined") return `${window.location.origin}${MCP_URL}`;
  return MCP_URL;
}
