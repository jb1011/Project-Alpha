// backend/src/adapters/x402/types.ts
import type { Address, Hex } from "../../types";

/** A `BatchEvmSigner` as Circle's BatchEvmScheme expects it: an address + an EIP-712 typed-data signer.
 *  Both a local pocket key and the Turnkey enclave signer satisfy this shape. */
export interface BatchEvmSigner {
  address: Address;
  signTypedData: (params: {
    domain: unknown;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<Hex>;
}

/** The x402 PaymentRequirements we need to build a batching authorization (subset of the 402 body). */
export interface X402Requirements {
  payTo: Address; // recipient (== the policy payee)
  amount: bigint; // atomic USDC (6 decimals)
  asset: Address; // USDC token address
  network: string; // "eip155:5042002"
  maxTimeoutSeconds: number;
}

export interface SignedAuthorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

/** What a signer returns: the encoded X-PAYMENT header + the raw authorization for the ledger/audit. */
export interface SignedX402 {
  header: string; // base64 X-PAYMENT envelope
  authorization: SignedAuthorization;
  signature: Hex;
  ledgerRef: string; // the authorization nonce, used to reconcile settlement back to the ledger
}

/** The seam: given requirements, produce a signed X-PAYMENT. The concrete impl closes over a signer +
 *  the per-chain batching config (verifyingContract etc). */
export type SignX402 = (req: X402Requirements) => Promise<SignedX402>;
