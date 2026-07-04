// backend/src/agent/liveRunner.ts
import Anthropic from "@anthropic-ai/sdk";
import Database from "better-sqlite3";
import { http, type WalletClient, createPublicClient, createWalletClient, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { managerWalletClient } from "../adapters/arc/clients";
import { buildOperatorWalletClientForEntity } from "../adapters/turnkey/operatorWallet";
import { PocketGateway } from "../adapters/x402/gateway";
import { arcBatchingConfig, pocketSignerFromKey } from "../adapters/x402/pocket";
import { derivePocketKey } from "../adapters/x402/pocketDerivation";
import { makeSignX402 } from "../adapters/x402/signX402";
import { chainFor } from "../chains";
import { type Config, loadConfig } from "../config/env";
import { authorizePayment } from "../payments/authority";
import { topUpPocket } from "../payments/funding";
import { ensureNativeGas } from "../payments/gasSeeder";
import { PaymentLedger } from "../payments/ledger";
import { sweepPocketToTreasury } from "../payments/pocketFloat";
import { buildPaywall } from "../payments/seller";
import { makeSettle } from "../payments/settle";
import type { SettleFn } from "../payments/settle";
import { SqliteAgentRunStore } from "../persistence/agentRunStore";
import type { RunPaymentInput } from "../persistence/agentRunStore";
import { migrate } from "../persistence/db";
import { SqliteEntityRepository } from "../persistence/entityRepository";
import { usdToUnits } from "../policy/units";
import type { Address, EntityRecord, Hex } from "../types";
import type { DemoResult } from "./demo";
import { runDemo } from "./demo";
import { persistAgentRun } from "./persistRun";
import { buildVendor } from "./vendor";

/** Minimal ERC-20 transfer fragment for sweeping the pocket's residual USDC to the treasury. */
const erc20TransferAbi = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

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

/** The per-agent vault operator identity that is authorized to pull from a treasury. The live
 *  funding leg signs `fundOperator` as THIS agent's vault operator (not a shared root key), so it
 *  works for treasuries created via the per-agent Turnkey vault. Throws if the treasury has no
 *  onboarded agent or that agent lacks a provisioned vault operator. */
export function requireVaultOperator(
  treasury: string,
  e: EntityRecord | undefined,
): { subOrgId: string; operator: string } {
  if (!e) throw new Error(`fundPocket: no onboarded agent owns treasury ${treasury}`);
  if (!e.turnkeySubOrgId || !e.operator)
    throw new Error(
      `fundPocket: agent ${e.idempotencyKey} has no per-agent vault operator (turnkey_sub_org_id + operator) to fund treasury ${treasury}`,
    );
  return { subOrgId: e.turnkeySubOrgId, operator: e.operator };
}

/** The pocket master seed is required to derive a per-agent pocket. */
function requireMasterSeed(cfg: Config): Hex {
  if (!cfg.pocketMasterSeed) throw new Error("set POCKET_MASTER_SEED to run the funding bridge");
  return cfg.pocketMasterSeed;
}

/** Leg 0: governed top-up treasury -> operator(enclave) -> pocket -> Gateway. Returns the on-chain tx
 *  hashes. `operatorWallet` must sign as the treasury's authorized operator (its per-agent vault key).
 *  The pocket used is derived per-agent from the master seed + `entityKey` (no per-agent key storage). */
export async function fundPocket(
  cfg: Config,
  treasury: Address,
  floatAtomic: bigint,
  operatorWallet: WalletClient,
  entityKey: string,
): Promise<Hex[]> {
  const pocketKey = derivePocketKey(requireMasterSeed(cfg), entityKey);
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
  const gateway = new PocketGateway({ pocketPrivateKey: pocketKey, rpcUrl: cfg.rpcUrl });
  const operatorAddress = operatorWallet.account?.address;
  if (!operatorAddress) throw new Error("fundPocket: operator wallet has no account address");

  const managerWallet = managerWalletClient(cfg);
  const seedTxs = await ensureNativeGas([operatorAddress, gateway.address], {
    getBalance: (addr) => pub.getBalance({ address: addr }),
    sendNative: (to, value) =>
      managerWallet.sendTransaction({
        to,
        value,
        account: managerWallet.account!,
        chain: managerWallet.chain,
      }),
    // Await the seed mining before topUpPocket depends on it — sendNative only returns a mempool
    // hash, and topUpPocket's operator-/pocket-signed txs would otherwise race an unmined seed and
    // fail with "gas required exceeds allowance (0)".
    confirm: (hash) => pub.waitForTransactionReceipt({ hash }).then(() => undefined),
    floor: parseEther(cfg.gasSeedFloorUsdc),
    target: parseEther(cfg.gasSeedTargetUsdc),
  });

  // Retry-safety (#32): if the operator already holds the fundOperator credit (a re-run completing a
  // partial bridge), skip re-pulling from the treasury. The gas-seed lands the operator at
  // gasSeedTarget; a landed credit pushes it to ~gasSeedTarget + amount (minus small gas), so the
  // amount/2 margin cleanly distinguishes "seeded only" from "seeded + credit".
  const seedTargetAtomic = usdToUnits(cfg.gasSeedTargetUsdc);
  const operatorBalance = await adapter.usdcBalanceOf(cfg.usdc, operatorAddress);
  const skipFundOperator = operatorBalance >= seedTargetAtomic + floatAtomic / 2n;

  const bridgeTxs = await topUpPocket(
    {
      treasury,
      // NOTE: uses cfg.usdc (the platform-global token). treasury_status.balance in entityPayment.ts
      // instead reads `entity.treasuryConfig?.usdc ?? cfg.usdc` — the two token sources coincide today
      // (onboarding sets treasuryConfig.usdc = cfg.usdc) but should not silently drift.
      usdc: cfg.usdc,
      pocketAddress: gateway.address,
      available: () => adapter.treasuryAvailable(treasury),
      operatorUsdcBalance: () => adapter.usdcBalanceOf(cfg.usdc, operatorAddress),
      fundOperator: (t, a) => adapter.fundOperator(t, a),
      operatorTransferUsdc: (u, to, a) => adapter.operatorTransferUsdc(u, to, a),
      depositToGateway: (amt) => gateway.deposit(amt),
    },
    floatAtomic,
    { skipFundOperator },
  );
  return [...seedTxs, ...bridgeTxs];
}

/** Live composition root: wire real funding + agent + settled sell into a single runner. */
export async function buildLiveAgentRunner(
  cfg: Config = loadConfig(),
): Promise<(query: string) => Promise<LiveRunResult>> {
  if (!cfg.anthropicApiKey) throw new Error("set ANTHROPIC_API_KEY to run the agent");
  requireMasterSeed(cfg);
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
  const runs = new SqliteAgentRunStore(db);
  const entities = new SqliteEntityRepository(db);

  // Fund from the treasury via ITS agent's own per-agent vault operator (not a shared root key),
  // so the governed `fundOperator` call is authorized. Resolved once; the wallet is a Turnkey API
  // read (no signing) so building it costs no enclave signatures.
  const maybeEntity = entities.findByTreasury(treasury);
  const vault = requireVaultOperator(treasury, maybeEntity);
  if (!maybeEntity) throw new Error(`fundPocket: no onboarded agent owns treasury ${treasury}`);
  const entity = maybeEntity;
  const operatorWallet = await buildOperatorWalletClientForEntity(cfg, vault);

  const pocketKey = derivePocketKey(requireMasterSeed(cfg), entity.idempotencyKey);
  const signX402 = makeSignX402({
    signer: pocketSignerFromKey(pocketKey),
    chainId: cfg.chainId,
    network: arcBatchingConfig.network,
    verifyingContract: arcBatchingConfig.verifyingContract,
  });

  // The pocket's own signer — used at the end of each run to sweep its residual USDC back to the
  // treasury (keeps the per-agent float ~zero; Gateway-held balance is not swept, only the EOA's).
  const pocketAccount = privateKeyToAccount(pocketKey);
  const pocketAddress = pocketAccount.address;
  const pocketWallet = createWalletClient({
    account: pocketAccount,
    chain: chainFor(cfg.chainId, cfg.rpcUrl),
    transport: http(cfg.rpcUrl),
  });
  const sweepPocket = () =>
    sweepPocketToTreasury({
      treasury,
      usdc: cfg.usdc,
      dust: 10_000n,
      pocketUsdcBalance: () => adapter.usdcBalanceOf(cfg.usdc, pocketAddress),
      transferToTreasury: async (to, amount) => {
        const { request } = await pub.simulateContract({
          account: pocketWallet.account,
          address: cfg.usdc,
          abi: erc20TransferAbi,
          functionName: "transfer",
          args: [to, amount],
        });
        const hash = await pocketWallet.writeContract(request);
        await pub.waitForTransactionReceipt({ hash });
        return hash;
      },
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

  const floatAtomic = usdToUnits(cfg.fundingFloatUsdc);

  const authorityDeps = {
    ledger,
    entityKey: entity.idempotencyKey,
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
    perTxCap: entity?.perTxCap ?? undefined,
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
    runningPending: ledger.runningPending(entity.idempotencyKey),
  });

  return async (query: string) => {
    // reset per-run accumulators so receipts never bleed across invocations of this runner
    settleTransferIds.length = 0;
    paymentRecords.length = 0;
    const result = await runLive(
      {
        fund: (amt) => fundPocket(cfg, treasury, amt, operatorWallet, entity.idempotencyKey),
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
    // Sweep is best-effort cleanup after a successful run; failure must not fail the result.
    try {
      await sweepPocket();
    } catch (e) {
      console.warn(
        `post-run pocket sweep failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return result;
  };
}
