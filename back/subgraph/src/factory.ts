import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  EntityCreated,
  TreasuryCreated,
} from "../generated/LegalManagerFactory/LegalManagerFactory";
import { AgentEntity } from "../generated/schema";

/** Load-or-create by agentId. EntityCreated and TreasuryCreated arrive in the same tx, so both
 *  handlers upsert the same row (order-independent). */
function loadOrCreate(agentId: string, timestamp: i64, block: i64, tx: Bytes): AgentEntity {
  let e = AgentEntity.load(agentId);
  if (e == null) {
    e = new AgentEntity(agentId);
    e.createdAt = BigInt.fromI64(timestamp);
    e.createdAtBlock = BigInt.fromI64(block);
    e.createdTx = tx;
  }
  return e as AgentEntity;
}

export function handleEntityCreated(event: EntityCreated): void {
  const e = loadOrCreate(
    event.params.agentId.toString(),
    event.block.timestamp.toI64(),
    event.block.number.toI64(),
    event.transaction.hash,
  );
  e.proxy = event.params.proxy;
  e.manager = event.params.manager;
  e.save();
}

export function handleTreasuryCreated(event: TreasuryCreated): void {
  const e = loadOrCreate(
    event.params.agentId.toString(),
    event.block.timestamp.toI64(),
    event.block.number.toI64(),
    event.transaction.hash,
  );
  e.treasury = event.params.treasury;
  e.operator = event.params.operator;
  e.save();
}
