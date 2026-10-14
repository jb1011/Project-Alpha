import type { Address } from "@/lib/api/types";

/**
 * The legal-body flow's local memory: five opaque values per wallet, and nothing a person typed.
 *
 * The flow handles a company name, a filing number, a declarant's name and title, a statement,
 * the typed data behind it and a signature. None of that is written to a browser store. What
 * survives a reload is which wallet the memory belongs to, the backend's handles for the company
 * and the order, and the two draft-only choices; everything else is read back from the server.
 *
 * Persistence is an ALLOWLIST, and each value is checked against its shape on the way in and on
 * the way out: a field nobody thought about is not persisted, and a typed value put under an
 * allowed name fails its shape and is dropped. The memory is a hint, never the truth: a value that
 * fails reads null, and a memory that cannot be read or written is one the flow does without.
 *
 * The onboarding wizard's key (`pa-onboarding-v3`) is never read or written here.
 */
export const LEGAL_BODY_STORAGE_KEY = "pa-legal-body-v1";

/** The only names that reach the store. Adding one is the moment to ask whether it belongs there. */
export const PERSISTED_LEGAL_BODY_KEYS = [
  "tenant",
  "companyId",
  "orderId",
  "ownerChoice",
  "agentId",
] as const satisfies readonly (keyof LegalBodyMemory)[];

export type OwnerChoice = "this-wallet" | "elsewhere";

export type LegalBodyMemory = {
  /** The signed-in wallet the memory belongs to. */
  tenant: Address;
  companyId: string | null;
  orderId: string | null;
  /** Meaningful only while the order is a draft. */
  ownerChoice: OwnerChoice | null;
  /** The identity picked or registered, draft only. */
  agentId: string | null;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The backend's handles: opaque, short, and never a sentence. */
const HANDLE = /^[A-Za-z0-9_-]{1,80}$/;
/** A uint256 in decimal: no sign, no leading zero, at most 78 digits. */
const AGENT_ID = /^(?:0|[1-9][0-9]{0,77})$/;
const OWNER_CHOICES: readonly OwnerChoice[] = ["this-wallet", "elsewhere"];

function isAddress(value: unknown): value is Address {
  return typeof value === "string" && ADDRESS.test(value);
}

function matching(value: unknown, shape: RegExp): string | null {
  return typeof value === "string" && shape.test(value) ? value : null;
}

function ownerChoiceOf(value: unknown): OwnerChoice | null {
  return OWNER_CHOICES.find((choice) => choice === value) ?? null;
}

/** An own property only: nothing inherited is picked. */
function own(state: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : undefined;
}

/**
 * Picks the allowlist from any object, validates each value's shape, nulls what fails.
 *
 * The tenant cannot be nulled: a memory without a wallet belongs to nobody. A tenant that is not
 * an address throws, and `writeLegalBodyMemory` then stores nothing.
 */
export function buildLegalBodyMemory(
  state: { tenant: string } & Record<string, unknown>,
): LegalBodyMemory {
  const tenant = own(state, "tenant");
  if (!isAddress(tenant)) throw new TypeError("the memory's tenant is not an address");
  return {
    tenant,
    companyId: matching(own(state, "companyId"), HANDLE),
    orderId: matching(own(state, "orderId"), HANDLE),
    ownerChoice: ownerChoiceOf(own(state, "ownerChoice")),
    agentId: matching(own(state, "agentId"), AGENT_ID),
  };
}

/** The parsed memory, or null when the blob is missing, malformed, or belongs to another tenant. */
export function parseLegalBodyMemory(raw: string | null, tenant: Address): LegalBodyMemory | null {
  if (raw === null || !isAddress(tenant)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const blob = parsed as Record<string, unknown>;
  const stored = own(blob, "tenant");
  // Tenants compare in lower case: a session address and a served one may differ in checksum.
  if (!isAddress(stored) || stored.toLowerCase() !== tenant.toLowerCase()) return null;
  return buildLegalBodyMemory({ ...blob, tenant: stored });
}

/** The store, or null when there is none to use: on the server, or where reaching it throws. */
function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The memory of this tenant, or null on the server, on any throw, or when there is none. */
export function readLegalBodyMemory(tenant: Address): LegalBodyMemory | null {
  try {
    const s = store();
    return s ? parseLegalBodyMemory(s.getItem(LEGAL_BODY_STORAGE_KEY), tenant) : null;
  } catch {
    return null;
  }
}

/** Stores the JSON of `buildLegalBodyMemory(memory)`. Never throws: a refused write is forgotten. */
export function writeLegalBodyMemory(memory: LegalBodyMemory): void {
  try {
    const bytes = JSON.stringify(buildLegalBodyMemory(memory));
    store()?.setItem(LEGAL_BODY_STORAGE_KEY, bytes);
  } catch {
    // A store that refuses the write, or a tenant that is not an address: nothing is remembered.
  }
}

/** Forgets the memory. Never throws. */
export function clearLegalBodyMemory(): void {
  try {
    store()?.removeItem(LEGAL_BODY_STORAGE_KEY);
  } catch {
    // Nothing to forget where there is no store.
  }
}
