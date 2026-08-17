/**
 * confirmCreateEntity's event parsing under NoviController mode (design §5, "Registry event
 * parsing: EntityCreated's manager topic now = controller").
 *
 * In controller mode the create tx is sent TO the controller, so the receipt no longer carries only
 * factory logs — the controller emits its own `Relayed` event, and any contract the relay touches
 * can emit whatever it likes. Two consequences, both pinned here: the ids must be read from the
 * FACTORY's own logs, and the manager topic must be the controller (a mismatch means the deployment
 * is pointed at the old factory or the wrong controller, and every later step would fail obscurely).
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  encodeEventTopics,
  pad,
  toHex,
} from "viem";
import { expect, test, vi } from "vitest";
import { legalManagerFactoryAbi } from "../../../src/abis/generated";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";

const CONTROLLER = "0x4819000000000000000000000000000000000000" as Address;
const FACTORY = "0x0000000000000000000000000000000000000001" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000002" as Address;
const EOA_MANAGER = "0x000000000000000000000000000000000000000b" as Address;
const PROXY = "0x0000000000000000000000000000000000000abc" as Address;
const TREASURY = "0x0000000000000000000000000000000000000def" as Address;
const OPERATOR = "0x000000000000000000000000000000000000cccc" as Address;
const TX = "0xdeadbeef00000000000000000000000000000000000000000000000000000004" as Hex;

function entityCreatedLog(p: { emitter: Address; agentId: bigint; manager: Address }) {
  return {
    address: p.emitter,
    data: "0x" as Hex,
    topics: encodeEventTopics({
      abi: legalManagerFactoryAbi,
      eventName: "EntityCreated",
      args: { agentId: p.agentId, proxy: PROXY, manager: p.manager },
    }),
  };
}

function treasuryCreatedLog(p: { emitter: Address; agentId: bigint }) {
  return {
    address: p.emitter,
    data: "0x" as Hex,
    topics: encodeEventTopics({
      abi: legalManagerFactoryAbi,
      eventName: "TreasuryCreated",
      args: { agentId: p.agentId, treasury: TREASURY, operator: OPERATOR },
    }),
  };
}

/** A controller `Relayed(address,address,bytes4)` log — noise the parser must ignore. */
const relayedLog = {
  address: CONTROLLER,
  data: "0x" as Hex,
  topics: [
    "0x1e2b3c4d5e6f70819200000000000000000000000000000000000000000000aa" as Hex,
    pad(CONTROLLER),
    pad(FACTORY),
    pad(toHex(1)),
  ],
};

function makeAdapter(logs: unknown[], controller?: Address) {
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ logs });
  const publicClient = {
    waitForTransactionReceipt,
    simulateContract: vi.fn(),
    call: vi.fn(),
  } as unknown as PublicClient;
  const managerWallet = {
    account: { address: EOA_MANAGER },
    writeContract: vi.fn(),
    sendTransaction: vi.fn(),
  } as unknown as WalletClient;
  return new ArcAdapter({
    publicClient,
    managerWallet,
    chainId: 5042002,
    factory: FACTORY,
    identityRegistry: REGISTRY,
    controller,
  });
}

test("controller mode: ids come from the FACTORY's logs, past the controller's own event", async () => {
  const adapter = makeAdapter(
    [
      relayedLog,
      entityCreatedLog({ emitter: FACTORY, agentId: 876734n, manager: CONTROLLER }),
      treasuryCreatedLog({ emitter: FACTORY, agentId: 876734n }),
    ],
    CONTROLLER,
  );
  const res = await adapter.confirmCreateEntity(TX);
  expect(res.agentId).toBe(876734n);
  expect(res.proxy.toLowerCase()).toBe(PROXY);
  expect(res.treasury.toLowerCase()).toBe(TREASURY);
  expect(res.txHash).toBe(TX);
});

test("controller mode: a same-signature event from another contract cannot hijack the ids", async () => {
  // Any contract the relay touches can emit EntityCreated(uint256,address,address). Only the
  // configured factory's log counts.
  const adapter = makeAdapter(
    [
      entityCreatedLog({ emitter: REGISTRY, agentId: 999n, manager: EOA_MANAGER }),
      entityCreatedLog({ emitter: FACTORY, agentId: 42n, manager: CONTROLLER }),
      treasuryCreatedLog({ emitter: FACTORY, agentId: 42n }),
    ],
    CONTROLLER,
  );
  expect((await adapter.confirmCreateEntity(TX)).agentId).toBe(42n);
});

test("controller mode: a manager topic that is NOT the controller is refused by name", async () => {
  // The shape a stale FACTORY_ADDRESS (old factory, EOA manager) produces — caught here instead of
  // three steps later when the controller cannot bind an NFT it does not own.
  const adapter = makeAdapter(
    [
      entityCreatedLog({ emitter: FACTORY, agentId: 7n, manager: EOA_MANAGER }),
      treasuryCreatedLog({ emitter: FACTORY, agentId: 7n }),
    ],
    CONTROLLER,
  );
  await expect(adapter.confirmCreateEntity(TX)).rejects.toThrow(/manager.*controller/is);
});

test("legacy mode: no manager assertion — any manager the caller chose is accepted, as before", async () => {
  const adapter = makeAdapter([
    entityCreatedLog({ emitter: FACTORY, agentId: 3n, manager: EOA_MANAGER }),
    treasuryCreatedLog({ emitter: FACTORY, agentId: 3n }),
  ]);
  expect((await adapter.confirmCreateEntity(TX)).agentId).toBe(3n);
});

test("a receipt with no factory events still fails with the existing message", async () => {
  const adapter = makeAdapter([relayedLog], CONTROLLER);
  await expect(adapter.confirmCreateEntity(TX)).rejects.toThrow(
    /EntityCreated\/TreasuryCreated not emitted/,
  );
});
