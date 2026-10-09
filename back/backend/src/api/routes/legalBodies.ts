import type { Context, Hono } from "hono";
import { getAddress, isAddress } from "viem";
import type { AuthVars } from "../../auth/middleware";
import type { FormationSummary } from "../../formation/status";
import type { SignedStatementJson } from "../../legalBody/publicStatement";
import type { Standing } from "../../legalBody/standing";
import { type StatementOutcome, statementForAddress } from "../../legalBody/statements";
import { opsLog } from "../../observability/opsLog";
import type {
  LegalBodyChainReads,
  LegalBodyResolution,
  LegalBodyResolver,
} from "../../payments/legalBody";
import type { EntityRecord } from "../../types";
import type { ApiDeps } from "../app";
import { TokenBucket } from "./agentBook";

/**
 * GET /legal-bodies/:address — "is this address the payment address of a Novi legal body in good
 * standing?" (design 2026-09-10 D3).
 *
 * PUBLIC and unauthenticated by design: the caller is a seller on someone else's stack who has
 * never heard of us and holds nothing but the address that is about to pay it. AgentBook answers
 * "is there a human?"; this answers the second question, and a seller that has to sign up for an
 * API key before it can ask is a seller that will not ask.
 *
 * Nothing here is new information about the ENTITY (§4): every one that resolves is already
 * listed on `/transparency` with its treasury, its agent id and its name. The payer→entity link is
 * the one new association — `/transparency` never publishes a pocket address — and it costs the
 * caller the address to obtain, which is an address AgentBook already binds in public.
 *
 * What a full-product answer DOES NOT carry, and must never (D7): who the guardian is, whether a
 * human vouched, anything from AgentBook, the EIN, the filing number, the tenant. The legal-body
 * question only — and in the vocabulary the chain actually carries: "a registered legal body in
 * good standing", never "verified company", "KYC'd" or "licensed".
 *
 * A Minimal legal body's answer carries the signed statement instead, under the statement's own
 * rules (`legalBody/publicStatement.ts`): its `filingNumber` and `legalName` only by the names rule
 * of `assembleStatement` (a passed check, a linked binding, nothing revoked), and
 * `guardianHumanVerified`, a flag. It does not name the guardian: `identityOwnerAtCreation` is the
 * identity's owner as the chain records it, which may be the guardian's own wallet. It never
 * carries the EIN.
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
  /**
   * The two Arc reads standing is made of, UNWRAPPED — the same pair `resolver` was built from.
   *
   * This route does not use them (it asks the resolver, which owns the address indexes too); the
   * Hedera `check_policy` tool does. That tool holds an entity record already, so it needs the
   * READS and not the address lookup, and taking them from here rather than from a second object
   * is what keeps one deployment from answering "suspended" on Arc and "active" on Hedera.
   *
   * Optional so every existing construction of this object still compiles; a deployment without
   * it cannot confirm standing, and `check_policy` fails CLOSED rather than guessing (D8).
   */
  chainReads?: LegalBodyChainReads;
  links: {
    /** Absolute url of the human-readable transparency page. */
    transparency: string;
    /** Base the per-entity metadata url is composed from — `<base>/metadata/<publicId>`, exactly
     *  the shape `workflow/onboarding.ts` bakes on chain as the entity's `metadataURI`. */
    metadataBase: string;
    /**
     * This API's OWN public origin (`PUBLIC_API_URL`), for the links a STRANGER'S x402 client
     * follows — the same base the demo wall and the lookup in a refusal are built from.
     *
     * Separate from `metadataBase` because in production that one is the www/backend proxy, and
     * that proxy's header allowlist (`interface/src/lib/proxyHeaders.ts`) forwards neither the
     * `payment-required` challenge nor `payment-signature`/`payment-response`: an x402 buyer
     * following a paid url through it gets a 402 with an empty body and nothing to pay against.
     *
     * Optional so every existing construction of this object still compiles; absent -> the
     * metadata base, which is exactly today's behaviour on a single-host deployment.
     */
    publicApiBase?: string;
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
 *
 * The statement route by agent keeps a memo of its own on the same window and bound.
 */
export const MEMO_TTL_MS = 15_000;
/**
 * …and the SAME window stated on the wire (R1).
 *
 * Every other public read route sets `Cache-Control` explicitly (`/transparency` and `/metadata`
 * 300 s, `/ensgateway` 30 s), and this one has to: the CORS `*` exists so a seller's browser page
 * can ask, and a shared cache left to its own heuristics would serve `standing: "active"` for a
 * body the guardian has since suspended. 15 seconds matches the memo, so the worst case is a
 * downstream cache holding an answer this process had already memoised — 30 s of staleness, the
 * cost D3's window was chosen against. Everything that is NOT a definitive answer — `unknown`, a
 * 400, a 429, a 503 — is `no-store`: none of them may be reused for anything.
 */
export const FRESH_CACHE_CONTROL = "public, max-age=15";
export const NO_STORE = "no-store";
/**
 * The PER-CLIENT budget, in front of the shared one (R2).
 *
 * The shared bucket protects the RPC; on an unauthenticated route it protects it from everyone at
 * once, so one scanner walking random addresses at a couple of requests a second could hold it
 * empty and every honest seller's lookup would 429 — which the copy-ready checker (D6) reads as
 * `null`, i.e. our own agents refused by every seller using it. A small budget per caller means a
 * scanner exhausts ITS OWN allowance first.
 *
 * Keyed by the LAST `X-Forwarded-For` entry, which is the one the reverse proxy in front of this
 * API appended; every entry before it is whatever the request arrived carrying, so keying on the
 * first let a caller mint a fresh allowance per request by writing a fresh fake one. It is still
 * best-effort — the shared bucket below is the backstop that holds whatever the key does not.
 */
const CLIENT_BURST = 10;
const CLIENT_REFILL_PER_SECOND = 0.5;
/** Bounded like the memo, and for the same reason: the key is caller-supplied. */
const CLIENT_MAX_KEYS = 2000;
/** A throttle is an ops signal, not a per-request log line: one line per window, whatever the
 *  volume, so a scanner cannot turn journald into its second victim. */
export const THROTTLE_LOG_WINDOW_MS = 60_000;
/** Bounded so a walk over random addresses cannot grow this map without limit. Oldest first —
 *  insertion order, re-inserted on every refresh, so the entry evicted is the coldest one. */
export const MEMO_MAX_ENTRIES = 1000;
/**
 * The two refusals of the public legal-body routes, in their flat shape. Public contract texts,
 * written once for this route and the statement route by agent beside it. The 429 is the same
 * whichever budget ran out. The 503 is a failed DATABASE read only: a chain that cannot be read is
 * `unknown`, never a 503.
 */
export const RATE_LIMITED_BODY = {
  error: "rate_limited",
  message: "try again in a few seconds",
} as const;
export const UNAVAILABLE_BODY = {
  error: "unavailable",
  message: "could not check right now; try again shortly",
} as const;

/** The filing facts this surface reports (D1: reported, never gating). */
export interface FormationFacts {
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
    }
  | MinimalAnswer;

/**
 * The answer for a Minimal legal body: the full product's shape, with the signed statement beside
 * it. A Minimal body has no metadata document and no filing of ours, so both of those are null.
 */
type MinimalAnswer =
  | {
      // No statement could be made just now (a chain read failed): nothing is signed and no agent
      // is named, since an address names an agent only through a statement made about it.
      address: string;
      legalBody: true;
      standing: "unknown";
      agentId: null;
      publicId: null;
      name: "";
      network: "testnet" | "mainnet";
      links: { transparency: string; metadata: null };
      formation: null;
      checkedAt: string;
      statement: null;
    }
  | {
      address: string;
      legalBody: true;
      standing: Standing;
      agentId: string;
      publicId: string;
      name: string;
      network: "testnet" | "mainnet";
      links: { transparency: string; metadata: null; statement: string };
      formation: null;
      checkedAt: string;
      statement: SignedStatementJson;
    };

/**
 * The memo of a public legal-body route: the last DEFINITIVE answer per key, for `ttlMs`.
 * Deciding what is definitive is the caller's: `unknown` is never handed to it.
 *
 * A plain `Map`, in the order of first writes. An answer read after its window is deleted by that
 * read. A hit is not re-inserted, so reading an answer neither renews its window nor moves its
 * place. A key written again while live keeps its first slot, with a window from the new write.
 * Above `maxEntries` the oldest write is evicted: the key is the caller's, and a walk over random
 * keys must not grow the map without limit.
 */
export class AnswerMemo<T> {
  private readonly entries = new Map<string, { at: number; answer: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (this.now() - hit.at < this.ttlMs) return hit.answer;
    this.entries.delete(key);
    return undefined;
  }

  set(key: string, answer: T): void {
    this.entries.set(key, { at: this.now(), answer });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/** Anything with a request header bag — a Hono `Context`, and nothing more than that. */
type HeaderBearing = { req: { header(name: string): string | undefined } };

/**
 * ONE per-client allowance per deployment, shared by every public read surface that asks for it
 * (audit C9). Keyed on the dependency object, which is the composition root's single instance, so
 * `/legal-bodies/:address` and the paid `/verify/:publicId` draw from the SAME bucket per caller:
 * a scanner that has spent its allowance on one of them cannot walk round to the other.
 */
const clientLimiters = new WeakMap<ApiDeps, (c: HeaderBearing) => TokenBucket>();

/**
 * The per-client limiter (R2): hand it a request, get that caller's bucket.
 *
 * Who is asking, as well as this can know: the LAST `X-Forwarded-For` entry, or `"direct"` for a
 * request that reached the process without one (localhost, a health check, a misconfigured proxy)
 * — one shared bucket for all of those, deliberately.
 *
 * LAST rather than first, and the difference is whether the limit binds at all: every entry
 * before the last is a value the request arrived carrying, so a caller rotating a fake first
 * entry was handed a fresh bucket on every request and this allowance never refused it. The last
 * entry is the one appended by the proxy that received the connection, which is the only entry in
 * the header nobody upstream of it could have chosen. (The bounded map below still caps memory
 * either way — memory was never the thing keying on the first entry cost us.)
 */
export function createClientLimiter(deps: ApiDeps): (c: HeaderBearing) => TokenBucket {
  const existing = clientLimiters.get(deps);
  if (existing) return existing;

  /** One bucket per caller (R2), bounded and least-recently-used-first. */
  const clients = new Map<string, TokenBucket>();
  const limiter = (c: HeaderBearing): TokenBucket => {
    // The last NON-EMPTY entry. Trimmed and lowercased so one caller cannot hold two buckets by
    // spelling itself two ways — and non-empty because a trailing comma is legal here and is what
    // a proxy appending to an empty inbound value leaves behind. Read literally, that empty tail
    // became the key, which is falsy, so those callers fell through to the shared `direct` bucket
    // and pooled one allowance between them. Only a header with nothing in it at all is `direct`.
    const appended = c.req
      .header("x-forwarded-for")
      ?.split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== "")
      .pop();
    const key = appended ?? "direct";
    const found = clients.get(key);
    // Re-inserted on every use, so insertion order IS least-recently-used order and the entry
    // evicted below is the coldest one — never the scanner's own exhausted bucket.
    if (found) {
      clients.delete(key);
      clients.set(key, found);
      return found;
    }
    const fresh = new TokenBucket(CLIENT_BURST, CLIENT_REFILL_PER_SECOND);
    clients.set(key, fresh);
    while (clients.size > CLIENT_MAX_KEYS) {
      const oldest = clients.keys().next().value;
      if (oldest === undefined) break;
      clients.delete(oldest);
    }
    return fresh;
  };
  clientLimiters.set(deps, limiter);
  return limiter;
}

/**
 * The SHARED read allowance, which is the one that protects the RPC itself.
 *
 * Deliberately the very instance on `deps.legalBody` and never a copy: two surfaces with two
 * budgets would let a caller spend the RPC twice over. Callers guard on `deps.legalBody` before
 * asking — the throw below is the type system's price for that, not a reachable path.
 */
export function sharedReadBudget(deps: ApiDeps): TokenBucket {
  const lb = deps.legalBody;
  if (!lb) throw new Error("sharedReadBudget requires deps.legalBody");
  return lb.readBudget;
}

/**
 * The filing, as much of it as is safe anywhere (D1: reported, never gating).
 *
 * Two booleans and the two fields `/transparency` publishes. Deliberately NOT here: the filing
 * number and doola's company id (the filing's own identifiers), the EIN (a tax identifier,
 * authenticated views only), and the open required-action codes (an operational detail of our
 * relationship with the provider, not a fact about the legal body).
 *
 * Exported because the paid attestation (`hedera/attestation.ts`) reports the same facts, and two
 * public surfaces describing one filing differently is the drift this projection exists to stop.
 */
export function formationOf(lb: LegalBodyLookupDeps, e: EntityRecord): FormationFacts | null {
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
}

/**
 * The lookup's answer for a Minimal legal body, from what the statement service made of the
 * address. `network` and the transparency link are the lookup's, as on every answer of this
 * route; the statement link is the statement route's, for the agent stated.
 */
function minimalAnswer(
  lb: LegalBodyLookupDeps,
  statementBase: string,
  address: string,
  outcome: Exclude<StatementOutcome, { kind: "none" }>,
  checkedAt: string,
): MinimalAnswer {
  if (outcome.kind === "unknown")
    return {
      address,
      legalBody: true,
      standing: "unknown",
      agentId: null,
      publicId: null,
      name: "",
      network: lb.network,
      links: { transparency: lb.links.transparency, metadata: null },
      formation: null,
      checkedAt,
      statement: null,
    };
  return {
    address,
    legalBody: true,
    standing: outcome.standing,
    agentId: outcome.agentId,
    publicId: outcome.publicId,
    // The name the statement carries: empty unless the statement may show it.
    name: outcome.statement.message.legalName,
    network: lb.network,
    links: {
      transparency: lb.links.transparency,
      metadata: null,
      statement: `${statementBase}${outcome.agentId}`,
    },
    formation: null,
    checkedAt,
    statement: outcome.statement,
  };
}

/** The one thing of an error an ops line carries: its message can quote a value we hold. Shared
 *  with the statement route by agent. */
export const errorNameOf = (e: unknown): string => (e instanceof Error ? e.name : "not_an_error");

export function mountLegalBodyRoutes(app: Hono<{ Variables: AuthVars }>, deps: ApiDeps): void {
  const lb = deps.legalBody;
  if (!lb) return;
  const now = () => (deps.now ?? Date.now)();
  const memo = new AnswerMemo<LookupAnswer>(MEMO_TTL_MS, MEMO_MAX_ENTRIES, now);
  const clientBucket = createClientLimiter(deps);
  const readBudget = sharedReadBudget(deps);
  /** When the last throttle line was written, so a sustained drain costs one line per minute. */
  let throttleLoggedAt: number | undefined;

  /** The same refusal whichever budget ran out — a caller learns that it should slow down, never
   *  which of our limits it is standing in front of — plus at most one ops line per window. */
  const throttled = (c: Context, bucket: "client" | "shared") => {
    const at = now();
    if (throttleLoggedAt === undefined || at - throttleLoggedAt >= THROTTLE_LOG_WINDOW_MS) {
      throttleLoggedAt = at;
      // WHICH budget, never who: the address is the caller's, and the key is an IP.
      opsLog("legal_body_lookup_throttled", { bucket });
    }
    c.header("Cache-Control", NO_STORE);
    return c.json(RATE_LIMITED_BODY, 429);
  };

  /** A DATABASE read failed, so we cannot tell whether the address is one of ours at all: the
   *  route's flat 503, never memoised and never reused. */
  const unavailable = (c: Context) => {
    c.header("Cache-Control", NO_STORE);
    return c.json(UNAVAILABLE_BODY, 503);
  };

  app.get("/legal-bodies/:address", async (c) => {
    const supplied = c.req.param("address");
    // EIP-55 or lowercase, and nothing else (D3). `getAddress` alone would NOT do it: viem
    // checksums without validating, so a caller's single mistyped case would silently become a
    // different address and come back as "not a legal body" — an answer they would act on.
    if (!isAddress(supplied, { strict: true })) {
      c.header("Cache-Control", NO_STORE);
      return c.json(
        {
          error: "validation_error",
          message:
            "address must be a 20-byte hex address, either all-lowercase or EIP-55 checksummed",
        },
        400,
      );
    }
    const address = getAddress(supplied);
    const key = address.toLowerCase();

    const hit = memo.get(key);
    if (hit !== undefined) {
      // A memo hit is a definitive answer by construction (`unknown` is never stored), so it
      // carries the same freshness as the read that produced it — and it costs a token from
      // NEITHER bucket, which is what lets a refreshing page ride the memo instead of a 429.
      c.header("Cache-Control", FRESH_CACHE_CONTROL);
      return c.json(hit);
    }
    // Both budgets are spent on a MISS ONLY, like the AgentBook status route's read budget: they
    // exist to bound the CHAIN READS, and a memo hit makes none. The caller's own allowance is
    // asked first, so a scanner runs itself out before it can touch the shared one.
    if (!clientBucket(c).take()) return throttled(c, "client");
    if (!readBudget.take()) return throttled(c, "shared");

    let resolved: LegalBodyResolution;
    try {
      resolved = await lb.resolver.resolve(address);
    } catch {
      // Only the LOCAL read can throw: `readStanding` catches every chain failure and returns
      // `unknown` (payments/legalBody.ts). So this is the database being unavailable, and with it
      // we cannot tell whether the address is one of ours at all — which `standing` has no value
      // for, and `legalBody: false` would be a lie. 503, in this route's flat error shape rather
      // than the house envelope a thrown error would have produced.
      return unavailable(c);
    }
    // A MINIMAL legal body: asked only for an address the full product does not know, and only
    // where the statement is wired, so every full-product answer stays exactly as it was. The
    // statement service answers a failed chain read with `unknown` and lets a failed database
    // read throw, which is this route's 503 like the resolver's.
    const statements = deps.legalBodyStatements;
    let minimal: StatementOutcome = { kind: "none" };
    if (resolved.kind === "none" && statements) {
      try {
        minimal = await statementForAddress(statements, address);
      } catch (e) {
        opsLog("legal_body_statement_db_failed", { errorName: errorNameOf(e) });
        return unavailable(c);
      }
    }
    const checkedAt = new Date(now()).toISOString();
    const answer: LookupAnswer =
      statements && minimal.kind !== "none"
        ? minimalAnswer(lb, statements.links.statementBase, address, minimal, checkedAt)
        : resolved.kind === "none"
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
              formation: formationOf(lb, resolved.entity),
              checkedAt,
            };

    // DEFINITIVE answers only (D8). "Not one of ours" is definitive too — it is a local read that
    // asked the chain nothing — so it is memoised like the rest; `unknown` never is. A Minimal
    // body's signed statement is definitive whatever standing it states: only the unsigned
    // `unknown` of a failed chain read is not an answer.
    const definitive =
      !(resolved.kind === "body" && resolved.standing === "unknown") && minimal.kind !== "unknown";
    if (definitive) memo.set(key, answer);

    // One line per MISS (a hit costs nothing and says nothing new). No address: this is a
    // high-volume public route and the two fields that matter for ops — which index matched and
    // what the chain said — keep the line short and greppable. A Minimal body is matched by its
    // statement.
    opsLog("legal_body_lookup", {
      matchedBy:
        resolved.kind === "body"
          ? resolved.matchedBy
          : minimal.kind === "none"
            ? "none"
            : "statement",
      standing: answer.standing,
    });
    // `unknown` is not an answer anything may reuse — it is the absence of one (D8).
    c.header("Cache-Control", definitive ? FRESH_CACHE_CONTROL : NO_STORE);
    return c.json(answer);
  });
}
