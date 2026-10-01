/**
 * LegalBodyChain's CREATE, the sending half: simulate the relayed create, bound its gas and its
 * fee, prepare it, then sign, record and send it inside the executor's sender lock.
 *
 * The relay seam is a plain object of mocks; the real ArcAdapter's half of this sequence has tests
 * of its own. The sender lock is the REAL one, and every fake notes whether it ran with the
 * executor's lock held, so the lock window is measured here, not assumed.
 */
import {
  type Abi,
  type Address,
  type Hex,
  InvalidInputRpcError,
  type PublicClient,
  RawContractError,
  RpcRequestError,
  TimeoutError,
  encodeErrorResult,
} from "viem";
import { describe, expect, test, vi } from "vitest";
import { legalBodyFactoryAbi, noviControllerAbi } from "../../../src/abis/generated";
import type { PreparedRelayedCall, RelayedCall } from "../../../src/adapters/arc/arcAdapter";
import {
  CREATE_GAS_CEILING,
  CREATE_MAX_FEE_WEI,
  LegalBodyChain,
  LegalBodyChainFaultError,
  LegalBodyFeeTooHighError,
  LegalBodyGasTooHighError,
  type RelaySeam,
  type SubmitCreateResult,
} from "../../../src/adapters/arc/legalBodyChain";
import { ContractRevertError, relayRevertError } from "../../../src/adapters/arc/relay";
import { senderLockHeld, withSenderLock } from "../../../src/adapters/arc/senderLock";
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
    publicClient: {} as PublicClient,
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
 * Run `fn` while another section holds the executor's sender lock. A call that waits for the lock
 * cannot settle in here, so a call that does settle settled without taking it. One that waits
 * fails after a second instead, and the lock is released either way, so no later test inherits it.
 */
async function whileLockHeldElsewhere<T>(fn: () => Promise<T>): Promise<T> {
  let release: (() => void) | undefined;
  const holder = withSenderLock(
    EXECUTOR,
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
});
