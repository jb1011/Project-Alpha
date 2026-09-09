import { encodeFunctionData, keccak256 } from "viem";
import type { PublicClient, WalletClient } from "viem";
import { CANCEL_AUTHORIZATION_GAS, TRANSFER_WITH_AUTHORIZATION_GAS } from "../adapters/arc/gas";
import { FIAT_TOKEN_ABI, readAuthorizationState } from "../adapters/arc/usdcToken";
import type { Address, Hex } from "../types";

/**
 * The EXECUTOR side of a formation payment (design 2026-08-26 §6.4).
 *
 * The guardian signs an EIP-3009 authorization; nobody's money moves until somebody puts it
 * on-chain, and that somebody is us — the platform EOA, paying the gas, which on Arc is USDC
 * cents. This module is the whole of that: build the call, SIGN THE TRANSACTION WITHOUT SENDING
 * IT, hand the caller its bytes and its hash to persist, and only then broadcast.
 *
 * ── WHY NOT `writeContract` ───────────────────────────────────────────────────────────────────
 *
 * §6.4 asks for two things that `writeContract` cannot both give: an explicit gas limit (it can)
 * and the SIGNED RAW TRANSACTION IN HAND BEFORE IT GOES OUT (it cannot — it signs and sends in one
 * call, and the first thing it returns is a hash for a transaction that is already public). The
 * crash-window rule is the more important of the two: a process that dies between "sent" and
 * "recorded" must be able to re-broadcast THE SAME BYTES rather than ask the guardian for a second
 * signature while the first is still live and self-authorizing. So the call is composed by hand —
 * `encodeFunctionData` + `signTransaction` + `sendRawTransaction` — with exactly the explicit gas
 * `writeContract` would have carried.
 *
 * ⚠ A signed transaction commits to a NONCE. If the persisted bytes are never broadcast and the
 * executor's nonce moves past them, the re-broadcast fails permanently ("nonce too low") — and
 * that is SAFE but slow: the authorization was never used, `authorizationState` stays false, and
 * the row expires on its own clock and can then be re-quoted. It cannot double-charge, which is
 * the property that matters. Serialising settles per company (the caller's keyed lock) keeps the
 * window small.
 */

export interface FormationExecutorDeps {
  publicClient: PublicClient;
  /** The platform EOA — the executor. It signs and pays the gas; it is NOT the token sender. */
  walletClient: WalletClient;
  usdc: Address;
  chainId: number;
  /** How long to wait for a receipt before treating the outcome as UNKNOWN (never as failed). */
  receiptTimeoutMs?: number;
}

/** The EIP-3009 authorization, in the shape the token's calldata wants. */
export interface SettleAuthorization {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface SignedExecutorTx {
  rawTx: Hex;
  txHash: Hex;
}

/** Default receipt wait. Arc has sub-second blocks, so 60s is a long time to be wrong about. */
export const SETTLE_RECEIPT_TIMEOUT_MS = 60_000;

/**
 * Sign (but DO NOT SEND) the executor's `transferWithAuthorization`.
 *
 * The hash is computed from the serialized bytes rather than taken from a node, because there is
 * no node in this step yet: it is `keccak256` of exactly what will be broadcast, which is the
 * same value `sendRawTransaction` will return, and it is what the row records BEFORE the
 * broadcast so a crash leaves something to look up.
 */
export async function signSettleTx(
  deps: FormationExecutorDeps,
  auth: SettleAuthorization,
  signature: Hex,
): Promise<SignedExecutorTx> {
  const data = encodeFunctionData({
    abi: FIAT_TOKEN_ABI,
    functionName: "transferWithAuthorization",
    args: [
      auth.from,
      auth.to,
      auth.value,
      auth.validAfter,
      auth.validBefore,
      auth.nonce,
      signature,
    ],
  });
  return signExecutorTx(deps, data, TRANSFER_WITH_AUTHORIZATION_GAS);
}

/**
 * Sign (but do not send) the executor's `cancelAuthorization` — the guardian's fast path.
 *
 * The platform cannot cancel unilaterally: the token verifies a `CancelAuthorization` signature
 * from the AUTHORIZER. This submits what the guardian signed, and nothing else.
 */
export async function signCancelTx(
  deps: FormationExecutorDeps,
  authorizer: Address,
  nonce: Hex,
  signature: Hex,
): Promise<SignedExecutorTx> {
  const data = encodeFunctionData({
    abi: FIAT_TOKEN_ABI,
    functionName: "cancelAuthorization",
    args: [authorizer, nonce, signature],
  });
  return signExecutorTx(deps, data, CANCEL_AUTHORIZATION_GAS);
}

async function signExecutorTx(
  deps: FormationExecutorDeps,
  data: Hex,
  gas: bigint,
): Promise<SignedExecutorTx> {
  const account = deps.walletClient.account;
  if (!account) throw new Error("formation settle: the executor wallet client has no account");
  // `pending` so two settles in the same block do not sign the same nonce. The caller also holds
  // a per-company lock, but the executor is shared across companies, so the node is the authority.
  const nonce = await deps.publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const fees = await deps.publicClient.estimateFeesPerGas();
  const rawTx = (await deps.walletClient.signTransaction({
    account,
    chain: null,
    to: deps.usdc,
    data,
    // EXPLICIT (§6.4). Not because of the Arc estimate footgun — that one bites when the SENDER
    // pays gas in the token it is sending, and here the guardian sends while the executor pays —
    // but because an estimate is a round trip that can fail on the hot path of a payment the
    // guardian has already signed.
    gas,
    nonce,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    chainId: deps.chainId,
  })) as Hex;
  return { rawTx, txHash: keccak256(rawTx) };
}

/** The outcome of putting bytes on-chain, as the caller must treat it. */
export type BroadcastOutcome =
  | { kind: "settled"; txHash: Hex; gasUsed: bigint }
  | { kind: "reverted"; txHash: Hex }
  /** We do not know. NEVER a failure: the transaction may still be mined. */
  | { kind: "unknown"; reason: string };

/**
 * Broadcast persisted bytes and wait for the receipt.
 *
 * Idempotent by construction: re-sending the same signed transaction is either accepted as a
 * duplicate or rejected as already-known, and both mean "these exact bytes are already in
 * flight". So a node error on SEND is never a failure verdict — it collapses into waiting for the
 * receipt of the hash we already hold.
 *
 * A timeout is `unknown`, never `reverted`. The difference decides whether a guardian is charged
 * again: a row moved to `failed` on a timeout would be re-quoted, and the original transfer could
 * still land afterwards.
 */
export async function broadcastAndConfirm(
  deps: FormationExecutorDeps,
  tx: SignedExecutorTx,
): Promise<BroadcastOutcome> {
  try {
    await deps.publicClient.sendRawTransaction({ serializedTransaction: tx.rawTx });
  } catch (err) {
    // Swallowed on purpose — see above. If these bytes were genuinely never accepted, the receipt
    // wait below times out and the answer is `unknown`, which is the honest one.
    void err;
  }
  try {
    const receipt = await deps.publicClient.waitForTransactionReceipt({
      hash: tx.txHash,
      timeout: deps.receiptTimeoutMs ?? SETTLE_RECEIPT_TIMEOUT_MS,
    });
    return receipt.status === "success"
      ? { kind: "settled", txHash: tx.txHash, gasUsed: receipt.gasUsed }
      : { kind: "reverted", txHash: tx.txHash };
  } catch (err) {
    return { kind: "unknown", reason: (err as Error).message };
  }
}

/**
 * Was this authorization already used (or cancelled)?
 *
 * The one on-chain fact that can resolve a `settling` row whose broadcast outcome we never saw.
 * `true` means the nonce is spent — the transfer happened, or the guardian cancelled it — and
 * `false` means NOT YET USED, which is emphatically not "dead": the signature is still valid and
 * still self-authorizing until `validBefore`. That asymmetry is the whole of §6.4's rule 2.
 */
export async function authorizationUsed(
  deps: FormationExecutorDeps,
  authorizer: Address,
  nonce: Hex,
): Promise<boolean> {
  return readAuthorizationState(deps.publicClient, deps.usdc, authorizer, nonce);
}
