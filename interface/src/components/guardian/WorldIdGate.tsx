"use client";

import { useState, type ReactNode } from "react";
import { IDKitRequestWidget, type RpContext } from "@worldcoin/idkit";
import { guardianConstraints } from "@/lib/worldid";
import {
  useWorldIdContextMutation,
  useWorldIdMeQuery,
  useWorldIdVerifyMutation,
} from "@/lib/api/hooks";
import { ApiError, type WorldIdContext, type WorldIdMe } from "@/lib/api/types";
import {
  worldIdGateState,
  worldIdMeStatus,
  type WorldIdGateState,
} from "@/lib/legalBody/worldIdGate";
import { CheckIcon, cx } from "@/components/onboarding/primitives";

/**
 * The guardian's World ID record and the way to put one on it, for any flow that asks for a
 * person: the record's query, the World ID widget, and the gate's state for this flow's rule.
 *
 * Whether the step BLOCKS comes from the server (`me.required`) or from the flow
 * (`forceRequired`), never from a screen alone; what counts as accepted is decided by
 * `worldIdGateState`. The widget is an element the screen places; it mounts once a context
 * exists, and a successful verification refetches the record. `struck` turns true the moment a
 * verification lands, for the seal's one-shot animation.
 */
export function useWorldIdGate({
  requireRealHuman = false,
  forceRequired = false,
}: {
  requireRealHuman?: boolean;
  forceRequired?: boolean;
}): {
  state: WorldIdGateState;
  me: WorldIdMe | null;
  begin(): Promise<void>;
  busy: boolean;
  error: string | null;
  widget: ReactNode;
  refetch(): void;
  struck: boolean;
} {
  const { data: me = null, error: meError, refetch } = useWorldIdMeQuery();
  const worldIdContextMutation = useWorldIdContextMutation();
  const worldIdVerifyMutation = useWorldIdVerifyMutation();
  const [ctx, setCtx] = useState<WorldIdContext | null>(null);
  const [open, setOpen] = useState(false);
  const [struck, setStruck] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const queryError =
    meError instanceof ApiError && meError.status === 404
      ? null
      : meError instanceof Error
        ? meError.message
        : meError
          ? "Could not check the guardian record."
          : null;
  const displayError = error ?? queryError;

  const busy = worldIdContextMutation.isPending;

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

  const state = worldIdGateState({
    me,
    meStatus: worldIdMeStatus(me, meError),
    requireRealHuman,
    forceRequired,
  });

  const widget = ctx ? (
    <IDKitRequestWidget
      open={open}
      onOpenChange={setOpen}
      app_id={ctx.appId as `app_${string}`}
      action={ctx.action}
      rp_context={ctx.rpContext as RpContext}
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
        const code = typeof e === "string" ? e : ((e as { code?: string })?.code ?? String(e));
        setOpen(false);
        setError(`world:${code}`);
      }}
    />
  ) : null;

  return {
    state,
    me,
    begin,
    busy,
    error: displayError,
    widget,
    refetch: () => {
      void refetch();
    },
    struck,
  };
}

/**
 * The line that says what is on record: the check icon and one sentence. Emerald for a row the
 * gate accepts; amber for a waiver, accepted or not, and for any row the gate does not accept.
 * A flow that refuses rows (`requireRealHuman`) passes its own `notAcceptedSentence`; without
 * one, a refused row reads as the record it is, in amber. Renders nothing when there is no row.
 */
export function WorldIdStatusRow({
  state,
  waiverSentence = "Guardian waiver on record — not a verified human",
  notAcceptedSentence,
}: {
  state: WorldIdGateState;
  waiverSentence?: string;
  notAcceptedSentence?: string;
}) {
  if (state.kind !== "accepted" && state.kind !== "not_accepted") return <></>;

  const waiver = state.credential === "waiver";
  const recordLine = waiver
    ? waiverSentence
    : `Verified human — ${state.credential ?? "proof of personhood"}`;
  const notAccepted = state.kind === "not_accepted";

  return (
    <div
      className={cx(
        "flex items-center gap-2 text-[13px]",
        waiver || notAccepted ? "text-amber-300" : "text-emerald-300",
      )}
    >
      <CheckIcon className="h-4 w-4" />
      {notAccepted ? (notAcceptedSentence ?? recordLine) : recordLine}
    </div>
  );
}
