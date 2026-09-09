import { readFileSync } from "node:fs";
import {
  BaseError,
  BlockNotFoundError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  EstimateGasExecutionError,
  ExecutionRevertedError,
  InsufficientFundsError,
  TransactionReceiptNotFoundError,
  decodeFunctionData,
  encodeErrorResult,
  toFunctionSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, test } from "vitest";
import { ContractRevertError } from "../../src/adapters/arc/relay";
import {
  type RegistrarOptions,
  buildSignal,
  createAgentBookRegistrar,
  encodeRegister,
} from "../../src/adapters/worldid/agentBookRegistrar";
import { AGENT_BOOK_ABI, AGENT_BOOK_ADDRESS } from "../../src/payments/agentBookReader";

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
      readClientThatRefusesToSend,
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
