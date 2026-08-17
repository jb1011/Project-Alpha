"use client";

import { useEffect, useState } from "react";
import { IDKitRequestWidget, identityCheck } from "@worldcoin/idkit";
import { guardianConstraints } from "@/lib/worldid";
import type { WorldIdAttestContext, WorldIdContext } from "@/lib/api/types";
import {
  useWorldIdAttestContextMutation,
  useWorldIdAttestVerifyMutation,
  useWorldIdContextMutation,
  useWorldIdMeQuery,
  useWorldIdVerifyMutation,
} from "@/lib/api/hooks";
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
  const { address } = useAuth();
  const { data: me = null, error: meError, refetch } = useWorldIdMeQuery();
  const worldIdContextMutation = useWorldIdContextMutation();
  const worldIdVerifyMutation = useWorldIdVerifyMutation();
  const worldIdAttestContextMutation = useWorldIdAttestContextMutation();
  const worldIdAttestVerifyMutation = useWorldIdAttestVerifyMutation();

  const [ctx, setCtx] = useState<WorldIdContext | null>(null);
  const [open, setOpen] = useState(false);
  const [struck, setStruck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attestCtx, setAttestCtx] = useState<WorldIdAttestContext | null>(null);
  const [attestOpen, setAttestOpen] = useState(false);

  const busy = worldIdContextMutation.isPending;
  const attestBusy = worldIdAttestContextMutation.isPending;
  const queryError =
    meError instanceof Error ? meError.message : meError ? "Could not read your guardian record." : null;
  const displayError = error ?? queryError;

  async function begin() {
    setError(null);
    try {
      setCtx(await worldIdContextMutation.mutateAsync());
      setOpen(true);
    } catch (e) {
      setError((e as Error).message || "Could not start verification.");
    }
  }

  async function handleVerify(proof: unknown) {
    await worldIdVerifyMutation.mutateAsync(proof);
  }

  async function beginAttest() {
    setError(null);
    try {
      setAttestCtx(await worldIdAttestContextMutation.mutateAsync());
      setAttestOpen(true);
    } catch (e) {
      setError((e as Error).message || "Could not start the attestation.");
    }
  }

  async function handleAttest(proof: unknown) {
    await worldIdAttestVerifyMutation.mutateAsync(proof);
  }

  useEffect(() => {
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
        loading={me === null && displayError === null}
        struck={struck}
        error={displayError}
        onVerify={() => void begin()}
        onAttest={() => void beginAttest()}
        attestBusy={attestBusy}
      />

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
          constraints={guardianConstraints(ctx.signal)}
          handleVerify={handleVerify}
          onSuccess={() => {
            setOpen(false);
            setError(null);
            setStruck(true);
            void refetch();
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

      {attestCtx ? (
        <IDKitRequestWidget
          open={attestOpen}
          onOpenChange={setAttestOpen}
          app_id={attestCtx.appId as `app_${string}`}
          action={attestCtx.action}
          // biome-ignore lint/suspicious/noExplicitAny: rp_context shape is defined by the API response.
          rp_context={attestCtx.rpContext as any}
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
            void refetch();
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
