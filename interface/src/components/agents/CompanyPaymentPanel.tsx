"use client";

import { Button, Callout, Card, SectionTitle, Spinner } from "@/components/onboarding/primitives";
import { FEE_BREAKDOWN, formatAtomicUsdc, paymentExplanation } from "@/lib/formation/payment";
import { useFormationPayment } from "@/lib/formation/useFormationPayment";

/**
 * THE FORMATION FEE, on the Companies page (design §7 "Companies section": payment state + the
 * same actions).
 *
 * The SAME CONTROLLER the wizard's `PaymentStep` uses — `useFormationPayment` (finding C3) — and
 * that sharing is the point rather than an economy. Two components deciding for themselves
 * whether a payment may be signed is how a page ends up offering "pay" for a transfer that is
 * already in flight, which is a guardian charged twice.
 *
 * It renders NOTHING at all where there is no payment: the query 404s on a company that owes
 * nothing, and a section that appeared empty would tell every owner in the beta that this system
 * takes money.
 */
export function CompanyPaymentPanel({ companyId }: { companyId: string }) {
  const p = useFormationPayment(companyId);
  const { payment, action, busy, problem, address } = p;

  // A 404 is the ordinary answer here (no payment, or a box that does not charge), and it must
  // render nothing rather than an error: an owner in the beta has no fee and no reason to read
  // about one.
  if (p.isError || !payment) return null;

  return (
    <Card>
      <SectionTitle>Formation fee</SectionTitle>
      <p className="mt-2 text-lg font-medium tabular-nums">
        ${formatAtomicUsdc(payment.amountUsdc)} USDC
      </p>
      <p className="mt-1 text-[12.5px] text-muted-2">{FEE_BREAKDOWN}</p>
      <p className="mt-3 text-sm">{paymentExplanation(payment)}</p>

      {payment.txHash && (
        <p className="mt-2 font-mono text-[11px] break-all text-muted-2">{payment.txHash}</p>
      )}
      {payment.refundTxHash && (
        <p className="mt-1 text-[12.5px] text-muted-2">
          Refunded — <span className="font-mono break-all">{payment.refundTxHash}</span>
        </p>
      )}

      {action === "wait" && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-2">
          <Spinner /> Waiting for confirmation…
        </p>
      )}

      {problem && (
        <Callout tone="warn" className="mt-3">
          {problem}
        </Callout>
      )}

      {action !== "wait" && action !== "done" && action !== "unknown" && (
        <div className="mt-4">
          {action === "sign" && payment.quote && (
            <Button disabled={busy || !address} onClick={() => void p.sign()}>
              {p.settling ? "Submitting…" : "Sign and pay"}
            </Button>
          )}
          {action === "cancel" && payment.cancelTypedData && (
            <Button variant="subtle" disabled={busy || !address} onClick={() => void p.cancel()}>
              {p.cancelling ? "Cancelling…" : "Cancel this payment"}
            </Button>
          )}
          {action === "requote" && (
            <Button disabled={busy} onClick={() => void p.requote()}>
              {p.requoting ? "Requesting…" : "Request a new quote"}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
