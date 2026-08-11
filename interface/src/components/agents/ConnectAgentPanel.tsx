"use client";

import { useState } from "react";
import { useCreateConnectionPackageMutation } from "@/lib/api/hooks";
import type { Capability, ConnectionPackage, EntityView } from "@/lib/api/types";
import { ApiError } from "@/lib/api/types";
import { Button, Callout, Card } from "@/components/onboarding/primitives";
import { ActiveConnectionsPanel } from "./ActiveConnectionsPanel";
import { CapabilitySelector } from "./CapabilitySelector";
import { ConnectionSnippet } from "./ConnectionSnippet";
import { ENTITY_CAPABILITIES, ENTITY_DEFAULT_CAPABILITY } from "./capabilityCopy";

export function ConnectAgentPanel({ entity }: { entity: EntityView }) {
  const createConnection = useCreateConnectionPackageMutation();
  const [capability, setCapability] = useState<Capability>(ENTITY_DEFAULT_CAPABILITY);
  const [pkg, setPkg] = useState<ConnectionPackage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const notReady = entity.status !== "bound" && entity.status !== "funded";
  const badMcpUrl = !!pkg && /localhost|127\.0\.0\.1/.test(pkg.mcpUrl);
  const busy = createConnection.isPending;

  async function generate() {
    setError(null);
    try {
      setPkg(
        await createConnection.mutateAsync({
          entityId: entity.id,
          capability,
        }),
      );
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? "Couldn't find that agent body — reload and try again."
          : e instanceof Error
            ? e.message
            : "Failed to generate connection.",
      );
    }
  }

  return (
    <Card className="p-5">
      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">Connect your agent</div>
      <p className="mt-2 text-[12px] leading-relaxed text-muted">
        Generate a scoped connection so your MCP agent (Claude Code, Cursor, …) can operate this legal body.
      </p>

      {notReady && (
        <Callout tone="info" className="mt-4">
          This agent&apos;s legal body is still being set up — a connection generated now won&apos;t be able to
          pay or take jobs until it&apos;s bound.
        </Callout>
      )}

      {!pkg ? (
        <>
          <div className="mt-4">
            <CapabilitySelector
              options={ENTITY_CAPABILITIES}
              value={capability}
              onChange={setCapability}
              disabled={busy}
            />
          </div>
          <Button className="mt-4" onClick={() => void generate()} loading={busy} disabled={busy}>
            Generate connection
          </Button>
        </>
      ) : (
        <>
          <Callout tone="accent" className="mt-4" title="Copy your key now">
            <p className="text-[12px] text-muted">You won&apos;t see this key again. Store it somewhere safe.</p>
            <code className="mt-2 block break-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink">
              {pkg.apiKey}
            </code>
          </Callout>
          {badMcpUrl && (
            <Callout tone="warn" className="mt-3">
              Server MCP URL looks misconfigured ({pkg.mcpUrl}) — the snippet may not work.
            </Callout>
          )}
          <ConnectionSnippet snippets={pkg.snippets} />
          <Button variant="ghost" size="md" className="mt-4" onClick={() => setPkg(null)}>
            Generate a new connection
          </Button>
        </>
      )}

      {error && <p className="mt-3 text-[11.5px] text-[#ff8a84]">{error}</p>}

      <div className="mt-6 border-t hairline pt-4">
        <ActiveConnectionsPanel filter={{ mode: "entity", entityId: entity.id }} />
      </div>
    </Card>
  );
}
