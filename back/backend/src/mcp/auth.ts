import type { ApiKeyStore } from "../persistence/apiKeyStore";

/** Resolve a `Authorization: Bearer <mcp key>` header to a tenantId, or null if absent/invalid. */
export function resolveTenant(authHeader: string | undefined, apiKeys: ApiKeyStore): string | null {
  const [scheme, token] = (authHeader ?? "").split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return apiKeys.verify(token)?.tenantId ?? null;
}
