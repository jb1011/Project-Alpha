import type { ApiKeyStore, VerifiedKey } from "../persistence/apiKeyStore";

/** Resolve a `Authorization: Bearer <mcp key>` header to a tenantId, or null if absent/invalid. */
export function resolveTenant(authHeader: string | undefined, apiKeys: ApiKeyStore): string | null {
  const [scheme, token] = (authHeader ?? "").split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return apiKeys.verify(token)?.tenantId ?? null;
}

/** Resolve `Authorization: Bearer <mcp key>` to the full verified key scope, or null. */
export function resolveKey(
  authHeader: string | undefined,
  apiKeys: ApiKeyStore,
): VerifiedKey | null {
  const [scheme, token] = (authHeader ?? "").split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return apiKeys.verify(token) ?? null;
}
