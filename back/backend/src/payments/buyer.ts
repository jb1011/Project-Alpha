import type { Address } from "../types";

export interface X402Accept {
  payTo: Address;
  maxAmountRequired: string; // atomic USDC
  asset: Address;
  network: string;
  maxTimeoutSeconds: number;
}

export type AuthorizeFn = (req: {
  payee: Address;
  amount: bigint;
  resource: string;
  asset: Address;
  network: string;
  maxTimeoutSeconds: number;
}) => Promise<{ ok: true; header: string } | { ok: false; reason: string }>;

export interface BuyerDeps {
  fetchImpl: typeof fetch;
  authorize: AuthorizeFn; // calls the Authority (HTTP) or authorizePayment directly
  /** Optional price ceiling (atomic USDC). If the 402's maxAmountRequired exceeds this, the buy is
   *  denied BEFORE authorize is ever called — a pre-sign, release-safe failure. */
  maxAmount?: bigint;
  /** Fires EXACTLY ONCE, right after authorize returns `ok` and before the X-PAYMENT retry fetch —
   *  i.e. the moment the payment is authorized/"signed". Callers use this to distinguish a
   *  never-signed failure (safe to release the idempotency claim) from a signed-but-unconfirmed
   *  outcome (must NOT release, to avoid a blind re-sign on retry). */
  onAuthorized?: () => void;
}

/**
 * Fetch a paywalled resource. On 402, ask the Authority to authorize the required payment; on allow,
 * retry with the X-PAYMENT header. The agent never signs — it can only ask the Authority.
 */
export async function buyWithX402(
  d: BuyerDeps,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const first = await d.fetchImpl(url, init);
  if (first.status !== 402) return first;

  const body = (await first.json()) as { accepts: X402Accept[] };
  const req = body.accepts[0];
  if (!req) throw new Error("402 had no payment requirements");

  const amount = BigInt(req.maxAmountRequired);
  if (d.maxAmount !== undefined && amount > d.maxAmount) {
    throw new Error("policy-denied: amount-exceeds-declared");
  }

  const decision = await d.authorize({
    payee: req.payTo,
    amount,
    resource: url,
    asset: req.asset,
    network: req.network,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
  });
  if (!decision.ok) throw new Error(`policy-denied: ${decision.reason}`);
  d.onAuthorized?.();

  const headers = { ...(init.headers as Record<string, string>), "X-PAYMENT": decision.header };
  return d.fetchImpl(url, { ...init, headers });
}
