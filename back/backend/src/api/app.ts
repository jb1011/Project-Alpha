import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AuthVars } from "../auth/middleware";
import { requireAuth } from "../auth/middleware";
import { mountMcpRoute } from "../mcp/transport";
import { apiOnError } from "./errors";
import { mountApiKeyRoutes } from "./routes/apiKeys";
import { mountAuthRoutes } from "./routes/auth";
import { mountConnectionRoutes } from "./routes/connection";
import { mountEnsGatewayRoutes } from "./routes/ensGateway";
import { mountJobRoutes } from "./routes/jobs";
import { mountMetadataRoutes } from "./routes/metadata";
import { mountProtectedRoutes } from "./routes/onboard";
import { mountPasskeyRoutes } from "./routes/passkey";
import { mountPerTxCapRoutes } from "./routes/perTxCap";
import { mountPolicyRoutes } from "./routes/policy";
import { mountReputationRoutes } from "./routes/reputation";
import { mountRunsRoutes } from "./routes/runs";
import { mountSchemaRoutes } from "./routes/schema";
import { mountTransparencyRoutes } from "./routes/transparency";
import { mountTreasuryRoutes } from "./routes/treasury";
import { mountTrustPolicyRoutes } from "./routes/trustPolicy";
import { mountWorldIdRoutes } from "./routes/worldId";
import { mountX402DemoRoutes } from "./routes/x402Demo";

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
  /** Address the ENS apex resolves to, ALREADY checksum-normalized. REQUIRED so the resolution is
   *  decided in exactly one place (main.ts: ENS_APEX_RESOLVES_TO ?? the signing key) — a second
   *  fallback here defaulted to `platformManagerAddress`, which in controller mode is the
   *  CONTROLLER CONTRACT: the exact address the NoviController design (§5) says the apex must never
   *  inherit by accident. Normalizing here (once) keeps it off the gateway's per-request path. */
  ensApexAddress: string;
  /** Injectable clock (ms) for tests; defaults to Date.now. */
  now?: () => number;
  repo: import("../persistence/entityRepository").EntityRepository;
  docStore: import("../persistence/documentStore").DocumentStore;
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
  /** Tier-0 custody: the platform default for new agents ("turnkey" until P4) + whether circle
   *  provisioning is configured on this deployment (credentials + wallet set). The /onboard
   *  route and the MCP onboard_agent tool refuse a circle request when unavailable. */
  walletProviderDefault: "turnkey" | "circle";
  circleCustodyAvailable: boolean;
  /** Mirror flag for turnkey: false on deployments (e.g. mainnet) that ship no Turnkey config. */
  turnkeyCustodyAvailable: boolean;
  /** doola formation (design §2). All three are OPTIONAL so every existing caller — and every
   *  credential-less deployment — builds unchanged; absent reads as "no formation on this box".
   *  `formationEnvironment` is REQUIRED-when-available by the honesty invariant: a sandbox
   *  formation must never be renderable as a real one. */
  formationAvailable?: boolean;
  formationRequired?: boolean;
  formationEnvironment?: "sandbox" | "production" | null;
  linkCodes: import("../persistence/linkCodeStore").LinkCodeStore;
  /** Per-entity payment service (status/pay), used by the MCP treasury_status/pay tools. Optional
   *  so deployments without POCKET_MASTER_SEED configured still build; the tools then return
   *  "payments unavailable" instead of throwing. */
  payments?: import("../payments/entityPayment").EntityPaymentService;
  /** Explicit treasury->pocket Gateway top-up (fund_pocket tool/route). Optional for the same
   *  reason as `payments`: deployments without POCKET_MASTER_SEED/Turnkey configured still build,
   *  and the tool/route then report "unavailable" instead of throwing. */
  pocketFunding?: import("../payments/pocketFunding").PocketFundingFn;
  /** Optional flag-gated x402 demo seller (Leg 3 smoke target). Present only when
   *  ENABLE_X402_DEMO is set; absent -> route not mounted (404). */
  x402Demo?: import("./routes/x402Demo").X402DemoDeps;
  /** Optional ENS CCIP-Read gateway (serves `*.<parent>.eth` records). Present only when
   *  ENS_GATEWAY_SIGNER_KEY is set; absent -> route not mounted (404). */
  ens?: import("./routes/ensGateway").EnsGatewayDeps;
  /** Optional World ID guardian gate (proof-of-personhood). Present only when the WORLD_*
   *  portal credentials are set; absent -> routes not mounted and onboarding is ungated. */
  worldId?: import("./routes/worldId").WorldIdDeps;
  /** S2 standing-float-ceiling reads for GET /entities/:id/treasury (dashboard). `read` is the same
   *  wiring as entityPayment.status()'s `standing` (payments/standingExposure.ts#buildReadExposure);
   *  `ceilingAtomic` is the configured MAX_POCKET_FLOAT_USDC, atomic USDC string. Optional for the
   *  same reason as `payments`: absent when POCKET_MASTER_SEED isn't configured, in which case the
   *  route reports zeroed standing. */
  standingExposure?: {
    read: (
      entity: import("../types").EntityRecord,
    ) => Promise<import("../payments/standingExposure").StandingExposure>;
    ceilingAtomic: string;
  };
}

/** Build the wizard REST API app: CORS + error envelope + /healthz. Routes mounted by later tasks. */
export function buildApiApp(deps: ApiDeps) {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use(
    "*",
    cors({
      origin: (_origin, c) =>
        c.req.path.startsWith("/metadata/") ||
        c.req.path.startsWith("/ensgateway") ||
        c.req.path === "/transparency"
          ? "*"
          : deps.webOrigin,
      allowHeaders: ["authorization", "content-type"],
    }),
  );
  app.onError(apiOnError);
  app.get("/healthz", (c) => c.json({ ok: true }));
  // Public deployment capabilities (Tier-0 P4). The wizard reads this BEFORE auth so it can
  // preselect the platform's custody default and refuse to offer an option this deployment
  // cannot serve — without it, a UI defaulting to `circle` would 400 at submit on every
  // credential-less deployment (local dev, contributors, self-hosts). Booleans only: no
  // secrets, no addresses, nothing a caller couldn't learn by attempting an onboard.
  app.get("/config", (c) =>
    c.json({
      walletProviderDefault: deps.walletProviderDefault,
      circleCustodyAvailable: deps.circleCustodyAvailable,
      turnkeyCustodyAvailable: deps.turnkeyCustodyAvailable,
      // Formation (design §2). Booleans + an enum, same discipline as the custody flags. The
      // environment is served so the wizard can label a sandbox filing amber ("Demo formation")
      // instead of green — the honesty invariant, enforced at the surface that renders it.
      formationAvailable: Boolean(deps.formationAvailable),
      formationRequired: Boolean(deps.formationRequired),
      formationEnvironment: deps.formationEnvironment ?? null,
    }),
  );
  mountSchemaRoutes(app);
  mountMetadataRoutes(app, deps);
  mountTransparencyRoutes(app, deps);
  mountEnsGatewayRoutes(app, deps);
  if (deps.x402Demo) mountX402DemoRoutes(app, deps.x402Demo);
  mountAuthRoutes(app, deps);
  mountPasskeyRoutes(app, deps);
  app.use("/onboard", requireAuth(deps.jwtSecret));
  app.use("/entities", requireAuth(deps.jwtSecret));
  app.use("/entities/*", requireAuth(deps.jwtSecret));
  app.use("/jobs/*", requireAuth(deps.jwtSecret));
  app.use("/api-keys", requireAuth(deps.jwtSecret));
  app.use("/api-keys/*", requireAuth(deps.jwtSecret));
  app.use("/connection-package", requireAuth(deps.jwtSecret));
  app.use("/bootstrap-connection", requireAuth(deps.jwtSecret));
  mountWorldIdRoutes(app, deps); // routes carry their own requireAuth (like /passkey)
  mountApiKeyRoutes(app, deps);
  mountConnectionRoutes(app, deps);
  mountProtectedRoutes(app, deps);
  mountTreasuryRoutes(app, deps);
  mountPolicyRoutes(app, deps);
  mountPerTxCapRoutes(app, deps);
  mountTrustPolicyRoutes(app, deps);
  mountRunsRoutes(app, deps);
  mountJobRoutes(app, deps);
  mountReputationRoutes(app, deps);
  mountMcpRoute(app, deps);
  return app;
}
