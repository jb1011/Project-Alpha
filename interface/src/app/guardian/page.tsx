"use client";

import * as React from "react";
import {
  IDKitRequestWidget,
  identityCheck,
  proofOfHuman,
} from "@worldcoin/idkit";
import {
  worldIdAttestContext,
  worldIdAttestVerify,
  worldIdContext,
  worldIdMe,
  worldIdVerify,
} from "@/lib/api/client";
import type {
  WorldIdAttestContext,
  WorldIdContext,
  WorldIdMe,
} from "@/lib/api/types";
import { AgentShell } from "@/components/agents/AgentShell";
import { RequireAuth } from "@/components/agents/RequireAuth";
import { GuardianRecord } from "@/components/guardian/GuardianRecord";
import { useAuth } from "@/components/onboarding/AuthProvider";

export default function GuardianPage() {
  return (
    <RequireAuth>
      <GuardianVerification />
    </RequireAuth>
  );
}

function GuardianVerification() {
  const { ensureSession, address } = useAuth();
  const [me, setMe] = React.useState<WorldIdMe | null>(null);
  const [ctx, setCtx] = React.useState<WorldIdContext | null>(null);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [struck, setStruck] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [attestCtx, setAttestCtx] = React.useState<WorldIdAttestContext | null>(
    null,
  );
  const [attestOpen, setAttestOpen] = React.useState(false);
  const [attestBusy, setAttestBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      const s = await ensureSession();
      setMe(await worldIdMe(s.token));
    } catch (e) {
      setError((e as Error).message || "Could not read your guardian record.");
    }
  }, [ensureSession]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Fetch the signed request context, then open World's widget.
  const begin = React.useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const s = await ensureSession();
      setCtx(await worldIdContext(s.token));
      setOpen(true);
    } catch (e) {
      setError((e as Error).message || "Could not start verification.");
    } finally {
      setBusy(false);
    }
  }, [ensureSession]);

  // The widget hands us the proof; our backend verifies it and applies the sybil gate.
  const handleVerify = React.useCallback(
    async (proof: unknown) => {
      const s = await ensureSession();
      await worldIdVerify(s.token, proof); // throwing here makes the widget show the failure
    },
    [ensureSession],
  );

  // Step-up: its own action, so its own signed context and its own widget instance.
  const beginAttest = React.useCallback(async () => {
    setError(null);
    setAttestBusy(true);
    try {
      const s = await ensureSession();
      setAttestCtx(await worldIdAttestContext(s.token));
      setAttestOpen(true);
    } catch (e) {
      setError((e as Error).message || "Could not start the attestation.");
    } finally {
      setAttestBusy(false);
    }
  }, [ensureSession]);

  const handleAttest = React.useCallback(
    async (proof: unknown) => {
      const s = await ensureSession();
      await worldIdAttestVerify(s.token, proof);
    },
    [ensureSession],
  );

  // The strike plays once, when a verification lands — not on every render of a verified page.
  React.useEffect(() => {
    if (!struck) return;
    const t = setTimeout(() => setStruck(false), 2400);
    return () => clearTimeout(t);
  }, [struck]);

  return (
    <AgentShell>
      <GuardianRecord
        me={me}
        address={address}
        busy={busy}
        loading={me === null && error === null}
        struck={struck}
        error={error}
        onVerify={() => void begin()}
        onAttest={() => void beginAttest()}
        attestBusy={attestBusy}
      />

      {/* World's own widget handles the QR, deep links and device handoff. */}
      {ctx ? (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={ctx.appId as `app_${string}`}
          action={ctx.action}
          // biome-ignore lint/suspicious/noExplicitAny: rp_context shape is defined by the API response.
          rp_context={ctx.rpContext as any}
          allow_legacy_proofs
          environment={ctx.environment}
          preset={proofOfHuman({ signal: ctx.signal })}
          handleVerify={handleVerify}
          onSuccess={() => {
            setOpen(false);
            setError(null);
            setStruck(true);
            void refresh();
          }}
          onError={(e: unknown) => {
            const code =
              typeof e === "string"
                ? e
                : ((e as { code?: string })?.code ?? String(e));
            setOpen(false);
            setError(`world:${code}`);
          }}
        />
      ) : null}

      {/* Step-up widget. Age only: World's attributes are assertions, so a country could be
          checked but never learned — see verifyAttestation for the full finding. */}
      {attestCtx ? (
        <IDKitRequestWidget
          open={attestOpen}
          onOpenChange={setAttestOpen}
          app_id={attestCtx.appId as `app_${string}`}
          action={attestCtx.action}
          // biome-ignore lint/suspicious/noExplicitAny: rp_context shape is defined by the API response.
          rp_context={attestCtx.rpContext as any}
          // Identity Check is v4-only; legacy proofs can't carry attributes.
          allow_legacy_proofs={false}
          environment={attestCtx.environment}
          preset={identityCheck({
            attributes: [{ type: "minimum_age", value: attestCtx.minAge }],
            legacy_signal: attestCtx.signal,
          })}
          handleVerify={handleAttest}
          onSuccess={() => {
            setAttestOpen(false);
            setError(null);
            void refresh();
          }}
          onError={(e: unknown) => {
            const code =
              typeof e === "string"
                ? e
                : ((e as { code?: string })?.code ?? String(e));
            setAttestOpen(false);
            setError(`world:${code}`);
          }}
        />
      ) : null}
    </AgentShell>
  );
}
