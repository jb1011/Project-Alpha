"use client";

import { useEffect, useState } from "react";
import { useAccount, useSignTypedData } from "wagmi";
import {
  useCancelCompanyPaymentMutation,
  useCompanyPaymentQuery,
  useRequoteCompanyPaymentMutation,
  useSettleCompanyPaymentMutation,
} from "@/lib/api/hooks";
import type { FormationPaymentView } from "@/lib/api/types";
import { type PaymentAction, paymentAction, toWagmiTypedData } from "./payment";

/**
 * ONE FORMATION-PAYMENT HOOK, for the two screens that show a payment (finding C3).
 *
 * The wizard's `PaymentStep` and the Companies page's `CompanyPaymentPanel` had the same forty
 * lines each: the query, three mutations, the settling-since ref, the busy flag, the problem
 * string, and the three handlers. Two copies of a money flow is two places for a rule to drift —
 * and one rule in particular had already drifted into being written twice:
 *
 *   **A signature is only meaningful from a CONNECTED wallet.** `from` is our own connected
 *   address, and the backend checks it against the company's guardian. Each screen guarded that
 *   for itself, one with `!address` on the button and one inside the handler.
 *
 * What stays in the components is what genuinely differs: the words, the layout, and which of the
 * offered actions each of them renders.
 */
export interface FormationPaymentController {
  payment: FormationPaymentView | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  /** What the guardian may do next — one answer, from one function (`paymentAction`). */
  action: PaymentAction;
  /** Any mutation in flight. The screens disable everything on it rather than reasoning per
   *  button about which action is running. */
  busy: boolean;
  settling: boolean;
  cancelling: boolean;
  requoting: boolean;
  /** The last thing that went wrong, in a sentence. Cleared at the start of every action. */
  problem: string | null;
  /** The connected wallet, or undefined. The three handlers already refuse without it; the
   *  screens use it to disable a button before it is clicked. */
  address: `0x${string}` | undefined;
  sign: () => Promise<void>;
  cancel: () => Promise<void>;
  requote: () => Promise<void>;
}

/** How often the settling clock is re-read. The payment itself is polled every 4 s, but a poll
 *  whose answer has not changed re-renders nothing, and the cancel button has to appear on
 *  wall-clock time rather than on a change in the data. */
const SETTLING_TICK_MS = 1_000;

export function useFormationPayment(companyId: string | null): FormationPaymentController {
  const { address } = useAccount();
  const { data: payment, isLoading, isError, error, refetch } = useCompanyPaymentQuery(companyId);
  const settle = useSettleCompanyPaymentMutation(companyId ?? "");
  const cancelPayment = useCancelCompanyPaymentMutation(companyId ?? "");
  const requotePayment = useRequoteCompanyPaymentMutation(companyId ?? "");
  const { signTypedDataAsync } = useSignTypedData();
  const [problem, setProblem] = useState<string | null>(null);

  /**
   * When this browser first SAW the payment enter `settling`.
   *
   * In memory and per-visit, deliberately: it drives one thing, whether the cancel button has
   * appeared yet, and a persisted timestamp would offer that button instantly on a reload — to
   * somebody whose transfer is one second old and about to confirm. Re-starting the clock on a
   * reload errs towards waiting, which is the safe direction.
   *
   * State, with a clock beside it, because `action` is computed during render and nothing else
   * re-renders a payment that sits in `settling`: a poll whose answer has not changed produces no
   * render, so a ref read here would surface the cancel button at whatever render happened to
   * come next, or never. The clock ticks only while the payment is settling. The stamp is taken
   * when the payment is first seen settling and recorded on the first tick, so the first second
   * reads as "wait", which it is; it is forgotten when the payment leaves `settling`, so a later
   * attempt waits its own full turn.
   */
  const paymentSettling = payment?.status === "settling";
  const [settlingSinceMs, setSettlingSinceMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!paymentSettling) return;
    const sinceMs = Date.now();
    const id = setInterval(() => {
      setSettlingSinceMs(sinceMs);
      setNowMs(Date.now());
    }, SETTLING_TICK_MS);
    return () => {
      clearInterval(id);
      setSettlingSinceMs(null);
    };
  }, [paymentSettling]);

  const run = async (fn: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await fn();
    } catch (e) {
      // A wallet REJECTION is not a failure of the payment — nothing was submitted, the quote is
      // untouched, and the button is still there. Saying "payment failed" here would be a lie
      // about the guardian's own decision.
      setProblem(messageOf(e));
    }
  };

  return {
    payment,
    isLoading,
    isError,
    error,
    refetch: () => void refetch(),
    action: paymentAction(payment, { nowMs, settlingSinceMs: settlingSinceMs ?? undefined }),
    busy: settle.isPending || cancelPayment.isPending || requotePayment.isPending,
    settling: settle.isPending,
    cancelling: cancelPayment.isPending,
    requoting: requotePayment.isPending,
    problem,
    address,
    sign: () =>
      run(async () => {
        const quote = payment?.quote;
        // THE ONE CONNECTED-WALLET GUARD (finding C3). `from` is our own connected address rather
        // than anything off the quote: the backend checks it against the company's guardian, so a
        // mismatch is caught there, and sending the quote's own `from` back would make the field
        // decorative.
        if (!quote || !address) return;
        const signature = await signTypedDataAsync(toWagmiTypedData(quote.typedData));
        await settle.mutateAsync({ signature, from: address });
      }),
    cancel: () =>
      run(async () => {
        // The SERVED cancellation, authorizer and all (finding C2) — absent where there is
        // nothing live to cancel, or where the deployment no longer charges.
        const td = payment?.cancelTypedData;
        if (!td || !address) return;
        const signature = await signTypedDataAsync(td);
        await cancelPayment.mutateAsync({ signature });
      }),
    requote: () => run(() => requotePayment.mutateAsync()),
  };
}

/** A wallet rejection, an RPC failure and an API refusal all arrive as different shapes. One
 *  reader, so no branch renders `[object Object]` at a guardian. */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === "string" ? e : "Something went wrong.";
}
