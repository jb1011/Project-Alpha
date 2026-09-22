/**
 * SEND AS A LOCAL ACCOUNT — the shape every in-process signing key in this repository uses.
 *
 * It was the platform key's private shape first (`ArcAdapter.prepareAsPlatform` /
 * `sendAsPlatform`), and it is not about the platform at all: it is about a key whose signature is
 * arithmetic rather than a network call. The job client and the evaluator/recorder are the same
 * kind of key, they had the same collision (two sends reading the node's count independently, both
 * signing the same nonce, one of the two rejected or replaced), and they now take the same lock —
 * the SAME lock, keyed by signer address, not a second mechanism beside it.
 *
 * The division of labour is the whole point, and `senderLock.ts` says why:
 *  - {prepareLocalTx} is the SLOW half — pre-flight, gas, fees, chain id — and runs with no lock
 *    held, because every other send from that key would otherwise queue behind those round trips;
 *  - {sendFromLocalAccount} is the nonce-critical half: read the pending nonce, sign offline,
 *    hand the bytes over. Two RPCs, both on the caller's bounded client, and nothing else.
 *
 * ⚠ A RECEIPT WAIT NEVER BELONGS INSIDE. The callers here await theirs after the send returns.
 *
 * ⚠ AN IN-PROCESS KEY ONLY. {localSigner} refuses an account that cannot sign locally, which is
 * the honest answer for a remote signer: its signature is a round trip, and a round trip inside
 * the lock is paid for by every send behind it. A remote signer needs a different nonce strategy
 * (the nonce is claimed by the signature), so the wallets this repository takes from a CALLER —
 * the per-agent enclave, Circle — keep their own path and are not routed through here.
 */
import type { Account, Address, Chain, Hex, Transport, WalletClient } from "viem";
import { sendFromSender } from "./senderLock";

/** A wallet client that is known to carry a local signing account. */
export type LocalWallet = WalletClient<Transport, Chain, Account>;

/** A transaction request with everything decided except its nonce — the locked step. */
export type PreparedLocalTx = Omit<
  Awaited<ReturnType<LocalWallet["prepareTransactionRequest"]>>,
  "nonce"
>;

/**
 * The two calls that happen INSIDE the send lock, and all any adapter asks of the bounded client.
 *
 * Typed structurally rather than as viem's `PublicClient` for the reason `hedera/registry.ts` gives
 * for its own clients: these two methods are the whole contract, a real viem client satisfies it,
 * and a test can supply one without inventing a chain.
 */
export interface LocalSendClient {
  getTransactionCount(args: { address: Address; blockTag: "pending" }): Promise<number>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
}

/**
 * Everything the transaction needs before it can be numbered, fetched OUTSIDE the lock.
 *
 * `parameters` is viem's default list MINUS `nonce`: picking the nonce is the locked step, and
 * asking for it here would both waste a call and pick it in the wrong place. An explicit `gas`
 * (the Arc `USDC_TRANSFER_GAS` footgun fix, and the relay's estimate) is passed straight through,
 * so viem skips the estimate exactly as it did before.
 */
export function prepareLocalTx(
  wallet: WalletClient,
  p: { account: Account; to: Address; data?: Hex; value?: bigint; gas?: bigint },
): Promise<PreparedLocalTx> {
  const w = wallet as LocalWallet;
  return w.prepareTransactionRequest({
    account: p.account,
    chain: w.chain,
    to: p.to,
    data: p.data,
    value: p.value,
    gas: p.gas,
    parameters: ["blobVersionedHashes", "chainId", "fees", "gas", "type"],
  }) as Promise<PreparedLocalTx>;
}

/**
 * The account's own `signTransaction`, or a refusal naming the caller.
 *
 * STRAIGHT TO THE ACCOUNT rather than through `walletClient.signTransaction`, which asks the node
 * for the chain id first — unconditionally, before it looks at whether it needs it (viem 2.52
 * `actions/wallet/signTransaction.ts`) — and that would be a third call inside the window. The
 * prepared request already carries `chainId`, and the chain's own serializer is handed over exactly
 * as the wallet action would.
 */
export function localSigner(
  wallet: WalletClient,
  who: string,
): (request: PreparedLocalTx & { nonce: number }) => Promise<Hex> {
  const w = wallet as LocalWallet;
  const sign = w.account?.signTransaction;
  if (!sign)
    throw new Error(
      `${who} cannot sign locally — a remote signer would put a network call inside the send lock`,
    );
  return (request) =>
    sign.call(w.account, request as never, {
      serializer: w.chain?.serializers?.transaction,
    }) as Promise<Hex>;
}

/**
 * THE CHOKEPOINT: the only place a transaction from a local key is numbered and put on the wire.
 *
 * Inside the lock, three things and exactly two RPCs: read the pending nonce, sign (offline), hand
 * the bytes to the node. `sender` is the lock's key — the address the nonce belongs to.
 */
export function sendFromLocalAccount(p: {
  wallet: WalletClient;
  via: LocalSendClient;
  sender: Address;
  prepared: PreparedLocalTx;
  /** Named in the refusal when the account cannot sign locally. */
  who: string;
}): Promise<Hex> {
  const sign = localSigner(p.wallet, p.who);
  return sendFromSender(
    p.sender,
    () => pendingNonceOf(p.via, p.sender),
    async (nonce) => {
      const rawTx = await sign({ ...p.prepared, nonce });
      return p.via.sendRawTransaction({ serializedTransaction: rawTx });
    },
  );
}

/** What a NEW transaction from this sender would be numbered, before our own floor is applied.
 *  `pending`, so it counts transactions of ours the chain has accepted but not yet mined. */
export function pendingNonceOf(via: LocalSendClient, sender: Address): Promise<number> {
  return via.getTransactionCount({ address: sender, blockTag: "pending" });
}
