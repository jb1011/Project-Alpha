// backend/src/adapters/x402/pocket.ts
import { CHAIN_CONFIGS } from "@circle-fin/x402-batching/client";
import type { Hex, TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "../../types";
import type { BatchEvmSigner } from "./types";

/** EIP712Domain must be declared explicitly for the Turnkey path; harmless for local accounts. */
const EIP712Domain = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

/** Wrap any object exposing `{ address, signTypedData }` so EIP712Domain is always injected. */
export function asBatchEvmSigner(inner: {
  address: Address;
  signTypedData: (td: TypedDataDefinition) => Promise<Hex>;
}): BatchEvmSigner {
  return {
    address: inner.address,
    signTypedData: (params) =>
      inner.signTypedData({
        ...params,
        types: { EIP712Domain, ...params.types },
      } as TypedDataDefinition),
  };
}

/** The pocket hot-key as a BatchEvmSigner (free to sign — never touches the enclave). */
export function pocketSignerFromKey(privateKey: Hex): BatchEvmSigner {
  const account = privateKeyToAccount(privateKey);
  return asBatchEvmSigner({
    address: account.address,
    signTypedData: (td) => account.signTypedData(td),
  });
}

/** Per-chain Circle batching constants for Arc testnet (verifyingContract = GatewayWallet, NOT USDC). */
export const arcBatchingConfig = {
  network: "eip155:5042002" as const,
  asset: CHAIN_CONFIGS.arcTestnet.usdc as Address,
  verifyingContract: CHAIN_CONFIGS.arcTestnet.gatewayWallet as Address,
};
