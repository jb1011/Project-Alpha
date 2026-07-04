// backend/src/onboarding/main.ts
import "dotenv/config";
import { serve } from "@hono/node-server";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { managerWalletClient, publicClientFor } from "../adapters/arc/clients";
import { buildTurnkeyProvisionDeps } from "../adapters/turnkey/clients";
import { buildOperatorSigner } from "../adapters/turnkey/operatorSigner";
import { provisionAgentVault } from "../adapters/turnkey/provisioner";
import { TurnkeySigner } from "../adapters/turnkey/turnkeySigner";
import { loadConfig } from "../config/env";
import { migrate, openDatabase } from "../persistence/db";
import { FileDocumentStore } from "../persistence/documentStore";
import { SqliteEntityRepository } from "../persistence/entityRepository";
import type { Address } from "../types";
import { runOnboarding as workflowRunOnboarding } from "../workflow/onboarding";
import { buildOnboardingApp } from "./server";

async function main() {
  const cfg = loadConfig();

  if (!cfg.turnkey?.delegatedApiPublicKey) {
    throw new Error("TURNKEY_DELEGATED_API_PUBLIC_KEY is required to run the onboarding server");
  }
  if (!cfg.turnkey?.delegatedApiPrivateKey) {
    throw new Error("TURNKEY_DELEGATED_API_PRIVATE_KEY is required to run the onboarding server");
  }
  if (!cfg.factoryAddress) {
    throw new Error("FACTORY_ADDRESS is required to run the onboarding server");
  }

  const db = openDatabase(cfg.dbPath);
  migrate(db);

  const repo = new SqliteEntityRepository(db);
  const docStore = new FileDocumentStore(cfg.docStoreDir);

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
    guardianPasskey: import("../adapters/turnkey/provisioner").GuardianPasskey;
    guardianEmail?: string;
  }) =>
    provisionAgentVault(buildTurnkeyProvisionDeps(cfg), {
      ...p,
      delegatedApiPublicKey: cfg.turnkey!.delegatedApiPublicKey!,
    });

  const signerForEntity = (e: { subOrgId: string; operator: string }) =>
    TurnkeySigner.forEntity(cfg, e);

  const runOnboarding = (
    spec: import("../policy/agentSpec").AgentSpec,
    guardianPasskey: import("../adapters/turnkey/provisioner").GuardianPasskey,
    idempotencyKey: string,
  ) =>
    workflowRunOnboarding({
      spec,
      idempotencyKey,
      repo,
      docStore,
      arc,
      operatorSigner,
      usdc: cfg.usdc,
      metadataBaseUrl: cfg.metadataBaseUrl,
      guardianPasskey,
      provision,
      signerForEntity,
    });

  const app = buildOnboardingApp({ runOnboarding });

  const port = Number(process.env.PORT ?? 8788);
  serve({ fetch: app.fetch, port });
  console.log(`Onboarding server listening on :${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
