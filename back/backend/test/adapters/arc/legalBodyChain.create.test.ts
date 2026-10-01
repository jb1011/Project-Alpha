/**
 * LegalBodyChain's CREATE. The sending half: simulate the relayed create, bound its gas and its
 * fee, prepare it, then sign, record and send it inside the executor's sender lock. The confirming
 * half: what the chain says about the create, from one receipt, or from the factory's logs.
 *
 * The relay seam is a plain object of mocks; the real ArcAdapter's half of this sequence has tests
 * of its own. The sender lock is the REAL one, and every fake notes whether it ran with the
 * executor's lock held, so the lock window is measured here, not assumed. The confirming half
 * reads from a fake node whose `getLogs` filters by address, block range and topic, as a node does.
 */
import {
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  HttpRequestError,
  InvalidInputRpcError,
  type Log,
  type PublicClient,
  RawContractError,
  RpcRequestError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  getAbiItem,
  isAddressEqual,
} from "viem";
import { describe, expect, test, vi } from "vitest";
import { legalBodyFactoryAbi, noviControllerAbi } from "../../../src/abis/generated";
import type { PreparedRelayedCall, RelayedCall } from "../../../src/adapters/arc/arcAdapter";
import {
  CREATE_GAS_CEILING,
  CREATE_MAX_FEE_WEI,
  CREATION_LOG_WINDOW_BLOCKS,
  LegalBodyChain,
  LegalBodyChainFaultError,
  type LegalBodyCreated,
  LegalBodyFeeTooHighError,
  LegalBodyGasTooHighError,
  type RelaySeam,
  type SubmitCreateResult,
} from "../../../src/adapters/arc/legalBodyChain";
import { RECEIPT_TIMEOUT_MS } from "../../../src/adapters/arc/receipts";
import { ContractRevertError, relayRevertError } from "../../../src/adapters/arc/relay";
import { senderLockHeld, withSenderLock } from "../../../src/adapters/arc/senderLock";
import { ChainTxRevertedError, ChainTxUnconfirmedError } from "../../../src/errors";
import type { LegalBodyLink } from "../../../src/legalBody/link";
import { failureOf } from "../../helpers/fakeRpcNode";

/** Placeholder contracts and parties, checksummed. */
const FACTORY = "0x00000000000000000000000000000000000000fb" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000002" as Address;
const CONTROLLER = "0x000000000000000000000000000000000000c0DE" as Address;
/** The platform account that signs and pays for the create: the sender lock's key. */
const EXECUTOR = "0x000000000000000000000000000000000000E0E0" as Address;
const GUARDIAN = "0x00000000000000000000000000000000000A11cE" as Address;
const CHAIN_ID = 5042002;
const NODE_URL = "http://node.invalid";

const LINK: LegalBodyLink = {
  agentId: 42n,
  guardian: GUARDIAN,
  amendmentDelay: 172_800n,
  operatingAgreementHash: `0x${"ab".repeat(32)}` as Hex,
  deadline: 1_900_003_600n,
};
const SIGNATURE = `0x${"5a".repeat(65)}` as Hex;

/** The node's estimate unless a test says otherwise, and the limit it gives with 25 % on top. */
const ESTIMATE = 300_000n;
const LIMIT = 375_000n;
/** 200 gwei per gas: 0.075 USDC at LIMIT, well under the cap. */
const FEE_PER_GAS = 200_000_000_000n;

/** What the signer hands back: the hash, the bytes and the nonce, all known before any send. */
const SIGNED = {
  txHash: `0x${"7a".repeat(32)}` as Hex,
  rawTx: `0x02${"ee".repeat(120)}` as Hex,
  nonce: 7,
};

type Step = "estimate" | "prepare" | "sign" | "record" | "send";

interface WorldOptions {
  /** The node's answer to the simulation. */
  estimate?: () => Promise<bigint>;
  /** The fee fields of the prepared request (default: an EIP-1559 fee well under the cap). */
  fees?: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint };
  /** The node's answer to the raw send. */
  send?: (rawTx: Hex) => Promise<Hex>;
  /** `null`: a relay seam with no platform account. */
  executor?: null;
  /** The node the confirming half reads from (default: none; the sending half reads nothing). */
  publicClient?: PublicClient;
}

/**
 * A LegalBodyChain over a mocked relay seam. `steps` lists each seam call and the record, in
 * order, with whether the executor's sender lock was held when it ran.
 */
function world(opts: WorldOptions = {}) {
  const steps: [Step, boolean][] = [];
  const note = (step: Step) => steps.push([step, senderLockHeld(EXECUTOR)]);
  const arc = {
    chainId: CHAIN_ID,
    platformAddress: opts.executor === null ? undefined : EXECUTOR,
    platformNonce: vi.fn(async () => 0),
    estimateRelayedCall: vi.fn(async (_call: RelayedCall) => {
      note("estimate");
      return (opts.estimate ?? (async () => ESTIMATE))();
    }),
    prepareRelayedCall: vi.fn(async (call: RelayedCall, gas: bigint) => {
      note("prepare");
      return {
        call,
        gas,
        request: {
          type: "eip1559",
          to: CONTROLLER,
          data: "0x",
          gas,
          chainId: CHAIN_ID,
          ...(opts.fees ?? { maxFeePerGas: FEE_PER_GAS, maxPriorityFeePerGas: 1n }),
        },
      } as unknown as PreparedRelayedCall;
    }),
    signRelayedCall: vi.fn(async (_prepared: PreparedRelayedCall) => {
      note("sign");
      return { ...SIGNED };
    }),
    sendRawRelayedCall: vi.fn(async (rawTx: Hex) => {
      note("send");
      return (opts.send ?? (async () => SIGNED.txHash))(rawTx);
    }),
  } satisfies RelaySeam;
  const record = vi.fn((_signed: { txHash: Hex; rawTx: Hex; nonce: number }) => {
    note("record");
    return true;
  });
  const chain = new LegalBodyChain({
    // Nothing in the create's sending half reads from the public client.
    publicClient: opts.publicClient ?? ({} as PublicClient),
    arc,
    chainId: CHAIN_ID,
    factory: FACTORY,
    identityRegistry: REGISTRY,
  });
  return { chain, arc, record, steps };
}

/** A node answer that is an error, for the simulation or the send. */
const failing = (e: unknown) => async (): Promise<never> => {
  throw e;
};

/**
 * Run `fn` while another section holds the executor's sender lock (or `sender`'s: `undefined` is
 * the lock a section with no named sender takes). A call that waits for the lock cannot settle in
 * here, so a call that does settle settled without taking it. One that waits fails after a second
 * instead, and the lock is released either way, so no later test inherits it.
 */
async function whileLockHeldElsewhere<T>(
  fn: () => Promise<T>,
  { sender }: { sender: Address | undefined } = { sender: EXECUTOR },
): Promise<T> {
  let release: (() => void) | undefined;
  const holder = withSenderLock(
    sender,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("the call waited for the executor's sender lock")),
      1_000,
    );
  });
  try {
    return await Promise.race([fn(), waited]);
  } finally {
    clearTimeout(timer);
    release?.();
    await holder;
  }
}

/** The ContractRevertError the relay seam raises for these revert bytes, decoded as it decodes
 *  them: against the factory's ABI and the controller's. */
function revertOf(data: Hex): ContractRevertError {
  const err = relayRevertError(new RawContractError({ data }), {
    abi: legalBodyFactoryAbi as Abi,
    functionName: "createLegalBody",
    target: FACTORY,
    controller: CONTROLLER,
  });
  if (!(err instanceof ContractRevertError)) throw new Error("expected a ContractRevertError");
  return err;
}

const BAD_SIGNATURE = encodeErrorResult({ abi: legalBodyFactoryAbi, errorName: "BadSignature" });

/** A value of each ABI type the declared errors take, to encode one of them with. */
function sampleArg(type: string): unknown {
  if (type === "address") return EXECUTOR;
  if (type === "bytes4") return "0x12345678";
  if (type === "bytes32") return `0x${"aa".repeat(32)}`;
  if (type === "string") return "x";
  if (/^uint\d+$/.test(type)) return 1n;
  throw new Error(`no sample value for the ABI type ${type}`);
}

/** The revert bytes of the error `name`, as the factory's ABI or the controller's declares it. */
function revertBytes(name: string): Hex {
  for (const abi of [legalBodyFactoryAbi, noviControllerAbi] as Abi[]) {
    const item = abi.find((x) => x.type === "error" && x.name === name);
    if (item?.type === "error")
      return encodeErrorResult({
        abi: [item],
        errorName: name,
        args: item.inputs.map((input) => sampleArg(input.type)),
      });
  }
  throw new Error(`neither ABI declares ${name}`);
}

/** The reverts that are a fault of the platform's setup: every error the controller declares, the
 *  factory's ownership errors, and the errors of its deployment of a body. */
const PLATFORM_FAULTS = [
  ...(noviControllerAbi as Abi).flatMap((x) => (x.type === "error" ? [x.name] : [])),
  "OwnableUnauthorizedAccount",
  "OwnableInvalidOwner",
  "FailedDeployment",
  "InsufficientBalance",
  "NotContract",
  "NotImplementation",
];
/** The factory's refusals of the link itself. */
const LINK_REFUSALS = ["BadSignature", "BadDeadline", "LegalBodyExists", "BadGuardian", "BadDelay"];

describe("estimateCreate", () => {
  test("estimateCreate relays createLegalBody at the factory with the six arguments, and adds 25 %", async () => {
    const { chain, arc } = world();
    await expect(chain.estimateCreate(LINK, SIGNATURE)).resolves.toBe(LIMIT);

    expect(arc.estimateRelayedCall).toHaveBeenCalledTimes(1);
    const call = arc.estimateRelayedCall.mock.calls[0]![0];
    expect(call.target).toBe(FACTORY);
    expect(call.abi).toBe(legalBodyFactoryAbi);
    expect(call.functionName).toBe("createLegalBody");
    expect(call.args).toEqual([
      LINK.agentId,
      LINK.guardian,
      LINK.amendmentDelay,
      LINK.operatingAgreementHash,
      LINK.deadline,
      SIGNATURE,
    ]);
  });

  test("the ceiling bounds the LIMIT: an estimate of 480,000 passes at 600,000; 480,001 throws", async () => {
    expect(CREATE_GAS_CEILING).toBe(600_000n);
    await expect(
      world({ estimate: async () => 480_000n }).chain.estimateCreate(LINK, SIGNATURE),
    ).resolves.toBe(600_000n);

    const err = await failureOf(
      world({ estimate: async () => 480_001n }).chain.estimateCreate(LINK, SIGNATURE),
    );
    expect(err).toBeInstanceOf(LegalBodyGasTooHighError);
    expect((err as LegalBodyGasTooHighError).estimate).toBe(480_001n);
    // The estimate is below the ceiling; it is the limit, 600,001, that is above it.
    expect((err as Error).message).toContain("480001");
    expect((err as Error).message).toContain("600001");
    expect((err as Error).message).toContain("600000");
  });

  test("NotAuthorized and OwnableUnauthorizedAccount are platform faults; BadSignature and NotLegalBody stay contract reverts", async () => {
    const estimating = (e: unknown) =>
      failureOf(world({ estimate: failing(e) }).chain.estimateCreate(LINK, SIGNATURE));

    const notAuthorized = revertOf(
      encodeErrorResult({
        abi: noviControllerAbi,
        errorName: "NotAuthorized",
        args: ["0x12345678", EXECUTOR],
      }),
    );
    const ownable = revertOf(
      encodeErrorResult({
        abi: legalBodyFactoryAbi,
        errorName: "OwnableUnauthorizedAccount",
        args: [EXECUTOR],
      }),
    );
    for (const [revert, name] of [
      [notAuthorized, "NotAuthorized"],
      [ownable, "OwnableUnauthorizedAccount"],
    ] as const) {
      expect(revert.errorName).toBe(name);
      const fault = await estimating(revert);
      expect(fault).toBeInstanceOf(LegalBodyChainFaultError);
      // A fault is ours to fix: nothing that reads a ContractRevertError as a refusal may see one.
      expect(fault).not.toBeInstanceOf(ContractRevertError);
      expect((fault as LegalBodyChainFaultError).errorName).toBe(name);
      expect((fault as Error).cause).toBe(revert);
    }

    const badSignature = revertOf(BAD_SIGNATURE);
    const notLegalBody = revertOf(
      encodeErrorResult({ abi: legalBodyFactoryAbi, errorName: "NotLegalBody", args: [GUARDIAN] }),
    );
    const undecodable = revertOf("0xdeadbeef");
    expect([badSignature, notLegalBody, undecodable].map((r) => r.errorName)).toEqual([
      "BadSignature",
      "NotLegalBody",
      "",
    ]);
    for (const revert of [badSignature, notLegalBody, undecodable])
      await expect(estimating(revert)).resolves.toBe(revert);
  });

  test.each(PLATFORM_FAULTS)(
    "%s from the simulation is a platform fault: LegalBodyChainFaultError with that name",
    async (name) => {
      const revert = revertOf(revertBytes(name));
      expect(revert.errorName).toBe(name);
      const fault = await failureOf(
        world({ estimate: failing(revert) }).chain.estimateCreate(LINK, SIGNATURE),
      );
      expect(fault).toBeInstanceOf(LegalBodyChainFaultError);
      expect(fault).not.toBeInstanceOf(ContractRevertError);
      expect((fault as LegalBodyChainFaultError).errorName).toBe(name);
      expect((fault as Error).cause).toBe(revert);
    },
  );

  test.each(LINK_REFUSALS)(
    "%s from the simulation stays the ContractRevertError, and is never a platform fault",
    async (name) => {
      const revert = revertOf(revertBytes(name));
      expect(revert.errorName).toBe(name);
      const refusal = await failureOf(
        world({ estimate: failing(revert) }).chain.estimateCreate(LINK, SIGNATURE),
      );
      expect(refusal).toBe(revert);
      expect(refusal).not.toBeInstanceOf(LegalBodyChainFaultError);
    },
  );

  test("a failure of the simulation that is not a revert, a timeout, comes back as the same object", async () => {
    const timeout = new TimeoutError({ body: { method: "eth_fillTransaction" }, url: NODE_URL });
    await expect(
      world({ estimate: failing(timeout) }).chain.estimateCreate(LINK, SIGNATURE),
    ).rejects.toBe(timeout);
  });

  test("no error name appears in both legalBodyFactoryAbi and noviControllerAbi", () => {
    const errorNames = (abi: Abi) => abi.flatMap((x) => (x.type === "error" ? [x.name] : []));
    const factory = new Set(errorNames(legalBodyFactoryAbi as Abi));
    const controller = errorNames(noviControllerAbi as Abi);
    expect(controller.length).toBeGreaterThan(0);
    expect(controller.filter((name) => factory.has(name))).toEqual([]);
  });

  test("with no executor, estimateCreate and submitCreate throw before estimating", async () => {
    const { chain, arc, record } = world({ executor: null });
    await expect(chain.estimateCreate(LINK, SIGNATURE)).rejects.toThrow("no executor");
    await expect(chain.submitCreate({ link: LINK, signature: SIGNATURE, record })).rejects.toThrow(
      "no executor",
    );
    expect(arc.estimateRelayedCall).not.toHaveBeenCalled();
  });
});

describe("submitCreate", () => {
  test("happy path: estimate, prepare, then sign, record and send, with the lock held for exactly those three", async () => {
    const { chain, arc, record, steps } = world();
    const result = await chain.submitCreate({ link: LINK, signature: SIGNATURE, record });

    expect(result).toEqual({ status: "sent", ...SIGNED });
    expect(steps).toEqual([
      ["estimate", false],
      ["prepare", false],
      ["sign", true],
      ["record", true],
      ["send", true],
    ]);
    expect(senderLockHeld(EXECUTOR)).toBe(false);

    // Prepared at the LIMIT, for the call that was simulated; then that preparation is signed,
    // the signed bytes recorded, and the same bytes sent.
    const simulated = arc.estimateRelayedCall.mock.calls[0]![0];
    expect(arc.prepareRelayedCall).toHaveBeenCalledWith(simulated, LIMIT);
    const prepared = await arc.prepareRelayedCall.mock.results[0]!.value;
    expect(arc.signRelayedCall).toHaveBeenCalledWith(prepared);
    expect(record).toHaveBeenCalledWith(SIGNED);
    expect(arc.sendRawRelayedCall).toHaveBeenCalledWith(SIGNED.rawTx);
  });

  test("record returns false: nothing is sent, and the result is not_recorded", async () => {
    const { chain, arc, steps } = world();
    const record = vi.fn(() => false);
    const result: SubmitCreateResult = await chain.submitCreate({
      link: LINK,
      signature: SIGNATURE,
      record,
    });

    expect(result).toEqual({ status: "not_recorded" });
    expect(record).toHaveBeenCalledTimes(1);
    expect(arc.sendRawRelayedCall).not.toHaveBeenCalled();
    expect(steps.map(([step]) => step)).toEqual(["estimate", "prepare", "sign"]);
  });

  test.each([
    { returned: "a promise", value: () => Promise.resolve(true), error: /promise/ },
    { returned: "undefined", value: () => undefined, error: /returned undefined/ },
    { returned: "a truthy value that is not true", value: () => 1, error: /returned 1/ },
  ])("record returns $returned: a throw, and nothing is sent", async ({ value, error }) => {
    const { chain, arc } = world();
    const record = vi.fn(() => value() as unknown as boolean);
    await expect(chain.submitCreate({ link: LINK, signature: SIGNATURE, record })).rejects.toThrow(
      error,
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(arc.sendRawRelayedCall).not.toHaveBeenCalled();
  });

  test("record returns a promise that rejects later: submitCreate throws its own sentence, nothing is sent, and the rejection is not left unhandled", async () => {
    const { chain, arc } = world();
    let rejectRecord: ((reason: unknown) => void) | undefined;
    const pending = new Promise<boolean>((_resolve, reject) => {
      rejectRecord = reject;
    });
    // A plain function, not a mock: a mock attaches its own handler to a promise it returns.
    let recordCalls = 0;
    const record = () => {
      recordCalls++;
      return pending as unknown as boolean;
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        chain.submitCreate({ link: LINK, signature: SIGNATURE, record }),
      ).rejects.toThrow(
        "createLegalBody: record returned a promise; it must record synchronously and return true or false. Nothing was sent",
      );
      rejectRecord?.(new Error("the record could not be written"));
      // Node reports an unhandled rejection once the microtasks have run: one macrotask is enough.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(recordCalls).toBe(1);
    expect(arc.sendRawRelayedCall).not.toHaveBeenCalled();
  });

  test("a prepared request with no fee field throws before the lock is taken", async () => {
    const { chain, arc, record, steps } = world({ fees: {} });
    await whileLockHeldElsewhere(async () => {
      await expect(
        chain.submitCreate({ link: LINK, signature: SIGNATURE, record }),
      ).rejects.toThrow(/no fee/);
    });
    expect(steps).toEqual([
      ["estimate", false],
      ["prepare", false],
    ]);
    expect(arc.signRelayedCall).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(arc.sendRawRelayedCall).not.toHaveBeenCalled();
  });

  test("record throws: the throw propagates, and nothing is sent", async () => {
    const { chain, arc } = world();
    const failure = new Error("the record could not be written");
    const record = vi.fn((): boolean => {
      throw failure;
    });
    await expect(chain.submitCreate({ link: LINK, signature: SIGNATURE, record })).rejects.toBe(
      failure,
    );
    expect(arc.sendRawRelayedCall).not.toHaveBeenCalled();
  });

  test("the send fails after the record: the result is unconfirmed, with the hash, the bytes and the cause", async () => {
    const cause = new TimeoutError({ body: { method: "eth_sendRawTransaction" }, url: NODE_URL });
    const { chain, record, steps } = world({ send: failing(cause) });
    const result = await chain.submitCreate({ link: LINK, signature: SIGNATURE, record });

    expect(result).toEqual({ status: "unconfirmed", ...SIGNED, cause });
    expect(result.status === "unconfirmed" && result.cause).toBe(cause);
    expect(steps.map(([step]) => step)).toEqual(["estimate", "prepare", "sign", "record", "send"]);
  });

  test("a fee above the cap throws LegalBodyFeeTooHighError before the lock is taken; nothing is signed", async () => {
    // An estimate of 400,000 gives a limit of 500,000, and 500 gwei per gas at that limit is
    // exactly the cap. One wei more per gas is above it at the limit, though not at the estimate.
    const AT_CAP = 500_000_000_000n;
    expect(500_000n * AT_CAP).toBe(CREATE_MAX_FEE_WEI);
    const estimate = async () => 400_000n;

    const atCap = world({ estimate, fees: { maxFeePerGas: AT_CAP } });
    await expect(
      atCap.chain.submitCreate({ link: LINK, signature: SIGNATURE, record: atCap.record }),
    ).resolves.toMatchObject({ status: "sent" });

    for (const fees of [{ maxFeePerGas: AT_CAP + 1n }, { gasPrice: AT_CAP + 1n }]) {
      const over = world({ estimate, fees });
      const err = await whileLockHeldElsewhere(() =>
        failureOf(
          over.chain.submitCreate({ link: LINK, signature: SIGNATURE, record: over.record }),
        ),
      );
      expect(err).toBeInstanceOf(LegalBodyFeeTooHighError);
      expect((err as LegalBodyFeeTooHighError).fee).toBe(500_000n * (AT_CAP + 1n));
      expect(over.arc.signRelayedCall).not.toHaveBeenCalled();
      expect(over.record).not.toHaveBeenCalled();
      expect(over.arc.sendRawRelayedCall).not.toHaveBeenCalled();
    }
  });

  test("a request with both fee fields is priced on maxFeePerGas, not on gasPrice", async () => {
    // As above: a limit of 500,000, at which 500 gwei per gas is exactly the cap.
    const AT_CAP = 500_000_000_000n;
    const estimate = async () => 400_000n;

    // At the cap by maxFeePerGas, above it by gasPrice: signed and sent.
    const atCap = world({ estimate, fees: { maxFeePerGas: AT_CAP, gasPrice: AT_CAP + 1n } });
    await expect(
      atCap.chain.submitCreate({ link: LINK, signature: SIGNATURE, record: atCap.record }),
    ).resolves.toMatchObject({ status: "sent" });

    // Above the cap by maxFeePerGas, at it by gasPrice: refused, priced on maxFeePerGas.
    const over = world({ estimate, fees: { maxFeePerGas: AT_CAP + 1n, gasPrice: AT_CAP } });
    const err = await failureOf(
      over.chain.submitCreate({ link: LINK, signature: SIGNATURE, record: over.record }),
    );
    expect(err).toBeInstanceOf(LegalBodyFeeTooHighError);
    expect((err as LegalBodyFeeTooHighError).fee).toBe(500_000n * (AT_CAP + 1n));
    expect(over.arc.signRelayedCall).not.toHaveBeenCalled();
    expect(over.record).not.toHaveBeenCalled();
    expect(over.arc.sendRawRelayedCall).not.toHaveBeenCalled();
  });

  test("a refusal from estimateCreate (a ContractRevertError) propagates from submitCreate; nothing is prepared", async () => {
    const refusal = revertOf(BAD_SIGNATURE);
    const { chain, arc, record } = world({ estimate: failing(refusal) });
    await expect(chain.submitCreate({ link: LINK, signature: SIGNATURE, record })).rejects.toBe(
      refusal,
    );
    expect(arc.prepareRelayedCall).not.toHaveBeenCalled();
    expect(arc.signRelayedCall).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(arc.sendRawRelayedCall).not.toHaveBeenCalled();
  });
});

describe("rebroadcastCreate", () => {
  /**
   * A node's refusal of a raw send, as viem raises it. The code and viem's class carry no meaning
   * here: a real refusal arrives in exactly the same class, and only the node's words differ.
   */
  const nodeSays = (message: string) =>
    new InvalidInputRpcError(
      new RpcRequestError({
        body: { method: "eth_sendRawTransaction" },
        error: { code: -32000, message },
        url: NODE_URL,
      }),
    );

  test("rebroadcastCreate sends the bytes with the executor's lock held", async () => {
    const { chain, arc, steps } = world();
    await expect(chain.rebroadcastCreate(SIGNED.rawTx)).resolves.toBeUndefined();
    expect(arc.sendRawRelayedCall).toHaveBeenCalledWith(SIGNED.rawTx);
    expect(steps).toEqual([["send", true]]);
    expect(senderLockHeld(EXECUTOR)).toBe(false);
  });

  test.each([
    { answer: "already known", error: nodeSays("already known") },
    { answer: "already imported", error: nodeSays("transaction already imported") },
    { answer: "nonce too low", error: nodeSays("nonce too low: next nonce 8, tx nonce 7") },
    {
      answer: "already known, further down the cause chain",
      error: new Error("the send failed", { cause: nodeSays("already known") }),
    },
  ])("rebroadcastCreate swallows $answer", async ({ error }) => {
    const { chain, steps } = world({ send: failing(error) });
    await expect(chain.rebroadcastCreate(SIGNED.rawTx)).resolves.toBeUndefined();
    expect(steps).toEqual([["send", true]]);
  });

  test("rebroadcastCreate throws a timeout, and a refusal in other words", async () => {
    const timeout = new TimeoutError({ body: { method: "eth_sendRawTransaction" }, url: NODE_URL });
    const refusal = nodeSays("insufficient funds for gas * price + value");
    for (const error of [timeout, refusal]) {
      const { chain, steps } = world({ send: failing(error) });
      await expect(chain.rebroadcastCreate(SIGNED.rawTx)).rejects.toBe(error);
      expect(steps).toEqual([["send", true]]);
    }
  });

  test("with no executor, rebroadcastCreate throws before taking any lock, and sends nothing", async () => {
    const { chain, arc } = world({ executor: null });
    // A section with no named sender would take the shared lock for one: hold it, so a call that
    // waited for it would fail here instead of settling.
    const err = await whileLockHeldElsewhere(
      () => failureOf(chain.rebroadcastCreate(SIGNED.rawTx)),
      {
        sender: undefined,
      },
    );
    expect((err as Error).message).toMatch(/no executor/);
    expect(arc.sendRawRelayedCall).not.toHaveBeenCalled();
  });
});

/** The body the create is meant to make, and the identity owner whose signature makes it. */
const BODY = "0x00000000000000000000000000000000000b0d11" as Address;
const OWNER = "0x0000000000000000000000000000000000000B0b" as Address;
/** A contract that is not the factory, and emits an event with the same signature. */
const LOOKALIKE = "0x000000000000000000000000000000000000bad1" as Address;
const DIGEST = `0x${"d1".repeat(32)}` as Hex;
/** The block the create is mined in, and the node's head when a search is not given an end. */
const CREATED_IN = 12_345n;
const HEAD = 40_000n;

/** Each block's time in seconds: half a second apart, as on Arc. */
const timeOf = (blockNumber: bigint) => 1_900_000_000n + blockNumber / 2n;

/** The `LegalBodyCreated` event, as the factory's ABI declares it. */
const LEGAL_BODY_CREATED = getAbiItem({ abi: legalBodyFactoryAbi, name: "LegalBodyCreated" });

/** A `LegalBodyCreated` log as a node returns it: by default the factory's, for BODY, in CREATED_IN. */
function createdLog(
  p: {
    emitter?: Address;
    body?: Address;
    owner?: Address;
    blockNumber?: bigint;
    removed?: boolean;
  } = {},
): Log<bigint, number, false> {
  return {
    address: p.emitter ?? FACTORY,
    topics: encodeEventTopics({
      abi: legalBodyFactoryAbi,
      eventName: "LegalBodyCreated",
      args: { agentId: LINK.agentId, legalBody: p.body ?? BODY, identityOwner: p.owner ?? OWNER },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [GUARDIAN, DIGEST]),
    blockNumber: p.blockNumber ?? CREATED_IN,
    blockHash: `0x${"b1".repeat(32)}`,
    transactionHash: SIGNED.txHash,
    transactionIndex: 0,
    logIndex: 0,
    removed: p.removed ?? false,
  };
}

/** What the chain says the factory created for the default log mined in `blockNumber`. */
function creation(blockNumber = CREATED_IN): LegalBodyCreated {
  return {
    legalBody: BODY,
    agentId: LINK.agentId,
    identityOwner: OWNER,
    guardian: GUARDIAN,
    linkDigest: DIGEST,
    txHash: SIGNED.txHash,
    blockNumber: Number(blockNumber),
    deployedAt: Number(timeOf(blockNumber)),
  };
}

/** The create's receipt, mined in CREATED_IN. */
function receipt(status: "success" | "reverted", logs: Log<bigint, number, false>[] = []) {
  return { status, logs, blockNumber: CREATED_IN, transactionHash: SIGNED.txHash };
}

/** A node's refusal of a `getLogs` range, in Arc's words, as viem raises it. */
const rangeTooLarge = () =>
  new RpcRequestError({
    body: { method: "eth_getLogs" },
    error: { code: -32012, message: "requested range too large" },
    url: NODE_URL,
  });

interface NodeOptions {
  /** The answer to `getTransactionReceipt`. */
  receipt?: () => Promise<unknown>;
  /** The answer to `waitForTransactionReceipt`. */
  wait?: () => Promise<unknown>;
  /** Every log on this chain; `getLogs` answers with those that match, as a node does. */
  logs?: Log<bigint, number, false>[];
  /** The widest range, in blocks, the node answers `getLogs` for. A wider one is refused. */
  maxLogRange?: bigint;
  /** A `getLogs` answer that is a failure, whatever the range. */
  logsFail?: unknown;
  /** The answer to `getBlock` for a numbered block (default: the block, at its time). */
  block?: (blockNumber: bigint) => Promise<{ number: bigint; timestamp: bigint }>;
}

/** A node to read the create's fate from, and a LegalBodyChain that reads from it. */
function onChain(opts: NodeOptions = {}) {
  const unexpected = (method: string) => async (): Promise<never> => {
    throw new Error(`unexpected ${method}`);
  };
  /** Every range `getLogs` was asked for, in order, refused or not. */
  const ranges: [bigint, bigint][] = [];
  const getLogs = vi.fn(
    async (q: {
      address: Address;
      event: AbiEvent;
      args: { legalBody: Address };
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      ranges.push([q.fromBlock, q.toBlock]);
      if (opts.logsFail !== undefined) throw opts.logsFail;
      if (opts.maxLogRange !== undefined && q.toBlock - q.fromBlock + 1n > opts.maxLogRange)
        throw rangeTooLarge();
      const [signature, , body] = encodeEventTopics({
        abi: [q.event],
        args: { legalBody: q.args.legalBody },
      });
      return (opts.logs ?? []).filter(
        (l) =>
          isAddressEqual(l.address, q.address) &&
          l.blockNumber >= q.fromBlock &&
          l.blockNumber <= q.toBlock &&
          l.topics[0] === signature &&
          l.topics[2] === body,
      );
    },
  );
  const getBlock = vi.fn(async (q: { blockNumber?: bigint; blockTag?: string }) => {
    if (q.blockNumber === undefined) return { number: HEAD, timestamp: timeOf(HEAD) };
    return (opts.block ?? (async (n: bigint) => ({ number: n, timestamp: timeOf(n) })))(
      q.blockNumber,
    );
  });
  const getTransactionReceipt = vi.fn(opts.receipt ?? unexpected("getTransactionReceipt"));
  const waitForTransactionReceipt = vi.fn(opts.wait ?? unexpected("waitForTransactionReceipt"));
  const publicClient = {
    getLogs,
    getBlock,
    getTransactionReceipt,
    waitForTransactionReceipt,
  } as unknown as PublicClient;
  const { chain } = world({ publicClient });
  return { chain, getLogs, getBlock, getTransactionReceipt, waitForTransactionReceipt, ranges };
}

const EXPECTED = { bodyAddress: BODY };

/** A failure that says nothing about the transaction: the node or the network had trouble. */
const rateLimited = () =>
  new HttpRequestError({ status: 429, url: NODE_URL, details: "Too Many Requests" });
const timedOut = () => new TimeoutError({ body: { method: "eth_call" }, url: NODE_URL });

describe("createOutcome", () => {
  test("createOutcome asks once and never waits: absent only for TransactionReceiptNotFoundError; a 429 throws", async () => {
    const notFound = onChain({
      receipt: failing(new TransactionReceiptNotFoundError({ hash: SIGNED.txHash })),
    });
    await expect(notFound.chain.createOutcome(SIGNED.txHash, EXPECTED)).resolves.toEqual({
      status: "absent",
    });
    expect(notFound.getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(notFound.getTransactionReceipt).toHaveBeenCalledWith({ hash: SIGNED.txHash });
    expect(notFound.waitForTransactionReceipt).not.toHaveBeenCalled();

    // Matched by type: the same words in another error are not the node saying "no receipt".
    const sameWords = new Error(
      `Transaction receipt with hash "${SIGNED.txHash}" could not be found.`,
    );
    for (const failure of [rateLimited(), timedOut(), sameWords]) {
      const { chain, getTransactionReceipt } = onChain({ receipt: failing(failure) });
      await expect(chain.createOutcome(SIGNED.txHash, EXPECTED)).rejects.toBe(failure);
      expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
    }
  });

  test("createOutcome: a reverted receipt is reverted; the factory's LegalBodyCreated for the body is created", async () => {
    await expect(
      onChain({ receipt: async () => receipt("reverted") }).chain.createOutcome(
        SIGNED.txHash,
        EXPECTED,
      ),
    ).resolves.toEqual({ status: "reverted" });

    const created = onChain({ receipt: async () => receipt("success", [createdLog()]) });
    await expect(created.chain.createOutcome(SIGNED.txHash, EXPECTED)).resolves.toEqual({
      status: "created",
      created: creation(),
    });
    expect(created.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  test("createOutcome: a receipt status that is neither success nor reverted counts as reverted", async () => {
    for (const status of [undefined, "pending"]) {
      const { chain, getBlock } = onChain({
        receipt: async () => ({ ...receipt("success", [createdLog()]), status }),
      });
      await expect(chain.createOutcome(SIGNED.txHash, EXPECTED), String(status)).resolves.toEqual({
        status: "reverted",
      });
      expect(getBlock, String(status)).not.toHaveBeenCalled();
    }
  });

  test("createOutcome: a successful receipt whose only LegalBodyCreated comes from another address throws", async () => {
    for (const logs of [
      [createdLog({ emitter: LOOKALIKE })],
      // The factory's event, but for another body: not the creation of the one expected.
      [createdLog({ body: LOOKALIKE })],
    ]) {
      const { chain } = onChain({ receipt: async () => receipt("success", logs) });
      await expect(chain.createOutcome(SIGNED.txHash, EXPECTED)).rejects.toThrow(
        /no LegalBodyCreated/,
      );
    }
  });
});

describe("confirmCreate", () => {
  test("confirmCreate ignores a look-alike event from another contract, and makes exactly one receipt call", async () => {
    // The look-alike comes first and names the same body, with another owner.
    const lookalike = createdLog({ emitter: LOOKALIKE, owner: LOOKALIKE });
    const { chain, waitForTransactionReceipt, getTransactionReceipt } = onChain({
      wait: async () => receipt("success", [lookalike, createdLog()]),
    });
    await expect(chain.confirmCreate(SIGNED.txHash, EXPECTED)).resolves.toEqual(creation());
    expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({
      hash: SIGNED.txHash,
      timeout: RECEIPT_TIMEOUT_MS,
    });
    expect(getTransactionReceipt).not.toHaveBeenCalled();

    const alone = onChain({ wait: async () => receipt("success", [lookalike]) });
    await expect(alone.chain.confirmCreate(SIGNED.txHash, EXPECTED)).rejects.toThrow(
      /no LegalBodyCreated/,
    );
    expect(alone.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(alone.getTransactionReceipt).not.toHaveBeenCalled();
  });

  test("confirmCreate: a timeout becomes ChainTxUnconfirmedError; a reverted receipt becomes ChainTxRevertedError", async () => {
    const timeout = await failureOf(
      onChain({
        wait: failing(new WaitForTransactionReceiptTimeoutError({ hash: SIGNED.txHash })),
      }).chain.confirmCreate(SIGNED.txHash, EXPECTED),
    );
    expect(timeout).toBeInstanceOf(ChainTxUnconfirmedError);
    expect(timeout).toMatchObject({ step: "createLegalBody", txHash: SIGNED.txHash });

    const reverted = await failureOf(
      onChain({ wait: async () => receipt("reverted") }).chain.confirmCreate(
        SIGNED.txHash,
        EXPECTED,
      ),
    );
    expect(reverted).toBeInstanceOf(ChainTxRevertedError);
    expect(reverted).toMatchObject({ step: "createLegalBody", txHash: SIGNED.txHash });

    // Any other failure is no verdict on the transaction, and goes back untouched.
    const other = rateLimited();
    await expect(
      onChain({ wait: failing(other) }).chain.confirmCreate(SIGNED.txHash, EXPECTED),
    ).rejects.toBe(other);
  });

  test("confirmCreate: a receipt for another transaction, successful with the body's event or reverted, becomes ChainTxUnconfirmedError", async () => {
    // viem's wait follows a replacement at the same sender and nonce, and resolves with the
    // replacement's receipt: that receipt says nothing about the create that was asked about.
    const ANOTHER_TX = `0x${"7b".repeat(32)}` as Hex;
    for (const another of [
      { ...receipt("success", [createdLog()]), transactionHash: ANOTHER_TX },
      { ...receipt("reverted"), transactionHash: ANOTHER_TX },
    ]) {
      const { chain, getBlock } = onChain({ wait: async () => another });
      const err = await failureOf(chain.confirmCreate(SIGNED.txHash, EXPECTED));
      expect(err, another.status).toBeInstanceOf(ChainTxUnconfirmedError);
      expect(err, another.status).toMatchObject({
        step: "createLegalBody",
        txHash: SIGNED.txHash,
      });
      expect(getBlock, another.status).not.toHaveBeenCalled();
    }
  });
});

describe("findCreation", () => {
  const FROM = 1_000n;

  test("findCreation: found in the first window, by the factory's address, the event and the body's topic", async () => {
    const { chain, getLogs, ranges } = onChain({ logs: [createdLog({ blockNumber: 3_000n })] });
    await expect(
      chain.findCreation({ bodyAddress: BODY, fromBlock: FROM, toBlock: 30_000n }),
    ).resolves.toEqual(creation(3_000n));
    expect(CREATION_LOG_WINDOW_BLOCKS).toBe(5_000n);
    expect(ranges).toEqual([[FROM, 5_999n]]);
    expect(getLogs).toHaveBeenCalledWith({
      address: FACTORY,
      event: LEGAL_BODY_CREATED,
      args: { legalBody: BODY },
      fromBlock: FROM,
      toBlock: 5_999n,
    });
  });

  test("findCreation: found in the third window, one window at a time", async () => {
    const { chain, ranges } = onChain({ logs: [createdLog({ blockNumber: 11_042n })] });
    await expect(
      chain.findCreation({ bodyAddress: BODY, fromBlock: FROM, toBlock: 30_000n }),
    ).resolves.toEqual(creation(11_042n));
    expect(ranges).toEqual([
      [FROM, 5_999n],
      [6_000n, 10_999n],
      [11_000n, 15_999n],
    ]);
  });

  test("findCreation: a range too large answer halves the window, and the search still completes", async () => {
    const TO = FROM + 4_999n;
    const { chain, ranges } = onChain({
      logs: [createdLog({ blockNumber: TO - 10n })],
      maxLogRange: 1_500n,
    });
    await expect(
      chain.findCreation({ bodyAddress: BODY, fromBlock: FROM, toBlock: TO }),
    ).resolves.toEqual(creation(TO - 10n));
    expect(ranges).toEqual([
      [FROM, FROM + 4_999n], // 5,000: refused
      [FROM, FROM + 2_499n], // 2,500: refused
      [FROM, FROM + 1_249n], // 1,250: answered, and kept for the rest of the search
      [FROM + 1_250n, FROM + 2_499n],
      [FROM + 2_500n, FROM + 3_749n],
      [FROM + 3_750n, TO],
    ]);
  });

  test("findCreation: a range refusal at the 500-block floor throws", async () => {
    const refused = rangeTooLarge();
    const { chain, ranges } = onChain({ logsFail: refused });
    const err = await failureOf(
      chain.findCreation({ bodyAddress: BODY, fromBlock: FROM, toBlock: 30_000n }),
    );
    expect((err as Error).cause).toBe(refused);
    // Halved down to the floor and no further: 5,000, 2,500, 1,250, 625, then 500.
    expect(ranges.map(([from, to]) => to - from + 1n)).toEqual([
      5_000n,
      2_500n,
      1_250n,
      625n,
      500n,
    ]);
    expect(ranges.every(([from]) => from === FROM)).toBe(true);
  });

  test("findCreation: fromBlock above toBlock returns undefined, and asks nothing", async () => {
    const { chain, getLogs, getBlock } = onChain({ logs: [createdLog()] });
    await expect(
      chain.findCreation({ bodyAddress: BODY, fromBlock: 101n, toBlock: 100n }),
    ).resolves.toBeUndefined();
    expect(getLogs).not.toHaveBeenCalled();
    expect(getBlock).not.toHaveBeenCalled();
  });

  test("findCreation: nothing found returns undefined, after searching up to the head", async () => {
    // Logs that are not the body's creation: another body's, and a look-alike's for this body.
    const { chain, getBlock, ranges } = onChain({
      logs: [
        createdLog({ body: LOOKALIKE, blockNumber: 2_000n }),
        createdLog({ emitter: LOOKALIKE, blockNumber: 2_000n }),
      ],
    });
    await expect(
      chain.findCreation({ bodyAddress: BODY, fromBlock: 30_000n }),
    ).resolves.toBeUndefined();
    expect(getBlock).toHaveBeenCalledWith({ blockTag: "latest" });
    expect(ranges).toEqual([
      [30_000n, 34_999n],
      [35_000n, 39_999n],
      [HEAD, HEAD],
    ]);
  });

  test("findCreation: a log with removed: true is ignored", async () => {
    const { chain, ranges } = onChain({
      logs: [
        createdLog({ blockNumber: 2_000n, removed: true }),
        createdLog({ blockNumber: 7_000n }),
      ],
    });
    await expect(
      chain.findCreation({ bodyAddress: BODY, fromBlock: FROM, toBlock: 30_000n }),
    ).resolves.toEqual(creation(7_000n));
    expect(ranges).toEqual([
      [FROM, 5_999n],
      [6_000n, 10_999n],
    ]);
  });

  test("findCreation: an RPC failure throws, and is not retried as a range refusal", async () => {
    for (const failure of [rateLimited(), timedOut()]) {
      const { chain, ranges } = onChain({ logsFail: failure });
      await expect(
        chain.findCreation({ bodyAddress: BODY, fromBlock: FROM, toBlock: 30_000n }),
      ).rejects.toBe(failure);
      expect(ranges).toEqual([[FROM, 5_999n]]);
    }
  });
});

describe("deployedAt", () => {
  test("deployedAt is the creating block's time, read by number; a failed read throws, in all three", async () => {
    const at = onChain({
      receipt: async () => receipt("success", [createdLog()]),
      logs: [createdLog()],
    });
    await at.chain.createOutcome(SIGNED.txHash, EXPECTED);
    await at.chain.findCreation({ bodyAddress: BODY, fromBlock: CREATED_IN, toBlock: CREATED_IN });
    expect(at.getBlock.mock.calls).toEqual([
      [{ blockNumber: CREATED_IN }],
      [{ blockNumber: CREATED_IN }],
    ]);

    const failure = timedOut();
    const broken = onChain({
      receipt: async () => receipt("success", [createdLog()]),
      wait: async () => receipt("success", [createdLog()]),
      logs: [createdLog()],
      block: failing(failure),
    });
    await expect(broken.chain.createOutcome(SIGNED.txHash, EXPECTED)).rejects.toBe(failure);
    await expect(broken.chain.confirmCreate(SIGNED.txHash, EXPECTED)).rejects.toBe(failure);
    await expect(
      broken.chain.findCreation({ bodyAddress: BODY, fromBlock: CREATED_IN, toBlock: CREATED_IN }),
    ).rejects.toBe(failure);
  });
});
