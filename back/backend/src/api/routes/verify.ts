import {
  HTTPFacilitatorClient,
  type RoutesConfig,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { paymentMiddlewareFromHTTPServer } from "@x402/hono";
import type { Context, Hono, MiddlewareHandler } from "hono";
import type { AuthVars } from "../../auth/middleware";
import { ApiError } from "../../errors";
import { buildAttestation, signAttestation } from "../../hedera/attestation";
import { opsLog } from "../../observability/opsLog";
import { isPublicOnChain } from "../../payments/legalBody";
import type { EntityRecord } from "../../types";
import { withDeadline } from "../../util/deadline";
import type { ApiDeps } from "../app";
import { createClientLimiter, sharedReadBudget } from "./legalBodies";

/**
 * GET /verify/:publicId — the PAID legal-standing check, settled on Hedera (design 2026-09-10 D9,
 * D30, task 6).
 *
 * Public and unauthenticated, like `/legal-bodies/:address`, and for the same reason: the caller
 * is an agent on someone else's stack that has never heard of us. What it buys is the document —
 * a body it can keep, quote and verify a signature over — where the free lookup answers one
 * boolean-shaped question about one address.
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

/** At most one facilitator handshake per this long, however many callers ask in between. This
 *  route is public and unauthenticated, so without a window every request to it while the
 *  facilitator is down would be another round trip to the facilitator. */
const HANDSHAKE_RETRY_MS = 10_000;

/**
 * How long the HANDSHAKE may take before a caller is told "not now" — and why it is the handshake
 * that is bounded rather than the facilitator client.
 *
 * The client's own `timeoutMs` would have been one line, and it is the wrong line: one
 * `HTTPFacilitatorClient` serves the handshake, `verify()` and `settle()` alike, so any ceiling
 * on it is also a ceiling on SETTLEMENT. A settle that times out is an indeterminate outcome by
 * the library's own documentation — the facilitator may have completed it — so a client-level
 * bound would turn a slow but successful payment into "failed" while the money had moved. That is
 * the class of lie the funding path has already paid to remove once, and it is not worth
 * reintroducing here to shorten a handshake. The client keeps its 30-second default.
 *
 * What genuinely needed bounding is only this: the handshake is SHARED, so a facilitator that
 * accepts the connection and then says nothing held every `/verify` caller at once — for the full
 * default, and longer where `getSupported` retried. Bounding the attempt rather than the transport
 * costs a caller five seconds and costs a settlement nothing.
 */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** The ONE sentence a caller is told while the handshake has not succeeded. It names no host, no
 *  URL and no third party: none of that is something a buyer can act on, and all of it is
 *  deployment topology that a public 503 has no business publishing. */
const UNAVAILABLE = "the paid standing check is temporarily unavailable; try again shortly";

/**
 * The refusal, and the one place that decides it is not reusable.
 *
 * `Cache-Control: no-store` for the same reason the 404 and the 429 in layer 1 carry it: nothing a
 * caller is refused may be held by a shared cache. An intermediary that kept this one would go on
 * refusing buyers out of its own copy long after the facilitator came back.
 */
const unavailable = (c: { header(name: string, value: string): void }): ApiError => {
  c.header("Cache-Control", "no-store");
  return new ApiError("facilitator_unavailable", 503, UNAVAILABLE);
};

export function mountVerifyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  const h = deps.hedera;
  const lb = deps.legalBody;
  // No Hedera config, or no way to read standing: the route does not exist. Not mounted and
  // refusing, which would advertise a capability this deployment cannot honour — and certainly
  // not mounted and charging for an answer it cannot produce.
  if (!h || !lb) return;

  const limiter = createClientLimiter(deps);
  const shared = sharedReadBudget(deps);
  const now = () => (deps.now ?? Date.now)();
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

  /**
   * LAYER 2, BUILT ON THE FIRST REQUEST — and the reason it is not built at mount.
   *
   * `paymentMiddleware(routes, server)` used to be called right here, while the app was being
   * assembled, and `@x402/hono` starts the facilitator's `/supported` handshake inside that call.
   * A facilitator that answered 200 without `exact` on this network therefore made
   * `x402HTTPResourceServer.initialize()` raise `RouteConfigurationError` during boot — and
   * `@x402/core` treats that as a FATAL startup error, so its background-init handler answered it
   * with `process.exit(1)`. The whole API died, `/healthz` included, because one third-party
   * sidecar was pointed at the wrong chain. A facilitator that was merely unreachable left the
   * process up but answered this route with a bare 500 from inside the library.
   *
   * So the handshake is ours: nothing touches the facilitator until a request actually needs it,
   * the built middleware is cached once it succeeds, and a failure is a 503 in this API's envelope
   * that the next request retries — at most one attempt per `HANDSHAKE_RETRY_MS`. No other route
   * in this process can be affected by it, which is the property that was missing.
   */
  let paid: MiddlewareHandler | undefined;
  /** The attempt in flight, so concurrent callers share ONE handshake instead of one each. */
  let attempt: Promise<MiddlewareHandler> | undefined;
  /** The earliest the next attempt may start. Set when an attempt BEGINS, so a facilitator that
   *  takes ten seconds to fail does not open the window the moment it answers. */
  let nextAttemptAt = 0;

  const openPaidLayer = (): Promise<MiddlewareHandler> =>
    withDeadline(
      HANDSHAKE_TIMEOUT_MS,
      () => {
        const facilitator = new HTTPFacilitatorClient({ url: h.cfg.facilitatorUrl });
        const server = new x402ResourceServer(facilitator).register(
          "hedera:*",
          new ExactHederaScheme(),
        );
        const httpServer = new x402HTTPResourceServer(server, routes);
        // The handshake, awaited where we can answer for it: `/supported`, plus the library's own
        // check that the facilitator advertises the scheme and network this route quotes. Then
        // `syncFacilitatorOnStart` FALSE, which is safe only because `initialize()` above did the
        // initialising — and is the point of doing it there. With the default (true) this call
        // starts a second handshake and hands its failure to the fatal-startup handler that exits
        // the process; with false and no `initialize()` of our own, the resource server would
        // have no supported kinds and every request would 500 (design Pre-cleared ✎, audit B8).
        const ready = httpServer
          .initialize()
          .then(() => paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
        // The library takes no `AbortSignal`, so the deadline bounds OUR ANSWER and not its
        // socket: `initialize()` goes on running under the client's own 30-second default. The
        // wrapper's rejection is this attempt's outcome and promises settle once, so a late
        // success resolves nothing and can never install a layer whose handshake we already
        // declared failed. This `catch` is what keeps that ignored outcome from surfacing as an
        // unhandled rejection.
        ready.catch(() => undefined);
        return ready;
      },
      () =>
        new Error(`the facilitator handshake did not complete within ${HANDSHAKE_TIMEOUT_MS}ms`),
    );

  const paidLayer = async (c: Context): Promise<MiddlewareHandler> => {
    if (paid) return paid;
    if (!attempt) {
      if (now() < nextAttemptAt) throw unavailable(c);
      nextAttemptAt = now() + HANDSHAKE_RETRY_MS;
      const started = openPaidLayer();
      // ONE line per ATTEMPT, which is why it is attached HERE, to the attempt itself, and not in
      // the catch below: fifty callers waiting on one handshake would each have written their own
      // copy of the same failure, so the journal filled in proportion to traffic against a route
      // whose problem is that the traffic cannot be served. The window above then bounds the
      // logging exactly as it bounds the round trips.
      //
      // WHAT failed, never where: the reason is the library's own sentence, which names the
      // scheme and the status code. This `catch` also makes the rejection handled, so an attempt
      // nobody is left awaiting cannot surface as an unhandled rejection.
      started.catch((err: unknown) => {
        opsLog("verify_facilitator_handshake_failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
      });
      attempt = started;
    }
    try {
      paid = await attempt;
      return paid;
    } catch {
      attempt = undefined;
      throw unavailable(c);
    }
  };

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

  // Layer 2: the x402 middleware (402, verify, settle; it discards our body on a failed settle),
  // behind the handshake above. Mounted AFTER layer 1, so a 404 or a throttled caller is answered
  // without the facilitator being asked anything at all — with the facilitator up or down.
  typed.use("/verify/:publicId", async (c, next) => (await paidLayer(c))(c, next));

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
    // The EIP-712 signature (task 13), where this deployment holds a key. Both fields or
    // neither: a verifier that sees `attestor` with no `signature` has been handed a claim it
    // cannot check, which is worse than an unsigned document that says so.
    //
    // AFTER the body is complete and over the body as served, so there is no field the buyer
    // reads that the signature does not cover. It signs whatever standing came back, including
    // `inactive` and `unknown` — the signature attests what we said, not that the news is good.
    if (h.cfg.attestationKey) {
      const { attestor, signature } = await signAttestation(body, h.cfg.attestationKey);
      body.attestor = attestor;
      body.signature = signature;
    }
    // Never reusable: standing is live, the body is paid for, and a shared cache holding it would
    // serve one buyer's document to the next caller for free.
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });
}
