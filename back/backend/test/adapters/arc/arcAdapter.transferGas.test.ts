/**
 * Unit tests for the Arc native-USDC estimateGas footgun fix: every EOA USDC `transfer` must pass an
 * explicit gas to writeContract so viem does not run eth_estimateGas WITH EIP-1559 fee fields (which
 * reserves ~the sender's whole balance and reverts a near-full-balance USDC transfer). No Anvil.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { beforeEach, expect, test, vi } from "vitest";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";
import { resetSenderNonces, withSenderLock } from "../../../src/adapters/arc/senderLock";

/** The platform signer these fakes send as — and therefore the lock the saga's path must hold. */
const PLATFORM = "0x000000000000000000000000000000000000000A" as Address;

// The nonce floors are process-wide, so each test starts from a fresh ledger (see senderLock.ts).
beforeEach(() => resetSenderNonces());

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const TO = "0x00000000000000000000000000000000000000cc" as Address;
const TREASURY = "0x00000000000000000000000000000000000000dd" as Address;
const FAKE_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000002" as Hex;

function makeAdapter() {
  const simulateContract = vi.fn().mockResolvedValue({ request: { marker: "sim-request" } });
  const operatorWrite = vi.fn().mockResolvedValue(FAKE_HASH);
  // The platform's send path: prepare (outside the lock) -> sign offline -> raw broadcast.
  const managerPrepare = vi.fn(async (r: Record<string, unknown>) => ({ ...r }));
  const managerSign = vi.fn().mockResolvedValue("0xsignedbytes");
  const sendRawTransaction = vi.fn().mockResolvedValue(FAKE_HASH);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({});
  const publicClient = {
    simulateContract,
    waitForTransactionReceipt,
    // Every platform send picks its nonce from this read (see senderLock.ts).
    getTransactionCount: vi.fn().mockResolvedValue(0),
    sendRawTransaction,
  } as unknown as PublicClient;
  const operatorWallet = {
    account: { address: "0x000000000000000000000000000000000000000B" },
    writeContract: operatorWrite,
  } as unknown as WalletClient;
  const managerWallet = {
    account: { address: PLATFORM, signTransaction: managerSign },
    chain: { id: 5042002 },
    prepareTransactionRequest: managerPrepare,
  } as unknown as WalletClient;
  const adapter = new ArcAdapter({
    publicClient,
    managerWallet,
    operatorWallet,
    chainId: 5042002,
    factory: "0x0000000000000000000000000000000000000001" as Address,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
  });
  return {
    adapter,
    simulateContract,
    operatorWrite,
    managerPrepare,
    managerSign,
    waitForTransactionReceipt,
  };
}

/** An explicit bigint gas must be present (its absence is what triggers viem's estimateGas), and the
 *  simulated request must still be forwarded (the fix only ADDS gas). */
function assertExplicitGas(call: unknown) {
  const arg = call as { gas?: bigint; marker?: string };
  expect(typeof arg.gas).toBe("bigint");
  expect(arg.gas).toBeGreaterThanOrEqual(60_000n); // headroom over a ~50k transfer
  expect(arg.marker).toBe("sim-request");
}

test("operatorTransferUsdc passes an explicit gas (skips the fee-fielded estimateGas footgun)", async () => {
  const { adapter, operatorWrite } = makeAdapter();
  const hash = await adapter.operatorTransferUsdc(USDC, TO, 100_000n);
  expect(hash).toBe(FAKE_HASH);
  assertExplicitGas(operatorWrite.mock.calls[0]![0]);
});

test("fundTreasury passes an explicit gas (same footgun class)", async () => {
  const { adapter, managerPrepare, managerSign } = makeAdapter();
  const hash = await adapter.fundTreasury({ usdc: USDC, treasury: TREASURY, amount: 500_000n });
  expect(hash).toBe(FAKE_HASH);
  // The gas is explicit in what is PREPARED, so viem never estimates — and it survives into the
  // bytes that are signed, which is the only place it matters.
  const prepared = managerPrepare.mock.calls[0]![0] as { gas?: bigint; to?: Address };
  expect(typeof prepared.gas).toBe("bigint");
  expect(prepared.gas).toBeGreaterThanOrEqual(60_000n);
  expect(prepared.to).toBe(USDC);
  expect(managerSign.mock.calls[0]![0]).toMatchObject({ gas: prepared.gas, nonce: 0 });
});

test("signFundTreasury — THE SAGA'S PATH — passes an explicit gas too", async () => {
  // The footgun fix has to hold on the path that actually funds agents. `fundTreasury` above is now
  // only the CLI's; the saga signs locally (so the hash exists before anything is sent), and
  // `prepareTransactionRequest` estimates exactly like `writeContract` would unless gas is given.
  const prepareTransactionRequest = vi.fn().mockResolvedValue({ nonce: 11, marker: "prepared" });
  const signTransaction = vi.fn().mockResolvedValue("0xsignedbytes" as Hex);
  const simulateContract = vi.fn().mockResolvedValue({ request: { marker: "sim-request" } });
  const managerWallet = {
    account: { address: PLATFORM, signTransaction },
    chain: { id: 5042002 },
    prepareTransactionRequest,
  } as unknown as WalletClient;
  const adapter = new ArcAdapter({
    publicClient: {
      simulateContract,
      getTransactionCount: vi.fn().mockResolvedValue(0),
    } as unknown as PublicClient,
    managerWallet,
    chainId: 5042002,
    factory: "0x0000000000000000000000000000000000000001" as Address,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
  });

  // Under the sender lock, because on this path the nonce-critical window is the CALLER's: sign,
  // persist, send (the saga's step 7). Picking a nonce outside it is refused.
  const signed = await withSenderLock(PLATFORM, () =>
    adapter.signFundTreasury({
      usdc: USDC,
      treasury: TREASURY,
      amount: 500_000n,
    }),
  );

  const prepared = prepareTransactionRequest.mock.calls[0]![0] as { gas?: bigint; to?: Address };
  expect(typeof prepared.gas).toBe("bigint");
  expect(prepared.gas).toBeGreaterThanOrEqual(60_000n);
  expect(prepared.to).toBe(USDC);
  // Signed as the account that actually holds and spends the USDC — the same wallet in controller
  // mode, where it is the executor: a treasury top-up is a plain transfer, never a relayed call.
  expect(prepareTransactionRequest.mock.calls[0]![0].account).toBe(managerWallet.account);
  // The simulate still runs FIRST, which is what keeps "nothing was sent" true for a revert.
  expect(simulateContract.mock.calls[0]![0].functionName).toBe("transfer");
  // The hash is derived from the signed bytes, not from a node's answer.
  expect(signed.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(signed.nonce).toBe(11);
  expect(signed.rawTx).toBe("0xsignedbytes");
});

test("signFundTreasury refuses to persist a hole where the nonce should be", async () => {
  // An unrecorded nonce would make "pending or dropped?" unanswerable later, and quietly.
  const managerWallet = {
    account: { address: PLATFORM, signTransaction: vi.fn() },
    chain: { id: 5042002 },
    prepareTransactionRequest: vi.fn().mockResolvedValue({ marker: "no-nonce" }),
  } as unknown as WalletClient;
  const adapter = new ArcAdapter({
    publicClient: {
      simulateContract: vi.fn().mockResolvedValue({ request: {} }),
      getTransactionCount: vi.fn().mockResolvedValue(0),
    } as unknown as PublicClient,
    managerWallet,
    chainId: 5042002,
    factory: "0x0000000000000000000000000000000000000001" as Address,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
  });
  await expect(
    withSenderLock(PLATFORM, () =>
      adapter.signFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 1n }),
    ),
  ).rejects.toThrow(/no nonce/);
});

test("operatorTransferUsdc still simulates (eth_call) + waits for the receipt", async () => {
  const { adapter, simulateContract, waitForTransactionReceipt } = makeAdapter();
  await adapter.operatorTransferUsdc(USDC, TO, 100_000n);
  expect(simulateContract.mock.calls[0]![0].functionName).toBe("transfer");
  expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: FAKE_HASH });
});
