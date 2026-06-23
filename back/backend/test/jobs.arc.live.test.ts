/**
 * RUNBOOK — Track C live proof-of-life (gated, off by default)
 *
 * Run live:
 *   ARC_JOB_LIVE=1 npx vitest run test/jobs.arc.live.test.ts
 *
 * Pre-reqs:
 *   (1) A `bound` (or `funded`) agent already onboarded in the DB with
 *       operator + turnkeySubOrgId + agentId set.
 *   (2) The job CLIENT key (JOB_CLIENT_PRIVATE_KEY, falls back to
 *       PLATFORM_PRIVATE_KEY) funded with Arc-testnet USDC — this key
 *       pays the escrow budget (0.10 USDC) and gas for createJob +
 *       approveAndFund.
 *   (3) The provider/operator EOA (the Turnkey enclave key bound to the
 *       agent) gas-seeded with enough testnet ETH/native token for the
 *       setBudget transaction.
 *   (4) JOB_EVALUATOR_PRIVATE_KEY set in .env, DISTINCT from the provider
 *       key and gas-funded — the complete() on-chain call requires a
 *       non-client, non-provider evaluator.
 *   (5) REPUTATION_REGISTRY_ADDRESS and JOB_CONTRACT_ADDRESS point at the
 *       live Arc-testnet deployments (defaults are already correct in env.ts).
 *
 * Spends REAL (Arc-testnet) USDC. Do NOT run in CI or unattended.
 * The test produces console.log output with all tx hashes for the demo
 * writeup and grant deliverable submission.
 */

import { randomUUID } from "node:crypto";
import "dotenv/config";
import { describe, expect, test } from "vitest";
import { publicClientFor } from "../src/adapters/arc/clients";
import { loadConfig } from "../src/config/env";
import { buildJobDeps } from "../src/jobs/composition";
import { migrate, openDatabase } from "../src/persistence/db";
import { FileDocumentStore } from "../src/persistence/documentStore";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import { usdToUnits } from "../src/policy/units";

const gated = process.env.ARC_JOB_LIVE === "1";
const run = gated ? describe : describe.skip;

/** Minimal ERC-20 ABI fragment — only balanceOf is needed here. */
const erc20BalanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

run("live ERC-8183 job loop", () => {
  test("agent earns USDC + reputation end-to-end", async () => {
    // ── 1. Build real deps ─────────────────────────────────────────────────
    const cfg = loadConfig();
    const db = openDatabase(cfg.dbPath);
    migrate(db);
    const repo = new SqliteEntityRepository(db);
    const docStore = new FileDocumentStore(cfg.docStoreDir);
    const jobDeps = buildJobDeps(cfg, db, repo, docStore);
    const publicClient = publicClientFor(cfg);

    // ── 2. Pick a usable agent ─────────────────────────────────────────────
    const entity = repo
      .list()
      .find(
        (e) =>
          (e.status === "bound" || e.status === "funded") &&
          !!e.operator &&
          !!e.turnkeySubOrgId &&
          !!e.agentId,
      );

    if (!entity) {
      throw new Error(
        "no bound agent in DB; onboard one first " +
          "(run the onboarding workflow, then re-run this test)",
      );
    }

    console.log(
      `[live] using entity ${entity.idempotencyKey} / agentId=${entity.agentId} / operator=${entity.operator}`,
    );

    // ── 3. Read provider USDC balance before ──────────────────────────────
    const beforeBalance = await publicClient.readContract({
      address: cfg.usdc,
      abi: erc20BalanceOfAbi,
      functionName: "balanceOf",
      args: [entity.operator as `0x${string}`],
    });

    console.log(`[live] provider USDC before: ${beforeBalance}`);

    // ── 4. Run the full job saga ───────────────────────────────────────────
    const jobKey = `live-job-${entity.idempotencyKey}-${Date.now()}-${randomUUID().slice(0, 8)}`;

    console.log(`[live] starting job ${jobKey}`);

    const rec = await jobDeps.runJob({
      jobKey,
      entityKey: entity.idempotencyKey,
      budget: usdToUnits("0.10"),
      description: "Track C live proof-of-life",
    });

    // ── 5. Log tx hashes for the demo writeup ─────────────────────────────
    console.log("[live] job complete:", {
      status: rec.status,
      jobId: rec.jobId,
      createTxHash: rec.createTxHash,
      fundTxHash: rec.fundTxHash,
      submitTxHash: rec.submitTxHash,
      completeTxHash: rec.completeTxHash,
      reputationTxHash: rec.reputationTxHash,
    });

    // ── 6. Assertions ──────────────────────────────────────────────────────
    expect(["completed", "reputed"]).toContain(rec.status);

    // Provider earned USDC. We don't assert exact delta because the provider
    // also pays USDC gas for the setBudget transaction.
    const afterBalance = await publicClient.readContract({
      address: cfg.usdc,
      abi: erc20BalanceOfAbi,
      functionName: "balanceOf",
      args: [entity.operator as `0x${string}`],
    });

    console.log(
      `[live] provider USDC after: ${afterBalance} (delta: ${afterBalance - beforeBalance})`,
    );

    expect(afterBalance).toBeGreaterThan(beforeBalance);
  }, 180_000);
});
