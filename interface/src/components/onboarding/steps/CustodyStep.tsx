"use client";

import { usePublicConfigQuery } from "@/lib/api/hooks";
import { StepNav } from "../OnboardingFlow";
import type { AgentConfig, Custody } from "../types";
import { Button, Callout, CheckIcon, StepHeader, cx } from "../primitives";

type Props = {
  config: AgentConfig;
  onChange: (config: AgentConfig) => void;
  onBack: () => void;
  onComplete: () => void;
};

/** Tier-0 custody selector: who holds the agent's OPERATOR keys. Honest framing (spec audit item
 *  10): the choice covers the operator layer only — the payment float (pocket) is platform-managed
 *  on BOTH options, capped at the standing-float ceiling — and the guardian keeps every on-chain
 *  power (pause, veto, clawback, key rotation) either way. */
const OPTIONS: {
  value: Custody;
  label: string;
  tag?: string;
  tagline: string;
  points: string[];
  tradeoff: string;
}[] = [
  {
    value: "circle",
    label: "Novi-managed",
    tag: "Recommended",
    tagline: "Smart-account operator in Circle's MPC infrastructure, run by the platform.",
    points: [
      "Gasless — no gas top-ups, no per-signature costs",
      "Smart-account operator (upgradeable, ERC-1271 signatures)",
      "Fastest funding path — fewer moving parts",
    ],
    tradeoff:
      "The platform controls the operator's hot keys (in Circle MPC — never stored on our servers). Your guardian wallet still outranks the agent on-chain: pause, veto, and clawback always answer to you.",
  },
  {
    value: "turnkey",
    label: "Passkey-rooted",
    tagline: "The operator key lives in a vault whose root authority is your passkey.",
    points: [
      "Your passkey outranks the platform for the operator key",
      "Sovereignty option — the platform operates under your root",
      "Same on-chain guardian powers as Novi-managed",
    ],
    tradeoff:
      "Keeps the operational overhead the managed path removes: gas top-ups on funding, and metered signing costs on the key vault.",
  },
];

export function CustodyStep({ config, onChange, onBack, onComplete }: Props) {
  const { data: publicConfig, isError } = usePublicConfigQuery();
  const circleAvailable = isError ? null : publicConfig?.circleCustodyAvailable ?? null;
  // Absent field = a backend that predates per-provider gating, which always served turnkey.
  const turnkeyAvailable = isError ? null : publicConfig?.turnkeyCustodyAvailable ?? null;

  const circleUnavailable = circleAvailable === false;
  const turnkeyUnavailable = turnkeyAvailable === false;
  // Derived, not stored: a deployment that can't serve an option shows the other as selected
  // without an effect writing to parent state (which would cascade renders). Circle-only is the
  // mainnet shape; turnkey-only is the credential-less dev shape.
  const selected = circleUnavailable ? "turnkey" : turnkeyUnavailable ? "circle" : config.custody;

  return (
    <div>
      <StepHeader
        eyebrow="Screen 3"
        title="Choose who holds the agent's operating keys"
        intro="This sets the custody of the agent's operator key — the key that moves funds inside your rules. Your wallet remains the on-chain guardian with full override powers on both options."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {OPTIONS.map((o) => {
          const isSelected = selected === o.value;
          const disabled =
            (o.value === "circle" && circleUnavailable) ||
            (o.value === "turnkey" && turnkeyUnavailable);
          return (
            <button
              key={o.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...config, custody: o.value })}
              className={cx(
                "rounded-2xl border p-5 text-left transition-colors",
                isSelected
                  ? "border-accent/40 bg-accent/[0.06]"
                  : "hairline-strong hover:bg-paper-2",
                disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
              )}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className={cx(
                    "h-4 w-4 rounded-full border",
                    isSelected ? "border-accent bg-accent" : "border-line-strong",
                  )}
                />
                <span className="text-[15px] font-medium text-ink">{o.label}</span>
                {o.tag && !disabled && (
                  <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-accent-soft">
                    {o.tag}
                  </span>
                )}
                {disabled && (
                  <span className="rounded-full border hairline-strong bg-paper-2/60 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-2">
                    Unavailable here
                  </span>
                )}
              </div>
              <p className="mt-2 text-[12.5px] leading-[1.55] text-muted">{o.tagline}</p>
              <ul className="mt-3 flex flex-col gap-2">
                {o.points.map((p) => (
                  <li key={p} className="flex gap-2 text-[12px] leading-[1.45] text-muted">
                    <CheckIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-soft" />
                    {p}
                  </li>
                ))}
              </ul>
              <p className="mt-3 border-t hairline pt-3 text-[11.5px] leading-[1.5] text-muted-2">
                {disabled
                  ? o.value === "circle"
                    ? "This deployment isn't configured for Novi-managed custody, so it can't be selected here."
                    : "This deployment doesn't offer passkey-rooted custody, so it can't be selected here."
                  : o.tradeoff}
              </p>
            </button>
          );
        })}
      </div>

      <Callout tone="accent" className="mt-6" title="What this choice does NOT change">
        The agent&apos;s payment float (its spending pocket) is platform-managed on both options and
        capped at the standing-float ceiling. Your guardian wallet keeps every on-chain power —
        pause, veto, clawback — regardless of custody. Custody is fixed for the life of the agent
        today; guardian-signed migration between options is on the roadmap.
      </Callout>

      <StepNav onBack={onBack}>
        <Button
          onClick={() => {
            // Commit the derived selection in the event handler (not an effect) so a downgraded
            // choice is what actually gets submitted.
            if (selected !== config.custody) onChange({ ...config, custody: selected });
            onComplete();
          }}
        >
          Continue
          <CheckIcon className="h-4 w-4" />
        </Button>
      </StepNav>
    </div>
  );
}
