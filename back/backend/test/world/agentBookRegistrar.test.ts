import { readFileSync } from "node:fs";
import {
  BlockNotFoundError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  decodeFunctionData,
  encodeErrorResult,
  keccak256,
  toFunctionSelector,
} from "viem";
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
const REGISTER_ARGS = {
  agent: AGENT,
  root: 2n,
  nonce: 3n,
  nullifierHash: 4n,
  proof: [5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n],
};

/** Only the one viem call under test is stubbed; neither path touches the wallet client. */
function registrarWith(publicClient: Record<string, unknown>) {
  return createAgentBookRegistrar({
    submitterPrivateKey: TEST_KEY,
    readRpcUrl: "http://127.0.0.1:0",
    writeRpcUrl: "http://127.0.0.1:0",
    clients: { publicClient, walletClient: {} } as unknown as NonNullable<
      RegistrarOptions["clients"]
    >,
  });
}
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
