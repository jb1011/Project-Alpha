import type { Hono } from "hono";
import { agentkitSignerFromKey } from "../../adapters/worldid/agentkitSigner";
import type { Config } from "../../config/env";
import { AGENT_BOOK_CHAIN_ID } from "../../payments/agentBookReader";
import type { SellerLegalBodyConfig, SellerTrustPolicy } from "../../payments/seller";
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
  /** Seller trust policy ("open" default; "accountable-only" refuses anonymous agents;
   *  "legal-bodies-only" additionally requires a legal body behind the payer). Applies to the
   *  CONFIGURED wall at /x402-demo/quote only — the legal-bodies demo wall pins its own. */
  trustPolicy?: SellerTrustPolicy;
  /** Registered demo agent key for /proof-run (signs AgentKit messages only, holds no funds). */
  proofAgentKey?: `0x${string}`;
  /** The legal-body check (design 2026-09-10 D4/D5), for the pinned demo wall and for the
   *  configured wall when the deployment sets X402_TRUST_POLICY=legal-bodies-only. Absent -> the
   *  pinned wall refuses 503 rather than serving on an unasked question. */
  legalBody?: SellerLegalBodyConfig;
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
    legalBody: deps.legalBody,
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
            // World Chain, not Arc (design v3 D10): the seller advertises `eip155:480`
            // beside Arc, and every AgentKit client in the wild signs for it.
            signer: agentkitSignerFromKey(deps.proofAgentKey, AGENT_BOOK_CHAIN_ID),
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

  // ── the legal-bodies-only wall, and the two refusals that make it legible ─────────────────
  //
  // The SECOND question a seller can ask (design 2026-09-10 D4/D5): AgentBook answers "is there a
  // human?", this wall also asks "is there a legal body?". The policy is PINNED here rather than
  // read from X402_TRUST_POLICY, so the demo can be shown on a box whose configured seller is
  // "open" — the deployment's own wall at /x402-demo/quote is not touched by any of this.
  if (deps.agentkit) {
    const wallPath = "/x402-demo/legal-bodies-wall";
    // Its own resource URL, because the AgentKit proof is bound to the resource it was signed
    // for: a header minted for /quote must not be replayable here, and vice versa.
    const wallResourceUrl = deps.resourceUrl.replace(/\/quote$/, "/legal-bodies-wall");
    const wallAgentkit = (rateKey: string) => ({
      ...(deps.agentkit as NonNullable<X402DemoDeps["agentkit"]>),
      resourceUrl: wallResourceUrl,
      rateKey,
    });
    const pinned = {
      trustPolicy: "legal-bodies-only" as const,
      price: deps.price,
      payTo: deps.payTo,
      asset: deps.asset,
      network: deps.network,
      resource: wallPath,
      resourceUrl: wallResourceUrl,
      legalBody: deps.legalBody,
      serve: () => ({
        quote: "Novi legal-body demo quote",
        resource: wallPath,
      }),
    };

    // The real wall: a Novi agent's payment lands here and settles, which is the third leg of the
    // demo and the only one that moves money.
    app.route(
      "/",
      buildPaywall({
        ...pinned,
        agentkit: wallAgentkit(`${wallResourceUrl}#legal-bodies-wall`),
        settle,
      }),
    );

    // A SECOND instance of the same wall for the run below — identical policy, deps and code
    // path, with two deliberate differences. (1) Its own rate key: /legal-bodies-run is a public
    // GET that any visitor can trigger, and charging the proof agent's budget on the real wall
    // would turn the second leg into a 429 after a handful of page views — the same reason
    // /proof-run keeps its own key. (2) No `settle`: this endpoint must be incapable of spending.
    const runWall = buildPaywall({
      ...pinned,
      agentkit: wallAgentkit(`${wallResourceUrl}#legal-bodies-run`),
    });
    const wallFetch = (init?: { headers?: Record<string, string> }) =>
      runWall.request(wallPath, init);

    let lastLegalRun = 0;
    app.get("/x402-demo/legal-bodies-run", async (c) => {
      const now = Date.now();
      if (now - lastLegalRun < 5_000)
        return c.json({ error: "slow-down", detail: "one run every 5 seconds" }, 429);
      lastLegalRun = now;

      // Leg 1 — anonymous: refused before the legal question is ever asked. Its body carries the
      // freshly minted challenge, which is exactly what leg 2 signs, so the second leg proves the
      // refusal really is self-service.
      const anonRes = await wallFetch();
      const anonBody = (await anonRes.json().catch(() => null)) as Record<string, unknown> | null;
      const legs: Record<string, unknown>[] = [
        { name: "anonymous", status: anonRes.status, body: anonBody },
      ];

      // Leg 2 — human-backed, no legal body: a real SIWE proof from the AgentBook-registered
      // proof agent (the Lisbon agent: a human vouches for it, no Novi body stands behind it).
      if (deps.proofAgentKey) {
        try {
          const { createAgentkitClient } = await import("@worldcoin/agentkit");
          const client = createAgentkitClient({
            // World Chain, not Arc (design v3 D10) — every AgentKit client signs for eip155:480.
            signer: agentkitSignerFromKey(deps.proofAgentKey, AGENT_BOOK_CHAIN_ID),
            // biome-ignore lint/suspicious/noExplicitAny: client options typing varies across SDK versions.
          } as any) as { createHeader(ext: unknown): Promise<string> };
          // createHeader wants the INNER extension ({info, supportedChains, schema}) — taken from
          // leg 1's own refusal, so no extra challenge is minted and nothing else is signed.
          const header = await client.createHeader(
            (anonBody as { extensions?: { agentkit?: unknown } } | null)?.extensions?.agentkit,
          );
          const agentRes = await wallFetch({ headers: { agentkit: header } });
          legs.push({
            name: "human-backed, no legal body",
            status: agentRes.status,
            humanId: agentRes.headers.get("X-AGENTKIT-HUMAN"),
            legalBody: agentRes.headers.get("X-NOVI-LEGAL-BODY"),
            body: await agentRes.json().catch(() => null),
          });
        } catch (e) {
          legs.push({
            name: "human-backed, no legal body",
            status: null,
            body: null,
            skipped: true,
            reason: `proof-leg-failed: ${(e as Error).message}`,
          });
        }
      } else {
        legs.push({
          name: "human-backed, no legal body",
          status: null,
          body: null,
          skipped: true,
          // Never signed by anything else: the leg is worth nothing unless the signer is an
          // address AgentBook actually vouches for.
          reason: "no proof agent key configured on this deployment (X402_PROOF_AGENT_KEY)",
        });
      }

      return c.json({
        policy: "legal-bodies-only",
        resource: wallResourceUrl,
        statement:
          "this seller trades only with agents that a registered legal body in good standing stands behind",
        legs,
        expected: {
          anonymous: {
            status: 403,
            error: "human_backing_required",
            reason: "no-proof-presented",
          },
          "human-backed, no legal body": {
            status: 403,
            error: "legal_body_required",
            reason: "not-legal-body",
          },
        },
        thirdLeg:
          "a payment from an AgentBook-registered Novi legal body reaches 200; run it from the product (MCP pay) — this endpoint spends nothing",
      });
    });
  }
}
