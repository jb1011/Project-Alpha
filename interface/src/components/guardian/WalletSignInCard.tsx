"use client";

import { useState, type ReactNode } from "react";
import { Button, Card, CheckIcon, cx } from "@/components/onboarding/primitives";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { shortAddress } from "@/components/onboarding/types";
import {
  connectAttempt,
  signInAttempt,
  walletStateOf,
  type WalletAttempt,
} from "@/lib/walletSignIn";

/**
 * The wallet sign-in card: connect a wallet, then sign in with it.
 *
 * It carries its own wallet state machine, so any flow that needs a signed-in guardian renders the
 * same card and gets the same behaviour. What the wallet becomes is the caller's sentence
 * (`body`).
 *
 * `onAttempt` receives every change of the attempt (`connecting`, `error`, or `null` when none is
 * under way or failed). A caller that gates on sign-in keeps it and reads
 * `walletSignedIn(!!session, attempt)`, the same rule as the card's badge. `onError` receives the
 * message of a failed connect or sign-in, and `null` when a new attempt starts, so a message from
 * an earlier attempt does not outlive it.
 */
export function WalletSignInCard({
  number = "1",
  body,
  onError,
  onAttempt,
}: {
  /** What the badge shows before sign-in; a check replaces it once signed in. */
  number?: ReactNode;
  body: ReactNode;
  onError?: (message: string | null) => void;
  onAttempt?: (attempt: WalletAttempt) => void;
}) {
  const { address, isConnected, isLoggingIn, connectWallet, login, session } = useAuth();

  const [walletOverride, setWalletOverride] = useState<WalletAttempt>(null);

  const walletState = walletStateOf(walletOverride, !!session, isConnected);

  // Every change of the attempt goes to the caller too, in the same event: no effect mirrors it.
  const report = {
    attempt(next: WalletAttempt) {
      setWalletOverride(next);
      onAttempt?.(next);
    },
    error(message: string | null) {
      onError?.(message);
    },
  };

  async function handleConnect() {
    await connectAttempt(connectWallet, report);
  }

  async function handleLogin() {
    await signInAttempt(login, report);
  }

  const walletDone = walletState === "logged-in";

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2.5">
        <span
          className={cx(
            "flex h-6 w-6 items-center justify-center rounded-full text-[11px]",
            walletDone
              ? "bg-accent text-paper"
              : "border hairline-strong text-muted-2",
          )}
        >
          {walletDone ? <CheckIcon className="h-3.5 w-3.5" /> : number}
        </span>
        <h3 className="text-[14px] font-medium text-ink">Connect wallet</h3>
      </div>
      <p className="mt-3 text-[12.5px] leading-[1.5] text-muted">{body}</p>

      {address && (
        <div className="mt-4 rounded-xl border hairline bg-paper px-4 py-3 font-mono text-[12.5px] text-ink">
          {shortAddress(address)}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        {!isConnected ? (
          <Button onClick={handleConnect} loading={walletState === "connecting"}>
            Connect wallet
          </Button>
        ) : !session ? (
          <Button onClick={handleLogin} loading={isLoggingIn}>
            Sign in with wallet
          </Button>
        ) : (
          <span className="inline-flex items-center gap-2 text-[13px] text-accent-soft">
            <CheckIcon className="h-4 w-4" /> Signed in
          </span>
        )}
      </div>
    </Card>
  );
}
