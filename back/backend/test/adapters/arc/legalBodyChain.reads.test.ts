/**
 * LegalBodyChain's READS, against a fake node behind viem's real `http` transport
 * (`helpers/fakeRpcNode`). The node answers on the wire and viem builds every error itself, which
 * is what the identity-owner cases depend on: viem raises a JSON-RPC `-32603` as the same revert
 * class as a real revert, so only the revert bytes can tell "no such identity" from "the node
 * failed". The relay seam is a real ArcAdapter over the same node.
 */
import {
  type Abi,
  type Address,
  type Hex,
  createPublicClient,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  isAddressEqual,
  toHex,
  zeroAddress,
} from "viem";
import { describe, expect, test } from "vitest";
import {
  iIdentityRegistryAbi,
  legalBodyFactoryAbi,
  mockIdentityRegistryAbi,
} from "../../../src/abis/generated";
import { LegalBodyChain, type LegalBodyChainDeps } from "../../../src/adapters/arc/legalBodyChain";
import type { LegalBodyLink } from "../../../src/legalBody/link";
import {
  FAKE_NODE_CHAIN,
  type FakeRpcNode,
  LOCAL_TEST_ACCOUNT,
  type NodeAnswer,
  causeChain,
  failureOf,
  fakeRpcNode,
  nodeRevert,
  relayingAdapter,
} from "../../helpers/fakeRpcNode";

/** Placeholder contracts and parties, checksummed. */
const FACTORY = "0x00000000000000000000000000000000000000fb" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000002" as Address;
const CONTROLLER = "0x000000000000000000000000000000000000c0DE" as Address;
const OWNER = "0x000000000000000000000000000000000000b0b0" as Address;
const OTHER_OWNER = "0x000000000000000000000000000000000000cA11" as Address;
const GUARDIAN = "0x00000000000000000000000000000000000A11cE" as Address;
const BODY = "0x0000000000000000000000000000000000000b0D" as Address;
const NO_CODE = "0x0000000000000000000000000000000000000E7E" as Address;
const DIGEST = `0x${"d1".repeat(32)}` as Hex;
const POINTER = `0x${"00".repeat(31)}01` as Hex;

/** The block every pinned read in this file is pinned to, and how it goes on the wire. */
const BLOCK = 77n;
const BLOCK_ON_WIRE = "0x4d";

const LINK: LegalBodyLink = {
  agentId: 42n,
  guardian: GUARDIAN,
  amendmentDelay: 172_800n,
  operatingAgreementHash: `0x${"ab".repeat(32)}` as Hex,
  deadline: 1_900_003_600n,
};

/** `ERC721NonexistentToken(42)`: what an ERC-721 `ownerOf` reverts with for a missing token. */
const NONEXISTENT_TOKEN = encodeErrorResult({
  abi: mockIdentityRegistryAbi,
  errorName: "ERC721NonexistentToken",
  args: [42n],
});

/** The view an `eth_call` asks for, decoded against the ABI of the contract it was sent to. */
function viewOf(params: unknown[]): {
  contract: "factory" | "registry";
  functionName: string;
  args: readonly unknown[];
} {
  const { to, data } = params[0] as { to: Address; data: Hex };
  const contract = isAddressEqual(to, FACTORY)
    ? "factory"
    : isAddressEqual(to, REGISTRY)
      ? "registry"
      : undefined;
  if (!contract) throw new Error(`eth_call to an unexpected address ${to}`);
  const abi = (contract === "factory" ? legalBodyFactoryAbi : iIdentityRegistryAbi) as Abi;
  const { functionName, args } = decodeFunctionData({ abi, data });
  return { contract, functionName, args: args ?? [] };
}

function returns(contract: "factory" | "registry", functionName: string, result: unknown) {
  const abi = (contract === "factory" ? legalBodyFactoryAbi : iIdentityRegistryAbi) as Abi;
  return { result: encodeFunctionResult({ abi, functionName, result }) };
}

/**
 * A node that answers each view by name, and anything else through `other`. A view it has no
 * answer for gets a JSON-RPC error, so a read a test did not expect fails that test.
 */
function nodeAnswering(
  views: Record<string, NodeAnswer>,
  other?: (method: string, params: unknown[]) => NodeAnswer | undefined,
): FakeRpcNode {
  return fakeRpcNode({
    answer: (method, params) => {
      if (method !== "eth_call") return other?.(method, params);
      const { functionName } = viewOf(params);
      return (
        views[functionName] ?? {
          error: { code: -32601, message: `no answer for ${functionName}` },
        }
      );
    },
  });
}

/** Each request as `what@block`: the view and its contract, or whose code was read. */
function trace(node: FakeRpcNode): string[] {
  return node.requests.map(({ method, params }) => {
    if (method === "eth_call") {
      const { contract, functionName } = viewOf(params);
      return `${contract}.${functionName}@${params[1]}`;
    }
    if (method === "eth_getCode") return `getCode(${params[0]})@${params[1]}`;
    return method;
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

describe("construction", () => {
  test("the constructor refuses a chain id that differs from the relay seam's", () => {
    const node = fakeRpcNode({ answer: () => undefined });
    expect(() => chainOver(node, { chainId: 1 })).toThrow(
      `differs from the relay seam's ${FAKE_NODE_CHAIN.id}`,
    );

    const chain = chainOver(node);
    expect(chain.chainId).toBe(FAKE_NODE_CHAIN.id);
    expect(chain.factory).toBe(FACTORY);
    expect(chain.executor).toBe(LOCAL_TEST_ACCOUNT.address);
    expect(node.calls).toEqual([]);
  });

  test("the constructor refuses a maxHeadAgeSeconds that is not a finite number above 0", () => {
    const node = fakeRpcNode({ answer: () => undefined });
    for (const maxHeadAgeSeconds of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY])
      expect(() => chainOver(node, { maxHeadAgeSeconds }), String(maxHeadAgeSeconds)).toThrow(
        /maxHeadAgeSeconds/,
      );
    for (const maxHeadAgeSeconds of [undefined, 120])
      expect(chainOver(node, { maxHeadAgeSeconds }), String(maxHeadAgeSeconds)).toBeInstanceOf(
        LegalBodyChain,
      );
    expect(node.calls).toEqual([]);
  });
});

describe("head", () => {
  const HEAD_TIME = 1_900_000_000n;
  const headNode = () =>
    fakeRpcNode({
      answer: (method) =>
        method === "eth_getBlockByNumber"
          ? {
              result: {
                number: "0x2a",
                hash: `0x${"11".repeat(32)}`,
                baseFeePerGas: "0x1",
                timestamp: toHex(HEAD_TIME),
                transactions: [],
              },
            }
          : undefined,
    });
  const at = (seconds: bigint) => () => Number(seconds) * 1000;

  test("head() throws when the head is older than maxHeadAgeSeconds", async () => {
    const stale = chainOver(headNode(), { maxHeadAgeSeconds: 30, now: at(HEAD_TIME + 31n) });
    await expect(stale.head()).rejects.toThrow("31 s old, above the 30 s limit");

    const node = headNode();
    const fresh = chainOver(node, { maxHeadAgeSeconds: 30, now: at(HEAD_TIME + 30n) });
    await expect(fresh.head()).resolves.toEqual({ number: 42n, timestamp: HEAD_TIME });
    expect(node.requests.map((r) => [r.method, r.params])).toEqual([
      ["eth_getBlockByNumber", ["latest", false]],
    ]);
  });

  test("head() believes any head when maxHeadAgeSeconds is unset", async () => {
    const chain = chainOver(headNode(), { now: at(HEAD_TIME + 86_400n) });
    await expect(chain.head()).resolves.toEqual({ number: 42n, timestamp: HEAD_TIME });
  });
});

describe("identityOwner", () => {
  const ownerOfAnswering = (answer: NodeAnswer) => chainOver(nodeAnswering({ ownerOf: answer }));

  test("a code 3 revert whose data starts with 0x7e273289 is undefined: no such identity", async () => {
    expect(NONEXISTENT_TOKEN.startsWith("0x7e273289")).toBe(true);
    await expect(
      ownerOfAnswering(nodeRevert(NONEXISTENT_TOKEN)).identityOwner(42n),
    ).resolves.toBeUndefined();
  });

  test("a JSON-RPC -32603 throws, although viem raises it as a contract revert", async () => {
    const err = await failureOf(
      ownerOfAnswering({ error: { code: -32603, message: "Internal error" } }).identityOwner(42n),
    );
    // The class is the trap: only the missing revert bytes say this was not an answer.
    expect(causeChain(err)).toContain("ContractFunctionRevertedError");
  });

  test("a code 3 revert with no data throws", async () => {
    const err = await failureOf(ownerOfAnswering(nodeRevert()).identityOwner(42n));
    expect(causeChain(err)).toContain("ContractFunctionRevertedError");
  });

  test("a code 3 revert with other bytes throws", async () => {
    const otherError = encodeErrorResult({
      abi: mockIdentityRegistryAbi,
      errorName: "ERC721InvalidOwner",
      args: [zeroAddress],
    });
    const err = await failureOf(ownerOfAnswering(nodeRevert(otherError)).identityOwner(42n));
    expect(causeChain(err)).toContain("ContractFunctionRevertedError");
  });

  test("a timeout throws", async () => {
    const err = await failureOf(ownerOfAnswering({ hang: true }).identityOwner(42n));
    expect(causeChain(err)).toContain("TimeoutError");
  });

  test("a normal answer is the owner", async () => {
    await expect(
      ownerOfAnswering(returns("registry", "ownerOf", OWNER)).identityOwner(42n),
    ).resolves.toBe(OWNER);
  });
});

describe("block pinning", () => {
  const views = {
    ownerOf: returns("registry", "ownerOf", OWNER),
    linkDigest: returns("factory", "linkDigest", DIGEST),
    predictLegalBody: returns("factory", "predictLegalBody", BODY),
    identityOwnerAtCreation: returns("factory", "identityOwnerAtCreation", OWNER),
    linkedLegalBody: returns("factory", "linkedLegalBody", BODY),
    encodePointer: returns("factory", "encodePointer", POINTER),
  };
  const codeAt = (method: string, params: unknown[]): NodeAnswer | undefined =>
    method === "eth_getCode"
      ? { result: isAddressEqual(params[0] as Address, BODY) ? "0x363d3d37" : "0x" }
      : undefined;

  test("each pinned read sends the block number it was given", async () => {
    const node = nodeAnswering(views, codeAt);
    const chain = chainOver(node);

    await expect(chain.hasCode(BODY, BLOCK)).resolves.toBe(true);
    await expect(chain.hasCode(NO_CODE, BLOCK)).resolves.toBe(false);
    await expect(chain.identityOwner(42n, BLOCK)).resolves.toBe(OWNER);
    await expect(chain.linkDigest(LINK, BLOCK)).resolves.toBe(DIGEST);
    await expect(chain.predictLegalBody(DIGEST, BLOCK)).resolves.toBe(BODY);
    await expect(chain.bodyCreator(BODY, BLOCK)).resolves.toBe(OWNER);
    await expect(
      chain.createdState({ bodyAddress: BODY, identityOwner: OWNER, blockNumber: BLOCK }),
    ).resolves.toBe("created");

    expect(trace(node)).toEqual([
      `getCode(${BODY})@${BLOCK_ON_WIRE}`,
      `getCode(${NO_CODE})@${BLOCK_ON_WIRE}`,
      `registry.ownerOf@${BLOCK_ON_WIRE}`,
      `factory.linkDigest@${BLOCK_ON_WIRE}`,
      `factory.predictLegalBody@${BLOCK_ON_WIRE}`,
      `factory.identityOwnerAtCreation@${BLOCK_ON_WIRE}`,
      `factory.identityOwnerAtCreation@${BLOCK_ON_WIRE}`,
    ]);
    // The digest is asked for the link's five fields, in the contract's order.
    const digestCall = node.requests.find(
      (r) => r.method === "eth_call" && viewOf(r.params).functionName === "linkDigest",
    );
    expect(viewOf(digestCall!.params).args).toEqual([
      LINK.agentId,
      LINK.guardian,
      LINK.amendmentDelay,
      LINK.operatingAgreementHash,
      LINK.deadline,
    ]);
  });

  test("a read given no block number reads the latest block", async () => {
    const node = nodeAnswering(views, codeAt);
    const chain = chainOver(node);

    await chain.hasCode(BODY);
    await chain.identityOwner(42n);
    await chain.linkDigest(LINK);
    await chain.predictLegalBody(DIGEST);
    await chain.bodyCreator(BODY);
    await chain.createdState({ bodyAddress: BODY, identityOwner: OWNER });
    await expect(chain.linkedLegalBody(42n)).resolves.toBe(BODY);
    await expect(chain.encodePointer(BODY)).resolves.toBe(POINTER);

    expect(trace(node)).toEqual([
      `getCode(${BODY})@latest`,
      "registry.ownerOf@latest",
      "factory.linkDigest@latest",
      "factory.predictLegalBody@latest",
      "factory.identityOwnerAtCreation@latest",
      "factory.identityOwnerAtCreation@latest",
      "factory.linkedLegalBody@latest",
      "factory.encodePointer@latest",
    ]);
  });
});

describe("the zero address is no answer", () => {
  test("bodyCreator maps the zero address to undefined, and returns any other creator", async () => {
    const none = nodeAnswering({
      identityOwnerAtCreation: returns("factory", "identityOwnerAtCreation", zeroAddress),
    });
    await expect(chainOver(none).bodyCreator(BODY)).resolves.toBeUndefined();

    const some = nodeAnswering({
      identityOwnerAtCreation: returns("factory", "identityOwnerAtCreation", OWNER),
    });
    await expect(chainOver(some).bodyCreator(BODY)).resolves.toBe(OWNER);
  });

  test("linkedLegalBody maps the zero address to undefined, and returns any other body", async () => {
    const none = nodeAnswering({
      linkedLegalBody: returns("factory", "linkedLegalBody", zeroAddress),
    });
    await expect(chainOver(none).linkedLegalBody(42n)).resolves.toBeUndefined();

    const some = nodeAnswering({ linkedLegalBody: returns("factory", "linkedLegalBody", BODY) });
    await expect(chainOver(some).linkedLegalBody(42n)).resolves.toBe(BODY);
  });
});

describe("createdState", () => {
  test.each([
    { state: "absent", recorded: "no creator", creator: zeroAddress },
    { state: "created", recorded: "the identity owner", creator: OWNER },
    { state: "foreign", recorded: "another owner", creator: OTHER_OWNER },
  ])(
    "$state when the factory recorded $recorded, from one recorded read",
    async ({ state, creator }) => {
      const node = nodeAnswering({
        identityOwnerAtCreation: returns("factory", "identityOwnerAtCreation", creator),
      });
      await expect(
        chainOver(node).createdState({
          bodyAddress: BODY,
          identityOwner: OWNER,
          blockNumber: BLOCK,
        }),
      ).resolves.toBe(state);

      expect(trace(node)).toEqual([`factory.identityOwnerAtCreation@${BLOCK_ON_WIRE}`]);
      expect(viewOf(node.requests[0]!.params).args).toEqual([BODY]);
    },
  );
});

describe("executorNonce", () => {
  test("executorNonce is the mined count, not the pending one", async () => {
    const node = fakeRpcNode({
      answer: (method, params) =>
        method === "eth_getTransactionCount"
          ? { result: params[1] === "latest" ? "0x7" : "0x9" }
          : undefined,
    });
    await expect(chainOver(node).executorNonce()).resolves.toBe(7);
    expect(node.requests.map((r) => [r.method, r.params])).toEqual([
      ["eth_getTransactionCount", [LOCAL_TEST_ACCOUNT.address, "latest"]],
    ]);
  });
});
