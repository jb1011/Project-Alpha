import type { EntityRecord } from "../types";

/** Secret-free projection of an EntityRecord for API responses. */
export interface EntityView {
  id: string;
  name: string;
  status: EntityRecord["status"];
  agentId: string | null;
  proxy: string | null;
  treasury: string | null;
  operator: string | null;
  manager: string;
  guardian: string;
  oaHash: string | null;
  metadataURI: string | null;
  createTxHash: string | null;
  bindTxHash: string | null;
  fundTxHash: string | null;
  error: string | null;
}

export function toEntityView(r: EntityRecord): EntityView {
  return {
    id: r.idempotencyKey,
    name: r.name,
    status: r.status,
    agentId: r.agentId,
    proxy: r.proxy,
    treasury: r.treasury,
    operator: r.operator,
    manager: r.manager,
    guardian: r.guardian,
    oaHash: r.oaHash,
    metadataURI: r.metadataURI,
    createTxHash: r.createTxHash,
    bindTxHash: r.bindTxHash,
    fundTxHash: r.fundTxHash,
    error: r.error ?? null,
  };
}
