import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { anvilChain } from "../../src/chains";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { deployStack } from "../helpers/stack";

// First four standard anvil accounts (funded by the default mnemonic), mirroring arcAdapter.bind.int.test.ts.
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

let anvil: AnvilHandle;
let adapter: ArcAdapter;
let treasury: `0x${string}`;
const manager = privateKeyToAccount(KEYS[0]);
const guardian = privateKeyToAccount(KEYS[1]).address;
const operator = privateKeyToAccount(KEYS[2]).address;
const payout = privateKeyToAccount(KEYS[3]).address;
// An address deliberately never added to the allowlist.
const stranger = privateKeyToAccount(`0x${"b".repeat(63)}1`).address;

beforeAll(async () => {
  anvil = await startAnvil(8549);
  const transport = http(anvil.rpcUrl);
  const pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  const stack = await deployStack(wallet, pub, manager.address);
  adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: wallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
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
  treasury = res.treasury;
}, 40_000);
afterAll(() => anvil?.stop());

test("treasuryPaused is false for a freshly-created treasury", async () => {
  expect(await adapter.treasuryPaused(treasury)).toBe(false);
}, 40_000);

test("treasuryAllowlistEnabled reflects creation (allowlistEnabled: false)", async () => {
  expect(await adapter.treasuryAllowlistEnabled(treasury)).toBe(false);
}, 40_000);

test("treasuryIsAllowed is false for an address never added to the allowlist", async () => {
  expect(await adapter.treasuryIsAllowed(treasury, stranger)).toBe(false);
}, 40_000);
