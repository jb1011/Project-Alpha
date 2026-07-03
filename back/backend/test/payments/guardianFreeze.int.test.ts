import Database from "better-sqlite3";
import {
  http,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
} from "viem";
import { type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, expect, test } from "vitest";
import { agentTreasuryAbi } from "../../src/abis/generated";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { anvilChain } from "../../src/chains";
import { type AuthorityDeps, authorizePayment } from "../../src/payments/authority";
import { PaymentLedger } from "../../src/payments/ledger";
import { migrate } from "../../src/persistence/db";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { deployStack } from "../helpers/stack";

// First four standard anvil accounts (funded by the default mnemonic).
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

let anvil: AnvilHandle;
let pub: PublicClient;
let deps: AuthorityDeps;
let treasury: `0x${string}`;
let guardianWallet: WalletClient;
const manager = privateKeyToAccount(KEYS[0]);
const guardian: PrivateKeyAccount = privateKeyToAccount(KEYS[1]);
const operator = privateKeyToAccount(KEYS[2]).address;
const payout = privateKeyToAccount(KEYS[3]).address;
const payee = privateKeyToAccount(`0x${"d".repeat(63)}1`).address;

/** Guardian toggles the on-chain kill switch (onlyGuardian). */
async function setPaused(paused: boolean) {
  const { request } = await pub.simulateContract({
    account: guardian,
    address: treasury,
    abi: agentTreasuryAbi,
    functionName: paused ? "pause" : "unpause",
  });
  const hash = await guardianWallet.writeContract(request);
  await pub.waitForTransactionReceipt({ hash });
}

beforeAll(async () => {
  anvil = await startAnvil(8550);
  const transport = http(anvil.rpcUrl);
  pub = createPublicClient({ chain: anvilChain, transport });
  const wallet = createWalletClient({ account: manager, chain: anvilChain, transport });
  guardianWallet = createWalletClient({ account: guardian, chain: anvilChain, transport });
  const stack = await deployStack(wallet, pub, manager.address);
  const adapter = new ArcAdapter({
    publicClient: pub,
    managerWallet: wallet,
    chainId: anvilChain.id,
    factory: stack.factory,
    identityRegistry: stack.registry,
  });
  const res = await adapter.createEntity({
    manager: manager.address,
    guardian: guardian.address,
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

  const db = new Database(":memory:");
  migrate(db);
  // The real readTreasury: compose the on-chain ArcAdapter reads into TreasuryState. This is what
  // makes the off-chain Authority obey the on-chain guardian/cap/allowlist.
  deps = {
    ledger: new PaymentLedger(db),
    entityKey: "entityA",
    readTreasury: async (who) => ({
      available: await adapter.treasuryAvailable(treasury),
      paused: await adapter.treasuryPaused(treasury),
      allowlistEnabled: await adapter.treasuryAllowlistEnabled(treasury),
      isAllowed: await adapter.treasuryIsAllowed(treasury, who),
    }),
    // signX402 is faked here (the real BatchEvmSigner adapter is Phase 2); this test proves the
    // GUARDIAN governs the off-chain rail, not the signing itself.
    signX402: async () => ({ header: "X-PAYMENT-test", ledgerRef: "r" }),
  };
}, 40_000);
afterAll(() => anvil?.stop());

test("the on-chain guardian pause instantly halts off-chain authorization, and unpause restores it", async () => {
  // 1) Before pause: a within-cap payment authorizes and yields a signed header.
  const before = await authorizePayment(deps, {
    payee,
    amount: 100n,
    resource: "/x",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
    maxTimeoutSeconds: 60,
  });
  expect(before).toMatchObject({ ok: true, header: "X-PAYMENT-test" });

  // 2) Guardian flips the on-chain kill switch.
  await setPaused(true);

  // 3) The very next authorization is denied — the off-chain Authority obeys on-chain state.
  const during = await authorizePayment(deps, {
    payee,
    amount: 100n,
    resource: "/x",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
    maxTimeoutSeconds: 60,
  });
  expect(during).toMatchObject({ ok: false, reason: "paused" });

  // 4) Guardian unpauses → authorization resumes.
  await setPaused(false);
  const after = await authorizePayment(deps, {
    payee,
    amount: 100n,
    resource: "/x",
    asset: "0x3600000000000000000000000000000000000000",
    network: "eip155:5042002",
    maxTimeoutSeconds: 60,
  });
  expect(after).toMatchObject({ ok: true, header: "X-PAYMENT-test" });
}, 40_000);
