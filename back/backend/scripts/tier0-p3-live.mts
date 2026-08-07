/**
 * Tier-0 P3 — one REAL circle agent through the full production stack, run locally against the
 * live Arc testnet (prod carries no Circle creds yet — and P3 on the prod DB is structurally
 * forbidden anyway: assertCircleCoverage would refuse the next prod boot).
 *
 * Legs (production code paths only — same builders api/main wires):
 *   1. runOnboarding custody=circle: provision SCA+pocket -> activateCircleSca (P2 probe-A fix)
 *      -> createEntity on the LIVE factory -> setAgentWallet with the SCA's ERC-1271 signature
 *      against the LIVE registry (first non-fork 1271 bind) -> fundTreasury 3 USDC.
 *   2. buildPocketFunding -> runCircleBridge: fundOperator -> exact approve -> depositFor(pocket),
 *      0.30 USDC, persisted bridge_legs saga.
 *   3. buildEntityPaymentService.pay: 0.01 USDC to the PROD demo seller through the Vercel proxy
 *      (Circle-MPC pocket signature, facilitator settle) — full buyer-side prod parity.
 *   4. buildJobDeps.runJob: 1 USDC ERC-8183 job via circleJobOps (SCA setBudget/submit through
 *      Gas Station) -> evaluator -> sweep.
 *
 * Run: npx tsx scripts/tier0-p3-live.mts [--leg 1|2|3|4]
 * Idempotent-ish: leg 1 reuses the persisted saga record (DATA_DIR=./data-p3).
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { formatUnits } from "viem";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { managerWalletClient, publicClientFor } from "../src/adapters/arc/clients";
import { withCircleRateLimit } from "../src/adapters/circle/circleRateLimit";
import {
  activateCircleSca,
  buildCircleWalletsApi,
  circleOperatorSigner,
  provisionCircleWallets,
} from "../src/adapters/circle/circleWallets";
import { loadConfig } from "../src/config/env";
import { buildJobDeps } from "../src/jobs/composition";
import { buildEntityPaymentService } from "../src/payments/entityPayment";
import { PaymentLedger } from "../src/payments/ledger";
import { buildPocketFunding } from "../src/payments/pocketFunding";
import { SqliteBridgeLegRepository } from "../src/persistence/bridgeLegRepository";
import { migrate, openDatabase } from "../src/persistence/db";
import { FileDocumentStore } from "../src/persistence/documentStore";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import { SqlitePaymentIdempotencyStore } from "../src/persistence/paymentIdempotencyStore";
import { parseAgentSpec } from "../src/policy/agentSpec";
import type { Address } from "../src/types";
import { runOnboarding } from "../src/workflow/onboarding";

const ENTITY_KEY = "p3:circle-live-1";
const SELLER_URL = "https://project-alpha-pi.vercel.app/backend/x402-demo/quote";
const CIRCLE_BLOCKCHAIN = "ARC-TESTNET";

const onlyLeg = process.argv.includes("--leg")
  ? process.argv[process.argv.indexOf("--leg") + 1]
  : undefined;
const want = (leg: string) => !onlyLeg || onlyLeg === leg;

function banner(s: string) {
  console.log(`\n${"━".repeat(70)}\n${s}\n${"━".repeat(70)}`);
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.circle?.walletSetId) throw new Error("Circle creds + wallet set required (local .env)");
  const db = openDatabase(cfg.dbPath);
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  const docStore = new FileDocumentStore(cfg.docStoreDir);
  const circleApi = withCircleRateLimit(buildCircleWalletsApi(cfg.circle));
  const arc = new ArcAdapter({
    publicClient: publicClientFor(cfg),
    managerWallet: managerWalletClient(cfg),
    chainId: cfg.chainId,
    factory: cfg.factoryAddress as Address,
    identityRegistry: cfg.identityRegistry,
  });
  const managerAddress = managerWalletClient(cfg).account!.address;
  const walletSetId = cfg.circle.walletSetId;

  // Same seams api/main wires for the saga (activation included — the P2 probe-A fix).
  const provisionCircle = async ({ entityKey }: { entityKey: string; name: string }) => {
    const { operator, pocket } = await provisionCircleWallets(circleApi, {
      walletSetId,
      blockchain: CIRCLE_BLOCKCHAIN,
      entityKey,
    });
    await activateCircleSca(circleApi, {
      operatorWalletId: operator.walletId,
      entityKey,
      usdc: cfg.usdc,
      gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    });
    return {
      operator: operator.address,
      operatorWalletId: operator.walletId,
      pocketWalletId: pocket.walletId,
      pocketAddress: pocket.address,
      walletSetId,
    };
  };

  const spec = parseAgentSpec({
    name: "P3CircleAgent",
    jurisdiction: "Wyoming-DAO-LLC",
    roles: { manager: managerAddress, guardian: cfg.guardianAddress },
    treasury: {
      payoutAddress: managerAddress,
      spendingCapUsdc: "100.00",
      spendingPeriod: "24h",
      allowlistEnabled: false,
    },
    governance: { amendmentDelay: "24h" },
    legal: {},
    metadata: { purpose: "Tier-0 P3 live validation agent (circle custody)" },
  });

  // ── Leg 1: onboarding saga, custody=circle, +3 USDC treasury fund ────────────────────────
  if (want("1")) {
    banner("Leg 1 — onboard (circle custody) on the LIVE chain");
    const t0 = Date.now();
    const rec = await runOnboarding({
      spec,
      idempotencyKey: ENTITY_KEY,
      repo,
      docStore,
      arc,
      operatorSigner: {
        address: managerAddress,
        signWalletSet: async () => {
          throw new Error("legacy shared signer must NOT be used on the circle path");
        },
      } as never,
      usdc: cfg.usdc,
      metadataBaseUrl: cfg.metadataBaseUrl,
      ownerTenantId: managerAddress,
      specJson: JSON.stringify(spec),
      custody: "circle",
      provisionCircle,
      circleSignerForEntity: (e) =>
        circleOperatorSigner(circleApi, { walletId: e.operatorWalletId, address: e.operator }),
      fundAmount: 350_000n, // 0.35 USDC (platform test wallet is nearly dry — amounts shrunk to fit)
    });
    console.log(`  status=${rec.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  agentId=${rec.agentId} treasury=${rec.treasury}`);
    console.log(`  operator(SCA)=${rec.operator} pocket=${rec.pocketAddress}`);
    console.log(`  createTx=${rec.createTxHash}`);
    console.log(`  bindTx=${rec.bindTxHash}  <-- LIVE-REGISTRY ERC-1271 BIND`);
    console.log(`  fundTx=${rec.fundTxHash}`);
    const boundWallet = await arc.getAgentWallet(BigInt(rec.agentId!));
    console.log(
      `  registry getAgentWallet=${boundWallet} (${boundWallet.toLowerCase() === rec.operator!.toLowerCase() ? "MATCHES SCA ✓" : "MISMATCH ✗"})`,
    );
  }

  // ── Leg 2: the circle funding bridge (fund -> approve -> depositFor) ─────────────────────
  if (want("2")) {
    banner("Leg 2 — circle bridge: treasury -> SCA -> Gateway(pocket), 0.25 USDC");
    const entity = repo.findByIdempotencyKey(ENTITY_KEY);
    if (!entity) throw new Error("run leg 1 first");
    const fundPocket = buildPocketFunding(cfg, undefined, {
      api: circleApi,
      legs: new SqliteBridgeLegRepository(db),
    });
    const t0 = Date.now();
    const hashes = await fundPocket(entity, 250_000n);
    console.log(`  ${hashes.length} legs confirmed in ${((Date.now() - t0) / 1000).toFixed(1)}s:`);
    for (const h of hashes) console.log(`    ${h}`);
  }

  // ── Leg 3: live pay to the PROD seller with the Circle-MPC pocket signature ──────────────
  if (want("3")) {
    banner("Leg 3 — pay 0.01 USDC to the PROD demo seller (Vercel proxy, facilitator settle)");
    const entity = repo.findByIdempotencyKey(ENTITY_KEY);
    if (!entity) throw new Error("run leg 1 first");
    const payments = buildEntityPaymentService(cfg, {
      reader: arc,
      ledger: new PaymentLedger(db),
      idempotency: new SqlitePaymentIdempotencyStore(db),
      circleApi,
    });
    const receipt = await payments.pay(entity, {
      url: SELLER_URL,
      amountUsdc: 10_000n,
      idempotencyKey: `p3-pay-${randomUUID().slice(0, 8)}`,
      tenantId: managerAddress,
    });
    console.log(`  receipt: ${JSON.stringify(receipt)}`);
    if (!receipt.ok) throw new Error(`pay failed: ${receipt.reason}`);
  }

  // ── Leg 4: ERC-8183 job through circleJobOps (SCA + Gas Station) ─────────────────────────
  if (want("4")) {
    banner("Leg 4 — run_job: 0.05 USDC budget, circle provider ops, evaluator, sweep");
    const jobDeps = buildJobDeps(cfg, db, repo, docStore, circleApi);
    const jobKey = `${ENTITY_KEY}:${Date.now()}-${randomUUID().slice(0, 6)}`;
    const t0 = Date.now();
    const job = await jobDeps.runJob({
      jobKey,
      entityKey: ENTITY_KEY,
      budget: 50_000n,
      description: "P3 live validation job (circle custody)",
    });
    console.log(
      `  job ${job.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s (jobId=${job.jobId})`,
    );
    console.log(
      `  txs: ${JSON.stringify(job, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
    );
  }

  // Final record snapshot
  const rec = repo.findByIdempotencyKey(ENTITY_KEY);
  if (rec) {
    banner("P3 record");
    console.log(
      JSON.stringify(
        {
          status: rec.status,
          walletProvider: rec.walletProvider,
          agentId: rec.agentId,
          operator: rec.operator,
          pocketAddress: rec.pocketAddress,
          circleOperatorWalletId: rec.circleOperatorWalletId,
          circlePocketWalletId: rec.circlePocketWalletId,
          bindTxHash: rec.bindTxHash,
        },
        null,
        2,
      ),
    );
  }
  db.close();
}

main().catch((e) => {
  console.error("\nP3 failed:", e);
  process.exit(1);
});
