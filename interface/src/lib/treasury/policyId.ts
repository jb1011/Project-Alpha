import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/** Matches AgentTreasury._policyId — used to track a scheduled policy change on-chain. */
export function computePolicyId(params: {
  newCap: bigint;
  newPeriod: bigint;
  allowlistOn: boolean;
  newPayout: Address;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "bool" },
        { type: "address" },
      ],
      [params.newCap, params.newPeriod, params.allowlistOn, params.newPayout],
    ),
  );
}
