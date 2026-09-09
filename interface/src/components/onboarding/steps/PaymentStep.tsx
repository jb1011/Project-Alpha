"use client";

import { usePublicConfigQuery } from "@/lib/api/hooks";
import {
  FEE_BREAKDOWN,
  feeSentence,
  formatAtomicUsdc,
  paymentExplanation,
} from "@/lib/formation/payment";
import { messageOf, useFormationPayment } from "@/lib/formation/useFormationPayment";
import { StepNav } from "../OnboardingFlow";
import {
  AmberPill,
  Button,
  Callout,
  Card,
  CheckIcon,
  SectionTitle,
  Spinner,
  StepHeader,
} from "../primitives";

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
 * persisted authorization), cancel (a SECOND signature, over a different message, which retires
 * the authorization on-chain), re-quote (a new nonce, only once nothing is live).
 *
 * The state and the three handlers are `useFormationPayment` (finding C3) — the same controller
 * the Companies page's panel uses, because two components deciding for themselves whether a
 * payment may be signed is how one of them ends up offering "pay" for a transfer already in
 * flight.
 */
export function PaymentStep({ eyebrow, companyId, onBack, onComplete }: Props) {
    const { data: config } = usePublicConfigQuery();
  const p = useFormationPayment(companyId);
  const { payment, action, busy, problem, address } = p;

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

        {p.isLoading && (
          <p className="mt-4 flex items-center gap-2 text-sm opacity-70">
            <Spinner /> Reading your quote…
          </p>
        )}

        {p.isError && (
          <Callout tone="warn" className="mt-4">
            <p>We could not read this company&apos;s payment. Nothing has been charged.</p>
            <p className="mt-1 text-sm opacity-80">{messageOf(p.error)}</p>
            <Button variant="subtle" className="mt-3" onClick={p.refetch}>
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
          <Button onClick={() => void p.sign()} disabled={busy || !address}>
            {p.settling ? "Submitting…" : "Sign and pay"}
          </Button>
        )}
        {action === "cancel" && (
          <Button variant="subtle" onClick={() => void p.cancel()} disabled={busy || !address}>
            {p.cancelling ? "Cancelling…" : "Cancel this payment"}
          </Button>
        )}
        {action === "requote" && (
          <Button onClick={() => void p.requote()} disabled={busy}>
            {p.requoting ? "Requesting…" : "Request a new quote"}
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
