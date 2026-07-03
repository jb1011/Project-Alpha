import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AuthVars } from "../auth/middleware";
import { requireAuth } from "../auth/middleware";
import { mountMcpRoute } from "../mcp/transport";
import { apiOnError } from "./errors";
import { mountApiKeyRoutes } from "./routes/apiKeys";
import { mountAuthRoutes } from "./routes/auth";
import { mountConnectionRoutes } from "./routes/connection";
import { mountJobRoutes } from "./routes/jobs";
import { mountProtectedRoutes } from "./routes/onboard";
import { mountPasskeyRoutes } from "./routes/passkey";
import { mountPerTxCapRoutes } from "./routes/perTxCap";
import { mountPolicyRoutes } from "./routes/policy";
import { mountReputationRoutes } from "./routes/reputation";
import { mountRunsRoutes } from "./routes/runs";
import { mountSchemaRoutes } from "./routes/schema";
import { mountTreasuryRoutes } from "./routes/treasury";

/** Dependencies for the REST API. Extended by later tasks (auth/onboard routes). */
export interface ApiDeps {
  webOrigin: string;
  nonceStore: import("../auth/nonceStore").NonceStore;
  siweDomain: string;
  chainId: number;
  jwtSecret: string;
  jwtTtlSec: number;
  /** Audit fix C: the platform/manager account address (Factory owner + setAgentWallet caller,
   *  see `managerAccount`). Force-set into `roles.manager` on onboarding so an agent-first caller
   *  never needs to know or guess it — a wrong guess would burn the entity name on bind failure. */
  platformManagerAddress: string;
  /** Injectable clock (ms) for tests; defaults to Date.now. */
  now?: () => number;
  repo: import("../persistence/entityRepository").EntityRepository;
  runner: import("../workflow/runner").OnboardingRunner;
  passkeyRpId: string;
  apiKeys: import("../persistence/apiKeyStore").ApiKeyStore;
  passkeys: import("../persistence/passkeyStore").PasskeyStore;
  challenges: import("../persistence/challengeStore").ChallengeStore;
  jobs: import("../jobs/jobRepository").JobRepository;
  jobRunner: import("../jobs/jobRunner").JobRunner;
  jobClientAddress: string;
  jobEvaluatorAddress: string;
  /** Audit fix A: caps on run_job to stop an earn-capability agent from draining the platform's
   *  job-funding wallet via a loop of large-budget or many-in-flight jobs. */
  maxJobBudget: bigint;
  maxInflightJobsPerTenant: number;
  arc: import("../adapters/arc/arcAdapter").ArcAdapter;
  agentRuns: import("../persistence/agentRunStore").AgentRunStore;
  mcpPublicUrl: string;
  /** Per-entity payment service (status/pay), used by the MCP treasury_status/pay tools. Optional
   *  so deployments without POCKET_MASTER_SEED configured still build; the tools then return
   *  "payments unavailable" instead of throwing. */
  payments?: import("../payments/entityPayment").EntityPaymentService;
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
  app.use("/connection-package", requireAuth(deps.jwtSecret));
  mountApiKeyRoutes(app, deps);
  mountConnectionRoutes(app, deps);
  mountProtectedRoutes(app, deps);
  mountTreasuryRoutes(app, deps);
  mountPolicyRoutes(app, deps);
  mountPerTxCapRoutes(app, deps);
  mountRunsRoutes(app, deps);
  mountJobRoutes(app, deps);
  mountReputationRoutes(app, deps);
  mountMcpRoute(app, deps);
  return app;
}
