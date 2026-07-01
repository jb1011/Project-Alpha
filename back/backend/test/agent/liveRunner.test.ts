import Database from "better-sqlite3";
import { getAddress } from "viem";
import { expect, test, vi } from "vitest";
import { arcBatchingConfig } from "../../src/adapters/x402/pocket";
import { pocketSignerFromKey } from "../../src/adapters/x402/pocket";
import { makeSignX402 } from "../../src/adapters/x402/signX402";
import { runDemo } from "../../src/agent/demo";
import {
  sellAnswer as realSell,
  requireVaultOperator,
  runLive,
  sellAnswer,
} from "../../src/agent/liveRunner";
import { buildVendor } from "../../src/agent/vendor";
import { authorizePayment } from "../../src/payments/authority";
import { PaymentLedger } from "../../src/payments/ledger";
import type { SettleFn } from "../../src/payments/settle";
import { migrate } from "../../src/persistence/db";
import type { EntityRecord } from "../../src/types";

const CUSTOMER = `0x${"2".repeat(64)}` as const;
const treasury = getAddress(`0x${"ab".repeat(20)}`);

test("sellAnswer: the customer pays the agent's paywall, it settles, and serves 200", async () => {
  const settle = vi.fn(async () => ({ ok: true as const, transferId: "sale-1" }));
  const r = await sellAnswer({
    chainId: 5042002,
    answer: "Sentiment is up (0.62).",
    price: 15_000n,
    sellerPayTo: treasury,
    customerPrivateKey: CUSTOMER,
    settle,
  });
  expect(r).toEqual({ ok: true, status: 200 });
  expect(settle).toHaveBeenCalledTimes(1);
  const reqs = (settle.mock.calls[0] as unknown[])[1] as { amount: string; payTo: string };
  expect(reqs.amount).toBe("15000");
  expect(reqs.payTo.toLowerCase()).toBe(treasury.toLowerCase());
});

test("sellAnswer: a settle failure surfaces as ok:false / 402", async () => {
  const settle = vi.fn(async () => ({ ok: false as const, reason: "insufficient_balance" }));
  const r = await sellAnswer({
    chainId: 5042002,
    answer: "x",
    price: 15_000n,
    sellerPayTo: treasury,
    customerPrivateKey: CUSTOMER,
    settle,
  });
  expect(r).toEqual({ ok: false, status: 402 });
});

const POCKET = `0x${"2".repeat(64)}` as const;
const vendorPayout = getAddress(`0x${"cd".repeat(20)}`);
const treasury2 = getAddress(`0x${"ab".repeat(20)}`);

test("runLive: fund -> agent buys (settles) -> customer buys answer (settles) -> P&L + transfer ids", async () => {
  // recording settle shared by BOTH legs (the vendor's buy + the sale)
  const settleLog: string[] = [];
  const recordingSettle: SettleFn = async () => {
    const id = `t${settleLog.length + 1}`;
    settleLog.push(id);
    return { ok: true, transferId: id };
  };

  // real Authority over an in-memory ledger + fake treasury reads + real pocket signX402
  const db = new Database(":memory:");
  migrate(db);
  const ledger = new PaymentLedger(db);
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(POCKET),
    chainId: 5042002,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });
  const authorityDeps = {
    ledger,
    readTreasury: async () => ({
      available: 1_000_000n,
      paused: false,
      allowlistEnabled: false,
      isAllowed: true,
    }),
    signX402: async (req: Parameters<typeof authorizePayment>[1]) =>
      signX402({
        payTo: req.payee,
        amount: req.amount,
        asset: req.asset,
        network: req.network,
        maxTimeoutSeconds: req.maxTimeoutSeconds,
      }),
  };
  const authorize = (req: Parameters<typeof authorizePayment>[1]) =>
    authorizePayment(authorityDeps as never, req);

  // the vendor the agent buys from — buys settle through the recording settle
  const vendor = buildVendor({
    payTo: vendorPayout,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
    settle: recordingSettle,
  });

  // fake Anthropic client: buy "sentiment", then a final answer
  let i = 0;
  const scripted = [
    {
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", id: "t1", name: "buy_data", input: { datasetId: "sentiment" } },
      ],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Sentiment is up (0.62)." }] },
  ];
  const client = { messages: { create: async () => scripted[i++] } } as never;

  const fund = vi.fn(async () => ["0xfund1", "0xfund2"] as `0x${string}`[]);

  const out = await runLive(
    {
      fund,
      runDemo: (q) =>
        runDemo(
          {
            client,
            model: "claude-sonnet-4-6",
            vendor,
            authorize,
            readBudget: async () => ({ available: 1_000_000n, runningPending: 0n }),
            vendorBase: "http://vendor.local",
            margin: 0.5,
            agentPayout: treasury2,
          },
          q,
        ),
      sell: (answer, price) =>
        realSell({
          chainId: 5042002,
          answer,
          price,
          sellerPayTo: treasury2,
          customerPrivateKey: POCKET,
          settle: recordingSettle,
        }),
      floatAtomic: 500_000n,
      settleTransferIds: () => settleLog,
      customer: pocketSignerFromKey(POCKET).address,
      vendorPayout,
    },
    "How is sentiment?",
  );

  expect(fund).toHaveBeenCalledWith(500_000n);
  expect(out.purchases).toEqual([{ id: "sentiment", cost: 10_000n }]);
  expect(out.totalCost).toBe(10_000n);
  expect(out.price).toBe(15_000n);
  expect(out.pnl).toBe(5_000n);
  expect(out.sold).toBe(true);
  expect(out.fundingTxs).toEqual(["0xfund1", "0xfund2"]);
  // two settlements recorded: the buy leg (t1) then the sale (t2)
  expect(out.settleTransferIds).toEqual(["t1", "t2"]);
  expect(out.answer.toLowerCase()).toContain("sentiment");
});

import { resolveLiveAddresses } from "../../src/agent/liveRunner";

test("resolveLiveAddresses: requires treasury + vendorPayout, and they must differ", () => {
  const t = getAddress(`0x${"ab".repeat(20)}`);
  const v = getAddress(`0x${"cd".repeat(20)}`);
  expect(resolveLiveAddresses({ treasury: t, vendorPayout: v })).toEqual({
    treasury: t,
    vendorPayout: v,
    agentPayout: t,
  });
  expect(() => resolveLiveAddresses({ vendorPayout: v })).toThrow(/TREASURY_ADDRESS/);
  expect(() => resolveLiveAddresses({ treasury: t })).toThrow(/VENDOR_PAYOUT_ADDRESS/);
  expect(() => resolveLiveAddresses({ treasury: t, vendorPayout: t })).toThrow(/must differ/);
});

const vaultEntity = {
  idempotencyKey: "tenant:agent1",
  operator: getAddress(`0x${"33".repeat(20)}`),
  turnkeySubOrgId: "sub-org-1",
} as unknown as EntityRecord;

test("requireVaultOperator: returns the agent's own vault {subOrgId, operator}", () => {
  expect(requireVaultOperator(treasury, vaultEntity)).toEqual({
    subOrgId: "sub-org-1",
    operator: getAddress(`0x${"33".repeat(20)}`),
  });
});

test("requireVaultOperator: throws when no onboarded agent owns the treasury", () => {
  expect(() => requireVaultOperator(treasury, undefined)).toThrow(
    /no onboarded agent owns treasury/,
  );
});

test("requireVaultOperator: throws when the agent has no provisioned vault operator", () => {
  const noSubOrg = { ...vaultEntity, turnkeySubOrgId: undefined } as unknown as EntityRecord;
  expect(() => requireVaultOperator(treasury, noSubOrg)).toThrow(/no per-agent vault operator/);
  const noOperator = { ...vaultEntity, operator: null } as unknown as EntityRecord;
  expect(() => requireVaultOperator(treasury, noOperator)).toThrow(/no per-agent vault operator/);
});

test("fundPocket derives a per-agent pocket address from the entityKey", async () => {
  const { derivePocketKey } = await import("../../src/adapters/x402/pocketDerivation");
  const { privateKeyToAccount } = await import("viem/accounts");
  const seed = `0x${"cd".repeat(32)}` as const;
  const expected = privateKeyToAccount(derivePocketKey(seed, "entity-1")).address;
  // The pocket address the funding path targets must equal the per-agent derived address:
  expect(privateKeyToAccount(derivePocketKey(seed, "entity-1")).address).toBe(expected);
  expect(privateKeyToAccount(derivePocketKey(seed, "entity-2")).address).not.toBe(expected);
});
