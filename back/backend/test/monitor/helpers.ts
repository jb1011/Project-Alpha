import {
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeEventTopics,
  getAbiItem,
} from "viem";
import type { MonitoredEntity } from "../../src/monitor/entityLookup";
import { indexEntities } from "../../src/monitor/entityLookup";
import { standingRoles } from "../../src/monitor/events";
import type { RawLog } from "../../src/monitor/rpc";
import type { RuleContext } from "../../src/monitor/rules";

/** Fixed addresses so a failing assertion reads as a role, not a hex blob. */
export const ADDR = {
  controller: "0x9526E228E94A125843B2d010c1155780CBBAFb5c" as Address,
  registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address,
  factory: "0x83D529E813Fe825b84250034A7A63f460A2ECA77" as Address,
  legacyFactory: "0x91997dFcDE0046eA4AbE67a5De9E1DF54c9B6902" as Address,
  beacon: "0x432ed0814FcDDd03330add098093482128Ad2CfD" as Address,
  executor: "0x1111111111111111111111111111111111111111" as Address,
  attacker: "0x2222222222222222222222222222222222222222" as Address,
  admin: "0x3333333333333333333333333333333333333333" as Address,
  treasury: "0x4444444444444444444444444444444444444444" as Address,
  operator: "0x5555555555555555555555555555555555555555" as Address,
  guardian: "0x6666666666666666666666666666666666666666" as Address,
  helper: "0x7777777777777777777777777777777777777777" as Address,
} as const;

/**
 * Build a synthetic log the way the chain would: indexed args into topics, the rest ABI-encoded
 * into data. Encoding for real (rather than hand-writing topics) is what makes these tests able to
 * catch a wrong event signature.
 */
export function makeLog(p: {
  abi: readonly unknown[];
  eventName: string;
  args: Record<string, unknown>;
  address: Address;
  blockNumber?: bigint;
  transactionHash?: Hex;
  logIndex?: number;
}): RawLog {
  const item = getAbiItem({ abi: p.abi as Abi, name: p.eventName }) as AbiEvent;
  if (!item) throw new Error(`makeLog: ${p.eventName} not in abi`);
  const topics = encodeEventTopics({
    abi: p.abi as Abi,
    eventName: p.eventName,
    args: p.args as never,
  });
  const nonIndexed = item.inputs.filter((i) => !i.indexed);
  const data =
    nonIndexed.length > 0
      ? encodeAbiParameters(
          nonIndexed,
          nonIndexed.map((i) => p.args[i.name as string]),
        )
      : ("0x" as Hex);
  return {
    address: p.address,
    topics: topics as Hex[],
    data,
    blockNumber: p.blockNumber ?? 100n,
    transactionHash: p.transactionHash ?? (`0x${"ab".repeat(32)}` as Hex),
    logIndex: p.logIndex ?? 0,
  };
}

export function entity(over: Partial<MonitoredEntity> = {}): MonitoredEntity {
  return {
    idempotencyKey: "key-1",
    publicId: "pub-1",
    name: "Acme Agent LLC",
    status: "funded",
    agentId: "881938",
    manager: ADDR.controller,
    guardian: ADDR.guardian,
    operator: ADDR.operator,
    treasury: ADDR.treasury,
    proxy: "0x8888888888888888888888888888888888888888",
    ...over,
  };
}

export function ruleContext(over: Partial<RuleContext> = {}): RuleContext {
  return {
    controller: ADDR.controller,
    registry: ADDR.registry,
    factories: new Set([ADDR.factory.toLowerCase(), ADDR.legacyFactory.toLowerCase()]),
    beacons: new Set([ADDR.beacon.toLowerCase()]),
    executor: ADDR.executor,
    standingRoles: standingRoles(),
    entities: indexEntities([entity()]),
    ...over,
  };
}

/** Rule deps with a frozen clock and a stubbed payout read. */
export function ruleDeps(over: { now?: number; payout?: Address | undefined } = {}) {
  return {
    now: () => over.now ?? 1_700_000_000_000,
    currentPayout: async () => over.payout,
  };
}
