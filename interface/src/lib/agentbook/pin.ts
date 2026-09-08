/**
 * Trust-on-first-use pin of an agent's payment address in this browser (design v3 D8).
 *
 * It cannot catch a backend that lied from the start; it does catch a backend that starts lying
 * later — which is the whole confused-deputy shape D8 narrows, because a vouch binds a HUMAN to
 * whatever address the dialog was handed.
 *
 * Every access is wrapped: `localStorage` throws outright in some privacy modes, and is absent
 * entirely outside a browser (this module is imported by a client component that Next also
 * type-checks on the server). An unavailable store means "no pin" — never "changed", which would
 * block a legitimate vouch on a browser setting.
 */
export type PinResult = "pinned" | "match" | "changed" | "unavailable";

const key = (entityId: string) => `novi.agentbook.pocket.${entityId}`;

/** The store, or null when there is none we can use. Never throws. */
function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The address this browser first saw for `entityId`, lowercased; null when there is none. */
export function readPin(entityId: string): string | null {
  try {
    return store()?.getItem(key(entityId)) ?? null;
  } catch {
    return null;
  }
}

/** Pin `address` for `entityId`. Returns false when the store refused it. */
export function writePin(entityId: string, address: string): boolean {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(key(entityId), address.toLowerCase());
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare an address against the pin, pinning it on first sight.
 *
 * `"changed"` is the only answer the caller must refuse to proceed on.
 */
export function checkPin(entityId: string, address: string): PinResult {
  const s = store();
  if (!s) return "unavailable";
  let seen: string | null;
  try {
    seen = s.getItem(key(entityId));
  } catch {
    return "unavailable";
  }
  const now = address.toLowerCase();
  if (!seen) return writePin(entityId, now) ? "pinned" : "unavailable";
  return seen === now ? "match" : "changed";
}
