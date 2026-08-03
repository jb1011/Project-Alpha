import "dotenv/config";
import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { managerAccount, managerWalletClient, publicClientFor } from "../adapters/arc/clients";
import { buildTurnkeyProvisionDeps } from "../adapters/turnkey/clients";
import { buildOperatorSigner } from "../adapters/turnkey/operatorSigner";
import { type GuardianPasskey, provisionAgentVault } from "../adapters/turnkey/provisioner";
import { TurnkeySigner } from "../adapters/turnkey/turnkeySigner";
import { SqliteNonceStore } from "../auth/nonceStore";
import { WORLD_CHAIN_DEFAULTS, loadConfig } from "../config/env";
import { buildJobDeps } from "../jobs/composition";
import { createAgentBookReader } from "../payments/agentBookReader";
import { buildEntityPaymentService } from "../payments/entityPayment";
import { PaymentLedger } from "../payments/ledger";
import { buildOutflowMeter } from "../payments/outflowMeter";
import { buildPocketFunding } from "../payments/pocketFunding";
import { buildSellerTrust } from "../payments/sellerTrust";
import { buildReadExposure } from "../payments/standingExposure";
import { SqliteAgentRunStore } from "../persistence/agentRunStore";
import { SqliteApiKeyStore } from "../persistence/apiKeyStore";
import { SqliteChallengeStore } from "../persistence/challengeStore";
import { migrate, openDatabase } from "../persistence/db";
import { FileDocumentStore } from "../persistence/documentStore";
import { SqliteEntityRepository } from "../persistence/entityRepository";
import { SqliteLinkCodeStore } from "../persistence/linkCodeStore";
import { SqlitePasskeyStore } from "../persistence/passkeyStore";
import { SqlitePaymentIdempotencyStore } from "../persistence/paymentIdempotencyStore";
import { assertCircleCoverage, backfillPocketAddresses } from "../persistence/tier0";
import { SqliteWorldStore } from "../persistence/worldStore";
import { usdToUnits } from "../policy/units";
import type { Address } from "../types";
import { runOnboarding } from "../workflow/onboarding";
import { OnboardingRunner, type RunSaga } from "../workflow/runner";
import { buildApiApp } from "./app";
import { buildX402DemoDeps } from "./routes/x402Demo";

async function main() {
  const cfg = loadConfig();
  if (!cfg.factoryAddress) throw new Error("FACTORY_ADDRESS is required to run the API server");
  if (!cfg.turnkey?.delegatedApiPublicKey || !cfg.turnkey?.delegatedApiPrivateKey)
    throw new Error(
      "TURNKEY_DELEGATED_API_{PUBLIC,PRIVATE}_KEY are required to run the API server",
    );

  const db = openDatabase(cfg.dbPath);
  migrate(db);
  // Tier-0: refuse to boot with unserviceable circle-path agents; store pocket addresses once
  // so read paths can stop deriving from the master seed (spec audit items 1 + 7).
  assertCircleCoverage(db, cfg.circle);
  if (cfg.pocketMasterSeed) backfillPocketAddresses(db, cfg.pocketMasterSeed);
  const repo = new SqliteEntityRepository(db);
  const docStore = new FileDocumentStore(cfg.docStoreDir);
  const nonceStore = new SqliteNonceStore(db);
  const apiKeys = new SqliteApiKeyStore(db);
  const passkeys = new SqlitePasskeyStore(db);
  const challenges = new SqliteChallengeStore(db);
  const agentRuns = new SqliteAgentRunStore(db);
  const arc = new ArcAdapter({
    publicClient: publicClientFor(cfg),
    managerWallet: managerWalletClient(cfg),
    chainId: cfg.chainId,
    factory: cfg.factoryAddress as Address,
    identityRegistry: cfg.identityRegistry,
  });
  const operatorSigner = await buildOperatorSigner(cfg);
  // S5: the platform-wide outflow brake — one meter, shared by every path in this process.
  const outflows = buildOutflowMeter(db, {
    ceilingAtomic: cfg.platformOutflowCeiling,
    windowMs: cfg.platformOutflowWindowMs,
  });
  // Audit fix C: the platform manager address, force-set into `roles.manager` on onboarding so an
  // agent-first caller never needs to know or guess it (see managerAccount doc).
  const platformManagerAddress = managerAccount(cfg).address;

  // Per-entity payment service (treasury_status/pay tools) needs a pocket-derivation seed; leave
  // it undefined on deployments that haven't set POCKET_MASTER_SEED so they keep working (the
  // tools then return "payments unavailable" instead of failing to boot).
  const payments = cfg.pocketMasterSeed
    ? buildEntityPaymentService(cfg, {
        reader: arc,
        ledger: new PaymentLedger(db),
        idempotency: new SqlitePaymentIdempotencyStore(db),
        // Buyer trust dial (X402_BUYER_TRUST_POLICY, default "open" = no-op): when strict, the
        // payee must be human-backed in AgentBook before anything is signed. Works without any
        // WORLD_* portal creds — the reader only needs the World Chain RPC + AgentBook address,
        // both of which have defaults. docs/design/2026-07-30-trust-policy-dials.md
        sellerTrust: buildSellerTrust({
          globalPolicy: cfg.x402BuyerTrustPolicy,
          store: new SqliteWorldStore(db),
          reader: createAgentBookReader({
            rpcUrl: cfg.worldChain?.rpcUrl ?? WORLD_CHAIN_DEFAULTS.rpcUrl,
            contractAddress: cfg.worldChain?.agentBook ?? WORLD_CHAIN_DEFAULTS.agentBook,
          }),
          // Legal-bodies tier: local registry lookup + the same Arc reads the dashboard trusts.
          legalBodies: {
            findByTreasury: (addr) => {
              const rec = repo.findByTreasury(addr);
              return rec ? { proxy: rec.proxy, treasury: rec.treasury } : undefined;
            },
            legalStatus: (proxy) => arc.legalStatus(proxy),
            treasuryPaused: (treasury) => arc.treasuryPaused(treasury),
          },
        }),
      })
    : undefined;

  // Explicit treasury->pocket top-up (fund_pocket tool/route). Same guard as `payments`: needs both
  // POCKET_MASTER_SEED (to derive the pocket) and Turnkey config (to sign as the operator).
  const pocketFunding =
    cfg.pocketMasterSeed && cfg.turnkey ? buildPocketFunding(cfg, outflows) : undefined;

  // S2 standing-float-ceiling reads for the dashboard (GET /entities/:id/treasury). Same guard as
  // `payments`: undefined when POCKET_MASTER_SEED isn't configured, in which case the route
  // reports zeroed standing instead of failing to boot.
  const standingExposure = cfg.pocketMasterSeed
    ? {
        read: buildReadExposure(cfg, arc),
        ceilingAtomic: usdToUnits(cfg.maxPocketFloatUsdc).toString(),
      }
    : undefined;

  const provision = (p: {
    subOrgName: string;
    guardianPasskey: GuardianPasskey;
    guardianEmail?: string;
  }) =>
    provisionAgentVault(buildTurnkeyProvisionDeps(cfg), {
      ...p,
      delegatedApiPublicKey: cfg.turnkey!.delegatedApiPublicKey!,
    });
  const signerForEntity = (e: { subOrgId: string; operator: string }) =>
    TurnkeySigner.forEntity(cfg, e);

  const runSaga: RunSaga = (i) =>
    runOnboarding({
      spec: i.spec,
      idempotencyKey: i.idempotencyKey,
      repo,
      docStore,
      arc,
      operatorSigner,
      usdc: cfg.usdc,
      metadataBaseUrl: cfg.metadataBaseUrl,
      ensParentName: cfg.ens?.parentName,
      ownerTenantId: i.tenantId,
      specJson: i.specJson,
      fundAmount: i.fundAmount,
      guardianPasskey: i.guardianPasskey,
      provision,
      signerForEntity,
      outflows,
    });

  const runner = new OnboardingRunner({
    repo,
    runSaga,
    fundCaps: { perCall: cfg.maxTreasuryFund, perTenantTotal: cfg.maxTreasuryFundedPerTenant },
    outflows,
  });
  const resumed = runner.reconcileInFlight();
  if (resumed) console.log(`Resumed ${resumed} in-flight onboarding(s)`);

  const jobDeps = buildJobDeps(cfg, db, repo, docStore);
  const resumedJobs = jobDeps.jobRunner.reconcileInFlight();
  if (resumedJobs) console.log(`Resumed ${resumedJobs} in-flight job(s)`);

  const x402Demo = buildX402DemoDeps(cfg);
  // World gate on the demo seller: authorize human-backed agents (AgentBook on World Chain)
  // before requiring payment. Settlement stays on Arc, untouched.
  if (x402Demo && cfg.worldChain) {
    const host = new URL(x402Demo.resourceUrl).hostname;
    x402Demo.agentkit = {
      domain: host,
      resourceUrl: x402Demo.resourceUrl,
      network: x402Demo.network,
      store: new SqliteWorldStore(db),
      allowancePerHuman: cfg.worldChain.allowancePerHuman,
      worldChainRpc: cfg.worldChain.rpcUrl,
      agentBookAddress: cfg.worldChain.agentBook,
      rpcUrls: { [x402Demo.network]: cfg.rpcUrl },
      rateWindowMs: (cfg.worldRateWindowHours ?? 24) * 3_600_000,
    };
    x402Demo.trustPolicy = cfg.x402TrustPolicy ?? "open";
    x402Demo.proofAgentKey = cfg.x402ProofAgentKey;
    if (x402Demo.trustPolicy === "accountable-only")
      console.warn("⚠ x402 seller policy: ACCOUNTABLE-ONLY — anonymous agents are refused (403)");
  }
  if (x402Demo)
    console.warn(`⚠ x402 demo seller ENABLED at /x402-demo/quote (payTo ${x402Demo.payTo})`);

  const ens = cfg.ens
    ? {
        signer: privateKeyToAccount(cfg.ens.signerKey),
        parentName: cfg.ens.parentName,
        metadataBaseUrl: cfg.metadataBaseUrl,
        identityRegistry: cfg.identityRegistry,
        chainId: cfg.chainId,
        resolverAddress: cfg.ens.resolverAddress,
        labelAliases: cfg.ens.labelAliases,
      }
    : undefined;
  if (ens) console.warn(`⚠ ENS gateway ENABLED at /ensgateway (parent ${ens.parentName})`);

  const worldStore = new SqliteWorldStore(db);
  const worldId = cfg.world
    ? {
        cfg: {
          appId: cfg.world.appId,
          rpId: cfg.world.rpId,
          rpSigningKey: cfg.world.rpSigningKey,
          action: cfg.world.action,
          environment: cfg.world.environment,
          attestAction: cfg.world.attestAction,
        },
        store: worldStore,
        maxEntitiesPerHuman: cfg.world.maxEntitiesPerHuman,
        attestMinAge: cfg.world.attestMinAge,
        requireGuardian: cfg.world.requireGuardian,
      }
    : undefined;
  if (worldId)
    console.warn(
      `⚠ World ID guardian gate ENABLED (action ${worldId.cfg.action}, env ${worldId.cfg.environment}, enforce=${worldId.requireGuardian})`,
    );
  if (worldId?.cfg.attestAction)
    console.warn(
      `⚠ Identity attestation step-up ENABLED (action ${worldId.cfg.attestAction}, min age ${worldId.attestMinAge})`,
    );

  const app = buildApiApp({
    webOrigin: cfg.webOrigin,
    nonceStore,
    siweDomain: cfg.siweDomain,
    chainId: cfg.chainId,
    jwtSecret: cfg.authJwtSecret,
    jwtTtlSec: cfg.authJwtTtlSec,
    platformManagerAddress,
    repo,
    docStore,
    runner,
    passkeyRpId: cfg.passkeyRpId,
    apiKeys,
    passkeys,
    challenges,
    arc,
    jobs: jobDeps.jobs,
    jobRunner: jobDeps.jobRunner,
    jobClientAddress: jobDeps.jobClientAddress,
    jobEvaluatorAddress: jobDeps.jobEvaluatorAddress,
    maxJobBudget: cfg.maxJobBudget,
    maxInflightJobsPerTenant: cfg.maxInflightJobsPerTenant,
    agentRuns,
    mcpPublicUrl: cfg.mcpPublicUrl,
    linkCodes: new SqliteLinkCodeStore(db),
    payments,
    pocketFunding,
    x402Demo,
    ens,
    worldId,
    standingExposure,
  });

  const port = Number(process.env.PORT ?? 8789);
  serve({ fetch: app.fetch, port });
  console.log(`Wizard API listening on :${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
