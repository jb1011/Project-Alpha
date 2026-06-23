import { Hono } from "hono";
import type { Address } from "../types";
import { type AuthorityDeps, authorizePayment } from "./authority";

/**
 * The Payment Authority's HTTP face: a single `POST /authorize` route. The agent (buyer) posts a
 * payment request here; the route runs the policy-gated chokepoint and returns the signed X-PAYMENT
 * header on allow (200) or the policy reason on deny (402 Payment Required). Thin by design — all the
 * logic lives in authorizePayment; the route only parses, dispatches, and maps the result to HTTP.
 */
export function buildAuthorityApp(deps: AuthorityDeps) {
  const app = new Hono();
  app.post("/authorize", async (c) => {
    const body = (await c.req.json()) as {
      payee: string;
      amount: string;
      resource: string;
      asset: string;
      network: string;
      maxTimeoutSeconds?: number;
    };
    const res = await authorizePayment(deps, {
      payee: body.payee as Address,
      amount: BigInt(body.amount),
      resource: body.resource,
      asset: body.asset as Address,
      network: body.network,
      maxTimeoutSeconds: body.maxTimeoutSeconds ?? 60,
    });
    if (res.ok) return c.json({ header: res.header }, 200);
    return c.json({ error: "policy-denied", reason: res.reason }, 402);
  });
  return app;
}
