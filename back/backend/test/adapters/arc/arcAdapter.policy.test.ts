/**
 * Unit tests for ArcAdapter.schedulePolicyUpdate / executePolicyUpdate.
 * No Anvil — all chain I/O is mocked so these run in the normal vitest suite.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
  parseTransaction,
  serializeTransaction,
} from "viem";
import { beforeEach, expect, test, vi } from "vitest";
import { agentTreasuryAbi } from "../../../src/abis/generated";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";
import { resetSenderNonces } from "../../../src/adapters/arc/senderLock";

// The nonce floors are process-wide, so each test starts from a fresh ledger (see senderLock.ts).
beforeEach(() => resetSenderNonces());

const TREASURY = "0x000000000000000000000000000000000000000F" as Address;
const FAKE_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000001" as Hex;
const POLICY_ID = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
const PAYOUT = "0x000000000000000000000000000000000000000A" as Address;
/** What the fake `prepareTransactionRequest` estimates when the caller passes no explicit gas. */
const PREPARED_GAS = 90_000n;

/** The fields the old exact-equality assertion pinned, read off the decoded transaction. */
const wire = (tx: ReturnType<typeof parseTransaction>) => ({
  to: tx.to,
  data: tx.data,
  value: tx.value,
  gas: tx.gas,
  nonce: tx.nonce,
});

function makeAdapter() {
  const simulateContract = vi.fn();
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({});
  // The send path: prepare (outside the lock) -> sign offline -> raw broadcast (see senderLock.ts).
  // The fake serialises for real, so the call that goes out can be decoded and checked field for
  // field — that is where `to`, `data`, `gas` and the nonce live now.
  const prepareTransactionRequest = vi.fn(async (r: Record<string, unknown>) => ({
    ...r,
    chainId: 1,
    type: "eip1559",
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    gas: r.gas ?? PREPARED_GAS,
  }));
  const signTransaction = vi.fn(async (tx: Record<string, unknown>) =>
    serializeTransaction(tx as never),
  );
  const raw: Hex[] = [];
  const sendRawTransaction = vi.fn(
    async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      raw.push(serializedTransaction);
      return FAKE_HASH;
    },
  );

  const publicClient = {
    simulateContract,
    waitForTransactionReceipt,
    // Every platform send picks its nonce from this read (see senderLock.ts).
    getTransactionCount: vi.fn().mockResolvedValue(0),
    sendRawTransaction,
  } as unknown as PublicClient;

  const managerWallet = {
    // `source` is how `localSend.ts` tells an in-process key from a remote signer; this fake
    // stands in for a `privateKeyToAccount`, so it says the same thing viem's does.
    account: {
      address: "0x000000000000000000000000000000000000000B",
      source: "privateKey",
      signTransaction,
    },
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
    /** What went on the wire, decoded. */
    sent: () => raw.map((r) => parseTransaction(r)),
  };
}

test("schedulePolicyUpdate: simulates correct function + args, signs with managerWallet, returns hash", async () => {
  const { adapter, simulateContract, sent } = makeAdapter();

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

  // What actually went out: the simulated call, to the treasury, at the nonce the ledger assigned.
  expect(sent()).toHaveLength(1);
  expect(wire(sent()[0]!)).toEqual({
    to: TREASURY.toLowerCase(),
    data: encodeFunctionData({
      abi: agentTreasuryAbi,
      functionName: "schedulePolicyUpdate",
      args: [newCap, newPeriod, allowlistOn, PAYOUT],
    }),
    value: undefined, // a policy update moves no native value
    gas: PREPARED_GAS,
    nonce: 0,
  });
});

test("executePolicyUpdate: simulates correct function + policyId, signs with managerWallet, returns hash", async () => {
  const { adapter, simulateContract, sent } = makeAdapter();

  const FAKE_REQUEST = { fake: "exec-request" };
  simulateContract.mockResolvedValue({ request: FAKE_REQUEST });

  const hash = await adapter.executePolicyUpdate(TREASURY, POLICY_ID);

  expect(hash).toBe(FAKE_HASH);

  const simArgs = simulateContract.mock.calls[0]![0];
  expect(simArgs.functionName).toBe("executePolicyUpdate");
  expect(simArgs.address).toBe(TREASURY);
  expect(simArgs.args).toEqual([POLICY_ID]);
  expect(simArgs.account?.address).toBe("0x000000000000000000000000000000000000000B");

  expect(sent()).toHaveLength(1);
  expect(wire(sent()[0]!)).toEqual({
    to: TREASURY.toLowerCase(),
    data: encodeFunctionData({
      abi: agentTreasuryAbi,
      functionName: "executePolicyUpdate",
      args: [POLICY_ID],
    }),
    value: undefined,
    gas: PREPARED_GAS,
    nonce: 0,
  });
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
