import type { AgentConfig, OnboardingSession, Phase } from "@/components/onboarding/types";

export const ONBOARDING_STORAGE_KEY = "pa-onboarding-v2";

/* ------------------------------------------------------------------ */
/* THE PERSISTENCE ALLOWLIST (design §3, audit 16/L8)                  */
/* ------------------------------------------------------------------ */

/**
 * What is allowed OUT of memory and into localStorage — named field by field.
 *
 * This used to be a denylist: the whole wizard state was serialized and one field
 * (`guardianPasskey`) was nulled on the way. That shape is safe exactly as long as nobody adds a
 * field and forgets, and the field someone was about to add is the legal name, email, phone and
 * home address of a real person. A denylist fails OPEN — the forgotten field leaks. An allowlist
 * fails CLOSED: a new field is simply not persisted until somebody writes its name here, and
 * writing its name is the moment to ask whether it belongs in a browser store at all.
 *
 * The rule this encodes: **no personal data is ever written to localStorage.** The wizard's PII
 * slice (`FormationParty`) is not on either list and must never be added. What survives a reload
 * is the opaque `partyId` handle the backend issued — which identifies a row, not a person.
 */
export const PERSISTED_CONFIG_KEYS = [
  "name",
  "purpose",
  "configMode",
  "custody",
  "perTxCap",
  "dailyCap",
  "allowlist",
  "timelockHours",
  "spendingPeriodHours",
] as const satisfies readonly (keyof AgentConfig)[];

/**
 * `guardianPasskey` is absent by design and always has been: a passkey attestation is a
 * single-use credential, and a restored session re-does the ceremony rather than replay a stale
 * one. `partyId`/`partySynthetic` are opaque — a handle and a boolean.
 */
export const PERSISTED_SESSION_KEYS = [
  "entityId",
  "idempotencyKey",
  "entity",
  "partyId",
  "partySynthetic",
] as const satisfies readonly (keyof OnboardingSession)[];

export type PersistedOnboarding = {
  phase: Phase;
  config: Pick<AgentConfig, (typeof PERSISTED_CONFIG_KEYS)[number]>;
  done: Record<string, boolean>;
  session: Pick<OnboardingSession, (typeof PERSISTED_SESSION_KEYS)[number]>;
};

function pick<T extends object, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = source[key];
  return out;
}

/**
 * The ONE place wizard state becomes storable bytes.
 *
 * Callers hand over everything they have; only the allowlisted fields come back.
 */
export function buildPersistedOnboarding(state: {
  phase: Phase;
  config: AgentConfig;
  done: Record<string, boolean>;
  session: OnboardingSession;
}): PersistedOnboarding {
  const session = pick(state.session, PERSISTED_SESSION_KEYS);
  return {
    phase: state.phase,
    config: pick(state.config, PERSISTED_CONFIG_KEYS),
    done: state.done,
    session: {
      ...session,
      // The entity view carries no personal data by construction, but once formation lands it
      // does carry the owner-only EIN and the document index — neither of which a wizard needs to
      // resume, and both of which the dashboard fetches fresh. Dropped rather than stored.
      entity: session.entity ? { ...session.entity, formation: null } : null,
    },
  };
}

let cachedRaw: string | null | undefined;
let cached: PersistedOnboarding | null = null;

export function readPersistedOnboarding(): PersistedOnboarding | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY);
    if (raw === cachedRaw) return cached;
    cachedRaw = raw;
    if (!raw) {
      cached = null;
      return null;
    }
    cached = JSON.parse(raw) as PersistedOnboarding;
    return cached;
  } catch {
    cachedRaw = null;
    cached = null;
    return null;
  }
}

export function clearOnboardingStorage(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  cachedRaw = null;
  cached = null;
}

export function isOnboardingComplete(persisted: PersistedOnboarding | null): boolean {
  if (!persisted) return false;
  if (persisted.phase === "dashboard") return true;
  const status = persisted.session.entity?.status;
  return status === "funded" || status === "bound";
}
