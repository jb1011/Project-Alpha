import type { AuthorityDeps } from "./authority";
import { buildAuthorityApp } from "./server";

export interface AuthorityService {
  app: ReturnType<typeof buildAuthorityApp>;
}

/** Compose the Payment Authority from its deps. The real entrypoint (2E.2) builds live deps; tests inject fakes. */
export function buildAuthorityService(deps: AuthorityDeps): AuthorityService {
  return { app: buildAuthorityApp(deps) };
}
