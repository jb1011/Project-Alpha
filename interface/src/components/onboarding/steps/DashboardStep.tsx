"use client";

import * as React from "react";
import { AgentConfig, formatUsdc, shortAddress } from "../types";
import type { EntityView } from "@/lib/api/types";
import { addressUrl, txUrl } from "@/lib/chain";
import {
  Button,
  Callout,
  Card,
  CheckIcon,
  cx,
  ExternalIcon,
  ShieldIcon,
} from "../primitives";

type Activity = {
  id: string;
  label: string;
  detail: string;
  amount: string;
  time: string;
  state: "confirmed" | "held";
};

const ACTIVITY: Activity[] = [
  { id: "a1", label: "Paid invoice", detail: "Render · infra", amount: "-120.00", time: "2m ago", state: "confirmed" },
  { id: "a2", label: "Rebalanced float", detail: "Internal transfer", amount: "-300.00", time: "1h ago", state: "confirmed" },
  { id: "a3", label: "Received deposit", detail: "Operating top-up", amount: "+500.00", time: "3h ago", state: "confirmed" },
];

export function DashboardStep({
  config,
  entity,
  onRestart,
}: {
  config: AgentConfig;
  entity: EntityView | null;
  onRestart: () => void;
}) {
  const [paused, setPaused] = React.useState(false);
  const [pendingVetoed, setPendingVetoed] = React.useState(false);
  const [recovered, setRecovered] = React.useState(false);
  const [dialog, setDialog] = React.useState<null | "recover" | "veto">(null);

  const balance = recovered ? 0 : entity?.status === "funded" ? Number(config.dailyCap) || 0 : 0;
  const dailyCap = Number(config.dailyCap) || 0;
  const dailySpent = recovered ? 0 : 420;

  return (
    <div className="anim-line" style={{ animationDuration: "0.45s" }}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted-2">
            <span className="font-mono text-muted">Screen 08</span>
            <span className="inline-block h-px w-6 bg-line-strong" />
          </div>
          <h1 className="mt-3 flex flex-wrap items-center gap-3 text-[30px] font-medium leading-tight tracking-[-0.02em] text-ink sm:text-[36px]">
            {config.name.trim() || "Your agent"}
            <span
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px] font-normal tracking-normal",
                paused
                  ? "border-[#febc2e]/40 bg-[#febc2e]/10 text-[#f3cd72]"
                  : "border-accent/30 bg-accent/10 text-accent-soft",
              )}
            >
              <span
                className={cx(
                  "h-1.5 w-1.5 rounded-full",
                  paused ? "bg-[#febc2e]" : "bg-accent animate-pulse",
                )}
              />
              {entity?.status === "funded" ? "Funded" : entity?.status === "bound" ? "Operational" : paused ? "Paused" : "Operational"}
            </span>
          </h1>
          <p className="mt-2 text-[14px] text-muted">
            Your agent can now transact on its own, within its limits.
          </p>
        </div>
        <button
          onClick={onRestart}
          className="text-[12.5px] text-muted-2 underline-offset-2 hover:text-ink hover:underline"
        >
          Reset onboarding
        </button>
      </div>

      {entity && (
        <Card className="mt-6 p-5">
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">
            On-chain identity
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
            {entity.agentId && (
              <OnChainRow label="Agent ID" value={`#${entity.agentId}`} />
            )}
            {entity.treasury && (
              <OnChainRow label="Treasury" value={shortAddress(entity.treasury)} href={addressUrl(entity.treasury)} />
            )}
            {entity.operator && (
              <OnChainRow label="Operator" value={shortAddress(entity.operator)} />
            )}
            {entity.guardian && (
              <OnChainRow label="Guardian" value={shortAddress(entity.guardian)} />
            )}
            {entity.oaHash && (
              <OnChainRow label="OA hash" value={`${entity.oaHash.slice(0, 14)}…`} />
            )}
          </dl>
          <div className="mt-4 flex flex-wrap gap-3">
            {entity.createTxHash && (
              <TxLink hash={entity.createTxHash} label="Create tx" />
            )}
            {entity.bindTxHash && (
              <TxLink hash={entity.bindTxHash} label="Bind tx" />
            )}
            {entity.fundTxHash && (
              <TxLink hash={entity.fundTxHash} label="Fund tx" />
            )}
          </div>
        </Card>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Treasury balance" value={`${formatUsdc(balance)}`} unit="USDC" emphasis />
        <StatCard
          label="Spent today"
          value={`${formatUsdc(dailySpent)}`}
          unit={`/ ${formatUsdc(dailyCap)} cap`}
        >
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-paper">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${dailyCap ? Math.min(100, (dailySpent / dailyCap) * 100) : 0}%` }}
            />
          </div>
        </StatCard>
        <StatCard label="Tier 2 wallet" value="0.00" unit="USDC · soon" muted />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        {/* Activity log */}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b hairline px-5 py-3.5">
            <span className="text-[13px] font-medium text-ink">Activity</span>
            <span className="text-[11.5px] text-muted-2">Agent transactions</span>
          </div>
          <ul>
            {!pendingVetoed && !recovered && (
              <li className="flex items-center justify-between gap-3 border-b hairline bg-[#febc2e]/[0.05] px-5 py-3.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] text-ink">Vendor payout</span>
                    <span className="rounded-full border border-[#febc2e]/40 bg-[#febc2e]/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[#f3cd72]">
                      Held · 11h left
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-muted-2">
                    Above-cap · awaiting timelock — you can veto
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[13px] tabular-nums text-ink">-740.00</span>
                  <Button variant="ghost" size="md" onClick={() => setDialog("veto")}>
                    Veto
                  </Button>
                </div>
              </li>
            )}
            {(entity?.status === "funded" ? [] : ACTIVITY).map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 border-b hairline px-5 py-3.5 last:border-0"
              >
                <div className="min-w-0">
                  <div className="text-[13px] text-ink">{a.label}</div>
                  <div className="mt-0.5 text-[11.5px] text-muted-2">{a.detail} · {a.time}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={cx(
                      "font-mono text-[13px] tabular-nums",
                      a.amount.startsWith("+") ? "text-accent-soft" : "text-ink",
                    )}
                  >
                    {a.amount}
                  </span>
                  <a
                    href="#"
                    onClick={(e) => e.preventDefault()}
                    className="text-muted-2 transition-colors hover:text-accent-soft"
                    aria-label="View on explorer"
                  >
                    <ExternalIcon className="h-3.5 w-3.5" />
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </Card>

        {/* Rules + guardian controls */}
        <div className="flex flex-col gap-6">
          <Card className="p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">
              Active rules
            </div>
            <dl className="mt-4 flex flex-col gap-3 text-[12.5px]">
              <RuleRow k="Per-tx cap" v={`${formatUsdc(config.perTxCap)} USDC`} />
              <RuleRow k="Daily cap" v={`${formatUsdc(config.dailyCap)} USDC`} />
              <RuleRow k="Timelock" v={`${config.timelockHours || "0"}h`} />
              <RuleRow
                k="Recipients"
                v={
                  config.allowlist.length
                    ? `${config.allowlist.length} allowlisted`
                    : "Any (within caps)"
                }
              />
            </dl>
            {config.allowlist.length > 0 && (
              <div className="mt-3 flex flex-col gap-1.5 border-t hairline pt-3">
                {config.allowlist.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-[11.5px]">
                    <span className="text-muted">{a.label || "Recipient"}</span>
                    <span className="font-mono text-muted-2">{shortAddress(a.address)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-2">
              <ShieldIcon className="h-3.5 w-3.5" /> Guardian controls
            </div>
            <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-2">
              Your human safety brake. Sensitive actions ask for confirmation.
            </p>
            <div className="mt-4 flex flex-col gap-2.5">
              <button
                onClick={() => setPaused((p) => !p)}
                className="flex items-center justify-between rounded-xl border hairline-strong bg-paper px-4 py-3 text-left transition-colors hover:bg-paper-2"
              >
                <div>
                  <div className="text-[13px] font-medium text-ink">
                    {paused ? "Resume agent" : "Pause agent"}
                  </div>
                  <div className="text-[11px] text-muted-2">
                    {paused ? "Re-enable autonomous actions" : "Freeze all autonomous actions"}
                  </div>
                </div>
                <span
                  className={cx(
                    "relative h-5 w-9 rounded-full transition-colors",
                    paused ? "bg-[#febc2e]/40" : "bg-accent/50",
                  )}
                >
                  <span
                    className={cx(
                      "absolute top-0.5 h-4 w-4 rounded-full bg-ink transition-all",
                      paused ? "left-0.5" : "left-[18px]",
                    )}
                  />
                </span>
              </button>

              <GuardianAction
                title="Veto pending action"
                desc={pendingVetoed ? "No actions held" : "Cancel the held vendor payout"}
                onClick={() => setDialog("veto")}
                disabled={pendingVetoed || recovered}
              />

              <GuardianAction
                title="Recover funds"
                desc="Sweep the full treasury back to you"
                onClick={() => setDialog("recover")}
                disabled={recovered}
                danger
              />
            </div>
          </Card>
        </div>
      </div>

      {recovered && (
        <Callout tone="info" className="mt-6" title="Funds recovered">
          The treasury was swept back to your wallet. The agent is effectively
          wound down.
        </Callout>
      )}

      {dialog && (
        <ConfirmDialog
          kind={dialog}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            if (dialog === "recover") setRecovered(true);
            if (dialog === "veto") setPendingVetoed(true);
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}

function OnChainRow({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href?: string;
}) {
  return (
    <div>
      <dt className="text-muted-2">{label}</dt>
      <dd className="mt-0.5 font-mono text-ink">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="hover:text-accent-soft">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

function TxLink({ hash, label }: { hash: string; label: string }) {
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-full border hairline-strong px-3 py-1.5 text-[11.5px] text-muted transition-colors hover:text-accent-soft"
    >
      {label}
      <ExternalIcon className="h-3 w-3" />
    </a>
  );
}

function StatCard({
  label,
  value,
  unit,
  emphasis,
  muted,
  children,
}: {
  label: string;
  value: string;
  unit?: string;
  emphasis?: boolean;
  muted?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Card className={cx("p-5", emphasis && "border-accent/20 bg-accent/[0.04]")}>
      <div className="text-[11px] uppercase tracking-[0.16em] text-muted-2">{label}</div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className={cx(
            "text-[26px] font-medium tabular-nums",
            muted ? "text-muted-2" : "text-ink",
          )}
        >
          {value}
        </span>
        {unit && <span className="text-[12px] text-muted-2">{unit}</span>}
      </div>
      {children}
    </Card>
  );
}

function RuleRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-2">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}

function GuardianAction({
  title,
  desc,
  onClick,
  disabled,
  danger,
}: {
  title: string;
  desc: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "flex items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        danger
          ? "border-[#ff5f57]/30 bg-[#ff5f57]/[0.05] hover:bg-[#ff5f57]/[0.1]"
          : "hairline-strong bg-paper hover:bg-paper-2",
      )}
    >
      <div>
        <div className={cx("text-[13px] font-medium", danger ? "text-[#ff8a84]" : "text-ink")}>
          {title}
        </div>
        <div className="text-[11px] text-muted-2">{desc}</div>
      </div>
      <span className={cx("text-[14px]", danger ? "text-[#ff8a84]" : "text-muted-2")}>→</span>
    </button>
  );
}

function ConfirmDialog({
  kind,
  onCancel,
  onConfirm,
}: {
  kind: "recover" | "veto";
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = {
    recover: {
      title: "Recover all funds?",
      body: "This sweeps the entire treasury balance back to your guardian wallet and halts the agent. This requires your signature on-chain.",
      cta: "Recover funds",
      danger: true,
    },
    veto: {
      title: "Veto the held action?",
      body: "The pending vendor payout will be cancelled before its timelock expires. The agent will be notified.",
      cta: "Veto action",
      danger: false,
    },
  }[kind];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-5">
      <button
        aria-label="Close"
        onClick={onCancel}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="relative w-full max-w-md rounded-2xl border hairline-strong bg-paper-2 p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.8)]">
        <div
          className={cx(
            "flex h-10 w-10 items-center justify-center rounded-full",
            copy.danger ? "bg-[#ff5f57]/12 text-[#ff8a84]" : "bg-[#febc2e]/12 text-[#f3cd72]",
          )}
        >
          <ShieldIcon className="h-5 w-5" />
        </div>
        <h3 className="mt-4 text-[18px] font-medium text-ink">{copy.title}</h3>
        <p className="mt-2 text-[13px] leading-[1.55] text-muted">{copy.body}</p>
        <div className="mt-6 flex justify-end gap-3">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={copy.danger ? "danger" : "primary"} onClick={onConfirm}>
            <CheckIcon className="h-4 w-4" />
            {copy.cta}
          </Button>
        </div>
      </div>
    </div>
  );
}
