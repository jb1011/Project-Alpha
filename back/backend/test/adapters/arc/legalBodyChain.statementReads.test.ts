/**
 * LegalBodyChain's statement reads: the snapshot, which reads every chain fact a statement rests on
 * at ONE block, and the kind of code an address holds at a block.
 *
 * Against a fake node behind viem's real `http` transport (`helpers/fakeRpcNode`), every answer
 * built with viem's own encoders. The node plays a small chain: the factory, the identity registry,
 * the bodies, and Multicall3, whose `aggregate3` it runs as the contract does, one sub-call at a
 * time. The relay seam is a real ArcAdapter over the same node; nothing here sends a transaction.
 *
 * Every address is a placeholder.
 */
import {
  type Abi,
  type Address,
  type Hex,
  type Transport,
  createPublicClient,
  decodeFunctionData,
  encodeFunctionResult,
  getAddress,
  isAddressEqual,
  multicall3Abi,
  toHex,
  zeroAddress,
} from "viem";
import { describe, expect, test, vi } from "vitest";
import {
  iIdentityRegistryAbi,
  legalBodyFactoryAbi,
  legalManagerAbi,
} from "../../../src/abis/generated";
import {
  type AgentSnapshot,
  type CodeKind,
  LegalBodyChain,
  type LegalBodyChainDeps,
  type LegalBodyChainPort,
  type SnapshotRequest,
  type StatementChainPort,
  codeKindOf,
} from "../../../src/adapters/arc/legalBodyChain";
import { MULTICALL3_BY_CHAIN } from "../../../src/chains";
import {
  FAKE_NODE_CHAIN,
  type FakeRpcNode,
  type NodeAnswer,
  type NodeRequest,
  causeChain,
  failureOf,
  fakeRpcNode,
  nodeRevert,
  relayingAdapter,
} from "../../helpers/fakeRpcNode";

/** Placeholder contracts and parties, checksummed. */
const FACTORY = getAddress("0x00000000000000000000000000000000000000fb");
const REGISTRY = getAddress("0x0000000000000000000000000000000000000002");
const CONTROLLER = getAddress("0x000000000000000000000000000000000000c0de");
const OWNER = getAddress("0x000000000000000000000000000000000000b0b0");
const WALLET = getAddress("0x00000000000000000000000000000000000a11e7");
/** The canonical Multicall3 deployment's address. */
const MULTICALL3 = getAddress("0xcA11bde05977b3631167028862bE2a173976CA11");

/** The n-th placeholder body. */
const bodyAt = (n: number): Address =>
  getAddress(`0x${(0xb0d1e000 + n).toString(16).padStart(40, "0")}`);
/** A bytes32 of one byte, given as two hex digits, repeated. */
const word = (byte: string): Hex => `0x${byte.repeat(32)}`;

/** The node's head, and how its number goes on the wire. */
const HEAD = { number: 77n, timestamp: 1_900_000_000n };
const HEAD_ON_WIRE = "0x4d";
const HEAD_BLOCK = {
  number: HEAD_ON_WIRE,
  hash: word("11"),
  baseFeePerGas: "0x1",
  timestamp: toHex(HEAD.timestamp),
  transactions: [],
};
/** The head-age limit production builds the chain with. */
const MAX_HEAD_AGE_SECONDS = 120;

/** A body as the fake chain holds it. */
interface FakeBody {
  creator: Address;
  /** The raw `status()`. The contract's enum is Active, WindingDown, Dissolved. */
  status: number;
  /** `meta()`: the EIN, the formation date, the operating agreement's hash, the agent id. */
  meta: readonly [string, bigint, Hex, bigint];
}

/** What the fake chain holds. A view named in `failing` reverts, wherever it is called. */
interface FakeChain {
  linked: Map<bigint, Address>;
  wallets: Map<bigint, Address>;
  bodies: Map<Address, FakeBody>;
  code: Map<Address, Hex>;
  failing: Set<string>;
}

function emptyChain(): FakeChain {
  return {
    linked: new Map(),
    wallets: new Map(),
    bodies: new Map(),
    code: new Map(),
    failing: new Set(),
  };
}

type Contract = "factory" | "registry" | "body";
const ABI: Record<Contract, Abi> = {
  factory: legalBodyFactoryAbi,
  registry: iIdentityRegistryAbi,
  body: legalManagerAbi,
};

function contractAt(chain: FakeChain, to: Address): Contract | undefined {
  if (isAddressEqual(to, FACTORY)) return "factory";
  if (isAddressEqual(to, REGISTRY)) return "registry";
  return chain.bodies.has(getAddress(to)) ? "body" : undefined;
}

/** What a view returns on the fake chain, or `undefined` for a view it does not answer. */
function viewValue(
  chain: FakeChain,
  contract: Contract,
  to: Address,
  functionName: string,
  args: readonly unknown[],
): unknown {
  switch (`${contract}.${functionName}`) {
    case "factory.linkedLegalBody":
      return chain.linked.get(args[0] as bigint) ?? zeroAddress;
    case "factory.identityOwnerAtCreation":
      return chain.bodies.get(getAddress(args[0] as Address))?.creator ?? zeroAddress;
    case "registry.getAgentWallet":
      return chain.wallets.get(args[0] as bigint) ?? zeroAddress;
    case "body.status":
      return chain.bodies.get(getAddress(to))?.status;
    case "body.meta":
      return chain.bodies.get(getAddress(to))?.meta;
    default:
      return undefined;
  }
}

/**
 * One call on the fake chain, as Multicall3 reports a sub-call. An address with no code answers
 * any call with empty bytes, as the EVM does. A contract reverts a view it does not answer, and
 * one named in `failing`.
 */
function run(chain: FakeChain, to: Address, data: Hex): { success: boolean; returnData: Hex } {
  const contract = contractAt(chain, to);
  if (!contract) return { success: true, returnData: "0x" };
  const abi = ABI[contract];
  const { functionName, args } = decodeFunctionData({ abi, data });
  const value = chain.failing.has(functionName)
    ? undefined
    : viewValue(chain, contract, to, functionName, args ?? []);
  if (value === undefined) return { success: false, returnData: "0x" };
  return { success: true, returnData: encodeFunctionResult({ abi, functionName, result: value }) };
}

/**
 * Multicall3's `aggregate3`, run as the contract runs it: every sub-call, in order. A failed
 * sub-call is reported as failed when it allows failure, and reverts the whole call when it does
 * not.
 */
function aggregate3(chain: FakeChain, data: Hex): NodeAnswer {
  const call = decodeFunctionData({ abi: multicall3Abi, data });
  if (call.functionName !== "aggregate3") return nodeRevert();
  const results: { success: boolean; returnData: Hex }[] = [];
  for (const sub of call.args[0]) {
    const result = run(chain, sub.target, sub.callData);
    if (!result.success && !sub.allowFailure) return nodeRevert();
    results.push(result);
  }
  return {
    result: encodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      result: results,
    }),
  };
}

/**
 * A node over `chain`: the head, every `eth_call` (Multicall3's `aggregate3` included) and
 * `eth_getCode`. `first` is asked before anything else, for a test that changes one answer.
 */
function nodeOver(
  chain: FakeChain,
  first?: (method: string, params: unknown[]) => NodeAnswer | undefined,
): FakeRpcNode {
  return fakeRpcNode({
    answer: (method, params) => {
      const answer = first?.(method, params);
      if (answer) return answer;
      if (method === "eth_getBlockByNumber") return { result: HEAD_BLOCK };
      if (method === "eth_getCode")
        return { result: chain.code.get(getAddress(params[0] as Address)) ?? "0x" };
      if (method !== "eth_call") return undefined;
      const { to, data } = params[0] as { to: Address; data: Hex };
      if (isAddressEqual(to, MULTICALL3)) return aggregate3(chain, data);
      const result = run(chain, to, data);
      return result.success ? { result: result.returnData } : nodeRevert();
    },
  });
}

/**
 * A LegalBodyChain whose every RPC goes to `node`, through `transport` when one is given. Its
 * clock is 5 s past the head, within the limit production builds it with.
 */
function chainOver(
  node: FakeRpcNode,
  deps: Partial<LegalBodyChainDeps> = {},
  transport: Transport = node.transport,
): LegalBodyChain {
  return new LegalBodyChain({
    publicClient: createPublicClient({ chain: FAKE_NODE_CHAIN, transport }),
    arc: relayingAdapter(node, { controller: CONTROLLER }),
    chainId: FAKE_NODE_CHAIN.id,
    factory: FACTORY,
    identityRegistry: REGISTRY,
    maxHeadAgeSeconds: MAX_HEAD_AGE_SECONDS,
    now: () => Number(HEAD.timestamp + 5n) * 1000,
    ...deps,
  });
}

/**
 * `node`'s transport, counting the requests in flight at once: a request is in flight from the
 * moment it leaves until its answer is back. Each request is held for 0 to 3 ms before it goes, so
 * requests started together are in flight together, and their answers come back out of order.
 */
function countingInFlight(node: FakeRpcNode): { transport: Transport; peak: () => number } {
  let inFlight = 0;
  let peak = 0;
  let sent = 0;
  const transport: Transport = (params) => {
    const inner = node.transport(params);
    const send = inner.request as unknown as (args: unknown, options?: unknown) => Promise<unknown>;
    const request = async (args: unknown, options?: unknown): Promise<unknown> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const holdMs = 3 - (sent++ % 4);
      try {
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        return await send(args, options);
      } finally {
        inFlight -= 1;
      }
    };
    return { ...inner, request: request as unknown as typeof inner.request };
  };
  return { transport, peak: () => peak };
}

const ethCalls = (node: FakeRpcNode): NodeRequest[] =>
  node.requests.filter((r) => r.method === "eth_call");
const targetOf = (request: NodeRequest): Address => (request.params[0] as { to: Address }).to;

/** A call as `contract.view(args)`, a body named by its address, decoded against the ABI of the
 *  contract it went to. */
function described(chain: FakeChain, to: Address, data: Hex): string {
  const contract = contractAt(chain, to);
  if (!contract) return `${to}.(${data})`;
  const { functionName, args } = decodeFunctionData({ abi: ABI[contract], data });
  const who = contract === "body" ? getAddress(to) : contract;
  return `${who}.${functionName}(${(args ?? []).join(",")})`;
}

/** Every view the node was asked, in the order sent: each `aggregate3`'s sub-calls, and each call
 *  sent on its own. */
function viewsRead(chain: FakeChain, node: FakeRpcNode): string[] {
  return ethCalls(node).flatMap(({ params }) => {
    const { to, data } = params[0] as { to: Address; data: Hex };
    if (!isAddressEqual(to, MULTICALL3)) return [described(chain, to, data)];
    const call = decodeFunctionData({ abi: multicall3Abi, data });
    if (call.functionName !== "aggregate3") throw new Error(`Multicall3.${call.functionName}`);
    return call.args[0].map((sub) => described(chain, sub.target, sub.callData));
  });
}

/** The views a snapshot of `requests` reads, in order: per agent, its linked body and its wallet;
 *  per body, its creator, its status and its meta. */
function viewsOf(requests: readonly SnapshotRequest[]): string[] {
  return requests.flatMap(({ agentId, bodies }) => [
    `factory.linkedLegalBody(${agentId})`,
    `registry.getAgentWallet(${agentId})`,
    ...bodies.flatMap((b) => [
      `factory.identityOwnerAtCreation(${b})`,
      `${b}.status()`,
      `${b}.meta()`,
    ]),
  ]);
}

/**
 * Two agents and three bodies, every fact distinct:
 * - agent 1000 is linked to its body 1 and has a wallet; its body 2 is dissolved, and the factory
 *   recorded no creator for it;
 * - agent 1001 is linked to nothing and has no wallet; its body 3 is winding down, carries an EIN
 *   and a formation date, and names agent 4242 in its own meta.
 */
function twoAgentsThreeBodies(): { chain: FakeChain; requests: SnapshotRequest[] } {
  const chain = emptyChain();
  chain.linked.set(1000n, bodyAt(1));
  chain.wallets.set(1000n, WALLET);
  chain.bodies.set(bodyAt(1), { creator: OWNER, status: 0, meta: ["", 0n, word("AB"), 1000n] });
  chain.bodies.set(bodyAt(2), {
    creator: zeroAddress,
    status: 2,
    meta: ["", 0n, word("cd"), 1000n],
  });
  chain.bodies.set(bodyAt(3), {
    creator: OWNER,
    status: 1,
    meta: ["00-0000000", 1_700_000_000n, word("ef"), 4242n],
  });
  return {
    chain,
    requests: [
      { agentId: 1000n, bodies: [bodyAt(1), bodyAt(2)] },
      { agentId: 1001n, bodies: [bodyAt(3)] },
    ],
  };
}

/** What a snapshot of {twoAgentsThreeBodies} reads. */
const TWO_AGENTS: AgentSnapshot[] = [
  {
    agentId: 1000n,
    linked: bodyAt(1),
    agentWallet: WALLET,
    bodies: [
      { body: bodyAt(1), creator: OWNER, status: "active", metaAgentId: 1000n, oaHash: word("ab") },
      {
        body: bodyAt(2),
        creator: undefined,
        status: "dissolved",
        metaAgentId: 1000n,
        oaHash: word("cd"),
      },
    ],
  },
  {
    agentId: 1001n,
    linked: undefined,
    agentWallet: zeroAddress,
    bodies: [
      {
        body: bodyAt(3),
        creator: OWNER,
        status: "winding_down",
        metaAgentId: 4242n,
        oaHash: word("ef"),
      },
    ],
  },
];

/** The views a snapshot of {twoAgentsThreeBodies} reads, in order. The identity's owner is not
 *  among them. */
const TWO_AGENTS_VIEWS = [
  "factory.linkedLegalBody(1000)",
  "registry.getAgentWallet(1000)",
  `factory.identityOwnerAtCreation(${bodyAt(1)})`,
  `${bodyAt(1)}.status()`,
  `${bodyAt(1)}.meta()`,
  `factory.identityOwnerAtCreation(${bodyAt(2)})`,
  `${bodyAt(2)}.status()`,
  `${bodyAt(2)}.meta()`,
  "factory.linkedLegalBody(1001)",
  "registry.getAgentWallet(1001)",
  `factory.identityOwnerAtCreation(${bodyAt(3)})`,
  `${bodyAt(3)}.status()`,
  `${bodyAt(3)}.meta()`,
];

/**
 * `agents` agents from id 2000, each with `perAgent` bodies of its own, the facts varied enough
 * that a fact read for the wrong agent or body would show: each agent is linked to its first body,
 * every other agent has a wallet of its own; each body has its own status and hash, and every
 * other one has no creator.
 */
function manyAgents(
  agents: number,
  perAgent: number,
): { chain: FakeChain; requests: SnapshotRequest[] } {
  const chain = emptyChain();
  const requests: SnapshotRequest[] = [];
  let n = 0;
  for (let a = 0; a < agents; a++) {
    const agentId = BigInt(2000 + a);
    const bodies: Address[] = [];
    for (let b = 0; b < perAgent; b++) {
      n += 1;
      const body = bodyAt(n);
      bodies.push(body);
      chain.bodies.set(body, {
        creator: n % 2 === 0 ? zeroAddress : OWNER,
        status: n % 3,
        meta: ["", 0n, word(n.toString(16).padStart(2, "0")), agentId],
      });
    }
    if (bodies[0]) chain.linked.set(agentId, bodies[0]);
    if (a % 2 === 0)
      chain.wallets.set(
        agentId,
        getAddress(`0x${(0xa11e70000 + a).toString(16).padStart(40, "0")}`),
      );
    requests.push({ agentId, bodies });
  }
  return { chain, requests };
}

const STATUS_NAMES = ["active", "winding_down", "dissolved"] as const;

/** The agents of a snapshot of `requests`, as the fake chain holds them. */
function heldBy(chain: FakeChain, requests: readonly SnapshotRequest[]): AgentSnapshot[] {
  return requests.map(({ agentId, bodies }) => ({
    agentId,
    linked: chain.linked.get(agentId),
    agentWallet: chain.wallets.get(agentId) ?? zeroAddress,
    bodies: bodies.map((body) => {
      const held = chain.bodies.get(body);
      const status = held && STATUS_NAMES[held.status];
      if (!held || !status) throw new Error(`the fake chain holds no body ${body} with a status`);
      return {
        body,
        creator: isAddressEqual(held.creator, zeroAddress) ? undefined : held.creator,
        status,
        metaAgentId: held.meta[3],
        oaHash: held.meta[2].toLowerCase() as Hex,
      };
    }),
  }));
}

describe("the Multicall3 address", () => {
  test("is the canonical deployment, listed for Arc testnet only", () => {
    expect(MULTICALL3_BY_CHAIN).toStrictEqual({ 5042002: MULTICALL3 });
    expect(MULTICALL3_BY_CHAIN[FAKE_NODE_CHAIN.id]).toBe(MULTICALL3);
  });
});

/** The two ways a snapshot reads: through Multicall3, or with a read per call. */
const MODES = [
  { mode: "through Multicall3", deps: { multicall3: MULTICALL3 } },
  { mode: "with separate reads", deps: {} },
] as const;

describe.each(MODES)("readStatementSnapshot $mode", ({ deps }) => {
  test("one head read, then every call at the head's block, and the facts decoded", async () => {
    const { chain, requests } = twoAgentsThreeBodies();
    const node = nodeOver(chain);

    const snapshot = await chainOver(node, deps).readStatementSnapshot(requests);

    expect(snapshot).toStrictEqual({
      blockNumber: HEAD.number,
      blockTimestamp: HEAD.timestamp,
      agents: TWO_AGENTS,
    });
    expect(node.requests[0]).toMatchObject({
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    });
    expect(node.calls.slice(1).every((method) => method === "eth_call")).toBe(true);
    for (const call of ethCalls(node)) expect(call.params[1]).toBe(HEAD_ON_WIRE);
    // The views of the rule, each once, and nothing else.
    expect([...viewsRead(chain, node)].sort()).toEqual([...TWO_AGENTS_VIEWS].sort());
  });

  test("each snapshot makes exactly one head read", async () => {
    const { chain, requests } = twoAgentsThreeBodies();
    const node = nodeOver(chain);
    const reader = chainOver(node, deps);

    await reader.readStatementSnapshot(requests);
    await reader.readStatementSnapshot(requests);

    expect(node.calls.filter((method) => method === "eth_getBlockByNumber")).toHaveLength(2);
    expect(node.calls.filter((method) => method !== "eth_call")).toEqual([
      "eth_getBlockByNumber",
      "eth_getBlockByNumber",
    ]);
  });

  test.each([3, 255])("a status of %i, outside the contract's enum, throws", async (value) => {
    const { chain, requests } = twoAgentsThreeBodies();
    chain.bodies.get(bodyAt(3))!.status = value;
    await expect(chainOver(nodeOver(chain), deps).readStatementSnapshot(requests)).rejects.toThrow(
      `reports status ${value}, outside its contract's enum`,
    );
  });

  test("a stale head throws, and nothing else is read", async () => {
    const { chain, requests } = twoAgentsThreeBodies();
    const node = nodeOver(chain);
    const stale = chainOver(node, {
      ...deps,
      now: () => Number(HEAD.timestamp + 121n) * 1000,
    });

    await expect(stale.readStatementSnapshot(requests)).rejects.toThrow("above the 120 s limit");
    expect(node.calls).toEqual(["eth_getBlockByNumber"]);
  });

  test.each(["linkedLegalBody", "getAgentWallet", "identityOwnerAtCreation", "status", "meta"])(
    "one failing call throws: a reverted %s is no answer",
    async (view) => {
      const { chain, requests } = twoAgentsThreeBodies();
      chain.failing.add(view);
      const err = await failureOf(chainOver(nodeOver(chain), deps).readStatementSnapshot(requests));
      expect(causeChain(err)).toContain("ContractFunctionRevertedError");
    },
  );

  test("a body with no code throws: its empty answer is no status", async () => {
    const { chain, requests } = twoAgentsThreeBodies();
    chain.bodies.delete(bodyAt(3));
    const err = await failureOf(chainOver(nodeOver(chain), deps).readStatementSnapshot(requests));
    expect(causeChain(err)).toContain("ContractFunctionZeroDataError");
  });

  test("the limits: 1 to 100 requests, at most 4 bodies each and 100 in all, refused before any read", async () => {
    const node = nodeOver(emptyChain());
    const reader = chainOver(node, deps);
    const agent = (id: number, bodies: number): SnapshotRequest => ({
      agentId: BigInt(id),
      bodies: Array.from({ length: bodies }, (_, i) => bodyAt(id * 10 + i)),
    });
    const refused: [string, SnapshotRequest[], string][] = [
      ["no request", [], "1 to 100 agents"],
      ["101 requests", Array.from({ length: 101 }, (_, i) => agent(i, 0)), "1 to 100 agents"],
      ["5 bodies for one agent", [agent(1, 5)], "at most 4 bodies per agent"],
      [
        "101 bodies in all",
        [...Array.from({ length: 25 }, (_, i) => agent(i, 4)), agent(99, 1)],
        "at most 100 bodies in all",
      ],
    ];

    for (const [label, requests, message] of refused)
      await expect(reader.readStatementSnapshot(requests), label).rejects.toThrow(message);
    expect(node.requests).toEqual([]);
  });
});

describe("readStatementSnapshot through Multicall3", () => {
  const withMulticall = { multicall3: MULTICALL3 };

  test("two agents and three bodies: ONE eth_call, to Multicall3, at the head's block", async () => {
    const { chain, requests } = twoAgentsThreeBodies();
    const node = nodeOver(chain);

    await chainOver(node, withMulticall).readStatementSnapshot(requests);

    const calls = ethCalls(node);
    expect(calls).toHaveLength(1);
    expect(isAddressEqual(targetOf(calls[0]!), MULTICALL3)).toBe(true);
    expect(calls[0]!.params[1]).toBe(HEAD_ON_WIRE);
    expect(viewsRead(chain, node)).toEqual(TWO_AGENTS_VIEWS);
  });

  test("100 agents with one body each: three eth_calls, all to Multicall3 at the head's block", async () => {
    const { chain, requests } = manyAgents(100, 1);
    const node = nodeOver(chain);

    const snapshot = await chainOver(node, withMulticall).readStatementSnapshot(requests);

    expect(snapshot.agents).toStrictEqual(heldBy(chain, requests));
    const calls = ethCalls(node);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(isAddressEqual(targetOf(call), MULTICALL3)).toBe(true);
      expect(call.params[1]).toBe(HEAD_ON_WIRE);
    }
    expect(viewsRead(chain, node)).toEqual(viewsOf(requests));
    expect(node.calls.filter((method) => method === "eth_getBlockByNumber")).toHaveLength(1);
  });

  test("the most a snapshot reads, 25 agents with four bodies each, all at the head's block", async () => {
    const { chain, requests } = manyAgents(25, 4);
    const node = nodeOver(chain);

    const snapshot = await chainOver(node, withMulticall).readStatementSnapshot(requests);

    expect(snapshot.agents).toStrictEqual(heldBy(chain, requests));
    expect(snapshot.agents.flatMap((a) => a.bodies)).toHaveLength(100);
    const calls = ethCalls(node);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.params[1]).toBe(HEAD_ON_WIRE);
    expect(viewsRead(chain, node)).toEqual(viewsOf(requests));
  });

  test("a 429 on the multicall's eth_call throws", async () => {
    const { chain, requests } = twoAgentsThreeBodies();
    const node = nodeOver(chain, (method) =>
      method === "eth_call" ? { httpStatus: 429, body: "Too Many Requests" } : undefined,
    );

    const err = await failureOf(chainOver(node, withMulticall).readStatementSnapshot(requests));

    expect(causeChain(err)).toContain("HttpRequestError");
    const calls = ethCalls(node);
    expect(calls).toHaveLength(1);
    expect(isAddressEqual(targetOf(calls[0]!), MULTICALL3)).toBe(true);
  });

  test("a failed sub-call fails the snapshot in its one eth_call", async () => {
    const { chain, requests } = twoAgentsThreeBodies();
    chain.failing.add("meta");
    const node = nodeOver(chain);

    await expect(chainOver(node, withMulticall).readStatementSnapshot(requests)).rejects.toThrow();
    expect(ethCalls(node)).toHaveLength(1);
  });
});

describe("readStatementSnapshot with separate reads", () => {
  test("two agents and three bodies: one eth_call per read, none to Multicall3", async () => {
    const { chain, requests } = twoAgentsThreeBodies();
    const node = nodeOver(chain);

    await chainOver(node).readStatementSnapshot(requests);

    const calls = ethCalls(node);
    expect(calls).toHaveLength(13);
    for (const call of calls) {
      expect(isAddressEqual(targetOf(call), MULTICALL3)).toBe(false);
      expect(call.params[1]).toBe(HEAD_ON_WIRE);
    }
  });

  test("100 agents with one body each: 500 reads, never more than 20 in flight", async () => {
    const { chain, requests } = manyAgents(100, 1);
    const node = nodeOver(chain);
    const counted = countingInFlight(node);

    const snapshot = await chainOver(node, {}, counted.transport).readStatementSnapshot(requests);

    expect(snapshot.agents).toStrictEqual(heldBy(chain, requests));
    const calls = ethCalls(node);
    expect(calls).toHaveLength(500);
    for (const call of calls) expect(call.params[1]).toBe(HEAD_ON_WIRE);
    expect([...viewsRead(chain, node)].sort()).toEqual(viewsOf(requests).sort());
    // 20 at once while more wait their turn, and never more.
    expect(counted.peak()).toBe(20);
  });

  test("a node refusing every read is asked 20 times, not 500", async () => {
    const { chain, requests } = manyAgents(100, 1);
    const node = nodeOver(chain, (method) =>
      method === "eth_call" ? { httpStatus: 429, body: "Too Many Requests" } : undefined,
    );

    const err = await failureOf(chainOver(node).readStatementSnapshot(requests));
    // Let any read still in flight land: none may start after the first failure.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(causeChain(err)).toContain("HttpRequestError");
    expect(ethCalls(node)).toHaveLength(20);
  });

  test("after one failed read, no further read starts, though the others succeed", async () => {
    const { chain, requests } = manyAgents(100, 1);
    let refused = false;
    const node = nodeOver(chain, (method) => {
      if (method !== "eth_call" || refused) return undefined;
      refused = true;
      return { httpStatus: 429, body: "Too Many Requests" };
    });
    const publicClient = createPublicClient({ chain: FAKE_NODE_CHAIN, transport: node.transport });
    const reads = vi.spyOn(publicClient, "readContract");

    const err = await failureOf(chainOver(node, { publicClient }).readStatementSnapshot(requests));
    const startedWhenItFailed = reads.mock.calls.length;
    // The reads in flight land; none may start after the failure.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(causeChain(err)).toContain("HttpRequestError");
    expect(reads.mock.calls.length).toBe(startedWhenItFailed);
    expect(startedWhenItFailed).toBeLessThan(500);
  });
});

describe("codeKindOf", () => {
  const delegation: Hex = `0xef0100${"ab".repeat(20)}`;
  const cases: { label: string; code: Hex | undefined; kind: CodeKind }[] = [
    { label: "no code (viem reads an empty account as undefined)", code: undefined, kind: "none" },
    { label: "empty code", code: "0x", kind: "none" },
    { label: "a 23-byte EIP-7702 delegation", code: delegation, kind: "delegated" },
    { label: "a delegation in upper case", code: `0xEF0100${"AB".repeat(20)}`, kind: "delegated" },
    { label: "23 bytes with another prefix", code: `0xef0200${"ab".repeat(20)}`, kind: "contract" },
    { label: "the delegation prefix on 24 bytes", code: `${delegation}00`, kind: "contract" },
    {
      label: "the delegation prefix on 22 bytes",
      code: delegation.slice(0, -2) as Hex,
      kind: "contract",
    },
    {
      label: "a contract's long code",
      code: `0x6080604052${"00".repeat(3_800)}`,
      kind: "contract",
    },
  ];

  test.each(cases)("$label is $kind", ({ code, kind }) => {
    expect(codeKindOf(code)).toBe(kind);
  });
});

describe("codeKind", () => {
  const KEY_ACCOUNT = getAddress("0x00000000000000000000000000000000000e0a01");
  const DELEGATED = getAddress("0x00000000000000000000000000000000000d1e7a");
  const CONTRACT = getAddress("0x00000000000000000000000000000000000c0c0a");

  test("reads the code at the given block, and names its kind", async () => {
    const chain = emptyChain();
    chain.code.set(DELEGATED, `0xef0100${"ab".repeat(20)}`);
    chain.code.set(CONTRACT, `0x6080604052${"00".repeat(64)}`);
    const node = nodeOver(chain);
    const reader = chainOver(node);

    await expect(reader.codeKind(KEY_ACCOUNT, HEAD.number)).resolves.toBe("none");
    await expect(reader.codeKind(DELEGATED, HEAD.number)).resolves.toBe("delegated");
    await expect(reader.codeKind(CONTRACT, HEAD.number)).resolves.toBe("contract");

    expect(node.requests.map((r) => [r.method, r.params])).toEqual([
      ["eth_getCode", [KEY_ACCOUNT, HEAD_ON_WIRE]],
      ["eth_getCode", [DELEGATED, HEAD_ON_WIRE]],
      ["eth_getCode", [CONTRACT, HEAD_ON_WIRE]],
    ]);
  });

  test("a failed read throws", async () => {
    const node = nodeOver(emptyChain(), (method) =>
      method === "eth_getCode" ? { error: { code: -32603, message: "Internal error" } } : undefined,
    );
    await expect(chainOver(node).codeKind(OWNER, HEAD.number)).rejects.toThrow();
  });
});

describe("StatementChainPort", () => {
  test("a plain object satisfies the port, and the real class is assignable to it", async () => {
    const plain = {
      chainId: FAKE_NODE_CHAIN.id,
      factory: FACTORY,
      readStatementSnapshot: vi.fn<StatementChainPort["readStatementSnapshot"]>(async () => ({
        blockNumber: HEAD.number,
        blockTimestamp: HEAD.timestamp,
        agents: [],
      })),
      codeKind: vi.fn<StatementChainPort["codeKind"]>(async () => "none"),
    } satisfies StatementChainPort;
    const port: StatementChainPort = plain;
    await expect(port.codeKind(OWNER, HEAD.number)).resolves.toBe("none");
    expect(plain.codeKind).toHaveBeenCalledWith(OWNER, HEAD.number);

    const node = nodeOver(emptyChain());
    const real: StatementChainPort = chainOver(node);
    expect(real.chainId).toBe(FAKE_NODE_CHAIN.id);
    expect(real.factory).toBe(FACTORY);
    expect(node.calls).toEqual([]);
  });

  test("the legal-body flow's port does not carry the statement reads", () => {
    // Checked by the type checker: both names are in this port and not in LegalBodyChainPort, so
    // the flow's fakes need not implement them.
    const statementOnly: Exclude<keyof StatementChainPort, keyof LegalBodyChainPort>[] = [
      "readStatementSnapshot",
      "codeKind",
    ];
    expect(statementOnly).toHaveLength(2);
  });
});
