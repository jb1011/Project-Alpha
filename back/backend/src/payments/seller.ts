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
import {
  type AgentkitSellerConfig,
  mintAgentkitExtension,
  verifyAgentkitRequest,
} from "./worldVerifier";

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
  /** Optional World AgentKit gate: authorize human-backed agents before requiring payment.
   *  Absent -> the paywall behaves exactly as before. */
  agentkit?: AgentkitSellerConfig;
  /** Whom this seller trades with. "open" (default) = today's behavior. "accountable-only" =
   *  agents no verified human answers for are REFUSED (403) — their payment is not wanted;
   *  human-backed agents proceed to the normal payment path. Requires `agentkit`. */
  trustPolicy?: "open" | "accountable-only";
}

/** A paywalled Hono sub-app: [agentkit authorization] -> 402 -> verify X-PAYMENT -> serve. */
export function buildPaywall(cfg: PaywallConfig) {
  const app = new Hono();
  const path = cfg.resource ?? "/api/insight";
  // In-memory/per-process replay guard: tracks seen authorization nonces.
  // A durable SQLite-backed seen-nonce store is the production follow-up.
  const seen = new Set<string>();

  /** 402 body, plus the hand-minted agentkit extension when the World gate is configured.
   *  `extensions` sits top-level next to `accepts`; the client only reads extensions.agentkit. */
  const challenge = () =>
    cfg.agentkit
      ? { ...buildRequirements(cfg), extensions: mintAgentkitExtension(cfg.agentkit) }
      : buildRequirements(cfg);

  const strict = cfg.trustPolicy === "accountable-only" && !!cfg.agentkit;

  /** Strict refusal: a doorway, not a wall. 403 (never 402 — payment would not help), with the
   *  remediation AND the standard challenge, so a capable agent can fix its situation from the
   *  refusal alone. */
  const refusal = (reason: string) => ({
    error: "human_backing_required",
    detail: "this seller trades only with agents a verified unique human answers for",
    reason,
    how: {
      register: "npx @worldcoin/agentkit-cli register <your-agent-address>",
      agentBook: cfg.agentkit?.agentBookAddress ?? "0xA23aB2712eA7BBa896930544C7d6636a96b944dA",
      chain: "world-chain",
    },
    // Safe: `strict` (checked by every caller) implies cfg.agentkit is present.
    extensions: mintAgentkitExtension(cfg.agentkit as AgentkitSellerConfig),
  });

  app.get(path, async (c) => {
    const akHeader = c.req.header("agentkit");

    // ── accountable-only: accountability is a PRECONDITION of commerce ──────────────────────
    // No valid proof of a human backer -> refused outright; their money is not wanted (403,
    // never 402). A valid proof unlocks the RIGHT TO BUY: flow continues into the normal x402
    // path below — everyone pays. The per-human counter acts as a rate cap (429), not a free
    // allowance: one human backing fifty agents still gets one budget.
    if (strict) {
      if (!akHeader) return c.json(refusal("no-proof-presented"), 403);
      const outcome = await verifyAgentkitRequest(akHeader, cfg.agentkit as AgentkitSellerConfig);
      if (!outcome.authorized) {
        if (outcome.reason === "allowance-exhausted") {
          if (outcome.humanId) c.header("X-AGENTKIT-HUMAN", outcome.humanId);
          return c.json(
            { error: "rate-capped", detail: "per-human request budget exhausted for this window" },
            429,
          );
        }
        return c.json(refusal(outcome.reason ?? "unverified"), 403);
      }
      c.header("X-AGENTKIT-HUMAN", outcome.humanId);
      c.header("X-AGENTKIT-AUTHORIZATION", `${outcome.used}/${outcome.limit}`);
      // fall through to payment — accountability grants no discount
    }

    // World gate FIRST (open mode): an agent proving it is backed by a verified unique human may
    // be authorized to act within its per-human allowance. Beyond that (or on any failure) it
    // falls through to the normal governed-payment path below — fail-closed by construction.
    if (!strict && akHeader && cfg.agentkit) {
      const outcome = await verifyAgentkitRequest(akHeader, cfg.agentkit);
      if (outcome.authorized) {
        c.header("X-AGENTKIT-HUMAN", outcome.humanId);
        c.header("X-AGENTKIT-AUTHORIZATION", `${outcome.used}/${outcome.limit}`);
        const body = (await cfg.serve(c.req.raw)) as Record<string, unknown>;
        return c.json(
          {
            ...body,
            humanBacked: true,
            authorization: { used: outcome.used, limit: outcome.limit },
          },
          200,
        );
      }
      c.header("X-AGENTKIT-REASON", outcome.reason);
    }

    const header = c.req.header("X-PAYMENT");
    if (!header) return c.json(challenge(), 402);
    const v = await verifyPayment(header, cfg);
    if (!v.ok) return c.json({ ...challenge(), error: v.reason }, 402);
    if (seen.has(v.nonce)) return c.json({ ...challenge(), error: "replay" }, 402);
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
      if (!r.ok) return c.json({ ...challenge(), error: `settle-failed:${r.reason ?? ""}` }, 402);
      if (r.transferId) c.header("X-PAYMENT-RESPONSE", r.transferId);
    }
    const served = (await cfg.serve(c.req.raw)) as Record<string, unknown>;
    // In strict mode the buyer proved a human backer before paying — say so on the receipt.
    return c.json(strict ? { ...served, humanBacked: true } : served, 200);
  });
  return app;
}
