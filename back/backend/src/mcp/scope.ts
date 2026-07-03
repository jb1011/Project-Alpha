import type { Capability } from "../persistence/apiKeyStore";

const LEVEL: Record<Capability, number> = { read: 0, earn: 1, spend: 2 };

/** A key's capability grants that action and all lower ones (read < earn < spend). */
export function hasCapability(scope: { capability: Capability }, needed: Capability): boolean {
  return LEVEL[scope.capability] >= LEVEL[needed];
}

/** A key scoped to a single entity (entityId != null) may operate ONLY that entity; a tenant-wide key
 *  (entityId == null) may operate any of its tenant's entities. Ownership is checked separately. */
export function entityInScope(scope: { entityId: string | null }, id: string): boolean {
  return scope.entityId === null || scope.entityId === id;
}
