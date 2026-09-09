import { encodeFunctionData, keccak256 } from "viem";
import type { PublicClient, WalletClient } from "viem";
import { CANCEL_AUTHORIZATION_GAS, TRANSFER_WITH_AUTHORIZATION_GAS } from "../adapters/arc/gas";
import { FIAT_TOKEN_ABI, readAuthorizationState } from "../adapters/arc/usdcToken";
import type { Address, Hex } from "../types";

/**
 * The EXECUTOR side of a formation payment (design 2026-08-26 §6.4, amended by the B1 gate).
 *
 * The guardian signs an EIP-3009 authorization; nobody's money moves until somebody puts it
 * on-chain, and that somebody is us — the dedicated SETTLE SUBMITTER, paying the gas, which on
 * Arc is USDC cents.
 *
 * ── THE DURABLE ARTIFACT IS THE AUTHORIZATION, NOT A TRANSACTION ───────────────────────────────
 *
 * The first cut of this module signed the executor transaction, handed its bytes back to be
 * persisted, and re-broadcast THOSE bytes on resume. That is the bridge-legs rule, and it is the
 * wrong rule here: a signed transaction commits to an EXECUTOR NONCE, and a nonce that another
 * transaction consumes while we are down makes the persisted bytes permanently unsendable
 * ("nonce too low"). The payment would then sit `settling` until its window closed, for a reason
 * that has nothing to do with the guardian.
 *
 * The guardian's AUTHORIZATION has no nonce of ours in it. So it is what we persist, and every
 * broadcast — the first and each resume — COMPOSES A FRESH transaction around it: the current
 * pending nonce, the current fees, a fee bump per re-broadcast. Exactly-once is not ours to
 * enforce and never was: the token retires the (authorizer, nonce) pair on first use, so a second
 * transaction carrying the same authorization reverts rather than transferring twice.
 */

export interface FormationExecutorDeps {
  publicClient: PublicClient;
  /** The DEDICATED SETTLE SUBMITTER (`FORMATION_SETTLE_SUBMITTER_KEY`) — its own EOA, its own
   *  nonce space, its own USDC gas balance, no governance authority. It signs and pays the gas;
   *  it is NOT the token sender. */
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

/**
 * Default receipt wait. Arc has sub-second blocks, so this is a long time to be wrong about —
 * and being wrong is cheap now: an unresolved broadcast is resolved by the token's own logs on
 * the next sweeper pass, not by our patience here. Callers on a human's hot path pass less.
 */
export const SETTLE_RECEIPT_TIMEOUT_MS = 60_000;

/** The outcome of putting a transaction on-chain, as the caller must treat it. */
export type BroadcastOutcome =
  | { kind: "settled"; txHash: Hex; gasUsed: bigint }
  | { kind: "reverted"; txHash: Hex }
  /** We do not know. NEVER a failure: the transaction may still be mined, and the authorization
   *  may be settled by somebody else entirely. */
  | { kind: "unknown"; reason: string; txHash?: Hex };

export interface BroadcastOptions {
  /**
   * How many times this authorization has already been broadcast. Each one bumps the fee, because
   * a previous transaction may still be sitting in the mempool under the same account nonce, and
   * a replacement at the same price is simply rejected.
   */
  bumps?: number;
  /** Called with the hash of the bytes about to go out, BEFORE they go out, so the caller can
   *  record what it is waiting on. */
  onBroadcast?: (txHash: Hex) => void;
}

/** Fee bump for re-broadcast n: +25% each, capped so a long-stalled row cannot walk the price up
 *  without bound. 12.5% is the protocol minimum for a replacement; 25% is one that lands. */
export function bumpedFee(fee: bigint, bumps: number): bigint {
  const n = BigInt(Math.max(0, Math.min(bumps, 8)));
  return (fee * (4n + n)) / 4n;
}

/**
 * Submit `transferWithAuthorization` — the whole settle, composed fresh.
 *
 * Nothing about the transaction is persisted or reused: the nonce, the fees and therefore the
 * hash are all of THIS attempt. What is reused is the guardian's signature, which is what the
 * token verifies.
 */
export async function submitTransferWithAuthorization(
  deps: FormationExecutorDeps,
  auth: SettleAuthorization,
  signature: Hex,
  opts: BroadcastOptions = {},
): Promise<BroadcastOutcome> {
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
  return composeAndSend(deps, data, TRANSFER_WITH_AUTHORIZATION_GAS, opts);
}

/**
 * Submit `cancelAuthorization` — the guardian's fast path.
 *
 * The platform cannot cancel unilaterally: the token verifies a `CancelAuthorization` signature
 * from the AUTHORIZER. This submits what the guardian signed, and nothing else.
 */
export async function submitCancelAuthorization(
  deps: FormationExecutorDeps,
  authorizer: Address,
  nonce: Hex,
  signature: Hex,
  opts: BroadcastOptions = {},
): Promise<BroadcastOutcome> {
  const data = encodeFunctionData({
    abi: FIAT_TOKEN_ABI,
    functionName: "cancelAuthorization",
    args: [authorizer, nonce, signature],
  });
  return composeAndSend(deps, data, CANCEL_AUTHORIZATION_GAS, opts);
}

/**
 * Compose, sign, announce, send, wait.
 *
 * The announce step (`onBroadcast`) sits between signing and sending deliberately: it is the last
 * moment at which the caller can record the hash it is about to be waiting on, and a hash written
 * after the send would be missing from exactly the crash that makes it useful.
 *
 * A send error is swallowed. Re-sending a transaction the node already knows, or losing a race
 * with our own earlier attempt, are both "these bytes are already in flight" — and if they were
 * genuinely never accepted the receipt wait below answers `unknown`, which is the honest verdict
 * and the one the log-based resolver picks up from.
 */
async function composeAndSend(
  deps: FormationExecutorDeps,
  data: Hex,
  gas: bigint,
  opts: BroadcastOptions,
): Promise<BroadcastOutcome> {
  const account = deps.walletClient.account;
  if (!account) throw new Error("formation settle: the submitter wallet client has no account");
  // `pending` so two settles in the same block do not sign the same nonce. The caller also holds
  // a per-company lock, but the submitter is shared across companies, so the node is the
  // authority — and the submitter is DEDICATED, so nothing else on this box moves that nonce.
  const nonce = await deps.publicClient.getTransactionCount({
    address: account.address,
    blockTag: "pending",
  });
  const fees = await deps.publicClient.estimateFeesPerGas();
  const bumps = opts.bumps ?? 0;
  const rawTx = (await deps.walletClient.signTransaction({
    account,
    chain: null,
    to: deps.usdc,
    data,
    // EXPLICIT (§6.4). Not because of the Arc estimate footgun — that one bites when the SENDER
    // pays gas in the token it is sending, and here the guardian sends while the submitter pays —
    // but because an estimate is a round trip that can fail, on the hot path of a payment the
    // guardian has already signed.
    gas,
    nonce,
    maxFeePerGas: bumpedFee(fees.maxFeePerGas, bumps),
    maxPriorityFeePerGas: bumpedFee(fees.maxPriorityFeePerGas ?? 0n, bumps),
    chainId: deps.chainId,
  })) as Hex;
  // keccak256 of exactly what goes out — the same value `sendRawTransaction` returns, computed
  // without a node so it is available BEFORE the send.
  const txHash = keccak256(rawTx);
  opts.onBroadcast?.(txHash);
  try {
    await deps.publicClient.sendRawTransaction({ serializedTransaction: rawTx });
  } catch (err) {
    void err;
  }
  try {
    const receipt = await deps.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: deps.receiptTimeoutMs ?? SETTLE_RECEIPT_TIMEOUT_MS,
    });
    return receipt.status === "success"
      ? { kind: "settled", txHash, gasUsed: receipt.gasUsed }
      : { kind: "reverted", txHash };
  } catch (err) {
    return { kind: "unknown", reason: (err as Error).message, txHash };
  }
}

/**
 * Was this authorization already used (or cancelled)?
 *
 * `true` means the nonce is spent — the transfer happened, or it was cancelled — and `false`
 * means NOT YET USED, which is emphatically not "dead": the signature is still valid and still
 * self-authorizing until `validBefore`. That asymmetry is the whole of §6.4's rule 2. WHICH of
 * the two a `true` means is a question for the token's logs (`resolveAuthorizationOutcome`), not
 * for this call.
 */
export async function authorizationUsed(
  deps: FormationExecutorDeps,
  authorizer: Address,
  nonce: Hex,
): Promise<boolean> {
  return readAuthorizationState(deps.publicClient, deps.usdc, authorizer, nonce);
}

/**
 * Wait for the receipt of a hash we already broadcast — WITHOUT sending anything.
 *
 * The resume leg's use for it: an authorization whose nonce the token reports as SPENT must never
 * be re-broadcast (the second transaction would revert, and a revert on a spent nonce says
 * nothing about where the money went). Reading the receipt of what we last sent is the cheap way
 * to learn that our own transfer is what spent it.
 */
export async function confirmBroadcast(
  deps: FormationExecutorDeps,
  txHash: Hex,
): Promise<BroadcastOutcome> {
  try {
    const receipt = await deps.publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: deps.receiptTimeoutMs ?? SETTLE_RECEIPT_TIMEOUT_MS,
    });
    return receipt.status === "success"
      ? { kind: "settled", txHash, gasUsed: receipt.gasUsed }
      : { kind: "reverted", txHash };
  } catch (err) {
    return { kind: "unknown", reason: (err as Error).message, txHash };
  }
}
