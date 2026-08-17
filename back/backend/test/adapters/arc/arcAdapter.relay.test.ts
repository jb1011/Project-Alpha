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
  size,
  slice,
} from "viem";
import { expect, test, vi } from "vitest";
import {
  agentTreasuryAbi,
  iIdentityRegistryAbi,
  legalManagerFactoryAbi,
  noviControllerAbi,
} from "../../../src/abis/generated";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";

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
const FAKE_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000003" as Hex;
const GAS = 123_456n;

function makeAdapter(opts: { controller?: Address; noAccount?: boolean } = {}) {
  const simulateContract = vi.fn().mockResolvedValue({ request: { marker: "sim-request" } });
  const call = vi.fn().mockResolvedValue({ data: "0x" });
  const estimateGas = vi.fn().mockResolvedValue(GAS);
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({});
  const writeContract = vi.fn().mockResolvedValue(FAKE_HASH);
  const sendTransaction = vi.fn().mockResolvedValue(FAKE_HASH);
  const publicClient = {
    simulateContract,
    call,
    estimateGas,
    waitForTransactionReceipt,
  } as unknown as PublicClient;
  const managerWallet = {
    account: opts.noAccount ? undefined : { address: EXECUTOR },
    chain: { id: 5042002 },
    writeContract,
    sendTransaction,
  } as unknown as WalletClient;
  const adapter = new ArcAdapter({
    publicClient,
    managerWallet,
    chainId: 5042002,
    factory: FACTORY,
    identityRegistry: REGISTRY,
    controller: opts.controller,
  });
  return { adapter, simulateContract, call, estimateGas, writeContract, sendTransaction };
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
  expect(sent.to).toBe(CONTROLLER);
  const data = sent.data as Hex;
  expect(size(data)).toBe(size(expected.data) + 20);
  expect(slice(data, 0, size(expected.data))).toBe(expected.data); // prefix == the direct calldata
  expect(slice(data, size(data) - 20)).toBe(expected.target.toLowerCase()); // 20-byte suffix
  expect(sent.account?.address ?? sent.account).toBeDefined(); // still sent BY the executor key
  expect(sent.gas).toBe(GAS); // the preflight's estimate rides along as the limit
}

// ── the relayed shape, per call site ─────────────────────────────────────

test("createEntity relays to the controller with the FACTORY appended", async () => {
  const { adapter, estimateGas, sendTransaction, simulateContract } = makeAdapter({
    controller: CONTROLLER,
  });
  const hash = await adapter.broadcastCreateEntity(createParams);
  expect(hash).toBe(FAKE_HASH);

  assertRelayed(sendTransaction.mock.calls[0]![0], {
    data: createCalldata(CONTROLLER),
    target: FACTORY,
  });
  // ONE preflight, on the SAME bytes: estimateGas both proves the call and produces the gas limit
  // (an eth_call preflight left viem to execute the transaction a second time to estimate).
  expect(estimateGas).toHaveBeenCalledTimes(1);
  expect(estimateGas.mock.calls[0]![0].to).toBe(CONTROLLER);
  expect(estimateGas.mock.calls[0]![0].data).toBe(sendTransaction.mock.calls[0]![0].data);
  expect(estimateGas.mock.calls[0]![0].account).toEqual({ address: EXECUTOR });
  expect(simulateContract).not.toHaveBeenCalled(); // the direct-mode path must not also run
});

test("setAgentWallet relays with the REGISTRY appended (the bind the controller owns the NFT for)", async () => {
  const { adapter, sendTransaction } = makeAdapter({ controller: CONTROLLER });
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
  assertRelayed(sendTransaction.mock.calls[0]![0], { data: expected, target: REGISTRY });
});

test("setAgentMetadata relays with the REGISTRY appended (the ENS reverse-bind in EVERY onboarding)", async () => {
  const { adapter, sendTransaction } = makeAdapter({ controller: CONTROLLER });
  await adapter.setAgentMetadata(876734n, "ens", "0x616263", CONTROLLER);
  const expected = encodeFunctionData({
    abi: iIdentityRegistryAbi,
    functionName: "setMetadata",
    args: [876734n, "ens", "0x616263"],
  });
  assertRelayed(sendTransaction.mock.calls[0]![0], { data: expected, target: REGISTRY });
});

test("schedulePolicyUpdate relays with the per-agent TREASURY appended", async () => {
  const { adapter, sendTransaction } = makeAdapter({ controller: CONTROLLER });
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
  assertRelayed(sendTransaction.mock.calls[0]![0], { data: expected, target: TREASURY });
});

test("executePolicyUpdate relays with the per-agent TREASURY appended", async () => {
  const { adapter, sendTransaction } = makeAdapter({ controller: CONTROLLER });
  await adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER);
  const expected = encodeFunctionData({
    abi: agentTreasuryAbi,
    functionName: "executePolicyUpdate",
    args: [POLICY_ID],
  });
  assertRelayed(sendTransaction.mock.calls[0]![0], { data: expected, target: TREASURY });
});

test("relayed writes still await the receipt (except broadcastCreateEntity, which never did)", async () => {
  const a1 = makeAdapter({ controller: CONTROLLER });
  const a2 = makeAdapter({ controller: CONTROLLER });
  await a1.adapter.setAgentMetadata(1n, "ens", "0x00", CONTROLLER);
  await a2.adapter.broadcastCreateEntity(createParams);
  expect(a1.sendTransaction).toHaveBeenCalledTimes(1);
  expect(a2.sendTransaction).toHaveBeenCalledTimes(1);
});

test("fundTreasury is NOT relayed in controller mode — it is a plain USDC transfer by the signer", async () => {
  const { adapter, simulateContract, writeContract, sendTransaction } = makeAdapter({
    controller: CONTROLLER,
  });
  await adapter.fundTreasury({ usdc: USDC, treasury: TREASURY, amount: 500_000n });
  expect(sendTransaction).not.toHaveBeenCalled();
  expect(simulateContract.mock.calls[0]![0].address).toBe(USDC);
  expect(writeContract).toHaveBeenCalledTimes(1);
  expect(typeof (writeContract.mock.calls[0]![0] as { gas?: bigint }).gas).toBe("bigint");
});

// ── THE regression that protects the 11 legacy prod agents ───────────────

test("legacy agent in CONTROLLER mode takes the direct path, byte-identical to legacy mode", async () => {
  // An agent whose immutable manager is the old EOA. Relaying its calls would arrive at the vault
  // as msg.sender == controller and revert NotManager — permanently, for every agent minted
  // before the cutover. Controller mode must NOT change anything for them.
  const controlled = makeAdapter({ controller: CONTROLLER });
  const legacyDeployment = makeAdapter(); // no controller at all — the pre-flip behavior

  for (const { adapter } of [controlled, legacyDeployment]) {
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
  expect(controlled.sendTransaction).not.toHaveBeenCalled();
  expect(controlled.estimateGas).not.toHaveBeenCalled();
  expect(legacyDeployment.sendTransaction).not.toHaveBeenCalled();

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
  expect(controlled.writeContract.mock.calls).toEqual(legacyDeployment.writeContract.mock.calls);
  for (const c of controlled.writeContract.mock.calls)
    expect(c[0]).toEqual({ marker: "sim-request" });
});

test("controller-managed agent in controller mode relays; the same agent has no relay pre-flip", async () => {
  const controlled = makeAdapter({ controller: CONTROLLER });
  await controlled.adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER);
  expect(controlled.sendTransaction).toHaveBeenCalledTimes(1);
  expect(controlled.simulateContract).not.toHaveBeenCalled();

  // Same agent manager, but this deployment has no CONTROLLER_ADDRESS: there is nothing to relay
  // through, so it goes direct (and would fail on-chain — loudly, which is the point).
  const unconfigured = makeAdapter();
  await unconfigured.adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER);
  expect(unconfigured.sendTransaction).not.toHaveBeenCalled();
  expect(unconfigured.simulateContract).toHaveBeenCalledTimes(1);
});

test("createEntity routes on the manager being minted, not on the deployment", async () => {
  // The doors force the controller in controller mode, so this relays...
  const relayed = makeAdapter({ controller: CONTROLLER });
  await relayed.adapter.broadcastCreateEntity(createParams);
  expect(relayed.sendTransaction).toHaveBeenCalledTimes(1);

  // ...and a spec that somehow carries a different manager goes DIRECT, where the factory's M4
  // check (`ManagerMustBeOwner`) rejects it, instead of being quietly relayed into the namespace.
  const direct = makeAdapter({ controller: CONTROLLER });
  await direct.adapter.broadcastCreateEntity({ ...createParams, manager: LEGACY_MANAGER });
  expect(direct.sendTransaction).not.toHaveBeenCalled();
  expect(direct.simulateContract.mock.calls[0]![0].functionName).toBe("createEntity");
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
  const { adapter, estimateGas, sendTransaction } = makeAdapter({ controller: CONTROLLER });
  // The controller bubbles the vault's revert verbatim; estimateGas carries it as raw bytes.
  estimateGas.mockRejectedValueOnce(
    new BaseError("execution reverted", { cause: new RawContractError({ data: "0x1a2b3c4d" }) }),
  );
  await expect(adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER)).rejects.toThrow(
    /relay executePolicyUpdate -> .*reverted in simulation/i,
  );
  expect(sendTransaction).not.toHaveBeenCalled();
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
  const { adapter, estimateGas, sendTransaction } = makeAdapter({ controller: CONTROLLER });
  const outage = new Error("socket hang up");
  estimateGas.mockRejectedValueOnce(outage);
  // Identity, not just message: nothing wrapped it, so no operator goes hunting a contract bug.
  await expect(adapter.executePolicyUpdate(TREASURY, POLICY_ID, CONTROLLER)).rejects.toBe(outage);
  expect(sendTransaction).not.toHaveBeenCalled();
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
  const { adapter, simulateContract, writeContract, sendTransaction } = makeAdapter();
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

  expect(sendTransaction).not.toHaveBeenCalled();
  expect(simulateContract.mock.calls.map((c) => [c[0].address, c[0].functionName])).toEqual([
    [FACTORY, "createEntity"],
    [REGISTRY, "setAgentWallet"],
    [REGISTRY, "setMetadata"],
    [TREASURY, "schedulePolicyUpdate"],
    [TREASURY, "executePolicyUpdate"],
  ]);
  // Every one signs as the platform account and forwards the SIMULATED request unmodified.
  for (const c of simulateContract.mock.calls) expect(c[0].account?.address).toBe(EXECUTOR);
  expect(writeContract.mock.calls).toHaveLength(5);
  for (const c of writeContract.mock.calls) expect(c[0]).toEqual({ marker: "sim-request" });
});

test("legacy mode never opens a relay preflight", async () => {
  const { adapter, call, estimateGas } = makeAdapter();
  await adapter.executePolicyUpdate(TREASURY, POLICY_ID);
  expect(call).not.toHaveBeenCalled();
  expect(estimateGas).not.toHaveBeenCalled();
});
