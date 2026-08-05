import { encodeFunctionData } from "viem";
import { iErc8183JobAbi } from "../abis/generated";
import type { SubmitAndConfirmOptions } from "../adapters/circle/circleExec";
import { CircleTxFailedError, submitAndConfirm } from "../adapters/circle/circleExec";
import type { CircleWalletsApi } from "../adapters/circle/circleWallets";
import type { JobOpAttempts } from "../persistence/jobOpAttempts";
import type { Address, Hex } from "../types";
import type { ProviderJobOps } from "./runJob";

/**
 * Circle-path ProviderJobOps (Tier-0 audit item 4): the provider-signed job steps sent by the
 * operator SCA through contractExecution instead of an enclave-backed viem wallet.
 *
 * Idempotency seeds are deterministic per (jobKey, step, attempt): a crash between Circle
 * accepting the submit and the job saga persisting its status makes the retry REPLAY the
 * original tx instead of firing a duplicate (Circle returns the original response for a reused
 * key) — while a terminal FAILED/DENIED bump of the persisted attempt (review finding H1)
 * derives a FRESH key, because the burned key would replay the failed response forever. The
 * sweep seed additionally carries the amount, so a later retry after balances moved never
 * replays a stale attempt.
 */
const erc20TransferAbi = [
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
] as const;

export function circleJobOps(p: {
  api: Pick<CircleWalletsApi, "createContractExecutionTransaction" | "getTransaction">;
  operatorWalletId: string;
  jobContract: Address;
  jobKey: string;
  /** Persisted per-(jobKey, step) attempt counters — the H1 key-burn escape hatch. */
  attempts: JobOpAttempts;
  confirm?: SubmitAndConfirmOptions;
  /** S5: Gas Station sponsorship observed from confirmed-tx fees (recorded, never checked). */
  outflows?: { record(path: "gas_sponsorship", amountAtomic: bigint, ref: string | null): void };
}): ProviderJobOps {
  const run = async (contractAddress: Address, callData: Hex, step: string): Promise<Hex> => {
    const attempt = p.attempts.get(p.jobKey, step);
    try {
      const { txHash } = await submitAndConfirm(
        p.api,
        {
          walletId: p.operatorWalletId,
          contractAddress,
          callData,
          idempotencySeed: `job:${p.jobKey}:${step}:${attempt}`,
          refId: `job:${p.jobKey}:${step}`,
        },
        {
          ...p.confirm,
          onNetworkFee: (fee, txId) => p.outflows?.record("gas_sponsorship", fee, txId),
        },
      );
      return txHash;
    } catch (e) {
      // Terminal Circle failure burned this attempt's idempotency key — bump so the NEXT retry
      // derives a fresh one instead of replaying the failed response forever.
      if (e instanceof CircleTxFailedError) p.attempts.bump(p.jobKey, step);
      throw e;
    }
  };

  return {
    setBudget: (jobId, amount) =>
      run(
        p.jobContract,
        encodeFunctionData({
          abi: iErc8183JobAbi,
          functionName: "setBudget",
          args: [jobId, amount, "0x"],
        }),
        "setBudget",
      ),
    submit: (jobId, deliverable) =>
      run(
        p.jobContract,
        encodeFunctionData({
          abi: iErc8183JobAbi,
          functionName: "submit",
          args: [jobId, deliverable, "0x"],
        }),
        "submit",
      ),
    sweepToTreasury: (usdc, treasury, amount) =>
      run(
        usdc,
        encodeFunctionData({
          abi: erc20TransferAbi,
          functionName: "transfer",
          args: [treasury, amount],
        }),
        `sweep:${amount}`,
      ),
  };
}
