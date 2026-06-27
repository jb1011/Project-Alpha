import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ArcAdapter } from "../src/adapters/arc/arcAdapter";
import { anvilChain } from "../src/chains";
import { type AnvilHandle, startAnvil } from "./helpers/anvil";
import { deployStack } from "./helpers/stack";

const ACCT = (i: number) =>
  privateKeyToAccount(
    [
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
      "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
    ][i] as `0x${string}`,
  );

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let stack: Awaited<ReturnType<typeof deployStack>>;
const manager = ACCT(0);
const guardian = ACCT(1).address;
const operator = ACCT(2).address;
const payout = ACCT(3).address;

beforeAll(async () => {
  anvil = await startAnvil(8546);
  const transport = http(anvil.rpcUrl);
  const pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: wallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
}, 40_000);
afterAll(() => anvil?.stop());

test("createEntity registers, deploys, transfers NFT to manager, and returns ids from events", async () => {
  const res = await adapter.createEntity({
    manager: manager.address,
    guardian,
    operator,
    amendmentDelay: 3_600n,
    metadataURI: "file:///tmp/meta.json",
    ein: "STUB-NOT-FILED",
    formationDate: 0,
    operatingAgreementHash: `0x${"ab".repeat(32)}`,
    treasury: {
      usdc: stack.usdc,
      payoutAddress: payout,
      cap: 1_000_000n,
      period: 2_592_000n,
      allowlistEnabled: false,
    },
  });

  expect(res.agentId).toBe(0n); // registry assigns id 0 first
  expect(res.proxy).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(res.treasury).toMatch(/^0x[0-9a-fA-F]{40}$/);

  // NFT now owned by manager; agentWallet still the factory (binding is a later step).
  expect((await adapter.ownerOf(0n)).toLowerCase()).toBe(manager.address.toLowerCase());
  expect((await adapter.getAgentWallet(0n)).toLowerCase()).toBe(stack.factory.toLowerCase());
}, 40_000);

test("broadcastCreateEntity then confirmCreateEntity mints the same entity as createEntity", async () => {
  // The saga needs to persist the tx hash BETWEEN broadcasting and reading the agentId (to close the
  // create->persist double-mint window). So the single createEntity must decompose into two steps.
  const params = {
    manager: manager.address,
    guardian,
    operator,
    amendmentDelay: 3_600n,
    metadataURI: "file:///tmp/meta-split.json",
    ein: "STUB-NOT-FILED",
    formationDate: 0,
    operatingAgreementHash: `0x${"cd".repeat(32)}` as `0x${string}`,
    treasury: {
      usdc: stack.usdc,
      payoutAddress: payout,
      cap: 1_000_000n,
      period: 2_592_000n,
      allowlistEnabled: false,
    },
  };

  // Step 1: broadcast returns a tx hash without resolving the agentId yet.
  const txHash = await adapter.broadcastCreateEntity(params);
  expect(txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

  // Step 2: confirm reads the receipt's events and yields the ids + the same tx hash.
  const res = await adapter.confirmCreateEntity(txHash);
  expect(res.txHash).toBe(txHash);
  expect(res.proxy).toMatch(/^0x[0-9a-fA-F]{40}$/);
  expect(res.treasury).toMatch(/^0x[0-9a-fA-F]{40}$/);
  // The entity exists and the NFT landed with the manager, exactly like the one-shot path.
  expect((await adapter.ownerOf(res.agentId)).toLowerCase()).toBe(manager.address.toLowerCase());

  // confirm is idempotent: re-reading the SAME tx returns the SAME agentId (the adopt-on-resume path).
  const again = await adapter.confirmCreateEntity(txHash);
  expect(again.agentId).toBe(res.agentId);
}, 40_000);

test("createEntity reverts when the sending wallet is not the factory owner", async () => {
  // createEntity is onlyOwner; the whole flow silently depends on managerWallet == factory owner.
  // Lock that precondition: a non-owner wallet (the guardian account here) must be rejected.
  const transport = http(anvil.rpcUrl);
  const pub = createPublicClient({ chain: anvilChain, transport });
  const stranger = createWalletClient({ account: ACCT(1), chain: anvilChain, transport });
  const rogue = new ArcAdapter({
    publicClient: pub,
    managerWallet: stranger,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });

  await expect(
    rogue.createEntity({
      manager: manager.address,
      guardian,
      operator,
      amendmentDelay: 3_600n,
      metadataURI: "file:///tmp/meta.json",
      ein: "STUB-NOT-FILED",
      formationDate: 0,
      operatingAgreementHash: `0x${"ab".repeat(32)}`,
      treasury: {
        usdc: stack.usdc,
        payoutAddress: payout,
        cap: 1_000_000n,
        period: 2_592_000n,
        allowlistEnabled: false,
      },
    }),
  ).rejects.toThrow(/OwnableUnauthorizedAccount/);
}, 40_000);
