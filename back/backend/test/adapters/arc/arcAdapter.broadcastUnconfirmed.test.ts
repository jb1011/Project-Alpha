/**
 * R1 (Critical, 2026-09-17 review): the adapter is the only layer that knows whether a hash
 * exists, so it is the layer that has to say so.
 *
 * A treasury top-up simulates, SENDS, and then awaits the receipt. viem rejects a receipt-poll
 * failure verbatim (`waitForTransactionReceipt`'s catch-all `emit.reject(err)`), so the identical
 * `HttpRequestError{status:429}` reaches the saga from both sides of the broadcast — and the old
 * public sentence said "Nothing was sent" for both. With the wizard's new Retry button that
 * invited a second transfer of platform funds.
 *
 * No Anvil: all chain I/O is mocked, same harness as arcAdapter.policy.test.ts.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { BaseError, HttpRequestError, TransactionReceiptNotFoundError } from "viem";
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
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "success" });
  const getTransactionReceipt = vi.fn();
  // The send path: prepare (outside the lock) -> sign offline -> raw broadcast (see senderLock.ts).
  const prepareTransactionRequest = vi.fn(async (r: Record<string, unknown>) => ({ ...r }));
  const signTransaction = vi.fn().mockResolvedValue("0xsignedbytes");
  const sendRawTransaction = vi.fn().mockResolvedValue(FAKE_HASH);

  const publicClient = {
    simulateContract,
    waitForTransactionReceipt,
    getTransactionReceipt,
    // Every platform send picks its nonce from this read (see senderLock.ts).
    getTransactionCount: vi.fn().mockResolvedValue(0),
    sendRawTransaction,
  } as unknown as PublicClient;
  const managerWallet = {
    // `source: "privateKey"` is what viem's `privateKeyToAccount` reports, and what `localSend.ts`
    // requires before it will sign inside the send lock.
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
    sendRawTransaction,
    waitForTransactionReceipt,
    getTransactionReceipt,
  };
}

/** A treasury top-up, both halves: broadcast, then await the receipt — which is what the saga and
 *  the CLI's fund door each do, with their own recording in between. */
const fund = async (a: ArcAdapter) =>
  a.confirmFundTreasury(
    await a.broadcastFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 1_000_000n }),
  );

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
  const { adapter, simulateContract, sendRawTransaction } = makeAdapter();
  simulateContract.mockRejectedValue(
    new Error("execution reverted: ERC20: transfer amount exceeds balance"),
  );

  await expect(fund(adapter)).rejects.not.toBeInstanceOf(BroadcastUnconfirmedError);
  expect(sendRawTransaction).not.toHaveBeenCalled();
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

test("receiptOutcome: a definitive absence is `absent`, a BROKEN READ THROWS (gate N8)", async () => {
  const { adapter, getTransactionReceipt, waitForTransactionReceipt } = makeAdapter();

  getTransactionReceipt.mockResolvedValue({ status: "success" });
  await expect(adapter.receiptOutcome(FAKE_HASH)).resolves.toBe("success");

  getTransactionReceipt.mockResolvedValue({ status: "reverted" });
  await expect(adapter.receiptOutcome(FAKE_HASH)).resolves.toBe("reverted");

  // The chain says it has no receipt. That is an ANSWER, and the caller may act on it.
  getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: FAKE_HASH }));
  await expect(adapter.receiptOutcome(FAKE_HASH)).resolves.toBe("absent");

  // ⚠ A THROTTLED RPC IS NOT AN ANSWER. This used to come back as the same "unknown" a genuine
  // absence did, and once `absent` could lead to `dropped`, that conflation authorised a second
  // transfer of money that had already moved. Matched by TYPE, like the AgentBook registrar: other
  // viem errors also read as "not found" in their prose and mean the read broke.
  getTransactionReceipt.mockRejectedValue(rpc429());
  await expect(adapter.receiptOutcome(FAKE_HASH)).rejects.toThrow(HttpRequestError);

  // A wrapped not-found is still definitive — `walk` tests the chain, not just the top error.
  getTransactionReceipt.mockRejectedValue(
    new BaseError("outer", { cause: new TransactionReceiptNotFoundError({ hash: FAKE_HASH }) }),
  );
  await expect(adapter.receiptOutcome(FAKE_HASH)).resolves.toBe("absent");

  // A plain non-viem failure is a broken read too.
  getTransactionReceipt.mockRejectedValue(new Error("socket hang up"));
  await expect(adapter.receiptOutcome(FAKE_HASH)).rejects.toThrow(/socket hang up/);

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
