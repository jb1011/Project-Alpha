import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AuthVars } from "../auth/middleware";
import { requireAuth } from "../auth/middleware";
import { apiOnError } from "./errors";
import { mountApiKeyRoutes } from "./routes/apiKeys";
import { mountAuthRoutes } from "./routes/auth";
import { mountJobRoutes } from "./routes/jobs";
import { mountProtectedRoutes } from "./routes/onboard";
import { mountPasskeyRoutes } from "./routes/passkey";
import { mountSchemaRoutes } from "./routes/schema";

/** Dependencies for the REST API. Extended by later tasks (auth/onboard routes). */
export interface ApiDeps {
  webOrigin: string;
  nonceStore: import("../auth/nonceStore").NonceStore;
  siweDomain: string;
  chainId: number;
  jwtSecret: string;
  jwtTtlSec: number;
  /** Injectable clock (ms) for tests; defaults to Date.now. */
  now?: () => number;
  repo: import("../persistence/entityRepository").EntityRepository;
  runner: import("../workflow/runner").OnboardingRunner;
  passkeyRpId: string;
  apiKeys: import("../persistence/apiKeyStore").ApiKeyStore;
  passkeys: import("../persistence/passkeyStore").PasskeyStore;
  jobs: import("../jobs/jobRepository").JobRepository;
  jobRunner: import("../jobs/jobRunner").JobRunner;
  jobClientAddress: string;
  jobEvaluatorAddress: string;
}

/** Build the wizard REST API app: CORS + error envelope + /healthz. Routes mounted by later tasks. */
export function buildApiApp(deps: ApiDeps) {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", cors({ origin: deps.webOrigin, allowHeaders: ["authorization", "content-type"] }));
  app.onError(apiOnError);
  app.get("/healthz", (c) => c.json({ ok: true }));
  mountSchemaRoutes(app);
  mountAuthRoutes(app, deps);
  mountPasskeyRoutes(app, deps);
  app.use("/onboard", requireAuth(deps.jwtSecret));
  app.use("/entities", requireAuth(deps.jwtSecret));
  app.use("/entities/*", requireAuth(deps.jwtSecret));
  app.use("/jobs/*", requireAuth(deps.jwtSecret));
  app.use("/api-keys", requireAuth(deps.jwtSecret));
  app.use("/api-keys/*", requireAuth(deps.jwtSecret));
  mountApiKeyRoutes(app, deps);
  mountProtectedRoutes(app, deps);
  mountJobRoutes(app, deps);
  return app;
}
