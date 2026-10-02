import { readFileSync } from "node:fs";
import {
  BaseError,
  BlockNotFoundError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  EstimateGasExecutionError,
  ExecutionRevertedError,
  InsufficientFundsError,
  TransactionExecutionError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeErrorResult,
  toFunctionSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { worldchain } from "viem/chains";
import { describe, expect, test, vi } from "vitest";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import {
  type RegistrarOptions,
  buildSignal,
  createAgentBookRegistrar,
  encodeRegister,
} from "../../src/adapters/worldid/agentBookRegistrar";
import { AGENT_BOOK_ABI, AGENT_BOOK_ADDRESS } from "../../src/payments/agentBookReader";
import {
  FAKE_RPC_URL,
  type FakeNodeOptions,
  type FakeRpcNode,
  type NodeAnswer,
  causeChain,
  failureOf,
  fakeRpcNode,
  nodeRevert,
} from "../helpers/fakeRpcNode";

const AGENT = "0x1111111111111111111111111111111111111111" as const;

describe("signal", () => {
  test("golden vector: address (20 bytes) ++ nonce (32 bytes), packed, 52 bytes", () => {
    const sig = buildSignal(AGENT, 1n);
    expect(sig).toBe(`0x${"11".repeat(20)}${"00".repeat(31)}01`);
    expect((sig.length - 2) / 2).toBe(52);
  });
});

describe("register calldata", () => {
  const args = {
    agent: AGENT,
    root: 2n,
    nonce: 3n,
    nullifierHash: 4n,
    proof: [5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n] as const,
  };
  test("selector and argument order are pinned", () => {
    const data = encodeRegister({ ...args, proof: [...args.proof] });
    expect(data.slice(0, 10)).toBe(
      toFunctionSelector("register(address,uint256,uint256,uint256,uint256[8])"),
    );
    const decoded = decodeFunctionData({ abi: AGENT_BOOK_ABI, data });
    expect(decoded.functionName).toBe("register");
    expect(decoded.args).toEqual([AGENT, 2n, 3n, 4n, [5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n]]);
    // Raw slot check: three adjacent uint256s reorder silently if the ABI is rebuilt by hand.
    const words = data.slice(10).match(/.{64}/g) ?? [];
    expect(BigInt(`0x${words[1]}`)).toBe(2n); // root
    expect(BigInt(`0x${words[2]}`)).toBe(3n); // nonce
    expect(BigInt(`0x${words[3]}`)).toBe(4n); // nullifierHash
  });
  test("a proof that is not exactly 8 elements is refused before any encoding", () => {
    expect(() => encodeRegister({ ...args, proof: [1n, 2n, 3n] })).toThrow(/exactly 8/);
  });
});

describe("verifier chain pin (design v3 §1.3, audit H1)", () => {
  test("the installed agentkit-core verifier still reads World Chain and the canonical contract", () => {
    const dist = readFileSync("node_modules/@worldcoin/agentkit-core/dist/cjs/index.js", "utf8");
    expect(dist).toContain("worldchain");
    expect(dist.toLowerCase()).toContain(AGENT_BOOK_ADDRESS.toLowerCase());
  });
});

/** A funded-looking key that exists only in this file; it never signs anything real. */
const TEST_KEY = `0x${"ab".repeat(32)}` as const;
/** The same account the registrar derives, for the errors viem stamps an account into. */
const SUBMITTER = privateKeyToAccount(TEST_KEY);
const REGISTER_ARGS = {
  agent: AGENT,
  root: 2n,
  nonce: 3n,
  nullifierHash: 4n,
  proof: [5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n],
};

/** Only the viem calls under test are stubbed; an unstubbed method is a `TypeError`, which is the
 *  point — a read that should go to the write provider (or the reverse) fails loudly here. */
function registrarWith(
  publicClient: Record<string, unknown>,
  walletClient: Record<string, unknown> = {},
) {
  return createAgentBookRegistrar({
    submitterPrivateKey: TEST_KEY,
    readRpcUrl: "http://127.0.0.1:0",
    writeRpcUrl: "http://127.0.0.1:0",
    clients: { publicClient, walletClient } as unknown as NonNullable<RegistrarOptions["clients"]>,
  });
}
/** The read client must never be asked to broadcast: it is pointed at the READ RPC. */
const readClientThatRefusesToSend = {
  sendRawTransaction: () => {
    throw new Error("broadcast went to the read client");
  },
};
const registrarWithSimulate = (simulateContract: () => Promise<unknown>) =>
  registrarWith({ simulateContract });

describe("simulateRegister tells a deterministic revert from a bad minute at the RPC", () => {
  test("a decoded contract revert becomes ContractRevertError carrying the error NAME", async () => {
    const abi = [{ type: "error", name: "AlreadyRegistered", inputs: [] }] as const;
    const reverted = new ContractFunctionRevertedError({
      abi: [...abi],
      data: encodeErrorResult({ abi, errorName: "AlreadyRegistered" }),
      functionName: "register",
    });
    const registrar = registrarWithSimulate(() =>
      Promise.reject(
        new ContractFunctionExecutionError(reverted, {
          abi: [...AGENT_BOOK_ABI],
          functionName: "register",
          contractAddress: AGENT_BOOK_ADDRESS,
          args: [],
        }),
      ),
    );
    const err = await registrar.simulateRegister(REGISTER_ARGS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as ContractRevertError).errorName).toBe("AlreadyRegistered");
    // Exact, because the NAME is the only detail allowed out: viem's prose carries the calldata,
    // and the calldata carries the proof.
    expect((err as Error).message).toBe("AgentBook.register reverted: AlreadyRegistered");
  });

  test("a transport failure is re-thrown UNCHANGED — it says nothing about the contract", async () => {
    const transport = new Error("HTTP 429 Too Many Requests");
    const registrar = registrarWithSimulate(() => Promise.reject(transport));
    await expect(registrar.simulateRegister(REGISTER_ARGS)).rejects.toBe(transport);
  });
});

describe("receiptStatus: 'not mined yet' is one specific viem error, not a shape of words", () => {
  const HASH = `0x${"11".repeat(32)}` as const;

  test("a missing receipt is null — the reconciler's 'still pending' branch", async () => {
    const registrar = registrarWith({
      getTransactionReceipt: () =>
        Promise.reject(new TransactionReceiptNotFoundError({ hash: HASH })),
    });
    expect(await registrar.receiptStatus(HASH)).toBeNull();
  });

  test("a transport failure is re-thrown UNCHANGED — an outage is not a pending transaction", async () => {
    const transport = new Error("rpc down");
    const registrar = registrarWith({ getTransactionReceipt: () => Promise.reject(transport) });
    await expect(registrar.receiptStatus(HASH)).rejects.toBe(transport);
  });

  test("another viem 'could not be found' error is NOT read as 'not mined yet'", async () => {
    // Why the typed check replaced a regex on `shortMessage`: viem has several not-found errors and
    // only ONE of them means "no receipt yet". Swallowing the others as null parks a broken read in
    // the reconciler's pending branch forever, waiting on a receipt nobody is fetching.
    const other = new BlockNotFoundError({ blockNumber: 123n });
    const registrar = registrarWith({ getTransactionReceipt: () => Promise.reject(other) });
    await expect(registrar.receiptStatus(HASH)).rejects.toBe(other);
  });
});

describe("submitRegister", () => {
  /** A wallet client that prepares, signs and broadcasts, with a PENDING nonce that only moves
   *  when something is actually sent — the shape a real node has, and the only shape in which the
   *  lock's job (sign → persist → broadcast, one writer at a time) is observable. */
  function walletStub(over: Record<string, unknown> = {}) {
    let pendingNonce = 7;
    return {
      prepareTransactionRequest: async (args: Record<string, unknown>) => ({
        ...args,
        nonce: pendingNonce,
      }),
      signTransaction: async () => "0x02signed",
      sendRawTransaction: async () => {
        pendingNonce += 1;
        return "0xtxhash";
      },
      ...over,
    };
  }
  const won = () => "won" as const;

  test("signs, persists, then broadcasts — and hands back the nonce it signed under", async () => {
    const order: string[] = [];
    const registrar = registrarWith(readClientThatRefusesToSend, walletStub());
    const res = await registrar.submitRegister(REGISTER_ARGS, (signed) => {
      order.push(`persist:${signed.rawTx}:${signed.submitterNonce}`);
      return "won";
    });
    expect(res).toEqual({
      signed: { rawTx: "0x02signed", submitterNonce: 7 },
      claim: "won",
      txHash: "0xtxhash",
    });
    expect(order).toEqual(["persist:0x02signed:7"]);
  });

  test("a persist that did not win the row broadcasts NOTHING (FR-C)", async () => {
    // The raw transaction exists but the row belongs to another submission: putting it on the wire
    // would spend the submitter's nonce on a registration nobody recorded.
    const sent: string[] = [];
    const registrar = registrarWith(
      readClientThatRefusesToSend,
      walletStub({
        sendRawTransaction: async () => {
          sent.push("sent");
          return "0xtxhash";
        },
      }),
    );
    const res = await registrar.submitRegister(REGISTER_ARGS, () => "inflight");
    expect(res).toEqual({
      signed: { rawTx: "0x02signed", submitterNonce: 7 },
      claim: "inflight",
      txHash: null,
    });
    expect(sent).toEqual([]);
  });

  test("a broadcast failure returns the error NAME and a null hash, never viem's prose", async () => {
    class MempoolError extends Error {
      name = "MempoolError";
    }
    const registrar = registrarWith(
      readClientThatRefusesToSend,
      walletStub({
        sendRawTransaction: () =>
          Promise.reject(new MempoolError(`rejected tx for ${REGISTER_ARGS.nullifierHash}`)),
      }),
    );
    const res = await registrar.submitRegister(REGISTER_ARGS, won);
    expect(res.txHash).toBeNull();
    expect(res.broadcastErrorName).toBe("MempoolError");
    expect(JSON.stringify(res)).not.toContain("rejected tx");
  });

  test("a prepared request with no nonce fails loudly instead of recording NaN", async () => {
    const registrar = registrarWith(
      readClientThatRefusesToSend,
      walletStub({ prepareTransactionRequest: async () => ({}) }),
    );
    await expect(registrar.submitRegister(REGISTER_ARGS, won)).rejects.toThrow(/has no nonce/);
  });

  test("one submitter EOA, one nonce sequence: the lock spans sign, persist AND broadcast (FR-C)", async () => {
    // The stub's pending nonce advances only when something is BROADCAST — exactly like a node.
    // So this test can only pass if the second submission's `prepareTransactionRequest` runs after
    // the first submission's `sendRawTransaction`: the whole sequence, not just the signature,
    // has to be inside the lock.
    const events: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstPersist = true;
    let pendingNonce = 7;
    const registrar = registrarWith(
      readClientThatRefusesToSend,
      walletStub({
        prepareTransactionRequest: async (args: Record<string, unknown>) => {
          events.push(`prepare:${pendingNonce}`);
          return { ...args, nonce: pendingNonce };
        },
        sendRawTransaction: async () => {
          events.push("send");
          pendingNonce += 1;
          return "0xtxhash";
        },
      }),
    );
    const persist = async () => {
      events.push("persist");
      if (firstPersist) {
        firstPersist = false;
        await held; // the first submission is still writing its row
      }
      return "won" as const;
    };

    const a = registrar.submitRegister(REGISTER_ARGS, persist);
    const b = registrar.submitRegister(REGISTER_ARGS, persist);
    await new Promise((r) => setTimeout(r, 0));
    // The second call has not even prepared: it is waiting on the lock the first still holds.
    expect(events).toEqual(["prepare:7", "persist"]);
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(events).toEqual(["prepare:7", "persist", "send", "prepare:8", "persist", "send"]);
    // Distinct nonces, in the order they were broadcast — the whole point of the lock.
    expect([first.signed.submitterNonce, second.signed.submitterNonce]).toEqual([7, 8]);
  });

  test("a revert found during gas estimation is classified, not leaked as viem prose", async () => {
    // Simulate passed, then the world moved (someone else registered this agent) and
    // `prepareTransactionRequest`'s estimate reverts. That is deterministic: retrying cannot fix
    // it. Shaped the way viem raises it — the revert nested inside the estimate error.
    const registrar = registrarWith(
      {
        ...readClientThatRefusesToSend,
        // An estimate's revert alone is not a verdict: the registrar asks the fee-less simulation
        // of the same call, and it is the simulation reverting too that makes this one.
        simulateContract: () =>
          Promise.reject(
            new ContractFunctionExecutionError(
              new ContractFunctionRevertedError({
                abi: [...AGENT_BOOK_ABI],
                data: "0xdeadbeef",
                functionName: "register",
              }),
              {
                abi: [...AGENT_BOOK_ABI],
                functionName: "register",
                contractAddress: AGENT_BOOK_ADDRESS,
                args: [],
              },
            ),
          ),
      },
      walletStub({
        prepareTransactionRequest: () =>
          Promise.reject(
            new EstimateGasExecutionError(
              new ExecutionRevertedError({ message: "execution reverted: 0xdeadbeef" }),
              { account: SUBMITTER },
            ),
          ),
      }),
    );
    const err = await registrar.submitRegister(REGISTER_ARGS, won).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as Error).message).toBe("AgentBook.register reverted: unknown");
  });

  test("an estimate that failed for want of GAS MONEY is not a revert", async () => {
    // A drained submitter is an operations problem: the route turns transport-shaped failures into
    // a 503 and checks the balance separately. Calling it a revert would tell the reconciler the
    // proof is bad and stop it retrying a registration that only needs the wallet topped up.
    const broke = new EstimateGasExecutionError(
      new InsufficientFundsError({ cause: new BaseError("insufficient funds for gas * price") }),
      { account: SUBMITTER },
    );
    const registrar = registrarWith(
      readClientThatRefusesToSend,
      walletStub({ prepareTransactionRequest: () => Promise.reject(broke) }),
    );
    await expect(registrar.submitRegister(REGISTER_ARGS, won)).rejects.toBe(broke);
  });
});

/**
 * The same classification against what a NODE says, with viem doing all of the wrapping.
 *
 * The tests above hand-build viem's errors, which encodes what their author believed viem
 * produces. These put a fake node behind viem's real `http` transport (`helpers/fakeRpcNode`) and
 * let viem build whatever it really builds.
 *
 * What they pin: the gas estimate is never the judge of the proof. It runs with fee fields, so the
 * submitter's balance shapes its answer, and a sender that cannot pay can come back looking exactly
 * like a revert: viem raises "gas required exceeds allowance" as `ExecutionRevertedError`, and some
 * nodes answer a sender that can pay for most, not all, of the gas with a plain code-3 "execution
 * reverted". So an estimate that fails as a revert only sends the registrar back to the fee-less
 * simulation (`eth_call`), which the balance cannot touch, and only that simulation can reject.
 *
 * Three node shapes, because viem asks each one a different first question for a local account:
 *  - a node that fills transactions: `eth_fillTransaction` is asked first and is where it fails;
 *  - a node without it: viem falls back to the single calls, and the estimate is `eth_estimateGas`;
 *  - a node that refuses `eth_fillTransaction` with an HTTP 401, as World Chain's default public
 *    endpoint does: viem falls back exactly as it does for the second shape.
 */
const UNFUNDED: NodeAnswer = {
  // geth's answer, word for word, to an estimate from a sender whose balance buys no gas. World
  // Chain's default public endpoint answers a fresh, empty address exactly this way.
  error: { code: -32000, message: "gas required exceeds allowance (0)" },
};

/** The fee-less simulation passing: `register` returns nothing. */
const SIMULATION_PASSES: NodeAnswer = { result: "0x" };

/** A node that could not serve the call: JSON-RPC -32603, words that say nothing of a revert. */
const NODE_INTERNAL_ERROR: NodeAnswer = {
  error: { code: -32603, message: "We are not able to process your request at this time" },
};

/** `Error(string)`, the one revert viem decodes against ANY ABI. */
const SOLIDITY_ERROR = [
  { type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] },
] as const;
/** A revert reason: free text of the kind that must never leave the adapter. Only a NAME may. */
const REASON = `nullifier ${REGISTER_ARGS.nullifierHash} already spent`;
const NAMED_REVERT = encodeErrorResult({ abi: SOLIDITY_ERROR, errorName: "Error", args: [REASON] });

/** A node that refuses `eth_fillTransaction`, as World Chain's default public endpoint does. */
const PUBLIC_RPC_REFUSES_FILL: NodeAnswer = {
  httpStatus: 401,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32600, message: "Only core evm requests are allowed." },
  }),
};

/** viem's traffic for a local account on a node that does not fill: it asks for a fill, is refused,
 *  and falls back to the nonce, the block, the tip and the estimate, one call each. */
const SINGLE_CALLS = [
  "eth_fillTransaction",
  "eth_getTransactionCount",
  "eth_getBlockByNumber",
  "eth_maxPriorityFeePerGas",
  "eth_estimateGas",
];

interface NodeShape {
  name: string;
  node: Pick<FakeNodeOptions, "fillTransaction" | "answer">;
  /** The RPC traffic of a submission whose estimate the node refuses, up to the estimate. */
  preflightCalls: readonly string[];
  /** The class viem throws for an estimate the node refuses. */
  outer: typeof TransactionExecutionError | typeof EstimateGasExecutionError;
  /** The cause chains viem builds, outermost first: around a code-3 revert, and around UNFUNDED
   *  (whose -32000 viem first maps to `InvalidInputRpcError`, and only then reads the text of). */
  revertChain: readonly string[];
  unfundedChain: readonly string[];
}

const NODE_SHAPES: NodeShape[] = [
  {
    name: "a node that fills transactions",
    node: { fillTransaction: true },
    preflightCalls: ["eth_fillTransaction"],
    outer: TransactionExecutionError,
    revertChain: ["TransactionExecutionError", "ExecutionRevertedError", "RpcRequestError"],
    unfundedChain: [
      "TransactionExecutionError",
      "ExecutionRevertedError",
      "InvalidInputRpcError",
      "RpcRequestError",
    ],
  },
  {
    name: "a node without eth_fillTransaction",
    node: { fillTransaction: false },
    preflightCalls: SINGLE_CALLS,
    outer: EstimateGasExecutionError,
    revertChain: ["EstimateGasExecutionError", "ExecutionRevertedError", "RpcRequestError"],
    unfundedChain: [
      "EstimateGasExecutionError",
      "ExecutionRevertedError",
      "InvalidInputRpcError",
      "RpcRequestError",
    ],
  },
  {
    name: "a node that refuses eth_fillTransaction with an HTTP 401",
    node: {
      answer: (method) => (method === "eth_fillTransaction" ? PUBLIC_RPC_REFUSES_FILL : undefined),
    },
    preflightCalls: SINGLE_CALLS,
    outer: EstimateGasExecutionError,
    revertChain: ["EstimateGasExecutionError", "ExecutionRevertedError", "RpcRequestError"],
    unfundedChain: [
      "EstimateGasExecutionError",
      "ExecutionRevertedError",
      "InvalidInputRpcError",
      "RpcRequestError",
    ],
  },
];

/** The real registrar, both of its clients on World Chain and on `node`. */
function registrarOver(node: FakeRpcNode) {
  return createAgentBookRegistrar({
    submitterPrivateKey: TEST_KEY,
    readRpcUrl: FAKE_RPC_URL,
    writeRpcUrl: FAKE_RPC_URL,
    clients: {
      publicClient: createPublicClient({ chain: worldchain, transport: node.transport }),
      walletClient: createWalletClient({
        chain: worldchain,
        transport: node.transport,
        account: SUBMITTER,
      }),
    } as unknown as NonNullable<RegistrarOptions["clients"]>,
  });
}

describe.each(NODE_SHAPES)("submitRegister against $name", (shape) => {
  /** One submission against a node that answers as `o` says, and answers the fee-less simulation
   *  (`eth_call`) with `simulation` when one is given. Every case here fails before persist. */
  async function submitAgainst(o: FakeNodeOptions, simulation?: NodeAnswer) {
    const node = fakeRpcNode({
      ...shape.node,
      ...o,
      answer: (method, params) =>
        method === "eth_call" && simulation ? simulation : shape.node.answer?.(method, params),
    });
    const persist = vi.fn(() => "won" as const);
    const err = await failureOf(registrarOver(node).submitRegister(REGISTER_ARGS, persist));
    return { err, node, persist };
  }

  test("a submitter that cannot pay for gas is NOT a revert, although viem gives it the revert class", async () => {
    const { err, node, persist } = await submitAgainst({ preflight: UNFUNDED });
    // The trap, exactly as viem builds it: the node's -32000 comes back as `ExecutionRevertedError`.
    // Its text already says the failure is about the sender, so no simulation is even asked.
    expect(node.calls).toEqual(shape.preflightCalls);
    expect(causeChain(err)).toEqual(shape.unfundedChain);
    expect((err as BaseError).walk((x) => x instanceof ExecutionRevertedError)).toBeInstanceOf(
      ExecutionRevertedError,
    );
    // ...and it is re-thrown as viem threw it. A revert verdict here would end the guardian's
    // session as failed, and a World proof cannot be replayed: the wallet only needs topping up.
    expect(err).toBeInstanceOf(shape.outer);
    expect(err).not.toBeInstanceOf(ContractRevertError);
    expect(persist).not.toHaveBeenCalled();
    expect(node.calls).not.toContain("eth_sendRawTransaction");
  });

  test.each<[string, NodeAnswer]>([
    ["capitalised", { error: { code: -32000, message: "Gas required exceeds allowance (0)" } }],
    [
      "under JSON-RPC code 3",
      { error: { code: 3, message: "gas required exceeds allowance (0)" } },
    ],
  ])(
    "the same answer %s is NOT a revert either, and asks no simulation",
    async (_label, answer) => {
      const { err, node, persist } = await submitAgainst({ preflight: answer });
      expect(node.calls).toEqual(shape.preflightCalls);
      expect(causeChain(err)).toContain("ExecutionRevertedError");
      expect(err).toBeInstanceOf(shape.outer);
      expect(err).not.toBeInstanceOf(ContractRevertError);
      expect(persist).not.toHaveBeenCalled();
    },
  );

  test("an estimate that says 'execution reverted' while the fee-less simulation PASSES is not a revert", async () => {
    // Some nodes answer a sender that can pay for most, but not all, of the gas this way: a plain
    // code 3 with no data, which nothing in the answer tells apart from a real revert. The
    // simulation, which the balance cannot touch, says the contract would accept the call.
    const { err, node, persist } = await submitAgainst(
      { preflight: nodeRevert() },
      SIMULATION_PASSES,
    );
    // The estimate's own error, re-thrown as viem threw it: transport, so the session stays open.
    expect(causeChain(err)).toEqual(shape.revertChain);
    expect(err).toBeInstanceOf(shape.outer);
    expect(err).not.toBeInstanceOf(ContractRevertError);
    expect(node.calls).toEqual([...shape.preflightCalls, "eth_call"]);
    expect(persist).not.toHaveBeenCalled();
    expect(node.calls).not.toContain("eth_sendRawTransaction");
  });

  test("an estimate revert the simulation confirms is a ContractRevertError, with the name the simulation decoded", async () => {
    const { err, node, persist } = await submitAgainst(
      { preflight: nodeRevert("0xdeadbeef") },
      nodeRevert(NAMED_REVERT),
    );
    // The SIMULATION's verdict: it had the ABI in hand, so it carries a name the estimate could not.
    expect(causeChain(err).slice(0, 3)).toEqual([
      "ContractRevertError",
      "ContractFunctionExecutionError",
      "ContractFunctionRevertedError",
    ]);
    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as ContractRevertError).errorName).toBe("Error");
    // Exact: the name is the only detail allowed out, never the reason string.
    expect((err as Error).message).toBe("AgentBook.register reverted: Error");
    expect(node.calls).toEqual([...shape.preflightCalls, "eth_call"]);
    expect(persist).not.toHaveBeenCalled();
    expect(node.calls).not.toContain("eth_sendRawTransaction");
  });

  test("an estimate revert confirmed by a simulation revert with NO data is a ContractRevertError with no name", async () => {
    const { err, persist } = await submitAgainst({ preflight: nodeRevert() }, nodeRevert());
    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as ContractRevertError).errorName).toBeUndefined();
    expect((err as Error).message).toBe("AgentBook.register reverted: unknown");
    expect(persist).not.toHaveBeenCalled();
  });

  test.each<[string, NodeAnswer]>([
    ["a timeout", { hang: true }],
    ["an HTTP 429", { httpStatus: 429, body: "rate limited" }],
    ["a node's internal error", NODE_INTERNAL_ERROR],
  ])(
    "an estimate revert whose simulation fails with %s is NOT a revert: the estimate's error is re-thrown",
    async (_label, simulation) => {
      const { err, node, persist } = await submitAgainst(
        { preflight: nodeRevert("0xdeadbeef") },
        simulation,
      );
      // The ORIGINAL error, untouched: a simulation that could not run judged nothing.
      expect(causeChain(err)).toEqual(shape.revertChain);
      expect(err).not.toBeInstanceOf(ContractRevertError);
      expect(node.calls).toEqual([...shape.preflightCalls, "eth_call"]);
      expect(persist).not.toHaveBeenCalled();
      expect(node.calls).not.toContain("eth_sendRawTransaction");
    },
  );

  test.each<[string, FakeNodeOptions, string]>([
    [
      "insufficient funds",
      {
        preflight: {
          error: { code: -32000, message: "insufficient funds for gas * price + value" },
        },
      },
      "InsufficientFundsError",
    ],
    [
      // Some nodes answer a partly-funded sender this way.
      "an out-of-gas rejection",
      {
        preflight: { error: { code: -32003, message: "out of gas: gas required exceeds: 52000" } },
      },
      "TransactionRejectedRpcError",
    ],
    ["an HTTP 429", { everyCall: { httpStatus: 429, body: "rate limited" } }, "HttpRequestError"],
    ["a timeout", { everyCall: { hang: true } }, "TimeoutError"],
  ])("%s is NOT a revert: re-thrown as viem threw it", async (_label, answer, inner) => {
    const { err, node, persist } = await submitAgainst(answer);
    expect(err).not.toBeInstanceOf(ContractRevertError);
    expect(err).toBeInstanceOf(BaseError);
    // ...and the case is the one it claims to be.
    expect(causeChain(err)).toContain(inner);
    expect(persist).not.toHaveBeenCalled();
    expect(node.calls).not.toContain("eth_sendRawTransaction");
  });
});

describe("simulateRegister against a node", () => {
  test("a revert the ABI decodes is a ContractRevertError carrying the error NAME, and nothing else", async () => {
    // `Error(string)`: its reason string is the kind of free text that must not leave the adapter.
    const node = fakeRpcNode({
      answer: (method) => (method === "eth_call" ? nodeRevert(NAMED_REVERT) : undefined),
    });
    const err = await failureOf(registrarOver(node).simulateRegister(REGISTER_ARGS));
    expect(node.calls).toEqual(["eth_call"]);
    expect(causeChain(err).slice(0, 3)).toEqual([
      "ContractRevertError",
      "ContractFunctionExecutionError",
      "ContractFunctionRevertedError",
    ]);
    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as ContractRevertError).errorName).toBe("Error");
    expect((err as Error).message).toBe("AgentBook.register reverted: Error");
  });

  test("a node's internal error is NOT a revert, although viem builds the decoded revert class for it", async () => {
    // viem builds `ContractFunctionRevertedError` for code 3 AND for -32603 with any message. With
    // no revert bytes and no "execution reverted" in the node's words, nothing says the contract
    // refused: a node that could not serve the call has judged nothing.
    const node = fakeRpcNode({
      answer: (method) => (method === "eth_call" ? NODE_INTERNAL_ERROR : undefined),
    });
    const err = await failureOf(registrarOver(node).simulateRegister(REGISTER_ARGS));
    expect(node.calls).toEqual(["eth_call"]);
    // The trap, exactly as viem builds it...
    expect(causeChain(err)).toContain("ContractFunctionRevertedError");
    // ...and re-thrown as viem threw it.
    expect(causeChain(err)[0]).toBe("ContractFunctionExecutionError");
    expect(err).not.toBeInstanceOf(ContractRevertError);
  });

  test("a code-3 revert with NO data, in the node's own words 'execution reverted', is still a ContractRevertError", async () => {
    const node = fakeRpcNode({
      answer: (method) => (method === "eth_call" ? nodeRevert() : undefined),
    });
    const err = await failureOf(registrarOver(node).simulateRegister(REGISTER_ARGS));
    expect(err).toBeInstanceOf(ContractRevertError);
    expect((err as ContractRevertError).errorName).toBeUndefined();
    expect((err as Error).message).toBe("AgentBook.register reverted: unknown");
  });
});

describe("write and read providers stay on their own RPC", () => {
  test("broadcast goes through the WRITE client, which is where the nonce was taken", async () => {
    const sent: string[] = [];
    const registrar = registrarWith(readClientThatRefusesToSend, {
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: string }) => {
        sent.push(serializedTransaction);
        return "0xtxhash";
      },
    });
    expect(await registrar.broadcast("0x02signed")).toBe("0xtxhash");
    expect(sent).toEqual(["0x02signed"]);
  });

  test("submitterNonce is the READ provider's MINED count — one provider, one verdict (FR-E)", async () => {
    // Two things are pinned here. The provider: the reconciler compares this count with the
    // receipt it just read through `receiptStatus`, i.e. the READ client, and a "replaced" verdict
    // built from two providers that disagree by one transaction marks a successful vouch failed.
    // And the block tag: "latest", because a "pending" count includes our own unmined
    // registration, which would read as "the chain moved past our nonce" while it is merely slow.
    const asked: unknown[] = [];
    const registrar = registrarWith(
      {
        request: async (req: { method: string; params: unknown }) => {
          asked.push(req);
          return "0x9";
        },
      },
      {
        getTransactionCount: () => {
          throw new Error("nonce read from the write client");
        },
      },
    );
    expect(await registrar.submitterNonce()).toBe(9);
    expect(asked).toEqual([
      { method: "eth_getTransactionCount", params: [expect.any(String), "latest"] },
    ]);
  });
});
