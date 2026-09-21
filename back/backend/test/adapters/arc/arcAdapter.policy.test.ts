/**
 * Unit tests for ArcAdapter.schedulePolicyUpdate / executePolicyUpdate.
 * No Anvil — all chain I/O is mocked so these run in the normal vitest suite.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { beforeEach, expect, test, vi } from "vitest";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";
import { resetSenderNonces } from "../../../src/adapters/arc/senderLock";

// The nonce floors are process-wide, so each test starts from a fresh ledger (see senderLock.ts).
beforeEach(() => resetSenderNonces());

const TREASURY = "0x000000000000000000000000000000000000000F" as Address;
const FAKE_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000001" as Hex;
const POLICY_ID = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
const PAYOUT = "0x000000000000000000000000000000000000000A" as Address;

function makeAdapter() {
  const simulateContract = vi.fn();
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({});
  // The send path: prepare (outside the lock) -> sign offline -> raw broadcast (see senderLock.ts).
  const prepareTransactionRequest = vi.fn(async (r: Record<string, unknown>) => ({ ...r }));
  const signTransaction = vi.fn().mockResolvedValue("0xsignedbytes");
  const sendRawTransaction = vi.fn().mockResolvedValue(FAKE_HASH);

  const publicClient = {
    simulateContract,
    waitForTransactionReceipt,
    // Every platform send picks its nonce from this read (see senderLock.ts).
    getTransactionCount: vi.fn().mockResolvedValue(0),
    sendRawTransaction,
  } as unknown as PublicClient;

  const managerWallet = {
    account: { address: "0x000000000000000000000000000000000000000B", signTransaction },
    chain: { id: 1 },
    prepareTransactionRequest,
  } as unknown as WalletClient;

  const adapter = new ArcAdapter({
    publicClient,
    managerWallet,
    chainId: 1,
    factory: "0x0000000000000000000000000000000000000001" as Address,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
  });

  return {
    adapter,
    simulateContract,
    prepareTransactionRequest,
    signTransaction,
    sendRawTransaction,
    waitForTransactionReceipt,
  };
}

test("schedulePolicyUpdate: simulates correct function + args, signs with managerWallet, returns hash", async () => {
  const { adapter, simulateContract, prepareTransactionRequest, signTransaction } = makeAdapter();

  const FAKE_REQUEST = { fake: "request" };
  simulateContract.mockResolvedValue({ request: FAKE_REQUEST });

  const newCap = 200_000_000n; // 200 USDC in base units
  const newPeriod = 86_400n;
  const allowlistOn = false;

  const hash = await adapter.schedulePolicyUpdate(TREASURY, {
    newCap,
    newPeriod,
    allowlistOn,
    newPayout: PAYOUT,
  });

  expect(hash).toBe(FAKE_HASH);

  const simArgs = simulateContract.mock.calls[0]![0];
  expect(simArgs.functionName).toBe("schedulePolicyUpdate");
  expect(simArgs.address).toBe(TREASURY);
  expect(simArgs.args).toEqual([newCap, newPeriod, allowlistOn, PAYOUT]);
  // Must sign with managerWallet, not operatorWallet
  expect(simArgs.account?.address).toBe("0x000000000000000000000000000000000000000B");

  // The call is sent to the treasury, prepared without a nonce (that is the locked step) and
  // signed with the one the ledger assigned it.
  expect(prepareTransactionRequest.mock.calls[0]![0]).toMatchObject({ to: TREASURY });
  expect(prepareTransactionRequest.mock.calls[0]![0].parameters).not.toContain("nonce");
  expect(signTransaction.mock.calls[0]![0]).toMatchObject({ to: TREASURY, nonce: 0 });
});

test("executePolicyUpdate: simulates correct function + policyId, signs with managerWallet, returns hash", async () => {
  const { adapter, simulateContract, prepareTransactionRequest, signTransaction } = makeAdapter();

  const FAKE_REQUEST = { fake: "exec-request" };
  simulateContract.mockResolvedValue({ request: FAKE_REQUEST });

  const hash = await adapter.executePolicyUpdate(TREASURY, POLICY_ID);

  expect(hash).toBe(FAKE_HASH);

  const simArgs = simulateContract.mock.calls[0]![0];
  expect(simArgs.functionName).toBe("executePolicyUpdate");
  expect(simArgs.address).toBe(TREASURY);
  expect(simArgs.args).toEqual([POLICY_ID]);
  expect(simArgs.account?.address).toBe("0x000000000000000000000000000000000000000B");

  // The call is sent to the treasury, prepared without a nonce (that is the locked step) and
  // signed with the one the ledger assigned it.
  expect(prepareTransactionRequest.mock.calls[0]![0]).toMatchObject({ to: TREASURY });
  expect(prepareTransactionRequest.mock.calls[0]![0].parameters).not.toContain("nonce");
  expect(signTransaction.mock.calls[0]![0]).toMatchObject({ to: TREASURY, nonce: 0 });
});

test("waitForTransactionReceipt is called after the broadcast for schedulePolicyUpdate", async () => {
  const { adapter, simulateContract, waitForTransactionReceipt } = makeAdapter();
  simulateContract.mockResolvedValue({ request: {} });

  await adapter.schedulePolicyUpdate(TREASURY, {
    newCap: 1_000_000n,
    newPeriod: 3600n,
    allowlistOn: true,
    newPayout: PAYOUT,
  });

  expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: FAKE_HASH });
});

test("waitForTransactionReceipt is called after the broadcast for executePolicyUpdate", async () => {
  const { adapter, simulateContract, waitForTransactionReceipt } = makeAdapter();
  simulateContract.mockResolvedValue({ request: {} });

  await adapter.executePolicyUpdate(TREASURY, POLICY_ID);

  expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: FAKE_HASH });
});
