import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION,
} from "@circle-fin/x402-batching";
import { Hono } from "hono";
import { getAddress, verifyTypedData } from "viem";
import { evm } from "x402/types";
import { arcBatchingConfig } from "../adapters/x402/pocket";
import { decodeX402Header } from "../adapters/x402/signX402";
import type { Address } from "../types";
import type { SettleFn } from "./settle";

export interface SellerConfig {
  price: bigint; // atomic USDC the agent charges per query
  payTo: Address; // the treasury payout address — revenue lands governed
  asset: Address;
  network: string;
}

/** The 402 body a buyer receives. payTo = treasury payout, so the agent's earnings stay on-chain governed. */
export function buildRequirements(cfg: SellerConfig) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: CIRCLE_BATCHING_SCHEME,
        network: cfg.network,
        asset: cfg.asset,
        payTo: cfg.payTo,
        maxAmountRequired: cfg.price.toString(),
        maxTimeoutSeconds: 60,
      },
    ],
  };
}

export type VerifyResult = { ok: true; nonce: `0x${string}` } | { ok: false; reason: string };

/**
 * Verify an inbound X-PAYMENT against this seller's requirements.
 *
 * Uses the self-verify fallback: decode via decodeX402Header (manual base64 codec that bypasses
 * the upstream encodePayment/decodePayment which throw "Invalid network" for Arc's eip155:5042002),
 * then check recipient, amount, and expiry. BatchFacilitatorClient.verify from @circle-fin/x402-batching/server
 * makes a remote HTTP call to Circle's Gateway API (requires Circle API key + network), so the
 * structural self-verify is the correct local path.
 */
export async function verifyPayment(header: string, cfg: SellerConfig): Promise<VerifyResult> {
  let env: ReturnType<typeof decodeX402Header>;
  try {
    env = decodeX402Header(header);
  } catch {
    return { ok: false, reason: "malformed X-PAYMENT" };
  }
  const a = env.payload.authorization;
  if (a.to.toLowerCase() !== cfg.payTo.toLowerCase()) {
    return { ok: false, reason: "wrong recipient" };
  }
  if (BigInt(a.value) < cfg.price) {
    return { ok: false, reason: "underpriced" };
  }
  if (BigInt(a.validBefore) <= BigInt(Math.floor(Date.now() / 1000))) {
    return { ok: false, reason: "expired" };
  }
  const chainId = Number(cfg.network.split(":")[1]); // "eip155:5042002" -> 5042002
  let recovered: boolean;
  try {
    recovered = await verifyTypedData({
      address: getAddress(a.from),
      domain: {
        name: CIRCLE_BATCHING_NAME,
        version: CIRCLE_BATCHING_VERSION,
        chainId,
        verifyingContract: arcBatchingConfig.verifyingContract,
      },
      types: evm.authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(a.from),
        to: getAddress(a.to),
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      },
      signature: env.payload.signature,
    });
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  if (!recovered) return { ok: false, reason: "bad-signature" };
  return { ok: true, nonce: a.nonce as `0x${string}` };
}

export interface PaywallConfig extends SellerConfig {
  serve: (req: Request) => unknown | Promise<unknown>;
  resource?: string; // default "/api/insight"
  settle?: SettleFn; // when set, settle the verified payment before serving
  resourceUrl?: string; // the resource URL recorded in the settle payload
}

/** A paywalled Hono sub-app: 402 -> verify X-PAYMENT -> serve. */
export function buildPaywall(cfg: PaywallConfig) {
  const app = new Hono();
  const path = cfg.resource ?? "/api/insight";
  // In-memory/per-process replay guard: tracks seen authorization nonces.
  // A durable SQLite-backed seen-nonce store is the production follow-up.
  const seen = new Set<string>();
  app.get(path, async (c) => {
    const header = c.req.header("X-PAYMENT");
    if (!header) return c.json(buildRequirements(cfg), 402);
    const v = await verifyPayment(header, cfg);
    if (!v.ok) return c.json({ ...buildRequirements(cfg), error: v.reason }, 402);
    if (seen.has(v.nonce)) return c.json({ ...buildRequirements(cfg), error: "replay" }, 402);
    seen.add(v.nonce);
    if (cfg.settle) {
      const r = await cfg.settle(header, {
        scheme: CIRCLE_BATCHING_SCHEME,
        network: cfg.network,
        asset: cfg.asset,
        amount: cfg.price.toString(),
        payTo: cfg.payTo,
        maxTimeoutSeconds: 60,
        extra: {
          name: CIRCLE_BATCHING_NAME,
          version: CIRCLE_BATCHING_VERSION,
          verifyingContract: arcBatchingConfig.verifyingContract,
        },
        resourceUrl: cfg.resourceUrl ?? cfg.resource ?? "/api/insight",
      });
      if (!r.ok)
        return c.json({ ...buildRequirements(cfg), error: `settle-failed:${r.reason ?? ""}` }, 402);
      if (r.transferId) c.header("X-PAYMENT-RESPONSE", r.transferId);
    }
    return c.json((await cfg.serve(c.req.raw)) as Record<string, unknown>, 200);
  });
  return app;
}
