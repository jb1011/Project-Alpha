import { type AuthorizeFn, buyWithX402 } from "../payments/buyer";

export interface AgentToolDeps {
  fetchImpl: typeof fetch;
  authorize: AuthorizeFn;
  /** Base URL of the vendor (e.g. "http://vendor.local" or the live vendor URL). */
  vendorBase: string;
  readBudget: () => Promise<{ available: bigint; runningPending: bigint }>;
}

export type BuyResult = { ok: true; data: unknown; cost: bigint } | { ok: false; reason: string };

export function makeTools(d: AgentToolDeps) {
  return {
    async getBudget(): Promise<{ remaining: bigint }> {
      const b = await d.readBudget();
      const remaining = b.available - b.runningPending;
      return { remaining: remaining > 0n ? remaining : 0n };
    },

    async buyData(datasetId: string): Promise<BuyResult> {
      const url = `${d.vendorBase}/data/${datasetId}`;
      try {
        const res = await buyWithX402({ fetchImpl: d.fetchImpl, authorize: d.authorize }, url);
        if (res.status !== 200) return { ok: false, reason: `vendor-${res.status}` };
        const data = (await res.json()) as unknown;
        // Recover the cost paid: re-probe the vendor's 402 to read maxAmountRequired.
        const cost = await priceOf(d, datasetId);
        return { ok: true, data, cost };
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        const reason = m.startsWith("policy-denied:") ? m.slice("policy-denied:".length).trim() : m;
        return { ok: false, reason };
      }
    },
  };
}

/** The price the vendor charges for a dataset = its 402 maxAmountRequired (atomic USDC). */
async function priceOf(d: AgentToolDeps, datasetId: string): Promise<bigint> {
  const probe = await d.fetchImpl(`${d.vendorBase}/data/${datasetId}`);
  if (probe.status !== 402) return 0n;
  const body = (await probe.json()) as { accepts?: { maxAmountRequired: string }[] };
  return BigInt(body.accepts?.[0]?.maxAmountRequired ?? "0");
}
