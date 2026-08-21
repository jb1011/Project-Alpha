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
    // `.strict()`: an unknown key here is REFUSED, not silently stripped. `ein` is the reason —
    // the EIN is issued by the IRS and carried by the OA bundle manifest (design §4), never
    // supplied by the caller, and it is absent from this shape so the generated JSON Schema
    // (GET /schema/agent-spec.json, the MCP schema resource) stops ADVERTISING a field the
    // system will not honor. Strictness turns "quietly ignored" into zod's named
    // "Unrecognized key(s) in object: 'ein'", which is what a caller needs to hear.
    legal: z
      .object({
        formationDate: z.string().date().optional(), // ISO YYYY-MM-DD; stubbed if absent
      })
      .strict()
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

/**
 * The formation party — the legal identity of the natural person a filing names (design §3/§5).
 *
 * **Deliberately BESIDE `AgentSpecSchema`, never inside it.** The spec is persisted verbatim in
 * `entities.spec_json` and rendered back out of it; PII that entered the spec would land in a
 * column every read path touches, in the OA terms doc, and in any future spec echo. The two
 * schemas sit next to each other so the separation is visible to whoever adds the next field:
 * anything identifying a human belongs here, and this shape never travels as `spec`.
 *
 * `.strict()` for the same reason the spec is: an unknown key is a caller's misunderstanding of
 * where their data is going, and it must be named rather than silently dropped.
 */
export const FormationPartySchema = z
  .object({
    legalFirstName: z.string().min(1),
    legalLastName: z.string().min(1),
    email: z.string().email(),
    /** doola REQUIRES a phone on a natural person's address (live sandbox, 2026-08-21), so a
     *  party without one cannot be filed — see `formationProvider.ts`. Kept optional here
     *  because the design specifies it so; the wizard must collect it before production. */
    phone: z.string().min(1).optional(),
    address: z
      .object({
        line1: z.string().min(1),
        line2: z.string().min(1).optional(),
        city: z.string().min(1),
        /** US: the 2-letter state. Absent for the countries that have no state/province (L3). */
        region: z.string().min(1).optional(),
        postalCode: z.string().min(1),
        /** ISO-3166-1 **alpha-3** ("USA", "FRA") — doola's convention, not alpha-2. Normalized
         *  to upper case so "usa" and "USA" cannot become two different countries downstream. */
        country: z
          .string()
          .transform((s) => s.toUpperCase())
          .refine((s) => /^[A-Z]{3}$/.test(s), {
            message: "must be an ISO-3166-1 alpha-3 country code, e.g. USA",
          }),
      })
      .strict(),
  })
  .strict();

export type FormationPartyInput = z.infer<typeof FormationPartySchema>;
