"use client";

import { useState } from "react";
import { AgentConfig, formatUsdc } from "../types";
import { StepNav } from "../OnboardingFlow";
import { useAuth } from "../AuthProvider";
import { useOnboardEntityMutation, usePublicConfigQuery } from "@/lib/api/hooks";
import { configToAgentSpec } from "@/lib/api/spec";
import type { GuardianPasskey } from "@/lib/api/types";
import {
  Button,
  Callout,
  Card,
  CheckIcon,
  Spinner,
  StepHeader,
  cx,
} from "../primitives";

type Props = {
  /** "Screen N" — counted over the phases THIS deployment shows. */
  eyebrow: string;
  config: AgentConfig;
  guardianPasskey: GuardianPasskey | null;
  idempotencyKey: string | null;
  /** The opaque formation-party handle, when the legal-identity step produced one. Never the
   *  identity — that is gone from this browser by the time the wizard reaches here. */
  partyId: string | null;
  /** Whether that handle is the labeled sandbox fixture. Amber, never green. */
  partySynthetic: boolean;
  onBack: () => void;
  onSubmitted: (entityId: string, idempotencyKey: string) => void;
};

export function AgreementStep({
  eyebrow,
  config,
  guardianPasskey,
  idempotencyKey,
  partyId,
  partySynthetic,
  onBack,
  onSubmitted,
}: Props) {
  const { address } = useAuth();
  const { data: publicConfig } = usePublicConfigQuery();
  const onboardEntity = useOnboardEntityMutation();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = onboardEntity.isPending;

  // "Formation applies to THIS agent" is the handle, not the deployment: a deployment that can
  // form entities still onboards agents that asked for no filing.
  const forming = partyId !== null;
  const sandbox = partySynthetic || publicConfig?.formationEnvironment !== "production";

  async function submit() {
    if (!guardianPasskey || !address) {
      setError("Complete wallet sign-in and passkey setup first.");
      return;
    }
    setError(null);
    try {
      const key =
        idempotencyKey ??
        (typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `pa-${Date.now()}`);
      const spec = configToAgentSpec(config, address);
      const { id } = await onboardEntity.mutateAsync({
        spec,
        guardianPasskey,
        idempotencyKey: key,
        custody: config.custody,
        // The HANDLE, never the identity: `spec` is persisted verbatim by the backend, and PII
        // that entered it would land in a column every read path touches.
        partyId: partyId ?? undefined,
      });
      onSubmitted(id, key);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onboarding submission failed.");
    }
  }

  return (
    <div>
      <StepHeader
        eyebrow={eyebrow}
        title="Review what gets anchored"
        intro="Confirming publishes one hash on Arc. This is what that hash commits to, and what it does not."
      />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px] lg:gap-10">
        <div className="flex min-w-0 flex-col gap-5">
          <AnchorExplainer config={config} forming={forming} />
          <FormationNote forming={forming} sandbox={sandbox} />
        </div>

        <div className="flex flex-col gap-5 lg:sticky lg:top-24 lg:self-start">
          <Card className="p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">
              Machine terms
            </div>
            <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-2">
              The rules the contracts actually enforce. These are hashed into the anchor.
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {keyClauses(config).map((c) => (
                <li key={c.title} className="flex gap-2.5">
                  <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-soft" />
                  <div>
                    <div className="text-[12.5px] font-medium text-ink">{c.title}</div>
                    <div className="text-[11.5px] leading-[1.45] text-muted-2">{c.body}</div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">
              On submit
            </div>
            <p className="mt-3 text-[12px] leading-[1.5] text-muted">
              The backend writes the terms document, registers identity on Arc, deploys the
              contracts, binds the agent wallet, and anchors version 1 of the manifest. This takes
              a few minutes.
              {forming && " The filing runs after that, on its own clock."}
            </p>
          </Card>
        </div>
      </div>

      <Callout tone="warn" className="mt-7" title="Human decision point">
        These rules bind a real on-chain treasury and, once anchored, are what the entity&apos;s
        record commits to. Read them, then confirm.
      </Callout>

      <label className="mt-5 flex cursor-pointer items-start gap-3 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className={cx(
            "mt-0.5 h-4 w-4 shrink-0 rounded border bg-paper-2 accent-[var(--accent)]",
          )}
        />
        <span className="text-muted">
          I&apos;ve reviewed what will be anchored and I confirm these rules for{" "}
          {config.name || "my agent"}.
        </span>
      </label>

      {error && (
        <Callout tone="warn" className="mt-4" title="Submission failed">
          {error}
        </Callout>
      )}

      <StepNav onBack={onBack}>
        <Button
          onClick={submit}
          disabled={!confirmed || submitting}
          loading={submitting}
        >
          {submitting ? "Submitting…" : "Confirm & deploy"}
          {!submitting && <CheckIcon className="h-4 w-4" />}
        </Button>
      </StepNav>

      {submitting && (
        <Card className="mt-4 flex items-center gap-3 p-4 text-[12.5px] text-muted">
          <Spinner className="h-4 w-4 text-accent-soft" />
          Starting onboarding on the backend…
        </Card>
      )}
    </div>
  );
}

function keyClauses(config: AgentConfig) {
  return [
    {
      title: "Member-managed by an agent",
      body: "The agent acts within a bounded mandate; the human is the guardian member.",
    },
    {
      title: `Spending mandate — ${formatUsdc(config.perTxCap)} / tx`,
      body: `Daily ceiling of ${formatUsdc(config.dailyCap)} USDC, enforced on-chain.`,
    },
    {
      title:
        config.allowlist.length > 0
          ? `Allowlist of ${config.allowlist.length} recipient(s)`
          : "Open recipients within caps",
      body:
        config.allowlist.length > 0
          ? "Transfers restricted to named, approved counterparties."
          : "No recipient restriction beyond the spending caps.",
    },
    {
      title: `Guardian timelock — ${config.timelockHours || "1"}h`,
      body: "Sensitive actions are held, giving the guardian time to veto.",
    },
    {
      title:
        config.custody === "circle"
          ? "Novi-managed operator keys"
          : "Passkey-rooted operator keys",
      body:
        config.custody === "circle"
          ? "Operator keys are platform-managed (Circle MPC); the guardian keeps every on-chain override."
          : "The guardian's passkey is the root authority over the agent's key vault.",
    },
  ];
}

/* ------------------------------------------------------------------ */

/**
 * What the on-chain anchor actually commits to.
 *
 * This screen used to render a long-form "OPERATING AGREEMENT OF … DAO LLC" assembled in the
 * browser, with articles and a witness clause, downloadable as a .txt. Nothing signed it, nothing
 * filed it, no lawyer wrote it, and the hash that went on-chain did not commit to it. It looked
 * like the legal document while being the one thing on the page that was not real — the exact
 * fabrication class the frontend audit found on the landing page.
 *
 * What replaces it is smaller and true: the scheme, the contents, and where the REAL document
 * comes from.
 */
function AnchorExplainer({ config, forming }: { config: AgentConfig; forming: boolean }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b hairline px-5 py-3">
        <span className="text-[12px] text-muted-2">
          OA bundle anchor — {config.name || "Agent"} DAO LLC
        </span>
        <span className="text-[11px] uppercase tracking-[0.14em] text-muted-2">version 1</span>
      </div>
      <div className="px-6 py-5 text-[12.5px] leading-[1.7] text-muted">
        <p>
          The backend assembles a JSON <strong className="font-medium text-ink">manifest</strong>,
          canonicalises it (RFC 8785) and hashes it with keccak256. That single hash — and nothing
          else — is written to your entity&apos;s LegalManager contract on Arc. Anyone holding only
          the chain can fetch the published manifest and recompute it.
        </p>

        <div className="mt-5 text-[11px] uppercase tracking-[0.18em] text-muted-2">
          The manifest commits to
        </div>
        <ul className="mt-3 flex flex-col gap-2.5">
          <Committed
            title="The machine terms"
            body="The caps, period, allowlist, timelock and custody in the panel beside this one, as a terms document with its own hash."
          />
          <Committed
            title="This chain and this agent"
            body="Chain id, the LegalManager address and the agent id — so an anchor from another deployment can never be mistaken for yours."
          />
          <Committed
            title="The entity"
            body="Name, jurisdiction and public id."
          />
          <Committed
            title={forming ? "The legal filing, once it exists" : "The legal filing — not applicable"}
            body={
              forming
                ? "Provider, environment, entity type, state, formation date, filing number, EIN, and the sha256 of every document the filing produces. Each new fact is a new manifest version."
                : "No filing was requested for this agent, so the manifest's legal block stays empty and the anchor commits to the terms alone."
            }
          />
        </ul>

        <p className="mt-5 border-t hairline pt-4 text-[12px] leading-[1.6] text-muted-2">
          Every later version is <strong className="font-medium text-muted">scheduled</strong>{" "}
          through your guardian timelock before it can replace this one, and you can veto it from
          the agent&apos;s Settings page while it waits. The platform cannot change what your
          entity commits to without giving you that window.
        </p>
      </div>
    </Card>
  );
}

function Committed({ title, body }: { title: string; body: string }) {
  return (
    <li className="flex gap-2.5">
      <CheckIcon className="mt-1 h-3.5 w-3.5 shrink-0 text-accent-soft" />
      <div>
        <div className="text-[12.5px] font-medium text-ink">{title}</div>
        <div className="text-[11.5px] leading-[1.5] text-muted-2">{body}</div>
      </div>
    </li>
  );
}

/**
 * Where the REAL Operating Agreement comes from — and, in sandbox, that it is a demo.
 *
 * Amber for sandbox, never green: a demo filing must read as a demo on every surface that shows
 * it (the guardian-waiver precedent).
 */
function FormationNote({ forming, sandbox }: { forming: boolean; sandbox: boolean }) {
  if (!forming) {
    return (
      <Callout tone="info" title="No legal filing for this agent">
        Nothing is filed with any state and no Operating Agreement document is produced. The agent
        gets its contracts, its treasury and its anchor; the legal body is not part of it.
      </Callout>
    );
  }
  return (
    <Callout
      tone={sandbox ? "warn" : "accent"}
      title={sandbox ? "Demo formation (sandbox)" : "The real Operating Agreement arrives after filing"}
    >
      {sandbox ? (
        <>
          Nothing is filed with the State of Wyoming and no company legally exists. doola&apos;s
          sandbox returns DEMO documents — including a demo Operating Agreement — after the demo
          filing. They appear in your dashboard under Legal documents, labeled sandbox, and their
          hashes go into the next manifest version exactly as real ones would.
        </>
      ) : (
        <>
          doola files the company and generates the Operating Agreement itself. It arrives after
          the filing, appears in your dashboard under Legal documents for you to download, and its
          sha256 is folded into the next manifest version — which is scheduled through your
          guardian timelock like any other change.
        </>
      )}
    </Callout>
  );
}
