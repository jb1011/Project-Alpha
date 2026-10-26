import type Database from "better-sqlite3";
import { config as loadDotenv } from "dotenv";
import type { Address, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicClientFor, sendClientFor, walletClientForKey } from "../adapters/arc/clients";
import { type Config, loadConfig } from "../config/env";
import { migrate, openDatabase } from "../persistence/db";
import { FileDocumentStore } from "../persistence/documentStore";
import { type PilotCaseRepository, SqlitePilotCaseRepository } from "./casesRepository";

/**
 * THE PILOT'S OWN NARROW CONTEXT: the configuration, the database, the pilot case table, the
 * document store, the two read clients and the three pilot wallets. Nothing else.
 *
 * The pilot commands open this instead of the CLI's `buildContext`, so a pilot command never
 * builds the platform's adapters or touches the platform key. The keys stay inside the wallet
 * clients' local accounts; this module never prints or logs one.
 */
export interface PilotContext {
  cfg: Config;
  db: Database.Database;
  cases: PilotCaseRepository;
  docStore: FileDocumentStore;
  publicClient: PublicClient;
  sendClient: PublicClient;
  wallets: { buyer: WalletClient; seller: WalletClient; referee: WalletClient };
  addresses: { buyer: Address; seller: Address; referee: Address };
  close(): void;
}

/** loadDotenv, loadConfig, openDatabase + migrate, the clients, the three wallets. Refuses without cfg.pilot. */
export function openPilotContext(): PilotContext {
  loadDotenv();
  const cfg = loadConfig();
  const pilot = cfg.pilot;
  if (!pilot)
    throw new Error(
      "refusing: the pilot keys are not set on this box (PILOT_BUYER_PRIVATE_KEY, PILOT_SELLER_PRIVATE_KEY, PILOT_REFEREE_PRIVATE_KEY)",
    );
  const db = openDatabase(cfg.dbPath);
  // Everything after the open is inside the try, so a throw from migrate or any constructor below
  // closes the database instead of leaking it.
  try {
    migrate(db);
    return {
      cfg,
      db,
      cases: new SqlitePilotCaseRepository(db),
      docStore: new FileDocumentStore(cfg.docStoreDir),
      publicClient: publicClientFor(cfg),
      sendClient: sendClientFor(cfg),
      wallets: {
        buyer: walletClientForKey(cfg, pilot.buyerPrivateKey),
        seller: walletClientForKey(cfg, pilot.sellerPrivateKey),
        referee: walletClientForKey(cfg, pilot.refereePrivateKey),
      },
      addresses: {
        buyer: privateKeyToAccount(pilot.buyerPrivateKey).address,
        seller: privateKeyToAccount(pilot.sellerPrivateKey).address,
        referee: privateKeyToAccount(pilot.refereePrivateKey).address,
      },
      close: () => db.close(),
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
