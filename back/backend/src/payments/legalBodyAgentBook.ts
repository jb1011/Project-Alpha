/**
 * A drop-in AgentBook checker that asks BOTH questions before it answers one.
 *
 * AgentKit's hooks take any object with `lookupHuman(address): Promise<string | null>` and treat a
 * non-null answer as "a verified unique human vouches for this address". Wrap the real AgentBook
 * verifier in this and the same object answers a stricter question: is there a human AND is this
 * address the payment address of a Novi legal body in good standing? Anything less is `null`,
 * because `null` is the only refusal shape AgentKit understands.
 *
 * THIS FILE IS MEANT TO BE COPIED. It imports nothing — not from this backend, not from npm — and
 * uses only the global `fetch` (injectable for tests). Drop it into any seller and it works.
 *
 * WHAT YOU MAY SAY WHEN THIS RETURNS AN ID (the claims ceiling, design 2026-09-10 D7). The lookup
 * reports what the chain says and nothing more, so the honest sentence is:
 *
 *     "a registered legal body in good standing stands behind this address"
 *
 * plus the agent id the lookup returned, if you want to name it. Never "verified company", never
 * "KYC'd", never "licensed", never "audited": the on-chain status carries none of that. A standing
 * of "unknown" is a read that failed — show it as unknown, never as a yes and never as a no. And
 * nothing here says WHO vouched for the agent: the human identifier is anonymous by construction.
 *
 * SPOOFING. This proves a property of an ADDRESS, so only ask it about an address someone has just
 * proved they control — the signer recovered from the AgentKit proof. That is what AgentKit hands
 * `lookupHuman`, which is why wrapping the verifier is safe. Calling the lookup with an address
 * from a request body, a query string or a form field proves nothing at all: anyone can name a
 * legal body they do not control.
 */

export interface LegalBodyAgentBookOptions {
  /** The real AgentBook verifier — `createAgentBookVerifier()` from `@worldcoin/agentkit-core`, or
   *  anything else with the same one-method shape. */
  agentBook: { lookupHuman(address: string): Promise<string | null> };
  /** Origin (and optional path prefix) the public lookup is served from; a trailing slash is fine.
   *  The request is `GET <lookupBaseUrl>/legal-bodies/<address>`. */
  lookupBaseUrl: string;
  /** Test seam / custom transport. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** How long to wait for the lookup before answering `null`. Default 5000 ms. */
  timeoutMs?: number;
}

/** What the checker reads out of the lookup's 200 body. Every other field is ignored, so the
 *  response can grow without breaking a copy of this file. */
interface LegalBodyLookupResponse {
  legalBody?: unknown;
  standing?: unknown;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export function createLegalBodyAgentBook(opts: LegalBodyAgentBookOptions): {
  lookupHuman(address: string): Promise<string | null>;
} {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // One trailing slash on the base and one leading slash on the path would give "//legal-bodies",
  // which some routers 404 and others redirect (losing the Accept header on the way).
  const base = opts.lookupBaseUrl.replace(/\/+$/, "");

  async function askLookup(address: string, humanId: string): Promise<string | null> {
    const url = `${base}/legal-bodies/${encodeURIComponent(address)}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // The timeout is raced rather than left to the signal alone: a transport that ignores
      // `signal` (a mock, an old polyfill, a proxying wrapper) would otherwise hang the seller's
      // request forever. Aborting as well means the real fetch also stops doing work.
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
      });
      const answered = (async (): Promise<string | null> => {
        const res = await doFetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        // Only a 200 is an answer. A 400 (bad address), a 404, a 5xx, a redirect, a 204: all of
        // them mean "we did not learn anything", which is `null`.
        if (!res || res.status !== 200) return null;
        const body = (await res.json()) as LegalBodyLookupResponse | null;
        if (!body || typeof body !== "object") return null;
        // Both fields, both exact. `legalBody: true` with any other standing is a body that is
        // suspended, dissolved, or whose chain read failed — none of which is a yes.
        return body.legalBody === true && body.standing === "active" ? humanId : null;
      })().catch(() => null); // a rejection after the timeout won must not go unhandled
      return await Promise.race([answered, timeout]);
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    /**
     * The human id, but only for an address a legal body in good standing stands behind.
     * Never throws: every doubt — no human, a failed AgentBook read, a non-200, an unparseable
     * body, a timeout, a network error — is `null`, and AgentKit refuses fail-closed.
     */
    async lookupHuman(address: string): Promise<string | null> {
      let humanId: string | null;
      try {
        humanId = await opts.agentBook.lookupHuman(address);
      } catch {
        return null;
      }
      if (!humanId) return null;
      const human = humanId;
      try {
        return await askLookup(address, human);
      } catch {
        return null;
      }
    },
  };
}
