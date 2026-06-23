"use client";

import * as React from "react";
import { AgentConfig, formatUsdc, shortAddress } from "../types";
import { StepNav } from "../OnboardingFlow";
import { useAuth } from "../AuthProvider";
import { onboardEntity } from "@/lib/api/client";
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
  config: AgentConfig;
  guardianPasskey: GuardianPasskey | null;
  idempotencyKey: string | null;
  onBack: () => void;
  onSubmitted: (entityId: string, idempotencyKey: string) => void;
};

export function AgreementStep({
  config,
  guardianPasskey,
  idempotencyKey,
  onBack,
  onSubmitted,
}: Props) {
  const { ensureSession, address } = useAuth();
  const [confirmed, setConfirmed] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const agreementText = React.useMemo(() => buildAgreement(config), [config]);

  function download() {
    const blob = new Blob([agreementText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(config.name || "agent").toLowerCase().replace(/\s+/g, "-")}-operating-agreement.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function submit() {
    if (!guardianPasskey || !address) {
      setError("Complete wallet sign-in and passkey setup first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const auth = await ensureSession();
      const key =
        idempotencyKey ??
        (typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `pa-${Date.now()}`);
      const spec = configToAgentSpec(config, address);
      const { id } = await onboardEntity(auth.token, spec, guardianPasskey, key);
      onSubmitted(id, key);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onboarding submission failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <StepHeader
        eyebrow="Screen 02"
        title="Review your operating agreement"
        intro="The backend will translate these rules into an LLC operating agreement and bind them to the on-chain policy when you confirm."
      />

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_320px] lg:gap-10">
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b hairline px-5 py-3">
            <span className="text-[12px] text-muted-2">
              Operating Agreement — {config.name || "Agent"} DAO LLC
            </span>
            <button
              onClick={download}
              className="text-[12px] text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Download
            </button>
          </div>
          <div className="max-h-[420px] overflow-y-auto px-6 py-5 text-[12.5px] leading-[1.7] text-muted whitespace-pre-wrap">
            {agreementText}
          </div>
        </Card>

        <div className="flex flex-col gap-5 lg:sticky lg:top-24 lg:self-start">
          <Card className="p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">
              Key clauses
            </div>
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
              The backend generates the legal document, registers identity on Arc,
              deploys contracts, and binds the agent wallet. This takes a few minutes.
            </p>
          </Card>
        </div>
      </div>

      <Callout tone="warn" className="mt-7" title="Human decision point">
        This is a binding policy for a real legal entity. Read it, then confirm
        you agree to these rules.
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
          I&apos;ve reviewed the operating agreement and I confirm these rules
          for {config.name || "my agent"}.
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
  ];
}

function buildAgreement(config: AgentConfig): string {
  const name = config.name || "The Agent";
  const lines = config.allowlist.length
    ? config.allowlist
        .map((a, i) => `        (${i + 1}) ${a.label || "Recipient"} — ${shortAddress(a.address)}`)
        .join("\n")
    : "        (none — open recipients within the spending caps)";

  return `OPERATING AGREEMENT
OF ${name.toUpperCase()} DAO LLC
(A Wyoming Decentralized Autonomous Organization Limited Liability Company)

ARTICLE I — FORMATION
1.1  This Agreement governs ${name} DAO LLC (the "Company"), formed under the
     Wyoming DAO LLC Act. The Company is algorithmically managed within the
     bounds defined herein and mirrored by smart contract.

ARTICLE II — PURPOSE
2.1  ${config.purpose || "The Company operates an autonomous agent acting within the mandate set herein."}

ARTICLE III — MANAGEMENT & GUARDIANSHIP
3.1  The Company is managed by an autonomous agent (the "Agent") operating under
     a delegated key with strictly limited authority.
3.2  The natural person who created the Company (the "Guardian") retains
     ultimate authority and may pause, veto, or recover Company assets at any
     time.

ARTICLE IV — SPENDING MANDATE
4.1  Per-transaction limit: ${formatUsdc(config.perTxCap)} USDC.
4.2  Rolling 24-hour limit: ${formatUsdc(config.dailyCap)} USDC.
4.3  Timelock: sensitive or above-threshold actions are delayed
     ${config.timelockHours || "1"} hour(s) before execution.

ARTICLE V — AUTHORIZED RECIPIENTS
5.1  Transfers may be made to:
${lines}

ARTICLE VI — LAW-TO-CODE BINDING
6.1  This Agreement is cryptographically bound to the deployed on-chain policy.
6.2  The backend computes the policy fingerprint at deploy time.
6.3  Any divergence between this Agreement and the deployed policy is void.

ARTICLE VII — NON-CUSTODY
7.1  No platform, including projectAlpha, holds the keys or assets of the
     Company. Authority originates solely from the Guardian's passkey.

IN WITNESS WHEREOF, the Guardian adopts this Agreement upon on-chain confirmation.`;
}
