/**
 * WHAT HAPPENS WHILE THE SEND LOCK IS HELD — measured, not asserted from the shape of the code.
 *
 * The lock serialises every platform send, so its window is head-of-line blocking for all of them:
 * whatever is inside it, one sick RPC endpoint delays every fund, seed, bind and policy update
 * behind it. So exactly two calls belong inside — read the pending nonce, hand over the signed
 * bytes — and everything slow (simulate, gas estimation, fee estimation, chain id) belongs before
 * it. Signing itself is offline: the platform account is a local key.
 *
 * These tests use REAL viem clients over a recording transport, so the sequence below is the RPC
 * traffic viem actually produces, and the bound tests use a real local HTTP server that never
 * answers (or throttles), because the bound is a property of the transport, not of our code.
 */
import { createServer } from "node:http";
import {
  http,
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  keccak256,
  parseTransaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";
import { USDC_TRANSFER_GAS } from "../../../src/adapters/arc/gas";
import {
  resetSenderNonces,
  senderLockHeld,
  withSenderLock,
} from "../../../src/adapters/arc/senderLock";

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const TREASURY = "0x000000000000000000000000000000000000000F" as Address;
const CONTROLLER = "0x000000000000000000000000000000000000c07a" as Address;
const SEED_TO = "0x00000000000000000000000000000000000000dd" as Address;
/** anvil's well-known account #1 — a published test key. */
const account = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

const chain = defineChain({
  id: 31_337,
  name: "fake",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["http://node.invalid"] } },
});

const TRUE_WORD = `0x${"0".repeat(63)}1` as Hex;

/** One adapter over a transport that records every call and whether the lock was held for it. */
function traced(opts: { controller?: Address; sendUrl?: string; sendTimeoutMs?: number } = {}) {
  const calls: { method: string; locked: boolean }[] = [];
  const sent: Hex[] = [];
  let pending = 0;

  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    calls.push({ method, locked: senderLockHeld(account.address) });
    switch (method) {
      case "eth_chainId":
        return "0x7a69";
      // viem probes this once per client before falling back to the individual calls; the message
      // is the one it looks for, so it stops asking.
      case "eth_fillTransaction":
        throw new Error("eth_fillTransaction is not available");
      case "eth_blockNumber":
        return "0x1";
      case "eth_getBlockByNumber":
        return { number: "0x1", baseFeePerGas: "0x1", timestamp: "0x1", transactions: [] };
      case "eth_maxPriorityFeePerGas":
        return "0x1";
      case "eth_estimateGas":
        return "0xdbba0";
      case "eth_call":
        return TRUE_WORD;
      case "eth_getTransactionCount":
        return `0x${pending.toString(16)}`;
      case "eth_sendRawTransaction": {
        const raw = (params as Hex[])[0]!;
        sent.push(raw);
        pending += 1;
        return keccak256(raw);
      }
      case "eth_getTransactionReceipt": {
        const hash = (params as Hex[])[0]!;
        return {
          transactionHash: hash,
          status: "0x1",
          blockNumber: "0x1",
          blockHash: `0x${"11".repeat(32)}`,
          transactionIndex: "0x0",
          from: account.address,
          to: USDC,
          cumulativeGasUsed: "0x1",
          gasUsed: "0x1",
          logs: [],
          logsBloom: `0x${"0".repeat(512)}`,
          type: "0x2",
          effectiveGasPrice: "0x1",
          contractAddress: null,
        };
      }
      default:
        throw new Error(`unexpected RPC call ${method}`);
    }
  });

  const transport = custom({ request: request as never }, { retryCount: 0 });
  const adapter = new ArcAdapter({
    publicClient: createPublicClient({ chain, transport }),
    managerWallet: createWalletClient({ account, chain, transport }),
    // The in-lock client: in these tests the same fake node, except where a test points it at a
    // hostile server to measure the bound.
    sendClient: opts.sendUrl
      ? createPublicClient({
          chain,
          transport: http(opts.sendUrl, { timeout: opts.sendTimeoutMs ?? 150, retryCount: 0 }),
        })
      : createPublicClient({ chain, transport }),
    chainId: chain.id,
    factory: "0x0000000000000000000000000000000000000001" as Address,
    identityRegistry: "0x0000000000000000000000000000000000000002" as Address,
    controller: opts.controller,
  });
  return {
    adapter,
    calls,
    sent,
    /** The RPC methods issued while the lock was held, in order. */
    inLock: () => calls.filter((c) => c.locked).map((c) => c.method),
  };
}

/** THE WINDOW: two calls, in this order, and nothing else. */
const THE_WINDOW = ["eth_getTransactionCount", "eth_sendRawTransaction"];

beforeEach(() => resetSenderNonces());

test("a DIRECT manager call holds the lock for exactly the nonce read and the raw send", async () => {
  const t = traced();
  await t.adapter.setAgentMetadata(1n, "ens", "0xabcd");
  expect(t.inLock()).toEqual(THE_WINDOW);
  // The simulate that decides whether anything is sent at all happened before the lock.
  expect(t.calls.map((c) => c.method)).toContain("eth_call");
});

test("a RELAYED manager call holds the lock for exactly the nonce read and the raw send", async () => {
  const t = traced({ controller: CONTROLLER });
  await t.adapter.setAgentMetadata(1n, "ens", "0xabcd", CONTROLLER);
  expect(t.inLock()).toEqual(THE_WINDOW);
  // Its preflight IS an estimateGas (the relay's trailing target is in no ABI), and it is outside.
  expect(t.calls.filter((c) => c.method === "eth_estimateGas").every((c) => !c.locked)).toBe(true);
});

test("a GAS SEED holds the lock for exactly the nonce read and the raw send", async () => {
  const t = traced();
  await t.adapter.sendNativeAsPlatform(SEED_TO, 10n);
  expect(t.inLock()).toEqual(THE_WINDOW);
});

test("broadcastFundTreasury holds the lock for exactly the nonce read and the raw send", async () => {
  const t = traced();
  await t.adapter.broadcastFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 5n });
  expect(t.inLock()).toEqual(THE_WINDOW);
});

test("the SAGA's fund window holds the lock for exactly the nonce read and the raw send", async () => {
  // The saga's shape (`workflow/onboarding.ts` step 7): prepare the transfer, THEN take the lock
  // across sign → persist → send. The revert pre-flight and the fee estimation belong to the
  // preparation, so a throttled endpoint delays this fund and not the whole queue.
  const t = traced();
  const persisted: string[] = [];
  const prepared = await t.adapter.prepareFundTreasury({
    usdc: USDC,
    treasury: TREASURY,
    amount: 5n,
  });
  await withSenderLock(account.address, async () => {
    const signed = await t.adapter.signFundTreasury(prepared);
    persisted.push(signed.txHash); // the synchronous SQLite write, in place
    await t.adapter.sendRawFundTreasury(signed.rawTx);
  });
  expect(t.inLock()).toEqual(THE_WINDOW);
  expect(persisted).toHaveLength(1);
  // The pre-flight ran, and it ran before the lock was taken.
  expect(t.calls.filter((c) => c.method === "eth_call").every((c) => !c.locked)).toBe(true);
});

test("the prepared transfer still carries the Arc gas and the transfer itself", async () => {
  // The prepared object is a superset of what the signature needs: the caller can still read the
  // transfer it asked for off it, which is what the saga records.
  const t = traced();
  const prepared = await t.adapter.prepareFundTreasury({
    usdc: USDC,
    treasury: TREASURY,
    amount: 5n,
  });
  expect(Object.keys(prepared).sort()).toEqual(["amount", "request", "treasury", "usdc"]);
  expect({ usdc: prepared.usdc, treasury: prepared.treasury, amount: prepared.amount }).toEqual({
    usdc: USDC,
    treasury: TREASURY,
    amount: 5n,
  });
  const signed = await withSenderLock(account.address, () => t.adapter.signFundTreasury(prepared));
  const tx = parseTransaction(signed.rawTx);
  expect(tx.to?.toLowerCase()).toBe(USDC.toLowerCase());
  expect(tx.gas).toBe(USDC_TRANSFER_GAS);
  expect(tx.nonce).toBe(0);
  expect(signed.txHash).toBe(keccak256(signed.rawTx));
});

test("nothing about the SIGNED BYTES changes: gas, fees, target, calldata, value, nonce", async () => {
  // The Arc footgun fix is in these bytes (USDC_TRANSFER_GAS, explicit, so no estimate reserves a
  // near-full balance), and so is the relay encoding. Decode what went out and read it back.
  const fund = traced();
  await fund.adapter.broadcastFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 5n });
  const tx = parseTransaction(fund.sent[0]!);
  expect(tx.to?.toLowerCase()).toBe(USDC.toLowerCase());
  expect(tx.gas).toBe(USDC_TRANSFER_GAS);
  expect(tx.nonce).toBe(0);
  expect(tx.chainId).toBe(chain.id);
  expect(typeof tx.maxFeePerGas).toBe("bigint");
  expect(typeof tx.maxPriorityFeePerGas).toBe("bigint");
  // `transfer(treasury, 5)`
  expect(tx.data?.startsWith("0xa9059cbb")).toBe(true);
  expect(tx.data?.toLowerCase()).toContain(TREASURY.slice(2).toLowerCase());

  const seed = traced();
  await seed.adapter.sendNativeAsPlatform(SEED_TO, 10n);
  const seedTx = parseTransaction(seed.sent[0]!);
  expect(seedTx.to?.toLowerCase()).toBe(SEED_TO.toLowerCase());
  expect(seedTx.value).toBe(10n);
  expect(seedTx.gas).toBe(0xdbba0n); // estimated, outside the lock

  const relayed = traced({ controller: CONTROLLER });
  await relayed.adapter.setAgentMetadata(1n, "ens", "0xabcd", CONTROLLER);
  const relayTx = parseTransaction(relayed.sent[0]!);
  expect(relayTx.to?.toLowerCase()).toBe(CONTROLLER.toLowerCase());
  expect(relayTx.gas).toBe(0xdbba0n); // the relay's estimateGas preflight IS the gas limit
  // Euler relay encoding: the 20-byte target is the calldata's tail.
  expect(relayTx.data?.toLowerCase().endsWith("0000000000000000000000000000000000000002")).toBe(
    true,
  );
});

// ── The bound: a sick endpoint may delay the queue, but only for as long as its timeout ────────

/** A local server that accepts and answers however the test says — or never. */
function hostile(handler?: Parameters<typeof createServer>[1]) {
  const server = createServer(handler ?? (() => {}));
  return new Promise<{ url: string; close: () => void; hits: () => number }>((resolve) => {
    let hits = 0;
    server.on("request", () => {
      hits += 1;
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        close: () => server.close(),
        hits: () => hits,
      }),
    );
  });
}

let servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

test("a HUNG nonce read releases the lock when the transport times out, and the queue moves on", async () => {
  const silent = await hostile();
  servers.push(silent);
  const t = traced({ sendUrl: silent.url, sendTimeoutMs: 150 });

  const t0 = Date.now();
  await expect(t.adapter.sendNativeAsPlatform(SEED_TO, 1n)).rejects.toThrow();
  const elapsed = Date.now() - t0;
  // One attempt, one timeout: no retry budget to multiply it, and no `Retry-After` to obey.
  expect(elapsed).toBeLessThan(2_000);
  expect(senderLockHeld(account.address)).toBe(false);

  // The next send from the same key is not stuck behind the dead one.
  const healthy = traced();
  await expect(healthy.adapter.sendNativeAsPlatform(SEED_TO, 1n)).resolves.toMatch(/^0x/);
});

test("a HUNG raw send releases the lock too", async () => {
  // The nonce read succeeds against a node that answers, and the broadcast is what hangs.
  let answered = 0;
  const halfDead = await hostile((_req, res) => {
    // First call (the nonce read) is answered; the broadcast never is.
    if (answered++ === 0) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }));
    }
  });
  servers.push(halfDead);
  const t = traced({ sendUrl: halfDead.url, sendTimeoutMs: 150 });

  const t0 = Date.now();
  await expect(t.adapter.sendNativeAsPlatform(SEED_TO, 1n)).rejects.toThrow();
  expect(Date.now() - t0).toBeLessThan(2_000);
  expect(senderLockHeld(account.address)).toBe(false);
});

test("a 429 with `Retry-After: 600` fails FAST and never sleeps on the header", async () => {
  // viem multiplies that header by 1000 and does not cap it, so with a retry budget one throttling
  // endpoint could hold the lock for half an hour. The in-lock transport has no retry budget.
  const throttling = await hostile((_req, res) => {
    res.writeHead(429, { "Retry-After": "600", "Content-Type": "text/plain" });
    res.end("rate limited");
  });
  servers.push(throttling);
  const t = traced({ sendUrl: throttling.url, sendTimeoutMs: 150 });

  const t0 = Date.now();
  await expect(t.adapter.sendNativeAsPlatform(SEED_TO, 1n)).rejects.toThrow();
  expect(Date.now() - t0).toBeLessThan(2_000);
  expect(throttling.hits()).toBe(1); // one attempt, no retries
  expect(senderLockHeld(account.address)).toBe(false);
});
