/**
 * R1 (Critical, 2026-09-17 review): the adapter is the only layer that knows whether a hash
 * exists, so it is the layer that has to say so.
 *
 * `fundTreasury` simulates, SENDS, and then awaits the receipt. viem rejects a receipt-poll
 * failure verbatim (`waitForTransactionReceipt`'s catch-all `emit.reject(err)`), so the identical
 * `HttpRequestError{status:429}` reaches the saga from both sides of the broadcast — and the old
 * public sentence said "Nothing was sent" for both. With the wizard's new Retry button that
 * invited a second transfer of platform funds.
 *
 * No Anvil: all chain I/O is mocked, same harness as arcAdapter.policy.test.ts.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { HttpRequestError, TransactionReceiptNotFoundError } from "viem";
import { expect, test, vi } from "vitest";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";
import { BroadcastUnconfirmedError } from "../../../src/errors";
import { publicErrorMessage } from "../../../src/workflow/publicError";

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const TREASURY = "0x000000000000000000000000000000000000000F" as Address;
const FAKE_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000001" as Hex;

/** The real shape of the prod condition: the Canteen key throttling a receipt poll. */
const rpc429 = () =>
  new HttpRequestError({
    body: { method: "eth_getTransactionReceipt", params: [FAKE_HASH] },
    details: "rate limit exceeded",
    status: 429,
    url: "https://arc.example.com/v2/SECRETKEY123456",
  });

function makeAdapter() {
  const simulateContract = vi.fn().mockResolvedValue({ request: { fake: "request" } });
  const writeContract = vi.fn().mockResolvedValue(FAKE_HASH);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "success" });
  const getTransactionReceipt = vi.fn();

  const publicClient = {
    simulateContract,
    waitForTransactionReceipt,
    getTransactionReceipt,
  } as unknown as PublicClient;
  const managerWallet = {
    account: { address: "0x000000000000000000000000000000000000000B" },
    writeContract,
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
    writeContract,
    waitForTransactionReceipt,
    getTransactionReceipt,
  };
}

const fund = (a: ArcAdapter) =>
  a.fundTreasury({ usdc: USDC, treasury: TREASURY, amount: 1_000_000n });

test("a 429 during the RECEIPT WAIT becomes BroadcastUnconfirmedError carrying the hash", async () => {
  const { adapter, waitForTransactionReceipt } = makeAdapter();
  const cause = rpc429();
  waitForTransactionReceipt.mockRejectedValue(cause);

  const err = await fund(adapter).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BroadcastUnconfirmedError);
  const unconfirmed = err as BroadcastUnconfirmedError;
  expect(unconfirmed.txHash).toBe(FAKE_HASH);
  expect(unconfirmed.operation).toBe("fundTreasury");
  // The cause is kept, so the operator diagnostic still has the whole chain.
  expect(unconfirmed.cause).toBe(cause);
});

test("…and the public message names the hash instead of claiming nothing was sent", async () => {
  const { adapter, waitForTransactionReceipt } = makeAdapter();
  waitForTransactionReceipt.mockRejectedValue(rpc429());
  const err = await fund(adapter).catch((e: unknown) => e);

  const message = publicErrorMessage(err);
  expect(message).toContain("The transfer was sent (0xdead…0001)");
  expect(message).toContain("Do not retry");
  expect(message).not.toContain("Nothing was sent");
  expect(message).not.toContain("SECRETKEY123456");
});

test("a REFUSED send (simulate reverts, no hash) is untouched — nothing was sent is true there", async () => {
  // The 2026-09-14 shape: `simulateContract` runs FIRST, so an empty platform wallet fails before
  // any broadcast. That error must keep its own message and never be dressed as unconfirmed.
  const { adapter, simulateContract, writeContract } = makeAdapter();
  simulateContract.mockRejectedValue(
    new Error("execution reverted: ERC20: transfer amount exceeds balance"),
  );

  await expect(fund(adapter)).rejects.not.toBeInstanceOf(BroadcastUnconfirmedError);
  expect(writeContract).not.toHaveBeenCalled();
});

test("a REVERTED receipt is a failure, not a funded treasury", async () => {
  // Pre-existing gap found while implementing R1: `waitForTransactionReceipt` RESOLVES for a
  // reverted transaction, so the hash was returned and step 7 marked the entity `funded` with a
  // transfer that moved nothing. The reconcile path treats `reverted` as "send again", so the send
  // path has to see the same fact.
  const { adapter, waitForTransactionReceipt } = makeAdapter();
  waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });

  const err = await fund(adapter).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(BroadcastUnconfirmedError);
  expect((err as Error).message).toMatch(/reverted/i);
  expect((err as Error).message).toContain(FAKE_HASH);
});

test("the happy path still returns the hash", async () => {
  const { adapter } = makeAdapter();
  await expect(fund(adapter)).resolves.toBe(FAKE_HASH);
});

test("receiptOutcome reads a receipt once and does not wait", async () => {
  const { adapter, getTransactionReceipt, waitForTransactionReceipt } = makeAdapter();

  getTransactionReceipt.mockResolvedValue({ status: "success" });
  await expect(adapter.receiptOutcome(FAKE_HASH)).resolves.toBe("success");

  getTransactionReceipt.mockResolvedValue({ status: "reverted" });
  await expect(adapter.receiptOutcome(FAKE_HASH)).resolves.toBe("reverted");

  // Not found = pending OR dropped. Both are "we do not know", which is the answer that makes the
  // saga refuse rather than guess.
  getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: FAKE_HASH }));
  await expect(adapter.receiptOutcome(FAKE_HASH)).resolves.toBe("unknown");

  // A throttled RPC is also "unknown" — never "reverted".
  getTransactionReceipt.mockRejectedValue(rpc429());
  await expect(adapter.receiptOutcome(FAKE_HASH)).resolves.toBe("unknown");

  // Reconciliation must never block the saga on a 180-second wait.
  expect(waitForTransactionReceipt).not.toHaveBeenCalled();
});

test("confirmCreateEntity wraps a receipt failure too — a mint may be on chain", async () => {
  // Same window, higher stakes: the agent NFT exists and `confirmCreateEntity`'s own resume design
  // depends on re-reading that hash rather than broadcasting a second mint.
  const { adapter, waitForTransactionReceipt } = makeAdapter();
  waitForTransactionReceipt.mockRejectedValue(rpc429());

  const err = await adapter.confirmCreateEntity(FAKE_HASH).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BroadcastUnconfirmedError);
  expect((err as BroadcastUnconfirmedError).txHash).toBe(FAKE_HASH);
  expect((err as BroadcastUnconfirmedError).operation).toBe("createEntity");
});
