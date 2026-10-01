/**
 * Two fake nodes for the platform's send path, both over `fakeRpcNode` (viem's real `http`
 * transport). They differ in how viem prepares a transaction against them:
 *
 *  - {fillUnavailable}: the node has no `eth_fillTransaction` (it answers -32601), so viem falls
 *    back to the single calls: `eth_estimateGas`, the fee calls and `eth_getTransactionCount`.
 *  - {fillLikeArc}: the node answers `eth_fillTransaction` with `{ raw, tx }`, as Arc testnet does,
 *    so ONE call fills the gas, the fees and a nonce. A gas it was given is kept. viem multiplies
 *    the filled `maxFeePerGas` by 1.2, so no test may assert that the fee equals the node's.
 *
 * Both take a raw transaction once: the first time they answer its keccak, and the same bytes
 * again get the JSON-RPC error `already known`, as a real node's mempool does. Every raw
 * transaction they were handed is kept in `raw`, repeats included.
 */
import { type Address, type Hex, keccak256, serializeTransaction, toHex } from "viem";
import { FAKE_NODE_CHAIN, type FakeRpcNode, type NodeAnswer, fakeRpcNode } from "./fakeRpcNode";

/** The gas the node estimates for any transaction it was not given a gas for. */
export const NODE_GAS_ESTIMATE = 0x5dd2n;

/** The nonce an Arc-like node fills in. Deliberately unrelated to its pending count. */
export const ARC_FILLED_NONCE = 0xf1;

const ARC_MAX_FEE_PER_GAS = 0x5d21dba00n;
const ARC_MAX_PRIORITY_FEE_PER_GAS = 0x12a05f200n;

export interface NodeTransportOptions {
  /**
   * How the node answers the preflight (`eth_fillTransaction` where it has one, and
   * `eth_estimateGas`): `nodeRevert(data)`, or a hang. Omit it for a node that answers normally.
   */
  preflight?: NodeAnswer;
  /** The PENDING count the node reports for any sender. It never moves on its own. Default 0. */
  pendingNonce?: number;
  /** The signer whose send lock `requests[].locked` reports. */
  lockKey?: Address;
  /** The transport's per-request timeout. */
  timeoutMs?: number;
}

export interface PresetNode extends FakeRpcNode {
  /** Every raw transaction the node was handed, in order, repeats included. */
  raw: Hex[];
}

/** A node without `eth_fillTransaction`: viem asks the single calls. */
export function fillUnavailable(opts: NodeTransportOptions = {}): PresetNode {
  return presetNode(false, opts);
}

/** A node that fills a transaction the way Arc testnet does, nonce included. */
export function fillLikeArc(opts: NodeTransportOptions = {}): PresetNode {
  return presetNode(true, opts);
}

function presetNode(fills: boolean, opts: NodeTransportOptions): PresetNode {
  const raw: Hex[] = [];
  const node = fakeRpcNode({
    fillTransaction: fills,
    lockKey: opts.lockKey,
    timeoutMs: opts.timeoutMs,
    answer: (method, params) => {
      switch (method) {
        case "eth_fillTransaction":
          // Without fill support, the helper's own "method not found" answers.
          if (!fills) return undefined;
          return opts.preflight ?? { result: arcFill(params[0] as RpcTxRequest) };
        case "eth_estimateGas":
          return opts.preflight ?? { result: toHex(NODE_GAS_ESTIMATE) };
        case "eth_getTransactionCount":
          return { result: toHex(opts.pendingNonce ?? 0) };
        case "eth_sendRawTransaction": {
          const bytes = params[0] as Hex;
          const known = raw.includes(bytes);
          raw.push(bytes);
          return known
            ? { error: { code: -32000, message: "already known" } }
            : { result: keccak256(bytes) };
        }
        default:
          return undefined;
      }
    },
  });
  return { ...node, raw };
}

/** A transaction request as viem puts it on the wire. */
interface RpcTxRequest {
  to?: Address;
  data?: Hex;
  input?: Hex;
  gas?: Hex;
  value?: Hex;
}

/** Arc's `eth_fillTransaction` answer: the unsigned bytes, and the transaction field by field. */
function arcFill(request: RpcTxRequest): { raw: Hex; tx: Record<string, unknown> } {
  const gas = request.gas ? BigInt(request.gas) : NODE_GAS_ESTIMATE;
  const value = request.value ? BigInt(request.value) : 0n;
  const input = request.input ?? request.data ?? "0x";
  const raw = serializeTransaction({
    type: "eip1559",
    chainId: FAKE_NODE_CHAIN.id,
    nonce: ARC_FILLED_NONCE,
    gas,
    maxFeePerGas: ARC_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: ARC_MAX_PRIORITY_FEE_PER_GAS,
    to: request.to,
    value,
    data: input,
  });
  return {
    raw,
    tx: {
      type: "0x2",
      chainId: toHex(FAKE_NODE_CHAIN.id),
      nonce: toHex(ARC_FILLED_NONCE),
      gas: toHex(gas),
      maxFeePerGas: toHex(ARC_MAX_FEE_PER_GAS),
      maxPriorityFeePerGas: toHex(ARC_MAX_PRIORITY_FEE_PER_GAS),
      to: request.to,
      value: toHex(value),
      accessList: [],
      input,
    },
  };
}
