import type { AgentkitExtension } from "@worldcoin/agentkit";
import type { AgentkitSigner } from "../adapters/worldid/agentkitSigner";
import type { Address } from "../types";
import { loadAgentkitSdk } from "./agentkitSdk";

/** The header (and the 402/403 `extensions` key) AgentKit uses, verified against
 *  `@worldcoin/agentkit-core` (`var AGENTKIT = "agentkit"`, dist/cjs/index.js) — the same constant
 *  the SDK's own client sets on its retry and our seller reads with `c.req.header("agentkit")`. */
const AGENTKIT = "agentkit";

export interface X402Accept {
  payTo: Address;
  maxAmountRequired: string; // atomic USDC
  asset: Address;
  network: string;
  maxTimeoutSeconds: number;
}

export type AuthorizeFn = (req: {
  payee: Address;
  amount: bigint;
  resource: string;
  asset: Address;
  network: string;
  maxTimeoutSeconds: number;
}) => Promise<{ ok: true; header: string; ledgerId: number } | { ok: false; reason: string }>;

export interface BuyerDeps {
  fetchImpl: typeof fetch;
  authorize: AuthorizeFn; // calls the Authority (HTTP) or authorizePayment directly
  /** Optional price ceiling (atomic USDC). If the 402's maxAmountRequired exceeds this, the buy is
   *  denied BEFORE authorize is ever called — a pre-sign, release-safe failure. */
  maxAmount?: bigint;
  /** Fires EXACTLY ONCE, right after authorize returns `ok` and before the X-PAYMENT retry fetch —
   *  i.e. the moment the payment is authorized/"signed". Callers use this to distinguish a
   *  never-signed failure (safe to release the idempotency claim) from a signed-but-unconfirmed
   *  outcome (must NOT release, to avoid a blind re-sign on retry). Receives the ledger row id so
   *  callers can settle it once the payment is confirmed. */
  onAuthorized?: (ledgerId: number) => void;
  /** The agent's AgentKit signer (its pocket identity), present only when the World layer is
   *  configured. Its ONLY use here is answering a strict seller's 403 challenge (the strict-wall
   *  recovery in `buyWithX402`). The 402 case belongs to the AgentKit client wrapped around
   *  `fetchImpl`; the buyer never pre-empts it. Signing a challenge moves no funds. */
  agentkitSigner?: AgentkitSigner;
  /** The same fetch as `fetchImpl` but WITHOUT the AgentKit client wrapped around it.
   *
   *  Used only once the buyer has taken over the proof itself (after a strict wall's 403). From
   *  there the wrapper is not merely redundant, it is expensive: it answers ANY 402 carrying the
   *  extension by minting its own proof and re-fetching, and it cannot know our request already
   *  carried one — so the seller charges the human a second unit for a request nobody needed. With
   *  the unwrapped fetch a whole purchase costs one unit: the 402 that quotes it.
   *
   *  Optional and inert by default: without it the recovery legs fall back to `fetchImpl`, which
   *  is exactly what they did before. */
  directFetch?: typeof fetch;
}

/** The AgentKit challenge a seller put in a 402/403 body, if there is a usable one.
 *  Mirrors the SDK client's own `isAgentkitExtension` guard (dist/cjs/index.js) so a body that
 *  would only make `createHeader` throw never gets that far. */
function challengeIn(body: unknown): AgentkitExtension | null {
  const ext = (body as { extensions?: Record<string, unknown> } | null)?.extensions?.[AGENTKIT] as
    | (AgentkitExtension & { info?: Record<string, unknown> })
    | undefined;
  const info = ext?.info;
  const ok =
    !!ext &&
    !!info &&
    typeof info === "object" &&
    typeof info.domain === "string" &&
    typeof info.uri === "string" &&
    typeof info.version === "string" &&
    typeof info.nonce === "string" &&
    typeof info.issuedAt === "string" &&
    Array.isArray(ext.supportedChains);
  return ok ? (ext as AgentkitExtension) : null;
}

/** Same, from a response — read through a CLONE so the original body is intact for the caller we
 *  hand it back to when we decide not to recover. */
async function agentkitChallenge(res: Response): Promise<AgentkitExtension | null> {
  try {
    return challengeIn(await res.clone().json());
  } catch {
    return null; // not JSON — an ordinary refusal, nothing to answer
  }
}

/** The signature the buyer is about to make is a SIWE login for whatever `domain`/`uri` the
 *  challenge names, and the seller writes those. Unchecked, a hostile or compromised seller can
 *  have our pocket key sign a login for someone else's site and replay it there. So: the challenge
 *  must name the host we are actually buying from — the same check our own seller makes on the way
 *  in (`agentkit-core` compares `message.domain` with the resource hostname and matches the URI
 *  host). Fail CLOSED: an unparseable resource url or challenge uri is a mismatch, not a pass. */
function assertChallengeOrigin(ext: AgentkitExtension, url: string): void {
  const clip = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : "");
  const info = ext.info as unknown as { domain?: unknown; uri?: unknown };
  const domain = clip(info.domain);
  const uri = clip(info.uri);
  const mismatch = (why: string) =>
    new Error(`challenge-origin-mismatch: ${why} (challenge domain "${domain}", uri "${uri}")`);

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw mismatch("the resource url has no origin to compare against");
  }
  if (domain !== target.hostname && domain !== target.host)
    throw mismatch(`the challenge is for another site, not ${target.host}`);
  if (uri) {
    let uriHost: string;
    try {
      uriHost = new URL(uri).host;
    } catch {
      throw mismatch("the challenge uri is not a url");
    }
    if (uriHost !== target.host) throw mismatch(`the challenge uri points at ${uriHost}`);
  }
}

/** Sign the challenge with the agent's pocket key and return the `agentkit` header value, or null
 *  if the proof cannot be made (SDK unavailable, or the challenge supports no chain/scheme this
 *  signer has). `createAgentkitClient(...).createHeader` is the SAME minting path the wrapped
 *  fetch uses for a 402 — we only call it ourselves because that wrapper ignores 403s.
 *  Fail-soft on purpose: a buy must never break because the World layer is unavailable; the
 *  caller then returns the seller's untouched refusal. */
async function mintProof(signer: AgentkitSigner, ext: AgentkitExtension, fetchImpl: typeof fetch) {
  try {
    const { createAgentkitClient } = await loadAgentkitSdk();
    // `fetch` is passed only so a client of ours never holds globalThis.fetch; createHeader is
    // pure signing and makes no request.
    return await createAgentkitClient({ signer, fetch: fetchImpl }).createHeader(ext);
  } catch {
    return null;
  }
}

interface SellerRefusalBody {
  error?: unknown;
  reason?: unknown;
  detail?: unknown;
}

/** The refusal a seller gives to an agent that ALREADY proved its human backing: quote it, so the
 *  reason a user reads names the missing thing (e.g. `legal_body_required` -> "get a legal body")
 *  instead of a bare `resource-403`. Fields are truncated: this string ends up in a ledger row and
 *  in the MCP `pay` output, and the text comes from someone else's server. */
async function refusedAfterProof(res: Response): Promise<string> {
  const base = "resource-403-after-proof";
  let body: SellerRefusalBody | null = null;
  try {
    body = (await res.clone().json()) as SellerRefusalBody;
  } catch {
    return base;
  }
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : "");
  const error = str(body?.error);
  const reason = str(body?.reason);
  const detail = str(body?.detail);
  if (!error && !detail) return base;
  return `${base}: ${error || "refused"}${reason ? ` (${reason})` : ""}${detail ? `: ${detail}` : ""}`;
}

/**
 * Fetch a paywalled resource. On 402, ask the Authority to authorize the required payment; on allow,
 * retry with the X-PAYMENT header. The agent never signs — it can only ask the Authority.
 *
 * On 403 with an AgentKit challenge in the body (a STRICT seller: `accountable-only` /
 * `legal-bodies-only`), mint the human-backing proof once and retry the same request with it, then
 * continue down the normal 402 path — minting a SECOND, fresh proof for the paying request, since
 * a proof is single-use at the seller. Throws `resource-403-after-proof: …` if the retry is refused
 * too, quoting the seller so the caller's failure reason names what is missing, and
 * `challenge-origin-mismatch: …` if a challenge names a site other than the one being bought from.
 */
export async function buyWithX402(
  d: BuyerDeps,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  // Headers we add ourselves, on top of whatever the caller passed. Starts as a copy of
  // init.headers so the paid retry below is byte-identical to what it always was when no strict
  // wall is involved.
  let extra: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  const first = await d.fetchImpl(url, init);

  // ── strict-wall recovery ────────────────────────────────────────────────────────────────────
  // `accountable-only` and `legal-bodies-only` sellers answer a PROOFLESS request with 403 (never
  // 402 — payment would not help) and put the AgentKit challenge in the refusal body, precisely so
  // a capable buyer can fix its situation from the refusal alone. The AgentKit client wrapped
  // around fetchImpl only reacts to 402s, so this is the one place that can answer.
  //
  // Rules, all load-bearing:
  //   * NEVER on the first request — a non-strict but AgentKit-aware seller would spend one of the
  //     human's allowance units on every purchase we make.
  //   * at most ONE recovery per purchase; a second 403 is terminal.
  //   * nothing is signed for payment and no allowance is committed here: the proof only unlocks
  //     the RIGHT to buy, and the 402 -> authorize -> pay path below is untouched.
  let response = first;
  /** Did WE answer a challenge to get here? Only then does the paying request need a proof of its
   *  own — a plain 402 seller's flow is left exactly as it was. */
  let proved = false;
  /** Once we are minting proofs ourselves, go around the AgentKit wrapper (see `directFetch`).
   *  The FIRST request never uses this: a non-strict seller's 402 is the wrapper's job. */
  const ownFetch = d.directFetch ?? d.fetchImpl;
  if (response.status === 403 && d.agentkitSigner) {
    const ext = await agentkitChallenge(response);
    if (ext) assertChallengeOrigin(ext, url);
    const proof = ext ? await mintProof(d.agentkitSigner, ext, ownFetch) : null;
    if (proof) {
      proved = true;
      extra = { ...extra, [AGENTKIT]: proof };
      response = await ownFetch(url, { ...init, headers: extra });
      // Refused WITH a valid proof in hand: retrying cannot help, so this is terminal — but the
      // seller just told us exactly what is missing, and that has to reach the user.
      if (response.status === 403) throw new Error(await refusedAfterProof(response));
    }
  }
  // A 403 we could not (or must not) answer stays exactly as terminal as it was before.
  if (response.status !== 402) return response;

  const body = (await response.json()) as {
    accepts: X402Accept[];
    extensions?: Record<string, unknown>;
  };
  const req = body.accepts[0];
  if (!req) throw new Error("402 had no payment requirements");

  const amount = BigInt(req.maxAmountRequired);
  if (d.maxAmount !== undefined && amount > d.maxAmount) {
    throw new Error("policy-denied: amount-exceeds-declared");
  }

  // An AgentKit proof is SINGLE-USE at the seller: the nonce is consumed by the first verify
  // (worldVerifier's `checkNonce` -> worldStore, "one header is good for exactly one verify"), so
  // replaying the recovery proof on the paying request is refused as a replay — after the payment
  // has been signed. Every 402 carries a fresh challenge for exactly this reason; mint from it.
  // Done BEFORE `authorize` so a mint that cannot happen costs no signature and leaves the
  // idempotency claim releasable.
  if (proved && d.agentkitSigner) {
    const next = challengeIn(body);
    if (!next) return response; // strict seller with no challenge to answer: nothing safe to send
    assertChallengeOrigin(next, url);
    const fresh = await mintProof(d.agentkitSigner, next, ownFetch);
    if (!fresh) return response; // fail-soft, exactly as on the 403: nothing signed, no payment
    extra = { ...extra, [AGENTKIT]: fresh };
  }

  const decision = await d.authorize({
    payee: req.payTo,
    amount,
    resource: url,
    asset: req.asset,
    network: req.network,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
  });
  if (!decision.ok) throw new Error(`policy-denied: ${decision.reason}`);
  d.onAuthorized?.(decision.ledgerId);

  // `extra` carries the FRESH proof when this purchase went through a strict wall (the spent one
  // would be refused as a replay), and nothing but the caller's own headers otherwise.
  const headers = { ...extra, "X-PAYMENT": decision.header };
  // Same fetch that carried the proof: the wrapper would answer a settle-failed 402 with a proof
  // of its own, charging the human for it.
  return (proved ? ownFetch : d.fetchImpl)(url, { ...init, headers });
}
