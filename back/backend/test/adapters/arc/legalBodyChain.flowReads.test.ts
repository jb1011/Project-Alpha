/**
 * The reads the legal-body flow adds to LegalBodyChain, against a fake node behind viem's real
 * `http` transport (`helpers/fakeRpcNode`): the executor's pending count, a body's own status, and
 * the linked-body pointer at a given block. The relay seam is a real ArcAdapter over the same
 * node, so every recorded request is what production would put on the wire.
 *
 * Also the port the flow's domain code depends on: a plain object must satisfy it, and so must
 * the real class.
 */
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  decodeFunctionData,
  encodeFunctionResult,
  isAddressEqual,
} from "viem";
import { afterEach, describe, expect, test, vi } from "vitest";
import { legalBodyFactoryAbi, legalManagerAbi } from "../../../src/abis/generated";
import {
  LegalBodyChain,
  type LegalBodyChainDeps,
  type LegalBodyChainPort,
} from "../../../src/adapters/arc/legalBodyChain";
import { noteSenderBroadcast, resetSenderNonces } from "../../../src/adapters/arc/senderLock";
import {
  FAKE_NODE_CHAIN,
  type FakeRpcNode,
  LOCAL_TEST_ACCOUNT,
  type NodeAnswer,
  causeChain,
  failureOf,
  fakeRpcNode,
  relayingAdapter,
} from "../../helpers/fakeRpcNode";

/** Placeholder contracts, checksummed. */
const FACTORY = "0x00000000000000000000000000000000000000fb" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000002" as Address;
const CONTROLLER = "0x000000000000000000000000000000000000c0DE" as Address;
const BODY = "0x0000000000000000000000000000000000000b0D" as Address;

/** The block the pinned reads in this file are pinned to, and how it goes on the wire. */
const BLOCK = 77n;
const BLOCK_ON_WIRE = "0x4d";

afterEach(() => resetSenderNonces());

/** The view an `eth_call` asks for, decoded against the ABI of the contract it was sent to. */
function viewOf(params: unknown[]): {
  contract: "factory" | "body";
  functionName: string;
  args: readonly unknown[];
} {
  const { to, data } = params[0] as { to: Address; data: Hex };
  const contract = isAddressEqual(to, FACTORY)
    ? "factory"
    : isAddressEqual(to, BODY)
      ? "body"
      : undefined;
  if (!contract) throw new Error(`eth_call to an unexpected address ${to}`);
  const abi = (contract === "factory" ? legalBodyFactoryAbi : legalManagerAbi) as Abi;
  const { functionName, args } = decodeFunctionData({ abi, data });
  return { contract, functionName, args: args ?? [] };
}

function returns(contract: "factory" | "body", functionName: string, result: unknown) {
  const abi = (contract === "factory" ? legalBodyFactoryAbi : legalManagerAbi) as Abi;
  return { result: encodeFunctionResult({ abi, functionName, result }) };
}

/** A node that answers each view by name. A view it has no answer for gets a JSON-RPC error. */
function nodeAnswering(views: Record<string, NodeAnswer>): FakeRpcNode {
  return fakeRpcNode({
    answer: (method, params) => {
      if (method !== "eth_call") return undefined;
      const { functionName } = viewOf(params);
      return (
        views[functionName] ?? {
          error: { code: -32601, message: `no answer for ${functionName}` },
        }
      );
    },
  });
}

/** Each `eth_call` as `contract.view@block`; any other request by its method. */
function trace(node: FakeRpcNode): string[] {
  return node.requests.map(({ method, params }) => {
    if (method !== "eth_call") return method;
    const { contract, functionName } = viewOf(params);
    return `${contract}.${functionName}@${params[1]}`;
  });
}

/** A LegalBodyChain whose every RPC, its own and its relay seam's, goes to `node`. */
function chainOver(node: FakeRpcNode, deps: Partial<LegalBodyChainDeps> = {}): LegalBodyChain {
  return new LegalBodyChain({
    publicClient: createPublicClient({ chain: FAKE_NODE_CHAIN, transport: node.transport }),
    arc: relayingAdapter(node, { controller: CONTROLLER }),
    chainId: FAKE_NODE_CHAIN.id,
    factory: FACTORY,
    identityRegistry: REGISTRY,
    ...deps,
  });
}

describe("executorPendingNonce", () => {
  /** A node whose mined count is 7 and whose pending count is 9, for any address. */
  const countingNode = () =>
    fakeRpcNode({
      answer: (method, params) =>
        method === "eth_getTransactionCount"
          ? { result: params[1] === "latest" ? "0x7" : params[1] === "pending" ? "0x9" : "0x0" }
          : undefined,
    });

  test("executorPendingNonce asks the node for the pending tag, and executorNonce for latest", async () => {
    const node = countingNode();
    const chain = chainOver(node);

    await expect(chain.executorPendingNonce()).resolves.toBe(9);
    await expect(chain.executorNonce()).resolves.toBe(7);

    expect(node.requests.map((r) => [r.method, r.params])).toEqual([
      ["eth_getTransactionCount", [LOCAL_TEST_ACCOUNT.address, "pending"]],
      ["eth_getTransactionCount", [LOCAL_TEST_ACCOUNT.address, "latest"]],
    ]);
  });

  test("the pending count is the node's own number, whatever this process last sent", async () => {
    // A send this process just made raises the floor the NEXT send is numbered from. The read is
    // not a send: it reports the node's count and nothing else.
    noteSenderBroadcast(LOCAL_TEST_ACCOUNT.address, 50);
    const node = countingNode();

    await expect(chainOver(node).executorPendingNonce()).resolves.toBe(9);
    expect(node.requests.map((r) => [r.method, r.params])).toEqual([
      ["eth_getTransactionCount", [LOCAL_TEST_ACCOUNT.address, "pending"]],
    ]);
  });

  test("a failed read throws", async () => {
    const node = fakeRpcNode({
      answer: (method) =>
        method === "eth_getTransactionCount"
          ? { error: { code: -32603, message: "Internal error" } }
          : undefined,
    });
    await expect(chainOver(node).executorPendingNonce()).rejects.toThrow();
  });
});

describe("linkedLegalBody", () => {
  test("linkedLegalBody sends the block it is given, and reads latest without one", async () => {
    const node = nodeAnswering({ linkedLegalBody: returns("factory", "linkedLegalBody", BODY) });
    const chain = chainOver(node);

    await expect(chain.linkedLegalBody(42n, BLOCK)).resolves.toBe(BODY);
    await expect(chain.linkedLegalBody(42n)).resolves.toBe(BODY);

    expect(trace(node)).toEqual([
      `factory.linkedLegalBody@${BLOCK_ON_WIRE}`,
      "factory.linkedLegalBody@latest",
    ]);
    for (const r of node.requests) expect(viewOf(r.params).args).toEqual([42n]);
  });
});

describe("bodyStatus", () => {
  test.each([
    { value: 0, label: "0", status: "active" },
    { value: 1, label: "1", status: "winding_down" },
    { value: 2, label: "2", status: "dissolved" },
  ])("the body's status() $label is $status", async ({ value, status }) => {
    const node = nodeAnswering({ status: returns("body", "status", value) });
    await expect(chainOver(node).bodyStatus(BODY, BLOCK)).resolves.toBe(status);
    // Read from the body itself, at the block it was given.
    expect(trace(node)).toEqual([`body.status@${BLOCK_ON_WIRE}`]);
  });

  test("bodyStatus reads latest without a block", async () => {
    const node = nodeAnswering({ status: returns("body", "status", 0) });
    await expect(chainOver(node).bodyStatus(BODY)).resolves.toBe("active");
    expect(trace(node)).toEqual(["body.status@latest"]);
  });

  test("a status outside the contract's enum throws", async () => {
    for (const value of [3, 255]) {
      const node = nodeAnswering({ status: returns("body", "status", value) });
      await expect(chainOver(node).bodyStatus(BODY), String(value)).rejects.toThrow(
        `status ${value}`,
      );
    }
  });

  test("an RPC failure throws", async () => {
    const internal = nodeAnswering({
      status: { error: { code: -32603, message: "Internal error" } },
    });
    await expect(chainOver(internal).bodyStatus(BODY)).rejects.toThrow();

    const hung = nodeAnswering({ status: { hang: true } });
    const err = await failureOf(chainOver(hung).bodyStatus(BODY));
    expect(causeChain(err)).toContain("TimeoutError");

    // No code at the address: the node answers empty bytes, which are no status.
    const empty = nodeAnswering({ status: { result: "0x" } });
    await expect(chainOver(empty).bodyStatus(BODY)).rejects.toThrow();
  });
});

describe("LegalBodyChainPort", () => {
  /** Every member the port asks for, as a plain object of fakes. */
  function plainPort() {
    return {
      chainId: FAKE_NODE_CHAIN.id,
      factory: FACTORY,
      executor: LOCAL_TEST_ACCOUNT.address,
      head: vi.fn(async () => ({ number: 1n, timestamp: 1n })),
      identityOwner: vi.fn(async (_agentId: bigint, _blockNumber?: bigint) => undefined),
      hasCode: vi.fn(async (_address: Address, _blockNumber?: bigint) => false),
      linkDigest: vi.fn<LegalBodyChainPort["linkDigest"]>(async () => `0x${"d1".repeat(32)}`),
      predictLegalBody: vi.fn<LegalBodyChainPort["predictLegalBody"]>(async () => BODY),
      bodyCreator: vi.fn<LegalBodyChainPort["bodyCreator"]>(async () => undefined),
      estimateCreate: vi.fn<LegalBodyChainPort["estimateCreate"]>(async () => 300_000n),
      createdState: vi.fn<LegalBodyChainPort["createdState"]>(async () => "absent"),
      executorNonce: vi.fn(async () => 7),
      executorPendingNonce: vi.fn(async () => 9),
      submitCreate: vi.fn<LegalBodyChainPort["submitCreate"]>(async () => ({
        status: "not_recorded",
      })),
      rebroadcastCreate: vi.fn<LegalBodyChainPort["rebroadcastCreate"]>(async () => {}),
      createOutcome: vi.fn<LegalBodyChainPort["createOutcome"]>(async () => ({
        status: "absent",
      })),
      confirmCreate: vi.fn<LegalBodyChainPort["confirmCreate"]>(async () => {
        throw new Error("not in this test");
      }),
      findCreation: vi.fn<LegalBodyChainPort["findCreation"]>(async () => undefined),
      linkedLegalBody: vi.fn<LegalBodyChainPort["linkedLegalBody"]>(async () => undefined),
      bodyStatus: vi.fn<LegalBodyChainPort["bodyStatus"]>(async () => "active"),
    };
  }

  test("a plain object satisfies the port, and the real class is assignable to it", async () => {
    const plain = plainPort() satisfies LegalBodyChainPort;
    const port: LegalBodyChainPort = plain;
    await expect(port.bodyStatus(BODY, BLOCK)).resolves.toBe("active");
    await expect(port.linkedLegalBody(42n, BLOCK)).resolves.toBeUndefined();
    await expect(port.executorPendingNonce()).resolves.toBe(9);
    expect(plain.bodyStatus).toHaveBeenCalledWith(BODY, BLOCK);
    expect(plain.linkedLegalBody).toHaveBeenCalledWith(42n, BLOCK);

    const node = fakeRpcNode({ answer: () => undefined });
    const real: LegalBodyChainPort = chainOver(node);
    expect(real.chainId).toBe(FAKE_NODE_CHAIN.id);
    expect(real.factory).toBe(FACTORY);
    expect(node.calls).toEqual([]);
  });

  test("an object without the flow's reads is not the port", () => {
    const { bodyStatus: _bodyStatus, ...withoutStatus } = plainPort();
    const { executorPendingNonce: _pending, ...withoutPending } = plainPort();
    // @ts-expect-error bodyStatus is part of the port
    const missingStatus: LegalBodyChainPort = withoutStatus;
    // @ts-expect-error executorPendingNonce is part of the port
    const missingPending: LegalBodyChainPort = withoutPending;
    expect([missingStatus, missingPending]).toHaveLength(2);
  });
});
