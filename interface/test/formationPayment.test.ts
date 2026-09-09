/**
 * FORMATION-PAYMENT PRESENTATION (B1, design §6).
 *
 * `paymentAction` decides which button a guardian is offered, and one of its answers is the whole
 * safety property of the screen: while a broadcast is in flight there is NO sign button. Signing
 * twice for one quote is how somebody pays 798 USDC for one company, and the reliable version of
 * "do not do that" is not rendering the control.
 *
 * The rest is honesty: the fee comes from `/config` and never from this bundle, and a status this
 * build does not know is inert rather than guessed at.
 */
import { expect, test } from "vitest";
import type { FormationPaymentView, PaymentTypedData } from "@/lib/api/types";
import {
  STUCK_AFTER_MS,
  cancelTypedData,
  feeSentence,
  formatAtomicUsdc,
  paymentAction,
  paymentExplanation,
  toWagmiTypedData,
} from "@/lib/formation/payment";

const NOW = 1_800_000_000_000;
const DOMAIN: PaymentTypedData["domain"] = {
  name: "USD Coin",
  version: "2",
  chainId: 5042002,
  verifyingContract: "0x3600000000000000000000000000000000000000",
};

const typedData: PaymentTypedData = {
  domain: DOMAIN,
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: {
    from: "0x000000000000000000000000000000000000000a",
    to: "0x000000000000000000000000000000000000bEEF",
    value: "399000000",
    validAfter: "0",
    validBefore: "1800001800",
    nonce: `0x${"a1".repeat(32)}`,
  },
};

function payment(over: Partial<FormationPaymentView> = {}): FormationPaymentView {
  return {
    paymentId: "p1",
    companyId: "c1",
    product: "formation",
    status: "quoted",
    amountUsdc: "399000000",
    amountDisplayUsdc: 399,
    validBefore: 1_800_001_800,
    payerAddress: null,
    txHash: null,
    refundTxHash: null,
    nonce: `0x${"a1".repeat(32)}`,
    domain: DOMAIN,
    quote: {
      paymentId: "p1",
      amountUsdc: "399000000",
      amountDisplayUsdc: 399,
      payTo: "0x000000000000000000000000000000000000bEEF",
      nonce: `0x${"a1".repeat(32)}`,
      validAfter: 0,
      validBefore: 1_800_001_800,
      typedData,
    },
    ...over,
  };
}

/* ── the fee sentence: served, never bundled ───────────────────────────────── */

test("the beta sentence names the price the BACKEND would charge, not one from this build", () => {
  expect(feeSentence({ formationPaymentRequired: false, formationFeeUsdc: 399 })).toBe(
    "Formation is included during the beta, normally $399.",
  );
  // A different deployment, a different number — which is the entire reason it is served.
  expect(feeSentence({ formationPaymentRequired: false, formationFeeUsdc: 250 })).toContain("$250");
});

test("when the price is unknown we do not invent one", () => {
  // A backend that forms nothing serves `null`. "Included during the beta" is still true and
  // complete without a number; a hardcoded $399 beside it would be a claim nobody is keeping.
  expect(feeSentence({ formationPaymentRequired: false, formationFeeUsdc: null })).toBe(
    "Formation is included during the beta.",
  );
  expect(feeSentence(undefined)).toBe("Formation is included during the beta.");
});

test("a charging deployment states the price rather than the beta", () => {
  expect(feeSentence({ formationPaymentRequired: true, formationFeeUsdc: 399 })).toBe(
    "$399 USDC, one time",
  );
});

test("atomic USDC renders as money, and a malformed amount as an em dash", () => {
  expect(formatAtomicUsdc("399000000")).toBe("399.00");
  expect(formatAtomicUsdc("1500000")).toBe("1.50");
  expect(formatAtomicUsdc("not-a-number")).toBe("—");
});

/* ── the action: what a guardian may do ────────────────────────────────────── */

test("a live quote offers SIGN", () => {
  expect(paymentAction(payment(), { nowMs: NOW })).toBe("sign");
});

test("⚠ a SETTLING payment offers NO sign — this is the double-charge guard", () => {
  // The whole safety property of the screen. The server withholds the quote here; this asserts
  // the client agrees rather than inventing an action from the status.
  const settling = payment({ status: "settling", quote: undefined });
  expect(paymentAction(settling, { nowMs: NOW })).toBe("wait");
  expect(paymentAction(settling, { nowMs: NOW, settlingSinceMs: NOW - 1000 })).toBe("wait");
});

test("a payment stuck long enough offers CANCEL — a second signature, not a retry", () => {
  const settling = payment({ status: "settling", quote: undefined });
  expect(
    paymentAction(settling, { nowMs: NOW, settlingSinceMs: NOW - STUCK_AFTER_MS - 1 }),
  ).toBe("cancel");
});

test("a `quoted` row with NO quote offers a re-quote — the clock, not the status", () => {
  // The backend withholds the typed data past `validBefore` even before the sweeper moves the
  // row. Offering a sign button off the STATUS alone would walk a guardian through a wallet
  // prompt for an authorization the token would reject.
  expect(paymentAction(payment({ quote: undefined }), { nowMs: NOW })).toBe("requote");
});

test("expired and failed both offer a re-quote; settled and refunded offer nothing", () => {
  for (const status of ["expired", "failed"] as const)
    expect(paymentAction(payment({ status, quote: undefined }), { nowMs: NOW })).toBe("requote");
  for (const status of ["settled", "refunded"] as const)
    expect(paymentAction(payment({ status, quote: undefined }), { nowMs: NOW })).toBe("done");
});

test("a status from a NEWER backend is inert, never guessed at", () => {
  const future = payment({ status: "escrowed" as never, quote: undefined });
  expect(paymentAction(future, { nowMs: NOW })).toBe("unknown");
  // …and no payment at all is `unknown` too, rather than something actionable.
  expect(paymentAction(undefined, { nowMs: NOW })).toBe("unknown");
});

test("every state a guardian can be in has words, and the settling one warns", () => {
  for (const status of ["quoted", "settling", "settled", "expired", "failed", "refunded"] as const)
    expect(paymentExplanation(payment({ status }))).not.toBe("");
  expect(paymentExplanation(payment({ status: "settling", quote: undefined }))).toMatch(
    /Do not sign again/,
  );
});

/* ── the typed data: relayed, not built ────────────────────────────────────── */

test("the wagmi message is a TRANSLATION of the server's, field for field", () => {
  const wagmi = toWagmiTypedData(typedData);
  expect(wagmi.domain).toBe(typedData.domain);
  expect(wagmi.types).toBe(typedData.types);
  expect(wagmi.primaryType).toBe("TransferWithAuthorization");
  // Only the three uint256 strings change, into the bigints viem's encoder wants.
  // `BigInt(...)` rather than `123n`: this package's tsconfig targets below ES2020, where the
  // literal syntax is a compile error. The values are identical.
  expect(wagmi.message).toEqual({
    from: typedData.message.from,
    to: typedData.message.to,
    value: BigInt("399000000"),
    validAfter: BigInt(0),
    validBefore: BigInt("1800001800"),
    nonce: typedData.message.nonce,
  });
});

test("the CANCEL message uses the SERVER's domain and the row's nonce", () => {
  // The one message this package constructs. Safe to: a wrong one yields a signature the token
  // REJECTS — a stuck payment, never a moved one. The domain is still the server's, because a
  // hardcoded "USD Coin"/"2" would sign against a domain the token does not verify.
  const td = cancelTypedData(DOMAIN, "0x000000000000000000000000000000000000000a", `0x${"a1".repeat(32)}`);
  expect(td.domain).toBe(DOMAIN);
  expect(td.primaryType).toBe("CancelAuthorization");
  expect(td.types.CancelAuthorization).toEqual([
    { name: "authorizer", type: "address" },
    { name: "nonce", type: "bytes32" },
  ]);
  expect(td.message).toEqual({
    authorizer: "0x000000000000000000000000000000000000000a",
    nonce: `0x${"a1".repeat(32)}`,
  });
});
