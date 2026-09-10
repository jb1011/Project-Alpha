import type { Hono } from "hono";
import { getAddress, isAddress } from "viem";
import type { AuthVars } from "../../auth/middleware";
import type { FormationSummary } from "../../formation/status";
import { opsLog } from "../../observability/opsLog";
import type { LegalBodyResolver } from "../../payments/legalBody";
import type { EntityRecord } from "../../types";
import type { ApiDeps } from "../app";
import type { TokenBucket } from "./agentBook";

/**
 * GET /legal-bodies/:address — "is this address the payment address of a Novi legal body in good
 * standing?" (design 2026-09-10 D3).
 *
 * PUBLIC and unauthenticated by design: the caller is a seller on someone else's stack who has
 * never heard of us and holds nothing but the address that is about to pay it. AgentBook answers
 * "is there a human?"; this answers the second question, and a seller that has to sign up for an
 * API key before it can ask is a seller that will not ask.
 *
 * Nothing here is new information (§4): every entity that resolves is already listed on
 * `/transparency` with its treasury and its agent id. The address the caller supplied is the only
 * thing this route can tell them that the transparency page cannot, and they supplied it.
 *
 * What this route DOES NOT answer, and must never (D7): who the guardian is, whether a human
 * vouched, anything from AgentBook, the EIN, the filing number, the tenant. The legal-body
 * question only — and in the vocabulary the chain actually carries: "a registered legal body in
 * good standing", never "verified company", "KYC'd" or "licensed".
 */

/** The lookup's own dependencies. Optional on `ApiDeps` as a whole, so a deployment that never
 *  wires a resolver simply has no such route (404) rather than a route that answers dishonestly. */
export interface LegalBodyLookupDeps {
  /** The ONE resolver (D1) — the same instance the buyer dial and the seller policy hold, so a
   *  suspension cannot mean one thing here and another there. It caches nothing. */
  resolver: LegalBodyResolver;
  /** The route's own read allowance, spent only on a MEMO MISS: two Arc reads per miss, and this
   *  is an unauthenticated surface where nothing else bounds the volume (§4, RPC drain). */
  readBudget: TokenBucket;
  links: {
    /** Absolute url of the human-readable transparency page. */
    transparency: string;
    /** Base the per-entity metadata url is composed from — `<base>/metadata/<publicId>`, exactly
     *  the shape `workflow/onboarding.ts` bakes on chain as the entity's `metadataURI`. */
    metadataBase: string;
  };
  /** The SHARED formation projection (`formation/status.ts`), keyed by company. Optional: absent,
   *  every answer's `formation` is null — the honest shape for a box that cannot read filings,
   *  and the same rule `/transparency` and `/metadata` apply. */
  formationSummary?: (companyId: string) => FormationSummary | null;
  /** Which Arc the entities in this deployment live on. Derived exactly as the AgentBook status
   *  route derives it, so the two public surfaces cannot name different chains. */
  network: "testnet" | "mainnet";
}

/**
 * The memo (D3): the LAST DEFINITIVE answer per address, for 15 seconds.
 *
 * A judge refreshing a page, or a seller's dashboard polling, must not be able to drain the RPC —
 * but a guardian suspension has to become visible fast, so the window is seconds and not minutes.
 * `unknown` is NEVER stored (D8): a read that failed is not an answer, and remembering it would
 * turn one RPC blip into fifteen seconds of "we cannot tell" for an address that is fine.
 */
const MEMO_TTL_MS = 15_000;
/** Bounded so a walk over random addresses cannot grow this map without limit. Oldest first —
 *  insertion order, re-inserted on every refresh, so the entry evicted is the coldest one. */
const MEMO_MAX_ENTRIES = 1000;

/** The filing facts this surface reports (D1: reported, never gating). */
interface FormationFacts {
  /** The STATE has filed the company: it legally exists. */
  filed: boolean;
  /** The IRS has issued the EIN. The EIN ITSELF is never on a public surface. */
  einIssued: boolean;
  status: FormationSummary["status"];
  environment: FormationSummary["environment"];
}

type LookupAnswer =
  | { address: string; legalBody: false; standing: null; checkedAt: string }
  | {
      address: string;
      legalBody: true;
      standing: "active" | "inactive" | "unknown";
      agentId: string | null;
      publicId: string | null;
      name: string;
      network: "testnet" | "mainnet";
      links: { transparency: string; metadata: string | null };
      formation: FormationFacts | null;
      checkedAt: string;
    };

export function mountLegalBodyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  const lb = deps.legalBody;
  if (!lb) return;
  const now = () => (deps.now ?? Date.now)();
  const memo = new Map<string, { at: number; answer: LookupAnswer }>();

  /**
   * The filing, as much of it as is safe anywhere (D1: reported, never gating).
   *
   * Two booleans and the two fields `/transparency` publishes. Deliberately NOT here: the filing
   * number and doola's company id (the filing's own identifiers), the EIN (a tax identifier,
   * authenticated views only), and the open required-action codes (an operational detail of our
   * relationship with the provider, not a fact about the legal body).
   */
  const formationOf = (e: EntityRecord): FormationFacts | null => {
    if (!e.companyId || !lb.formationSummary) return null;
    const s = lb.formationSummary(e.companyId);
    if (!s) return null;
    return {
      filed: s.status === "filed" || s.status === "complete",
      einIssued: s.status === "complete",
      status: s.status,
      // Inseparable from the rest (the honesty invariant): a sandbox filing must never be
      // readable as a Wyoming company by omission.
      environment: s.environment,
    };
  };

  app.get("/legal-bodies/:address", async (c) => {
    const supplied = c.req.param("address");
    // EIP-55 or lowercase, and nothing else (D3). `getAddress` alone would NOT do it: viem
    // checksums without validating, so a caller's single mistyped case would silently become a
    // different address and come back as "not a legal body" — an answer they would act on.
    if (!isAddress(supplied, { strict: true }))
      return c.json(
        {
          error: "validation_error",
          message:
            "address must be a 20-byte hex address, either all-lowercase or EIP-55 checksummed",
        },
        400,
      );
    const address = getAddress(supplied);
    const key = address.toLowerCase();

    const hit = memo.get(key);
    if (hit) {
      if (now() - hit.at < MEMO_TTL_MS) return c.json(hit.answer);
      memo.delete(key);
    }
    // Taken on a MISS ONLY, like the AgentBook status route's read budget: the bucket exists to
    // bound the CHAIN READS, and a memo hit makes none. Out of budget the answer is "ask again",
    // never a guess and never a stale body.
    if (!lb.readBudget.take())
      return c.json({ error: "rate_limited", message: "try again in a few seconds" }, 429);

    const resolved = await lb.resolver.resolve(address);
    const checkedAt = new Date(now()).toISOString();
    const answer: LookupAnswer =
      resolved.kind === "none"
        ? { address, legalBody: false, standing: null, checkedAt }
        : {
            address,
            legalBody: true,
            standing: resolved.standing,
            // A DECIMAL STRING, as every other public surface serves it (`/transparency`,
            // `/metadata`): an agent id is a uint256 token id, and a JSON number silently loses
            // precision above 2^53. The design sketch's unquoted `843704` would have been a lie
            // for any id big enough to matter.
            agentId: resolved.entity.agentId ?? null,
            publicId: resolved.entity.publicId ?? null,
            name: resolved.entity.name,
            network: lb.network,
            links: {
              transparency: lb.links.transparency,
              metadata: resolved.entity.publicId
                ? `${lb.links.metadataBase.replace(/\/+$/, "")}/metadata/${resolved.entity.publicId}`
                : null,
            },
            formation: formationOf(resolved.entity),
            checkedAt,
          };

    // DEFINITIVE answers only (D8). "Not one of ours" is definitive too — it is a local read that
    // asked the chain nothing — so it is memoised like the rest; `unknown` never is.
    if (!(resolved.kind === "body" && resolved.standing === "unknown")) {
      memo.set(key, { at: now(), answer });
      while (memo.size > MEMO_MAX_ENTRIES) {
        const oldest = memo.keys().next().value;
        if (oldest === undefined) break;
        memo.delete(oldest);
      }
    }

    // One line per MISS (a hit costs nothing and says nothing new). No address: this is a
    // high-volume public route and the two fields that matter for ops — which index matched and
    // what the chain said — keep the line short and greppable.
    opsLog("legal_body_lookup", {
      matchedBy: resolved.kind === "body" ? resolved.matchedBy : "none",
      standing: resolved.kind === "body" ? resolved.standing : null,
    });
    return c.json(answer);
  });
}
