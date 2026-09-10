import {
  CIRCLE_BATCHING_NAME,
  CIRCLE_BATCHING_SCHEME,
  CIRCLE_BATCHING_VERSION,
} from "@circle-fin/x402-batching";
import { Hono } from "hono";
import { arcBatchingConfig } from "../adapters/x402/pocket";
import { decodeX402Header } from "../adapters/x402/signX402";
import type { Address } from "../types";
import type { LegalBodyResolver } from "./legalBody";
import type { SettleFn } from "./settle";
import {
  type VerifyTransferAuthorizationResult,
  verifyTransferAuthorization,
} from "./transferAuthorization";
import {
  type AgentkitSellerConfig,
  chargeAllowance,
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

export type VerifyResult = VerifyTransferAuthorizationResult;

/**
 * Verify an inbound X-PAYMENT against this seller's requirements.
 *
 * Uses the self-verify fallback: decode via decodeX402Header (manual base64 codec that bypasses
 * the upstream encodePayment/decodePayment which throw "Invalid network" for Arc's eip155:5042002),
 * then check recipient, amount, and expiry. BatchFacilitatorClient.verify from @circle-fin/x402-batching/server
 * makes a remote HTTP call to Circle's Gateway API (requires Circle API key + network), so the
 * structural self-verify is the correct local path.
 *
 * The four EIP-3009 checks and the recovery itself moved to
 * `payments/transferAuthorization.ts` (design 2026-08-26 §6.3): formation payments need the same
 * question answered against the USDC TOKEN's domain with an EXACT amount, and two copies of
 * "did this person really authorize this transfer?" is two places for the recipient check to be
 * forgotten. What stays here is what is genuinely this rail's: the x402 ENVELOPE, Circle's
 * GATEWAY BATCHING domain (`verifyingContract` = the GatewayWallet, not USDC), and the amount
 * FLOOR that lets a buyer over-pay a paywall.
 */
export async function verifyPayment(header: string, cfg: SellerConfig): Promise<VerifyResult> {
  let env: ReturnType<typeof decodeX402Header>;
  try {
    env = decodeX402Header(header);
  } catch {
    return { ok: false, reason: "malformed X-PAYMENT" };
  }
  const chainId = Number(cfg.network.split(":")[1]); // "eip155:5042002" -> 5042002
  return verifyTransferAuthorization({
    authorization: env.payload.authorization,
    signature: env.payload.signature,
    domain: {
      name: CIRCLE_BATCHING_NAME,
      version: CIRCLE_BATCHING_VERSION,
      chainId,
      verifyingContract: arcBatchingConfig.verifyingContract,
    },
    payTo: cfg.payTo,
    value: cfg.price,
    mode: "floor",
  });
}

/** The seller-side trust dial. Ordered by strictness: each policy is the one before it plus one
 *  more question the buyer has to be able to answer. */
export type SellerTrustPolicy = "open" | "accountable-only" | "legal-bodies-only";

/** What `legal-bodies-only` needs to ask its question and to say something useful when the answer
 *  is no. The links are passed in rather than hard-coded because the refusal is a PUBLIC document
 *  a stranger's agent will follow: it has to point at this deployment's own lookup. */
export interface SellerLegalBodyConfig {
  /** The ONE resolver (design 2026-09-10 D1) — the same instance the buyer dial and the public
   *  lookup hold, so a suspension cannot mean one thing here and another there. It caches
   *  nothing: standing is read fresh on every request, which is the point. */
  resolver: LegalBodyResolver;
  /** Public API base the refusal's `how.lookup` is composed from: `<base>/legal-bodies/<address>`. */
  lookupBaseUrl: string;
  /** Where an agent with no legal body goes to get one. */
  onboardUrl: string;
  /** The human-readable list of the bodies this seller will trade with. */
  transparencyUrl: string;
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
   *  human-backed agents proceed to the normal payment path. "legal-bodies-only" = the same, plus
   *  a registered Novi legal body in good standing behind the payer address. Both strict policies
   *  require `agentkit`; "legal-bodies-only" additionally requires `legalBody`. */
  trustPolicy?: SellerTrustPolicy;
  /** Required by `legal-bodies-only`, ignored by every other policy. ABSENT under that policy is
   *  a misconfiguration, not a permission: every request is refused 503 (D8 — fail closed), so a
   *  deployment that forgets to wire the resolver cannot silently sell to anyone who asks. */
  legalBody?: SellerLegalBodyConfig;
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
  const challenge = async () =>
    cfg.agentkit
      ? { ...buildRequirements(cfg), extensions: await mintAgentkitExtension(cfg.agentkit) }
      : buildRequirements(cfg);

  // Both strict policies share the human gate; `legalGate` is the SECOND question, asked only
  // after the first one has been answered. Widening `strict` here is what keeps the two policies
  // from drifting apart: `legal-bodies-only` cannot accidentally become laxer than
  // `accountable-only` about proofs, rate caps or receipts.
  const strict =
    (cfg.trustPolicy === "accountable-only" || cfg.trustPolicy === "legal-bodies-only") &&
    !!cfg.agentkit;
  const legalPolicy = cfg.trustPolicy === "legal-bodies-only";
  const legalGate = legalPolicy && !!cfg.agentkit;
  /** Either half missing and the policy cannot be honoured at all. It then refuses EVERYTHING
   *  (503) rather than degrading: a box that loses its World config must not quietly start
   *  selling to anonymous payers while its own env still says `legal-bodies-only`. (The same
   *  omission under `accountable-only` still degrades to `open` — pre-existing, untouched here.) */
  const legalUnavailable = legalPolicy && (!cfg.agentkit || !cfg.legalBody);

  // Said ONCE, at mount, because a request-time log for a misconfiguration this permanent is just
  // noise — and because a policy that is silently not in force is the failure worth shouting about.
  if (legalPolicy && !cfg.agentkit)
    console.warn(
      "⚠ x402 seller policy legal-bodies-only has NO agentkit config: every request is refused 503",
    );
  if (legalPolicy && !cfg.legalBody)
    console.warn(
      "⚠ x402 seller policy legal-bodies-only has NO legal-body resolver wired: every request is refused 503",
    );

  /** Strict refusal: a doorway, not a wall. 403 (never 402 — payment would not help), with the
   *  remediation AND the standard challenge, so a capable agent can fix its situation from the
   *  refusal alone. */
  const refusal = async (reason: string) => ({
    error: "human_backing_required",
    detail: "this seller trades only with agents a verified unique human answers for",
    reason,
    how: {
      register: "npx @worldcoin/agentkit-cli register <your-agent-address>",
      agentBook: cfg.agentkit?.agentBookAddress ?? "0xA23aB2712eA7BBa896930544C7d6636a96b944dA",
      chain: "world-chain",
    },
    // Safe: `strict` (checked by every caller) implies cfg.agentkit is present.
    extensions: await mintAgentkitExtension(cfg.agentkit as AgentkitSellerConfig),
  });

  /** The SECOND doorway (D4/D7). Same shape as the human refusal — 403, a reason, a remediation
   *  and the challenge — because the situations are the same kind: something is missing that the
   *  agent can go and get. `how.lookup` names the address we actually checked (the proof's
   *  signer), so following the link asks the very question this refusal answered.
   *
   *  The vocabulary is fixed (D7): "a registered legal body in good standing", never "verified
   *  company", "KYC'd" or "licensed" — the chain carries a status, not a guarantee. */
  const legalRefusal = async (reason: string, agentAddress: string) => {
    // Safe: every caller is inside `legalGate` past the cfg.legalBody guard.
    const lb = cfg.legalBody as SellerLegalBodyConfig;
    return {
      error: "legal_body_required",
      detail:
        "this seller trades only with agents that a registered legal body in good standing stands behind",
      reason,
      how: {
        lookup: `${lb.lookupBaseUrl.replace(/\/+$/, "")}/legal-bodies/${agentAddress}`,
        onboard: lb.onboardUrl,
        transparency: lb.transparencyUrl,
      },
      extensions: await mintAgentkitExtension(cfg.agentkit as AgentkitSellerConfig),
    };
  };

  /** 503, not 403: "we could not tell" is a different fact from "no", and an agent that IS a
   *  legal body must be able to read the difference and retry rather than go and re-register. */
  const checkUnavailable = (detail: string) => ({ error: "legal_body_check_unavailable", detail });

  app.get(path, async (c) => {
    const akHeader = c.req.header("agentkit");
    /** Set only when the legal gate ran and passed; `undefined` means the question was never
     *  asked (any other policy), which is why the receipt below distinguishes the two. */
    let legalBodyAgentId: string | null | undefined;

    /** The inbound payment, verified at most ONCE per request although two places ask about it:
     *  the allowance decision below and the payment path at the bottom. `verifyPayment` is pure
     *  local crypto (decode + recipient/amount/expiry + a local signature recovery — no chain
     *  reads, no side effects), so asking early costs nothing and changes no order that matters. */
    const paymentHeader = c.req.header("X-PAYMENT");
    let checked: VerifyResult | null | undefined;
    const checkPayment = async (): Promise<VerifyResult | null> => {
      if (checked === undefined)
        checked = paymentHeader ? await verifyPayment(paymentHeader, cfg) : null;
      return checked;
    };
    /** Is this request the PAYING half of a purchase whose 402 we already charged a unit for?
     *  Only a payment that actually verifies and is not a replay counts — junk must not buy a free
     *  trip through the gate, or a human-backed agent could hammer the legal check for nothing.
     *
     *  Note what this does NOT establish: that the payment is FUNDED. `verifyPayment` is local
     *  crypto over an EIP-3009 authorization — signing one costs nothing and needs no balance — so
     *  `paying` is a promise to pay, and the meter exemption belongs to the promise that was KEPT
     *  (see `spendUnit`). */
    const payingRequest = async () => {
      const v = await checkPayment();
      return !!v && v.ok && !seen.has(v.nonce);
    };
    /** Spend this request's unit, at most once, and put the receipt on the response.
     *
     *  Set only inside the strict gate, and only for a request whose charge is DEFERRED: one that
     *  carries a verifiable payment, and is therefore exempt ONLY if that payment settles and the
     *  request is served. `undefined` everywhere else means the charge is already decided — spent
     *  inside the verify (`accountable-only`), spent at the legal decision, or rightly not spent
     *  at all (a 503 is our failure, and the store has no release). */
    let spendUnit: (() => { allowed: boolean; used: number; limit: number }) | undefined;

    // ── accountable-only: accountability is a PRECONDITION of commerce ──────────────────────
    // No valid proof of a human backer -> refused outright; their money is not wanted (403,
    // never 402). A valid proof unlocks the RIGHT TO BUY: flow continues into the normal x402
    // path below — everyone pays. The per-human counter acts as a rate cap (429), not a free
    // allowance: one human backing fifty agents still gets one budget.
    // Before anything else, and OUTSIDE the strict block on purpose: a policy this deployment
    // cannot EVALUATE authorizes nobody, not even to the point of being told what proof to bring.
    // Without `agentkit` the strict block is skipped entirely, so this check has to sit in front
    // of it or a misconfigured seller would fall through to `open` and sell to anyone.
    if (legalUnavailable)
      return c.json(
        checkUnavailable("this seller's legal-body check is not configured right now"),
        503,
      );

    if (strict) {
      if (!akHeader) return c.json(await refusal("no-proof-presented"), 403);
      // ONE PURCHASE, ONE UNIT (re-review R2). A strict wall answers an unpaid request with a 402
      // and charges it; the buyer then comes back with the SAME purchase plus its payment. Charging
      // that second half too makes every purchase cost two of the human's units — at the production
      // default of three per 24 h, one purchase a day. So a request that carries a payment we can
      // verify is not charged; the 402 that quoted it already was.
      const paying = await payingRequest();
      // Under the legal gate the meter is NOT touched here either: the human is identified and an
      // exhausted one is still refused, but the unit is spent below, once the second question has
      // a definitive answer (review R3).
      const outcome = await verifyAgentkitRequest(
        akHeader,
        cfg.agentkit as AgentkitSellerConfig,
        paying
          ? // Already paid for by its 402: neither spend a unit nor refuse for want of one. A 429
            // here lands on a buyer that has just signed its money away.
            { chargeAllowance: false, enforceAllowance: false }
          : legalGate
            ? { chargeAllowance: false }
            : undefined,
      );
      if (!outcome.authorized) {
        if (outcome.reason === "allowance-exhausted") {
          if (outcome.humanId) c.header("X-AGENTKIT-HUMAN", outcome.humanId);
          return c.json(
            { error: "rate-capped", detail: "per-human request budget exhausted for this window" },
            429,
          );
        }
        return c.json(await refusal(outcome.reason ?? "unverified"), 403);
      }
      c.header("X-AGENTKIT-HUMAN", outcome.humanId);
      if (!legalGate) c.header("X-AGENTKIT-AUTHORIZATION", `${outcome.used}/${outcome.limit}`);

      // ── WHEN the unit is spent (final pass F2) ──────────────────────────────────────────────
      // An X-PAYMENT header is a promise, not a payment: it verifies locally with no funds behind
      // it, and on a refusal its nonce is never consumed, so ONE signed authorization used to make
      // every refusal free while this seller kept doing the work — an AgentBook read and, under
      // the legal gate, two Arc reads per request. The exemption is therefore not "this request
      // carries a payment" but "this payment SETTLED and we served the request", which is only
      // known at the bottom of this handler. So a paying request defers its charge and spends it
      // at every other exit: both legal 403s, a re-quoted 402, a settlement that failed. A
      // purchase still costs exactly one unit — the one its 402 spent.
      //
      // Deliberate delta for `accountable-only` too (ruling FP-F4, and the one thing about that
      // policy this branch changes): it used to charge inside the verify on EVERY verified
      // request, so a purchase cost it two units; now the paying half is exempt when it is served
      // and charged when it is not. Refusals are unchanged, in both policies: still one unit.
      const humanId = outcome.humanId;
      let spent: { allowed: boolean; used: number; limit: number } | undefined;
      const charge = () => {
        if (!spent) {
          spent = chargeAllowance(cfg.agentkit as AgentkitSellerConfig, humanId);
          c.header("X-AGENTKIT-AUTHORIZATION", `${spent.used}/${spent.limit}`);
        }
        return spent;
      };
      if (paying) spendUnit = charge;

      // ── legal-bodies-only: the SECOND question ───────────────────────────────────────────
      // A human vouches for this agent — now, does a registered legal body stand behind the
      // address that is about to pay? The address checked is the PROOF'S SIGNER, never anything
      // the caller asserted: an attacker cannot present a body it cannot sign for.
      if (legalGate) {
        const resolved = await (cfg.legalBody as SellerLegalBodyConfig).resolver.resolve(
          outcome.agentAddress,
        );
        if (resolved.kind === "body" && resolved.standing === "unknown")
          // Fail closed, remember NOTHING (D8) — and CHARGE NOTHING. This 503 is our failure and
          // its own detail invites a retry; the store has no release, so a unit spent on an RPC
          // blip is gone for the window and would lock out exactly the buyer this policy exists
          // to serve. The meter is untouched, so the retry we asked for is free.
          return c.json(
            checkUnavailable("the legal-body check could not be completed just now"),
            503,
          );

        // The answer is definitive, so the request is charged whichever way it went: a refusal
        // still cost a signature verification, an AgentBook read and two Arc reads, and an
        // unregistered agent must not be able to hammer this wall for free — with or without a
        // payment header riding along (F2). `charge()` is the one place a unit is spent, and it
        // spends at most one per request.
        if (resolved.kind === "none") {
          charge();
          return c.json(await legalRefusal("not-legal-body", outcome.agentAddress), 403);
        }
        if (resolved.standing === "inactive") {
          charge();
          return c.json(await legalRefusal("legal-body-inactive", outcome.agentAddress), 403);
        }
        // Standing is good, so this request will be quoted or served. A paying one keeps its
        // charge deferred (it is spent below unless the payment actually settles) and reports
        // where the human stands; every other one spends its unit here.
        if (paying) c.header("X-AGENTKIT-AUTHORIZATION", `${outcome.used}/${outcome.limit}`);
        else {
          const charged = charge();
          // Lost a race with a concurrent request for the same human (the meter is transactional,
          // so it can never exceed the limit — the loser is simply told so). Same 429 the peek
          // above would have produced a moment earlier.
          if (!charged.allowed)
            return c.json(
              {
                error: "rate-capped",
                detail: "per-human request budget exhausted for this window",
              },
              429,
            );
        }
        legalBodyAgentId = resolved.entity.agentId ?? null;
        // Named on the receipt, not merely implied by a 200. Omitted rather than faked when the
        // record has no agent id yet — an empty header value is a claim we cannot support.
        if (legalBodyAgentId) c.header("X-NOVI-LEGAL-BODY", legalBodyAgentId);
      }
      // fall through to payment — accountability grants no discount, and neither does standing
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

    const header = paymentHeader;
    if (!header) return c.json(await challenge(), 402);
    const v = (await checkPayment()) as VerifyResult;
    // Every exit from here down that is not a SERVED request spends the deferred unit (F2): the
    // gate work was done, and only a payment that lands buys the exemption. (`spendUnit` is set
    // only for a request whose payment verified, so the two 402s below are its race cases; the
    // settlement failure is the real one — an unfunded authorization.)
    if (!v.ok) {
      spendUnit?.();
      return c.json({ ...(await challenge()), error: v.reason }, 402);
    }
    if (seen.has(v.nonce)) {
      spendUnit?.();
      return c.json({ ...(await challenge()), error: "replay" }, 402);
    }
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
      if (!r.ok) {
        // The payment never landed, so this request bought nothing and pays for itself like any
        // other (F2) — an unfunded authorization is the attack this closes.
        spendUnit?.();
        return c.json({ ...(await challenge()), error: `settle-failed:${r.reason ?? ""}` }, 402);
      }
      if (r.transferId) c.header("X-PAYMENT-RESPONSE", r.transferId);
    }
    const served = (await cfg.serve(c.req.raw)) as Record<string, unknown>;
    // In strict mode the buyer proved a human backer before paying — say so on the receipt, and
    // under legal-bodies-only name the body it proved too.
    return c.json(
      strict
        ? {
            ...served,
            humanBacked: true,
            ...(legalBodyAgentId !== undefined ? { legalBody: { agentId: legalBodyAgentId } } : {}),
          }
        : served,
      200,
    );
  });
  return app;
}
