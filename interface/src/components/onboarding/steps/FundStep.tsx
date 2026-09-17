"use client";

import { useEffect, useState } from "react";
import { AgentConfig, formatUsdc, shortAddress } from "../types";
import { StepNav } from "../OnboardingFlow";
import { useAuth } from "../AuthProvider";
import { useEntityFundPollQuery, useFundEntityMutation } from "@/lib/api/hooks";
import { usdcToAtomic } from "@/lib/api/spec";
import type { EntityView } from "@/lib/api/types";
import { txUrl } from "@/lib/chain";
import { FUND_TIMEOUT_COPY, fundPollOutcome } from "@/lib/onboarding/fundOutcome";
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

/**
 * `timeout` is the outcome this step was missing, and the reason it span forever twice in one week
 * (2026-09-14 and 2026-09-16). It means "we stopped watching", NOT "it failed": the transfer may
 * well have landed, and saying otherwise would send a founder to re-fund a treasury that is
 * already full. See `@/lib/onboarding/fundOutcome`.
 */
type FundStatus = "idle" | "pending" | "confirmed" | "error" | "timeout";

/** How often the elapsed clock is re-read while polling. The poll itself runs every 2.5s; this is
 *  a separate tick because a poll that keeps answering the same thing produces no re-render, and
 *  the timeout has to fire on wall-clock time rather than on a change in the data. */
const CLOCK_TICK_MS = 1_000;

/** Shown while the fund mutation is waiting on `login()` — the 2026-09-16 failure exactly: the
 *  session had expired, `ensureToken()` was blocked on a signature, and the MetaMask window was
 *  behind the browser. The spinner was honest about "busy" and silent about WHO we were waiting
 *  for. */
const WALLET_WAIT_COPY = "Waiting for your wallet: open MetaMask to sign in again.";

export function FundStep({
  eyebrow,
  config,
  entityId,
  entity,
  onEntity,
  onComplete,
}: {
  /** "Screen N" — counted over the phases THIS deployment shows. */
  eyebrow: string;
  config: AgentConfig;
  entityId: string | null;
  entity: EntityView | null;
  onEntity: (entity: EntityView) => void;
  onComplete: () => void;
}) {
  const { address, isConnected, isLoggingIn } = useAuth();
  const fundEntity = useFundEntityMutation();
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<FundStatus>(
    entity?.status === "funded" ? "confirmed" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [pollFunding, setPollFunding] = useState(false);
  /** When the current attempt's poll began. `null` means no attempt is being watched. */
  const [pollStartedAt, setPollStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fundPoll = useEntityFundPollQuery(entityId, pollFunding);

  // The parent's copy of the entity follows every answer, as before.
  useEffect(() => {
    if (fundPoll.data) onEntity(fundPoll.data);
  }, [fundPoll.data, onEntity]);

  // The clock, alive only while an attempt is being watched.
  useEffect(() => {
    if (!pollFunding) return;
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, [pollFunding]);

  // ONE place decides what the poll means, and it is a pure function with a table test
  // (`fundPollOutcome`). The three ways this used to end — confirmed, failed, or never — are now
  // four, and the fourth is the one that stops the spinner honestly.
  useEffect(() => {
    if (!pollFunding || pollStartedAt === null) return;
    const outcome = fundPollOutcome(fundPoll.data, now - pollStartedAt);
    if (outcome === "keep-polling") return;
    setPollFunding(false);
    if (outcome === "confirmed") {
      setStatus("confirmed");
      setError(null);
    } else if (outcome === "timeout") {
      setStatus("timeout");
      setError(null);
    } else {
      setStatus("error");
      setError(outcome.error);
    }
  }, [fundPoll.data, now, pollFunding, pollStartedAt]);

  const treasury = entity?.treasury;
  const amountNum = Number(amount);
  const amountValid = amount !== "" && !Number.isNaN(amountNum) && amountNum > 0;
  const busy = status === "pending" || fundEntity.isPending || pollFunding;
  const confirmed = status === "confirmed" || entity?.status === "funded";
  // A timeout leaves the button enabled: `busy` is false (nothing is in flight any more) and
  // `confirmed` is false, so the existing button comes back as the retry affordance.
  const timedOut = status === "timeout";
  const waitingForWallet = fundEntity.isPending && isLoggingIn;

  async function fund() {
    if (!entityId) return;
    setStatus("pending");
    setError(null);
    try {
      await fundEntity.mutateAsync({
        entityId,
        amountAtomic: usdcToAtomic(amount),
      });
      // The clock starts when the backend has accepted the request, so the 90 seconds measure the
      // on-chain wait rather than however long a wallet signature took.
      setPollStartedAt(Date.now());
      setNow(Date.now());
      setPollFunding(true);
    } catch (e) {
      setStatus("error");
      // `e` is an `ApiError` for anything the API answered or failed to answer — its message is
      // the backend's own error envelope (or, for a timeout, this client's sentence). Nothing raw
      // from a chain or an RPC reaches here.
      setError(e instanceof Error ? e.message : "Funding request failed.");
    }
  }

  return (
    <div>
      <StepHeader
        eyebrow={eyebrow}
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

              {/* We stopped watching; we did NOT decide. `warn`, not `alarm`, and no claim of
                  failure — the transfer may already have landed. */}
              {timedOut && (
                <Callout tone="warn" title="Still waiting">
                  {FUND_TIMEOUT_COPY}
                </Callout>
              )}

              {/* The 2026-09-16 spinner, explained: the request has not been sent yet because the
                  session expired and MetaMask is asking for a signature somewhere out of sight. */}
              {waitingForWallet && (
                <p className="flex items-center gap-2 text-[11.5px] text-[#f3cd72]">
                  <Spinner className="h-3.5 w-3.5" />
                  {WALLET_WAIT_COPY}
                </p>
              )}

              {!confirmed ? (
                <Button
                  size="lg"
                  onClick={() => void fund()}
                  loading={busy}
                  disabled={!amountValid || busy || !entityId}
                >
                  {busy ? "Funding treasury…" : timedOut ? "Retry funding" : "Fund treasury"}
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
