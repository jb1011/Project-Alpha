// backend/src/payments/settle.ts
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { decodeX402Header } from "../adapters/x402/signX402";
import type { Address } from "../types";

export interface SettleRequirements {
  scheme: string;
  network: string;
  asset: Address;
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; verifyingContract: Address };
  resourceUrl: string;
}
/** Minimal facilitator surface (BatchFacilitatorClient satisfies it). */
export interface Facilitator {
  settle(
    // biome-ignore lint/suspicious/noExplicitAny: Circle's facilitator boundary is loosely typed
    paymentPayload: any,
    // biome-ignore lint/suspicious/noExplicitAny: Circle's facilitator boundary is loosely typed
    paymentRequirements: any,
  ): Promise<{ success: boolean; transaction?: string; errorReason?: string }>;
}
export type SettleResult = { ok: true; transferId?: string } | { ok: false; reason?: string };
export type SettleFn = (header: string, requirements: SettleRequirements) => Promise<SettleResult>;

/** Decode the X-PAYMENT header, enrich with resource + accepted (Finding 10), and settle. Pure of network. */
export async function settleWith(
  fac: Facilitator,
  header: string,
  r: SettleRequirements,
): Promise<SettleResult> {
  const base = decodeX402Header(header);
  const requirements = {
    scheme: r.scheme,
    network: r.network,
    asset: r.asset,
    amount: r.amount,
    payTo: r.payTo,
    maxTimeoutSeconds: r.maxTimeoutSeconds,
    extra: r.extra,
  };
  const paymentPayload = {
    ...base,
    resource: {
      url: r.resourceUrl,
      description: "governed nanopayment resource",
      mimeType: "application/json",
    },
    accepted: requirements,
  };
  let s: { success: boolean; transaction?: string; errorReason?: string };
  try {
    s = await fac.settle(paymentPayload, requirements);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  return s.success ? { ok: true, transferId: s.transaction } : { ok: false, reason: s.errorReason };
}

/** Bind the real Circle facilitator (testnet base URL — the client appends /v1/x402/...). */
export function makeSettle(cfg: { facilitatorUrl: string }): SettleFn {
  const fac = new BatchFacilitatorClient({ url: cfg.facilitatorUrl }) as unknown as Facilitator;
  return (header, requirements) => settleWith(fac, header, requirements);
}
