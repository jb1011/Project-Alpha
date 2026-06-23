import { config as loadDotenv } from "dotenv";
import type { Address } from "viem";
import { ArcAdapter } from "../adapters/arc/arcAdapter";
import { managerWalletClient, publicClientFor } from "../adapters/arc/clients";
import { buildOperatorSigner } from "../adapters/turnkey/operatorSigner";
import type { OperatorSigner } from "../adapters/turnkey/signer";
import { type Config, loadConfig } from "../config/env";
import { type JobDeps, buildJobDeps } from "../jobs/composition";
import { migrate, openDatabase } from "../persistence/db";
import { FileDocumentStore } from "../persistence/documentStore";
import { SqliteEntityRepository } from "../persistence/entityRepository";

export interface CliContext {
  cfg: Config;
  repo: SqliteEntityRepository;
  docStore: FileDocumentStore;
  arc: ArcAdapter;
  operatorSigner: OperatorSigner;
  jobDeps: JobDeps;
}

/** Build the live context from env (.env loaded). Throws if FACTORY_ADDRESS/operator signer missing. */
export async function buildContext(): Promise<CliContext> {
  loadDotenv();
  const cfg = loadConfig();
  if (!cfg.factoryAddress) throw new Error("FACTORY_ADDRESS is required (deploy first; see M0).");

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
  return {
    cfg,
    repo,
    docStore,
    arc,
    operatorSigner: await buildOperatorSigner(cfg), // Turnkey if configured, else OPERATOR_PRIVATE_KEY
    jobDeps: buildJobDeps(cfg, db, repo, docStore),
  };
}
