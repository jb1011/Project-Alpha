import type { EntityStatus, EntityView } from "./types";
import { getEntity } from "./client";

const TERMINAL: EntityStatus[] = ["bound", "funded", "failed"];

export async function pollEntity(
  token: string,
  id: string,
  opts: {
    intervalMs?: number;
    onUpdate?: (entity: EntityView) => void;
    until?: EntityStatus[];
  } = {},
): Promise<EntityView> {
  const intervalMs = opts.intervalMs ?? 2500;
  const until = opts.until ?? TERMINAL;

  for (;;) {
    const entity = await getEntity(token, id);
    opts.onUpdate?.(entity);
    if (until.includes(entity.status)) return entity;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const DEPLOY_STATUS_ORDER: EntityStatus[] = [
  "pending",
  "provisioned",
  "translating",
  "created",
  "bound",
  "funded",
];

export function deployStepIndex(status: EntityStatus, entity?: EntityView): number {
  const map: Record<EntityStatus, number> = {
    pending: 0,
    provisioned: 1,
    translating: 2,
    created: 3,
    bound: 4,
    funded: 4,
    failed: -1,
  };
  if (status !== "failed") return map[status];

  if (!entity) return 0;
  if (entity.bindTxHash) return 4;
  if (entity.createTxHash || entity.agentId) return 3;
  if (entity.oaHash) return 2;
  if (entity.operator) return 1;
  return 0;
}
