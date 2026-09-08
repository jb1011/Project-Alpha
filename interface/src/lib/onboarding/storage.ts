import type { AgentConfig, OnboardingSession, Phase } from "@/components/onboarding/types";

/**
 * The storage key, BUMPED for A3 (design §7).
 *
 * The v2 shape is not readable as v3: its phase vocabulary contains `legal-identity`, a screen
 * that no longer exists, and its session carries `partyId`/`partySynthetic`, two fields the
 * onboard door now REFUSES rather than ignores. Re-using the key would have made every returning
 * user's blob a silent liar — a wizard resuming on a phantom step, or carrying a party handle to
 * a submit that refuses it two screens later.
 *
 * The old key is still READ, once, by `migrateOnboardingV2`. Bumping without a migration would
 * have been the same bug wearing a different hat: everybody mid-onboarding loses their place.
 */
export const ONBOARDING_STORAGE_KEY = "pa-onboarding-v3";

/** The key A2 and everything before it wrote. Read once, migrated, and then removed. */
export const ONBOARDING_STORAGE_KEY_V2 = "pa-onboarding-v2";

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
 * slice (`FormationParty`) is not on either list and must never be added — and since A2 that
 * slice can carry a SOCIAL SECURITY NUMBER, which is the single worst field in this codebase to
 * get wrong. What survives a reload is the opaque `companyId` the backend issued: it identifies a
 * filing, not a person.
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
 * one.
 *
 * `companyId` is opaque — it identifies a filing, not a person — and it REPLACES `partyId` and
 * `partySynthetic`, both retired with A1's shim (§7, A3). The party handle is no longer an
 * onboard concept, and "is this a demo?" is no longer wizard state at all: it is read from the
 * COMPANY ROW, whose pin is stamped at creation and immutable after.
 */
export const PERSISTED_SESSION_KEYS = [
  "entityId",
  "idempotencyKey",
  "entity",
  "companyId",
] as const satisfies readonly (keyof OnboardingSession)[];

export type PersistedOnboarding = {
  phase: Phase;
  config: Pick<AgentConfig, (typeof PERSISTED_CONFIG_KEYS)[number]>;
  done: Record<string, boolean>;
  session: Pick<OnboardingSession, (typeof PERSISTED_SESSION_KEYS)[number]>;
  /**
   * This blob came from v2 carrying a PARTY HANDLE and no company (§7, A3).
   *
   * A one-time fact about a RESTORE, not durable state, which is why it is at the top level
   * rather than in `session` (the PII allowlist) and why `buildPersistedOnboarding` never writes
   * it: the first save after the restore drops it. The flow reads it once, to decide whether a
   * resumed session has to pick a company before it can go on — see `resumePhase`.
   */
  resumeNeedsCompany?: boolean;
};

/** The v2 blob, in the shape it was actually written. */
type PersistedOnboardingV2 = {
  phase?: string;
  config?: Record<string, unknown>;
  done?: Record<string, boolean>;
  session?: Record<string, unknown>;
};

/**
 * v2 → v3, explicitly (design §7, A3).
 *
 * Three things changed under a returning user, and every one of them is silent if nobody
 * translates:
 *
 *  1. the phase `legal-identity` became `legal-body`. Left alone it is not on `PHASES` at all, so
 *     `snapToVisiblePhase` treats it as corrupt storage and drops the user back to `welcome` —
 *     losing a completed passkey ceremony and an accountable-human step;
 *  2. `done["legal-identity"]` is a claim about a step that no longer exists. It is DROPPED
 *     rather than renamed: what that step produced was a party handle, and a party handle is no
 *     longer what "the legal body is settled" means. Mapping it to `done["legal-body"]` would
 *     have let the Stepper jump a user forward past a company they never picked;
 *  3. `partyId`/`partySynthetic` are gone from the allowlist, and the onboard door REFUSES a
 *     `partyId` rather than ignoring it. They are dropped here, and a session that carried a
 *     party but no company is flagged so the flow can send it back to `legal-body` — which is
 *     the honest state: the identity is registered on the backend, nothing was filed with it,
 *     and the wizard's next question is which company.
 *
 * Anything unreadable returns null, exactly as a corrupt v3 blob does: a wizard that starts over
 * is recoverable, and one that resumes from half-parsed state is not.
 */
export function migrateOnboardingV2(raw: string): PersistedOnboarding | null {
  let blob: PersistedOnboardingV2;
  try {
    blob = JSON.parse(raw) as PersistedOnboardingV2;
  } catch {
    return null;
  }
  if (!blob || typeof blob !== "object") return null;

  const session = (blob.session ?? {}) as Record<string, unknown>;
  const companyId = typeof session.companyId === "string" ? session.companyId : null;
  const hadParty = typeof session.partyId === "string" && session.partyId.length > 0;

  const { "legal-identity": _retired, ...done } = blob.done ?? {};
  const phase = blob.phase === "legal-identity" ? "legal-body" : (blob.phase as Phase | undefined);

  return {
    phase: phase ?? "welcome",
    // The config allowlist is unchanged between the two versions, so the same `pick` applies —
    // and it is a pick rather than a spread, so a v2 field that is no longer allowlisted is
    // dropped here as well.
    config: pick(
      { ...emptyPersistedConfig(), ...(blob.config as Partial<AgentConfig> | undefined) },
      PERSISTED_CONFIG_KEYS,
    ),
    done,
    session: {
      entityId: typeof session.entityId === "string" ? session.entityId : null,
      idempotencyKey:
        typeof session.idempotencyKey === "string" ? session.idempotencyKey : null,
      entity: (session.entity as PersistedOnboarding["session"]["entity"]) ?? null,
      companyId,
    },
    // Only when there is actually something to correct: a party was registered and no company
    // ever came of it. A blob that already has a company is complete in v3 terms.
    ...(hadParty && !companyId ? { resumeNeedsCompany: true } : {}),
  };
}

/** The persisted-config defaults, so a v2 blob missing a field migrates to a value rather than
 *  to `undefined` — which would reach an input as an uncontrolled-component warning. */
function emptyPersistedConfig(): Pick<AgentConfig, (typeof PERSISTED_CONFIG_KEYS)[number]> {
  return {
    name: "",
    purpose: "",
    configMode: "manual",
    custody: "circle",
    perTxCap: "",
    dailyCap: "",
    allowlist: [],
    timelockHours: "24",
    spendingPeriodHours: "24",
  };
}

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
      // No v3 blob — but there may be a v2 one, written by a user who was mid-onboarding when
      // this shipped. Migrated, never parsed as if it were v3. The old key is left in place: this
      // function runs on every render through `useSyncExternalStore`, and a write here would be a
      // side effect in a snapshot reader (React calls it during render, and calls it twice in
      // StrictMode). The first v3 save is what supersedes it.
      const legacy = window.localStorage.getItem(ONBOARDING_STORAGE_KEY_V2);
      cached = legacy ? migrateOnboardingV2(legacy) : null;
      return cached;
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
    // …and the v2 key with it, or "Start over" would leave the migration to resurrect the very
    // session the user just discarded.
    window.localStorage.removeItem(ONBOARDING_STORAGE_KEY_V2);
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
