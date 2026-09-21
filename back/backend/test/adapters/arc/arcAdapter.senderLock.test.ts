/**
 * THE GUARD: no platform-key send may reach the wire outside the sender lock, and none may leave
 * its nonce to viem.
 *
 * The wallet client handed to the adapter here REFUSES a send when the lock is not held, so this
 * file fails for any send path that forgets the chokepoint — including one added later. It also
 * refuses a send with no explicit nonce, which is the other half: a nonce viem reads for itself
 * inside the call is a nonce picked outside our ledger, and the floor that protects us from a
 * stale node read would never see it.
 *
 * No chain and no anvil: the node is a counter, and the receipt is a promise this file controls.
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { beforeEach, expect, test, vi } from "vitest";
import { ArcAdapter } from "../../../src/adapters/arc/arcAdapter";
import {
  nextSenderNonce,
  resetSenderNonces,
  senderLockHeld,
  withSenderLock,
} from "../../../src/adapters/arc/senderLock";

const EXECUTOR = "0x000000000000000000000000000000000000000B" as Address;
const CONTROLLER = "0x000000000000000000000000000000000000c07a" as Address;
const FACTORY = "0x0000000000000000000000000000000000000001" as Address;
const REGISTRY = "0x0000000000000000000000000000000000000002" as Address;
const TREASURY = "0x000000000000000000000000000000000000000F" as Address;
const PROXY = "0x00000000000000000000000000000000000000fa" as Address;
const USDC = "0x3600000000000000000000000000000000000000" as Address;
const LEGACY_MANAGER = "0x000000000000000000000000000000000001e6ac" as Address;
const OA_HASH = `0x${"ab".repeat(32)}` as Hex;
const POLICY_ID = `0x${"cd".repeat(32)}` as Hex;
const SIG = `0x${"11".repeat(65)}` as Hex;

/** Every send this fake wallet accepts, in the order the node saw them. */
type Sent = { via: "writeContract" | "sendTransaction" | "sendRawTransaction"; nonce?: number };

function makeAdapter(
  opts: {
    controller?: Address;
    /** Pending counts the node answers with, in order (the last one repeats — a stale replica). */
    pending?: number[];
    /** Hashes whose receipt never arrives. */
    hangReceipt?: Hex[];
  } = {},
) {
  const sent: Sent[] = [];
  const pending = [...(opts.pending ?? [0])];
  let mined = 0;

  /** The invariant, enforced where the transaction would leave the process. */
  const guard = (via: Sent["via"], nonce: unknown): Hex => {
    if (!senderLockHeld(EXECUTOR))
      throw new Error(`${via} reached the wire without the sender lock`);
    if (typeof nonce !== "number")
      throw new Error(`${via} reached the wire with no explicit nonce (viem would pick its own)`);
    sent.push({ via, nonce });
    mined = Math.max(mined, nonce + 1);
    return `0x${(nonce + 1).toString(16).padStart(64, "0")}` as Hex;
  };

  const getTransactionCount = vi.fn(async () =>
    pending.length > 1 ? pending.shift()! : pending[0]!,
  );
  const waitForTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    if (opts.hangReceipt?.includes(hash)) await new Promise(() => {});
    return { status: "success", logs: [] };
  });
  const publicClient = {
    simulateContract: vi.fn(async () => ({ request: { marker: "sim-request" } })),
    estimateGas: vi.fn(async () => 123_456n),
    getTransactionCount,
    waitForTransactionReceipt,
    getBlock: vi.fn(async () => ({ timestamp: 1_000n })),
  } as unknown as PublicClient;

  const managerWallet = {
    account: { address: EXECUTOR },
    chain: { id: 5042002 },
    writeContract: vi.fn(async (r: { nonce?: number }) => guard("writeContract", r.nonce)),
    sendTransaction: vi.fn(async (r: { nonce?: number }) => guard("sendTransaction", r.nonce)),
    sendRawTransaction: vi.fn(async () => guard("sendRawTransaction", 0)),
    prepareTransactionRequest: vi.fn(async (r: { nonce?: number }) => ({
      ...r,
      marker: "prepared",
    })),
    signTransaction: vi.fn(async () => "0xsignedbytes" as Hex),
  } as unknown as WalletClient;

  const adapter = new ArcAdapter({
    publicClient,
    managerWallet,
    chainId: 5042002,
    factory: FACTORY,
    identityRegistry: REGISTRY,
    controller: opts.controller,
  });
  return { adapter, sent, getTransactionCount, managerWallet };
}

const createParams = {
  manager: CONTROLLER,
  guardian: "0x000000000000000000000000000000000000bbbb" as Address,
  operator: "0x000000000000000000000000000000000000cccc" as Address,
  amendmentDelay: 3_600n,
  metadataURI: "https://host.example/metadata/abc",
  ein: "STUB-NOT-FILED",
  formationDate: 0,
  operatingAgreementHash: OA_HASH,
  treasury: {
    usdc: USDC,
    payoutAddress: "0x000000000000000000000000000000000000000A" as Address,
    cap: 1_000_000n,
    period: 2_592_000n,
    allowlistEnabled: false,
  },
};

/** Every platform-key send the adapter can make, by the public method that makes it. */
const sendPaths: { name: string; run: (a: ArcAdapter) => Promise<unknown> }[] = [
  { name: "broadcastCreateEntity", run: (a) => a.broadcastCreateEntity(createParams) },
  {
    name: "setAgentWallet",
    run: (a) =>
      a.setAgentWallet({
        agentId: 7n,
        newWallet: createParams.operator,
        deadline: 9_999n,
        signature: SIG,
        agentManager: LEGACY_MANAGER,
      }),
  },
  {
    name: "setAgentMetadata",
    run: (a) => a.setAgentMetadata(7n, "ens", "0xabcd", LEGACY_MANAGER),
  },
  {
    name: "schedulePolicyUpdate",
    run: (a) =>
      a.schedulePolicyUpdate(
        TREASURY,
        { newCap: 1n, newPeriod: 2n, allowlistOn: false, newPayout: TREASURY },
        LEGACY_MANAGER,
      ),
  },
  {
    name: "executePolicyUpdate",
    run: (a) => a.executePolicyUpdate(TREASURY, POLICY_ID, LEGACY_MANAGER),
  },
  {
    name: "scheduleOperatingAgreementUpdate",
    run: (a) => a.scheduleOperatingAgreementUpdate(PROXY, OA_HASH, LEGACY_MANAGER),
  },
  {
    name: "executeOperatingAgreementUpdate",
    run: (a) => a.executeOperatingAgreementUpdate(PROXY, OA_HASH, LEGACY_MANAGER),
  },
  {
    name: "broadcastFundTreasury",
    run: (a) => a.broadcastFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 500_000n }),
  },
  {
    name: "fundTreasury",
    run: (a) => a.fundTreasury({ usdc: USDC, treasury: TREASURY, amount: 1n }),
  },
  { name: "sendNativeAsPlatform", run: (a) => a.sendNativeAsPlatform(TREASURY, 10n) },
];

beforeEach(() => resetSenderNonces());

test.each(sendPaths)("$name sends under the lock, with an explicit nonce", async ({ run }) => {
  const { adapter, sent } = makeAdapter();
  await run(adapter);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.nonce).toBe(0);
});

test.each(sendPaths)("$name sends under the lock in CONTROLLER mode too", async ({ run }) => {
  // The relayed path is a different send (raw `sendTransaction` to the controller); it must be
  // locked and numbered exactly like the direct one.
  const { adapter, sent } = makeAdapter({ controller: CONTROLLER });
  await run(adapter);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.nonce).toBe(0);
});

test("concurrent sends from the adapter get distinct consecutive nonces", async () => {
  // The defect, at the level it was reported: the node answers the same count to every reader
  // until one of our transactions mines. Five sends, five nonces.
  const { adapter, sent } = makeAdapter({ pending: [0] });
  await Promise.all([
    adapter.broadcastFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 1n }),
    adapter.broadcastCreateEntity(createParams),
    adapter.setAgentMetadata(7n, "ens", "0xabcd", LEGACY_MANAGER),
    adapter.sendNativeAsPlatform(TREASURY, 1n),
    adapter.broadcastFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 2n }),
  ]);
  expect(sent.map((s) => s.nonce)).toEqual([0, 1, 2, 3, 4]);
});

test("the lock is NOT held across a receipt wait", async () => {
  // `setAgentWallet` broadcasts and then waits for its receipt. If the lock covered the wait, a
  // transaction that never mines would stop every other send from this key — forever.
  const hung = "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;
  const { adapter, sent } = makeAdapter({ hangReceipt: [hung] });
  const waiting = adapter.setAgentWallet({
    agentId: 7n,
    newWallet: createParams.operator,
    deadline: 9_999n,
    signature: SIG,
    agentManager: LEGACY_MANAGER,
  });
  // Let the first send reach the wire and enter its (never-ending) receipt wait.
  await new Promise((r) => setTimeout(r, 5));
  expect(sent).toHaveLength(1);

  await expect(
    adapter.broadcastFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 1n }),
  ).resolves.toMatch(/^0x/);
  expect(sent.map((s) => s.nonce)).toEqual([0, 1]);
  void waiting.catch(() => {});
});

test("signFundTreasury refuses to pick a nonce outside the lock", async () => {
  // The saga's fund window spans sign -> persist -> send, so the LOCK IS THE CALLER'S. A signature
  // taken unlocked has already claimed a nonce another send can claim too.
  const { adapter } = makeAdapter();
  await expect(
    adapter.signFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 1n }),
  ).rejects.toThrow(/sender lock/i);
});

test("the fund window numbers its transactions from the same ledger as every other send", async () => {
  const { adapter, sent } = makeAdapter({ pending: [0] });
  // One atomic send first, so the floor is 1 and the node's stale 0 must not be believed.
  await adapter.sendNativeAsPlatform(TREASURY, 1n);
  const signed = await withSenderLock(EXECUTOR, () =>
    adapter.signFundTreasury({ usdc: USDC, treasury: TREASURY, amount: 1n }),
  );
  expect(signed.nonce).toBe(1);
  expect(sent.map((s) => s.nonce)).toEqual([0]); // signing sends nothing
});

test("the platform address is what the lock is keyed on", async () => {
  const { adapter } = makeAdapter();
  expect(adapter.platformAddress).toBe(EXECUTOR);
  await withSenderLock(adapter.platformAddress!, async () => {
    expect(senderLockHeld(EXECUTOR)).toBe(true);
    // The adapter's own nonce picker and the caller's lock agree on the key, or this throws.
    await expect(nextSenderNonce(adapter.platformAddress!, async () => 4)).resolves.toBe(4);
  });
});
