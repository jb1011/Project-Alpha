import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { parseDuration, usdToUnits } from "./units";

// Validate any valid 40-hex address (casing-insensitive), then normalize to canonical EIP-55
// checksum — keeps stored addresses consistent with config/env.ts.
const addr = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), { message: "must be a 0x address" })
  .transform((s) => getAddress(s));

// Contract-enforced bounds, mirrored here so a bad agent.json fails at the spec boundary with a
// readable field path instead of an opaque on-chain custom-error revert mid-onboarding.
// LegalManager.MIN_AMENDMENT_DELAY / AgentTreasury.MIN_POLICY_DELAY = 1h;
// AgentTreasury.MAX_POLICY_PERIOD = 365d; period must be > 0 (ZeroAmount).
const MIN_DELAY_SECONDS = 3_600n;
const MAX_PERIOD_SECONDS = 365n * 86_400n;

// A USD amount the 6-decimal USDC parser accepts (e.g. "1000.00"); rejects negatives/junk/>6dp.
const usdcAmount = z.string().refine(
  (s) => {
    try {
      usdToUnits(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a USD amount like 1000.00 (max 6 decimals, non-negative)" },
);

// A duration (string like "30d"/"24h" or a number of seconds) within [min, max] seconds.
const durationInRange = (min: bigint, max: bigint, hint: string) =>
  z.union([z.string(), z.number()]).refine(
    (v) => {
      try {
        const secs = parseDuration(v);
        return secs >= min && secs <= max;
      } catch {
        return false;
      }
    },
    { message: hint },
  );

export const AgentSpecSchema = z
  .object({
    name: z.string().min(1),
    jurisdiction: z.string().default("Wyoming-DAO-LLC"),
    roles: z.object({
      manager: addr,
      guardian: addr,
      operator: addr.optional(), // usually created by Turnkey; may be pinned for tests
    }),
    treasury: z.object({
      usdc: addr.optional(), // defaults to config USDC in the translator
      payoutAddress: addr,
      spendingCapUsdc: usdcAmount,
      spendingPeriod: durationInRange(1n, MAX_PERIOD_SECONDS, "must be a duration in (0, 365d]"),
      allowlistEnabled: z.boolean().default(false),
      perTxCapUsdc: usdcAmount
        .refine((v) => Number(v) > 0, "perTxCapUsdc must be greater than 0")
        .optional(), // optional off-chain per-transaction cap
    }),
    governance: z.object({
      amendmentDelay: durationInRange(
        MIN_DELAY_SECONDS,
        MAX_PERIOD_SECONDS,
        "must be a duration >= 1h",
      ).default("24h"),
    }),
    legal: z
      .object({
        ein: z.string().optional(),
        formationDate: z.string().date().optional(), // ISO YYYY-MM-DD; stubbed if absent
      })
      .default({}),
    metadata: z
      .object({
        description: z.string().default(""),
        agentType: z.string().default("service"),
        capabilities: z.array(z.string()).default([]),
        version: z.string().default("1"),
      })
      .default({}),
  })
  // Cross-field role distinctness, mirroring LegalManager/AgentTreasury constructor invariants
  // (RolesMustDiffer + payout != operator). Addresses are already EIP-55-normalized above, so
  // string equality is a sound comparison.
  .superRefine((spec, ctx) => {
    const { manager, guardian, operator } = spec.roles;
    if (manager === guardian) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["roles", "guardian"],
        message: "guardian must differ from manager",
      });
    }
    if (operator !== undefined) {
      if (operator === manager) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", "operator"],
          message: "operator must differ from manager",
        });
      }
      if (operator === guardian) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["roles", "operator"],
          message: "operator must differ from guardian",
        });
      }
      if (spec.treasury.payoutAddress === operator) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["treasury", "payoutAddress"],
          message: "payoutAddress must differ from operator",
        });
      }
    }
  });

export type AgentSpec = z.infer<typeof AgentSpecSchema>;

/** Parse + validate an agent.json object. Throws a readable error keyed by field path. */
export function parseAgentSpec(input: unknown): AgentSpec {
  const parsed = AgentSpecSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join(".") ?? "unknown";
    const msg = first?.message ?? "validation failed";
    throw new Error(`Invalid agent spec: ${path} — ${msg}`);
  }
  return parsed.data;
}
