/**
 * Unit test: JobAdapter.transferUsdc (the ERC-8183 provider earnings sweep) must pass an explicit gas
 * to writeContract — it sweeps ~the provider EOA's whole USDC balance, which would otherwise hit the
 * Arc native-USDC estimateGas footgun (see src/adapters/arc/gas.ts). No Anvil.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { expect, test, vi } from "vitest";
import { JobAdapter } from "../../../src/adapters/arc/jobAdapter";
import { RECEIPT_TIMEOUT_MS } from "../../../src/adapters/arc/receipts";

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const TREASURY = "0x00000000000000000000000000000000000000dd" as Address;
const FAKE_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000003" as Hex;

test("transferUsdc passes an explicit gas to writeContract (near-full-balance sweep footgun)", async () => {
  const simulateContract = vi.fn().mockResolvedValue({ request: { marker: "sim-request" } });
  // A receipt that says the sweep SUCCEEDED: the adapter now reads `status`, and a reverted one is
  // refused rather than returned as a hash (`adapters/arc/receipts.ts`).
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "success" });
  const writeContract = vi.fn().mockResolvedValue(FAKE_HASH);
  const publicClient = { simulateContract, waitForTransactionReceipt } as unknown as PublicClient;
  const wallet = {
    account: { address: "0x000000000000000000000000000000000000000B" },
    writeContract,
  } as unknown as WalletClient;
  const adapter = new JobAdapter({
    publicClient,
    clientWallet: {} as unknown as WalletClient,
    jobContract: "0x0000000000000000000000000000000000000004" as Address,
  });

  const hash = await adapter.transferUsdc(wallet, USDC, TREASURY, 250_000n);
  expect(hash).toBe(FAKE_HASH);
  const arg = writeContract.mock.calls[0]![0] as { gas?: bigint; marker?: string };
  expect(typeof arg.gas).toBe("bigint");
  expect(arg.gas).toBeGreaterThanOrEqual(60_000n);
  expect(arg.marker).toBe("sim-request");
  // The bound came with the status check (`adapters/arc/receipts.ts`): the same hash as before,
  // and now an explicit deadline, because the escrow unit holds a lock across waits like this one.
  expect(waitForTransactionReceipt).toHaveBeenCalledWith({
    hash: FAKE_HASH,
    timeout: RECEIPT_TIMEOUT_MS,
  });
});
