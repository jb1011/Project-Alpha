export const apiKeys = {
  all: ["api"] as const,
  publicConfig: () => [...apiKeys.all, "publicConfig"] as const,
  agentSchema: () => [...apiKeys.all, "agentSchema"] as const,
  entities: (token: string) => [...apiKeys.all, "entities", token] as const,
  entity: (token: string, id: string) => [...apiKeys.all, "entity", token, id] as const,
  entityTreasury: (token: string, id: string) =>
    [...apiKeys.all, "entityTreasury", token, id] as const,
  entityRuns: (token: string, id: string) => [...apiKeys.all, "entityRuns", token, id] as const,
  entityReputation: (token: string, id: string) =>
    [...apiKeys.all, "entityReputation", token, id] as const,
  entityJobs: (token: string, id: string) => [...apiKeys.all, "entityJobs", token, id] as const,
  entityAgentBook: (token: string, id: string) =>
    [...apiKeys.all, "entityAgentBook", token, id] as const,
  apiKeys: (token: string) => [...apiKeys.all, "apiKeys", token] as const,
  passkeys: (token: string) => [...apiKeys.all, "passkeys", token] as const,
  worldIdMe: (token: string) => [...apiKeys.all, "worldIdMe", token] as const,
  /* COMPANIES (design §7). Token-scoped like every other authenticated key, so a sign-out cannot
   * leave one tenant's legal bodies in another's cache. */
  companies: (token: string) => [...apiKeys.all, "companies", token] as const,
  company: (token: string, id: string) => [...apiKeys.all, "company", token, id] as const,
  companyCompliance: (token: string, id: string) =>
    [...apiKeys.all, "companyCompliance", token, id] as const,
  /** PUBLIC and token-free: build-time rules that are the same for everybody. */
  formationRules: () => [...apiKeys.all, "formationRules"] as const,
};
