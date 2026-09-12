// `payFetchFor` with the fetch and the MCP client stubbed. No network, no key.
// Two claims, both load-bearing for D2: the client is what refuses on a policy deny,
// and it never signs before it has asked; and a settled payment is reported to the
// legal body until the mirror node has seen it.
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import type { ClientHederaSigner } from "@x402/hedera";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoviClient, PaymentReport, PolicyVerdict } from "../src/novi.js";
import { payFetchFor } from "../src/pay.js";

const ENTITY_ID = "entity-under-test";
const TX_ID = "0.0.7162784@1788998489.006924053";
const RESOURCE_URL = "http://127.0.0.1:8787/verify/9f8003f5-4c70-435a-9980-9a54625691b7";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  payTo: "0.0.10412694",
  asset: "0.0.429274",
  amount: "1000",
  maxTimeoutSeconds: 60,
  extra: { feePayer: "0.0.7162784" },
};

const paymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: { url: RESOURCE_URL },
  accepts: [requirements],
};

const settled: SettleResponse = {
  success: true,
  transaction: TX_ID,
  network: "hedera:testnet",
  payer: "0.0.10450558",
};

/** A signer that records whether it was asked to sign, and never touches a key. */
function stubSigner() {
  const create = vi.fn(async () => "ZmFrZS10eA==");
  return {
    accountId: "0.0.10450558",
    createPartiallySignedTransferTransaction: create,
  } satisfies ClientHederaSigner & { createPartiallySignedTransferTransaction: typeof create };
}

/** 402 with the requirements in the header, then 200 with the settlement in the header. */
function stubFetch(settlement: SettleResponse | null = settled) {
  let calls = 0;
  return vi.fn(async (): Promise<Response> => {
    calls += 1;
    if (calls === 1) {
      return new Response("{}", {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) },
      });
    }
    const headers = new Headers({ "content-type": "application/json" });
    if (settlement) headers.set("PAYMENT-RESPONSE", encodePaymentResponseHeader(settlement));
    return new Response(JSON.stringify({ standing: "active" }), { status: 200, headers });
  });
}

function stubNovi(verdict: PolicyVerdict, reports: PaymentReport[]): NoviClient {
  const queue = [...reports];
  return {
    checkPolicy: vi.fn(async () => verdict),
    reportPayment: vi.fn(async () => queue.shift() ?? ({ status: "settled" } as PaymentReport)),
    linkHederaAccount: vi.fn(async () => ({
      ok: true as const,
      accountId: "0.0.1",
      guardianPublicKey: "03ab",
    })),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("payFetchFor", () => {
  it("refuses to pay when check_policy denies, and never signs", async () => {
    const signer = stubSigner();
    const novi = stubNovi({ ok: false, reason: "paused" }, []);
    const fetchImpl = stubFetch();

    const paid = payFetchFor({
      signer,
      novi,
      entityId: ENTITY_ID,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // The literal the SDK produces, asserted whole: the command layer parses the tail of it
    // to print `policy denied: paused`, so a wording change upstream has to fail here.
    await expect(paid(RESOURCE_URL)).rejects.toThrow(
      "Failed to create payment payload: Payment creation aborted: policy denied: paused",
    );
    expect(signer.createPartiallySignedTransferTransaction).not.toHaveBeenCalled();
    expect(novi.reportPayment).not.toHaveBeenCalled();
  });

  it("asks check_policy with the selected requirements", async () => {
    const signer = stubSigner();
    const novi = stubNovi({ ok: false, reason: "paused" }, []);
    const paid = payFetchFor({
      signer,
      novi,
      entityId: ENTITY_ID,
      fetchImpl: stubFetch() as unknown as typeof fetch,
    });

    await expect(paid(RESOURCE_URL)).rejects.toThrow();
    expect(novi.checkPolicy).toHaveBeenCalledWith({
      id: ENTITY_ID,
      payee: "0.0.10412694",
      amountUsdc: "1000",
      network: "hedera:testnet",
    });
  });

  it("reports the settled transaction from PAYMENT-RESPONSE", async () => {
    const signer = stubSigner();
    const novi = stubNovi({ ok: true, available: "1000000" }, [{ status: "settled", ledgerId: 7 }]);
    const paid = payFetchFor({
      signer,
      novi,
      entityId: ENTITY_ID,
      fetchImpl: stubFetch() as unknown as typeof fetch,
    });

    const res = await paid(RESOURCE_URL);
    expect(res.status).toBe(200);
    expect(signer.createPartiallySignedTransferTransaction).toHaveBeenCalledOnce();
    expect(novi.reportPayment).toHaveBeenCalledOnce();
    expect(novi.reportPayment).toHaveBeenCalledWith({
      id: ENTITY_ID,
      payee: "0.0.10412694",
      amountUsdc: "1000",
      network: "hedera:testnet",
      transactionId: TX_ID,
      idempotencyKey: TX_ID,
    });
  });

  it("retries report_payment while the mirror node answers pending", async () => {
    vi.useFakeTimers();
    const signer = stubSigner();
    const novi = stubNovi({ ok: true, available: "1000000" }, [
      { status: "pending" },
      { status: "settled", ledgerId: 8 },
    ]);
    const paid = payFetchFor({
      signer,
      novi,
      entityId: ENTITY_ID,
      fetchImpl: stubFetch() as unknown as typeof fetch,
    });

    const pending = paid(RESOURCE_URL);
    await vi.advanceTimersByTimeAsync(15_000);
    const res = await pending;

    expect(res.status).toBe(200);
    expect(novi.reportPayment).toHaveBeenCalledTimes(2);
  });

  it("does not report a refused settlement", async () => {
    const signer = stubSigner();
    const novi = stubNovi({ ok: true, available: "1000000" }, []);
    const refused: SettleResponse = {
      success: false,
      errorReason: "transaction_failed",
      transaction: TX_ID,
      network: "hedera:testnet",
    };
    const paid = payFetchFor({
      signer,
      novi,
      entityId: ENTITY_ID,
      fetchImpl: stubFetch(refused) as unknown as typeof fetch,
    });

    await paid(RESOURCE_URL);
    expect(novi.reportPayment).not.toHaveBeenCalled();
  });
});
