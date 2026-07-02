"use client";

import * as React from "react";
import { usePublicClient, useReadContract, useWriteContract } from "wagmi";
import {
  executePolicyUpdate,
  getEntity,
  patchPerTxCap,
  schedulePolicyUpdate,
} from "@/lib/api/client";
import type { EntityView } from "@/lib/api/types";
import { arcTestnet } from "@/lib/chain";
import { usdcToAtomic } from "@/lib/api/spec";
import { treasuryAbi } from "@/lib/treasuryAbi";
import { computePolicyId } from "@/lib/treasury/policyId";
import { wireAllowlistEntries } from "@/lib/treasury/allowlist";
import { useAuth } from "@/components/onboarding/AuthProvider";
import {
  Button,
  Callout,
  Card,
  Field,
  TextInput,
  cx,
} from "@/components/onboarding/primitives";
import { formatUsdc, isAddress, shortAddress } from "@/components/onboarding/types";

type PendingPolicy = {
  policyId: `0x${string}`;
  cap: bigint;
  period: bigint;
  payoutAddress: `0x${string}`;
  allowlistEnabled: boolean;
  executableAt: bigint;
};

export function AgentSettings({ entityId }: { entityId: string }) {
  const { ensureSession } = useAuth();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [entity, setEntity] = React.useState<EntityView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<PendingPolicy | null>(null);

  const [perTxCap, setPerTxCap] = React.useState("");
  const [dailyCap, setDailyCap] = React.useState("");
  const [periodHours, setPeriodHours] = React.useState("24");
  const [allowlistOn, setAllowlistOn] = React.useState(false);
  const [payout, setPayout] = React.useState("");
  const [allowAddr, setAllowAddr] = React.useState("");
  const [newOperator, setNewOperator] = React.useState("");

  const treasury = entity?.treasury as `0x${string}` | undefined;

  const { data: onChainAllowlist } = useReadContract({
    address: treasury,
    abi: treasuryAbi,
    functionName: "allowlistEnabled",
    chainId: arcTestnet.id,
    query: { enabled: !!treasury },
  });

  const refreshEntity = React.useCallback(async () => {
    const auth = await ensureSession();
    const e = await getEntity(auth.token, entityId);
    setEntity(e);
    if (e.perTxCap) setPerTxCap(String(Number(e.perTxCap) / 1e6));
  }, [ensureSession, entityId]);

  React.useEffect(() => {
    void refreshEntity().catch((e) =>
      setError(e instanceof Error ? e.message : "Failed to load agent."),
    );
  }, [refreshEntity]);

  React.useEffect(() => {
    if (!pending?.policyId || !treasury || !publicClient) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const pp = await publicClient.readContract({
          address: treasury,
          abi: treasuryAbi,
          functionName: "pendingPolicy",
          args: [pending.policyId],
        });
        if (!cancelled && !pp[5]) setPending(null);
      } catch {
        /* ignore */
      }
    };
    const h = setInterval(() => void poll(), 8000);
    return () => {
      cancelled = true;
      clearInterval(h);
    };
  }, [pending, treasury, publicClient]);

  async function runTx(
    fn: () => Promise<void>,
    fallback = "Transaction failed — is this the guardian wallet?",
  ) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refreshEntity();
    } catch (e) {
      setError(e instanceof Error ? shortenErr(e.message) : fallback);
    } finally {
      setBusy(false);
    }
  }

  async function onSavePerTxCap() {
    await runTx(async () => {
      const auth = await ensureSession();
      const val = perTxCap.trim() === "" ? null : perTxCap.trim();
      await patchPerTxCap(auth.token, entityId, val);
    }, "Failed to update per-tx cap.");
  }

  async function onSchedulePolicy() {
    await runTx(async () => {
      const auth = await ensureSession();
      const periodSeconds = Math.max(3600, Math.round(Number(periodHours) * 3600));
      const body = {
        capUsdc: dailyCap.trim(),
        periodSeconds,
        allowlistOn,
        payoutAddress: payout.trim(),
      };
      await schedulePolicyUpdate(auth.token, entityId, body);
      const policyId = computePolicyId({
        newCap: BigInt(usdcToAtomic(dailyCap.trim())),
        newPeriod: BigInt(periodSeconds),
        allowlistOn,
        newPayout: payout.trim() as `0x${string}`,
      });
      if (publicClient && treasury) {
        const pp = await publicClient.readContract({
          address: treasury,
          abi: treasuryAbi,
          functionName: "pendingPolicy",
          args: [policyId],
        });
        if (pp[5]) {
          setPending({
            policyId,
            cap: pp[0],
            period: pp[1],
            payoutAddress: pp[2],
            allowlistEnabled: pp[3],
            executableAt: pp[4],
          });
        }
      }
    }, "Failed to schedule policy update.");
  }

  async function onExecutePolicy() {
    if (!pending) return;
    await runTx(async () => {
      const auth = await ensureSession();
      await executePolicyUpdate(auth.token, entityId, pending.policyId);
      setPending(null);
    }, "Failed to execute policy update.");
  }

  async function onVeto() {
    if (!pending || !treasury || !publicClient) return;
    await runTx(async () => {
      const hash = await writeContractAsync({
        address: treasury,
        abi: treasuryAbi,
        functionName: "vetoPolicyUpdate",
        args: [pending.policyId],
        chainId: arcTestnet.id,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setPending(null);
    });
  }

  async function onAddAllowlist() {
    if (!treasury || !publicClient || !isAddress(allowAddr)) return;
    await runTx(async () => {
      await wireAllowlistEntries({
        treasury,
        addresses: [allowAddr.trim()],
        writeContractAsync,
        publicClient,
      });
      setAllowAddr("");
    });
  }

  async function onEmergencyWithdraw() {
    if (!treasury || !publicClient) return;
    if (!window.confirm("Emergency withdraw sweeps the entire treasury to the payout address. Continue?")) {
      return;
    }
    await runTx(async () => {
      const hash = await writeContractAsync({
        address: treasury,
        abi: treasuryAbi,
        functionName: "emergencyWithdraw",
        chainId: arcTestnet.id,
      });
      await publicClient.waitForTransactionReceipt({ hash });
    });
  }

  async function onRotateOperator() {
    if (!treasury || !publicClient || !isAddress(newOperator)) return;
    await runTx(async () => {
      const hash = await writeContractAsync({
        address: treasury,
        abi: treasuryAbi,
        functionName: "setOperator",
        args: [newOperator.trim() as `0x${string}`],
        chainId: arcTestnet.id,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      setNewOperator("");
    });
  }

  const executableAt = pending ? Number(pending.executableAt) * 1000 : 0;
  const canExecute = pending && Date.now() >= executableAt;

  if (!entity) {
    return <div className="py-12 text-[13px] text-muted">Loading settings…</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[28px] font-medium tracking-[-0.02em] text-ink">Governance settings</h1>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted">
          Change spending rules, manage the allowlist, and use guardian break-glass controls.
          Period-cap changes are timelocked; per-tx cap updates apply instantly.
        </p>
      </div>

      {pending && (
        <Callout tone="warn" title="Pending policy change">
          <p className="text-[12px] text-muted">
            New cap {formatUsdc(Number(pending.cap) / 1e6)} USDC · period{" "}
            {Math.round(Number(pending.period) / 3600)}h · allowlist{" "}
            {pending.allowlistEnabled ? "on" : "off"} · payout {shortAddress(pending.payoutAddress)}
          </p>
          <p className="mt-1 text-[12px] text-muted-2">
            {canExecute
              ? "Timelock elapsed — you can execute the change."
              : `Executable ${new Date(executableAt).toLocaleString()}`}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="md"
              disabled={!canExecute || busy}
              loading={busy}
              onClick={() => void onExecutePolicy()}
            >
              Execute policy
            </Button>
            <Button variant="danger" size="md" disabled={busy} onClick={() => void onVeto()}>
              Veto change
            </Button>
          </div>
        </Callout>
      )}

      <Card className="p-5">
        <SectionTitle>Per-transaction cap (instant)</SectionTitle>
        <p className="mt-1 text-[12px] text-muted-2">
          Off-chain guardrail enforced by the payment authority. No timelock.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Per-tx cap (USDC)" className="min-w-[200px] flex-1">
            <TextInput
              value={perTxCap}
              onChange={(e) => setPerTxCap(e.target.value)}
              placeholder="e.g. 0.50"
            />
          </Field>
          <Button onClick={() => void onSavePerTxCap()} loading={busy}>
            Save
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle>Period cap (timelocked)</SectionTitle>
        <p className="mt-1 text-[12px] text-muted-2">
          Manager-signed on-chain change — schedule now, execute after the timelock.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Rolling cap (USDC)">
            <TextInput value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} placeholder="e.g. 100" />
          </Field>
          <Field label="Period (hours)">
            <TextInput
              value={periodHours}
              onChange={(e) => setPeriodHours(e.target.value)}
              placeholder="24"
            />
          </Field>
          <Field label="Payout address">
            <TextInput value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="0x…" />
          </Field>
          <label className="flex items-center gap-2 pt-6 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={allowlistOn}
              onChange={(e) => setAllowlistOn(e.target.checked)}
              className="rounded border hairline-strong"
            />
            Require allowlist for spending
          </label>
        </div>
        <Button className="mt-4" onClick={() => void onSchedulePolicy()} loading={busy}>
          Schedule policy update
        </Button>
      </Card>

      <Card className="p-5">
        <SectionTitle>Allowlist</SectionTitle>
        <p className="mt-1 text-[12px] text-muted-2">
          On-chain: {onChainAllowlist ? "enabled" : "disabled or unrestricted"} · guardian-signed
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Add address" className="min-w-[240px] flex-1">
            <TextInput
              value={allowAddr}
              onChange={(e) => setAllowAddr(e.target.value)}
              placeholder="0x…"
            />
          </Field>
          <Button
            variant="ghost"
            disabled={!isAddress(allowAddr) || busy}
            onClick={() => void onAddAllowlist()}
          >
            Add
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle>Break-glass</SectionTitle>
        <div className="mt-4 flex flex-col gap-4">
          <div>
            <Button variant="danger" disabled={busy || !treasury} onClick={() => void onEmergencyWithdraw()}>
              Emergency withdraw
            </Button>
            <p className="mt-1 text-[11.5px] text-muted-2">
              Sweeps the full treasury balance to the payout address.
            </p>
          </div>
          <div className="border-t hairline pt-4">
            <Field label="Rotate operator (advanced)">
              <TextInput
                value={newOperator}
                onChange={(e) => setNewOperator(e.target.value)}
                placeholder="0x…"
              />
            </Field>
            <Button
              variant="ghost"
              className="mt-3"
              disabled={!isAddress(newOperator) || busy}
              onClick={() => void onRotateOperator()}
            >
              Set operator
            </Button>
          </div>
        </div>
      </Card>

      {error && <p className="text-[12px] text-[#ff8a84]">{error}</p>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">{children}</div>
  );
}

function shortenErr(msg: string): string {
  const first = msg.split("\n")[0]?.trim() ?? "Transaction failed.";
  return first.length > 140 ? `${first.slice(0, 140)}…` : first;
}
