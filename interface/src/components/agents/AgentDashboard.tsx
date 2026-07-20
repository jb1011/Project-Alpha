"use client";

import * as React from "react";
import Link from "next/link";
import { usePublicClient, useWriteContract } from "wagmi";
import {
  getEntity,
  getEntityRuns,
  getEntityTreasury,
} from "@/lib/api/client";
import type { AgentRun, EntityView, TreasuryView } from "@/lib/api/types";
import { addressUrl, arcTestnet, txUrl } from "@/lib/chain";
import { treasuryAbi } from "@/lib/treasuryAbi";
import { useAuth } from "@/components/onboarding/AuthProvider";
import { JobsReputationCard } from "@/components/agents/JobsReputationCard";
import { ConnectAgentPanel } from "@/components/agents/ConnectAgentPanel";
import { Card, cx, ExternalIcon, ShieldIcon } from "@/components/onboarding/primitives";
import { AgentConfig, formatUsdc, shortAddress } from "@/components/onboarding/types";

export function AgentDashboard({
  entityId,
  config,
  onRestart,
}: {
  entityId: string;
  config?: AgentConfig;
  onRestart?: () => void;
}) {
  const { ensureSession } = useAuth();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [entity, setEntity] = React.useState<EntityView | null>(null);
  const [treasury, setTreasury] = React.useState<TreasuryView | null>(null);
  const [runs, setRuns] = React.useState<AgentRun[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pausing, setPausing] = React.useState(false);
  const [pauseError, setPauseError] = React.useState<string | null>(null);

  const ensureSessionRef = React.useRef(ensureSession);
  React.useEffect(() => {
    ensureSessionRef.current = ensureSession;
  }, [ensureSession]);

  const treasuryAddr = entity?.treasury ?? null;

  const refresh = React.useCallback(async () => {
    try {
      const auth = await ensureSessionRef.current();
      const e = await getEntity(auth.token, entityId);
      setEntity(e);
      setLoadError(null);
      if (e.treasury) {
        setTreasury(await getEntityTreasury(auth.token, entityId));
        setRuns((await getEntityRuns(auth.token, entityId)).runs);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load agent.");
    }
  }, [entityId]);

  React.useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) void refresh();
    };
    tick();
    const h = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [refresh]);

  const paused = treasury?.paused ?? false;
  const balanceUsdc = treasury ? Number(treasury.usdcBalance) / 1e6 : null;
  const capUsdc = treasury ? Number(treasury.cap) / 1e6 : Number(config?.dailyCap) || 0;
  const spentUsdc = treasury
    ? Math.max(0, (Number(treasury.cap) - Number(treasury.available)) / 1e6)
    : 0;
  const perTxUsdc = entity?.perTxCap
    ? Number(entity.perTxCap) / 1e6
    : config?.perTxCap
      ? Number(config.perTxCap)
      : null;
  const displayName = entity?.name?.trim() || config?.name?.trim() || "Your agent";
  const periodHours = treasury ? Math.round(Number(treasury.period) / 3600) : null;
  // T5 note: GET /entities/:id/treasury does not yet surface `standing`/`legalActive` — those
  // fields live only on the MCP `treasury_status` tool output (entityPayment.status()), which the
  // web dashboard does not call. Widen locally (no shared-type edit, no backend change — out of
  // scope for this copy-only task) so the two new rows render honestly ("—") until a follow-up
  // extends the REST route. See back/docs/design/2026-07-20-s2-interim-float-ceiling-design.md §D7.
  const treasuryExt = treasury as
    | (TreasuryView & {
        standing?: { operatorEoa: string; pocketEoa: string; gateway: string; total: string; ceiling: string };
        legalActive?: boolean;
      })
    | null;
  const ceilingUsdc = treasuryExt?.standing?.ceiling
    ? Number(treasuryExt.standing.ceiling) / 1e6
    : null;
  const legalActive = treasuryExt?.legalActive;

  const onTogglePause = async () => {
    if (!treasuryAddr) return;
    setPauseError(null);
    setPausing(true);
    try {
      const hash = await writeContractAsync({
        address: treasuryAddr as `0x${string}`,
        abi: treasuryAbi,
        functionName: paused ? "unpause" : "pause",
        chainId: arcTestnet.id,
      });
      if (publicClient) await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
    } catch (e) {
      setPauseError(
        e instanceof Error
          ? shortenErr(e.message)
          : "Transaction failed — is this the guardian wallet?",
      );
    } finally {
      setPausing(false);
    }
  };

  if (loadError && !entity) {
    return (
      <div className="py-12 text-center text-[13px] text-[#ff8a84]">{loadError}</div>
    );
  }

  return (
    <div className="anim-line" style={{ animationDuration: "0.45s" }}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-muted-2">
            <span className="font-mono text-muted">Agent dashboard</span>
            <span className="inline-block h-px w-6 bg-line-strong" />
          </div>
          <h1 className="mt-3 flex flex-wrap items-center gap-3 text-[30px] font-medium leading-tight tracking-[-0.02em] text-ink sm:text-[36px]">
            {displayName}
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
              {paused ? "Paused" : "Operational"}
            </span>
          </h1>
          <p className="mt-2 text-[14px] text-muted">
            Monitor activity, treasury, and job track record. Edit rules in{" "}
            <Link
              href={`/agents/${encodeURIComponent(entityId)}/settings`}
              className="text-accent-soft underline-offset-2 hover:underline"
            >
              Settings
            </Link>
            .
          </p>
        </div>
        {onRestart && (
          <button
            onClick={onRestart}
            className="text-[12.5px] text-muted-2 underline-offset-2 hover:text-ink hover:underline"
          >
            Reset onboarding
          </button>
        )}
      </div>

      {entity && (
        <Card className="mt-6 p-5">
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">On-chain identity</div>
          <dl className="mt-4 grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
            {entity.agentId && <OnChainRow label="Agent ID" value={`#${entity.agentId}`} />}
            {entity.treasury && (
              <OnChainRow
                label="Treasury"
                value={shortAddress(entity.treasury)}
                href={addressUrl(entity.treasury)}
              />
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
            {entity.createTxHash && <TxLink hash={entity.createTxHash} label="Create tx" />}
            {entity.bindTxHash && <TxLink hash={entity.bindTxHash} label="Bind tx" />}
            {entity.fundTxHash && <TxLink hash={entity.fundTxHash} label="Fund tx" />}
          </div>
        </Card>
      )}

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Treasury balance"
          value={balanceUsdc === null ? "—" : formatUsdc(balanceUsdc)}
          unit="USDC"
          emphasis
        />
        <StatCard
          label="Spent this period"
          value={treasury ? formatUsdc(spentUsdc) : "—"}
          unit={`/ ${formatUsdc(capUsdc)} cap`}
        >
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-paper">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${capUsdc ? Math.min(100, (spentUsdc / capUsdc) * 100) : 0}%` }}
            />
          </div>
        </StatCard>
        <StatCard
          label="Per-tx cap"
          value={perTxUsdc === null ? "—" : formatUsdc(perTxUsdc)}
          unit="USDC"
        />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-6">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b hairline px-5 py-3.5">
              <span className="text-[13px] font-medium text-ink">Activity</span>
              <span className="text-[11.5px] text-muted-2">Agent jobs · x402</span>
            </div>
            {runs.length === 0 ? (
              <div className="px-5 py-12 text-center text-[12.5px] text-muted-2">
                No agent payments yet — this agent hasn&apos;t transacted.
              </div>
            ) : (
              <ul>
                {runs.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </ul>
            )}
          </Card>
          <JobsReputationCard entityId={entityId} />
        </div>

        <div className="flex flex-col gap-6">
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">Active rules</div>
              <Link
                href={`/agents/${encodeURIComponent(entityId)}/settings`}
                className="text-[11.5px] text-muted-2 hover:text-accent-soft"
              >
                Edit →
              </Link>
            </div>

            <div className="mt-4 text-[11px] uppercase tracking-[0.18em] text-muted-2">
              On-chain (enforced by the treasury contract)
            </div>
            <dl className="mt-3 flex flex-col gap-3 text-[12.5px]">
              <RuleRow k="Period cap" v={`${formatUsdc(capUsdc)} USDC`} />
              <RuleRow k="Period" v={periodHours ? `${periodHours}h rolling` : "—"} />
              <RuleRow k="Guardian pause" v={paused ? "On" : "Off"} />
              <RuleRow
                k="Legal status"
                v={legalActive === undefined ? "—" : legalActive ? "Active" : "Suspended"}
              />
              <RuleRow
                k="Allowlist (direct spend)"
                v={
                  config?.allowlist.length
                    ? `${config.allowlist.length} allowlisted`
                    : "Any (within caps)"
                }
              />
            </dl>

            <div className="mt-5 text-[11px] uppercase tracking-[0.18em] text-muted-2">
              Software-enforced on x402 payments
            </div>
            <p className="mt-1.5 text-[11px] leading-[1.5] text-muted-2">
              The backend checks each payment against fresh on-chain state — not guaranteed if the
              backend is compromised.
            </p>
            <dl className="mt-3 flex flex-col gap-3 text-[12.5px]">
              <RuleRow
                k="Per-tx cap"
                v={perTxUsdc === null ? "Not set" : `${formatUsdc(perTxUsdc)} USDC`}
              />
              <RuleRow k="Allowlist / threshold" v="Re-asserted before every payment" />
              <RuleRow k="Pause + legal status" v="Re-checked before every payment" />
              <RuleRow
                k="Standing float ceiling"
                v={ceilingUsdc === null ? "—" : `≤ ${formatUsdc(ceilingUsdc)} USDC`}
              />
            </dl>

            <p className="mt-4 border-t hairline pt-3 text-[11px] leading-[1.5] text-muted-2">
              x402 payments enforce the same allowlist, per-tx and cap rules as direct on-chain
              spends — in software, against live on-chain reads. The float ceiling caps how much
              can sit beyond the guardian&apos;s reach at once.
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-muted-2">
              <ShieldIcon className="h-3.5 w-3.5" /> Guardian controls
            </div>
            <p className="mt-2 text-[11.5px] leading-[1.5] text-muted-2">
              Your human safety brake — freeze all autonomous spending on-chain, signed by your wallet.
            </p>
            <div className="mt-4">
              <button
                onClick={() => void onTogglePause()}
                disabled={pausing || !treasuryAddr}
                className="flex w-full items-center justify-between rounded-xl border hairline-strong bg-paper px-4 py-3 text-left transition-colors hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div>
                  <div className="text-[13px] font-medium text-ink">
                    {pausing ? "Confirm in wallet…" : paused ? "Resume agent" : "Pause agent"}
                  </div>
                  <div className="text-[11px] text-muted-2">
                    {paused ? "Re-enable autonomous spending" : "Freeze all autonomous spending"}
                  </div>
                </div>
                <span
                  className={cx(
                    "relative h-5 w-9 shrink-0 rounded-full transition-colors",
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
              {pauseError && (
                <p className="mt-2 text-[11.5px] leading-[1.4] text-[#ff8a84]">{pauseError}</p>
              )}
            </div>
          </Card>
        </div>
      </div>

      {entity && (
        <div className="mt-8">
          <ConnectAgentPanel entity={entity} />
        </div>
      )}
    </div>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  const [open, setOpen] = React.useState(false);
  const profit = Number(run.pnl) >= 0;
  return (
    <li className="border-b hairline last:border-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-paper-2/40"
      >
        <div className="min-w-0">
          <div className="truncate text-[13px] text-ink">{run.query}</div>
          <div className="mt-0.5 text-[11.5px] text-muted-2">
            spent {formatUsdc(Number(run.cost) / 1e6)} USDC · earned{" "}
            {formatUsdc(Number(run.revenue) / 1e6)} USDC
          </div>
        </div>
        <span
          className={cx(
            "shrink-0 font-mono text-[13px] tabular-nums",
            profit ? "text-accent-soft" : "text-[#ff8a84]",
          )}
        >
          {profit ? "+" : "−"}
          {formatUsdc(Math.abs(Number(run.pnl)) / 1e6)}
        </span>
      </button>
      {open && (
        <div className="border-t hairline bg-paper/40 px-5 py-3">
          {(run.payments ?? []).map((p, i) => (
            <div
              key={p.transferId ?? i}
              className="flex items-center justify-between gap-3 py-1.5 text-[11.5px]"
            >
              <span className="text-muted">
                {p.direction === "buy" ? "Paid" : "Received"}{" "}
                {formatUsdc(Number(p.amount) / 1e6)} USDC · {shortAddress(p.counterparty)}
              </span>
              <span className="font-mono text-muted-2">
                {p.transferId ? `settle ${p.transferId.slice(0, 8)}…` : p.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function shortenErr(msg: string): string {
  const first = msg.split("\n")[0]?.trim() ?? "Transaction failed.";
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}

function OnChainRow({ label, value, href }: { label: string; value: string; href?: string }) {
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
  children,
}: {
  label: string;
  value: string;
  unit?: string;
  emphasis?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Card className={cx("p-5", emphasis && "border-accent/20 bg-accent/[0.04]")}>
      <div className="text-[11px] uppercase tracking-[0.16em] text-muted-2">{label}</div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-[26px] font-medium tabular-nums text-ink">{value}</span>
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
