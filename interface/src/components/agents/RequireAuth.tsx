"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Callout, Card, Spinner } from "@/components/onboarding/primitives";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { authPanelState } from "./authPanel";
import { shortenErr } from "@/lib/errors";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, isConnected, isConnecting, isLoggingIn, connectWallet, login } =
    useAuth();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Session lives in sessionStorage; the server always sees "logged out". Wait for the
  // client snapshot before branching, or React throws a hydration mismatch on /guardian,
  // /agents, etc. when a session already exists.
  useEffect(() => {
    setReady(true);
  }, []);

  const panel = authPanelState({ isConnected, isConnecting, isLoggingIn });

  // Every rejection on this surface used to be discarded by `void connectWallet()`: a rejected
  // request, a locked wallet, a wallet already mid-connect (-32002), a SIWE verify that failed —
  // all of them left the button exactly as it was and printed an unhandled rejection to a console
  // nobody had open. The wizard's own connect has always caught and shown these
  // (`WelcomeStep.handleConnect`), which is why the same wallet appeared to work there and to be
  // dead here.
  const run = useCallback(
    async (action: () => Promise<void>, fallback: string) => {
      setError(null);
      try {
        await action();
      } catch (e) {
        setError(e instanceof Error ? shortenErr(e.message) : fallback);
      }
    },
    [],
  );

  if (!ready) {
    return <LoadingState />;
  }

  if (session) return <>{children}</>;

  return (
    <div className="mx-auto max-w-md px-5 py-24">
      <Card className="p-6 text-center">
        <h1 className="text-[22px] font-medium text-ink">Sign in to continue</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Connect the guardian wallet you used when creating your agents.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Button
            onClick={() =>
              void (panel.action === "connect"
                ? run(connectWallet, "Wallet connection failed.")
                : run(login, "Sign-in failed."))
            }
            loading={panel.pending}
          >
            {panel.label}
          </Button>
          {error ? (
            <Callout tone="warn" title="Something went wrong" className="text-left">
              {error}
            </Callout>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-24 text-[13px] text-muted">
      <Spinner className="h-4 w-4 text-accent-soft" />
      {label}
    </div>
  );
}
