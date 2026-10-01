/**
 * A fake JSON-RPC node behind viem's REAL `http` transport.
 *
 * The node answers on the wire: an HTTP response carrying a JSON-RPC result or error, a bare HTTP
 * status, or nothing at all. Every layer above that is viem's own: the `RpcRequestError` the http
 * transport builds, the node-error mapping, and the `estimateGas` / `fillTransaction` wrappers.
 * That is the point of it. A hand-built error encodes what its author believed viem produces;
 * this encodes what a node SAYS, and lets viem produce whatever it really produces.
 *
 * Why `http` and not a `custom` transport: a `custom` (EIP-1193) provider that throws hands viem a
 * plain error, which viem wraps in `UnknownRpcError`. That is a different cause chain from the one
 * production's http transport builds (`RpcRequestError`), and the cause chain is exactly what the
 * tests that use this helper are about.
 *
 * Every request is recorded by method, so a test can pin the exact RPC traffic viem generates.
 */
import {
  http,
  type Account,
  type Address,
  type Hex,
  type Transport,
  createPublicClient,
  createWalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArcAdapter } from "../../src/adapters/arc/arcAdapter";
import { chainFor } from "../../src/chains";

export const FAKE_RPC_URL = "http://node.invalid";

/** The chain definition production builds (`chainFor`), pointed at the fake node. */
export const FAKE_NODE_CHAIN = chainFor(5042002, FAKE_RPC_URL);

/** anvil's well-known account #1, a published test key: a LOCAL account, as production signs. */
export const LOCAL_TEST_ACCOUNT = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

/** One answer from the node, at the wire level. */
export type NodeAnswer =
  | { result: unknown }
  | { error: { code: number; message: string; data?: unknown } }
  | { httpStatus: number; body: string }
  | { hang: true };

/**
 * A contract revert, exactly as Arc testnet's node (and geth) puts it on the wire:
 * `{"code":3,"message":"execution reverted","data":"0x…"}`. Omit `data` for a revert that
 * carries none.
 */
export function nodeRevert(data?: Hex): NodeAnswer {
  return {
    error: { code: 3, message: "execution reverted", ...(data !== undefined ? { data } : {}) },
  };
}

/**
 * The cause chains viem 2.52 builds around a node's code-3 revert of `estimateGas`, by account
 * shape. The first two were observed against Arc testnet's own node (which supports
 * `eth_fillTransaction`); the third is viem's fallback for a node that does not.
 */
export const NODE_REVERT_CHAIN = {
  /** A json-rpc account: viem asks `eth_estimateGas` directly. */
  jsonRpcAccount: ["EstimateGasExecutionError", "ExecutionRevertedError", "RpcRequestError"],
  /** A local account (production): viem asks `eth_fillTransaction` first, and it reverts there. */
  localAccount: [
    "EstimateGasExecutionError",
    "ExecutionRevertedError",
    "TransactionExecutionError",
    "ExecutionRevertedError",
    "RpcRequestError",
  ],
  /** A local account on a node with no `eth_fillTransaction`: viem falls back to the single calls. */
  localAccountWithoutFill: [
    "EstimateGasExecutionError",
    "ExecutionRevertedError",
    "EstimateGasExecutionError",
    "ExecutionRevertedError",
    "RpcRequestError",
  ],
} as const;

export interface FakeNodeOptions {
  /** How the node answers the preflight calls (`eth_fillTransaction`, `eth_estimateGas`). */
  preflight?: NodeAnswer;
  /** How the node answers EVERY call: an endpoint that is throttling us, or has stopped answering. */
  everyCall?: NodeAnswer;
  /** `false` = a node without `eth_fillTransaction` (it answers "method not found"). */
  fillTransaction?: boolean;
  /** The transport's per-request timeout, which is what turns a `hang` into viem's TimeoutError. */
  timeoutMs?: number;
}

export interface FakeRpcNode {
  transport: Transport;
  /** Every JSON-RPC method the node was asked, in order. */
  calls: string[];
}

export function fakeRpcNode(opts: FakeNodeOptions): FakeRpcNode {
  if (!opts.preflight && !opts.everyCall)
    throw new Error("fakeRpcNode: say how the node answers (preflight or everyCall)");
  const calls: string[] = [];
  const fillSupported = opts.fillTransaction ?? true;

  const answerFor = (method: string): NodeAnswer => {
    if (opts.everyCall) return opts.everyCall;
    switch (method) {
      case "eth_fillTransaction":
        return fillSupported
          ? opts.preflight!
          : { error: { code: -32601, message: "the method eth_fillTransaction does not exist" } };
      case "eth_estimateGas":
        return opts.preflight!;
      case "eth_chainId":
        return { result: `0x${FAKE_NODE_CHAIN.id.toString(16)}` };
      case "eth_getTransactionCount":
        return { result: "0x0" };
      case "eth_getBlockByNumber":
        return {
          result: {
            number: "0x1",
            hash: `0x${"11".repeat(32)}`,
            baseFeePerGas: "0x1",
            timestamp: "0x1",
            transactions: [],
          },
        };
      case "eth_maxPriorityFeePerGas":
        return { result: "0x1" };
      default:
        // Recorded above, and refused here: a test that pins `calls` sees any surprise.
        return { error: { code: -32601, message: `the method ${method} does not exist` } };
    }
  };

  const fetchFn = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
    calls.push(method);
    const answer = answerFor(method);
    if ("hang" in answer)
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        ),
      );
    if ("httpStatus" in answer)
      return new Response(answer.body, {
        status: answer.httpStatus,
        headers: { "Content-Type": "text/plain" },
      });
    const payload = "error" in answer ? { error: answer.error } : { result: answer.result };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...payload }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return {
    calls,
    transport: http(FAKE_RPC_URL, {
      fetchFn,
      retryCount: 0,
      timeout: opts.timeoutMs ?? 100,
    }),
  };
}

/**
 * The real `ArcAdapter`, relaying through `controller`, with every RPC going to `node`.
 *
 * `account` defaults to a local key, the shape production signs with. Every test that uses this
 * fails at the preflight, so nothing here ever reaches a send.
 */
export function relayingAdapter(
  node: FakeRpcNode,
  opts: { controller: Address; account?: Account | Address },
): ArcAdapter {
  const account = opts.account ?? LOCAL_TEST_ACCOUNT;
  return new ArcAdapter({
    publicClient: createPublicClient({ chain: FAKE_NODE_CHAIN, transport: node.transport }),
    managerWallet: createWalletClient({
      account,
      chain: FAKE_NODE_CHAIN,
      transport: node.transport,
    }),
    chainId: FAKE_NODE_CHAIN.id,
    factory: "0x0000000000000000000000000000000000000001",
    identityRegistry: "0x0000000000000000000000000000000000000002",
    controller: opts.controller,
  });
}

/** What a call rejected with. Fails the test if it resolved instead. */
export async function failureOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail, and it succeeded");
}

/** The class name of each Error in a cause chain, outermost first. Stops at the first non-Error. */
export function causeChain(e: unknown): string[] {
  const names: string[] = [];
  for (let cur: unknown = e, hops = 0; cur instanceof Error && hops < 12; hops++) {
    names.push(cur.name);
    cur = (cur as { cause?: unknown }).cause;
  }
  return names;
}
