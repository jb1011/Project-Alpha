"use client";

import { useEffect, useRef, useState } from "react";
import { usePublicClient, useWriteContract } from "wagmi";
import { StepNav } from "../OnboardingFlow";
import { useAuth } from "../AuthProvider";
import { deployStepIndex, pollEntity } from "@/lib/api/poll";
import type { EntityStatus, EntityView } from "@/lib/api/types";
import { arcTestnet, txUrl } from "@/lib/chain";
import { wireAllowlistEntries } from "@/lib/treasury/allowlist";
import type { AgentConfig } from "../types";
import {
  Button,
  Callout,
  Card,
  CheckIcon,
  ExternalIcon,
  Spinner,
  StepHeader,
  cx,
} from "../primitives";

type UiStatus = "pending" | "active" | "confirmed" | "failed";

type ChainStep = {
  n: string;
  title: string;
  desc: string;
  kind: "vault" | "tx" | "signature";
  statusKey: EntityStatus;
  txField?: keyof Pick<EntityView, "createTxHash" | "bindTxHash">;
};

const STEPS: ChainStep[] = [
  {
    n: "01",
    title: "Provision the agent key",
    desc: "Create the agent's signing key inside the vault with delegated access.",
    kind: "vault",
    statusKey: "provisioned",
  },
  {
    n: "02",
    title: "Register identity on-chain",
    desc: "Enroll the agent in the Arc identity registry.",
    kind: "tx",
    statusKey: "translating",
  },
  {
    n: "03",
    title: "Deploy & wire the contracts",
    desc: "Deploy treasury and governance, inscribe the policy, and record you as guardian.",
    kind: "tx",
    statusKey: "created",
    txField: "createTxHash",
  },
  {
    n: "04",
    title: "Bind the key to the treasury",
    desc: "Link the agent's key to its treasury. Your agent is ready to act.",
    kind: "signature",
    statusKey: "bound",
    txField: "bindTxHash",
  },
];

function stepUiStatus(stepIdx: number, entity: EntityView | null): UiStatus {
  if (!entity) return stepIdx === 0 ? "active" : "pending";
  const progress = deployStepIndex(entity.status, entity);
  if (entity.status === "failed" && stepIdx === progress) return "failed";
  if (progress >= 4 || stepIdx < progress) return "confirmed";
  if (stepIdx === progress) return "active";
  return "pending";
}

export function DeployStep({
  entityId,
  config,
  onEntity,
  onComplete,
}: {
  entityId: string | null;
  config: AgentConfig;
  onEntity: (entity: EntityView) => void;
  onComplete: () => void;
}) {
  const { ensureSession } = useAuth();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [entity, setEntity] = useState<EntityView | null>(null);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wiringAllowlist, setWiringAllowlist] = useState(false);

  const onEntityRef = useRef(onEntity);
  const ensureSessionRef = useRef(ensureSession);

  useEffect(() => {
    onEntityRef.current = onEntity;
    ensureSessionRef.current = ensureSession;
  }, [onEntity, ensureSession]);

  useEffect(() => {
    if (!entityId) return;
    let cancelled = false;

    (async () => {
      setPolling(true);
      setError(null);
      try {
        const auth = await ensureSessionRef.current();
        const result = await pollEntity(auth.token, entityId, {
          onUpdate: (e) => {
            if (!cancelled) {
              setEntity(e);
              onEntityRef.current(e);
            }
          },
        });
        if (!cancelled) {
          setEntity(result);
          onEntityRef.current(result);
          if (result.status === "failed") {
            setError(result.error ?? "Onboarding failed.");
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Failed to poll entity status.",
          );
        }
      } finally {
        if (!cancelled) setPolling(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [entityId]);

  const allDone = entity?.status === "bound" || entity?.status === "funded";
  const hasFailure = entity?.status === "failed";
  const allowlistAddrs = config.allowlist
    .map((e) => e.address.trim())
    .filter((a) => a.length > 0);
  const confirmedCount = STEPS.filter(
    (_, i) => stepUiStatus(i, entity) === "confirmed",
  ).length;

  async function handleContinue() {
    if (!entity?.treasury || allowlistAddrs.length === 0) {
      onComplete();
      return;
    }
    if (!publicClient) {
      setError("Wallet client not ready — try again.");
      return;
    }
    setWiringAllowlist(true);
    setError(null);
    try {
      await wireAllowlistEntries({
        treasury: entity.treasury as `0x${string}`,
        addresses: allowlistAddrs,
        writeContractAsync,
        publicClient,
      });
      onComplete();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Failed to set allowlist entries — confirm with your guardian wallet.",
      );
    } finally {
      setWiringAllowlist(false);
    }
  }

  if (!entityId) {
    return (
      <Callout tone="warn" title="No entity to deploy">
        Go back and confirm the operating agreement to start deployment.
      </Callout>
    );
  }

  return (
    <div>
      <StepHeader
        eyebrow="Screens 03 – 06"
        title="Deploying on-chain"
        intro="The backend is provisioning keys, registering identity, deploying contracts, and binding the agent wallet. This usually takes a few minutes."
      />

      <div className="mb-6 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-paper-2">
          <div
            className="h-full rounded-full bg-accent transition-all duration-500"
            style={{ width: `${(confirmedCount / STEPS.length) * 100}%` }}
          />
        </div>
        <span className="text-[12px] tabular-nums text-muted-2">
          {confirmedCount}/{STEPS.length}
        </span>
      </div>

      {entity && (
        <div className="mb-4 text-[12px] text-muted-2">
          Status: <span className="text-ink">{entity.status}</span>
          {entity.agentId && <> · agent #{entity.agentId}</>}
        </div>
      )}

      <ol className="flex flex-col">
        {STEPS.map((step, i) => (
          <ChainRow
            key={step.n}
            step={step}
            status={stepUiStatus(i, entity)}
            txHash={step.txField && entity ? entity[step.txField] : null}
            failureMessage={
              entity?.status === "failed" &&
              stepUiStatus(i, entity) === "failed"
                ? entity.error
                : null
            }
          />
        ))}
      </ol>

      {polling && !allDone && !hasFailure && (
        <Card className="mt-6 flex items-center gap-3 p-4 text-[12.5px] text-muted">
          <Spinner className="h-4 w-4 text-accent-soft" />
          Waiting for the backend…
        </Card>
      )}

      {hasFailure && (
        <Callout tone="warn" className="mt-6" title="Deployment failed">
          {error ?? entity?.error ?? "An error occurred during onboarding."}
        </Callout>
      )}

      {allDone && (
        <Callout tone="accent" className="mt-6" title="All contracts live">
          Your agent&apos;s identity, treasury, and governance are deployed and
          wired. Next: fund the treasury.
          {entity?.treasury && (
            <div className="mt-2 font-mono text-[11px] text-muted">
              Treasury: {entity.treasury}
            </div>
          )}
        </Callout>
      )}

      {allDone && allowlistAddrs.length > 0 && (
        <Callout tone="accent" className="mt-4" title="Allowlist setup">
          {allowlistAddrs.length} recipient
          {allowlistAddrs.length > 1 ? "s" : ""} will be registered on-chain when you continue
          (one guardian-signed transaction per address).
        </Callout>
      )}

      {error && !hasFailure && (
        <Callout tone="warn" className="mt-6" title="Error">
          {error}
        </Callout>
      )}

      <StepNav>
        <Button onClick={() => void handleContinue()} disabled={!allDone || wiringAllowlist}>
          {wiringAllowlist ? (
            <>
              <Spinner className="h-4 w-4" /> Setting allowlist…
            </>
          ) : (
            <>
              Continue to funding
              <CheckIcon className="h-4 w-4" />
            </>
          )}
        </Button>
      </StepNav>
    </div>
  );
}

function ChainRow({
  step,
  status,
  txHash,
  failureMessage,
}: {
  step: ChainStep;
  status: UiStatus;
  txHash: string | null;
  failureMessage?: string | null;
}) {
  const isTx = step.kind !== "vault";
  return (
    <li className="relative flex gap-4 py-3">
      <span
        className={cx(
          "relative z-10 mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors",
          status === "confirmed" && "border-accent/50 bg-accent text-paper",
          status === "active" && "border-accent bg-accent/15 text-accent-soft",
          status === "failed" &&
            "border-[#ff5f57]/50 bg-[#ff5f57]/12 text-[#ff8a84]",
          status === "pending" && "hairline-strong bg-paper text-muted-2",
        )}
      >
        {status === "confirmed" ? (
          <CheckIcon className="h-4 w-4" />
        ) : status === "active" ? (
          <Spinner className="h-4 w-4" />
        ) : status === "failed" ? (
          <span className="text-[15px] leading-none">!</span>
        ) : (
          <span className="text-[11px] tabular-nums">{step.n}</span>
        )}
      </span>

      <div
        className={cx(
          "min-w-0 flex-1 rounded-xl border px-4 py-3 transition-colors",
          status === "active"
            ? "border-accent/30 bg-accent/[0.05]"
            : status === "failed"
              ? "border-[#ff5f57]/30 bg-[#ff5f57]/[0.04]"
              : "hairline bg-paper-2/40",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13.5px] font-medium text-ink">
                {step.title}
              </span>
              <StatusPill status={status} />
            </div>
            <p className="mt-1 text-[12px] leading-[1.5] text-muted">
              {step.desc}
            </p>
          </div>
        </div>

        {txHash && (status === "active" || status === "confirmed") && isTx && (
          <a
            href={txUrl(txHash)}
            target="_blank"
            rel="noreferrer"
            className="mt-2.5 inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-2 transition-colors hover:text-accent-soft"
          >
            tx {txHash.slice(0, 10)}…{txHash.slice(-6)}
            <ExternalIcon className="h-3 w-3" />
          </a>
        )}

        {status === "failed" && failureMessage && (
          <p className="mt-2.5 text-[11.5px] leading-[1.45] text-[#ff8a84]">
            {failureMessage}
          </p>
        )}
      </div>
    </li>
  );
}

function StatusPill({ status }: { status: UiStatus }) {
  const map = {
    pending: { label: "Queued", cls: "text-muted-2 border-line-strong" },
    active: {
      label: "In progress",
      cls: "text-accent-soft border-accent/30 bg-accent/10",
    },
    confirmed: { label: "Confirmed", cls: "text-accent-soft border-accent/30" },
    failed: {
      label: "Failed",
      cls: "text-[#ff8a84] border-[#ff5f57]/30 bg-[#ff5f57]/10",
    },
  } as const;
  const s = map[status];
  return (
    <span
      className={cx(
        "shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-[0.1em]",
        s.cls,
      )}
    >
      {s.label}
    </span>
  );
}
