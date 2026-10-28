import { type Address, type Hex, encodeAbiParameters, keccak256 } from "viem";

/**
 * `AgentTreasury._policyId`: `keccak256(abi.encode(cap, period, allowlistOn, payout))`.
 *
 * The id the treasury keys a scheduled change by, and the one the guardian vetoes or the manager
 * executes. The interface computes the same id (`interface/src/lib/treasury/policyId.ts`); a test
 * in each package pins one vector computed with `cast`.
 */
export function computePolicyId(p: {
  cap: bigint;
  period: bigint;
  allowlistOn: boolean;
  payout: Address;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "address" }],
      [p.cap, p.period, p.allowlistOn, p.payout],
    ),
  );
}
