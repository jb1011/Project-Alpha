import "dotenv/config";
import { serve } from "@hono/node-server";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { managerWalletClient, publicClientFor } from "../adapters/arc/clients";
import { buildTurnkeyProvisionDeps } from "../adapters/turnkey/clients";
import { buildOperatorSigner } from "../adapters/turnkey/operatorSigner";
import { type GuardianPasskey, provisionAgentVault } from "../adapters/turnkey/provisioner";
import { TurnkeySigner } from "../adapters/turnkey/turnkeySigner";
import { SqliteNonceStore } from "../auth/nonceStore";
import { loadConfig } from "../config/env";
import { buildJobDeps } from "../jobs/composition";
import { migrate, openDatabase } from "../persistence/db";
import { FileDocumentStore } from "../persistence/documentStore";
import { SqliteEntityRepository } from "../persistence/entityRepository";
import type { Address } from "../types";
import { runOnboarding } from "../workflow/onboarding";
import { OnboardingRunner, type RunSaga } from "../workflow/runner";
import { buildApiApp } from "./app";

async function main() {
  const cfg = loadConfig();
  if (!cfg.factoryAddress) throw new Error("FACTORY_ADDRESS is required to run the API server");
  if (!cfg.turnkey?.delegatedApiPublicKey || !cfg.turnkey?.delegatedApiPrivateKey)
    throw new Error(
      "TURNKEY_DELEGATED_API_{PUBLIC,PRIVATE}_KEY are required to run the API server",
    );

  const db = openDatabase(cfg.dbPath);
  migrate(db);
  const repo = new SqliteEntityRepository(db);
  const docStore = new FileDocumentStore(cfg.docStoreDir);
  const nonceStore = new SqliteNonceStore(db);
  const arc = new ArcAdapter({
    publicClient: publicClientFor(cfg),
    managerWallet: managerWalletClient(cfg),
    chainId: cfg.chainId,
    factory: cfg.factoryAddress as Address,
    identityRegistry: cfg.identityRegistry,
  });
  const operatorSigner = await buildOperatorSigner(cfg);

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
      ownerTenantId: i.tenantId,
      specJson: i.specJson,
      fundAmount: i.fundAmount,
      guardianPasskey: i.guardianPasskey,
      provision,
      signerForEntity,
    });

  const runner = new OnboardingRunner({ repo, runSaga });
  const resumed = runner.reconcileInFlight();
  if (resumed) console.log(`Resumed ${resumed} in-flight onboarding(s)`);

  const jobDeps = buildJobDeps(cfg, db, repo, docStore);
  const resumedJobs = jobDeps.jobRunner.reconcileInFlight();
  if (resumedJobs) console.log(`Resumed ${resumedJobs} in-flight job(s)`);

  const app = buildApiApp({
    webOrigin: cfg.webOrigin,
    nonceStore,
    siweDomain: cfg.siweDomain,
    chainId: cfg.chainId,
    jwtSecret: cfg.authJwtSecret,
    jwtTtlSec: cfg.authJwtTtlSec,
    repo,
    runner,
    passkeyRpId: cfg.passkeyRpId,
    jobs: jobDeps.jobs,
    jobRunner: jobDeps.jobRunner,
    jobClientAddress: jobDeps.jobClientAddress,
    jobEvaluatorAddress: jobDeps.jobEvaluatorAddress,
  });

  const port = Number(process.env.PORT ?? 8789);
  serve({ fetch: app.fetch, port });
  console.log(`Wizard API listening on :${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
