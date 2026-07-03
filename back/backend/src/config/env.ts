import { getAddress, isAddress } from "viem";
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

const DEV_JWT_SECRET = "dev-insecure-secret-change-me-please";

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
  SPEND_ALLOWLIST_THRESHOLD_USDC: z.string().default("1"),
  MAX_JOB_BUDGET_USDC: z.string().default("5"),
  MAX_INFLIGHT_JOBS_PER_TENANT: z.coerce.number().int().positive().default(3),
  CUSTOMER_PRIVATE_KEY: privKeySchema.optional(),
  CIRCLE_API_KEY: z.string().optional(),
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
  anthropicApiKey?: string;
  agentModel: string;
  gatewayFacilitatorUrl: string;
  fundingFloatUsdc: string;
  spendAllowlistThreshold: bigint;
  maxJobBudget: bigint;
  maxInflightJobsPerTenant: number;
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
}

/** Validate + shape env into Config. Throws a readable error on the first invalid field. */
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
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    agentModel: e.AGENT_MODEL,
    gatewayFacilitatorUrl: e.GATEWAY_FACILITATOR_URL,
    fundingFloatUsdc: e.FUNDING_FLOAT_USDC,
    spendAllowlistThreshold: usdToUnits(e.SPEND_ALLOWLIST_THRESHOLD_USDC),
    maxJobBudget: usdToUnits(e.MAX_JOB_BUDGET_USDC),
    maxInflightJobsPerTenant: e.MAX_INFLIGHT_JOBS_PER_TENANT,
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
  };

  // Fail-closed: never let production boot with the insecure dev defaults.
  if ((env.NODE_ENV ?? process.env.NODE_ENV) === "production") {
    if (cfg.authJwtSecret === DEV_JWT_SECRET)
      throw new Error("Invalid config: AUTH_JWT_SECRET must be set to a real secret in production");
    if (cfg.webOrigin === "*")
      throw new Error(
        "Invalid config: WEB_ORIGIN must be an explicit origin (not '*') in production",
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
    platformPrivateKey: "REDACTED",
    customerPrivateKey: "REDACTED",
    authJwtSecret: "REDACTED",
    operatorPrivateKey: cfg.operatorPrivateKey ? "REDACTED" : undefined,
    pocketMasterSeed: cfg.pocketMasterSeed ? "REDACTED" : undefined,
    circleApiKey: cfg.circleApiKey ? "REDACTED" : undefined,
    anthropicApiKey: cfg.anthropicApiKey ? "REDACTED" : undefined,
    jobClientPrivateKey: "REDACTED",
    jobEvaluatorPrivateKey: cfg.jobEvaluatorPrivateKey ? "REDACTED" : undefined,
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
