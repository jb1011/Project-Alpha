// backend/src/agent/datasets.ts
export interface Dataset {
  id: string;
  title: string;
  price: bigint;
  body: Record<string, unknown>;
}

export const DATASETS: Record<string, Dataset> = {
  "market-snapshot": {
    id: "market-snapshot",
    title: "USDC market snapshot",
    price: 20_000n,
    body: { usdcMcap: "...", arcTps: 9000, note: "synthetic demo data" },
  },
  "onchain-flows": {
    id: "onchain-flows",
    title: "Arc on-chain USDC flows (24h)",
    price: 50_000n,
    body: { inflow: "...", outflow: "...", topPairs: ["USDC/ETH"] },
  },
  sentiment: {
    id: "sentiment",
    title: "Agent-economy sentiment index",
    price: 10_000n,
    body: { index: 0.62, trend: "up" },
  },
};
export function getDataset(id: string): Dataset | undefined {
  return DATASETS[id];
}
