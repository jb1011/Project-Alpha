"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import {
  useCancelCompanyPaymentMutation,
  useCompanyPaymentQuery,
  usePublicConfigQuery,
  useRequoteCompanyPaymentMutation,
  useSettleCompanyPaymentMutation,
} from "@/lib/api/hooks";
import {
  FEE_BREAKDOWN,
  cancelTypedData,
  feeSentence,
  formatAtomicUsdc,
  paymentAction,
  paymentExplanation,
  toWagmiTypedData,
} from "@/lib/formation/payment";
import { StepNav } from "../OnboardingFlow";
import { AmberPill, Button, Callout, Card, CheckIcon, SectionTitle, Spinner, StepHeader } from "../primitives";

type Props = {
  eyebrow: string;
  companyId: string | null;
  onBack: () => void;
  onComplete: () => void;
};

/**
 * THE FORMATION FEE (design §6.1/§6.2) — the guardian signs, we submit, the receipt is the
 * settlement.
 *
 * This is the first place in the interface that signs TYPED DATA. Everything before it was
 * `personal_sign` (SIWE), which asks a wallet to sign a sentence; this asks one to authorize a
 * transfer of the holder's own USDC, and the difference is the whole reason the message is served
 * whole rather than assembled here. A client that built it would be a second place to get the
 * domain, the type list or the field ORDER wrong, and each of those produces a signature that
 * verifies against nothing and reverts on-chain after the guardian has approved it.
 *
 * ── THE ONE RULE THIS SCREEN ENFORCES ────────────────────────────────────────────────────────
 *
 * **One signature per quote.** The sign button exists only while the server is serving a live
 * quote; the moment a broadcast is in flight the server withholds it and this screen shows
 * "waiting" with no way to sign again. Signing twice while a transfer may still be mined is how a
 * guardian is charged 798 USDC for one company, and no amount of care in a click handler would
 * prevent it as reliably as not rendering the button.
 *
 * The exits, in the order a stuck guardian meets them: wait (the sweeper re-broadcasts the
 * persisted transaction), cancel (a SECOND signature, over a different message, which retires the
 * authorization on-chain), re-quote (a new nonce, only once nothing is live).
 */
export function PaymentStep({ eyebrow, companyId, onBack, onComplete }: Props) {
  const { address } = useAccount();
  const { data: config } = usePublicConfigQuery();
  const { data: payment, isLoading, isError, error, refetch } = useCompanyPaymentQuery(companyId);
  const settle = useSettleCompanyPaymentMutation(companyId ?? "");
  const cancel = useCancelCompanyPaymentMutation(companyId ?? "");
  const requote = useRequoteCompanyPaymentMutation(companyId ?? "");
  const { signTypedDataAsync } = useSignTypedData();
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * When this browser first SAW the payment enter `settling`.
   *
   * In memory and per-visit, deliberately: it drives one thing, whether the cancel button has
   * appeared yet, and a persisted timestamp would offer that button instantly on a reload — to
   * somebody whose transfer is one second old and about to confirm. Re-starting the clock on a
   * reload errs towards waiting, which is the safe direction.
   */
  const settlingSince = useRef<number | null>(null);
  useEffect(() => {
    if (payment?.status === "settling") settlingSince.current ??= Date.now();
    else settlingSince.current = null;
  }, [payment?.status]);

  const action = paymentAction(payment, {
    nowMs: Date.now(),
    settlingSinceMs: settlingSince.current ?? undefined,
  });
  const busy = settle.isPending || cancel.isPending || requote.isPending;

  async function onSign() {
    setProblem(null);
    const quote = payment?.quote;
    if (!quote || !address) return;
    try {
      const signature = await signTypedDataAsync(toWagmiTypedData(quote.typedData));
      // `from` is OUR connected address rather than anything off the quote: the backend checks it
      // against the company's guardian, so a mismatch is caught there. Sending the quote's own
      // `from` back would make this field decorative.
      await settle.mutateAsync({ signature, from: address });
    } catch (e) {
      // A wallet REJECTION is not a failure of the payment — nothing was submitted, the quote is
      // untouched, and the button is still there. Saying "payment failed" here would be a lie
      // about the guardian's own decision.
      setProblem(messageOf(e));
    }
  }

  async function onCancel() {
    setProblem(null);
    // No domain, no cancel: `paymentAction` does not offer one, and a deployment that has stopped
    // charging serves none (finding B8).
    if (!payment?.domain || !address) return;
    try {
      const signature = await signTypedDataAsync(
        cancelTypedData(payment.domain, address, payment.nonce),
      );
      await cancel.mutateAsync({ signature });
    } catch (e) {
      setProblem(messageOf(e));
    }
  }

  async function onRequote() {
    setProblem(null);
    try {
      await requote.mutateAsync();
    } catch (e) {
      setProblem(messageOf(e));
    }
  }

  // ⚠ NO COMPANY, NO FEE (finding B5). `visiblePhases` does not show this step without a company
  // handle, so this branch should be unreachable — which is exactly why it must not be a dead
  // end if the list and the session ever disagree (a restored session, a `/config` that arrives
  // late, a skipped legal-body step). A screen with no company has nothing to quote, nothing to
  // sign and no endpoint that would answer; it says so and lets the user carry on.
  if (!companyId)
    return (
      <div>
        <StepHeader
          eyebrow={eyebrow}
          title="No formation fee to pay"
          intro="This step is for a company's formation fee, and this agent has no company yet."
        />
        <Card>
          <p className="text-sm">
            You skipped the legal body, or it has not been created yet — so there is nothing owed
            and nothing to sign. You can add a company later from the Companies section.
          </p>
        </Card>
        <StepNav onBack={onBack}>
          <Button onClick={onComplete}>Continue</Button>
        </StepNav>
      </div>
    );

  return (
    <div>
      <StepHeader
        eyebrow={eyebrow}
        title="Pay the formation fee"
        intro="Your wallet authorizes a one-time USDC transfer. We submit it and pay the network fee; the receipt is what lets the filing start."
      />

      <Card>
        <SectionTitle>What you are paying</SectionTitle>
        <p className="mt-2 text-2xl font-semibold tabular-nums">
          {payment ? `$${formatAtomicUsdc(payment.amountUsdc)} USDC` : feeSentence(config)}
        </p>
        {/* The state fee is INSIDE the price, not added at checkout — and saying so is the one
            part of the total a reader can check against Wyoming's published schedule. */}
        <p className="mt-1 text-sm opacity-70">{FEE_BREAKDOWN}</p>

        {isLoading && (
          <p className="mt-4 flex items-center gap-2 text-sm opacity-70">
            <Spinner /> Reading your quote…
          </p>
        )}

        {isError && (
          <Callout tone="warn" className="mt-4">
            <p>We could not read this company&apos;s payment. Nothing has been charged.</p>
            <p className="mt-1 text-sm opacity-80">{messageOf(error)}</p>
            <Button variant="subtle" className="mt-3" onClick={() => void refetch()}>
              Try again
            </Button>
          </Callout>
        )}

        {payment && (
          <div className="mt-4">
            <p className="text-sm">{paymentExplanation(payment)}</p>
            {action === "wait" && (
              <p className="mt-3 flex items-center gap-2 text-sm opacity-70">
                <Spinner /> Waiting for the transfer to confirm…
              </p>
            )}
            {action === "done" && payment.status === "settled" && (
              <p className="mt-3 flex items-center gap-2 text-sm">
                <CheckIcon /> Paid
              </p>
            )}
            {action === "unknown" && (
              // A status this build does not know is AMBER and inert. The alternative — guessing
              // which button belongs to it — is how a newer backend gets a wrong action offered.
              <AmberPill className="mt-3">
                This payment is in a state this page does not recognise. Refresh, or check the
                Companies section.
              </AmberPill>
            )}
          </div>
        )}

        {problem && (
          <Callout tone="warn" className="mt-4">
            {problem}
          </Callout>
        )}
      </Card>

      {payment?.quote && action === "sign" && (
        <Card className="mt-4">
          <SectionTitle>What your wallet will show</SectionTitle>
          {/* The four facts the signature commits to, in the order the wallet lists them. A
              guardian should be able to read this panel and the wallet prompt side by side. */}
          <dl className="mt-2 grid gap-1 text-sm">
            <Row label="Amount" value={`${formatAtomicUsdc(payment.quote.amountUsdc)} USDC`} />
            <Row label="To" value={payment.quote.payTo} mono />
            <Row label="From" value={address ?? "—"} mono />
            {/* THE QUOTE's deadline, not the token's. The signature stays valid a little longer
                (the settlement grace, so a last-second signature can still be mined), but this is
                the moment we stop offering it — promising the later time would be promising
                minutes the settle door refuses. */}
            <Row
              label="Quote valid until"
              value={new Date(payment.quote.expiresAt * 1000).toLocaleString()}
            />
          </dl>
        </Card>
      )}

      <StepNav onBack={onBack}>
        {action === "sign" && (
          <Button onClick={() => void onSign()} disabled={busy || !address}>
            {settle.isPending ? "Submitting…" : "Sign and pay"}
          </Button>
        )}
        {action === "cancel" && (
          <Button variant="subtle" onClick={() => void onCancel()} disabled={busy}>
            {cancel.isPending ? "Cancelling…" : "Cancel this payment"}
          </Button>
        )}
        {action === "requote" && (
          <Button onClick={() => void onRequote()} disabled={busy}>
            {requote.isPending ? "Requesting…" : "Request a new quote"}
          </Button>
        )}
        {action === "done" && <Button onClick={onComplete}>Continue</Button>}
      </StepNav>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <dt className="opacity-70">{label}</dt>
      <dd className={mono ? "font-mono text-xs break-all" : "tabular-nums"}>{value}</dd>
    </div>
  );
}

/** A wallet rejection, an RPC failure and an API refusal all arrive as different shapes. One
 *  reader, so no branch renders `[object Object]` at a guardian. */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "Something went wrong.";
}
