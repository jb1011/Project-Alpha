"use client";

import { useEffect, useState } from "react";
import { AgentTabs } from "@/components/agents/AgentTabs";
import { AmendmentVetoCard } from "@/components/agents/AmendmentVetoCard";
import { ExternalRecordCard } from "@/components/agents/ExternalRecordCard";
import { usePublicClient, useReadContract, useWriteContract } from "wagmi";
import {
  useEntityQuery,
  useEntityTreasuryQuery,
  useExecutePolicyUpdateMutation,
  usePatchPerTxCapMutation,
  usePatchTrustPolicyMutation,
  useSchedulePolicyUpdateMutation,
} from "@/lib/api/hooks";
import type { EntityView } from "@/lib/api/types";
import { arcTestnet } from "@/lib/chain";
import { usdcToAtomic } from "@/lib/api/spec";
import { treasuryAbi } from "@/lib/treasuryAbi";
import { computePolicyId } from "@/lib/treasury/policyId";
import { wireAllowlistEntries } from "@/lib/treasury/allowlist";
import { shortenErr } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import {
  Button,
  Callout,
  Card,
  Field,
  SectionTitle,
  TextInput,
  cx,
} from "@/components/onboarding/primitives";
import { formatUsdc, isAddress, shortAddress } from "@/components/onboarding/types";

/** How often the timelock is re-read while a scheduled policy change is waiting. The delay is
 *  hours long; a second is close enough, and is what the other clocks in this interface tick at. */
const TIMELOCK_TICK_MS = 1_000;

/** How long to wait before asking the treasury again when restoring a scheduled change failed. */
const RESTORE_RETRY_MS = 5_000;
/** …a bounded number of times: a read that keeps failing (a wallet on another chain) must not
 *  poll for as long as the record stands. A reload starts over. */
const RESTORE_MAX_RETRIES = 6;

type PendingPolicy = {
  policyId: `0x${string}`;
  cap: bigint;
  period: bigint;
  payoutAddress: `0x${string}`;
  allowlistEnabled: boolean;
  executableAt: bigint;
};

export function AgentSettings({ entityId }: { entityId: string }) {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const entityQuery = useEntityQuery(entityId);
  const treasuryQuery = useEntityTreasuryQuery(entityId);
  const patchPerTxCap = usePatchPerTxCapMutation(entityId);
  const patchTrustPolicy = usePatchTrustPolicyMutation(entityId);
  const schedulePolicyUpdate = useSchedulePolicyUpdateMutation(entityId);
  const executePolicyUpdate = useExecutePolicyUpdateMutation(entityId);

  const entity = entityQuery.data ?? null;
  /** What the load itself says went wrong, read off the query rather than copied into state, so
   *  it clears by itself when a refetch succeeds. `error` below is the actions' own. */
  const loadError = entityQuery.error
    ? entityQuery.error instanceof Error
      ? entityQuery.error.message
      : "Failed to load agent."
    : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingPolicy | null>(null);
  const [formInitialized, setFormInitialized] = useState(false);
  const [capSeeded, setCapSeeded] = useState(false);
  const [allowSeeded, setAllowSeeded] = useState(false);
  const [payoutSeeded, setPayoutSeeded] = useState(false);
  /** The schedule record the chain has already been asked about, keyed by its transaction (a
   *  policy id repeats when the same tuple is scheduled again), so each record is checked once
   *  rather than on every refetch. Also set when this tab vetoes or executes the change, so a
   *  node a block behind cannot bring it back. */
  const [checkedScheduleKey, setCheckedScheduleKey] = useState<string | null>(null);
  /** Bumped after a failed check, to ask the chain again a little later. */
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  /** The clock the timelock is read against, ticking only while a scheduled change waits. */
  const [now, setNow] = useState(() => Date.now());

  const [perTxCap, setPerTxCap] = useState("");
  const [trustPolicy, setTrustPolicy] = useState<string>("inherit");
  const [dailyCap, setDailyCap] = useState("");
  const [periodHours, setPeriodHours] = useState("24");
  const [allowlistOn, setAllowlistOn] = useState(false);
  const [payout, setPayout] = useState("");
  const [allowAddr, setAllowAddr] = useState("");
  const [newOperator, setNewOperator] = useState("");

  const treasury = entity?.treasury as `0x${string}` | undefined;

  const { data: onChainAllowlist } = useReadContract({
    address: treasury,
    abi: treasuryAbi,
    functionName: "allowlistEnabled",
    chainId: arcTestnet.id,
    query: { enabled: !!treasury },
  });

  const { data: payoutOnChain } = useReadContract({
    address: treasury,
    abi: treasuryAbi,
    functionName: "payoutAddress",
    chainId: arcTestnet.id,
    query: { enabled: !!treasury },
  });

  const refreshEntity = entityQuery.refetch;

  // The form is seeded from the stored agent once, the first time it is on hand, and never again:
  // a refetch after a save must not overwrite what the guardian is typing. Seeded during render
  // under a guard the seeding itself turns off, so the first frame that has the agent already
  // shows its values rather than an empty form an effect fills a frame later.
  if (entity && !formInitialized) {
    if (entity.perTxCap) setPerTxCap(String(Number(entity.perTxCap) / 1e6));
    setTrustPolicy(entity.trustPolicy ?? "inherit");
    setFormInitialized(true);
  }

  // Same once-only seed for the timelocked fields. They live on the treasury, not the entity, so
  // they arrive on their own reads. A later refetch must not wipe a cap the guardian is editing.
  const treasuryView = treasuryQuery.data ?? null;
  if (treasuryView && !capSeeded) {
    setCapSeeded(true);
    setDailyCap(String(Number(treasuryView.cap) / 1e6));
    setPeriodHours(String(Math.round(Number(treasuryView.period) / 3600)));
  }
  if (onChainAllowlist !== undefined && !allowSeeded) {
    setAllowSeeded(true);
    setAllowlistOn(onChainAllowlist);
  }
  if (payoutOnChain && !payoutSeeded) {
    setPayoutSeeded(true);
    setPayout(payoutOnChain);
  }

  // The timelock clock, alive only while a scheduled change is waiting. A poll whose answer has
  // not changed re-renders nothing, so without it the execute button would wait for whatever
  // render came next.
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(() => setNow(Date.now()), TIMELOCK_TICK_MS);
    return () => clearInterval(id);
  }, [pending]);

  useEffect(() => {
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

  // A change scheduled in another tab, or before a reload, is known to the backend (design
  // 2026-10-23, section 4.5) but not to this page's state. It is shown only once the treasury says
  // it is still pending, with every figure read from the chain: the backend's record is what was
  // sent, and a veto leaves it standing.
  const scheduled = entity?.scheduledPolicy ?? null;
  const scheduledId = scheduled?.policyId ?? null;
  const scheduledKey = scheduled ? `${scheduled.policyId}:${scheduled.txHash}` : null;
  useEffect(() => {
    if (!scheduledId || !scheduledKey || pending || !treasury || !publicClient) return;
    if (checkedScheduleKey === scheduledKey) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      try {
        const pp = await publicClient.readContract({
          address: treasury,
          abi: treasuryAbi,
          functionName: "pendingPolicy",
          args: [scheduledId],
        });
        if (cancelled) return;
        setCheckedScheduleKey(scheduledKey);
        if (pp[5])
          setPending({
            policyId: scheduledId,
            cap: pp[0],
            period: pp[1],
            payoutAddress: pp[2],
            allowlistEnabled: pp[3],
            executableAt: pp[4],
          });
      } catch {
        // Unchecked: ask again shortly, or a blip at load would hide the change (and its Veto
        // button) until a full reload.
        if (!cancelled && restoreAttempt < RESTORE_MAX_RETRIES)
          retry = setTimeout(() => setRestoreAttempt((n) => n + 1), RESTORE_RETRY_MS);
      }
    })();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [scheduledId, scheduledKey, pending, treasury, publicClient, checkedScheduleKey, restoreAttempt]);

  /** This tab just settled the change: its record must not be restored from a lagging read. */
  function markScheduleSettled(policyId: `0x${string}`) {
    if (scheduled && scheduled.policyId.toLowerCase() === policyId.toLowerCase())
      setCheckedScheduleKey(`${scheduled.policyId}:${scheduled.txHash}`);
  }

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
      const val = perTxCap.trim() === "" ? null : perTxCap.trim();
      await patchPerTxCap.mutateAsync(val);
    }, "Failed to update per-tx cap.");
  }

  async function onSaveTrustPolicy() {
    await runTx(async () => {
      await patchTrustPolicy.mutateAsync(
        trustPolicy === "inherit"
          ? null
          : (trustPolicy as "open" | "verified-sellers-only" | "verified-legal-bodies-only"),
      );
    }, "Failed to update the trust policy.");
  }

  async function onSchedulePolicy() {
    await runTx(async () => {
      const periodSeconds = Math.max(3600, Math.round(Number(periodHours) * 3600));
      const body = {
        capUsdc: dailyCap.trim(),
        periodSeconds,
        allowlistOn,
        payoutAddress: payout.trim(),
      };
      await schedulePolicyUpdate.mutateAsync(body);
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
      await executePolicyUpdate.mutateAsync(pending.policyId);
      markScheduleSettled(pending.policyId);
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
      markScheduleSettled(pending.policyId);
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
  const canExecute = pending !== null && now >= executableAt;

  if (!entity) {
    return loadError ? (
      <div className="py-12 text-[12px] text-[#ff8a84]">{loadError}</div>
    ) : (
      <div className="py-12 text-[13px] text-muted">Loading settings…</div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
        <h1 className="text-[28px] font-medium tracking-[-0.02em] text-ink">Governance settings</h1>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted">
          Change spending rules, manage the allowlist, and use guardian break-glass controls.
          Period-cap changes are timelocked; per-tx cap updates apply instantly.
        </p>
        </div>
        <AgentTabs entityId={entityId} active="settings" />
      </div>

      {entity.rootPasskeyId && (
        <Card className="p-5">
          <SectionTitle>Guardian passkey</SectionTitle>
          <p className="mt-1 text-[12px] text-muted-2">
            WebAuthn credential ID recorded at onboarding — the human approval anchor for this
            agent.
          </p>
          <code className="mt-3 block break-all rounded-lg bg-paper-2 px-3 py-2 font-mono text-[11px] text-ink">
            {entity.rootPasskeyId}
          </code>
        </Card>
      )}

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
              : `Executable ${formatDateTime(executableAt)}`}
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

      {/* Right under the pending change, so the guardian reads the record as part of the
          decision; shown with nothing pending too, so the record can be checked on its own. */}
      <ExternalRecordCard entityId={entityId} agentId={entity.agentId} />

      {/* Beside the treasury's pending-policy card, and deliberately a different kind of thing:
          that one is scheduled through this platform and executed through it, while this one is
          read straight off the chain and vetoed straight on it. */}
      <AmendmentVetoCard entity={entity} />

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
        <SectionTitle>Buyer trust policy</SectionTitle>
        <p className="mt-1 text-[12px] text-muted-2">
          Who this agent is willing to pay. Guardian-only — an agent can never loosen its own
          strictness through an API key.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Field label="Policy" className="min-w-[260px] flex-1">
            <select
              value={trustPolicy}
              onChange={(e) => setTrustPolicy(e.target.value)}
              className="w-full rounded-md border hairline bg-transparent px-3 py-2 text-[13px] text-ink"
            >
              <option value="inherit">Platform default</option>
              <option value="open">Open — pay any seller the on-chain policy allows</option>
              <option value="verified-sellers-only">
                Strict — only sellers vouched for in World&rsquo;s AgentBook
              </option>
              <option value="verified-legal-bodies-only">Strictest — only active Novi Corpus legal bodies</option>
            </select>
          </Field>
          <Button onClick={() => void onSaveTrustPolicy()} loading={busy}>
            Save
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <SectionTitle>Period cap (timelocked)</SectionTitle>
        <p className="mt-1 text-[12px] text-muted-2">
          Manager-signed on-chain change — schedule now, execute after the timelock. The fields
          start as the rule on chain now.
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

      {(error ?? loadError) && (
        <p className="text-[12px] text-[#ff8a84]">{error ?? loadError}</p>
      )}
    </div>
  );
}

