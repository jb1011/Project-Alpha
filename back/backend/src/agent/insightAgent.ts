import type Anthropic from "@anthropic-ai/sdk";
import type { makeTools } from "./tools";

export interface InsightAgentDeps {
  client: Anthropic; // injected: a fake in tests, a real `new Anthropic({ apiKey })` live
  model: string; // e.g. "claude-sonnet-4-6" (or "claude-opus-4-8" via AGENT_MODEL)
  tools: ReturnType<typeof makeTools>;
  catalog: { id: string; title: string; price: string }[];
}

export interface AgentRun {
  answer: string;
  purchases: { id: string; cost: bigint }[];
  denied: { id: string; reason: string }[];
  totalCost: bigint;
}

const SYSTEM = [
  "You are a cost-aware research agent. You answer the user's query by optionally buying paid datasets.",
  "You hold NO payment key: every purchase goes through the buy_data tool, which may be DENIED by the on-chain policy.",
  "Before buying, consider get_budget (remaining USDC, atomic units, 6 decimals). Buy only datasets whose value",
  "justifies the price. If buy_data returns ok:false, do NOT retry — note it and answer with what you have.",
  "Finish with a concise synthesized answer in plain text.",
].join(" ");

const TOOL_DEFS: Anthropic.Messages.Tool[] = [
  {
    name: "get_budget",
    description: "Remaining spendable USDC (atomic, 6 decimals) under the on-chain cap.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "buy_data",
    description: "Buy a paid dataset by id. May be policy-denied.",
    input_schema: {
      type: "object",
      properties: { datasetId: { type: "string", description: "dataset id from the catalog" } },
      required: ["datasetId"],
    },
  },
];

export function buildInsightAgent(d: InsightAgentDeps) {
  return {
    async run(query: string): Promise<AgentRun> {
      const purchases: { id: string; cost: bigint }[] = [];
      const denied: { id: string; reason: string }[] = [];
      const system = `${SYSTEM} Catalog: ${JSON.stringify(d.catalog)}`;
      const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: query }];
      let answer = "";

      for (let step = 0; step < 8; step++) {
        const res = await (
          d.client.messages.create as (
            params: Anthropic.Messages.MessageCreateParamsNonStreaming,
          ) => Promise<Anthropic.Messages.Message>
        )({ model: d.model, max_tokens: 1024, system, tools: TOOL_DEFS, messages });

        messages.push({ role: "assistant", content: res.content });

        if (res.stop_reason !== "tool_use") {
          answer = res.content
            .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n");
          break;
        }

        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
        for (const block of res.content) {
          if (block.type !== "tool_use") continue;
          if (block.name === "get_budget") {
            const b = await d.tools.getBudget();
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({ remaining: b.remaining.toString() }),
            });
          } else if (block.name === "buy_data") {
            const { datasetId } = block.input as { datasetId: string };
            const r = await d.tools.buyData(datasetId);
            if (r.ok) {
              purchases.push({ id: datasetId, cost: r.cost });
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({ ok: true, data: r.data, cost: r.cost.toString() }),
              });
            } else {
              denied.push({ id: datasetId, reason: r.reason });
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({ ok: false, reason: r.reason }),
              });
            }
          } else {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({ error: `unknown tool: ${block.name}` }),
            });
          }
        }
        messages.push({ role: "user", content: toolResults });
      }

      if (answer === "") answer = "(agent reached step limit without producing a final answer)";
      const totalCost = purchases.reduce((s, p) => s + p.cost, 0n);
      return { answer, purchases, denied, totalCost };
    },
  };
}
