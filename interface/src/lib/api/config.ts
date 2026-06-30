export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/backend";

export const MCP_URL = process.env.NEXT_PUBLIC_MCP_URL ?? "/backend/mcp";

export const SIWE_DOMAIN = process.env.NEXT_PUBLIC_SIWE_DOMAIN ?? "localhost";

export const MANAGER_ADDRESS =
  process.env.NEXT_PUBLIC_MANAGER_ADDRESS ??
  "0xbE497D6E00dedE6892Dcb99271af4DeA98c58a9e";

const AUTH_STORAGE_KEY = "pa-auth-session";
export const AUTH_SESSION_EVENT = "pa-auth-session-change";

export function notifyAuthSessionChange() {
  invalidateAuthSessionCache();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AUTH_SESSION_EVENT));
  }
}

type StoredAuthSession = {
  token: string;
  address: `0x${string}`;
  expiresAt: number;
};

let cachedAuthSessionRaw: string | null | undefined;
let cachedAuthSession: StoredAuthSession | null = null;

function parseAuthSession(raw: string | null): StoredAuthSession | null {
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as StoredAuthSession;
    if (session.expiresAt * 1000 <= Date.now()) {
      sessionStorage.removeItem(AUTH_STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function invalidateAuthSessionCache() {
  cachedAuthSessionRaw = undefined;
}

/** Stable snapshot for useSyncExternalStore — returns the same object until storage changes. */
export function getAuthSessionSnapshot(): StoredAuthSession | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(AUTH_STORAGE_KEY);
  if (raw === cachedAuthSessionRaw) return cachedAuthSession;
  cachedAuthSessionRaw = raw;
  cachedAuthSession = parseAuthSession(raw);
  return cachedAuthSession;
}

export function loadAuthSession() {
  if (typeof window === "undefined") return null;
  return getAuthSessionSnapshot();
}

export function saveAuthSession(session: {
  token: string;
  address: `0x${string}`;
  expiresAt: number;
}) {
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  notifyAuthSessionChange();
}

export function clearAuthSession() {
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  notifyAuthSessionChange();
}
