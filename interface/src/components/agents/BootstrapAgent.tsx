"use client";

import * as React from "react";
import Link from "next/link";
import { bootstrapConnection, getPasskeyChallenge, storePasskey } from "@/lib/api/client";
import { createGuardianPasskey } from "@/lib/api/passkey";
import type { BootstrapPackage, Capability } from "@/lib/api/types";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { Button, Callout, Card, StepHeader } from "@/components/onboarding/primitives";
import { CapabilitySelector } from "./CapabilitySelector";
import { ConnectionSnippet } from "./ConnectionSnippet";
import { TENANT_CAPABILITIES, TENANT_DEFAULT_CAPABILITY } from "./capabilityCopy";

type Phase = "passkey" | "capability" | "confirm" | "generate";

function LinkCodeBox({ code }: { code: string }) {
  const [remaining, setRemaining] = React.useState(15 * 60);
  React.useEffect(() => {
    const end = Date.now() + 15 * 60_000;
    const h = setInterval(() => setRemaining(Math.max(0, Math.round((end - Date.now()) / 1000))), 1000);
    return () => clearInterval(h);
  }, []);
  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, "0");
  return (
    <div className="mt-4 rounded-xl border border-accent/30 bg-accent/[0.06] px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">One-time link code</div>
      <code className="mt-1 block break-all font-mono text-[13px] text-ink">{code}</code>
      <div className="mt-1 text-[11px] text-muted-2">
        {remaining > 0 ? `Valid for ${mm}:${ss}` : "Expired — start over to get a new code."}
      </div>
    </div>
  );
}

export function BootstrapAgent() {
  const { ensureSession } = useAuth();
  const [phase, setPhase] = React.useState<Phase>("passkey");
  const [passkeyId, setPasskeyId] = React.useState<string | null>(null);
  const [capability, setCapability] = React.useState<Capability>(TENANT_DEFAULT_CAPABILITY);
  const [pkg, setPkg] = React.useState<BootstrapPackage | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const webauthnUnavailable =
    typeof window !== "undefined" && typeof window.PublicKeyCredential === "undefined";

  async function createPasskey() {
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession();
      const { challenge, rpId } = await getPasskeyChallenge(auth.token);
      const passkey = await createGuardianPasskey(challenge, rpId);
      const { id } = await storePasskey(auth.token, passkey);
      setPasskeyId(id);
      setPhase("capability");
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotAllowedError")
        setError("Passkey request was cancelled or denied on your device.");
      else setError(e instanceof Error ? e.message : "Passkey creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (!passkeyId) return;
    setBusy(true);
    setError(null);
    try {
      const auth = await ensureSession(); // re-check: guards a stale token across the multi-step flow
      setPkg(await bootstrapConnection(auth.token, passkeyId, capability));
      setPhase("generate");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate connection.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPhase("passkey");
    setPasskeyId(null);
    setPkg(null);
    setError(null);
    setCapability(TENANT_DEFAULT_CAPABILITY);
  }

  return (
    <div>
      <StepHeader
        eyebrow="Bootstrap"
        title="Let your agent set itself up"
        intro="Create a guardian passkey and a one-time link code so your MCP agent can onboard and operate a new legal body."
      />
      <Card className="p-6">
        {phase === "passkey" &&
          (webauthnUnavailable ? (
            <Callout tone="warn">
              Passkeys aren&apos;t available in this browser. Use the web-first &ldquo;Connect your agent&rdquo;
              panel on an agent&apos;s dashboard instead.
            </Callout>
          ) : (
            <div>
              <p className="text-[13px] text-muted">
                The guardian passkey is your human approval anchor — it authorizes creating the legal body.
              </p>
              <Button className="mt-4" onClick={() => void createPasskey()} loading={busy} disabled={busy}>
                Create guardian passkey
              </Button>
            </div>
          ))}

        {phase === "capability" && (
          <div>
            <p className="text-[13px] text-muted">
              Choose what the linked agent may do. This key is <span className="text-ink">tenant-wide</span>, so
              it can act across all your legal bodies.
            </p>
            <div className="mt-4">
              <CapabilitySelector options={TENANT_CAPABILITIES} value={capability} onChange={setCapability} />
            </div>
            <div className="mt-4 flex gap-2">
              <Button variant="ghost" onClick={() => setPhase("passkey")}>
                Back
              </Button>
              <Button onClick={() => setPhase("confirm")}>Continue</Button>
            </div>
          </div>
        )}

        {phase === "confirm" && (
          <div>
            <Callout tone="warn" title="Confirm authorization">
              You&apos;re about to create a <span className="text-ink">tenant-wide</span> connection with{" "}
              <span className="text-ink">{capability}</span> power, anchored to the guardian passkey you just
              created. Any agent that receives the one-time link code can act on your legal bodies at this level.
              {capability !== "read" && (
                <div className="mt-2">
                  {capability === "provision" ? (
                    <>
                      &ldquo;provision&rdquo; also lets the agent fund treasuries from the platform and create new
                      agent legal bodies.
                    </>
                  ) : (
                    "This lets a connected agent act and pay on your behalf, within that capability's limits."
                  )}
                </div>
              )}
            </Callout>
            <div className="mt-4 flex gap-2">
              <Button variant="ghost" onClick={() => setPhase("capability")}>
                Back
              </Button>
              <Button onClick={() => void generate()} loading={busy} disabled={busy}>
                Confirm &amp; generate
              </Button>
            </div>
          </div>
        )}

        {phase === "generate" && pkg && (
          <div>
            <Callout tone="accent" title="Copy your key now">
              <p className="text-[12px] text-muted">You won&apos;t see this key again.</p>
              <code className="mt-2 block break-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink">
                {pkg.apiKey}
              </code>
            </Callout>
            <ConnectionSnippet snippets={pkg.snippets} />
            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-[0.14em] text-muted-2">
                Passkey ID (needed for onboarding)
              </div>
              <code className="mt-1 block break-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink">
                {pkg.passkeyId}
              </code>
            </div>
            <LinkCodeBox code={pkg.linkCode} />
            <ol className="mt-4 flex list-decimal flex-col gap-1.5 pl-5 text-[12px] text-muted">
              <li>Paste the MCP config above into your agent.</li>
              <li>
                Ask your agent to run <code className="text-ink">claim_connection</code> with the link code — it
                returns <code className="text-ink">bound: true</code>.
              </li>
              <li>
                Ask it to run <code className="text-ink">onboard_agent</code> with{" "}
                <code className="text-ink">passkeyId: {pkg.passkeyId}</code> to create the legal body.
              </li>
              <li>
                Poll <code className="text-ink">get_entity</code> until status is{" "}
                <code className="text-ink">bound</code>.
              </li>
            </ol>
            <Button variant="ghost" size="md" className="mt-4" onClick={reset}>
              Start over
            </Button>
          </div>
        )}

        {error && <p className="mt-3 text-[11.5px] text-[#ff8a84]">{error}</p>}
      </Card>

      <div className="mt-6">
        <Link
          href="/agents/account"
          className="text-[12px] text-accent underline-offset-2 hover:underline"
        >
          Manage connections & passkeys → Account
        </Link>
      </div>
    </div>
  );
}
