// backend/src/adapters/x402/signX402.ts
import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION,
} from "@circle-fin/x402-batching";
import { BatchEvmScheme } from "@circle-fin/x402-batching/client";
import type { Address } from "../../types";
import type {
  BatchEvmSigner,
  SignX402,
  SignedAuthorization,
  SignedX402,
  X402Requirements,
} from "./types";

export interface SignX402Config {
  signer: BatchEvmSigner; // the pocket (per §4.1); the enclave for the large/critical tier later
  chainId: number;
  network: string; // "eip155:5042002"
  verifyingContract: Address; // GatewayWallet
}

interface X402Envelope {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { authorization: SignedAuthorization; signature: `0x${string}` };
}

/**
 * x402 wire-format codec: base64(JSON(envelope)).
 * Arc testnet ("eip155:5042002") is not in x402's SupportedEVMNetworks whitelist, so we bypass
 * the upstream encodePayment/decodePayment which throw "Invalid network" for unknown chains.
 * This is the documented fallback format — the seller side must use the same codec (see 2D).
 */
function safeBase64Encode(data: string): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.btoa === "function") {
    return globalThis.btoa(data);
  }
  return Buffer.from(data).toString("base64");
}

function safeBase64Decode(data: string): string {
  if (typeof globalThis !== "undefined" && typeof globalThis.atob === "function") {
    return globalThis.atob(data);
  }
  return Buffer.from(data, "base64").toString("utf-8");
}

/** Encode an X-PAYMENT envelope into the x402 wire format (base64 JSON). */
function encodeX402Header(env: X402Envelope): string {
  return safeBase64Encode(JSON.stringify(env));
}

/** Decode an X-PAYMENT header back into its envelope (used by the seller + tests). */
export function decodeX402Header(header: string): X402Envelope {
  return JSON.parse(safeBase64Decode(header)) as X402Envelope;
}

/** Build the concrete signX402 seam from a signer + per-chain batching config. */
export function makeSignX402(cfg: SignX402Config): SignX402 {
  const expectedNetwork = `eip155:${cfg.chainId}`;
  if (cfg.network !== expectedNetwork) {
    throw new Error(
      `signX402 config mismatch: network "${cfg.network}" does not match chainId ${cfg.chainId} (expected "${expectedNetwork}")`,
    );
  }
  const scheme = new BatchEvmScheme(cfg.signer);
  return async (req: X402Requirements): Promise<SignedX402> => {
    const requirements = {
      scheme: CIRCLE_BATCHING_SCHEME,
      network: cfg.network,
      asset: req.asset,
      amount: req.amount.toString(),
      payTo: req.payTo,
      maxTimeoutSeconds: req.maxTimeoutSeconds,
      extra: {
        name: CIRCLE_BATCHING_NAME,
        version: CIRCLE_BATCHING_VERSION,
        verifyingContract: cfg.verifyingContract,
      },
    };
    const { payload } = await scheme.createPaymentPayload(1, requirements);
    const authorization = payload.authorization as SignedAuthorization;
    const signature = payload.signature as `0x${string}`;
    const env: X402Envelope = {
      x402Version: 1,
      scheme: CIRCLE_BATCHING_SCHEME,
      network: cfg.network,
      payload: { authorization, signature },
    };
    return {
      header: encodeX402Header(env),
      authorization,
      signature,
      ledgerRef: authorization.nonce,
    };
  };
}
