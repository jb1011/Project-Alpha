import { encodeFunctionData } from "viem";
import { iErc8183JobAbi } from "../abis/generated";
import type { SubmitAndConfirmOptions } from "../adapters/circle/circleExec";
import { submitAndConfirm } from "../adapters/circle/circleExec";
import type { CircleWalletsApi } from "../adapters/circle/circleWallets";
import type { Address, Hex } from "../types";
import type { ProviderJobOps } from "./runJob";

/**
 * Circle-path ProviderJobOps (Tier-0 audit item 4): the provider-signed job steps sent by the
 * operator SCA through contractExecution instead of an enclave-backed viem wallet.
 *
 * Idempotency seeds are deterministic per (jobKey, step): a crash between Circle accepting the
 * submit and the job saga persisting its status makes the retry REPLAY the original tx instead of
 * firing a duplicate (Circle returns the original response for a reused key). The sweep seed also
 * carries the amount — sweep amounts are balance-dependent, so a later retry after balances moved
 * derives a fresh key instead of replaying a stale (possibly FAILED) attempt.
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
  confirm?: SubmitAndConfirmOptions;
  /** S5: Gas Station sponsorship observed from confirmed-tx fees (recorded, never checked). */
  outflows?: { record(path: "gas_sponsorship", amountAtomic: bigint, ref: string | null): void };
}): ProviderJobOps {
  const run = async (contractAddress: Address, callData: Hex, step: string): Promise<Hex> => {
    const { txHash } = await submitAndConfirm(
      p.api,
      {
        walletId: p.operatorWalletId,
        contractAddress,
        callData,
        idempotencySeed: `job:${p.jobKey}:${step}`,
        refId: `job:${p.jobKey}:${step}`,
      },
      {
        ...p.confirm,
        onNetworkFee: (fee, txId) => p.outflows?.record("gas_sponsorship", fee, txId),
      },
    );
    return txHash;
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
