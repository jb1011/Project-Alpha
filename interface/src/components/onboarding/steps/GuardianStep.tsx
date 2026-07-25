"use client";

import { IDKitRequestWidget, proofOfHuman } from "@worldcoin/idkit";
import { useCallback, useEffect, useRef, useState } from "react";
import { worldIdContext, worldIdMe, worldIdVerify } from "@/lib/api/client";
import { ApiError, type WorldIdContext, type WorldIdMe } from "@/lib/api/types";
import { PersonhoodSeal } from "@/components/guardian/PersonhoodSeal";
import { useAuth } from "../AuthProvider";
import { Button, Callout, Card, CheckIcon, Spinner, StepHeader } from "../primitives";

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
  const { ensureSession, address } = useAuth();
  const [me, setMe] = useState<WorldIdMe | null>(null);
  const [ctx, setCtx] = useState<WorldIdContext | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [struck, setStruck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skipped = useRef(false);

  // The parent passes a fresh arrow every render; holding it in a ref keeps `refresh` stable so
  // the mount effect doesn't re-fire on every render and poll the API forever.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  const refresh = useCallback(async () => {
    try {
      const s = await ensureSession();
      setMe(await worldIdMe(s.token));
    } catch (e) {
      // World isn't configured on this deployment — this step has nothing to ask for.
      if (e instanceof ApiError && e.status === 404) {
        if (!skipped.current) {
          skipped.current = true;
          onCompleteRef.current();
        }
        return;
      }
      setError((e as Error).message || "Could not check the guardian record.");
    }
  }, [ensureSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const begin = useCallback(async () => {
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

  const handleVerify = useCallback(
    async (proof: unknown) => {
      const s = await ensureSession();
      await worldIdVerify(s.token, proof);
    },
    [ensureSession],
  );

  const verified = me?.verified ?? false;
  const required = me?.required ?? false;
  const loading = me === null && error === null;

  return (
    <div>
      <StepHeader
        eyebrow="01"
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
                {me?.maxEntities != null && (
                  <p className="text-[12.5px] leading-[1.6] text-muted">
                    You hold {me.entitiesUsed ?? 0} of {me.maxEntities} legal entities. One person,
                    a capped number of companies.
                  </p>
                )}
              </>
            ) : (
              <>
                <ul className="flex flex-col gap-2 text-[12.5px] leading-[1.6] text-muted">
                  <Point>Only a unique human can stand behind an agent's legal body.</Point>
                  <Point>We store a nullifier — never your name, document, or face.</Point>
                  <Point>Verify once; every agent on this account inherits it.</Point>
                </ul>
                {!required && (
                  <p className="text-[11.5px] text-muted-2">
                    Optional for now — you can verify later from the guardian page.
                  </p>
                )}
              </>
            )}

            {error && <ErrorNote error={error} />}
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
            const code = typeof e === "string" ? e : ((e as { code?: string })?.code ?? String(e));
            setOpen(false);
            setError(`world:${code}`);
          }}
        />
      ) : null}
    </div>
  );
}

function Point({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted-2" />
      <span>{children}</span>
    </li>
  );
}

function ErrorNote({ error }: { error: string }) {
  const code = error.startsWith("world:") ? error.slice(6) : "";
  if (code === "max_verifications_reached")
    return (
      <Callout tone="warn" title="World has already verified you for this action">
        You are a real, unique human — World just won&apos;t issue a second proof for it.
      </Callout>
    );
  if (code === "user_rejected" || code === "verification_rejected")
    return (
      <Callout tone="warn" title="Verification cancelled">
        Nothing was recorded. Start again whenever you&apos;re ready.
      </Callout>
    );
  if (code === "credential_unavailable")
    return (
      <Callout tone="warn" title="Orb credential required">
        Guardianship needs an Orb or document-grade credential. A device-only World ID isn&apos;t
        enough to be legally accountable for an agent.
      </Callout>
    );
  if (error.toLowerCase().includes("already the guardian"))
    return (
      <Callout tone="warn" title="This human already backs another account">
        One person cannot quietly hold two separate guardianships.
      </Callout>
    );
  return (
    <Callout tone="warn" title="Not verified">
      {code || error}
    </Callout>
  );
}
