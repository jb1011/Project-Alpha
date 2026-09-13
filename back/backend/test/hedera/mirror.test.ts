/**
 * The mirror node client, driven entirely by a fake `fetch`.
 *
 * Nothing here touches the network: the mirror node is a read-only REST surface, so a scripted
 * `fetch` is a HONEST fake of it — the only thing a live call would add is latency and flake.
 */
import { expect, test } from "vitest";
import { HederaMirror, MirrorError, mirrorTxId } from "../../src/hedera/mirror";

const BASE = "https://testnet.mirrornode.hedera.com";
const TX = "0.0.7162784@1788998489.006924053";
const TX_PATH = "0.0.7162784-1788998489-006924053";

interface Route {
  status?: number;
  body?: unknown;
}

/** A `fetch` that answers from a path->response script and records every path it was asked for. */
function scriptedFetch(routes: Record<string, Route | Route[]>) {
  const calls: string[] = [];
  const cursor = new Map<string, number>();
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    expect(url.startsWith(BASE)).toBe(true);
    const path = url.slice(BASE.length);
    calls.push(path);
    const entry = routes[path];
    let route: Route | undefined;
    if (Array.isArray(entry)) {
      // A scripted sequence: answer with the nth response, then repeat the last one.
      const nth = cursor.get(path) ?? 0;
      cursor.set(path, nth + 1);
      route = entry[Math.min(nth, entry.length - 1)];
    } else {
      route = entry;
    }
    if (!route) {
      return new Response(JSON.stringify({ _status: { messages: [{ message: "Not found" }] } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const ACCOUNT_BODY = {
  account: "0.0.10412694",
  evm_address: "0x00000000000000000000000000000000009ed596",
  key: {
    _type: "ECDSA_SECP256K1",
    key: "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
  },
};

const TX_BODY = {
  transactions: [
    {
      transaction_id: TX_PATH,
      name: "CRYPTOTRANSFER",
      result: "SUCCESS",
      consensus_timestamp: "1788998499.123456789",
      token_transfers: [
        { token_id: "0.0.429274", account: "0.0.10412694", amount: 1000 },
        { token_id: "0.0.429274", account: "0.0.7162784", amount: -1000 },
      ],
    },
  ],
};

test("mirrorTxId rewrites the @-form and passes the dashed form through", () => {
  expect(mirrorTxId(TX)).toBe(TX_PATH);
  expect(mirrorTxId(TX_PATH)).toBe(TX_PATH);
});

test("account maps key._type, key.key and evm_address", async () => {
  const { impl, calls } = scriptedFetch({
    "/api/v1/accounts/0.0.10412694": { body: ACCOUNT_BODY },
  });
  const got = await new HederaMirror(BASE, impl).account("0.0.10412694");
  expect(got).toEqual({
    account: "0.0.10412694",
    keyHex: "034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa",
    keyType: "ECDSA_SECP256K1",
    evmAddress: "0x00000000000000000000000000000000009ed596",
  });
  expect(calls).toEqual(["/api/v1/accounts/0.0.10412694"]);
});

test("account returns null for an account the mirror node does not know", async () => {
  const { impl } = scriptedFetch({});
  expect(await new HederaMirror(BASE, impl).account("0.0.1")).toBeNull();
});

test("account reports a keyless account as null key rather than omitting the account", async () => {
  const { impl } = scriptedFetch({
    "/api/v1/accounts/0.0.2": { body: { account: "0.0.2", evm_address: null, key: null } },
  });
  expect(await new HederaMirror(BASE, impl).account("0.0.2")).toEqual({
    account: "0.0.2",
    keyHex: null,
    keyType: null,
    evmAddress: null,
  });
});

test("tokenBalance reads tokens[0].balance as a bigint", async () => {
  const { impl, calls } = scriptedFetch({
    "/api/v1/accounts/0.0.10412694/tokens?token.id=0.0.429274": {
      body: { tokens: [{ token_id: "0.0.429274", balance: 12_345_678 }] },
    },
  });
  expect(await new HederaMirror(BASE, impl).tokenBalance("0.0.10412694", "0.0.429274")).toBe(
    12_345_678n,
  );
  expect(calls).toEqual(["/api/v1/accounts/0.0.10412694/tokens?token.id=0.0.429274"]);
});

test("tokenBalance is 0n when the account is not associated with the token", async () => {
  const { impl } = scriptedFetch({
    "/api/v1/accounts/0.0.10412694/tokens?token.id=0.0.429274": { body: { tokens: [] } },
  });
  expect(await new HederaMirror(BASE, impl).tokenBalance("0.0.10412694", "0.0.429274")).toBe(0n);
});

test("transaction maps every record and turns token_transfers[].amount into a bigint", async () => {
  const { impl, calls } = scriptedFetch({ [`/api/v1/transactions/${TX_PATH}`]: { body: TX_BODY } });
  const got = await new HederaMirror(BASE, impl).transaction(TX);
  expect(got).toEqual([
    {
      transactionId: TX_PATH,
      name: "CRYPTOTRANSFER",
      result: "SUCCESS",
      consensusTimestamp: "1788998499.123456789",
      tokenTransfers: [
        { tokenId: "0.0.429274", account: "0.0.10412694", amount: 1000n },
        { tokenId: "0.0.429274", account: "0.0.7162784", amount: -1000n },
      ],
    },
  ]);
  expect(calls).toEqual([`/api/v1/transactions/${TX_PATH}`]);
});

test("transaction returns null when the id is not indexed yet", async () => {
  const { impl } = scriptedFetch({});
  expect(await new HederaMirror(BASE, impl).transaction(TX)).toBeNull();
});

test("a non-200 that is not a 404 throws a typed MirrorError naming path and status", async () => {
  const { impl } = scriptedFetch({ "/api/v1/accounts/0.0.9": { status: 502, body: {} } });
  const err = await new HederaMirror(BASE, impl)
    .account("0.0.9")
    .then(() => null)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MirrorError);
  expect((err as MirrorError).message).toBe("mirror /api/v1/accounts/0.0.9 -> 502");
  expect((err as MirrorError).status).toBe(502);
});

test("waitTransaction polls with the injected sleep until the record appears", async () => {
  const { impl, calls } = scriptedFetch({
    [`/api/v1/transactions/${TX_PATH}`]: [{ status: 404 }, { status: 404 }, { body: TX_BODY }],
  });
  const slept: number[] = [];
  let clock = 0;
  const got = await new HederaMirror(BASE, impl).waitTransaction(TX, {
    timeoutMs: 10_000,
    intervalMs: 250,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  expect(got?.[0]?.result).toBe("SUCCESS");
  expect(calls).toHaveLength(3);
  expect(slept).toEqual([250, 250]);
});

test("waitTransaction returns null once timeoutMs has elapsed", async () => {
  const { impl, calls } = scriptedFetch({});
  let clock = 0;
  const got = await new HederaMirror(BASE, impl).waitTransaction(TX, {
    timeoutMs: 1000,
    intervalMs: 400,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  expect(got).toBeNull();
  // The deadline is checked AFTER each attempt, so the clock reads 0, 400, 800 and 1200: four
  // attempts, the last of which is what discovers the deadline has passed. No fifth.
  expect(calls).toHaveLength(4);
});

test("a trailing slash on the base URL does not double the separator", async () => {
  const { impl, calls } = scriptedFetch({
    "/api/v1/accounts/0.0.10412694": { body: ACCOUNT_BODY },
  });
  await new HederaMirror(`${BASE}/`, impl).account("0.0.10412694");
  expect(calls).toEqual(["/api/v1/accounts/0.0.10412694"]);
});

test("a read that outlives its timeout throws a typed MirrorError instead of hanging", async () => {
  const hang = (async () => new Promise<Response>(() => {})) as typeof fetch;
  const err = await new HederaMirror(BASE, hang, 15)
    .account("0.0.1")
    .then(() => null)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MirrorError);
  expect((err as MirrorError).status).toBeNull();
  expect((err as MirrorError).message).toContain("timed out after 15ms");
});

test("a 200 whose body is not JSON surfaces as a MirrorError, not a bare SyntaxError", async () => {
  const html = (async () =>
    new Response("<html>captive portal</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
  const err = await new HederaMirror(BASE, html)
    .account("0.0.1")
    .then(() => null)
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MirrorError);
  expect((err as MirrorError).message).toBe(
    "mirror /api/v1/accounts/0.0.1 -> unreadable JSON body",
  );
  expect((err as MirrorError).status).toBe(200);
});

test("a failed record keeps the mirror node's own result and has no transfers", async () => {
  const { impl } = scriptedFetch({
    [`/api/v1/transactions/${TX_PATH}`]: {
      body: {
        transactions: [
          {
            transaction_id: TX_PATH,
            name: "CRYPTOTRANSFER",
            result: "INSUFFICIENT_TOKEN_BALANCE",
            consensus_timestamp: "1788998499.123456789",
          },
        ],
      },
    },
  });
  const got = await new HederaMirror(BASE, impl).transaction(TX);
  expect(got?.[0]?.result).toBe("INSUFFICIENT_TOKEN_BALANCE");
  expect(got?.[0]?.tokenTransfers).toEqual([]);
});
