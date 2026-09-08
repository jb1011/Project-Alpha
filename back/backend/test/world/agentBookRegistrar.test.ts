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
  keccak256,
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
  hashSignal,
} from "../../src/adapters/worldid/agentBookRegistrar";
import { AGENT_BOOK_ABI, AGENT_BOOK_ADDRESS } from "../../src/payments/agentBookReader";

const AGENT = "0x1111111111111111111111111111111111111111" as const;

describe("signal", () => {
  test("golden vector: address (20 bytes) ++ nonce (32 bytes), packed, 52 bytes", () => {
    const sig = buildSignal(AGENT, 1n);
    expect(sig).toBe(`0x${"11".repeat(20)}${"00".repeat(31)}01`);
    expect((sig.length - 2) / 2).toBe(52);
  });
  test("hashSignal is keccak256 >> 8 (World's hashToField)", () => {
    const sig = buildSignal(AGENT, 7n);
    expect(hashSignal(sig)).toBe(BigInt(keccak256(sig)) >> 8n);
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

describe("signRegister", () => {
  /** A wallet client that prepares, signs, and screams if asked to broadcast. */
  function walletStub(over: Record<string, unknown> = {}) {
    return {
      prepareTransactionRequest: async (args: Record<string, unknown>) => ({ ...args, nonce: 7 }),
      signTransaction: async () => "0x02signed",
      sendRawTransaction: () => {
        throw new Error("signRegister broadcast");
      },
      ...over,
    };
  }

  test("returns the raw tx and the EVM nonce it signed under, and broadcasts NOTHING", async () => {
    // The caller persists the attempt BEFORE broadcasting (bridge-legs rule), so a signRegister
    // that also sent would put an unrecorded transaction on chain.
    const registrar = registrarWith(readClientThatRefusesToSend, walletStub());
    expect(await registrar.signRegister(REGISTER_ARGS)).toEqual({
      rawTx: "0x02signed",
      submitterNonce: 7,
    });
  });

  test("a prepared request with no nonce fails loudly instead of recording NaN", async () => {
    const registrar = registrarWith(
      readClientThatRefusesToSend,
      walletStub({ prepareTransactionRequest: async () => ({}) }),
    );
    await expect(registrar.signRegister(REGISTER_ARGS)).rejects.toThrow(/has no nonce/);
  });

  test("one submitter EOA, one nonce sequence: signing is serialized by the keyed lock", async () => {
    const events: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstSign = true;
    const registrar = registrarWith(
      readClientThatRefusesToSend,
      walletStub({
        prepareTransactionRequest: async (args: Record<string, unknown>) => {
          events.push("prepare");
          return { ...args, nonce: 7 };
        },
        signTransaction: async () => {
          events.push("sign");
          if (firstSign) {
            firstSign = false;
            await held; // the first signature is still in flight
          }
          return "0x02signed";
        },
      }),
    );

    const a = registrar.signRegister(REGISTER_ARGS);
    const b = registrar.signRegister(REGISTER_ARGS);
    await new Promise((r) => setTimeout(r, 0));
    // Without the lock the second call would have read the same pending nonce here and both
    // transactions would fight for it; one of them would be dropped.
    expect(events).toEqual(["prepare", "sign"]);
    release();
    await Promise.all([a, b]);
    expect(events).toEqual(["prepare", "sign", "prepare", "sign"]);
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
    const err = await registrar.signRegister(REGISTER_ARGS).catch((e: unknown) => e);
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
    await expect(registrar.signRegister(REGISTER_ARGS)).rejects.toBe(broke);
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

  test("submitterNonce is the WRITE provider's MINED count, not the read provider's", async () => {
    // Two things are pinned here. The provider: two RPCs can disagree by a transaction, and this
    // number is only meaningful next to the nonce the signer took. And the block tag: "latest",
    // because a "pending" count includes our own unmined registration, which the reconciler would
    // read as "the chain moved past our nonce, we were replaced" while it is merely slow.
    const asked: unknown[] = [];
    const registrar = registrarWith(
      {
        getTransactionCount: () => {
          throw new Error("nonce read from the read client");
        },
      },
      {
        request: async (req: { method: string; params: unknown }) => {
          asked.push(req);
          return "0x9";
        },
      },
    );
    expect(await registrar.submitterNonce()).toBe(9);
    expect(asked).toEqual([
      { method: "eth_getTransactionCount", params: [expect.any(String), "latest"] },
    ]);
  });
});
