"use client";

import { useState, type ReactNode } from "react";
import {
  Button,
  Callout,
  Card,
  CheckIcon,
  FingerprintIcon,
  KeyIcon,
  ShieldIcon,
  Spinner,
  StepHeader,
  cx,
} from "../primitives";
import { useAuth } from "../AuthProvider";
import { getPasskeyChallenge } from "@/lib/api/client";
import { createGuardianPasskey } from "@/lib/api/passkey";
import type { GuardianPasskey } from "@/lib/api/types";
import { shortAddress } from "../types";

type WalletState = "idle" | "connecting" | "connected" | "logged-in" | "error";
type PasskeyState = "idle" | "pending" | "registered" | "error";

export function WelcomeStep({
  guardianPasskey,
  onPasskey,
  onComplete,
}: {
  guardianPasskey: GuardianPasskey | null;
  onPasskey: (passkey: GuardianPasskey) => void;
  onComplete: () => void;
}) {
  const {
    address,
    isConnected,
    isLoggingIn,
    connectWallet,
    login,
    session,
  } = useAuth();

  const [walletOverride, setWalletOverride] = useState<"connecting" | "error" | null>(
    null,
  );
  const [passkeyOverride, setPasskeyOverride] = useState<"pending" | "error" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const walletState: WalletState =
    walletOverride === "connecting"
      ? "connecting"
      : walletOverride === "error"
        ? "error"
        : session
          ? "logged-in"
          : isConnected
            ? "connected"
            : "idle";

  const passkeyState: PasskeyState =
    passkeyOverride === "pending"
      ? "pending"
      : passkeyOverride === "error"
        ? "error"
        : guardianPasskey
          ? "registered"
          : "idle";

  async function handleConnect() {
    setError(null);
    setWalletOverride("connecting");
    try {
      await connectWallet();
      setWalletOverride(null);
    } catch (e) {
      setWalletOverride("error");
      setError(e instanceof Error ? e.message : "Wallet connection failed.");
    }
  }

  async function handleLogin() {
    setError(null);
    setWalletOverride(null);
    try {
      await login();
    } catch (e) {
      setWalletOverride("error");
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    }
  }

  async function startPasskey() {
    setPasskeyOverride("pending");
    setError(null);
    try {
      const { challenge, rpId } = await getPasskeyChallenge();
      const passkey = await createGuardianPasskey(challenge, rpId);
      onPasskey(passkey);
      setPasskeyOverride(null);
    } catch (e) {
      setPasskeyOverride("error");
      if (e instanceof DOMException && e.name === "NotAllowedError") {
        setError("Passkey request was cancelled or denied on your device.");
      } else {
        setError(e instanceof Error ? e.message : "Passkey creation failed.");
      }
    }
  }

  const walletDone = walletState === "logged-in";
  const passkeyDone = passkeyState === "registered";

  return (
    <div>
      <StepHeader
        eyebrow="Screen 00"
        title={<>Connect your wallet and secure the vault.</>}
        intro="Sign in with your wallet — it becomes the agent's on-chain guardian. Then create a passkey as the root key for the agent's vault."
      />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_0.85fr] lg:gap-12">
        <div className="flex flex-col gap-6">
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
                {walletDone ? <CheckIcon className="h-3.5 w-3.5" /> : "1"}
              </span>
              <h3 className="text-[14px] font-medium text-ink">Connect wallet</h3>
            </div>
            <p className="mt-3 text-[12.5px] leading-[1.5] text-muted">
              The wallet you sign in with becomes the agent&apos;s guardian — the
              human who can pause, veto, or recover funds on-chain. This is a
              permanent role, not a throwaway login.
            </p>

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

          <Card className={cx("p-6", !walletDone && "opacity-60")}>
            <div className="flex items-center gap-2.5">
              <span
                className={cx(
                  "flex h-6 w-6 items-center justify-center rounded-full text-[11px]",
                  passkeyDone
                    ? "bg-accent text-paper"
                    : "border hairline-strong text-muted-2",
                )}
              >
                {passkeyDone ? <CheckIcon className="h-3.5 w-3.5" /> : "2"}
              </span>
              <h3 className="text-[14px] font-medium text-ink">Create passkey</h3>
            </div>
            <ol className="mt-4 flex flex-col gap-4">
              <MiniRow
                icon={<FingerprintIcon className="h-4 w-4" />}
                title="You tap once"
                body="Face ID, fingerprint, or your device PIN. The passkey never leaves your device."
              />
              <MiniRow
                icon={<KeyIcon className="h-4 w-4" />}
                title="Vault created at deploy"
                body="This step registers your passkey. The Turnkey sub-organization is provisioned on the backend when you confirm deployment."
              />
              <MiniRow
                icon={<ShieldIcon className="h-4 w-4" />}
                title="You hold the root"
                body="Your passkey becomes the vault's root authority."
              />
            </ol>

            <div className="mt-5">
              {passkeyDone ? (
                <span className="inline-flex items-center gap-2 text-[13px] text-accent-soft">
                  <CheckIcon className="h-4 w-4" /> Passkey ready
                </span>
              ) : (
                <Button
                  onClick={startPasskey}
                  loading={passkeyState === "pending"}
                  disabled={!walletDone || passkeyState === "pending"}
                >
                  Create vault with passkey
                </Button>
              )}
            </div>
          </Card>

          <Callout tone="accent" icon={<ShieldIcon className="h-4 w-4" />} title="Non-custodial">
            projectAlpha never holds your keys or funds. Your wallet is the guardian;
            your passkey is the vault root.
          </Callout>

          {error && (
            <Callout tone="warn" title="Something went wrong">
              {error}
            </Callout>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={onComplete} disabled={!walletDone || !passkeyDone}>
              Continue
              <CheckIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <PasskeyVisual state={passkeyState} />
      </div>
    </div>
  );
}

function MiniRow({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-3.5">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border hairline-strong bg-paper text-accent-soft">
        {icon}
      </span>
      <div>
        <div className="text-[13.5px] font-medium text-ink">{title}</div>
        <div className="mt-0.5 text-[12.5px] leading-[1.5] text-muted">{body}</div>
      </div>
    </li>
  );
}

function PasskeyVisual({ state }: { state: PasskeyState }) {
  return (
    <div className="relative flex items-center justify-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[28px] bg-gradient-to-br from-accent/15 via-transparent to-highlight/15 blur-2xl"
      />
      <Card className="relative w-full max-w-sm overflow-hidden p-7">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.16em] text-muted-2">
          <span>Device authenticator</span>
          <span
            className={cx(
              "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5",
              state === "registered"
                ? "text-accent-soft"
                : state === "error"
                  ? "text-[#ff8a84]"
                  : "text-muted-2",
            )}
          >
            <span
              className={cx(
                "h-1.5 w-1.5 rounded-full",
                state === "registered"
                  ? "bg-accent"
                  : state === "pending"
                    ? "bg-[#febc2e] animate-pulse"
                    : state === "error"
                      ? "bg-[#ff5f57]"
                      : "bg-muted-2",
              )}
            />
            {state === "registered"
              ? "Registered"
              : state === "pending"
                ? "Awaiting"
                : state === "error"
                  ? "Failed"
                  : "Ready"}
          </span>
        </div>

        <div className="my-9 flex flex-col items-center">
          <div
            className={cx(
              "relative flex h-28 w-28 items-center justify-center rounded-full border-2 transition-colors",
              state === "registered"
                ? "border-accent text-accent-soft"
                : state === "error"
                  ? "border-[#ff5f57]/50 text-[#ff8a84]"
                  : "border-line-strong text-ink",
            )}
          >
            {state === "pending" && (
              <span className="absolute inset-0 animate-ping rounded-full border-2 border-accent/40" />
            )}
            {state === "registered" ? (
              <CheckIcon className="h-12 w-12" />
            ) : (
              <FingerprintIcon className="h-14 w-14" />
            )}
          </div>
          <div className="mt-5 text-center text-[13px] text-muted">
            {state === "idle" && "Complete wallet sign-in first"}
            {state === "pending" && "Confirm on your device…"}
            {state === "registered" && "Passkey bound as vault root"}
            {state === "error" && "Authentication cancelled"}
          </div>
        </div>

        {state === "pending" ? (
          <div className="flex items-center justify-center rounded-xl border hairline-strong bg-paper px-4 py-3 text-[12px] text-muted">
            <Spinner className="mr-2 h-3.5 w-3.5" /> Waiting for passkey…
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 text-center">
            {["Turnkey vault", "WebAuthn", "Root key"].map((t) => (
              <div
                key={t}
                className="rounded-lg border hairline bg-paper/60 px-2 py-2 text-[10.5px] text-muted-2"
              >
                {t}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
