import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  http,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mockUsdcAbi } from "../src/abis/generated";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { LocalKeySigner, type OperatorSigner } from "../src/adapters/turnkey/signer";
import { anvilChain } from "../src/chains";
import { migrate, openDatabase } from "../src/persistence/db";
import { FileDocumentStore } from "../src/persistence/documentStore";
import { SqliteEntityRepository } from "../src/persistence/entityRepository";
import { parseAgentSpec } from "../src/policy/agentSpec";
import { runOnboarding } from "../src/workflow/onboarding";
import { type AnvilHandle, startAnvil } from "./helpers/anvil";
import { deployStack } from "./helpers/stack";

const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;
const manager = privateKeyToAccount(KEYS[0]);
const guardian = privateKeyToAccount(KEYS[1]).address;
const operatorSigner = new LocalKeySigner(KEYS[2]);
const payout = privateKeyToAccount(KEYS[3]).address;

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let stack: Awaited<ReturnType<typeof deployStack>>;
let repo: SqliteEntityRepository;
let docStore: FileDocumentStore;
let pub: PublicClient;
let wallet: WalletClient;

const spec = () =>
  parseAgentSpec({
    name: "Saga Agent",
    roles: { manager: manager.address, guardian },
    treasury: {
      payoutAddress: payout,
      spendingCapUsdc: "1000.00",
      spendingPeriod: "30d",
      allowlistEnabled: false,
    },
    governance: { amendmentDelay: "1h" },
  });

beforeAll(async () => {
  anvil = await startAnvil(8548);
  const transport = http(anvil.rpcUrl);
  pub = createPublicClient({ chain: anvilChain, transport });
  wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: wallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
  const db = openDatabase(":memory:");
  migrate(db);
  repo = new SqliteEntityRepository(db);
  docStore = new FileDocumentStore(mkdtempSync(join(tmpdir(), "saga-docs-")));
}, 40_000);
afterAll(() => anvil?.stop());

test("full happy path: translate -> generate -> create -> bind, persisted and on-chain", async () => {
  const rec = await runOnboarding({
    spec: spec(),
    idempotencyKey: "agent-A",
    repo,
    docStore,
    arc: adapter,
    operatorSigner,
    usdc: stack.usdc,
  });
  expect(rec.status).toBe("bound");
  expect(rec.agentId).toBe("0");
  expect((await adapter.getAgentWallet(0n)).toLowerCase()).toBe(
    operatorSigner.address.toLowerCase(),
  );
  expect(repo.listEvents("agent-A").map((e) => e.step)).toEqual(["createEntity", "setAgentWallet"]);
}, 40_000);

test("resume is idempotent: re-running does NOT mint a second agentId", async () => {
  const before = await adapter.ownerOf(0n);
  const rec = await runOnboarding({
    spec: spec(),
    idempotencyKey: "agent-A",
    repo,
    docStore,
    arc: adapter,
    operatorSigner,
    usdc: stack.usdc,
  });
  expect(rec.agentId).toBe("0"); // same id, no new entity
  expect(await adapter.ownerOf(0n)).toBe(before);
  // still exactly one create + one bind event (no duplicates)
  expect(repo.listEvents("agent-A").filter((e) => e.step === "createEntity")).toHaveLength(1);
}, 40_000);

test("resume from 'created': a bind failure stays 'created'; re-run binds without re-minting", async () => {
  const key = "agent-B";
  // A signer whose FIRST signWalletSet throws, to crash the saga at the bind step after create persisted.
  let failOnce = true;
  const flakySigner: OperatorSigner = {
    address: operatorSigner.address,
    signWalletSet: (td) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("simulated bind crash");
      }
      return operatorSigner.signWalletSet(td);
    },
  };

  const deps = {
    spec: spec(),
    idempotencyKey: key,
    repo,
    docStore,
    arc: adapter,
    operatorSigner: flakySigner,
    usdc: stack.usdc,
  };

  // First run: create persists, bind throws -> status stays 'created', create event but no bind event.
  await expect(runOnboarding(deps)).rejects.toThrow(/simulated bind crash/);
  const mid = repo.findByIdempotencyKey(key);
  expect(mid?.status).toBe("created");
  expect(mid?.agentId).toBe("1"); // agent-A was 0; this is the second entity
  expect(repo.listEvents(key).map((e) => e.step)).toEqual(["createEntity"]);

  // Resume: only the bind step runs -> no second mint, exactly one create event, ends 'bound'.
  const rec = await runOnboarding(deps);
  expect(rec.status).toBe("bound");
  expect(rec.agentId).toBe("1");
  expect(repo.listEvents(key).filter((e) => e.step === "createEntity")).toHaveLength(1);
  expect(repo.listEvents(key).map((e) => e.step)).toEqual(["createEntity", "setAgentWallet"]);
  expect((await adapter.getAgentWallet(1n)).toLowerCase()).toBe(
    operatorSigner.address.toLowerCase(),
  );
}, 40_000);

test("optional fundAmount runs the fund step: status 'funded' and treasury holds the USDC", async () => {
  const key = "agent-C";
  // The manager needs USDC to fund the new entity's treasury.
  await wallet.writeContract({
    address: stack.usdc,
    abi: mockUsdcAbi,
    functionName: "mint",
    args: [manager.address, 5_000_000n],
    account: manager,
    chain: anvilChain,
  });

  const rec = await runOnboarding({
    spec: spec(),
    idempotencyKey: key,
    repo,
    docStore,
    arc: adapter,
    operatorSigner,
    usdc: stack.usdc,
    fundAmount: 2_000_000n,
  });

  expect(rec.status).toBe("funded");
  expect(repo.listEvents(key).map((e) => e.step)).toEqual([
    "createEntity",
    "setAgentWallet",
    "fundTreasury",
  ]);
  const bal = await pub.readContract({
    address: stack.usdc,
    abi: mockUsdcAbi,
    functionName: "balanceOf",
    args: [rec.treasury as `0x${string}`],
  });
  expect(bal).toBe(2_000_000n);
}, 40_000);
