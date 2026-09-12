/**
 * Operator tool: pause or unpause one legal body's Arc treasury, from its guardian key.
 *
 * WHY THIS EXISTS. `AgentTreasury.pause()`/`unpause()` (design D22) are the guardian's kill
 * switch: while paused, `spend` reverts and the buyer's `check_policy` MCP tool reports
 * `{ ok: false, reason: "paused" }` instead of letting a payment through (audit B1). The demo
 * round trip (task 14 step 2) needs a way to flip that switch from the command line, without a
 * console and without ever printing the guardian's key.
 *
 * TWO WAYS TO NAME THE TREASURY, because under D28 the paying demo entity (`HederaDemo_1`) lives
 * on PROD and the local database never holds prod rows:
 *   --entity <name|key>   resolve the row in the LOCAL database — the same resolution
 *                         `hedera-register-identity.mts` uses (idempotency key, then public id,
 *                         then name) — and take its `treasury`
 *   --treasury <address>  the treasury address directly; no database is opened at all
 *
 * THE ONLY GATE is the on-chain `guardian()` read: the script refuses unless
 * `DEMO_GUARDIAN_KEY`'s address equals it, before it signs anything.
 *
 * SECRETS. `DEMO_GUARDIAN_KEY` is read from `process.env` only, and is never printed, logged or
 * included in an error message. Run it under 1Password:
 *   op run --env-file=.env.guardian.tpl -- npx tsx scripts/guardian-pause.mts pause --treasury 0x…
 *
 *   npx tsx scripts/guardian-pause.mts pause --entity FormationE2E_1
 *   npx tsx scripts/guardian-pause.mts unpause --treasury 0x92aE7c6B6eB9470d7E01F8fEb352714bD80A7AAf
 *
 * `dotenv` is loaded inside `main()` rather than at import time (the `hedera-register-identity.mts`
 * idiom): this module is imported by `test/hedera/guardianPause.test.ts` for its pure helpers, and
 * an import-time `.env` load would make the suite's behaviour depend on an untracked developer file.
 */
import { pathToFileURL } from "node:url";
import { type Address, isAddressEqual } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentTreasuryAbi } from "../src/abis/generated";
import { publicClientFor, walletClientForKey } from "../src/adapters/arc/clients";
import { loadConfig } from "../src/config/env";
import { migrate, openDatabase } from "../src/persistence/db";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import type { Hex } from "../src/types";
// Reused rather than reimplemented: the same local-database lookup `--entity` needs elsewhere
// (idempotency key, then public id, then name), tested in `test/hedera/registerIdentity.test.ts`.
import { resolveEntity } from "./hedera-register-identity.mjs";

// ── Pure helpers (exported for test/hedera/guardianPause.test.ts) ──────────────────────────────

export type Mode = "pause" | "unpause";

export interface ParsedArgs {
  mode: Mode;
  entity?: string;
  treasury?: Address;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Refuses to sign unless the key that is about to sign is the treasury's own on-chain guardian.
 * Case-insensitive: viem checksums a derived address, a value read off a row or pasted on a
 * command line may not be, and this check must not depend on which one it got.
 */
export function assertGuardianMatches(onChainGuardian: Address, keyAddress: Address): void {
  if (!isAddressEqual(onChainGuardian, keyAddress)) {
    throw new Error("guardian key does not match on-chain guardian");
  }
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
  return v;
}

/**
 * `pause|unpause --entity <name|key> | --treasury <address>` — exactly one of the two location
 * flags. Throws a plain `Error` on any refusal; `main()` is what turns that into a printed usage
 * message and a non-zero exit.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const [mode, ...rest] = argv;
  if (mode !== "pause" && mode !== "unpause") {
    throw new Error(
      `first argument must be "pause" or "unpause"${mode ? `, got "${mode}"` : ""}`,
    );
  }
  const entity = flagValue(rest, "--entity");
  const treasury = flagValue(rest, "--treasury");
  if (entity !== undefined && treasury !== undefined) {
    throw new Error("--entity and --treasury are mutually exclusive");
  }
  if (entity === undefined && treasury === undefined) {
    throw new Error("one of --entity <name|key> or --treasury <address> is required");
  }
  if (treasury !== undefined && !ADDRESS_RE.test(treasury)) {
    throw new Error(`--treasury must be a 20-byte address: ${treasury}`);
  }
  return { mode, entity, treasury: treasury as Address | undefined };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────

const USAGE = "usage: guardian-pause.mts pause|unpause --entity <name|key> | --treasury <address>";

function usageAndExit(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  // The NAME only — an error here must never carry the value, because this one is a key.
  if (!v) usageAndExit(`${name} is not set (run under: op run --env-file=.env.guardian.tpl -- …)`);
  return v;
}

export async function main(): Promise<void> {
  const { default: dotenv } = await import("dotenv");
  dotenv.config();

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    usageAndExit((e as Error).message);
  }

  const guardianKey = requireEnv("DEMO_GUARDIAN_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(guardianKey)) {
    usageAndExit("DEMO_GUARDIAN_KEY must be 0x followed by 64 hex characters");
  }

  const cfg = loadConfig();

  let treasury: Address;
  let label: string;
  if (parsed.entity) {
    const db = openDatabase(cfg.dbPath);
    migrate(db);
    const repo = new SqliteEntityRepository(db);
    const rec = resolveEntity(repo.list(), parsed.entity);
    db.close();
    if (!rec.treasury) usageAndExit(`${rec.name} has no treasury on its row`);
    treasury = rec.treasury;
    label = rec.name;
  } else {
    treasury = parsed.treasury as Address;
    label = treasury;
  }

  const publicClient = publicClientFor(cfg);
  const keyAccount = privateKeyToAccount(guardianKey as Hex);

  const onChainGuardian = await publicClient.readContract({
    address: treasury,
    abi: agentTreasuryAbi,
    functionName: "guardian",
  });
  // Before anything is signed: a mismatch here must never reach writeContract.
  assertGuardianMatches(onChainGuardian, keyAccount.address);

  const walletClient = walletClientForKey(cfg, guardianKey as Hex);
  const txHash = await walletClient.writeContract({
    address: treasury,
    abi: agentTreasuryAbi,
    functionName: parsed.mode,
    account: keyAccount,
    chain: walletClient.chain,
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  const paused = await publicClient.readContract({
    address: treasury,
    abi: agentTreasuryAbi,
    functionName: "paused",
  });

  console.log(`${label}: ${parsed.mode} tx ${txHash}`);
  console.log(`paused: ${paused}`);
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
