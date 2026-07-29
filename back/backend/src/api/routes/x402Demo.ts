import type { Hono } from "hono";
import { agentkitSignerFromKey } from "../../adapters/worldid/agentkitSigner";
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
  /** Optional World AgentKit gate (human-backed agent authorization). Absent -> unchanged. */
  agentkit?: import("../../payments/worldVerifier").AgentkitSellerConfig;
  /** Seller trust policy ("open" default; "accountable-only" refuses anonymous agents). */
  trustPolicy?: "open" | "accountable-only";
  /** Registered demo agent key for /proof-run (signs AgentKit messages only, holds no funds). */
  proofAgentKey?: `0x${string}`;
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
    agentkit: deps.agentkit,
    trustPolicy: deps.trustPolicy,
    settle,
    serve: () => ({ quote: "BYOA x402 demo quote", resource: "/x402-demo/quote" }),
  });
  app.route("/", paywall);

  // ── /x402-demo/proof-run — live demonstration of accountable-only commerce ────────────────
  // Two identities against a STRICT in-process paywall built from the SAME deps (same store,
  // same AgentBook config, same price): an anonymous bot, then the registered proof agent
  // minting a real proof from the refusal's own challenge. No settlement — the free legs
  // (403 refusal vs 402 invoice) ARE the demonstration. Throttled: the agent leg does a real
  // World Chain read on cache misses.
  if (deps.agentkit) {
    let lastRun = 0;
    const strictWall = buildPaywall({
      trustPolicy: "accountable-only",
      price: deps.price,
      payTo: deps.payTo,
      asset: deps.asset,
      network: deps.network,
      resource: "/x402-demo/quote",
      resourceUrl: deps.resourceUrl,
      // Same proof semantics, separate budget: /proof runs on every page view, so charging the
      // public seller's per-human allowance would let visitors exhaust what real buyers need.
      agentkit: deps.agentkit && { ...deps.agentkit, rateKey: `${deps.resourceUrl}#proof-run` },
      serve: () => ({ quote: "demo" }),
    });
    const wallFetch = (init?: { headers?: Record<string, string> }) =>
      strictWall.request("/x402-demo/quote", init);

    app.get("/x402-demo/proof-run", async (c) => {
      const now = Date.now();
      if (now - lastRun < 5_000)
        return c.json({ error: "slow-down", detail: "one run every 5 seconds" }, 429);
      lastRun = now;

      // Leg 1 — the anonymous bot: no proof, refused outright.
      const botRes = await wallFetch();
      const botBody = (await botRes.json().catch(() => ({}))) as Record<string, unknown>;
      const legs: Record<string, unknown>[] = [
        {
          actor: "bot",
          status: botRes.status,
          error: botBody.error,
          detail: botBody.detail,
          how: botBody.how,
        },
      ];

      // Leg 2 — the registered agent: mint a real proof from the refusal's own challenge.
      if (deps.proofAgentKey) {
        try {
          const probe = await wallFetch();
          const probeBody = (await probe.json()) as {
            extensions?: { agentkit?: unknown };
          };
          const { createAgentkitClient } = await import("@worldcoin/agentkit");
          const client = createAgentkitClient({
            signer: agentkitSignerFromKey(deps.proofAgentKey, chainIdOf(deps.network)),
            // biome-ignore lint/suspicious/noExplicitAny: client options typing varies across SDK versions.
          } as any) as { createHeader(ext: unknown): Promise<string> };
          // createHeader wants the INNER extension ({info, supportedChains, schema}).
          const header = await client.createHeader(probeBody.extensions?.agentkit);
          const agentRes = await wallFetch({ headers: { agentkit: header } });
          const agentBody = (await agentRes.json().catch(() => ({}))) as {
            accepts?: unknown[];
            error?: string;
          };
          legs.push({
            actor: "agent",
            status: agentRes.status,
            humanId: agentRes.headers.get("X-AGENTKIT-HUMAN"),
            rate: agentRes.headers.get("X-AGENTKIT-AUTHORIZATION"),
            invoice: Array.isArray(agentBody.accepts) && agentBody.accepts.length > 0,
            error: agentBody.error,
          });
        } catch (e) {
          legs.push({
            actor: "agent",
            status: 0,
            error: `proof-leg-failed: ${(e as Error).message}`,
          });
        }
      } else {
        legs.push({ actor: "agent", configured: false });
      }

      return c.json({
        policy: "accountable-only",
        resource: deps.resourceUrl,
        statement: "this seller trades only with agents a verified unique human answers for",
        legs,
      });
    });
  }
}

/** "eip155:5042002" -> 5042002. */
function chainIdOf(network: string): number {
  return Number(network.split(":")[1] ?? 0);
}
