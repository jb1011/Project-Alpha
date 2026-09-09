/**
 * The USDC domain PIN (design 2026-08-26 §6.1).
 *
 * `name` and `version` are two strings on somebody else's predeploy, and they are the difference
 * between a signature that settles and one that reverts. Getting them wrong is invisible until a
 * guardian has signed — our own verification would pass, because it would be checking against the
 * same wrong domain we asked them to sign — so they are READ and then CHECKED against the token's
 * own DOMAIN_SEPARATOR.
 */
import { type Hex as ViemHex, hashDomain } from "viem";
import { expect, test } from "vitest";
import {
  CANCEL_AUTHORIZATION_TYPES,
  DEFAULT_RESOLVE_LOOKBACK,
  FIAT_TOKEN_ABI,
  LOG_WINDOW_LADDER,
  MAX_RESOLVE_LOOKBACK,
  readAuthorizationState,
  readUsdcDomain,
  resolveAuthorizationOutcome,
} from "../../../src/adapters/arc/usdcToken";
import type { Address, Hex } from "../../../src/types";

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const CHAIN = 5042002;

const EIP712_DOMAIN_TYPE = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
} as const;

function separatorFor(name: string, version: string): ViemHex {
  return hashDomain({
    domain: { name, version, chainId: BigInt(CHAIN), verifyingContract: USDC },
    types: EIP712_DOMAIN_TYPE,
  });
}

/** A public client stub that answers exactly the three reads `readUsdcDomain` makes. */
function tokenAt(answers: { name: string; version: string; separator: ViemHex }) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "name") return answers.name;
      if (functionName === "version") return answers.version;
      if (functionName === "DOMAIN_SEPARATOR") return answers.separator;
      throw new Error(`unexpected read: ${functionName}`);
    },
    // biome-ignore lint/suspicious/noExplicitAny: a three-method stub of viem's PublicClient
  } as any;
}

test("reads name/version off the token and returns them as the domain", async () => {
  const domain = await readUsdcDomain(
    tokenAt({ name: "USD Coin", version: "2", separator: separatorFor("USD Coin", "2") }),
    USDC,
    CHAIN,
  );
  expect(domain).toEqual({
    name: "USD Coin",
    version: "2",
    chainId: CHAIN,
    verifyingContract: USDC,
  });
});

test("nothing is hardcoded: a token calling itself something else is honoured, not corrected", async () => {
  // The point of reading rather than assuming. Arc's predeploy is Circle's FiatTokenV2_2, but the
  // strings are that deployment's business, and a guardian signs whatever the token says it is.
  const domain = await readUsdcDomain(
    tokenAt({ name: "Bridged USDC", version: "1", separator: separatorFor("Bridged USDC", "1") }),
    USDC,
    CHAIN,
  );
  expect(domain).toMatchObject({ name: "Bridged USDC", version: "1" });
});

test("REFUSES when the computed separator does not match the token's own", async () => {
  // Every way this can happen is a way a signature would revert on-chain AFTER the guardian
  // approved it: a different EIP-712 layout, a salt, a proxy pointing elsewhere. Refusing to
  // quote is the honest answer.
  await expect(
    readUsdcDomain(
      tokenAt({ name: "USD Coin", version: "2", separator: separatorFor("USD Coin", "1") }),
      USDC,
      CHAIN,
    ),
  ).rejects.toThrow(/USDC domain pin failed/);
});

test("the pin is chain-bound: the right strings on the wrong chain still refuse", async () => {
  await expect(
    readUsdcDomain(
      tokenAt({ name: "USD Coin", version: "2", separator: separatorFor("USD Coin", "2") }),
      USDC,
      // A domain separator commits to the chain id, so a box pointed at a different chain than
      // the token it is reading cannot silently produce signatures for the wrong network.
      1,
    ),
  ).rejects.toThrow(/USDC domain pin failed/);
});

test("authorizationState is read with the authorizer and the nonce, and returns the raw bool", async () => {
  const seen: unknown[] = [];
  const client = {
    readContract: async (args: { functionName: string; args: unknown[] }) => {
      seen.push(args);
      return true;
    },
    // biome-ignore lint/suspicious/noExplicitAny: one-method stub
  } as any;
  const used = await readAuthorizationState(
    client,
    USDC,
    "0x00000000000000000000000000000000000000Ab" as Address,
    `0x${"a1".repeat(32)}` as Hex,
  );
  expect(used).toBe(true);
  expect(seen[0]).toMatchObject({
    functionName: "authorizationState",
    args: ["0x00000000000000000000000000000000000000Ab", `0x${"a1".repeat(32)}`],
  });
});

test("the ABI declares only the `bytes signature` overloads, and both cancel + state", () => {
  // FiatTokenV2_2 overloads transferWithAuthorization and cancelAuthorization on (v,r,s). With
  // both declared, viem needs an explicit overload selection at every call site; the `bytes` form
  // is the one a browser wallet's signature drops straight into.
  const byName = (n: string) => FIAT_TOKEN_ABI.filter((f) => f.name === n);
  expect(byName("transferWithAuthorization")).toHaveLength(1);
  expect(byName("cancelAuthorization")).toHaveLength(1);
  expect(byName("transferWithAuthorization")[0]?.inputs.at(-1)).toMatchObject({ type: "bytes" });
  expect(byName("authorizationState")).toHaveLength(1);
});

test("CancelAuthorization is (authorizer, nonce) — what FiatTokenV2_2 hashes", () => {
  expect(CANCEL_AUTHORIZATION_TYPES.CancelAuthorization).toEqual([
    { name: "authorizer", type: "address" },
    { name: "nonce", type: "bytes32" },
  ]);
});

// ── resolveAuthorizationOutcome (B1 gate A3) ───────────────────────────────────────────────
//
// What happened to (authorizer, nonce)? Answered from the TOKEN's logs rather than from the
// receipt of a transaction we happened to send — because a signed authorization is public, and
// the transaction that settles it need not be ours.

const AUTHORIZER = "0x000000000000000000000000000000000000000A" as Address;
const PAYEE = "0x000000000000000000000000000000000000bEEF" as Address;
const NONCE = `0x${"a1".repeat(32)}` as Hex;
const VALUE = 399_000_000n;

interface StubLog {
  name: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
}

/** A client that serves logs and remembers every range it was ASKED for — which is the property
 *  under test as much as the verdict is. */
function logChain(logs: StubLog[], opts: { head?: bigint; rejectWider?: bigint } = {}) {
  const asked: Array<{ event: string; from: bigint; to: bigint }> = [];
  const client = {
    getBlockNumber: async () => opts.head ?? 1_000_000n,
    getLogs: async (q: {
      event: { name: string };
      args?: Record<string, unknown>;
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      asked.push({ event: q.event.name, from: q.fromBlock, to: q.toBlock });
      // The live lesson: an endpoint REJECTS a window it considers too wide, and the ceiling
      // differs per endpoint. The reader must walk down rather than fail.
      if (opts.rejectWider !== undefined && q.toBlock - q.fromBlock + 1n > opts.rejectWider)
        throw new Error("-32012 requested range too large");
      return logs.filter(
        (l) =>
          l.name === q.event.name &&
          l.blockNumber >= q.fromBlock &&
          l.blockNumber <= q.toBlock &&
          Object.entries(q.args ?? {}).every(
            ([k, v]) => String(l.args[k]).toLowerCase() === String(v).toLowerCase(),
          ),
      );
    },
    // biome-ignore lint/suspicious/noExplicitAny: a two-method stub of viem's PublicClient
  } as any;
  return { client, asked };
}

function settlement(txHash: Hex, block = 999_000n, value = VALUE): StubLog[] {
  return [
    {
      name: "AuthorizationUsed",
      args: { authorizer: AUTHORIZER, nonce: NONCE },
      blockNumber: block,
      transactionHash: txHash,
    },
    {
      name: "Transfer",
      args: { from: AUTHORIZER, to: PAYEE, value },
      blockNumber: block,
      transactionHash: txHash,
    },
  ];
}

const resolve = (client: unknown, fromBlock: bigint | null = 998_000n) =>
  resolveAuthorizationOutcome({
    // biome-ignore lint/suspicious/noExplicitAny: the stub above
    client: client as any,
    usdc: USDC,
    authorizer: AUTHORIZER,
    nonce: NONCE,
    payTo: PAYEE,
    value: VALUE,
    fromBlock,
  });

test("AuthorizationUsed + a matching Transfer is a SETTLEMENT, whoever sent it", async () => {
  const txHash = `0x${"ab".repeat(32)}` as Hex;
  const { client } = logChain(settlement(txHash));
  expect(await resolve(client)).toMatchObject({ kind: "settled", txHash });
});

test("AuthorizationCanceled is CANCELLED — and is answered before anything else is asked", async () => {
  const { client, asked } = logChain([
    {
      name: "AuthorizationCanceled",
      args: { authorizer: AUTHORIZER, nonce: NONCE },
      blockNumber: 999_000n,
      transactionHash: `0x${"cd".repeat(32)}` as Hex,
    },
  ]);
  expect(await resolve(client)).toMatchObject({ kind: "cancelled" });
  // A cancelled authorization can never have a matching transfer, so the other two queries are
  // work nobody needs.
  expect(asked.every((a) => a.event === "AuthorizationCanceled")).toBe(true);
});

test("a used nonce with NO matching transfer is UNKNOWN — never a settlement of ours", async () => {
  // The log says a nonce was consumed. Only the Transfer says OUR payee got THIS amount, and
  // reading the first as a settlement would ready a company nobody paid for.
  const [used] = settlement(`0x${"ab".repeat(32)}` as Hex);
  const { client } = logChain([used!]);
  expect(await resolve(client)).toEqual({ kind: "unknown" });
});

test("a transfer of the WRONG AMOUNT does not settle the payment", async () => {
  const txHash = `0x${"ab".repeat(32)}` as Hex;
  const { client } = logChain(settlement(txHash, 999_000n, 1n));
  expect(await resolve(client)).toEqual({ kind: "unknown" });
});

test("nothing on-chain is UNKNOWN, which is never a failure", async () => {
  const { client } = logChain([]);
  expect(await resolve(client)).toEqual({ kind: "unknown" });
});

test("the window is BOUNDED even with no hint — never a range from genesis", async () => {
  // The public-RPC lesson. An unbounded `fromBlock: 0` is rejected outright by some endpoints and
  // times out on the rest, and either way the payment stays unresolved.
  const { client, asked } = logChain([], { head: 1_000_000n });
  await resolve(client, null);
  expect(asked.length).toBeGreaterThan(0);
  for (const a of asked) {
    expect(a.from).toBeGreaterThanOrEqual(1_000_000n - DEFAULT_RESOLVE_LOOKBACK);
    expect(a.to - a.from).toBeLessThan(LOG_WINDOW_LADDER[0]!);
  }
});

test("an ANCIENT quoted_block is capped — one payment cannot become a full-chain scan", async () => {
  const { client, asked } = logChain([], { head: 1_000_000n });
  await resolve(client, 1n);
  expect(asked[0]!.from).toBe(1_000_000n - MAX_RESOLVE_LOOKBACK);
});

test("an endpoint that rejects the range makes the reader WALK DOWN the ladder", async () => {
  // Measured live: the box's token'd RPC served 100,000 blocks where the public one refused
  // 50,000 and served 5,000. A hardcoded chunk size produces the worst possible failure — a
  // process that is up, logging, and permanently unable to resolve a payment.
  const txHash = `0x${"ab".repeat(32)}` as Hex;
  const { client, asked } = logChain(settlement(txHash), { rejectWider: 5_000n });
  expect(await resolve(client, 900_000n)).toMatchObject({ kind: "settled" });
  const widths = asked.map((a) => a.to - a.from + 1n);
  expect(widths[0]).toBe(LOG_WINDOW_LADDER[0]);
  expect(widths.some((w) => w <= 5_000n)).toBe(true);
});
