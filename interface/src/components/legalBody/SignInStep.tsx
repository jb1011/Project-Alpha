"use client";

import { useState } from "react";
import { WalletSignInCard } from "@/components/guardian/WalletSignInCard";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { StepNav } from "@/components/onboarding/OnboardingFlow";
import { Button, Callout, Spinner, StepHeader } from "@/components/onboarding/primitives";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import { signInStepState, type CodeRead } from "@/lib/legalBody/gates";
import { signInAttempt, type WalletAttempt } from "@/lib/walletSignIn";

const S = LEGAL_BODY_COPY.signIn;

/**
 * The legal-body flow's sign-in: the shared wallet card with this flow's own sentence, and no
 * passkey. What the step says is `signInStepState`'s answer: a smart account is a stop with no
 * Continue (the declaration needs a plain wallet signature); a session the server no longer
 * accepts asks for a new sign-in, and the refusal's own message is never shown.
 *
 * `code` is the signed-in wallet's `getCode`, read by the flow. `onEngage` tells the flow the
 * person is acting on this step, so it stays on screen through the sign-in until Continue.
 */
export function SignInStep({
  code,
  expired,
  onEngage,
  onContinue,
  onRetryCheck,
}: {
  code: CodeRead;
  expired: boolean;
  onEngage: () => void;
  onContinue: () => void;
  onRetryCheck: () => void;
}) {
  const { session, login, isLoggingIn } = useAuth();
  // The card's attempt, as it reports it: this step reads the same rule as the card's badge.
  const [attempt, setAttempt] = useState<WalletAttempt>(null);
  const [error, setError] = useState<string | null>(null);

  const state = signInStepState({ hasSession: !!session, attempt, expired, code });

  async function signInAgain() {
    onEngage();
    await signInAttempt(login, { attempt: setAttempt, error: setError });
  }

  return (
    <div>
      <StepHeader eyebrow={LEGAL_BODY_COPY.rail.labels.signin} title={S.title} intro={S.intro} />

      <div className="flex max-w-xl flex-col gap-6">
        <WalletSignInCard
          body={S.body}
          onError={setError}
          onAttempt={(next) => {
            setAttempt(next);
            onEngage();
          }}
        />

        {state === "checking" && (
          <div className="flex items-center gap-2 text-[12.5px] text-muted">
            <Spinner className="h-3.5 w-3.5" /> {S.checking}
          </div>
        )}
        {state === "check_failed" && (
          <Callout tone="warn" title={S.checkFailedTitle}>
            {S.checkFailed}
          </Callout>
        )}
        {state === "smart_account" && (
          <Callout tone="warn" title={S.smartAccountTitle}>
            {S.smartAccount}
          </Callout>
        )}
        {state === "expired" && (
          <Callout tone="warn" title={S.expiredTitle}>
            {S.expired}
          </Callout>
        )}
        {error && (
          <Callout tone="warn" title={S.errorTitle}>
            {error}
          </Callout>
        )}
      </div>

      <StepNav>
        {state === "check_failed" && (
          <Button variant="subtle" onClick={onRetryCheck}>
            {S.retry}
          </Button>
        )}
        {state === "expired" && (
          <Button onClick={() => void signInAgain()} loading={isLoggingIn}>
            {S.signInAgain}
          </Button>
        )}
        {state === "ready" && <Button onClick={onContinue}>{S.continue}</Button>}
      </StepNav>
    </div>
  );
}
