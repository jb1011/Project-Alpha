/**
 * ArcAdapter relay routing (NoviController design §5).
 *
 * Routing is PER AGENT, not per deployment. `AgentTreasury.manager` is immutable and the identity
 * NFT has one owner, so an agent minted before the controller cutover is managed by the OLD EOA
 * forever. A global "controller mode" switch would relay those agents' calls into a `NotManager`
 * revert — which is why every relayed method takes the agent's PERSISTED manager and relays only
 * when it IS the controller.
 *
 * Five call sites can relay — createEntity, setAgentWallet, setMetadata (the ENS reverse-bind
 * inside EVERY onboarding), schedulePolicyUpdate, executePolicyUpdate — and nothing else:
 * fundTreasury is a plain USDC transfer from the signing key and must stay direct.
 *
 * No Anvil — all chain I/O is mocked.
 */
import {
  type Address,
  BaseError,
  type Hex,
  type PublicClient,
  RawContractError,
  type WalletClient,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  parseTransaction,
  serializeTransaction,
  size,
  slice,
} from "viem";
import { beforeEach, expect, test, vi } from "vitest";
import {
  agentTreasuryAbi,
  iIdentityRegistryAbi,
  legalManagerAbi,
  legalManagerFactoryAbi,
  noviControllerAbi,
} from "../../../src/abis/generated";
import { ArcAdapter, MANAGER_RECEIPT_TIMEOUT_MS } from "../../../src/adapters/arc/arcAdapter";
import { resetSenderNonces } from "../../../src/adapters/arc/senderLock";

// The nonce floors are process-wide, so each test starts from a fresh ledger (see senderLock.ts).
beforeEach(() => resetSenderNonces());

const CONTROLLER = "0x4819000000000000000000000000000000000000" as Address;
/** The manager of the agents that already exist on prod: the platform EOA, not the controller. */
const LEGACY_MANAGER = "0x000000000000000000000000000000000001e6ac" as Address;
const FACTORY = "0x0000000000000000000000000000000000000001" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000002" as Address;
const TREASURY = "0x000000000000000000000000000000000000000F" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const PAYOUT = "0x000000000000000000000000000000000000000A" as Address;
const EXECUTOR = "0x000000000000000000000000000000000000000B" as Address;
const POLICY_ID = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
/** The entity's LegalManager proxy — the target of the two OA amendment calls. */
const PROXY = "0x00000000000000000000000000000000000000fa" as Address;
const OA_HASH = "0xabcdef00000000000000000000000000000000000000000000000000000000ff" as Hex;
const FAKE_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000003" as Hex;
const GAS = 123_456n;
/** What the fake `prepareTransactionRequest` estimates when the caller passes no explicit gas. */
const PREPARED_GAS = 90_000n;

function makeAdapter(opts: { controller?: Address; noAccount?: boolean } = {}) {
  const simulateContract = vi.fn().mockResolvedValue({ request: { marker: "sim-request" } });
  const call = vi.fn().mockResolvedValue({ data: "0x" });
  const estimateGas = vi.fn().mockResolvedValue(GAS);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({});
  // Every platform send is now prepare (outside the lock) -> sign offline -> raw broadcast, so
  // what used to be asserted on the `writeContract`/`sendTransaction` argument is asserted on the
  // BYTES: this fake serialises for real (no key — an unsigned EIP-1559 payload round-trips
  // through `parseTransaction` just as well), so the tests read to/data/gas/value/nonce back out
  // of the wire format, which is where they now live.
  const prepareTransactionRequest = vi.fn(async (r: Record<string, unknown>) => ({
    ...r,
    // What viem's own prepare fills in and the serialiser needs.
    chainId: 5042002,
    type: "eip1559",
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    gas: r.gas ?? PREPARED_GAS,
  }));
  const signRequests: Record<string, unknown>[] = [];
  const signTransaction = vi.fn(async (tx: Record<string, unknown>) => {
    signRequests.push(tx);
    return serializeTransaction(tx as never);
  });
  const raw: Hex[] = [];
  const sendRawTransaction = vi.fn(
    async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
      raw.push(serializedTransaction);
      return FAKE_HASH;
    },
  );
  const publicClient = {
    simulateContract,
    call,
    estimateGas,
    waitForTransactionReceipt,
    // Every platform send picks its nonce from this read (see senderLock.ts).
    getTransactionCount: vi.fn().mockResolvedValue(0),
    sendRawTransaction,
  } as unknown as PublicClient;
  const managerWallet = {
    account: opts.noAccount ? undefined : { address: EXECUTOR, signTransaction },
    chain: { id: 5042002 },
    prepareTransactionRequest,
  } as unknown as WalletClient;
  const adapter = new ArcAdapter({
    publicClient,
    managerWallet,
    chainId: 5042002,
    factory: FACTORY,
    identityRegistry: REGISTRY,
    controller: opts.controller,
  });
  /** What the platform actually put on the wire, decoded. */
  const signed = () => raw.map((r) => parseTransaction(r));
  return {
    adapter,
    simulateContract,
    call,
    estimateGas,
    managerWallet,
    prepareTransactionRequest,
    signTransaction,
    signRequests,
    sendRawTransaction,
    waitForTransactionReceipt,
    signed,
    /** …split by route: a relayed call goes to the controller, a direct one to its target. */
    relayed: () => signed().filter((tx) => tx.to === CONTROLLER),
    direct: () => signed().filter((tx) => tx.to !== CONTROLLER),
  };
}

const createParams = {
  manager: CONTROLLER, // in controller mode the doors force the manager to the controller
  guardian: "0x000000000000000000000000000000000000bbbb" as Address,
  operator: "0x000000000000000000000000000000000000cccc" as Address,
  amendmentDelay: 3_600n,
  metadataURI: "https://api.example/metadata/abc",
  ein: "STUB-NOT-FILED",
  formationDate: 0,
  operatingAgreementHash: `0x${"ab".repeat(32)}` as Hex,
  treasury: {
    usdc: USDC,
    payoutAddress: PAYOUT,
    cap: 1_000_000n,
    period: 2_592_000n,
    allowlistEnabled: false,
  },
};

const createCalldata = (manager: Address) =>
  encodeFunctionData({
    abi: legalManagerFactoryAbi,
    functionName: "createEntity",
    args: [
      manager,
      createParams.guardian,
      createParams.operator,
      createParams.amendmentDelay,
      createParams.metadataURI,
      createParams.ein,
      BigInt(createParams.formationDate),
      createParams.operatingAgreementHash,
      {
        usdc: USDC,
        payoutAddress: PAYOUT,
        cap: 1_000_000n,
        period: 2_592_000n,
        allowlistEnabled: false,
      },
    ],
  });

/** The relay contract: to == controller, data == <direct calldata> ++ <20-byte target>. */
function assertRelayed(tx: unknown, expected: { data: Hex; target: Address }) {
  const sent = tx as { to?: Address; data?: Hex; gas?: bigint; account?: { address?: Address } };
  expect(sent.to?.toLowerCase()).toBe(CONTROLLER.toLowerCase());
  const data = sent.data as Hex;
  expect(size(data)).toBe(size(expected.data) + 20);
  expect(slice(data, 0, size(expected.data))).toBe(expected.data); // prefix == the direct calldata
  expect(slice(data, size(data) - 20)).toBe(expected.target.toLowerCase()); // 20-byte suffix
  expect(typeof (sent as { nonce?: number }).nonce).toBe("number"); // numbered by the ledger
  expect(sent.gas).toBe(GAS); // the preflight's estimate rides along as the limit
}

// ── the relayed shape, per call site ─────────────────────────────────────

test("createEntity relays to the controller with the FACTORY appended", async () => {
  const { adapter, estimateGas, relayed, simulateContract, managerWallet } = makeAdapter({
    controller: CONTROLLER,
  });
  const hash = await adapter.broadcastCreateEntity(createParams);
  expect(hash).toBe(FAKE_HASH);

  assertRelayed(relayed()[0], {
    data: createCalldata(CONTROLLER),
    target: FACTORY,
  });
  // ONE preflight, on the SAME bytes: estimateGas both proves the call and produces the gas limit
  // (an eth_call preflight left viem to execute the transaction a second time to estimate).
  expect(estimateGas).toHaveBeenCalledTimes(1);
  expect(estimateGas.mock.calls[0]![0].to).toBe(CONTROLLER);
  expect(estimateGas.mock.calls[0]![0].data).toBe(relayed()[0]!.data);
  // The executor account itself, not a copy of its address: the same object the wallet carries.
  expect(estimateGas.mock.calls[0]![0].account).toBe(managerWallet.account);
  expect(simulateContract).not.toHaveBeenCalled(); // the direct-mode path must not also run
});

test("setAgentWallet relays with the REGISTRY appended (the bind the controller owns the NFT for)", async () => {
  const { adapter, relayed } = makeAdapter({ controller: CONTROLLER });
  const args = {
    agentId: 876734n,
    newWallet: "0x00000000000000000000000000000000000005ca" as Address,
    deadline: 1_800_000_000n,
    signature: `0x${"cd".repeat(65)}` as Hex,
    agentManager: CONTROLLER,
  };
  await adapter.setAgentWallet(args);
  const expected = encodeFunctionData({
    abi: iIdentityRegistryAbi,
    functionName: "setAgentWallet",
    args: [args.agentId, args.newWallet, args.deadline, args.signature],
  });
  assertRelayed(relayed()[0], { data: expected, target: REGISTRY });
});

test("setAgentMetadata relays with the REGISTRY appended (the ENS reverse-bind in EVERY onboarding)", async () => {
  const { adapter, relayed } = makeAdapter({ controller: CONTROLLER });
  await adapter.setAgentMetadata(876734n, "ens", "0x616263", CONTROLLER);
  const expected = encodeFunctionData({
    abi: iIdentityRegistryAbi,
    functionName: "setMetadata",
    args: [876734n, "ens", "0x616263"],
  });
  assertRelayed(relayed()[0], { data: expected, target: REGISTRY });
});

test("schedulePolicyUpdate relays with the per-agent TREASURY appended", async () => {
  const { adapter, relayed } = makeAdapter({ controller: CONTROLLER });
  await adapter.schedulePolicyUpdate(
    TREASURY,
    { newCap: 200_000_000n, newPeriod: 86_400n, allowlistOn: false, newPayout: PAYOUT },
    CONTROLLER,
  );
  const expected = encodeFunctionData({
    abi: agentTreasuryAbi,
    functionName: "schedulePolicyUpdate",
    args: [200_000_000n, 86_400n, false, PAYOUT],
  });
  assertRelayed(relayed()[0], { data: expected, target: TREASURY });
});

test("executePolicyUpdate relays with the per-agent TREASURY appended", async () => {
  const { adapter, relayed } = makeAdapter({ controller: CONTROLLER });
  await adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER);
  const expected = encodeFunctionData({
    abi: agentTreasuryAbi,
    functionName: "executePolicyUpdate",
    args: [POLICY_ID],
  });
  assertRelayed(relayed()[0], { data: expected, target: TREASURY });
});

// ── the OA amendment pair (design §7): relayed like the treasury pair, BROADCAST-ONLY ──

test("scheduleOperatingAgreementUpdate relays with the per-agent PROXY appended", async () => {
  const { adapter, relayed } = makeAdapter({ controller: CONTROLLER });
  const hash = await adapter.scheduleOperatingAgreementUpdate(PROXY, OA_HASH, CONTROLLER);
  expect(hash).toBe(FAKE_HASH);
  const expected = encodeFunctionData({
    abi: legalManagerAbi,
    functionName: "scheduleOperatingAgreementUpdate",
    args: [OA_HASH],
  });
  assertRelayed(relayed()[0], { data: expected, target: PROXY });
});

test("executeOperatingAgreementUpdate relays with the per-agent PROXY appended", async () => {
  const { adapter, relayed } = makeAdapter({ controller: CONTROLLER });
  await adapter.executeOperatingAgreementUpdate(PROXY, OA_HASH, CONTROLLER);
  const expected = encodeFunctionData({
    abi: legalManagerAbi,
    functionName: "executeOperatingAgreementUpdate",
    args: [OA_HASH],
  });
  assertRelayed(relayed()[0], { data: expected, target: PROXY });
});

test("A-adapter-1: the OA pair BROADCASTS and returns — it never awaits its own receipt", async () => {
  // The split is load-bearing (design §7): the anchor loop persists the tx hash on the oa_anchors
  // row BEFORE the receipt, so a crash in that gap resumes by ADOPTING it. Re-broadcasting a
  // schedule is not harmless — LegalManager has no AlreadyScheduled guard, so a re-schedule
  // silently RESETS the timelock and shortens the veto window the guardian was notified about.
  const { adapter, waitForTransactionReceipt } = makeAdapter({ controller: CONTROLLER });
  await adapter.scheduleOperatingAgreementUpdate(PROXY, OA_HASH, CONTROLLER);
  await adapter.executeOperatingAgreementUpdate(PROXY, OA_HASH, CONTROLLER);
  expect(waitForTransactionReceipt).not.toHaveBeenCalled();
  // …and the confirm half is exposed for the caller to await once the hash is durable — BOUNDED
  // (review F7), because this is awaited from an unattended sweeper tick that holds the entity's
  // keyed lock: viem's default is to wait forever, and one dropped tx would pin a worker with it.
  await adapter.waitForManagerReceipt(FAKE_HASH);
  expect(waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  expect(waitForTransactionReceipt.mock.calls[0]![0]).toEqual({
    hash: FAKE_HASH,
    timeout: MANAGER_RECEIPT_TIMEOUT_MS,
  });
});

test("A-adapter-2: a LEGACY agent's amendment goes DIRECT, even in controller mode", async () => {
  // The proxy's manager is immutable. Relaying a pre-cutover agent's amendment would arrive as
  // msg.sender == controller and revert NotManager — permanently.
  const { adapter, simulateContract, relayed } = makeAdapter({ controller: CONTROLLER });
  await adapter.scheduleOperatingAgreementUpdate(PROXY, OA_HASH, LEGACY_MANAGER);
  await adapter.executeOperatingAgreementUpdate(PROXY, OA_HASH, LEGACY_MANAGER);
  expect(relayed()).toHaveLength(0);
  expect(simulateContract.mock.calls.map((c) => [c[0].address, c[0].functionName])).toEqual([
    [PROXY, "scheduleOperatingAgreementUpdate"],
    [PROXY, "executeOperatingAgreementUpdate"],
  ]);
});

test("A-adapter-3: Vetoed()/TooEarly()/NotActive() decode by NAME, not as a hex blob", async () => {
  // These three are the entire vocabulary of an amendment that will not go through, and an
  // operator reading `0x...` in journald cannot tell "the guardian stopped this" from "the
  // timelock has not elapsed" from "the body is dissolving".
  for (const errorName of ["Vetoed", "TooEarly", "NotActive"] as const) {
    const { adapter, estimateGas, relayed } = makeAdapter({ controller: CONTROLLER });
    estimateGas.mockRejectedValueOnce(
      new BaseError("execution reverted", {
        cause: new RawContractError({
          data: encodeErrorResult({ abi: legalManagerAbi, errorName }),
        }),
      }),
    );
    await expect(
      adapter.executeOperatingAgreementUpdate(PROXY, OA_HASH, CONTROLLER),
    ).rejects.toThrow(new RegExp(errorName));
    expect(relayed()).toHaveLength(0);
  }
});

test("relayed writes still await the receipt (except the three broadcast-only ones)", async () => {
  const a1 = makeAdapter({ controller: CONTROLLER });
  const a2 = makeAdapter({ controller: CONTROLLER });
  await a1.adapter.setAgentMetadata(1n, "ens", "0x00", CONTROLLER);
  await a2.adapter.broadcastCreateEntity(createParams);
  expect(a1.relayed()).toHaveLength(1);
  expect(a2.relayed()).toHaveLength(1);
});

test("a treasury top-up is NOT relayed in controller mode — it is a plain USDC transfer by the signer", async () => {
  const { adapter, simulateContract, direct, relayed } = makeAdapter({
    controller: CONTROLLER,
  });
  await adapter.broadcastFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 500_000n });
  expect(relayed()).toHaveLength(0);
  expect(simulateContract.mock.calls[0]![0].address).toBe(USDC);
  expect(direct()).toHaveLength(1);
  expect(typeof (direct()[0] as { gas?: bigint }).gas).toBe("bigint");
});

// ── THE regression that protects the 11 legacy prod agents ───────────────

test("legacy agent in CONTROLLER mode takes the direct path, byte-identical to legacy mode", async () => {
  // An agent whose immutable manager is the old EOA. Relaying its calls would arrive at the vault
  // as msg.sender == controller and revert NotManager — permanently, for every agent minted
  // before the cutover. Controller mode must NOT change anything for them.
  const controlled = makeAdapter({ controller: CONTROLLER });
  const legacyDeployment = makeAdapter(); // no controller at all — the pre-flip behavior

  for (const { adapter } of [controlled, legacyDeployment]) {
    // Two DEPLOYMENTS, so two nonce ledgers: the floors are process-wide (one signing key, one
    // counter), and sharing them here would make the second deployment's calls differ by a number
    // that has nothing to do with routing.
    resetSenderNonces();
    await adapter.setAgentWallet({
      agentId: 1n,
      newWallet: PAYOUT,
      deadline: 1n,
      signature: "0x00",
      agentManager: LEGACY_MANAGER,
    });
    await adapter.setAgentMetadata(1n, "ens", "0x00", LEGACY_MANAGER);
    await adapter.schedulePolicyUpdate(
      TREASURY,
      { newCap: 1n, newPeriod: 1n, allowlistOn: true, newPayout: PAYOUT },
      LEGACY_MANAGER,
    );
    await adapter.executePolicyUpdate(TREASURY, POLICY_ID, LEGACY_MANAGER);
  }

  // Nothing relayed, on either deployment.
  expect(controlled.relayed()).toHaveLength(0);
  expect(controlled.estimateGas).not.toHaveBeenCalled();
  expect(legacyDeployment.relayed()).toHaveLength(0);

  // ...and the direct calls are byte-identical between the two deployments.
  const shape = (m: typeof controlled.simulateContract) =>
    m.mock.calls.map((c) => [c[0].address, c[0].functionName, c[0].account?.address]);
  expect(shape(controlled.simulateContract)).toEqual(shape(legacyDeployment.simulateContract));
  expect(shape(controlled.simulateContract)).toEqual([
    [REGISTRY, "setAgentWallet", EXECUTOR],
    [REGISTRY, "setMetadata", EXECUTOR],
    [TREASURY, "schedulePolicyUpdate", EXECUTOR],
    [TREASURY, "executePolicyUpdate", EXECUTOR],
  ]);
  // Byte-identical means exactly that: the serialised transactions match, field for field.
  expect(controlled.direct()).toEqual(legacyDeployment.direct());
  // ...and each one carries the call it was asked for, at the nonce this process assigned it.
  const expectedDirect = [
    {
      to: REGISTRY,
      data: encodeFunctionData({
        abi: iIdentityRegistryAbi,
        functionName: "setAgentWallet",
        args: [1n, PAYOUT, 1n, "0x00"],
      }),
    },
    {
      to: REGISTRY,
      data: encodeFunctionData({
        abi: iIdentityRegistryAbi,
        functionName: "setMetadata",
        args: [1n, "ens", "0x00"],
      }),
    },
    {
      to: TREASURY,
      data: encodeFunctionData({
        abi: agentTreasuryAbi,
        functionName: "schedulePolicyUpdate",
        args: [1n, 1n, true, PAYOUT],
      }),
    },
    {
      to: TREASURY,
      data: encodeFunctionData({
        abi: agentTreasuryAbi,
        functionName: "executePolicyUpdate",
        args: [POLICY_ID],
      }),
    },
  ];
  expect(controlled.direct()).toHaveLength(expectedDirect.length);
  for (const [i, tx] of controlled.direct().entries()) {
    expect(tx.to).toBe(expectedDirect[i]!.to.toLowerCase());
    expect(tx.data).toBe(expectedDirect[i]!.data);
    expect(tx.value).toBeUndefined(); // a manager call moves no native value
    expect(tx.gas).toBe(PREPARED_GAS);
    expect(tx.nonce).toBe(i);
  }
  // Signed as the executor on both deployments — the sender is not a field of the wire format.
  for (const req of controlled.signRequests)
    expect((req.account as { address?: Address }).address).toBe(EXECUTOR);
});

test("controller-managed agent in controller mode relays; the same agent has no relay pre-flip", async () => {
  const controlled = makeAdapter({ controller: CONTROLLER });
  await controlled.adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER);
  expect(controlled.relayed()).toHaveLength(1);
  expect(controlled.simulateContract).not.toHaveBeenCalled();

  // Same agent manager, but this deployment has no CONTROLLER_ADDRESS: there is nothing to relay
  // through, so it goes direct (and would fail on-chain — loudly, which is the point).
  const unconfigured = makeAdapter();
  await unconfigured.adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER);
  expect(unconfigured.relayed()).toHaveLength(0);
  expect(unconfigured.simulateContract).toHaveBeenCalledTimes(1);
});

test("createEntity routes on the manager being minted, not on the deployment", async () => {
  // The doors force the controller in controller mode, so this relays...
  const relayedAdapter = makeAdapter({ controller: CONTROLLER });
  await relayedAdapter.adapter.broadcastCreateEntity(createParams);
  expect(relayedAdapter.relayed()).toHaveLength(1);

  // ...and a spec that somehow carries a different manager goes DIRECT, where the factory's M4
  // check (`ManagerMustBeOwner`) rejects it, instead of being quietly relayed into the namespace.
  const directAdapter = makeAdapter({ controller: CONTROLLER });
  await directAdapter.adapter.broadcastCreateEntity({ ...createParams, manager: LEGACY_MANAGER });
  expect(directAdapter.relayed()).toHaveLength(0);
  expect(directAdapter.simulateContract.mock.calls[0]![0].functionName).toBe("createEntity");
});

// ── resume across the flip ───────────────────────────────────────────────

test("confirmCreateEntity: the controller assertion applies only to a RELAYED create", async () => {
  // A record BROADCAST before the flip (manager = the old EOA) and CONFIRMED after it. The mint is
  // already on chain and perfectly valid; asserting "manager must be the controller" on it would
  // throw forever and strand the saga at `translating`.
  const { adapter, publicClient } = makeConfirmAdapter({
    controller: CONTROLLER,
    mintedManager: LEGACY_MANAGER,
  });
  const res = await adapter.confirmCreateEntity(FAKE_HASH, LEGACY_MANAGER);
  expect(res.agentId).toBe(876734n);
  expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
});

test("confirmCreateEntity: a RELAYED create whose mint is not the controller's still throws", async () => {
  const { adapter } = makeConfirmAdapter({
    controller: CONTROLLER,
    mintedManager: LEGACY_MANAGER,
  });
  // agentManager == the controller => this create WAS relayed => the mint must be the controller's.
  await expect(adapter.confirmCreateEntity(FAKE_HASH, CONTROLLER)).rejects.toThrow(
    /is not the configured controller/,
  );
});

test("confirmCreateEntity: a controller mint under a controller deployment is accepted", async () => {
  const { adapter } = makeConfirmAdapter({ controller: CONTROLLER, mintedManager: CONTROLLER });
  const res = await adapter.confirmCreateEntity(FAKE_HASH, CONTROLLER);
  // viem returns the topics checksummed; compare case-insensitively.
  expect(res.proxy.toLowerCase()).toBe("0x0000000000000000000000000000000000000abc");
  expect(res.treasury.toLowerCase()).toBe("0x0000000000000000000000000000000000000def");
});

/** A publicClient whose receipt carries real EntityCreated/TreasuryCreated logs from FACTORY. */
function makeConfirmAdapter(opts: { controller?: Address; mintedManager: Address }) {
  const publicClient = {
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ logs: buildLogs(opts.mintedManager) }),
  } as unknown as PublicClient & { waitForTransactionReceipt: ReturnType<typeof vi.fn> };
  const adapter = new ArcAdapter({
    publicClient,
    managerWallet: { account: { address: EXECUTOR } } as unknown as WalletClient,
    chainId: 5042002,
    factory: FACTORY,
    identityRegistry: REGISTRY,
    controller: opts.controller,
  });
  return { adapter, publicClient };
}

/** Real, viem-encodable logs for the two factory events (topics computed from the generated ABI). */
function buildLogs(manager: Address) {
  const entityTopics = encodeEventTopics({
    abi: legalManagerFactoryAbi,
    eventName: "EntityCreated",
    args: {
      agentId: 876734n,
      proxy: "0x0000000000000000000000000000000000000abc" as Address,
      manager,
    },
  });
  const treasuryTopics = encodeEventTopics({
    abi: legalManagerFactoryAbi,
    eventName: "TreasuryCreated",
    args: {
      agentId: 876734n,
      treasury: "0x0000000000000000000000000000000000000def" as Address,
      operator: "0x000000000000000000000000000000000000cccc" as Address,
    },
  });
  return [
    { address: FACTORY, data: "0x" as Hex, topics: entityTopics },
    { address: FACTORY, data: "0x" as Hex, topics: treasuryTopics },
  ];
}

// ── preflight failures: revert vs transport ──────────────────────────────

test("a reverting relay preflight names the target + function and never sends the tx", async () => {
  const { adapter, estimateGas, relayed } = makeAdapter({ controller: CONTROLLER });
  // The controller bubbles the vault's revert verbatim; estimateGas carries it as raw bytes.
  estimateGas.mockRejectedValueOnce(
    new BaseError("execution reverted", { cause: new RawContractError({ data: "0x1a2b3c4d" }) }),
  );
  await expect(adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER)).rejects.toThrow(
    /relay executePolicyUpdate -> .*reverted in simulation/i,
  );
  expect(relayed()).toHaveLength(0);
});

test("a bubbled vault custom error is DECODED against the target ABI (debuggable relay failures)", async () => {
  const { adapter, estimateGas } = makeAdapter({ controller: CONTROLLER });
  const reverted = encodeErrorResult({ abi: agentTreasuryAbi, errorName: "TooEarly" });
  estimateGas.mockRejectedValueOnce(
    new BaseError("execution reverted", { cause: new RawContractError({ data: reverted }) }),
  );
  await expect(adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER)).rejects.toThrow(
    /TooEarly/,
  );
});

test("a CONTROLLER-origin error names itself too (NotAuthorized, not a hex blob)", async () => {
  const { adapter, estimateGas } = makeAdapter({ controller: CONTROLLER });
  const reverted = encodeErrorResult({
    abi: noviControllerAbi,
    errorName: "NotAuthorized",
    args: [
      slice(
        encodeFunctionData({
          abi: agentTreasuryAbi,
          functionName: "executePolicyUpdate",
          args: [POLICY_ID],
        }),
        0,
        4,
      ),
      EXECUTOR.toLowerCase() as Address,
    ],
  });
  estimateGas.mockRejectedValueOnce(
    new BaseError("execution reverted", { cause: new RawContractError({ data: reverted }) }),
  );
  await expect(adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER)).rejects.toThrow(
    /NotAuthorized\(0x[0-9a-f]{8}, 0x/i,
  );
});

test("TargetNotBound (the M5 pin refusing a target) decodes by name", async () => {
  const { adapter, estimateGas } = makeAdapter({ controller: CONTROLLER });
  const reverted = encodeErrorResult({
    abi: noviControllerAbi,
    errorName: "TargetNotBound",
    args: ["0xdeadbeef", REGISTRY],
  });
  estimateGas.mockRejectedValueOnce(
    new BaseError("execution reverted", { cause: new RawContractError({ data: reverted }) }),
  );
  await expect(adapter.setAgentMetadata(1n, "ens", "0x00", CONTROLLER)).rejects.toThrow(
    /TargetNotBound/,
  );
});

test("a TRANSPORT failure is rethrown untouched — an RPC timeout is not a revert", async () => {
  const { adapter, estimateGas, relayed } = makeAdapter({ controller: CONTROLLER });
  const outage = new Error("socket hang up");
  estimateGas.mockRejectedValueOnce(outage);
  // Identity, not just message: nothing wrapped it, so no operator goes hunting a contract bug.
  await expect(adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER)).rejects.toBe(outage);
  expect(relayed()).toHaveLength(0);
});

// ── the named-account guard ──────────────────────────────────────────────

test("an account-less manager wallet is refused before any chain I/O, in BOTH modes", async () => {
  for (const controller of [CONTROLLER, undefined]) {
    const { adapter, estimateGas, simulateContract } = makeAdapter({ controller, noAccount: true });
    await expect(adapter.executePolicyUpdate(TREASURY, POLICY_ID, controller)).rejects.toThrow(
      /manager wallet has no account/i,
    );
    expect(estimateGas).not.toHaveBeenCalled();
    expect(simulateContract).not.toHaveBeenCalled();
  }
});

// ── Regression: with no controller configured, nothing about the five sites may change. ──

test("legacy mode: every relayed site still simulates against its TARGET and writes the request", async () => {
  const { adapter, simulateContract, direct, relayed } = makeAdapter();
  await adapter.broadcastCreateEntity(createParams);
  await adapter.setAgentWallet({
    agentId: 1n,
    newWallet: PAYOUT,
    deadline: 1n,
    signature: "0x00",
  });
  await adapter.setAgentMetadata(1n, "ens", "0x00");
  await adapter.schedulePolicyUpdate(TREASURY, {
    newCap: 1n,
    newPeriod: 1n,
    allowlistOn: true,
    newPayout: PAYOUT,
  });
  await adapter.executePolicyUpdate(TREASURY, POLICY_ID);

  expect(relayed()).toHaveLength(0);
  expect(simulateContract.mock.calls.map((c) => [c[0].address, c[0].functionName])).toEqual([
    [FACTORY, "createEntity"],
    [REGISTRY, "setAgentWallet"],
    [REGISTRY, "setMetadata"],
    [TREASURY, "schedulePolicyUpdate"],
    [TREASURY, "executePolicyUpdate"],
  ]);
  // Every one signs as the platform account and forwards the SIMULATED request unmodified.
  for (const c of simulateContract.mock.calls) expect(c[0].account?.address).toBe(EXECUTOR);
  expect(direct()).toHaveLength(5);
  // Each site sends the call it simulated, to the target it simulated it against, at the nonce
  // this process assigned it — consecutive, because one key sends one at a time.
  const expectedLegacy = [
    { to: FACTORY, data: createCalldata(CONTROLLER) },
    {
      to: REGISTRY,
      data: encodeFunctionData({
        abi: iIdentityRegistryAbi,
        functionName: "setAgentWallet",
        args: [1n, PAYOUT, 1n, "0x00"],
      }),
    },
    {
      to: REGISTRY,
      data: encodeFunctionData({
        abi: iIdentityRegistryAbi,
        functionName: "setMetadata",
        args: [1n, "ens", "0x00"],
      }),
    },
    {
      to: TREASURY,
      data: encodeFunctionData({
        abi: agentTreasuryAbi,
        functionName: "schedulePolicyUpdate",
        args: [1n, 1n, true, PAYOUT],
      }),
    },
    {
      to: TREASURY,
      data: encodeFunctionData({
        abi: agentTreasuryAbi,
        functionName: "executePolicyUpdate",
        args: [POLICY_ID],
      }),
    },
  ];
  for (const [i, tx] of direct().entries()) {
    expect(tx.to).toBe(expectedLegacy[i]!.to.toLowerCase());
    expect(tx.data).toBe(expectedLegacy[i]!.data);
    expect(tx.value).toBeUndefined();
    expect(tx.gas).toBe(PREPARED_GAS);
    expect(tx.nonce).toBe(i);
  }
});

test("legacy mode never opens a relay preflight", async () => {
  const { adapter, call, estimateGas } = makeAdapter();
  await adapter.executePolicyUpdate(TREASURY, POLICY_ID);
  expect(call).not.toHaveBeenCalled();
  expect(estimateGas).not.toHaveBeenCalled();
});
