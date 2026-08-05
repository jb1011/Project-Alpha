import { createHash } from "node:crypto";
import type { Hex } from "../../types";
import type { CircleWalletsApi } from "./circleWallets";

/**
 * Tier-0 Circle contract-execution helper (spec 2026-08-03, audit item 3).
 *
 * Circle's transaction model is ASYNC: createContractExecutionTransaction returns a tx-id
 * immediately; the on-chain hash only exists once the transaction confirms. So every on-chain
 * action on the circle path is submit → poll getTransaction → terminal state, with:
 *
 * - DETERMINISTIC idempotency keys (UUID-v4-shaped, derived from a stable seed): Circle replays
 *   the original response for a reused key, which makes crash-retry safe — a re-submit after a
 *   crash returns the ORIGINAL tx instead of firing a second one. The caller owns the seed
 *   (bridgeKey:leg:attempt for funding, job:jobKey:step for job ops).
 * - HARD poll timeouts: the caller usually holds the per-entity keyed lock, so an unbounded poll
 *   would wedge the whole entity's mutex chain (audit item 6).
 * - Terminal-state handling: FAILED / DENIED / CANCELLED throw a CircleTxFailedError naming the
 *   state — the failed tx's idempotency key is burned, so retries must derive a fresh key.
 */

/** UUID-v4-SHAPED but fully deterministic: sha256(seed) with the version/variant bits forced.
 *  Circle requires UUID format; the spec requires determinism per bridge leg. Both hold. */
export function deterministicIdempotencyKey(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  const bytes = h.slice(0, 32).split("");
  bytes[12] = "4"; // version nibble
  bytes[16] = ((Number.parseInt(bytes[16]!, 16) & 0x3) | 0x8).toString(16); // variant 10xx
  const s = bytes.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

export class CircleTxFailedError extends Error {
  constructor(
    readonly circleTxId: string,
    readonly state: string,
    detail?: string,
  ) {
    super(`circle tx ${circleTxId} reached terminal state ${state}${detail ? `: ${detail}` : ""}`);
    this.name = "CircleTxFailedError";
  }
}

export class CircleTxTimeoutError extends Error {
  constructor(
    readonly circleTxId: string,
    timeoutMs: number,
  ) {
    super(
      `circle tx ${circleTxId} not confirmed within ${timeoutMs}ms — still in flight; retry resumes it`,
    );
    this.name = "CircleTxTimeoutError";
  }
}

const SUCCESS_STATES = new Set(["CONFIRMED", "COMPLETE"]);
const FAILURE_STATES = new Set(["FAILED", "DENIED", "CANCELLED"]);

export interface SubmitAndConfirmInput {
  walletId: string;
  contractAddress: string;
  /** viem encodeFunctionData output — exact calldata, no ABI-string re-encoding ambiguity. */
  callData: Hex;
  /** Stable seed for the deterministic idempotency key (NOT the key itself). */
  idempotencySeed: string;
  refId?: string;
}

export interface SubmitAndConfirmOptions {
  pollDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called once the tx confirms, with the network fee in 6-dec atomic USDC (Arc gas IS USDC) —
   *  the S5 gas_sponsorship observation hook. Observe-never-gate: errors are swallowed. */
  onNetworkFee?: (feeAtomic: bigint, circleTxId: string) => void;
}

const DEFAULT_POLL_DELAY_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Bound ONE HTTP call by a real wall-clock deadline (review finding M1): the poll loop's
 *  deadline check only runs BETWEEN calls, so a hung Circle API call (dropped TCP, no RST) would
 *  otherwise wedge the caller — which usually holds the per-entity keyed lock — forever. Uses a
 *  real timer deliberately (not the injectable test sleep): an instantly-resolving fake sleep
 *  must not fake-timeout instantly-resolving fake API calls. */
function withCallDeadline<T>(work: Promise<T>, ms: number, err: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(err()), Math.max(ms, 1));
    (t as { unref?: () => void }).unref?.();
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Poll an ALREADY-SUBMITTED Circle tx to a terminal state (review finding M2: a resumed saga leg
 *  that carries its circle_tx_id polls it directly instead of re-submitting — no reliance on
 *  Circle's idempotency-replay retention for the no-double-send guarantee). */
export async function confirmTransaction(
  api: Pick<CircleWalletsApi, "getTransaction">,
  circleTxId: string,
  opts: SubmitAndConfirmOptions = {},
): Promise<{ circleTxId: string; txHash: Hex }> {
  const pollDelayMs = opts.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  for (;;) {
    const remaining = deadline - now();
    const tx = (
      await withCallDeadline(
        api.getTransaction({ id: circleTxId }),
        remaining,
        () => new CircleTxTimeoutError(circleTxId, timeoutMs),
      )
    ).data?.transaction;
    const state = tx?.state ?? "UNKNOWN";
    if (SUCCESS_STATES.has(state)) {
      if (!tx?.txHash) throw new Error(`circle tx ${circleTxId} is ${state} but carries no txHash`);
      if (opts.onNetworkFee && tx.networkFee) {
        try {
          // networkFee is a decimal USDC string on Arc (native gas IS USDC) → 6-dec atomic.
          opts.onNetworkFee(BigInt(Math.round(Number(tx.networkFee) * 1e6)), circleTxId);
        } catch {
          // observe, never gate
        }
      }
      return { circleTxId, txHash: tx.txHash as Hex };
    }
    if (FAILURE_STATES.has(state)) {
      throw new CircleTxFailedError(circleTxId, state, tx?.errorReason);
    }
    if (now() >= deadline) throw new CircleTxTimeoutError(circleTxId, timeoutMs);
    await sleep(pollDelayMs);
  }
}

/** Submit one contract execution and poll it to confirmation. Returns the Circle tx-id and the
 *  real on-chain hash. Throws CircleTxFailedError (terminal) or CircleTxTimeoutError (in flight —
 *  the deterministic idempotency key makes a later retry resume THIS tx, not fire a new one). */
export async function submitAndConfirm(
  api: Pick<CircleWalletsApi, "createContractExecutionTransaction" | "getTransaction">,
  input: SubmitAndConfirmInput,
  opts: SubmitAndConfirmOptions = {},
): Promise<{ circleTxId: string; txHash: Hex }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await withCallDeadline(
    api.createContractExecutionTransaction({
      walletId: input.walletId,
      contractAddress: input.contractAddress,
      callData: input.callData,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      idempotencyKey: deterministicIdempotencyKey(input.idempotencySeed),
      refId: input.refId,
    }),
    timeoutMs,
    () =>
      new Error(
        `circle createContractExecutionTransaction timed out after ${timeoutMs}ms — safe to retry (deterministic idempotency key replays)`,
      ),
  );
  const circleTxId = res.data?.id;
  if (!circleTxId)
    throw new Error(
      `circle createContractExecutionTransaction returned no tx id (contract ${input.contractAddress})`,
    );

  return confirmTransaction(api, circleTxId, opts);
}
