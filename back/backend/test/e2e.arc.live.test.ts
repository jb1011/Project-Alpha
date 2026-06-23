import "dotenv/config"; // load backend/.env into process.env for the live run
import { describe, expect, test } from "vitest";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { managerAccount, managerWalletClient, publicClientFor } from "../src/adapters/arc/clients";
import { buildOperatorSigner } from "../src/adapters/turnkey/operatorSigner";
import { loadConfig } from "../src/config/env";
import { migrate, openDatabase } from "../src/persistence/db";
import { FileDocumentStore } from "../src/persistence/documentStore";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import { parseAgentSpec } from "../src/policy/agentSpec";
import { runOnboarding } from "../src/workflow/onboarding";

// Opt-in only: spends real Arc-testnet USDC gas. Run with:
//   ARC_E2E=1 npx vitest run test/e2e.arc.live.test.ts
// Requires backend/.env: PLATFORM_PRIVATE_KEY (= the funded Factory owner), FACTORY_ADDRESS,
// OPERATOR_PRIVATE_KEY (throwaway; signs only, never sends), GUARDIAN_ADDRESS.
const RUN = process.env.ARC_E2E === "1";

describe.skipIf(!RUN)("Arc testnet E2E (live, costs testnet USDC gas)", () => {
  test("onboards a real agent end-to-end on Arc testnet", async () => {
    const cfg = loadConfig();
    if (!cfg.factoryAddress || !cfg.guardianAddress) {
      throw new Error("set FACTORY_ADDRESS and GUARDIAN_ADDRESS");
    }
    const db = openDatabase(cfg.dbPath);
    migrate(db);
    const arc = new ArcAdapter({
      publicClient: publicClientFor(cfg),
      managerWallet: managerWalletClient(cfg),
      chainId: cfg.chainId,
      factory: cfg.factoryAddress,
      identityRegistry: cfg.identityRegistry,
    });
    // Turnkey enclave key when TURNKEY_* is set (production path); else OPERATOR_PRIVATE_KEY (testnet).
    const operatorSigner = await buildOperatorSigner(cfg);
    // manager == the platform account derived from PLATFORM_PRIVATE_KEY (must be the Factory owner)
    const manager = managerAccount(cfg).address;
    const spec = parseAgentSpec({
      name: `E2E Agent ${process.env.ARC_E2E_TAG ?? "run"}`,
      roles: { manager, guardian: cfg.guardianAddress },
      treasury: {
        payoutAddress: cfg.guardianAddress,
        spendingCapUsdc: "10.00",
        spendingPeriod: "30d",
        allowlistEnabled: false,
      },
      governance: { amendmentDelay: "1h" },
    });
    const rec = await runOnboarding({
      spec,
      idempotencyKey: `e2e-${process.env.ARC_E2E_TAG ?? Date.now()}`,
      repo: new SqliteEntityRepository(db),
      docStore: new FileDocumentStore(cfg.docStoreDir),
      arc,
      operatorSigner,
      usdc: cfg.usdc,
    });
    expect(rec.status).toBe("bound");
    expect((await arc.getAgentWallet(BigInt(rec.agentId!))).toLowerCase()).toBe(
      operatorSigner.address.toLowerCase(),
    );
  }, 120_000);
});
