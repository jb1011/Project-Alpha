import type Anthropic from "@anthropic-ai/sdk";
import { expect, test, vi } from "vitest";
import { buildInsightAgent } from "../../src/agent/insightAgent";

// A fake Anthropic client whose messages.create returns the scripted responses in order.
function fakeClient(scripted: Array<Partial<Anthropic.Message>>): Anthropic {
  let i = 0;
  return { messages: { create: async () => scripted[i++] } } as unknown as Anthropic;
}

test("the agent buys a dataset then returns a synthesized answer with recorded purchases", async () => {
  const tools = {
    getBudget: vi.fn(async () => ({ remaining: 1_000_000n })),
    buyData: vi.fn(async (id: string) => ({
      ok: true as const,
      data: { id, body: { index: 0.62 } },
      cost: 10_000n,
    })),
  };
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "buy_data", input: { datasetId: "sentiment" } },
      ] as never,
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Agent-economy sentiment is up (index 0.62)." }] as never,
    },
  ]);
  const agent = buildInsightAgent({
    client,
    model: "claude-sonnet-4-6",
    tools: tools as never,
    catalog: [{ id: "sentiment", title: "Sentiment", price: "10000" }],
  });

  const r = await agent.run("How is agent-economy sentiment?");
  expect(r.answer).toContain("sentiment is up");
  expect(r.purchases).toEqual([{ id: "sentiment", cost: 10_000n }]);
  expect(r.totalCost).toBe(10_000n);
  expect(tools.buyData).toHaveBeenCalledWith("sentiment");
});

test("a denied purchase is recorded in `denied` and does not abort the answer", async () => {
  const tools = {
    getBudget: vi.fn(async () => ({ remaining: 5_000n })),
    buyData: vi.fn(async () => ({ ok: false as const, reason: "over-cap" })),
  };
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "buy_data", input: { datasetId: "onchain-flows" } },
      ] as never,
    },
    {
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: "I could not afford on-chain flows; partial answer based on priors.",
        },
      ] as never,
    },
  ]);
  const agent = buildInsightAgent({
    client,
    model: "claude-sonnet-4-6",
    tools: tools as never,
    catalog: [],
  });
  const r = await agent.run("flows?");
  expect(r.denied).toEqual([{ id: "onchain-flows", reason: "over-cap" }]);
  expect(r.purchases).toEqual([]);
  expect(r.answer).toContain("partial");
});

test("the agent calls get_budget then buys a dataset and returns the final answer", async () => {
  const tools = {
    getBudget: vi.fn(async () => ({ remaining: 500_000n })),
    buyData: vi.fn(async (id: string) => ({
      ok: true as const,
      data: { id, body: { price: 42.5 } },
      cost: 5_000n,
    })),
  };
  const client = fakeClient([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "b1", name: "get_budget", input: {} }] as never,
    },
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "b2", name: "buy_data", input: { datasetId: "price-feed" } },
      ] as never,
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Current price is 42.5." }] as never,
    },
  ]);
  const agent = buildInsightAgent({
    client,
    model: "claude-sonnet-4-6",
    tools: tools as never,
    catalog: [{ id: "price-feed", title: "Price Feed", price: "5000" }],
  });

  const r = await agent.run("What is the current price?");
  expect(tools.getBudget).toHaveBeenCalledOnce();
  expect(tools.buyData).toHaveBeenCalledWith("price-feed");
  expect(r.purchases).toEqual([{ id: "price-feed", cost: 5_000n }]);
  expect(r.totalCost).toBe(5_000n);
  expect(r.answer).toContain("42.5");
});
