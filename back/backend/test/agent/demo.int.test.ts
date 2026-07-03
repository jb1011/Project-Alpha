import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { arcBatchingConfig, pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { runDemo } from "../../src/agent/demo";
import { buildVendor } from "../../src/agent/vendor";
import { authorizePayment } from "../../src/payments/authority";
import { PaymentLedger } from "../../src/payments/ledger";
import { migrate } from "../../src/persistence/db";

const KEY = `0x${"2".repeat(64)}` as const;
const agentPayout = "0x00000000000000000000000000000000000000ab" as const;
const vendorPayout = "0x00000000000000000000000000000000000000cd" as const;

test("full cycle: agent buys sentiment, answers, prices at margin, customer pays -> positive P&L", async () => {
  const db = new Database(":memory:");
  migrate(db);
  const ledger = new PaymentLedger(db);
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(KEY),
    chainId: 5042002,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });
  const deps = {
    ledger,
    entityKey: "entityA",
    readTreasury: async () => ({
      available: 1_000_000n,
      paused: false,
      allowlistEnabled: false,
      isAllowed: true,
    }),
    signX402: async (req: {
      payee: `0x${string}`;
      amount: bigint;
      asset: `0x${string}`;
      network: string;
      maxTimeoutSeconds: number;
    }) =>
      signX402({
        payTo: req.payee,
        amount: req.amount,
        asset: req.asset,
        network: req.network,
        maxTimeoutSeconds: req.maxTimeoutSeconds,
      }),
  };
  const authorize = async (r: Parameters<typeof authorizePayment>[1]) =>
    authorizePayment(deps as never, r);
  const vendor = buildVendor({
    payTo: vendorPayout,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
  });

  // fake Anthropic client: scripted tool_use then final text (no network, no key)
  let _i = 0;
  const scripted = [
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "buy_data", input: { datasetId: "sentiment" } },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Sentiment is up (0.62)." }] },
  ];
  const client = { messages: { create: async () => scripted[_i++] } } as never;

  const out = await runDemo(
    {
      client,
      model: "claude-sonnet-4-6",
      vendor,
      authorize,
      readBudget: async () => ({ available: 1_000_000n, runningPending: 0n }),
      vendorBase: "http://vendor.local",
      margin: 0.5,
      agentPayout,
    },
    "sentiment?",
  );
  expect(out.purchases).toEqual([{ id: "sentiment", cost: 10_000n }]);
  expect(out.totalCost).toBe(10_000n);
  expect(out.price).toBe(15_000n); // 10000 * 1.5
  expect(out.pnl).toBe(out.price - out.totalCost); // 5000, the customer paid `price`
  expect(out.answer.toLowerCase()).toContain("sentiment");
});
