/**
 * Operator tool: sweep an agent's un-clawback-able standing float back into its governed treasury.
 *
 * WHY THIS EXISTS. `MAX_POCKET_FLOAT_USDC` (S2, PR #39) bounds standing exposure — operator EOA +
 * pocket EOA + Gateway — at funding time. Agents funded BEFORE that ceiling existed can already sit
 * above it, and `topUpPocket` then rejects every further top-up (`float-ceiling-exceeded`) on both
 * the manual `fund_pocket` path and the autonomous leg-0 path. Note leg-0's `fundToTarget` only
 * inspects GATEWAY float, so it does not save an agent whose excess sits on the EOAs. Sweeping the
 * EOAs back into the treasury is the correct remedy: the funds move from hot, un-clawback-able keys
 * into the guardian-governed vault, which is strictly safer, and the agent becomes fundable again.
 *
 * WHAT IT DOES NOT DO. Gateway-held balance is not withdrawable through the current SDK wrapper
 * (same limitation as `sweepPocketToTreasury`), so it is reported but never swept. Keep deposits
 * JIT-minimal instead.
 *
 * It reuses the two production-proven sweep paths verbatim rather than inventing a third:
 *   - pocket EOA  -> treasury : `sweepPocketToTreasury` (liveRunner's wiring, dust 10_000)
 *   - operator EOA -> treasury: delegated per-agent Turnkey wallet (runJob step 4.5, reserve 10_000)
 * Both use the explicit `USDC_TRANSFER_GAS` — mandatory on Arc, where the gas token IS the USDC
 * being transferred and a fee-fielded `eth_estimateGas` would otherwise revert a near-full-balance
 * transfer. See `adapters/arc/gas.ts`.
 *
 * DRY RUN BY DEFAULT. Prints the plan and exits; pass `--execute` to actually move funds.
 *
 *   npm run -s cli:sweep -- --entity TestAgentMB_1
 *   npm run -s cli:sweep -- --entity TestAgentMB_1 --entity TestBootstrapMB_1 --execute
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { http, createPublicClient, createWalletClient, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDC_TRANSFER_GAS } from "../src/adapters/arc/gas";
import { buildOperatorWalletClientForEntity } from "../src/adapters/turnkey/operatorWallet";
import { PocketGateway } from "../src/adapters/x402/gateway";
import { derivePocketKey } from "../src/adapters/x402/pocketDerivation";
import { chainFor } from "../src/chains";
import { loadConfig } from "../src/config/env";
import { sweepPocketToTreasury } from "../src/payments/pocketFloat";
import type { Address, Hex } from "../src/types";

/** Left behind on each EOA so the sweep tx can pay its own USDC gas. Both values are the ones
 *  already used in production (`liveRunner` dust / `runJob` SWEEP_GAS_RESERVE); a live sweep spent
 *  ~1,224 atomic of the 10,000, so the margin is comfortable. */
const DUST = 10_000n;

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const targets = argv.flatMap((a, i) => (a === "--entity" ? [argv[i + 1]] : [])).filter(Boolean);
if (targets.length === 0) {
  console.error("usage: sweep-standing-float --entity <name|idempotencyKey> [...] [--execute]");
  process.exit(2);
}

const fmt = (n: bigint) => `${(Number(n) / 1e6).toFixed(6)} USDC (${n})`;

async function main() {
  const cfg = loadConfig();
  const pub = createPublicClient({
    transport: http(cfg.rpcUrl),
    chain: chainFor(cfg.chainId, cfg.rpcUrl),
  });
  const db = new Database(cfg.dbPath, { readonly: true });

  const bal = (owner: Address) =>
    pub.readContract({
      address: cfg.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    }) as Promise<bigint>;

  console.log(`mode: ${EXECUTE ? "EXECUTE (moves funds)" : "DRY RUN (no writes)"}\n`);

  for (const target of targets) {
    const row = db
      .prepare(
        "SELECT name, idempotency_key, operator, treasury, turnkey_sub_org_id FROM entities WHERE name = ? OR idempotency_key = ?",
      )
      .get(target, target) as
      | {
          name: string;
          idempotency_key: string;
          operator: string;
          treasury: string;
          turnkey_sub_org_id: string;
        }
      | undefined;

    if (!row) {
      console.error(`✗ ${target}: no such entity`);
      process.exitCode = 1;
      continue;
    }
    if (!row.treasury || !row.operator || !row.turnkey_sub_org_id) {
      console.error(`✗ ${row.name}: missing treasury/operator/subOrg — cannot sweep`);
      process.exitCode = 1;
      continue;
    }

    const pocketKey = derivePocketKey(cfg.pocketMasterSeed!, row.idempotency_key);
    const pocketAccount = privateKeyToAccount(pocketKey);
    const gateway = new PocketGateway({ pocketPrivateKey: pocketKey, rpcUrl: cfg.rpcUrl });

    const [op0, pk0, gw0] = await Promise.all([
      bal(row.operator as Address),
      bal(pocketAccount.address),
      gateway.getAvailable(),
    ]);
    const gwAtomic = BigInt(Math.floor(gw0 * 1e6));
    const before = op0 + pk0 + gwAtomic;

    console.log(`── ${row.name} ─────────────────────────────────`);
    console.log(`   treasury  ${row.treasury}`);
    console.log(`   operator  ${row.operator}  ${fmt(op0)}`);
    console.log(`   pocket    ${pocketAccount.address}  ${fmt(pk0)}`);
    console.log(`   gateway   (not sweepable)          ${fmt(gwAtomic)}`);
    console.log(`   STANDING  ${fmt(before)}`);
    console.log(
      `   plan: pocket -> treasury ${fmt(pk0 > DUST ? pk0 - DUST : 0n)} | operator -> treasury ${fmt(op0 > DUST ? op0 - DUST : 0n)}`,
    );

    if (!EXECUTE) {
      console.log("   (dry run — nothing sent)\n");
      continue;
    }

    const hashes: Hex[] = [];

    // 1) pocket EOA -> treasury, via the exact helper liveRunner uses.
    const pocketWallet = createWalletClient({
      account: pocketAccount,
      chain: chainFor(cfg.chainId, cfg.rpcUrl),
      transport: http(cfg.rpcUrl),
    });
    const pocketTx = await sweepPocketToTreasury({
      treasury: row.treasury as Address,
      usdc: cfg.usdc,
      dust: DUST,
      pocketUsdcBalance: () => bal(pocketAccount.address),
      transferToTreasury: async (to, amount) => {
        const { request } = await pub.simulateContract({
          account: pocketWallet.account,
          address: cfg.usdc,
          abi: erc20Abi,
          functionName: "transfer",
          args: [to, amount],
        });
        const h = await pocketWallet.writeContract({ ...request, gas: USDC_TRANSFER_GAS });
        await pub.waitForTransactionReceipt({ hash: h });
        return h;
      },
    });
    if (pocketTx) {
      hashes.push(pocketTx);
      console.log(`   ✓ pocket sweep   ${pocketTx}`);
    } else {
      console.log("   · pocket sweep   skipped (at or below dust)");
    }

    // 2) operator EOA -> treasury, mirroring runJob step 4.5 (delegated per-agent Turnkey wallet).
    const opNow = await bal(row.operator as Address);
    const opAmount = opNow > DUST ? opNow - DUST : 0n;
    if (opAmount > 0n) {
      const operatorWallet = await buildOperatorWalletClientForEntity(cfg, {
        subOrgId: row.turnkey_sub_org_id,
        operator: row.operator,
      });
      const { request } = await pub.simulateContract({
        account: operatorWallet.account ?? undefined,
        address: cfg.usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [row.treasury as Address, opAmount],
      });
      const h = await operatorWallet.writeContract({ ...request, gas: USDC_TRANSFER_GAS });
      await pub.waitForTransactionReceipt({ hash: h });
      hashes.push(h);
      console.log(`   ✓ operator sweep ${h}`);
    } else {
      console.log("   · operator sweep skipped (at or below dust)");
    }

    const [op1, pk1, gw1] = await Promise.all([
      bal(row.operator as Address),
      bal(pocketAccount.address),
      gateway.getAvailable(),
    ]);
    const after = op1 + pk1 + BigInt(Math.floor(gw1 * 1e6));
    console.log(`   STANDING ${fmt(before)} -> ${fmt(after)}  (${hashes.length} tx)\n`);
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
