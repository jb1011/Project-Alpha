"use client";

import * as React from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { getEntityRuns, getEntityTreasury } from "@/lib/api/client";
import type { AgentRun, EntityView, TreasuryView } from "@/lib/api/types";
import { addressUrl, arcTestnet, txUrl } from "@/lib/chain";
import { treasuryAbi } from "@/lib/treasuryAbi";
import { useAuth } from "../AuthProvider";
import { Card, cx, ExternalIcon, ShieldIcon } from "../primitives";
import { AgentConfig, formatUsdc, shortAddress } from "../types";

export function DashboardStep({
  config,
  entity,
  onRestart,
}: {
  config: AgentConfig;
  entity: EntityView | null;
  onRestart: () => void;
}) {
  const { ensureSession } = useAuth();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [treasury, setTreasury] = React.useState<TreasuryView | null>(null);
  const [runs, setRuns] = React.useState<AgentRun[]>([]);
  const [pausing, setPausing] = React.useState(false);
  const [pauseError, setPauseError] = React.useState<string | null>(null);

  const ensureSessionRef = React.useRef(ensureSession);
  React.useEffect(() => {
    ensureSessionRef.current = ensureSession;
  }, [ensureSession]);

  const entityId = entity?.id ?? null;
  const treasuryAddr = entity?.treasury ?? null;

  // Read the REAL on-chain treasury state from the backend (no mocks).
  const refresh = React.useCallback(async () => {
    if (!entityId || !treasuryAddr) return;
    try {
      const auth = await ensureSessionRef.current();
      setTreasury(await getEntityTreasury(auth.token, entityId));
      setRuns((await getEntityRuns(auth.token, entityId)).runs);
    } catch {
      /* transient (e.g. token refresh / RPC blip) — keep the last good value */
    }
  }, [entityId, treasuryAddr]);

  React.useEffect(() => {
    if (!entityId || !treasuryAddr) return;
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
  }, [entityId, treasuryAddr, refresh]);

  const paused = treasury?.paused ?? false;
  // Atomic USDC (6 decimals) → human. Fall back to the typed cap only until the first fetch lands.
  const balanceUsdc = treasury ? Number(treasury.usdcBalance) / 1e6 : null;
  const capUsdc = treasury ? Number(treasury.cap) / 1e6 : Number(config.dailyCap) || 0;
  const spentUsdc = treasury
    ? Math.max(0, (Number(treasury.cap) - Number(treasury.available)) / 1e6)
    : 0;

  // Real guardian freeze: the connected (guardian) wallet signs pause()/unpause() on-chain.
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
              {paused ? "Paused" : "Operational"}
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
          <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">On-chain identity</div>
          <dl className="mt-4 grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
            {entity.agentId && <OnChainRow label="Agent ID" value={`#${entity.agentId}`} />}
            {entity.treasury && (
              <OnChainRow label="Treasury" value={shortAddress(entity.treasury)} href={addressUrl(entity.treasury)} />
            )}
            {entity.operator && <OnChainRow label="Operator" value={shortAddress(entity.operator)} />}
            {entity.guardian && <OnChainRow label="Guardian" value={shortAddress(entity.guardian)} />}
            {entity.oaHash && <OnChainRow label="OA hash" value={`${entity.oaHash.slice(0, 14)}…`} />}
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
        <StatCard label="Tier 2 wallet" value="0.00" unit="USDC · soon" muted />
      </div>

      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        {/* Activity log — x402 job receipts, expandable per run. */}
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between border-b hairline px-5 py-3.5">
            <span className="text-[13px] font-medium text-ink">Activity</span>
            <span className="text-[11.5px] text-muted-2">Agent jobs · x402</span>
          </div>
          {runs.length === 0 ? (
            <div className="px-5 py-12 text-center text-[12.5px] text-muted-2">
              No agent payments yet — this agent hasn’t transacted.
            </div>
          ) : (
            <ul>
              {runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          )}
        </Card>

        {/* Rules + guardian controls */}
        <div className="flex flex-col gap-6">
          <Card className="p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">Active rules</div>
            <dl className="mt-4 flex flex-col gap-3 text-[12.5px]">
              <RuleRow k="Per-tx cap" v={`${formatUsdc(config.perTxCap)} USDC`} />
              <RuleRow k="Daily cap" v={`${formatUsdc(config.dailyCap)} USDC`} />
              <RuleRow k="Timelock" v={`${config.timelockHours || "0"}h`} />
              <RuleRow
                k="Recipients"
                v={config.allowlist.length ? `${config.allowlist.length} allowlisted` : "Any (within caps)"}
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
              Your human safety brake — freeze all autonomous spending on-chain, signed by your wallet.
            </p>
            <div className="mt-4">
              <button
                onClick={onTogglePause}
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
              {pauseError && <p className="mt-2 text-[11.5px] leading-[1.4] text-[#ff8a84]">{pauseError}</p>}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function RunRow({ run }: { run: AgentRun }) {
  const [open, setOpen] = React.useState(false);
  const profit = Number(run.pnl) >= 0;
  return (
    <li className="border-b hairline last:border-0">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left hover:bg-paper-2/40">
        <div className="min-w-0">
          <div className="truncate text-[13px] text-ink">{run.query}</div>
          <div className="mt-0.5 text-[11.5px] text-muted-2">spent {formatUsdc(Number(run.cost) / 1e6)} USDC · earned {formatUsdc(Number(run.revenue) / 1e6)} USDC</div>
        </div>
        <span className={cx("shrink-0 font-mono text-[13px] tabular-nums", profit ? "text-accent-soft" : "text-[#ff8a84]")}>
          {profit ? "+" : "−"}{formatUsdc(Math.abs(Number(run.pnl)) / 1e6)}
        </span>
      </button>
      {open && (
        <div className="border-t hairline bg-paper/40 px-5 py-3">
          {(run.payments ?? []).map((p, i) => (
            <div key={p.transferId ?? i} className="flex items-center justify-between gap-3 py-1.5 text-[11.5px]">
              <span className="text-muted">
                {p.direction === "buy" ? "Paid" : "Received"} {formatUsdc(Number(p.amount) / 1e6)} USDC · {shortAddress(p.counterparty)}
              </span>
              <span className="font-mono text-muted-2">{p.transferId ? `settle ${p.transferId.slice(0, 8)}…` : p.status}</span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

function shortenErr(msg: string): string {
  // viem errors are verbose; surface just the first meaningful line.
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
        <span className={cx("text-[26px] font-medium tabular-nums", muted ? "text-muted-2" : "text-ink")}>
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
