import { getAddress, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { usdToUnits } from "../policy/units";
import type { Address, Hex } from "../types";

const addressSchema = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), { message: "must be a 0x address" })
  .transform((s) => getAddress(s) as Address);

const privKeySchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, { message: "must be 0x + 64 hex chars" })
  .transform((s) => s as Hex);

const etherSchema = z.string().refine(
  (v) => {
    try {
      return parseEther(v) > 0n;
    } catch {
      return false;
    }
  },
  { message: "must be a positive decimal amount (e.g. 0.05)" },
);

const DEV_JWT_SECRET = "dev-insecure-secret-change-me-please";

/** Fallbacks for `Config.worldChain` (optional in the type for test fixtures). */
export const WORLD_CHAIN_DEFAULTS = {
  rpcUrl: "https://worldchain-mainnet.g.alchemy.com/public",
  agentBook: "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" as Address,
  allowancePerHuman: 3,
} as const;

const EnvSchema = z.object({
  ARC_TESTNET_RPC_URL: z.string().url(),
  ARC_CHAIN_ID: z.coerce.number().int().positive().default(5042002),
  PLATFORM_PRIVATE_KEY: privKeySchema,
  IDENTITY_REGISTRY: addressSchema.default("0x8004A818BFB912233c491871b3d84c89A494BD9e"),
  USDC_ADDRESS: addressSchema.default("0x3600000000000000000000000000000000000000"),
  FACTORY_ADDRESS: addressSchema.optional(),
  GUARDIAN_ADDRESS: addressSchema.optional(),
  OPERATOR_PRIVATE_KEY: privKeySchema.optional(),
  POCKET_MASTER_SEED: privKeySchema.optional(),
  DATA_DIR: z.string().default("./data"),
  TURNKEY_API_PUBLIC_KEY: z.string().optional(),
  TURNKEY_API_PRIVATE_KEY: z.string().optional(),
  TURNKEY_ORGANIZATION_ID: z.string().optional(),
  TURNKEY_SIGN_WITH: z.string().optional(), // operator key id or address to sign with
  TURNKEY_BASE_URL: z.string().url().default("https://api.turnkey.com"),
  TURNKEY_DELEGATED_API_PUBLIC_KEY: z.string().optional(),
  TURNKEY_DELEGATED_API_PRIVATE_KEY: z.string().optional(),
  FUNDING_FLOAT_USDC: z.string().default("0.50"),
  MAX_POCKET_FLOAT_USDC: z.string().default("1.00"),
  SPEND_ALLOWLIST_THRESHOLD_USDC: z.string().default("1"),
  MAX_JOB_BUDGET_USDC: z.string().default("5"),
  MAX_INFLIGHT_JOBS_PER_TENANT: z.coerce.number().int().positive().default(3),
  MAX_TREASURY_FUND_USDC: z.string().default("25"),
  MAX_TREASURY_FUNDED_PER_TENANT_USDC: z.string().default("100"),
  /** S5: aggregate platform-wallet outflow ceiling per rolling window, ALL paths (fund_treasury,
   *  gas seeds, job funding, operator CLI). Reject-don't-clamp. docs/design/2026-08-01-s5-*.md */
  PLATFORM_OUTFLOW_CEILING_USDC: z.string().default("200"),
  PLATFORM_OUTFLOW_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
  CUSTOMER_PRIVATE_KEY: privKeySchema.optional(),
  CIRCLE_API_KEY: z.string().optional(),
  /** Circle DevC entity secret (Tier-0). UNRECOVERABLE-BY-DESIGN without the recovery file —
   *  offline custody, >=2 locations, never on the VPS or in the repo. All-or-nothing with
   *  CIRCLE_API_KEY. docs/design/2026-08-03-tier0-circle-wallet-migration.md (Secrets & recovery). */
  CIRCLE_ENTITY_SECRET: z.string().optional(),
  /** The platform wallet set ("novi-tier0"). Required only when provisioning circle-path agents. */
  CIRCLE_WALLET_SET_ID: z.string().optional(),
  /** Tier-0: platform default custody for NEW agents when the caller doesn't choose. Per-call
   *  override: `custody` on /onboard + onboard_agent.
   *
   *  P4 (2026-08-07) flipped PROD to `circle` after P2+P3 proved the path live — but the SCHEMA
   *  default stays `turnkey` on purpose: a `circle` schema default would make the boot invariant
   *  below refuse to start every credential-less deployment (local dev, CI, contributors,
   *  self-hosts). The platform default is therefore an explicit prod .env setting, and any
   *  deployment without Circle credentials keeps working exactly as before.
   *  docs/design/2026-08-03-tier0-circle-wallet-migration.md. */
  WALLET_PROVIDER_DEFAULT: z.enum(["turnkey", "circle"]).default("turnkey"),
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().default("claude-sonnet-4-6"),
  GATEWAY_FACILITATOR_URL: z.string().url().default("https://gateway-api-testnet.circle.com"),
  AUTH_JWT_SECRET: z.string().min(16).default(DEV_JWT_SECRET),
  AUTH_JWT_TTL_SEC: z.coerce.number().int().positive().default(3600),
  WEB_ORIGIN: z.string().default("*"),
  SIWE_DOMAIN: z.string().default("localhost"),
  PASSKEY_RP_ID: z.string().default("localhost"),
  JOB_CONTRACT_ADDRESS: addressSchema.default("0x0747EEf0706327138c69792bF28Cd525089e4583"),
  REPUTATION_REGISTRY_ADDRESS: addressSchema.default("0x8004B663056A597Dffe9eCcC1965A193B7388713"),
  JOB_CLIENT_PRIVATE_KEY: privKeySchema.optional(),
  JOB_EVALUATOR_PRIVATE_KEY: privKeySchema.optional(),
  JOB_SWEEP_TO_TREASURY: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  MCP_PUBLIC_URL: z.string().default("http://localhost:8789/mcp"),
  METADATA_BASE_URL: z.string().url().default("http://localhost:8789"),
  GAS_SEED_FLOOR_USDC: etherSchema.default("0.05"),
  GAS_SEED_TARGET_USDC: etherSchema.default("0.2"),
  ENABLE_X402_DEMO: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  X402_DEMO_PAYTO: addressSchema.optional(),
  /** Seller trust policy. "open" = today's behavior (AgentKit authorizes within the allowance,
   *  everyone else pays). "accountable-only" = agents no verified human answers for are refused
   *  outright (403); human-backed agents still pay. */
  X402_TRUST_POLICY: z.enum(["open", "accountable-only"]).default("open"),
  /** Buyer-side trust dial: "verified-sellers-only" refuses to pay any address AgentBook does not
   *  vouch a human for. Default "open" = today's behavior. docs/design/2026-07-30-trust-policy-dials.md */
  X402_BUYER_TRUST_POLICY: z.enum(["open", "verified-sellers-only"]).default("open"),
  /** AgentBook-registered key for the /proof-run demo (signs AgentKit messages, holds no funds). */
  X402_PROOF_AGENT_KEY: privKeySchema.optional(),
  /** Window for the per-human rate cap. The raw counter is lifetime, which is not a rate. */
  WORLD_RATE_WINDOW_HOURS: z.coerce.number().int().positive().default(24),
  X402_DEMO_PRICE_USDC: z
    .string()
    .default("0.01")
    .refine(
      (v) => {
        try {
          const n = usdToUnits(v);
          return n > 0n && n <= 1_000_000n;
        } catch {
          return false;
        }
      },
      { message: "must be > 0 and <= 1.0 USDC (max 6 decimals)" },
    ),
  // ENS CCIP-Read gateway (optional; absent -> route not mounted). Signs record responses.
  ENS_GATEWAY_SIGNER_KEY: privKeySchema.optional(),
  ENS_PARENT_NAME: z.string().default("novicorpus.eth"),
  ENS_RESOLVER_ADDRESS: addressSchema.optional(),
  /** Vanity subnames, `label=publicId` comma-separated (e.g. "demo=b46fd15c-…"). Lets a memorable
   *  name point at an existing agent without rewriting a publicId that is already on-chain. */
  ENS_LABEL_ALIASES: z.string().optional(),
  // World ID / AgentKit (optional; absent -> routes not mounted, seller check skipped).
  WORLD_APP_ID: z.string().optional(),
  WORLD_RP_ID: z.string().optional(),
  WORLD_RP_SIGNING_KEY: z.string().optional(),
  WORLD_ACTION: z.string().default("guardian-verification"),
  /** Optional anti-sybil ceiling on legal entities per verified human. No legal basis — Wyoming
   *  does not cap how many LLCs a person may control — so it is UNSET (unlimited) by default and
   *  exists only for deployments that want one. */
  WORLD_MAX_ENTITIES_PER_HUMAN: z.coerce.number().int().positive().optional(),
  WORLD_REQUIRE_GUARDIAN: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  WORLD_CHAIN_RPC: z.string().url().default("https://worldchain-mainnet.g.alchemy.com/public"),
  WORLD_AGENTBOOK_ADDRESS: addressSchema.default("0xA23aB2712eA7BBa896930544C7d6636a96b944dA"),
  WORLD_ALLOWANCE_PER_HUMAN: z.coerce.number().int().nonnegative().default(3),
  WORLD_ENVIRONMENT: z.enum(["production", "staging", "sandbox"]).default("production"),
  /** Identity-Check step-up. Absent -> the whole attestation surface stays unmounted, so merging
   *  the feature is a no-op until this is deliberately set. */
  WORLD_ATTEST_ACTION: z.string().optional(),
  WORLD_ATTEST_MIN_AGE: z.coerce.number().int().positive().default(18),
});

export interface Config {
  rpcUrl: string;
  chainId: number;
  platformPrivateKey: Hex;
  identityRegistry: Address;
  usdc: Address;
  factoryAddress?: Address;
  guardianAddress?: Address;
  operatorPrivateKey?: Hex;
  pocketMasterSeed?: Hex;
  dataDir: string;
  dbPath: string;
  docStoreDir: string;
  turnkey?: {
    apiPublicKey: string;
    apiPrivateKey: string;
    organizationId: string;
    baseUrl: string;
    signWith: string;
    delegatedApiPublicKey?: string;
    delegatedApiPrivateKey?: string;
  };
  circleApiKey?: string;
  /** Tier-0 Circle DevC credentials; present only when BOTH env vars are set (all-or-nothing). */
  circle?: { apiKey: string; entitySecret: string; walletSetId?: string };
  /** Tier-0: default custody for NEW agents (`turnkey` until P4 flips it). */
  walletProviderDefault: "turnkey" | "circle";
  anthropicApiKey?: string;
  agentModel: string;
  gatewayFacilitatorUrl: string;
  fundingFloatUsdc: string;
  maxPocketFloatUsdc: string;
  spendAllowlistThreshold: bigint;
  maxJobBudget: bigint;
  maxInflightJobsPerTenant: number;
  maxTreasuryFund: bigint;
  maxTreasuryFundedPerTenant: bigint;
  platformOutflowCeiling: bigint;
  platformOutflowWindowMs: number;
  customerPrivateKey: Hex;
  authJwtSecret: string;
  authJwtTtlSec: number;
  webOrigin: string;
  siweDomain: string;
  passkeyRpId: string;
  jobContract: Address;
  reputationRegistry: Address;
  jobClientPrivateKey: Hex;
  jobEvaluatorPrivateKey?: Hex;
  jobSweepToTreasury: boolean;
  mcpPublicUrl: string;
  metadataBaseUrl: string;
  gasSeedFloorUsdc: string;
  gasSeedTargetUsdc: string;
  enableX402Demo: boolean;
  x402DemoPayTo: Address;
  x402DemoPriceUsdc: string;
  /** Optional in the type (test fixtures build Config literals); loadConfig always sets them. */
  x402TrustPolicy?: "open" | "accountable-only";
  x402BuyerTrustPolicy: "open" | "verified-sellers-only";
  worldRateWindowHours?: number;
  x402ProofAgentKey?: Hex;
  ens?: {
    signerKey: Hex;
    parentName: string;
    resolverAddress?: Address;
    /** Vanity subname label -> publicId. */
    labelAliases?: Record<string, string>;
  };
  /** World ID + AgentKit. Present only when the portal credentials are configured. */
  world?: {
    appId: string;
    rpId: string;
    rpSigningKey: string;
    action: string;
    /** Absent = no ceiling. */
    maxEntitiesPerHuman?: number;
    requireGuardian: boolean;
    environment: "production" | "staging" | "sandbox";
    /** Identity-Check step-up action. Absent = attestation surface not mounted. */
    attestAction?: string;
    /** Age threshold proven by the attestation (never a birthdate). */
    attestMinAge: number;
  };
  /** AgentBook read config — independent of `world` so the seller check can run standalone.
   *  Optional in the type (test fixtures build Config literals); loadConfig always populates it,
   *  and consumers should fall back to WORLD_CHAIN_DEFAULTS when absent. */
  worldChain?: {
    rpcUrl: string;
    agentBook: Address;
    allowancePerHuman: number;
  };
}

/** Validate + shape env into Config. Throws a readable error on the first invalid field. */
/** "demo=abc,staging=def" -> { demo: "abc", staging: "def" }. Malformed pairs are ignored. */
function parseLabelAliases(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [label, publicId] = pair.split("=").map((s) => s.trim());
    if (label && publicId) out[label.toLowerCase()] = publicId;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The one definition of "this deployment can provision Turnkey vaults": core turnkey config plus
 *  the delegated keypair (buildTurnkeyProvisionDeps throws without it). Used by the prod boot
 *  invariant below and by api/main.ts to derive `turnkeyCustodyAvailable` — one predicate, so the
 *  boot gate and the advertised availability can never drift apart. Note core-without-delegated is
 *  a legitimate shape (legacy shared-operator signing works; per-agent vault provisioning doesn't). */
export function canProvisionTurnkey(cfg: Pick<Config, "turnkey">): boolean {
  return Boolean(cfg.turnkey?.delegatedApiPublicKey && cfg.turnkey?.delegatedApiPrivateKey);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") ?? "unknown";
    const msg = first?.message ?? "validation failed";
    throw new Error(`Invalid config: ${path} — ${msg}`);
  }
  const e = parsed.data;
  const turnkey =
    e.TURNKEY_API_PUBLIC_KEY &&
    e.TURNKEY_API_PRIVATE_KEY &&
    e.TURNKEY_ORGANIZATION_ID &&
    e.TURNKEY_SIGN_WITH
      ? {
          apiPublicKey: e.TURNKEY_API_PUBLIC_KEY,
          apiPrivateKey: e.TURNKEY_API_PRIVATE_KEY,
          organizationId: e.TURNKEY_ORGANIZATION_ID,
          baseUrl: e.TURNKEY_BASE_URL,
          signWith: e.TURNKEY_SIGN_WITH,
          delegatedApiPublicKey: e.TURNKEY_DELEGATED_API_PUBLIC_KEY,
          delegatedApiPrivateKey: e.TURNKEY_DELEGATED_API_PRIVATE_KEY,
        }
      : undefined;

  const cfg = {
    rpcUrl: e.ARC_TESTNET_RPC_URL,
    chainId: e.ARC_CHAIN_ID,
    platformPrivateKey: e.PLATFORM_PRIVATE_KEY,
    identityRegistry: e.IDENTITY_REGISTRY,
    usdc: e.USDC_ADDRESS,
    factoryAddress: e.FACTORY_ADDRESS,
    guardianAddress: e.GUARDIAN_ADDRESS,
    operatorPrivateKey: e.OPERATOR_PRIVATE_KEY,
    pocketMasterSeed: e.POCKET_MASTER_SEED,
    dataDir: e.DATA_DIR,
    dbPath: `${e.DATA_DIR}/legalbody.db`,
    docStoreDir: `${e.DATA_DIR}/documents`,
    turnkey,
    circleApiKey: e.CIRCLE_API_KEY,
    circle:
      e.CIRCLE_API_KEY && e.CIRCLE_ENTITY_SECRET
        ? {
            apiKey: e.CIRCLE_API_KEY,
            entitySecret: e.CIRCLE_ENTITY_SECRET,
            walletSetId: e.CIRCLE_WALLET_SET_ID,
          }
        : undefined,
    walletProviderDefault: e.WALLET_PROVIDER_DEFAULT,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    agentModel: e.AGENT_MODEL,
    gatewayFacilitatorUrl: e.GATEWAY_FACILITATOR_URL,
    fundingFloatUsdc: e.FUNDING_FLOAT_USDC,
    maxPocketFloatUsdc: e.MAX_POCKET_FLOAT_USDC,
    spendAllowlistThreshold: usdToUnits(e.SPEND_ALLOWLIST_THRESHOLD_USDC),
    maxJobBudget: usdToUnits(e.MAX_JOB_BUDGET_USDC),
    maxInflightJobsPerTenant: e.MAX_INFLIGHT_JOBS_PER_TENANT,
    maxTreasuryFund: usdToUnits(e.MAX_TREASURY_FUND_USDC),
    maxTreasuryFundedPerTenant: usdToUnits(e.MAX_TREASURY_FUNDED_PER_TENANT_USDC),
    platformOutflowCeiling: usdToUnits(e.PLATFORM_OUTFLOW_CEILING_USDC),
    platformOutflowWindowMs: e.PLATFORM_OUTFLOW_WINDOW_HOURS * 3_600_000,
    customerPrivateKey: e.CUSTOMER_PRIVATE_KEY ?? e.PLATFORM_PRIVATE_KEY,
    authJwtSecret: e.AUTH_JWT_SECRET,
    authJwtTtlSec: e.AUTH_JWT_TTL_SEC,
    webOrigin: e.WEB_ORIGIN,
    siweDomain: e.SIWE_DOMAIN,
    passkeyRpId: e.PASSKEY_RP_ID,
    jobContract: e.JOB_CONTRACT_ADDRESS,
    reputationRegistry: e.REPUTATION_REGISTRY_ADDRESS,
    jobClientPrivateKey: e.JOB_CLIENT_PRIVATE_KEY ?? e.PLATFORM_PRIVATE_KEY,
    jobEvaluatorPrivateKey: e.JOB_EVALUATOR_PRIVATE_KEY,
    jobSweepToTreasury: e.JOB_SWEEP_TO_TREASURY,
    mcpPublicUrl: e.MCP_PUBLIC_URL,
    metadataBaseUrl: e.METADATA_BASE_URL,
    gasSeedFloorUsdc: e.GAS_SEED_FLOOR_USDC,
    gasSeedTargetUsdc: e.GAS_SEED_TARGET_USDC,
    enableX402Demo: e.ENABLE_X402_DEMO,
    x402TrustPolicy: e.X402_TRUST_POLICY,
    x402BuyerTrustPolicy: e.X402_BUYER_TRUST_POLICY,
    worldRateWindowHours: e.WORLD_RATE_WINDOW_HOURS,
    x402ProofAgentKey: e.X402_PROOF_AGENT_KEY,
    x402DemoPayTo:
      e.X402_DEMO_PAYTO ?? (privateKeyToAccount(e.PLATFORM_PRIVATE_KEY).address as Address),
    x402DemoPriceUsdc: e.X402_DEMO_PRICE_USDC,
    ens: e.ENS_GATEWAY_SIGNER_KEY
      ? {
          signerKey: e.ENS_GATEWAY_SIGNER_KEY,
          parentName: e.ENS_PARENT_NAME,
          resolverAddress: e.ENS_RESOLVER_ADDRESS,
          labelAliases: parseLabelAliases(e.ENS_LABEL_ALIASES),
        }
      : undefined,
    // All three portal credentials are required together — a partial config would fail at
    // request-signing time with a confusing runtime error instead of a clear boot warning.
    world:
      e.WORLD_APP_ID && e.WORLD_RP_ID && e.WORLD_RP_SIGNING_KEY
        ? {
            appId: e.WORLD_APP_ID,
            rpId: e.WORLD_RP_ID,
            rpSigningKey: e.WORLD_RP_SIGNING_KEY,
            action: e.WORLD_ACTION,
            maxEntitiesPerHuman: e.WORLD_MAX_ENTITIES_PER_HUMAN,
            requireGuardian: e.WORLD_REQUIRE_GUARDIAN,
            environment: e.WORLD_ENVIRONMENT,
            attestAction: e.WORLD_ATTEST_ACTION,
            attestMinAge: e.WORLD_ATTEST_MIN_AGE,
          }
        : undefined,
    worldChain: {
      rpcUrl: e.WORLD_CHAIN_RPC,
      agentBook: e.WORLD_AGENTBOOK_ADDRESS,
      allowancePerHuman: e.WORLD_ALLOWANCE_PER_HUMAN,
    },
  };

  const isProd = (env.NODE_ENV ?? process.env.NODE_ENV) === "production";

  // Fail-closed: never let production boot with the insecure dev defaults.
  if (isProd) {
    if (cfg.authJwtSecret === DEV_JWT_SECRET)
      throw new Error("Invalid config: AUTH_JWT_SECRET must be set to a real secret in production");
    if (cfg.webOrigin === "*")
      throw new Error(
        "Invalid config: WEB_ORIGIN must be an explicit origin (not '*') in production",
      );
    const mbu = new URL(cfg.metadataBaseUrl);
    const loopback =
      mbu.hostname === "localhost" ||
      mbu.hostname.endsWith(".localhost") ||
      mbu.hostname === "0.0.0.0" ||
      mbu.hostname === "[::1]" ||
      mbu.hostname.startsWith("127.");
    if (mbu.protocol !== "https:" || loopback)
      throw new Error(
        "Invalid config: METADATA_BASE_URL must be an https, non-loopback URL in production (it is baked permanently on-chain)",
      );
  }

  if (parseEther(cfg.gasSeedFloorUsdc) >= parseEther(cfg.gasSeedTargetUsdc)) {
    throw new Error("Invalid config: GAS_SEED_FLOOR_USDC must be less than GAS_SEED_TARGET_USDC");
  }

  // Tier-0: a half-configured Circle block must fail at boot, not at first sign (audit item 1).
  if (Boolean(e.CIRCLE_API_KEY) !== Boolean(e.CIRCLE_ENTITY_SECRET)) {
    throw new Error(
      e.CIRCLE_API_KEY
        ? "Invalid config: CIRCLE_API_KEY is set but CIRCLE_ENTITY_SECRET is missing (all-or-nothing)"
        : "Invalid config: CIRCLE_ENTITY_SECRET is set but CIRCLE_API_KEY is missing (all-or-nothing)",
    );
  }

  // Tier-0 (review L2): a circle DEFAULT without circle provisioning would 400 every default
  // onboard at runtime — refuse at boot instead, like every other config mismatch.
  if (cfg.walletProviderDefault === "circle" && !cfg.circle?.walletSetId) {
    throw new Error(
      "Invalid config: WALLET_PROVIDER_DEFAULT=circle requires CIRCLE_API_KEY + CIRCLE_ENTITY_SECRET + CIRCLE_WALLET_SET_ID",
    );
  }

  // Symmetric turnkey-side check, production-only: `turnkey` is the SCHEMA default so bare
  // dev/CI deployments must keep booting credential-less — but a production deployment whose
  // default custody it cannot provision (vault provisioning needs the delegated keypair too)
  // would fail every default onboard in front of a user instead of at boot.
  if (isProd && cfg.walletProviderDefault === "turnkey" && !canProvisionTurnkey(cfg)) {
    throw new Error(
      "Invalid config: WALLET_PROVIDER_DEFAULT=turnkey in production requires TURNKEY_API_* + TURNKEY_ORGANIZATION_ID + TURNKEY_SIGN_WITH + TURNKEY_DELEGATED_API_* (set WALLET_PROVIDER_DEFAULT=circle for a circle-only deployment)",
    );
  }

  if (cfg.platformOutflowCeiling < cfg.maxTreasuryFund) {
    throw new Error(
      "Invalid config: PLATFORM_OUTFLOW_CEILING_USDC must be >= MAX_TREASURY_FUND_USDC (a single legal fund call must never be auto-blocked)",
    );
  }

  if (cfg.maxTreasuryFund > cfg.maxTreasuryFundedPerTenant) {
    throw new Error(
      "Invalid config: MAX_TREASURY_FUND_USDC must be <= MAX_TREASURY_FUNDED_PER_TENANT_USDC",
    );
  }

  const ceilingAtomic = usdToUnits(cfg.maxPocketFloatUsdc);
  const floatAtomic = usdToUnits(cfg.fundingFloatUsdc);
  // usdToUnits treats the native 18-dec seed string as its 6-dec-USDC decimal equivalent — the same
  // interpretation the existing skip-guard uses (funding robustness doc; liveRunner.ts:213). On Arc,
  // native gas IS USDC, so the numeric value is the correct 6-dec equivalent.
  const seedTargetAtomic = usdToUnits(cfg.gasSeedTargetUsdc);
  if (ceilingAtomic < floatAtomic + 2n * seedTargetAtomic) {
    throw new Error(
      "Invalid config: MAX_POCKET_FLOAT_USDC must be >= FUNDING_FLOAT_USDC + 2×GAS_SEED_TARGET_USDC " +
        "(both EOAs are gas-seeded to the target and are counted in standing exposure, so the first " +
        "legitimate float top-up would otherwise be rejected).",
    );
  }

  return cfg;
}

/**
 * Safe-to-log view: secrets replaced with "REDACTED".
 * WARNING: this spreads all Config fields. If you add a NEW secret field to Config,
 * you MUST explicitly redact it here or it will appear in logs.
 */
export function redact(cfg: Config): Record<string, unknown> {
  return {
    ...cfg,
    spendAllowlistThreshold: cfg.spendAllowlistThreshold.toString(),
    maxJobBudget: cfg.maxJobBudget.toString(),
    maxTreasuryFund: cfg.maxTreasuryFund.toString(),
    maxTreasuryFundedPerTenant: cfg.maxTreasuryFundedPerTenant.toString(),
    platformOutflowCeiling: cfg.platformOutflowCeiling.toString(),
    platformPrivateKey: "REDACTED",
    customerPrivateKey: "REDACTED",
    authJwtSecret: "REDACTED",
    operatorPrivateKey: cfg.operatorPrivateKey ? "REDACTED" : undefined,
    pocketMasterSeed: cfg.pocketMasterSeed ? "REDACTED" : undefined,
    circleApiKey: cfg.circleApiKey ? "REDACTED" : undefined,
    circle: cfg.circle
      ? { apiKey: "REDACTED", entitySecret: "REDACTED", walletSetId: cfg.circle.walletSetId }
      : undefined,
    anthropicApiKey: cfg.anthropicApiKey ? "REDACTED" : undefined,
    jobClientPrivateKey: "REDACTED",
    jobEvaluatorPrivateKey: cfg.jobEvaluatorPrivateKey ? "REDACTED" : undefined,
    x402ProofAgentKey: cfg.x402ProofAgentKey ? "REDACTED" : undefined,
    ens: cfg.ens ? { ...cfg.ens, signerKey: "REDACTED" } : undefined,
    world: cfg.world ? { ...cfg.world, rpSigningKey: "REDACTED" } : undefined,
    turnkey: cfg.turnkey
      ? {
          ...cfg.turnkey,
          apiPrivateKey: "REDACTED",
          apiPublicKey: "REDACTED",
          delegatedApiPrivateKey: cfg.turnkey.delegatedApiPrivateKey ? "REDACTED" : undefined,
        }
      : undefined,
  };
}
