import { HTTPFacilitatorClient, type RoutesConfig, x402ResourceServer } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { paymentMiddleware } from "@x402/hono";
import type { Hono } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { buildAttestation } from "../../hedera/attestation";
import { isPublicOnChain } from "../../payments/legalBody";
import type { EntityRecord } from "../../types";
import type { ApiDeps } from "../app";
import { createClientLimiter, sharedReadBudget } from "./legalBodies";

/**
 * GET /verify/:publicId — the PAID legal-standing check, settled on Hedera (design 2026-09-10 D9,
 * D30, task 6).
 *
 * Public and unauthenticated, like `/legal-bodies/:address`, and for the same reason: the caller
 * is an agent on someone else's stack that has never heard of us. What it buys is the document —
 * a body it can keep, quote and (from task 13) verify a signature over — where the free lookup
 * answers one boolean-shaped question about one address.
 *
 * THREE LAYERS, in this order, and the order is the design:
 *
 *   1. the rate limiter and the 404 guard, BEFORE any price is quoted (D9). Quoting for an
 *      entity we do not have would turn this route into an existence oracle that charges for the
 *      answer, and would let a walk over random UUIDs cost us a facilitator round trip each.
 *   2. `@x402/hono`'s payment middleware: it issues the 402, verifies, and settles AFTER the
 *      handler — a settlement that fails replaces our body with the facilitator's 402, so the
 *      attestation is never served for a payment that did not land.
 *   3. the handler, which builds the body and nothing else.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The description travels ON THE WIRE, in the 402's `PAYMENT-REQUIRED` header, so it is a served
 *  string and the claims ceiling (D9) binds it: good standing, never "verified", never "KYC'd". */
const DESCRIPTION =
  "Novi Corpus legal-standing check: is this a registered legal body in good standing?";

/** The entity the 404 guard already resolved, handed to the handler so the paid path never reads
 *  the database twice — and never disagrees with the row the price was quoted against. */
type VerifyVars = AuthVars & { verifyEntity: EntityRecord };

export function mountVerifyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  const h = deps.hedera;
  const lb = deps.legalBody;
  // No Hedera config, or no way to read standing: the route does not exist. Not mounted and
  // refusing, which would advertise a capability this deployment cannot honour — and certainly
  // not mounted and charging for an answer it cannot produce.
  if (!h || !lb) return;

  const limiter = createClientLimiter(deps);
  const shared = sharedReadBudget(deps);
  const facilitator = new HTTPFacilitatorClient({ url: h.cfg.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register("hedera:*", new ExactHederaScheme());
  const routes: RoutesConfig = {
    "GET /verify/:publicId": {
      accepts: {
        scheme: "exact",
        network: "hedera:testnet",
        payTo: h.cfg.payToAccountId,
        price: { amount: h.cfg.verifyPriceAtomic.toString(), asset: h.cfg.usdcTokenId },
      },
      description: DESCRIPTION,
      mimeType: "application/json",
    },
  };

  const typed = app as unknown as Hono<{ Variables: VerifyVars }>;

  // Layer 1: the limiter and the 404 guard, BEFORE any 402 is issued (D9).
  typed.use("/verify/:publicId", async (c, next) => {
    // Nothing a caller is refused may be reused by a shared cache — not a throttle, not a 404.
    const noStore = () => c.header("Cache-Control", "no-store");
    // The PER-CLIENT allowance first, and it is the SAME instance `/legal-bodies/:address` spends
    // (audit C9): a caller cannot walk from one public read surface to the other to double it.
    if (!limiter(c).take()) {
      noStore();
      return c.json({ error: "rate_limited", message: "try again in a few seconds" }, 429);
    }
    const publicId = c.req.param("publicId");
    // One 404 for malformed, unknown and not-yet-on-chain alike: three different answers would
    // tell an unpaying caller which UUIDs exist.
    const ent = UUID.test(publicId) ? deps.repo.findByPublicId(publicId) : undefined;
    if (!ent || !isPublicOnChain(ent)) {
      noStore();
      return c.json({ error: "not_found" }, 404);
    }
    // The SHARED budget bounds ARC READS, so it is spent only once we know a read can follow.
    // Taking it above the 404 guard let a walk over random ids drain the deployment-wide bucket
    // and throttle the free `/legal-bodies` lookup, which makes no chain read for any of them.
    //
    // The same argument rules out spending it on an UNPAID request. A caller with no payment
    // header is only ever quoted a price: the 402 comes out of the middleware below and the
    // handler — the only thing that reads Arc — never runs. Charging the shared bucket for it let
    // a caller rotating `x-forwarded-for` over known public ids hold `/legal-bodies` at 429 while
    // costing us no chain read at all. So the token is taken only when a payment header is
    // present, which is the only request that can reach the handler.
    //
    // This does NOT close a garbage-header drain: a forged or malformed payment header is refused
    // by the middleware below, after this line, so it still spends one shared token. What it
    // costs the attacker is a well-formed-looking header per request instead of one flipped IP
    // address; bounding that case needs the budget spent inside layer 3, which cannot be done
    // without either double-reading the entity or moving the take past settlement.
    //
    // Still in layer 1, ahead of the 402, and it must never move past the payment middleware: a
    // 429 raised after settlement would take the buyer's money and return nothing.
    const paying = c.req.header("payment-signature") ?? c.req.header("x-payment");
    if (paying && !shared.take()) {
      noStore();
      return c.json({ error: "rate_limited", message: "try again in a few seconds" }, 429);
    }
    c.set("verifyEntity", ent);
    await next();
  });

  // Layer 2: the x402 middleware (402, verify, settle; it discards our body on a failed settle).
  // `syncFacilitatorOnStart` stays at its DEFAULT (true): with false the middleware never
  // initializes, and the resource server then throws on every request, which answers 500
  // (design Pre-cleared ✎, audit B8). Mounting fetches the facilitator's `/supported` once, in
  // the background; a failure there is retried by the middleware on the first request.
  typed.use("/verify/:publicId", paymentMiddleware(routes, server));

  // Layer 3: the handler.
  typed.get("/verify/:publicId", async (c) => {
    const ent = c.get("verifyEntity");
    const body = await buildAttestation(ent, {
      lookup: lb,
      worldId: deps.worldId,
      chainId: deps.chainId,
      identityRegistry: deps.identityRegistry,
      now: deps.now ?? Date.now,
    });
    // Never reusable: standing is live, the body is paid for, and a shared cache holding it would
    // serve one buyer's document to the next caller for free.
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });
}
