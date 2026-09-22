/**
 * Unit tests for the Arc native-USDC estimateGas footgun fix: every EOA USDC `transfer` must pass an
 * explicit gas to writeContract so viem does not run eth_estimateGas WITH EIP-1559 fee fields (which
 * reserves ~the sender's whole balance and reverts a near-full-balance USDC transfer). No Anvil.
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
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";
import { USDC_TRANSFER_GAS } from "../../../src/adapters/arc/gas";
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
  // The platform's send path: prepare (outside the lock) -> sign offline -> raw broadcast. The
  // fake serialises for real, so the transfer that goes out can be decoded and checked.
  const managerPrepare = vi.fn(async (r: Record<string, unknown>) => ({
    ...r,
    chainId: 5042002,
    type: "eip1559",
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  }));
  const managerSign = vi.fn(async (tx: Record<string, unknown>) =>
    serializeTransaction(tx as never),
  );
  const raw: Hex[] = [];
  const sendRawTransaction = vi.fn(
    async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      raw.push(serializedTransaction);
      return FAKE_HASH;
    },
  );
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
    // The in-process key `localSend.ts` insists on, spelled as viem spells it.
    account: { address: PLATFORM, source: "privateKey", signTransaction: managerSign },
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
    /** What went on the wire, decoded. */
    sent: () => raw.map((r) => parseTransaction(r)),
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

test("a treasury top-up passes an explicit gas (same footgun class)", async () => {
  const { adapter, managerPrepare, sent } = makeAdapter();
  const hash = await adapter.confirmFundTreasury(
    await adapter.broadcastFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 500_000n }),
  );
  expect(hash).toBe(FAKE_HASH);
  // The gas is explicit in what is PREPARED, so viem never estimates it...
  const prepared = managerPrepare.mock.calls[0]![0] as { gas?: bigint; to?: Address };
  expect(typeof prepared.gas).toBe("bigint");
  expect(prepared.gas).toBeGreaterThanOrEqual(60_000n); // headroom over a ~50k transfer
  expect(prepared.to).toBe(USDC);
  // ...and the transfer that actually goes out carries it, with the call and the nonce.
  expect(sent()).toHaveLength(1);
  const tx = sent()[0]!;
  expect({ to: tx.to, data: tx.data, value: tx.value, gas: tx.gas, nonce: tx.nonce }).toEqual({
    to: USDC.toLowerCase(),
    data: encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "transfer",
          stateMutability: "nonpayable",
          inputs: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ],
      functionName: "transfer",
      args: [TREASURY, 500_000n],
    }),
    value: undefined, // a USDC transfer moves no native value
    gas: USDC_TRANSFER_GAS,
    nonce: 0,
  });
});

test("signFundTreasury — THE SAGA'S PATH — passes an explicit gas too", async () => {
  // The footgun fix has to hold on the path that actually funds agents. `fundTreasury` above is now
  // only the CLI's; the saga signs locally (so the hash exists before anything is sent), and
  // `prepareTransactionRequest` estimates exactly like `writeContract` would unless gas is given.
  const prepareTransactionRequest = vi.fn().mockResolvedValue({ marker: "prepared" });
  const signTransaction = vi.fn().mockResolvedValue("0xsignedbytes" as Hex);
  const simulateContract = vi.fn().mockResolvedValue({ request: { marker: "sim-request" } });
  const managerWallet = {
    account: { address: PLATFORM, source: "privateKey", signTransaction },
    chain: { id: 5042002 },
    prepareTransactionRequest,
  } as unknown as WalletClient;
  const adapter = new ArcAdapter({
    publicClient: {
      simulateContract,
      getTransactionCount: vi.fn().mockResolvedValue(11),
    } as unknown as PublicClient,
    managerWallet,
    chainId: 5042002,
    factory: "0x0000000000000000000000000000000000000001" as Address,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
  });

  // Prepared OUTSIDE the lock (the pre-flight, the gas, the fees), signed inside it: on this path
  // the nonce-critical window is the CALLER's — sign, persist, send (the saga's step 7) — and
  // picking a nonce outside it is refused.
  const readyToSign = await adapter.prepareFundTreasury({
    usdc: USDC,
    treasury: TREASURY,
    amount: 500_000n,
  });
  const signed = await withSenderLock(PLATFORM, () => adapter.signFundTreasury(readyToSign));

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
  expect(signed.nonce).toBe(11); // the ledger's, from the node's pending count
  expect(signed.rawTx).toBe("0xsignedbytes");
});

test("signFundTreasury refuses to persist a hole where the nonce should be", async () => {
  // An unrecorded nonce would make "pending or dropped?" unanswerable later, and quietly. The
  // number now comes from the ledger, so the hole to refuse is a node that answers the count with
  // something that is not one.
  const signTransaction = vi.fn();
  const managerWallet = {
    // A local key, as viem labels one: the refusal this test is about is the missing nonce, and it
    // must not be reached by being mistaken for a remote signer instead.
    account: { address: PLATFORM, source: "privateKey", signTransaction },
    chain: { id: 5042002 },
    prepareTransactionRequest: vi.fn().mockResolvedValue({ marker: "prepared" }),
  } as unknown as WalletClient;
  const adapter = new ArcAdapter({
    publicClient: {
      simulateContract: vi.fn().mockResolvedValue({ request: {} }),
      getTransactionCount: vi.fn().mockResolvedValue(undefined),
    } as unknown as PublicClient,
    managerWallet,
    chainId: 5042002,
    factory: "0x0000000000000000000000000000000000000001" as Address,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
  });
  const readyToSign = await adapter.prepareFundTreasury({
    usdc: USDC,
    treasury: TREASURY,
    amount: 1n,
  });
  await expect(
    withSenderLock(PLATFORM, () => adapter.signFundTreasury(readyToSign)),
  ).rejects.toThrow(/nonce/);
  expect(signTransaction).not.toHaveBeenCalled();
});

test("operatorTransferUsdc still simulates (eth_call) + waits for the receipt", async () => {
  const { adapter, simulateContract, waitForTransactionReceipt } = makeAdapter();
  await adapter.operatorTransferUsdc(USDC, TO, 100_000n);
  expect(simulateContract.mock.calls[0]![0].functionName).toBe("transfer");
  expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: FAKE_HASH });
});
