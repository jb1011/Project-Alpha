"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import {
  useCancelCompanyPaymentMutation,
  useCompanyPaymentQuery,
  useRequoteCompanyPaymentMutation,
  useSettleCompanyPaymentMutation,
} from "@/lib/api/hooks";
import {
  FEE_BREAKDOWN,
  cancelTypedData,
  formatAtomicUsdc,
  paymentAction,
  paymentExplanation,
  toWagmiTypedData,
} from "@/lib/formation/payment";
import { Button, Callout, Card, SectionTitle, Spinner } from "@/components/onboarding/primitives";

/**
 * THE FORMATION FEE, on the Companies page (design §7 "Companies section": payment state + the
 * same actions).
 *
 * The SAME functions the wizard's `PaymentStep` uses — `paymentAction`, `paymentExplanation`,
 * `toWagmiTypedData`, `cancelTypedData` — and that sharing is the point rather than an economy.
 * Two components deciding for themselves whether a payment may be signed is how a page ends up
 * offering "pay" for a transfer that is already in flight, which is a guardian charged twice.
 *
 * It renders NOTHING at all where there is no payment: the query 404s on a deployment that does
 * not charge and on a company that owes nothing, and a section that appeared empty would tell
 * every owner in the beta that this system takes money.
 */
export function CompanyPaymentPanel({ companyId }: { companyId: string }) {
  const { address } = useAccount();
  const { data: payment, isError } = useCompanyPaymentQuery(companyId);
  const settle = useSettleCompanyPaymentMutation(companyId);
  const cancel = useCancelCompanyPaymentMutation(companyId);
  const requote = useRequoteCompanyPaymentMutation(companyId);
  const { signTypedDataAsync } = useSignTypedData();
  const [problem, setProblem] = useState<string | null>(null);

  /** When THIS visit first saw the payment settling — see `PaymentStep` for why it is per-visit. */
  const settlingSince = useRef<number | null>(null);
  useEffect(() => {
    if (payment?.status === "settling") settlingSince.current ??= Date.now();
    else settlingSince.current = null;
  }, [payment?.status]);

  // A 404 is the ordinary answer here (no payment, or a box that does not charge), and it must
  // render nothing rather than an error: an owner in the beta has no fee and no reason to read
  // about one.
  if (isError || !payment) return null;

  const action = paymentAction(payment, {
    nowMs: Date.now(),
    settlingSinceMs: settlingSince.current ?? undefined,
  });
  const busy = settle.isPending || cancel.isPending || requote.isPending;

  const run = async (fn: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Something went wrong.");
    }
  };

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
            <Button
              disabled={busy || !address}
              onClick={() =>
                void run(async () => {
                  const signature = await signTypedDataAsync(
                    toWagmiTypedData(payment.quote!.typedData),
                  );
                  await settle.mutateAsync({ signature, from: address as `0x${string}` });
                })
              }
            >
              {settle.isPending ? "Submitting…" : "Sign and pay"}
            </Button>
          )}
          {action === "cancel" && (
            <Button
              variant="subtle"
              disabled={busy || !address}
              onClick={() =>
                void run(async () => {
                  const signature = await signTypedDataAsync(
                    cancelTypedData(payment.domain, address as `0x${string}`, payment.nonce),
                  );
                  await cancel.mutateAsync({ signature });
                })
              }
            >
              {cancel.isPending ? "Cancelling…" : "Cancel this payment"}
            </Button>
          )}
          {action === "requote" && (
            <Button disabled={busy} onClick={() => void run(() => requote.mutateAsync())}>
              {requote.isPending ? "Requesting…" : "Request a new quote"}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
