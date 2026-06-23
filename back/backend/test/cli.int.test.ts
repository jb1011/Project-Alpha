import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { LocalKeySigner } from "../src/adapters/turnkey/signer";
import { anvilChain } from "../src/chains";
import type { CliContext } from "../src/cli/context";
import { buildCli } from "../src/cli/index";
import { loadConfig } from "../src/config/env";
import { buildJobDeps } from "../src/jobs/composition";
import { migrate, openDatabase } from "../src/persistence/db";
import { FileDocumentStore } from "../src/persistence/documentStore";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import { type AnvilHandle, startAnvil } from "./helpers/anvil";
import { deployStack } from "./helpers/stack";

const manager = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);
const guardian = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
).address;
const operatorKey = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;
const payout = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
).address;

let anvil: AnvilHandle;
let ctx: CliContext;
let agentJsonPath: string;

beforeAll(async () => {
  anvil = await startAnvil(8550);
  const transport = http(anvil.rpcUrl);
  const pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  const stack = await deployStack(wallet, pub, manager.address);
  const db = openDatabase(":memory:");
  migrate(db);
  const cfg = loadConfig({
    ARC_TESTNET_RPC_URL: anvil.rpcUrl,
    ARC_CHAIN_ID: "31337",
    PLATFORM_PRIVATE_KEY: `0x${"a".repeat(64)}`,
    USDC_ADDRESS: stack.usdc,
  });
  const mergedCfg = { ...cfg, usdc: stack.usdc };
  const repo = new SqliteEntityRepository(db);
  const docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "cli-docs-")));
  ctx = {
    cfg: mergedCfg,
    repo,
    docStore,
    arc: new ArcAdapter({
      publicClient: pub,
      managerWallet: wallet,
      chainId: anvilChain.id,
      factory: stack.factory,
      identityRegistry: stack.registry,
    }),
    operatorSigner: new LocalKeySigner(operatorKey),
    jobDeps: buildJobDeps(mergedCfg, db, repo, docStore),
  };
  agentJsonPath = join(mkdtempSync(join(tmpdir(), "cli-spec-")), "agent.json");
  writeFileSync(
    agentJsonPath,
    JSON.stringify({
      name: "CLI Agent",
      roles: { manager: manager.address, guardian },
      treasury: {
        payoutAddress: payout,
        spendingCapUsdc: "1000.00",
        spendingPeriod: "30d",
        allowlistEnabled: false,
      },
      governance: { amendmentDelay: "1h" },
    }),
  );
}, 40_000);
afterAll(() => anvil?.stop());

test("create-entity drives the full saga to bound and list-entities shows it", async () => {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((m) => {
    logs.push(String(m));
  });
  const cli = buildCli(() => ctx);
  await cli.parseAsync([
    "node",
    "legalbody",
    "create-entity",
    "--config",
    agentJsonPath,
    "--id",
    "cli-A",
  ]);
  await cli.parseAsync(["node", "legalbody", "list-entities"]);
  spy.mockRestore();

  expect(logs.join("\n")).toContain('"status": "bound"');
  expect(logs.join("\n")).toContain("cli-A");
  expect((await ctx.arc.getAgentWallet(0n)).toLowerCase()).toBe(
    new LocalKeySigner(operatorKey).address.toLowerCase(),
  );
}, 40_000);
