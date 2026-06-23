"use client";

import * as React from "react";
import { AgentConfig, formatUsdc, shortAddress } from "../types";
import { StepNav } from "../OnboardingFlow";
import { useAuth } from "../AuthProvider";
import { fundEntity } from "@/lib/api/client";
import { pollEntity } from "@/lib/api/poll";
import { usdcToAtomic } from "@/lib/api/spec";
import type { EntityView } from "@/lib/api/types";
import { txUrl } from "@/lib/chain";
import {
  Button,
  Callout,
  Card,
  CheckIcon,
  ExternalIcon,
  KeyIcon,
  Spinner,
  StepHeader,
} from "../primitives";

type FundStatus = "idle" | "pending" | "confirmed" | "error";

export function FundStep({
  config,
  entityId,
  entity,
  onEntity,
  onComplete,
}: {
  config: AgentConfig;
  entityId: string | null;
  entity: EntityView | null;
  onEntity: (entity: EntityView) => void;
  onComplete: () => void;
}) {
  const { ensureSession, address, isConnected } = useAuth();
  const [amount, setAmount] = React.useState("");
  const [status, setStatus] = React.useState<FundStatus>(
    entity?.status === "funded" ? "confirmed" : "idle",
  );
  const [error, setError] = React.useState<string | null>(null);

  const treasury = entity?.treasury;
  const amountNum = Number(amount);
  const amountValid = amount !== "" && !Number.isNaN(amountNum) && amountNum > 0;
  const busy = status === "pending";
  const confirmed = status === "confirmed" || entity?.status === "funded";

  async function fund() {
    if (!entityId) return;
    setStatus("pending");
    setError(null);
    try {
      const auth = await ensureSession();
      await fundEntity(auth.token, entityId, usdcToAtomic(amount));
      const result = await pollEntity(auth.token, entityId, {
        until: ["funded", "failed"],
        onUpdate: onEntity,
      });
      onEntity(result);
      if (result.status === "funded") {
        setStatus("confirmed");
      } else {
        setStatus("error");
        setError(result.error ?? "Funding failed.");
      }
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Funding request failed.");
    }
  }

  return (
    <div>
      <StepHeader
        eyebrow="Screen 07"
        title="Fund your agent's treasury"
        intro="The backend transfers USDC from the platform wallet into your agent's on-chain treasury. Enter the amount to fund."
      />

      <Callout
        tone="warn"
        className="mb-7"
        icon={<KeyIcon className="h-4 w-4" />}
        title="Backend-funded treasury"
      >
        On this testnet demo, funding is initiated via the backend API. The
        platform wallet sends USDC to your agent&apos;s treasury contract.
      </Callout>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_300px] lg:gap-10">
        <Card className="p-6">
          {!isConnected || !address ? (
            <div className="flex flex-col items-start gap-4">
              <div>
                <h3 className="text-[15px] font-medium text-ink">Wallet session required</h3>
                <p className="mt-1 text-[13px] text-muted">
                  Your wallet session must still be active from sign-in.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-between rounded-xl border hairline bg-paper px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <span className="h-2 w-2 rounded-full bg-accent" />
                  <span className="font-mono text-[12.5px] text-ink">
                    {shortAddress(address)}
                  </span>
                </div>
                <span className="text-[12px] text-muted-2">Guardian</span>
              </div>

              <div>
                <label htmlFor="fund-amount" className="text-[12.5px] font-medium text-ink">
                  Amount to fund
                </label>
                <div className="relative mt-1.5">
                  <input
                    id="fund-amount"
                    type="number"
                    min={0}
                    inputMode="decimal"
                    placeholder="0.00"
                    disabled={busy || confirmed}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full rounded-xl border hairline-strong bg-paper-2/80 px-3.5 py-3 pr-16 text-[20px] tabular-nums text-ink placeholder:text-muted-2 focus:outline-none focus:ring-2 focus:ring-accent/45 disabled:opacity-60"
                  />
                  <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[12px] text-muted-2">
                    USDC
                  </span>
                </div>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {[25, 50, 100].map((v) => (
                    <button
                      key={v}
                      disabled={busy || confirmed}
                      onClick={() => setAmount(String(v))}
                      className="rounded-full border hairline-strong px-3 py-1 text-[11.5px] text-muted transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-50"
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              {error && (
                <p className="text-[11.5px] text-[#ff8a84]">{error}</p>
              )}

              {!confirmed ? (
                <Button
                  size="lg"
                  onClick={fund}
                  loading={busy}
                  disabled={!amountValid || busy || !entityId}
                >
                  {busy ? "Funding treasury…" : "Fund treasury"}
                </Button>
              ) : (
                <div className="rounded-xl border border-accent/30 bg-accent/[0.06] px-4 py-4">
                  <div className="flex items-center gap-2.5 text-accent-soft">
                    <CheckIcon className="h-4 w-4" />
                    <span className="text-[14px] font-medium">
                      {formatUsdc(amount || "0")} USDC funded
                    </span>
                  </div>
                  {entity?.fundTxHash && (
                    <a
                      href={txUrl(entity.fundTxHash)}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted hover:text-accent-soft"
                    >
                      View fund tx <ExternalIcon className="h-3 w-3" />
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-5 lg:sticky lg:top-24 lg:self-start">
          <Card className="p-5">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-2">
              Treasury
            </div>
            <div className="mt-2 font-mono text-[13px] text-ink">
              {treasury ? shortAddress(treasury) : "—"}
            </div>
            <div className="mt-4 flex items-baseline gap-2">
              <span className="text-[28px] font-medium tabular-nums text-ink">
                {confirmed ? formatUsdc(amount) : "0.00"}
              </span>
              <span className="text-[13px] text-muted-2">USDC</span>
            </div>
            <div className="mt-1 text-[11.5px] text-muted-2">
              {config.name || "Your agent"} · Arc
            </div>
          </Card>

          {busy && (
            <Card className="flex items-center gap-3 p-4 text-[12.5px] text-muted">
              <Spinner className="h-4 w-4 text-accent-soft" />
              Waiting for on-chain confirmation…
            </Card>
          )}
        </div>
      </div>

      <StepNav>
        <Button onClick={onComplete} disabled={!confirmed}>
          Open dashboard
          <CheckIcon className="h-4 w-4" />
        </Button>
      </StepNav>
    </div>
  );
}
