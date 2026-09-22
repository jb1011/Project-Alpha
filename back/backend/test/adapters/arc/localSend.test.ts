/**
 * WHOSE SIGNATURE MAY HAPPEN INSIDE THE SEND LOCK.
 *
 * The lock exists to serialise nonces, and its cost is head-of-line blocking: everything inside it
 * is time every other send from that key spends waiting. A local key's signature is arithmetic, so
 * it belongs there. A REMOTE signer's is a network round trip — an enclave, a KMS, anything built
 * with viem's `toAccount` — and one of those inside the lock delays every send behind it by however
 * long that service takes, which is exactly what `senderLock.ts` forbids.
 *
 * The two are indistinguishable by shape: both expose `signTransaction`, because that is viem's
 * account interface. They differ in what they SAY they are, and viem 2.52 is explicit:
 * `privateKeyToAccount` sets `source: "privateKey"`, while `toAccount` stamps `source: "custom"` on
 * anything built from a custom signer. So the refusal keys on that, and it happens BEFORE the lock
 * is taken and before a single RPC — a misconfigured signer must not consume a nonce, and must not
 * make the queue wait to find out.
 */
import type { Address, Hex, WalletClient } from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import { beforeEach, expect, test, vi } from "vitest";
import {
  type LocalSendClient,
  localSigner,
  sendFromLocalAccount,
} from "../../../src/adapters/arc/localSend";
import { resetSenderNonces, senderLockHeld } from "../../../src/adapters/arc/senderLock";

/** anvil's published test key #1. No secret here. */
const local = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const WHO = "ArcAdapter: the platform account";
const SIGNED = `0x02${"ab".repeat(32)}` as Hex;
const HASH = `0x${"cd".repeat(32)}` as Hex;

/**
 * An account of the shape an enclave gives: viem's `toAccount`, so `source` is "custom", and a
 * `signTransaction` that goes over a network (here: one that must never be reached).
 */
function remoteAccount() {
  const signTransaction = vi.fn(async () => SIGNED);
  const account = toAccount({
    address: local.address,
    signTransaction,
    async signMessage() {
      return SIGNED;
    },
    async signTypedData() {
      return SIGNED;
    },
  });
  return { account, signTransaction };
}

/** The bounded in-lock client, recording whether either of its two calls was reached. */
function sendClient() {
  const calls: string[] = [];
  const via: LocalSendClient = {
    getTransactionCount: async () => {
      calls.push("eth_getTransactionCount");
      return 0;
    },
    sendRawTransaction: async () => {
      calls.push("eth_sendRawTransaction");
      return HASH;
    },
  };
  return { via, calls };
}

const walletFor = (account: unknown) =>
  ({ account, chain: { id: 31_337 } }) as unknown as WalletClient;

/** A prepared transaction, as `prepareLocalTx` would have returned it: fees and gas decided, no
 *  nonce (that is the locked step). */
const prepared = {
  to: local.address,
  data: "0x" as Hex,
  chainId: 31_337,
  type: "eip1559",
  gas: 90_000n,
  maxFeePerGas: 2n,
  maxPriorityFeePerGas: 1n,
} as never;

beforeEach(() => resetSenderNonces());

test("a REMOTE signer is refused before the lock is taken and before any RPC", async () => {
  const { account, signTransaction } = remoteAccount();
  expect(account.source).toBe("custom"); // the fact the refusal reads
  const { via, calls } = sendClient();

  // SYNCHRONOUSLY — the refusal happens before the function returns a promise at all, so there is
  // no await between being handed this account and saying no.
  expect(() =>
    sendFromLocalAccount({
      wallet: walletFor(account),
      via,
      sender: local.address as Address,
      prepared,
      who: WHO,
    }),
  ).toThrow(
    "ArcAdapter: the platform account cannot sign locally — a remote signer would put a network call inside the send lock",
  );

  // Nothing was asked of the node, nothing was signed, and no nonce was claimed.
  expect(calls).toEqual([]);
  expect(signTransaction).not.toHaveBeenCalled();
  expect(senderLockHeld(local.address as Address)).toBe(false);
});

test("…and `localSigner` itself refuses it, so no caller can reach the signature another way", () => {
  const { account } = remoteAccount();
  expect(() => localSigner(walletFor(account), WHO)).toThrow(/cannot sign locally/);
  // The other half of the same rule: an account with no `signTransaction` at all.
  expect(() => localSigner(walletFor({ address: local.address }), WHO)).toThrow(
    /cannot sign locally/,
  );
});

test("an in-process key is accepted, and its window is the two calls", async () => {
  // `privateKeyToAccount` — `source: "privateKey"` — signs with a key this process holds, which is
  // the one case the lock can afford.
  const { via, calls } = sendClient();
  await expect(
    sendFromLocalAccount({
      wallet: walletFor(local),
      via,
      sender: local.address as Address,
      prepared,
      who: WHO,
    }),
  ).resolves.toBe(HASH);
  expect(calls).toEqual(["eth_getTransactionCount", "eth_sendRawTransaction"]);
});
