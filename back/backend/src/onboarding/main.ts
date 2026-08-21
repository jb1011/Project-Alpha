// backend/src/onboarding/main.ts
import "dotenv/config";
import { serve } from "@hono/node-server";
import { privateKeyToAccount } from "viem/accounts";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import {
  managerWalletClient,
  platformManagerAddress,
  publicClientFor,
} from "../adapters/arc/clients";
import { buildTurnkeyProvisionDeps } from "../adapters/turnkey/clients";
import { buildOperatorSigner } from "../adapters/turnkey/operatorSigner";
import { provisionAgentVault } from "../adapters/turnkey/provisioner";
import { TurnkeySigner } from "../adapters/turnkey/turnkeySigner";
import { derivePocketKey } from "../adapters/x402/pocketDerivation";
import { loadConfig } from "../config/env";
import {
  legacyDoorRefusalMessage,
  legacyDoorRefused,
  resolveFormationDeployment,
} from "../formation";
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
    controller: cfg.controllerAddress,
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
      // Audit item 7 (review L4): rows created here must also store their pocket address.
      derivePocketAddress: cfg.pocketMasterSeed
        ? (entityKey) =>
            privateKeyToAccount(derivePocketKey(cfg.pocketMasterSeed!, entityKey)).address
        : undefined,
      // Formation (design §2/§5): the SAME resolver the API and the CLI use. This server is a
      // legacy door (retire-vs-gate is a PR-2 decision), but while it can still mint entities it
      // must not mint ones that disagree with the rest of the deployment about their provider.
      formation: resolveFormationDeployment(cfg),
    });

  const refused = legacyDoorRefused(cfg);
  if (refused)
    console.warn(
      "⚠ formation is REQUIRED on this deployment — this legacy onboarding door refuses every request",
    );
  const app = buildOnboardingApp({
    runOnboarding,
    formationRefusal: refused ? legacyDoorRefusalMessage("onboarding-server") : undefined,
    // Controller mode: the controller contract; otherwise the signing key's address, as before.
    platformManagerAddress: platformManagerAddress(cfg),
  });

  const port = Number(process.env.PORT ?? 8788);
  serve({ fetch: app.fetch, port });
  console.log(`Onboarding server listening on :${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
