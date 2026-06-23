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

  const decision = await d.authorize({
    payee: req.payTo,
    amount: BigInt(req.maxAmountRequired),
    resource: url,
    asset: req.asset,
    network: req.network,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
  });
  if (!decision.ok) throw new Error(`policy-denied: ${decision.reason}`);

  const headers = { ...(init.headers as Record<string, string>), "X-PAYMENT": decision.header };
  return d.fetchImpl(url, { ...init, headers });
}
