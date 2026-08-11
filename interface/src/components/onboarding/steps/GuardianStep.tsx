"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { IDKitRequestWidget, proofOfHuman, type RpContext } from "@worldcoin/idkit";
import {
  useWorldIdContextMutation,
  useWorldIdMeQuery,
  useWorldIdVerifyMutation,
} from "@/lib/api/hooks";
import { ApiError, type WorldIdContext } from "@/lib/api/types";
import { GetWorldIdHelp } from "@/components/guardian/GetWorldIdHelp";
import { PersonhoodSeal } from "@/components/guardian/PersonhoodSeal";
import { WorldErrorNote } from "@/components/guardian/WorldErrorNote";
import { useAuth } from "../AuthProvider";
import { Button, Card, CheckIcon, Spinner, StepHeader } from "../primitives";

/**
 * Proof of personhood for the account's guardian.
 *
 * The binding is account-level, not per-agent: once this human is on record every agent under
 * the wallet inherits them, so from the second agent onward this step is already satisfied and
 * just needs acknowledging. Whether it BLOCKS comes from the server (`required`), never from
 * here — the same gate guards the MCP path, and a UI-only gate would be theatre.
 */
export function GuardianStep({
  onBack,
  onComplete,
}: {
  onBack: () => void;
  onComplete: () => void;
}) {
  const { address } = useAuth();
  const { data: me = null, error: meError, refetch } = useWorldIdMeQuery();
  const worldIdContextMutation = useWorldIdContextMutation();
  const worldIdVerifyMutation = useWorldIdVerifyMutation();
  const [ctx, setCtx] = useState<WorldIdContext | null>(null);
  const [open, setOpen] = useState(false);
  const [struck, setStruck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipped = useRef(false);

  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    if (meError instanceof ApiError && meError.status === 404 && !skipped.current) {
      skipped.current = true;
      onCompleteRef.current();
    }
  }, [meError]);

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

  const verified = me?.verified ?? false;
  const required = me?.required ?? false;
  const loading = me === null && displayError === null;

  return (
    <div>
      <StepHeader
        eyebrow="Screen 2"
        title={verified ? "A human is on record." : "Who is accountable for this agent?"}
        intro={
          verified
            ? "Your agents inherit a named, verified controller. Nothing to do here — this carries over to every agent on this account."
            : "A Wyoming DAO LLC must have a real natural person behind it. World ID proves one unique human is here, without revealing who they are."
        }
      />

      <Card className="p-6">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:gap-8">
          <div className="mx-auto h-[124px] w-[124px] shrink-0 sm:mx-0">
            <PersonhoodSeal
              seed={me?.nullifier ?? address ?? "novi-corpus"}
              verified={verified}
              struck={struck}
            />
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {loading ? (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                <Spinner className="h-3.5 w-3.5" /> Checking the guardian record…
              </div>
            ) : verified ? (
              <>
                <div className="flex items-center gap-2 text-[13px] text-emerald-300">
                  <CheckIcon className="h-4 w-4" />
                  Verified human — {me?.credential ?? "proof of personhood"}
                </div>
                <p className="text-[12.5px] leading-[1.6] text-muted">
                  {me?.maxEntities != null
                    ? `You hold ${me.entitiesUsed ?? 0} of ${me.maxEntities} legal entities allowed on this account.`
                    : `You hold ${me?.entitiesUsed ?? 0} legal ${
                        (me?.entitiesUsed ?? 0) === 1 ? "entity" : "entities"
                      }. There's no limit on how many a verified human may form.`}
                </p>
              </>
            ) : (
              <>
                <ul className="flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
                  <Point>Only a unique human can stand behind an agent&apos;s legal body.</Point>
                  <Point>We store a nullifier — never your name, document, or face.</Point>
                  <Point>Verify once; every agent on this account inherits it.</Point>
                </ul>
                {required ? (
                  <p className="text-[11.5px] text-muted-2">
                    Required — an agent can&apos;t be created without a human answering for it.
                  </p>
                ) : (
                  <p className="text-[11.5px] text-muted-2">
                    Optional for now — you can verify later from the guardian page.
                  </p>
                )}
                {/* Always present in the unverified state, not only after a failure: someone
                    without World App has no other way forward now that this is enforced. */}
                <GetWorldIdHelp />
              </>
            )}

            {displayError && <WorldErrorNote error={displayError} />}
          </div>
        </div>
      </Card>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <div className="flex items-center gap-2">
          {!verified && !required && !loading && (
            <Button variant="subtle" onClick={onComplete}>
              Skip for now
            </Button>
          )}
          {verified ? (
            <Button onClick={onComplete}>Continue</Button>
          ) : (
            <Button onClick={() => void begin()} loading={busy} disabled={loading}>
              Verify with World ID
            </Button>
          )}
        </div>
      </div>

      {ctx ? (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={ctx.appId as `app_${string}`}
          action={ctx.action}
          rp_context={ctx.rpContext as RpContext}
          allow_legacy_proofs
          environment={ctx.environment}
          preset={proofOfHuman({ signal: ctx.signal })}
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
      ) : null}
    </div>
  );
}

function Point({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-2" />
      <span>{children}</span>
    </li>
  );
}

