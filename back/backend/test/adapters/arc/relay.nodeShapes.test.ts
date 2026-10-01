/**
 * A relayed call's preflight against what a NODE actually says when the target reverts.
 *
 * A relayed manager call is preflighted with `estimateGas` against the controller, and when the
 * target reverts the node answers `{"code":3,"message":"execution reverted","data":"0x…"}`. viem
 * never builds a `RawContractError` for `estimateGas`: the revert bytes stay on the node's own
 * error (`RpcRequestError`, code 3), several wrappers down. A recogniser that only looks for
 * `RawContractError` therefore misses every real revert, and the anchor loop reads each one as a
 * network blip.
 *
 * Nothing in this file builds a viem error by hand. A fake node answers on the wire, the REAL
 * `ArcAdapter` relays through it, and viem does all the wrapping (see `helpers/fakeRpcNode`).
 *
 * Three account shapes, because viem asks the node different questions for each:
 *  - a json-rpc account: `eth_estimateGas`, and nothing else;
 *  - a local account (how production signs): `eth_fillTransaction`, which is where the revert
 *    surfaces, and nothing else;
 *  - a local account on a node without `eth_fillTransaction`: viem falls back to the nonce, block,
 *    fee and gas calls one by one, and the revert surfaces on `eth_estimateGas`.
 */
import {
  type Abi,
  type Account,
  type Address,
  BaseError,
  type Hex,
  RpcRequestError,
  encodeErrorResult,
  encodeFunctionData,
  getAddress,
  slice,
} from "viem";
import { beforeEach, describe, expect, test } from "vitest";
import { legalManagerAbi, noviControllerAbi } from "../../../src/abis/generated";
import {
  ContractRevertError,
  decodedRevertName,
  relayRevertError,
} from "../../../src/adapters/arc/relay";
import { resetSenderNonces } from "../../../src/adapters/arc/senderLock";
import {
  type FakeNodeOptions,
  LOCAL_TEST_ACCOUNT,
  NODE_REVERT_CHAIN,
  causeChain,
  failureOf,
  fakeRpcNode,
  nodeRevert,
  relayingAdapter,
} from "../../helpers/fakeRpcNode";

beforeEach(() => resetSenderNonces());

const CONTROLLER = "0x000000000000000000000000000000000000c07a" as Address;
/** The entity's LegalManager proxy: the target of the two amendment calls. */
const PROXY = "0x00000000000000000000000000000000000000fa" as Address;
const OA_HASH = `0x${"ab".repeat(32)}` as Hex;

interface Shape {
  name: string;
  account: Account | Address;
  fillTransaction: boolean;
  /** The RPC traffic viem generates for a reverting preflight in this shape. */
  revertCalls: string[];
  /** The cause chain viem builds around the node's revert, outermost first. */
  revertChain: readonly string[];
}

const SHAPES: Shape[] = [
  {
    name: "json-rpc account",
    account: LOCAL_TEST_ACCOUNT.address,
    fillTransaction: true,
    revertCalls: ["eth_estimateGas"],
    revertChain: NODE_REVERT_CHAIN.jsonRpcAccount,
  },
  {
    name: "local account (production shape)",
    account: LOCAL_TEST_ACCOUNT,
    fillTransaction: true,
    revertCalls: ["eth_fillTransaction"],
    revertChain: NODE_REVERT_CHAIN.localAccount,
  },
  {
    name: "local account, node without eth_fillTransaction",
    account: LOCAL_TEST_ACCOUNT,
    fillTransaction: false,
    revertCalls: [
      "eth_fillTransaction",
      "eth_getTransactionCount",
      "eth_getBlockByNumber",
      "eth_maxPriorityFeePerGas",
      "eth_estimateGas",
    ],
    revertChain: NODE_REVERT_CHAIN.localAccountWithoutFill,
  },
];

/** The selector the controller names in `NotAuthorized(selector, caller)`. */
const SCHEDULE_SELECTOR = slice(
  encodeFunctionData({
    abi: legalManagerAbi,
    functionName: "scheduleOperatingAgreementUpdate",
    args: [OA_HASH],
  }),
  0,
  4,
);

describe.each(SHAPES)("node revert, $name", (shape) => {
  const nodeFor = (o: FakeNodeOptions) =>
    fakeRpcNode({ fillTransaction: shape.fillTransaction, ...o });
  const adapterFor = (node: ReturnType<typeof fakeRpcNode>) =>
    relayingAdapter(node, { controller: CONTROLLER, account: shape.account });

  test("a LegalManager custom error (TooEarly) becomes a ContractRevertError named TooEarly", async () => {
    const data = encodeErrorResult({ abi: legalManagerAbi, errorName: "TooEarly" });
    const node = nodeFor({ preflight: nodeRevert(data) });
    const err = await failureOf(
      adapterFor(node).executeOperatingAgreementUpdate(PROXY, OA_HASH, CONTROLLER),
    );

    // The fixture is the real thing: viem's own traffic and viem's own chain, around the node's
    // own answer. If a viem upgrade changes either, this says so before anything else does.
    expect(node.calls).toEqual(shape.revertCalls);
    expect(causeChain(err)).toEqual(["ContractRevertError", ...shape.revertChain]);
    const rpc = (err as { cause: BaseError }).cause.walk((e) => e instanceof RpcRequestError);
    expect(rpc).toMatchObject({ code: 3, data });

    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as ContractRevertError).errorName).toBe("TooEarly");
    expect(decodedRevertName(err)).toBe("TooEarly");
    expect((err as Error).message).toBe(
      `relay executeOperatingAgreementUpdate -> ${PROXY} via controller ${CONTROLLER} reverted in simulation: TooEarly()`,
    );
  });

  test("a controller error (NotAuthorized) is decoded with its arguments", async () => {
    const caller = getAddress(LOCAL_TEST_ACCOUNT.address);
    const selector = SCHEDULE_SELECTOR;
    const node = nodeFor({
      preflight: nodeRevert(
        encodeErrorResult({
          abi: noviControllerAbi,
          errorName: "NotAuthorized",
          args: [selector, caller],
        }),
      ),
    });
    const err = await failureOf(
      adapterFor(node).scheduleOperatingAgreementUpdate(PROXY, OA_HASH, CONTROLLER),
    );
    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as ContractRevertError).errorName).toBe("NotAuthorized");
    expect((err as Error).message).toContain(
      `reverted in simulation: NotAuthorized(${selector}, ${caller})`,
    );
    expect(node.calls).not.toContain("eth_sendRawTransaction");
  });

  test("bytes that decode against neither ABI are still a revert, with no name", async () => {
    const node = nodeFor({ preflight: nodeRevert("0xdeadbeef") });
    const err = await failureOf(
      adapterFor(node).executeOperatingAgreementUpdate(PROXY, OA_HASH, CONTROLLER),
    );
    expect(err).toBeInstanceOf(ContractRevertError);
    // An empty name, never a guessed one. The class is the signal, not the name.
    expect((err as ContractRevertError).errorName).toBe("");
    expect(decodedRevertName(err)).toBe("");
    expect((err as Error).message).toContain("reverted in simulation: revert data 0xdeadbeef");
  });

  // ── Not reverts. Each is returned exactly as viem threw it. ─────────────────────────────────

  test.each<[string, FakeNodeOptions, string]>([
    ["an HTTP 429", { everyCall: { httpStatus: 429, body: "rate limited" } }, "HttpRequestError"],
    [
      "a JSON-RPC -32005 rate limit",
      { everyCall: { error: { code: -32005, message: "rate limit exceeded" } } },
      "LimitExceededRpcError",
    ],
    [
      "a JSON-RPC -32603 internal error",
      { preflight: { error: { code: -32603, message: "internal error" } } },
      "InternalRpcError",
    ],
    [
      "insufficient funds",
      {
        preflight: {
          error: {
            code: -32000,
            message: "insufficient funds for gas * price + value: balance 0, tx cost 1, overshot 1",
          },
        },
      },
      "InsufficientFundsError",
    ],
    [
      // viem gives this the REVERT class, but it is an unfunded sender, not a contract verdict:
      // the reason `ExecutionRevertedError` on its own must never count as a revert.
      "gas required exceeds allowance",
      { preflight: { error: { code: -32000, message: "gas required exceeds allowance (0)" } } },
      "ExecutionRevertedError",
    ],
    ["a code-3 revert with no data", { preflight: nodeRevert() }, "ExecutionRevertedError"],
    ["a code-3 revert with empty data", { preflight: nodeRevert("0x") }, "ExecutionRevertedError"],
    [
      "a code-3 revert with fewer than 4 bytes",
      { preflight: nodeRevert("0x1234") },
      "ExecutionRevertedError",
    ],
    [
      // The code is what marks a revert: hex data on any other error is not a contract verdict.
      "hex data on an error that is not code 3",
      { preflight: { error: { code: -32000, message: "execution failed", data: "0xdeadbeef" } } },
      "InvalidInputRpcError",
    ],
    ["a timeout", { everyCall: { hang: true } }, "TimeoutError"],
  ])("%s is NOT a revert: returned untouched", async (_label, answer, inner) => {
    const node = nodeFor(answer);
    const err = await failureOf(
      adapterFor(node).executeOperatingAgreementUpdate(PROXY, OA_HASH, CONTROLLER),
    );
    expect(err).not.toBeInstanceOf(ContractRevertError);
    expect(decodedRevertName(err)).toBeUndefined();
    // viem's own error, as viem threw it: nothing wrapped it.
    expect(err).toBeInstanceOf(BaseError);
    expect(causeChain(err)[0]).toBe("EstimateGasExecutionError");
    // ...and the case is the one it claims to be.
    expect(causeChain(err)).toContain(inner);
    expect(node.calls).not.toContain("eth_sendRawTransaction");
  });
});

test("the search for revert bytes is hop-bounded: a cyclic cause chain is returned untouched", () => {
  // Not a node shape: a guard on the traversal itself. viem's `walk` recurses for as long as there
  // is a `cause`, so without the bound a cycle would overflow the stack inside the relay's catch
  // and replace the real failure with a RangeError.
  const inner = new BaseError("inner");
  const outer = new BaseError("outer", { cause: inner });
  Object.defineProperty(inner, "cause", { value: outer });
  const ctx = {
    abi: legalManagerAbi as Abi,
    functionName: "executeOperatingAgreementUpdate",
    target: PROXY,
    controller: CONTROLLER,
  };
  expect(relayRevertError(outer, ctx)).toBe(outer);
});
