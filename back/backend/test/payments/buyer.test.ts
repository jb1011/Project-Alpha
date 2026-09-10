import { randomBytes } from "node:crypto";
import type { AgentkitExtension } from "@worldcoin/agentkit";
import { expect, test, vi } from "vitest";
import { agentkitSignerFromKey } from "../../src/adapters/worldid/agentkitSigner";
import { buyWithX402 } from "../../src/payments/buyer";
import type { Hex } from "../../src/types";

const requirements = {
  payTo: "0x00000000000000000000000000000000000000ab",
  maxAmountRequired: "100",
  asset: "0x3600000000000000000000000000000000000000",
  network: "eip155:5042002",
  maxTimeoutSeconds: 60,
};

function fakeFetch(seenHeaders: string[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const xp = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"];
    if (!xp) return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    seenHeaders.push(xp);
    return new Response(JSON.stringify({ data: "the insight" }), { status: 200 });
  });
}

test("on 402, authorizes then retries with X-PAYMENT and returns the body", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const res = await buyWithX402(
    { fetchImpl: fakeFetch(seen), authorize },
    "https://seller/api/insight",
  );
  expect(await res.json()).toEqual({ data: "the insight" });
  expect(seen).toEqual(["X-PAYMENT-ok"]);
  expect(authorize).toHaveBeenCalledWith(
    expect.objectContaining({ payee: requirements.payTo, amount: 100n }),
  );
});

test("a policy-denied authorization does not retry and surfaces the denial", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: false as const, reason: "over-cap" }));
  await expect(
    buyWithX402({ fetchImpl: fakeFetch(seen), authorize }, "https://seller/api/insight"),
  ).rejects.toThrow(/policy-denied: over-cap/);
  expect(seen).toEqual([]);
});

test("onAuthorized fires exactly once, after authorize ok and before the X-PAYMENT retry fetch", async () => {
  const seen: string[] = [];
  const order: string[] = [];
  const authorize = vi.fn(async () => {
    order.push("authorize");
    return { ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 };
  });
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const xp = (init?.headers as Record<string, string> | undefined)?.["X-PAYMENT"];
    if (!xp) return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    order.push("retry-fetch");
    seen.push(xp);
    return new Response(JSON.stringify({ data: "the insight" }), { status: 200 });
  });
  const onAuthorized = vi.fn(() => order.push("onAuthorized"));

  await buyWithX402(
    { fetchImpl: fetchImpl as unknown as typeof fetch, authorize, onAuthorized },
    "https://seller/api/insight",
  );

  expect(onAuthorized).toHaveBeenCalledTimes(1);
  expect(order).toEqual(["authorize", "onAuthorized", "retry-fetch"]);
});

test("onAuthorized is never called on a policy-denied authorization", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: false as const, reason: "over-cap" }));
  const onAuthorized = vi.fn();
  await expect(
    buyWithX402(
      { fetchImpl: fakeFetch(seen), authorize, onAuthorized },
      "https://seller/api/insight",
    ),
  ).rejects.toThrow(/policy-denied: over-cap/);
  expect(onAuthorized).not.toHaveBeenCalled();
});

test("surprise-price ceiling: maxAmountRequired above maxAmount is denied before authorize is ever called", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const onAuthorized = vi.fn();
  await expect(
    buyWithX402(
      { fetchImpl: fakeFetch(seen), authorize, maxAmount: 99n, onAuthorized },
      "https://seller/api/insight",
    ),
  ).rejects.toThrow(/policy-denied: amount-exceeds-declared/);
  expect(authorize).not.toHaveBeenCalled();
  expect(onAuthorized).not.toHaveBeenCalled();
  expect(seen).toEqual([]);
});

test("maxAmount at or under the ceiling proceeds normally", async () => {
  const seen: string[] = [];
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const res = await buyWithX402(
    { fetchImpl: fakeFetch(seen), authorize, maxAmount: 100n },
    "https://seller/api/insight",
  );
  expect(res.status).toBe(200);
  expect(seen).toEqual(["X-PAYMENT-ok"]);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Strict-wall recovery (T6). A seller whose policy is `accountable-only` or `legal-bodies-only`
// answers a PROOFLESS first request with 403 — not 402 — and carries the AgentKit challenge in
// the refusal body's `extensions` (seller.ts `refusal()` / `legalRefusal()`). The AgentKit client
// wrapped around our fetch only reacts to 402s, so without this recovery a Novi agent can never
// buy from a strict wall through the product `pay`.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const AGENT_KEY: Hex = `0x${"6".repeat(64)}`;
const WORLD_CHAIN_ID = 480; // AgentBook's chain — the one our agents sign for
const RESOURCE = "https://seller/api/insight";

/** The seller's own challenge, built the way `worldVerifier.mintAgentkitExtension` builds it
 *  (`declareAgentkitExtension` + an alphanumeric nonce, issuedAt and expiry — SIWE rejects a
 *  hyphenated nonce and the client swallows the resulting throw), so what the buyer signs in these
 *  tests is the real shape a strict wall emits. Built from the SDK rather than imported from
 *  worldVerifier so this suite does not drag the seller's dependency graph in. */
async function sellerChallenge(
  origin: { domain: string; resourceUri: string } = { domain: "seller", resourceUri: RESOURCE },
): Promise<{ agentkit: AgentkitExtension }> {
  const { declareAgentkitExtension } = await import("@worldcoin/agentkit");
  const ext = declareAgentkitExtension({
    domain: origin.domain,
    resourceUri: origin.resourceUri,
    network: [requirements.network, `eip155:${WORLD_CHAIN_ID}`],
    statement:
      "Prove this agent is backed by a verified unique human to be authorized on this resource",
  }) as unknown as { agentkit: AgentkitExtension & { info: Record<string, unknown> } };
  const info = ext.agentkit.info;
  info.nonce = randomBytes(16).toString("hex");
  info.issuedAt = new Date().toISOString();
  info.expirationTime = new Date(Date.now() + 5 * 60_000).toISOString();
  return ext as unknown as { agentkit: AgentkitExtension };
}

/** seller.ts `refusal()` — the human gate, verbatim in shape. */
const humanRefusal = (extensions: unknown) => ({
  error: "human_backing_required",
  detail: "this seller trades only with agents a verified unique human answers for",
  reason: "no-proof-presented",
  how: {
    register: "npx @worldcoin/agentkit-cli register <your-agent-address>",
    agentBook: "0xA23aB2712eA7BBa896930544C7d6636a96b944dA",
    chain: "world-chain",
  },
  extensions,
});

/** seller.ts `legalRefusal()` — the SECOND doorway, reached only WITH a valid proof. */
const legalBodyRefusal = (extensions: unknown) => ({
  error: "legal_body_required",
  detail:
    "this seller trades only with agents that a registered legal body in good standing stands behind",
  reason: "not-legal-body",
  how: {
    lookup: "https://api.novicorpus.com/legal-bodies/0x0000000000000000000000000000000000000001",
    onboard: "https://www.novicorpus.com/",
    transparency: "https://www.novicorpus.com/transparency",
  },
  extensions,
});

type SeenCall = { agentkit?: string | undefined; payment?: string | undefined };

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers as Record<string, string> | undefined) ?? {};
}

/** The nonce inside a minted header — what the seller consumes. */
function nonceOf(header: string): string {
  return (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { nonce: string }).nonce;
}

/** A strict wall WITH the seller's real replay rule: `validateAgentkitMessage` consumes the
 *  challenge nonce on first use (worldVerifier.ts `checkNonce` -> worldStore.consumeNonce; "one
 *  header is good for exactly one verify", test/world/sellerGate.test.ts), so a header presented
 *  twice is refused 403. Every response carries its OWN fresh challenge, exactly as `refusal()`
 *  and `challenge()` do — which is what makes re-minting possible. */
function strictWall(seen: SeenCall[], opts: { quoteWithoutChallenge?: boolean } = {}) {
  const spent = new Set<string>();
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const h = headersOf(init);
    seen.push({ agentkit: h.agentkit, payment: h["X-PAYMENT"] });
    const challenge = await sellerChallenge();
    if (!h.agentkit) return new Response(JSON.stringify(humanRefusal(challenge)), { status: 403 });
    if (spent.has(nonceOf(h.agentkit)))
      return new Response(
        JSON.stringify({
          ...humanRefusal(challenge),
          reason: "invalid-message:Nonce validation failed (possible replay attack)",
        }),
        { status: 403 },
      );
    spent.add(nonceOf(h.agentkit));
    if (!h["X-PAYMENT"])
      return new Response(
        JSON.stringify(
          opts.quoteWithoutChallenge
            ? { accepts: [requirements] }
            : { accepts: [requirements], extensions: challenge },
        ),
        { status: 402 },
      );
    return new Response(JSON.stringify({ data: "the insight" }), {
      status: 200,
      headers: { "X-NOVI-LEGAL-BODY": "843704" },
    });
  });
}

test("a strict wall's 403 challenge is answered with a minted proof, then the normal 402 -> pay path runs", async () => {
  const seen: SeenCall[] = [];
  const fetchImpl = strictWall(seen);
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 7 }));

  const res = await buyWithX402(
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      authorize,
      agentkitSigner: agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID),
    },
    RESOURCE,
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ data: "the insight" });
  expect(res.headers.get("X-NOVI-LEGAL-BODY")).toBe("843704");
  expect(seen).toHaveLength(3);
  // 1. NEVER on the first request: an AgentKit-aware seller that is not strict would spend one of
  //    the human's allowance units on every purchase we make.
  expect(seen[0]?.agentkit).toBeUndefined();
  // 2. the recovery request carries the proof and NO payment (nothing is signed to get past a 403)
  expect(typeof seen[1]?.agentkit).toBe("string");
  expect(seen[1]?.payment).toBeUndefined();
  // 3. the paid retry carries a FRESH proof, minted from the 402's own challenge: the recovery
  //    leg spent that nonce, and this stub refuses a replay exactly as the seller does — reusing
  //    it would 403 the purchase AFTER the payment was signed (re-review R1).
  expect(typeof seen[2]?.agentkit).toBe("string");
  expect(seen[2]?.agentkit).not.toBe(seen[1]?.agentkit);
  expect(nonceOf(seen[2]?.agentkit as string)).not.toBe(nonceOf(seen[1]?.agentkit as string));
  expect(seen[2]?.payment).toBe("X-PAYMENT-ok");
  expect(authorize).toHaveBeenCalledTimes(1);

  // The header is a genuinely signed AgentKit payload for OUR pocket address, not a placeholder.
  const payload = JSON.parse(
    Buffer.from(seen[1]?.agentkit as string, "base64").toString("utf8"),
  ) as { address: string; chainId: string; signature: string };
  expect(payload.address).toBe(agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID).address);
  expect(payload.chainId).toBe(`eip155:${WORLD_CHAIN_ID}`);
  expect(payload.signature).toMatch(/^0x[0-9a-f]+$/i);
});

test("a 403 with no agentkit challenge stays terminal, exactly as before", async () => {
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
  );
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const res = await buyWithX402(
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      authorize,
      agentkitSigner: agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID),
    },
    RESOURCE,
  );
  expect(res.status).toBe(403);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(authorize).not.toHaveBeenCalled();
});

test("without an AgentKit signer a challenged 403 stays terminal — nothing to sign with", async () => {
  const challenge = await sellerChallenge();
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify(humanRefusal(challenge)), { status: 403 }),
  );
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const res = await buyWithX402(
    { fetchImpl: fetchImpl as unknown as typeof fetch, authorize },
    RESOURCE,
  );
  expect(res.status).toBe(403);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(authorize).not.toHaveBeenCalled();
});

test("a signer for a chain the challenge does not support falls back to the untouched 403", async () => {
  const challenge = await sellerChallenge();
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify(humanRefusal(challenge)), { status: 403 }),
  );
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const res = await buyWithX402(
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      authorize,
      // eip155:1 is not in the challenge's supportedChains -> createHeader throws
      agentkitSigner: agentkitSignerFromKey(AGENT_KEY, 1),
    },
    RESOURCE,
  );
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: "human_backing_required" });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test("one recovery per purchase: a second 403 is terminal and says the proof was already made", async () => {
  const challenge = await sellerChallenge();
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify(humanRefusal(challenge)), { status: 403 }),
  );
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  await expect(
    buyWithX402(
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        authorize,
        agentkitSigner: agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID),
      },
      RESOURCE,
    ),
  ).rejects.toThrow(/resource-403-after-proof/);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(authorize).not.toHaveBeenCalled();
});

test("a legal-bodies-only wall's refusal surfaces its error and remediation in the failure reason", async () => {
  const challenge = await sellerChallenge();
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    headersOf(init).agentkit
      ? new Response(JSON.stringify(legalBodyRefusal(challenge)), { status: 403 })
      : new Response(JSON.stringify(humanRefusal(challenge)), { status: 403 }),
  );
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const err = await buyWithX402(
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      authorize,
      agentkitSigner: agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID),
    },
    RESOURCE,
  ).catch((e: Error) => e);

  // The whole point: the human proof WORKED and the second door is the legal body, so the reason
  // the MCP `pay` tool prints has to say "get a legal body", not a bare "resource-403".
  expect((err as Error).message).toContain("resource-403-after-proof");
  expect((err as Error).message).toContain("legal_body_required");
  expect((err as Error).message).toContain("not-legal-body");
  expect((err as Error).message).toContain("registered legal body in good standing");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(authorize).not.toHaveBeenCalled();
});

test("a 503 after the proof is returned as a response, not thrown — 'we could not tell' is retryable", async () => {
  const challenge = await sellerChallenge();
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    headersOf(init).agentkit
      ? new Response(JSON.stringify({ error: "legal_body_check_unavailable" }), { status: 503 })
      : new Response(JSON.stringify(humanRefusal(challenge)), { status: 403 }),
  );
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const res = await buyWithX402(
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      authorize,
      agentkitSigner: agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID),
    },
    RESOURCE,
  );
  expect(res.status).toBe(503);
  expect(authorize).not.toHaveBeenCalled();
});

test("a signer changes nothing for a plain 402 seller: the first request still carries no proof", async () => {
  const seen: SeenCall[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const h = headersOf(init);
    seen.push({ agentkit: h.agentkit, payment: h["X-PAYMENT"] });
    if (!h["X-PAYMENT"])
      return new Response(JSON.stringify({ accepts: [requirements] }), { status: 402 });
    return new Response(JSON.stringify({ data: "the insight" }), { status: 200 });
  });
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const res = await buyWithX402(
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      authorize,
      agentkitSigner: agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID),
    },
    RESOURCE,
  );
  expect(res.status).toBe(200);
  // The AgentKit client wrapped around fetchImpl owns the 402 case; the buyer must not pre-empt it.
  expect(seen.every((c) => c.agentkit === undefined)).toBe(true);
});

test("the paid leg's proof is minted from the 402's own challenge, so a wall that consumes nonces still serves", async () => {
  // The same wall as above, driven twice: two purchases, four proofs, no replay refusal anywhere.
  const seen: SeenCall[] = [];
  const fetchImpl = strictWall(seen);
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const deps = {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    authorize,
    agentkitSigner: agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID),
  };
  expect((await buyWithX402(deps, RESOURCE)).status).toBe(200);
  expect((await buyWithX402(deps, RESOURCE)).status).toBe(200);
  const proofs = seen.map((c) => c.agentkit).filter((v): v is string => typeof v === "string");
  expect(proofs).toHaveLength(4);
  expect(new Set(proofs.map(nonceOf)).size).toBe(4);
});

test("a 402 that carries no challenge after we proved is returned untouched — nothing is signed", async () => {
  const seen: SeenCall[] = [];
  const fetchImpl = strictWall(seen, { quoteWithoutChallenge: true });
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  const res = await buyWithX402(
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      authorize,
      agentkitSigner: agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID),
    },
    RESOURCE,
  );
  expect(res.status).toBe(402);
  expect(authorize).not.toHaveBeenCalled();
  expect(seen).toHaveLength(2);
});

test("a challenge naming another site is never signed: terminal challenge-origin-mismatch", async () => {
  const foreign = await sellerChallenge({
    domain: "app.example.com",
    resourceUri: "https://app.example.com/login",
  });
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify(humanRefusal(foreign)), { status: 403 }),
  );
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  await expect(
    buyWithX402(
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        authorize,
        agentkitSigner: agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID),
      },
      RESOURCE,
    ),
  ).rejects.toThrow(/challenge-origin-mismatch/);
  // One request, one refusal, no signature of any kind: a hostile seller gets nothing to replay.
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(authorize).not.toHaveBeenCalled();
});

test("the 402's challenge is origin-checked too, before the payment is authorized", async () => {
  const honest = await sellerChallenge();
  const foreign = await sellerChallenge({
    domain: "app.example.com",
    resourceUri: "https://app.example.com/login",
  });
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
    headersOf(init).agentkit
      ? new Response(JSON.stringify({ accepts: [requirements], extensions: foreign }), {
          status: 402,
        })
      : new Response(JSON.stringify(humanRefusal(honest)), { status: 403 }),
  );
  const authorize = vi.fn(async () => ({ ok: true as const, header: "X-PAYMENT-ok", ledgerId: 1 }));
  await expect(
    buyWithX402(
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        authorize,
        agentkitSigner: agentkitSignerFromKey(AGENT_KEY, WORLD_CHAIN_ID),
      },
      RESOURCE,
    ),
  ).rejects.toThrow(/challenge-origin-mismatch/);
  expect(authorize).not.toHaveBeenCalled();
});
