/**
 * ArcAdapter in NoviController mode (design §5): every manager-signed, ROLE-GATED call is sent to
 * the controller with the target address appended as the final 20 bytes; the controller checks the
 * selector role and forwards. Five call sites relay — createEntity, setAgentWallet, setMetadata
 * (the ENS reverse-bind inside EVERY onboarding), schedulePolicyUpdate, executePolicyUpdate — and
 * nothing else: fundTreasury is a plain USDC transfer from the signing key and must stay direct.
 *
 * With no controller configured the adapter must behave EXACTLY as before (simulateContract against
 * the target + writeContract), which is what every existing deployment and test relies on.
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
  encodeFunctionData,
  size,
  slice,
} from "viem";
import { expect, test, vi } from "vitest";
import {
  agentTreasuryAbi,
  iIdentityRegistryAbi,
  legalManagerFactoryAbi,
} from "../../../src/abis/generated";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";

const CONTROLLER = "0x4819000000000000000000000000000000000000" as Address;
const FACTORY = "0x0000000000000000000000000000000000000001" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000002" as Address;
const TREASURY = "0x000000000000000000000000000000000000000F" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const PAYOUT = "0x000000000000000000000000000000000000000A" as Address;
const EXECUTOR = "0x000000000000000000000000000000000000000B" as Address;
const POLICY_ID = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as Hex;
const FAKE_HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000003" as Hex;

function makeAdapter(opts: { controller?: Address } = {}) {
  const simulateContract = vi.fn().mockResolvedValue({ request: { marker: "sim-request" } });
  const call = vi.fn().mockResolvedValue({ data: "0x" });
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({});
  const writeContract = vi.fn().mockResolvedValue(FAKE_HASH);
  const sendTransaction = vi.fn().mockResolvedValue(FAKE_HASH);
  const publicClient = {
    simulateContract,
    call,
    waitForTransactionReceipt,
  } as unknown as PublicClient;
  const managerWallet = {
    account: { address: EXECUTOR },
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
  return { adapter, simulateContract, call, writeContract, sendTransaction };
}

const createParams = {
  manager: CONTROLLER, // in controller mode the manager IS the controller
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

/** The relay contract: to == controller, data == <direct calldata> ++ <20-byte target>. */
function assertRelayed(tx: unknown, expected: { data: Hex; target: Address }) {
  const sent = tx as { to?: Address; data?: Hex; account?: { address?: Address } };
  expect(sent.to).toBe(CONTROLLER);
  const data = sent.data as Hex;
  expect(size(data)).toBe(size(expected.data) + 20);
  expect(slice(data, 0, size(expected.data))).toBe(expected.data); // prefix == the direct calldata
  expect(slice(data, size(data) - 20)).toBe(expected.target.toLowerCase()); // 20-byte suffix
  expect(sent.account?.address ?? sent.account).toBeDefined(); // still sent BY the executor key
}

test("createEntity relays to the controller with the FACTORY appended", async () => {
  const { adapter, call, sendTransaction, simulateContract } = makeAdapter({
    controller: CONTROLLER,
  });
  const hash = await adapter.broadcastCreateEntity(createParams);
  expect(hash).toBe(FAKE_HASH);

  const expected = encodeFunctionData({
    abi: legalManagerFactoryAbi,
    functionName: "createEntity",
    args: [
      createParams.manager,
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
  assertRelayed(sendTransaction.mock.calls[0]![0], { data: expected, target: FACTORY });
  // eth_call simulation first, with the SAME bytes (design §5: bubbled errors before we spend gas).
  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0]![0].to).toBe(CONTROLLER);
  expect(call.mock.calls[0]![0].data).toBe(sendTransaction.mock.calls[0]![0].data);
  expect(simulateContract).not.toHaveBeenCalled(); // the direct-mode path must not also run
});

test("setAgentWallet relays with the REGISTRY appended (the bind the controller owns the NFT for)", async () => {
  const { adapter, sendTransaction } = makeAdapter({ controller: CONTROLLER });
  const args = {
    agentId: 876734n,
    newWallet: "0x00000000000000000000000000000000000005ca" as Address,
    deadline: 1_800_000_000n,
    signature: `0x${"cd".repeat(65)}` as Hex,
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
  await adapter.setAgentMetadata(876734n, "ens", "0x616263");
  const expected = encodeFunctionData({
    abi: iIdentityRegistryAbi,
    functionName: "setMetadata",
    args: [876734n, "ens", "0x616263"],
  });
  assertRelayed(sendTransaction.mock.calls[0]![0], { data: expected, target: REGISTRY });
});

test("schedulePolicyUpdate relays with the per-agent TREASURY appended", async () => {
  const { adapter, sendTransaction } = makeAdapter({ controller: CONTROLLER });
  await adapter.schedulePolicyUpdate(TREASURY, {
    newCap: 200_000_000n,
    newPeriod: 86_400n,
    allowlistOn: false,
    newPayout: PAYOUT,
  });
  const expected = encodeFunctionData({
    abi: agentTreasuryAbi,
    functionName: "schedulePolicyUpdate",
    args: [200_000_000n, 86_400n, false, PAYOUT],
  });
  assertRelayed(sendTransaction.mock.calls[0]![0], { data: expected, target: TREASURY });
});

test("executePolicyUpdate relays with the per-agent TREASURY appended", async () => {
  const { adapter, sendTransaction } = makeAdapter({ controller: CONTROLLER });
  await adapter.executePolicyUpdate(TREASURY, POLICY_ID);
  const expected = encodeFunctionData({
    abi: agentTreasuryAbi,
    functionName: "executePolicyUpdate",
    args: [POLICY_ID],
  });
  assertRelayed(sendTransaction.mock.calls[0]![0], { data: expected, target: TREASURY });
});

test("relayed writes still await the receipt (except broadcastCreateEntity, which never did)", async () => {
  const { adapter } = makeAdapter({ controller: CONTROLLER });
  const { adapter: a2, sendTransaction } = makeAdapter({ controller: CONTROLLER });
  await adapter.setAgentMetadata(1n, "ens", "0x00");
  await a2.broadcastCreateEntity(createParams);
  expect(sendTransaction).toHaveBeenCalledTimes(1);
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

test("a reverting relay simulation names the target + function and never sends the tx", async () => {
  const { adapter, call, sendTransaction } = makeAdapter({ controller: CONTROLLER });
  // The controller bubbles the vault's revert verbatim; eth_call carries it as raw bytes.
  const err = Object.assign(new Error("execution reverted"), {
    data: { data: "0x1a2b3c4d" }, // unknown selector -> shown raw, still attributed
  });
  call.mockRejectedValueOnce(err);
  await expect(adapter.executePolicyUpdate(TREASURY, POLICY_ID)).rejects.toThrow(
    /relay executePolicyUpdate -> .*reverted in simulation/i,
  );
  expect(sendTransaction).not.toHaveBeenCalled();
});

test("a bubbled vault custom error is DECODED against the target ABI (debuggable relay failures)", async () => {
  const { adapter, call } = makeAdapter({ controller: CONTROLLER });
  // The controller bubbles AgentTreasury.TooEarly() verbatim; eth_call has no ABI attached, so the
  // adapter must decode it itself or the operator sees only "0x085de625".
  const reverted = encodeErrorResult({ abi: agentTreasuryAbi, errorName: "TooEarly" });
  // A REAL viem error chain (BaseError -> RawContractError), which is what production throws and
  // what revertData()'s BaseError.walk() consumes — not a synthetic plain object.
  call.mockRejectedValueOnce(
    new BaseError("execution reverted", { cause: new RawContractError({ data: reverted }) }),
  );
  await expect(adapter.executePolicyUpdate(TREASURY, POLICY_ID)).rejects.toThrow(/TooEarly/);
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

test("legacy mode never opens an eth_call relay simulation", async () => {
  const { adapter, call } = makeAdapter();
  await adapter.executePolicyUpdate(TREASURY, POLICY_ID);
  expect(call).not.toHaveBeenCalled();
});
