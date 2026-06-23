import type Anthropic from "@anthropic-ai/sdk";
import type { Hono } from "hono";
import type { AuthorizeFn } from "../payments/buyer";
import type { Address } from "../types";
import { DATASETS } from "./datasets";
import { buildInsightAgent } from "./insightAgent";
import { priceAnswer } from "./pricing";
import { makeTools } from "./tools";

export interface DemoDeps {
  client: Anthropic;
  model: string;
  vendor: Hono;
  authorize: AuthorizeFn;
  readBudget: () => Promise<{ available: bigint; runningPending: bigint }>;
  vendorBase: string;
  margin: number;
  agentPayout: Address;
}

export interface DemoResult {
  answer: string;
  totalCost: bigint;
  price: bigint;
  pnl: bigint;
  purchases: { id: string; cost: bigint }[];
  denied: { id: string; reason: string }[];
}

export async function runDemo(d: DemoDeps, query: string): Promise<DemoResult> {
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) =>
    d.vendor.fetch(new Request(url, init))) as unknown as typeof fetch;
  const tools = makeTools({
    fetchImpl,
    authorize: d.authorize,
    vendorBase: d.vendorBase,
    readBudget: d.readBudget,
  });
  const catalog = Object.values(DATASETS).map((x) => ({
    id: x.id,
    title: x.title,
    price: x.price.toString(),
  }));
  const agent = buildInsightAgent({ client: d.client, model: d.model, tools, catalog });
  const run = await agent.run(query);
  const price = priceAnswer(run.totalCost, d.margin);
  // P&L = revenue (a customer pays `price` for the answer) − input cost. On the live path this is a real
  // second buy against the agent's own paywall (payTo = agentPayout); here we record the priced revenue.
  const pnl = price - run.totalCost;
  return {
    answer: run.answer,
    totalCost: run.totalCost,
    price,
    pnl,
    purchases: run.purchases,
    denied: run.denied,
  };
}
