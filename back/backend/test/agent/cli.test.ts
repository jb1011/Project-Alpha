import { expect, test, vi } from "vitest";
import { buildCli } from "../../src/cli/index";

test("`agent ask` prints the answer and P&L", async () => {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a) => {
    logs.push(a.join(" "));
  });
  // buildCli accepts an injected agent demo runner for tests — no live model or network needed.
  const program = buildCli(undefined, {
    runDemo: async () => ({
      answer: "Sentiment is up.",
      totalCost: 10_000n,
      price: 15_000n,
      pnl: 5_000n,
      purchases: [{ id: "sentiment", cost: 10_000n }],
      denied: [],
    }),
  });
  await program.parseAsync(["node", "legalbody", "agent", "ask", "sentiment?"]);
  spy.mockRestore();
  const out = logs.join("\n");
  expect(out).toContain("Sentiment is up.");
  expect(out).toContain("P&L");
});
