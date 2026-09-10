import type { AgentkitExtension } from "@worldcoin/agentkit";
import type { AgentkitSigner } from "../adapters/worldid/agentkitSigner";
import type { Address } from "../types";

/** The header (and the 402/403 `extensions` key) AgentKit uses, verified against
 *  `@worldcoin/agentkit-core` (`var AGENTKIT = "agentkit"`, dist/cjs/index.js) — the same constant
 *  the SDK's own client sets on its retry and our seller reads with `c.req.header("agentkit")`. */
const AGENTKIT = "agentkit";

/** Lazily loaded, exactly as worldVerifier.ts does it: the ~8 MB SDK is only paid for by a buy
 *  that actually meets a strict wall, and one load serves the process. */
let agentkitMod: Promise<typeof import("@worldcoin/agentkit")> | undefined;
const loadAgentkit = () => {
  agentkitMod ??= import("@worldcoin/agentkit");
  return agentkitMod;
};

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
}

/** The AgentKit challenge a strict seller puts in its 403 body, if there is a usable one.
 *  Mirrors the SDK client's own `isAgentkitExtension` guard (dist/cjs/index.js) so a body that
 *  would only make `createHeader` throw never gets that far. Body is read from a CLONE: the
 *  original response is what the caller gets back when we decide not to recover. */
async function agentkitChallenge(res: Response): Promise<AgentkitExtension | null> {
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return null; // not JSON — an ordinary 403, nothing to answer
  }
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

/** Sign the challenge with the agent's pocket key and return the `agentkit` header value, or null
 *  if the proof cannot be made (SDK unavailable, or the challenge supports no chain/scheme this
 *  signer has). `createAgentkitClient(...).createHeader` is the SAME minting path the wrapped
 *  fetch uses for a 402 — we only call it ourselves because that wrapper ignores 403s.
 *  Fail-soft on purpose: a buy must never break because the World layer is unavailable; the
 *  caller then returns the seller's untouched refusal. */
async function mintProof(signer: AgentkitSigner, ext: AgentkitExtension, fetchImpl: typeof fetch) {
  try {
    const { createAgentkitClient } = await loadAgentkit();
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
 * continue down the normal 402 path. Throws `resource-403-after-proof: …` if that retry is refused
 * too, quoting the seller so the caller's failure reason names what is missing.
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
  if (response.status === 403 && d.agentkitSigner) {
    const ext = await agentkitChallenge(response);
    const proof = ext ? await mintProof(d.agentkitSigner, ext, d.fetchImpl) : null;
    if (proof) {
      extra = { ...extra, [AGENTKIT]: proof };
      response = await d.fetchImpl(url, { ...init, headers: extra });
      // Refused WITH a valid proof in hand: retrying cannot help, so this is terminal — but the
      // seller just told us exactly what is missing, and that has to reach the user.
      if (response.status === 403) throw new Error(await refusedAfterProof(response));
    }
  }
  // A 403 we could not (or must not) answer stays exactly as terminal as it was before.
  if (response.status !== 402) return response;

  const body = (await response.json()) as { accepts: X402Accept[] };
  const req = body.accepts[0];
  if (!req) throw new Error("402 had no payment requirements");

  const amount = BigInt(req.maxAmountRequired);
  if (d.maxAmount !== undefined && amount > d.maxAmount) {
    throw new Error("policy-denied: amount-exceeds-declared");
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

  // `extra` still carries the proof when one was minted: re-minting it (or dropping it) would cost
  // the human a second allowance unit and, at a strict wall, be refused outright.
  const headers = { ...extra, "X-PAYMENT": decision.header };
  return d.fetchImpl(url, { ...init, headers });
}
