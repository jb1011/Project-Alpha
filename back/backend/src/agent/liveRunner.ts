// backend/src/agent/liveRunner.ts
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { http, createPublicClient } from "viem";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { buildOperatorWalletClient } from "../adapters/turnkey/operatorWallet";
import { PocketGateway } from "../adapters/x402/gateway";
import { arcBatchingConfig, pocketSignerFromKey } from "../adapters/x402/pocket";
import { makeSignX402 } from "../adapters/x402/signX402";
import { chainFor } from "../chains";
import { type Config, loadConfig } from "../config/env";
import { authorizePayment } from "../payments/authority";
import { topUpPocket } from "../payments/funding";
import { PaymentLedger } from "../payments/ledger";
import { buildPaywall } from "../payments/seller";
import { makeSettle } from "../payments/settle";
import type { SettleFn } from "../payments/settle";
import { SqliteAgentRunStore } from "../persistence/agentRunStore";
import type { RunPaymentInput } from "../persistence/agentRunStore";
import { migrate } from "../persistence/db";
import { SqliteEntityRepository } from "../persistence/entityRepository";
import { usdToUnits } from "../policy/units";
import type { Address, Hex } from "../types";
import type { DemoResult } from "./demo";
import { runDemo } from "./demo";
import { persistAgentRun } from "./persistRun";
import { buildVendor } from "./vendor";

export interface SellParams {
  chainId: number;
  answer: string;
  price: bigint;
  sellerPayTo: Address; // the treasury payout — revenue lands governed
  customerPrivateKey: Hex; // the simulated customer's signer (defaults to the platform key upstream)
  settle: SettleFn;
  resourceUrl?: string;
}

export interface LiveDeps {
  fund: (floatAtomic: bigint) => Promise<Hex[]>;
  runDemo: (query: string) => Promise<DemoResult>;
  sell: (answer: string, price: bigint) => Promise<{ ok: boolean; status: number }>;
  floatAtomic: bigint;
  settleTransferIds: () => string[];
  customer: Address;
  vendorPayout: Address;
}

export interface LiveRunResult extends DemoResult {
  fundingTxs: Hex[];
  settleTransferIds: string[];
  sold: boolean;
  customer: Address;
  vendorPayout: Address;
}

/** Orchestrate the three legs: fund the pocket, run the agent (buys settle via its vendor), then sell the answer. */
export async function runLive(d: LiveDeps, query: string): Promise<LiveRunResult> {
  const fundingTxs = await d.fund(d.floatAtomic); // leg 0 — before the agent can spend
  const demo = await d.runDemo(query); // leg 1 — agent buys (settles) + synthesizes + prices
  const sale = await d.sell(demo.answer, demo.price); // leg 2 — customer buys the answer (settles in)
  return {
    ...demo,
    fundingTxs,
    settleTransferIds: d.settleTransferIds(),
    sold: sale.ok,
    customer: d.customer,
    vendorPayout: d.vendorPayout,
  };
}

/** Leg 2: a simulated customer pays the agent's own paywall for the answer; the Seller verifies + settles. */
export async function sellAnswer(p: SellParams): Promise<{ ok: boolean; status: number }> {
  const paywall = buildPaywall({
    price: p.price,
    payTo: p.sellerPayTo,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
    serve: () => ({ answer: p.answer }),
    settle: p.settle,
    resourceUrl: p.resourceUrl ?? "agent://insight",
  });
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(p.customerPrivateKey),
    chainId: p.chainId,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });
  const { header } = await signX402({
    payTo: p.sellerPayTo,
    amount: p.price,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
    maxTimeoutSeconds: 600,
  });
  const res = await paywall.request("/api/insight", { headers: { "X-PAYMENT": header } });
  return { ok: res.status === 200, status: res.status };
}

/** Validate the three demo addresses from env: treasury + vendorPayout required, and distinct. */
export function resolveLiveAddresses(env: {
  treasury?: string;
  vendorPayout?: string;
  agentPayout?: string;
}): { treasury: Address; vendorPayout: Address; agentPayout: Address } {
  const treasury = (env.treasury ?? "") as Address;
  if (!treasury) throw new Error("set TREASURY_ADDRESS to run the agent");
  const vendorPayout = (env.vendorPayout ?? "") as Address;
  if (!vendorPayout)
    throw new Error(
      "set VENDOR_PAYOUT_ADDRESS (the data-vendor cost destination) to run the agent",
    );
  if (vendorPayout.toLowerCase() === treasury.toLowerCase()) {
    throw new Error(
      "VENDOR_PAYOUT_ADDRESS must differ from TREASURY_ADDRESS (cost must leave the treasury)",
    );
  }
  const agentPayout = (env.agentPayout || treasury) as Address;
  return { treasury, vendorPayout, agentPayout };
}

/** Leg 0: governed top-up treasury -> operator(enclave) -> pocket -> Gateway. Returns the on-chain tx hashes. */
export async function fundPocket(
  cfg: Config,
  treasury: Address,
  floatAtomic: bigint,
): Promise<Hex[]> {
  if (!cfg.turnkey)
    throw new Error("the funding bridge needs the Turnkey enclave operator (set TURNKEY_*)");
  if (!cfg.pocketPrivateKey) throw new Error("set POCKET_PRIVATE_KEY to run the funding bridge");
  const operatorWallet = await buildOperatorWalletClient(cfg);
  const pub = createPublicClient({
    chain: chainFor(cfg.chainId, cfg.rpcUrl),
    transport: http(cfg.rpcUrl),
  });
  const adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: undefined as never, // not used by the operator-sent funding txs
    operatorWallet,
    chainId: cfg.chainId,
    factory: (cfg.factoryAddress ?? "0x0") as Address,
    identityRegistry: cfg.identityRegistry,
  });
  const gateway = new PocketGateway({ pocketPrivateKey: cfg.pocketPrivateKey, rpcUrl: cfg.rpcUrl });
  const txs: Hex[] = [];
  await topUpPocket(
    {
      treasury,
      usdc: cfg.usdc,
      pocketAddress: gateway.address,
      available: () => adapter.treasuryAvailable(treasury),
      fundOperator: async (t, a) => {
        const h = await adapter.fundOperator(t, a);
        txs.push(h);
        return h;
      },
      operatorTransferUsdc: async (u, to, a) => {
        const h = await adapter.operatorTransferUsdc(u, to, a);
        txs.push(h);
        return h;
      },
      depositToGateway: (amt) => gateway.deposit(amt),
    },
    floatAtomic,
  );
  return txs;
}

/** Live composition root: wire real funding + agent + settled sell into a single runner. */
export async function buildLiveAgentRunner(
  cfg: Config = loadConfig(),
): Promise<(query: string) => Promise<LiveRunResult>> {
  if (!cfg.anthropicApiKey) throw new Error("set ANTHROPIC_API_KEY to run the agent");
  if (!cfg.pocketPrivateKey) throw new Error("set POCKET_PRIVATE_KEY to run the agent");
  const { treasury, vendorPayout, agentPayout } = resolveLiveAddresses({
    treasury: process.env.TREASURY_ADDRESS,
    vendorPayout: process.env.VENDOR_PAYOUT_ADDRESS,
    agentPayout: process.env.AGENT_PAYOUT_ADDRESS,
  });

  const pub = createPublicClient({
    chain: chainFor(cfg.chainId, cfg.rpcUrl),
    transport: http(cfg.rpcUrl),
  });
  const adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: undefined as never,
    chainId: cfg.chainId,
    factory: (cfg.factoryAddress ?? "0x0") as Address,
    identityRegistry: cfg.identityRegistry,
  });
  const db = new Database(cfg.dbPath);
  migrate(db);
  const ledger = new PaymentLedger(db);
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(cfg.pocketPrivateKey),
    chainId: cfg.chainId,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });

  const customer = pocketSignerFromKey(cfg.customerPrivateKey).address;

  // recording settle shared by both legs
  const settleTransferIds: string[] = [];
  const paymentRecords: RunPaymentInput[] = [];
  const baseSettle = makeSettle({ facilitatorUrl: cfg.gatewayFacilitatorUrl });
  const settle: SettleFn = async (header, reqs) => {
    const r = await baseSettle(header, reqs);
    if (r.ok && r.transferId) settleTransferIds.push(r.transferId);
    const isBuy = reqs.payTo.toLowerCase() === vendorPayout.toLowerCase();
    paymentRecords.push({
      direction: isBuy ? "buy" : "sell",
      counterparty: isBuy ? reqs.payTo : customer,
      amount: reqs.amount,
      transferId: r.ok ? (r.transferId ?? null) : null,
      status: r.ok ? "settled" : "failed",
    });
    return r;
  };

  const authorityDeps = {
    ledger,
    readTreasury: async (payee: Address) => ({
      available: await adapter.treasuryAvailable(treasury),
      paused: await adapter.treasuryPaused(treasury),
      allowlistEnabled: await adapter.treasuryAllowlistEnabled(treasury),
      isAllowed: await adapter.treasuryIsAllowed(treasury, payee),
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
    authorizePayment(authorityDeps, req);

  const vendor = buildVendor({
    payTo: vendorPayout,
    asset: arcBatchingConfig.asset,
    network: arcBatchingConfig.network,
    settle,
  });
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey });
  const readBudget = async () => ({
    available: await adapter.treasuryAvailable(treasury),
    runningPending: ledger.runningPending(),
  });
  const floatAtomic = usdToUnits(cfg.fundingFloatUsdc);

  const runs = new SqliteAgentRunStore(db);
  const entities = new SqliteEntityRepository(db);

  return async (query: string) => {
    const result = await runLive(
      {
        fund: (amt) => fundPocket(cfg, treasury, amt),
        runDemo: (q) =>
          runDemo(
            {
              client,
              model: cfg.agentModel,
              vendor,
              authorize,
              readBudget,
              vendorBase: "http://vendor.local",
              margin: 0.5,
              agentPayout,
            },
            q,
          ),
        sell: (answer, price) =>
          sellAnswer({
            chainId: cfg.chainId,
            answer,
            price,
            sellerPayTo: agentPayout,
            customerPrivateKey: cfg.customerPrivateKey,
            settle,
          }),
        floatAtomic,
        settleTransferIds: () => settleTransferIds,
        customer,
        vendorPayout,
      },
      query,
    );
    persistAgentRun({ runs, entities }, treasury, query, result, paymentRecords);
    return result;
  };
}
