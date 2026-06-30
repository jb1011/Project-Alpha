import type { AgentConfig, OnboardingSession, Phase } from "@/components/onboarding/types";

export const ONBOARDING_STORAGE_KEY = "pa-onboarding-v2";

export type PersistedOnboarding = {
  phase: Phase;
  config: AgentConfig;
  done: Record<string, boolean>;
  session: OnboardingSession;
};

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
