import type { Hono } from "hono";
import type { Config } from "../../config/env";
import { buildPaywall } from "../../payments/seller";
import { makeSettle } from "../../payments/settle";
import { usdToUnits } from "../../policy/units";
import type { Address } from "../../types";

/** Everything the demo seller route needs, resolved from config. */
export interface X402DemoDeps {
  payTo: Address; // where the 0.01 USDC settles (a demo address we control)
  asset: Address; // USDC on Arc
  network: string; // "eip155:5042002"
  price: bigint; // atomic USDC (6 decimals)
  facilitatorUrl: string; // Circle Gateway facilitator (settle)
  resourceUrl: string; // public URL recorded in the settle payload
}

/**
 * Resolve the demo-seller deps from config, or `undefined` when the flag is off.
 * Only reads the fields it needs so it stays trivially unit-testable.
 */
export function buildX402DemoDeps(
  cfg: Pick<
    Config,
    | "enableX402Demo"
    | "x402DemoPayTo"
    | "usdc"
    | "chainId"
    | "x402DemoPriceUsdc"
    | "gatewayFacilitatorUrl"
    | "metadataBaseUrl"
  >,
): X402DemoDeps | undefined {
  if (!cfg.enableX402Demo) return undefined;
  return {
    payTo: cfg.x402DemoPayTo,
    asset: cfg.usdc,
    network: `eip155:${cfg.chainId}`,
    price: usdToUnits(cfg.x402DemoPriceUsdc),
    facilitatorUrl: cfg.gatewayFacilitatorUrl,
    resourceUrl: `${cfg.metadataBaseUrl}/x402-demo/quote`,
  };
}

/**
 * Mount the flag-gated public x402 demo seller at GET /x402-demo/quote.
 * Reuses buildPaywall: no header -> 402; valid X-PAYMENT -> self-verify -> settle
 * via Circle's facilitator -> serve a trivial static quote.
 */
export function mountX402DemoRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: intentional — env-agnostic (bare Hono in tests, AuthVars-typed app in prod), mirrors mountSchemaRoutes
  app: Hono<any>,
  deps: X402DemoDeps,
): void {
  const settle = makeSettle({ facilitatorUrl: deps.facilitatorUrl });
  const paywall = buildPaywall({
    price: deps.price,
    payTo: deps.payTo,
    asset: deps.asset,
    network: deps.network,
    resource: "/x402-demo/quote",
    resourceUrl: deps.resourceUrl,
    settle,
    serve: () => ({ quote: "BYOA x402 demo quote", resource: "/x402-demo/quote" }),
  });
  app.route("/", paywall);
}
