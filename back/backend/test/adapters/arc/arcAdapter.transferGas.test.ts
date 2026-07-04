/**
 * Unit tests for the Arc native-USDC estimateGas footgun fix: every EOA USDC `transfer` must pass an
 * explicit gas to writeContract so viem does not run eth_estimateGas WITH EIP-1559 fee fields (which
 * reserves ~the sender's whole balance and reverts a near-full-balance USDC transfer). No Anvil.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { expect, test, vi } from "vitest";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const TO = "0x00000000000000000000000000000000000000cc" as Address;
const TREASURY = "0x00000000000000000000000000000000000000dd" as Address;
const FAKE_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000002" as Hex;

function makeAdapter() {
  const simulateContract = vi.fn().mockResolvedValue({ request: { marker: "sim-request" } });
  const operatorWrite = vi.fn().mockResolvedValue(FAKE_HASH);
  const managerWrite = vi.fn().mockResolvedValue(FAKE_HASH);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({});
  const publicClient = { simulateContract, waitForTransactionReceipt } as unknown as PublicClient;
  const operatorWallet = {
    account: { address: "0x000000000000000000000000000000000000000B" },
    writeContract: operatorWrite,
  } as unknown as WalletClient;
  const managerWallet = {
    account: { address: "0x000000000000000000000000000000000000000A" },
    writeContract: managerWrite,
  } as unknown as WalletClient;
  const adapter = new ArcAdapter({
    publicClient,
    managerWallet,
    operatorWallet,
    chainId: 5042002,
    factory: "0x0000000000000000000000000000000000000001" as Address,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
  });
  return { adapter, simulateContract, operatorWrite, managerWrite, waitForTransactionReceipt };
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
  const { adapter, managerWrite } = makeAdapter();
  const hash = await adapter.fundTreasury({ usdc: USDC, treasury: TREASURY, amount: 500_000n });
  expect(hash).toBe(FAKE_HASH);
  assertExplicitGas(managerWrite.mock.calls[0]![0]);
});

test("operatorTransferUsdc still simulates (eth_call) + waits for the receipt", async () => {
  const { adapter, simulateContract, waitForTransactionReceipt } = makeAdapter();
  await adapter.operatorTransferUsdc(USDC, TO, 100_000n);
  expect(simulateContract.mock.calls[0]![0].functionName).toBe("transfer");
  expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: FAKE_HASH });
});
