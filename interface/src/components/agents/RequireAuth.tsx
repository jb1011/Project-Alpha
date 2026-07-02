"use client";

import type { ReactNode } from "react";
import { Button, Card, Spinner } from "@/components/onboarding/primitives";
import { useAuth } from "@/components/onboarding/AuthProvider";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, isConnected, isLoggingIn, connectWallet, login } = useAuth();

  if (session) return <>{children}</>;

  return (
    <div className="mx-auto max-w-md px-5 py-24">
      <Card className="p-6 text-center">
        <h1 className="text-[22px] font-medium text-ink">Sign in to continue</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          Connect the guardian wallet you used when creating your agents.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          {!isConnected ? (
            <Button onClick={() => void connectWallet()} loading={isLoggingIn}>
              Connect wallet
            </Button>
          ) : (
            <Button onClick={() => void login()} loading={isLoggingIn}>
              Sign in with wallet
            </Button>
          )}
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
