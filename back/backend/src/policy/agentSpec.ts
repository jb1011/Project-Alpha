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
    /**
     * REQUIRED (C6). doola refuses a company create whose responsible party has no phone (live
     * sandbox, 2026-08-21), so a party without one is a legal identity that can never be filed.
     *
     * The design left it optional and the create step refuses it later, which meant a caller
     * could post an identity, receive a handle, onboard with it, and discover at the FILING —
     * after the entity is minted, bound and funded — that their party was unusable. Refusing at
     * INTAKE costs the caller one 400 and costs the platform nothing. The create step's own check
     * stays as belt-and-braces: it guards the parties already in the table, and it is the layer
     * that must hold if doola's requirements change again.
     *
     * The labeled sandbox fixture supplies one (`syntheticFormationParty`), so the synthetic path
     * is unaffected.
     */
    phone: z.string().min(1),
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

/**
 * The COMPANY INTAKE, as one schema for the two REST doors that carry it (design §5, A2).
 *
 * Beside `FormationPartySchema` for the same reason that one is here: these are the shapes a
 * caller sends about a legal filing, and `POST /companies` and `PATCH /companies/:id` are the two
 * doors that can carry a Social Security Number. They had a hand-rolled copy each — an
 * `Array.isArray` check and a loop over three field names — and the copies were already one field
 * apart, which is how a door ends up accepting something its twin refuses.
 *
 * TYPE rules only. Every CONTENT rule — length, charset, Wyoming's restricted words, duplicates
 * after normalization, the industry list, the SSN's `XXX-XX-XXXX` format — lives in
 * `createCompany`, where MCP meets exactly the same refusals. A route that re-stated any of them
 * would be a second opinion about a legal filing.
 *
 * The messages are spelled out rather than left to zod, because A2's rule is that a refusal NAMES
 * its field and, where it can, the offending value; `firstIssueMessage` at the door is what turns
 * the first issue back into that sentence.
 */
export const CompanyIntakeBodySchema = z.object({
  /** Three candidates. The COUNT and every content rule are `createCompany`'s (§5), so a caller
   *  who sends two gets the domain's sentence about why three are needed, not a schema's. */
  names: z
    .array(z.string(), { invalid_type_error: "names must be an array of strings" })
    .optional(),
  businessPurpose: z.string({ invalid_type_error: "businessPurpose must be a string" }).optional(),
  industryLabel: z.string({ invalid_type_error: "industryLabel must be a string" }).optional(),
  /**
   * The SSN, and the ONE field on this schema whose absence from a door is a security property
   * rather than a convenience (§4.1) — see `gateSsn` for what happens to it next.
   */
  ssn: z.string({ invalid_type_error: "ssn must be a string" }).optional(),
});

/**
 * `POST /companies`.
 *
 * `.strict()`, exactly as `FormationPartySchema` is, and here it earns its keep twice over: a
 * caller who types `SSN` or `ssn_number` would otherwise have the field SILENTLY DROPPED and get
 * back a companyId filed under the slow EIN route — the same failure the MCP door had, on the one
 * surface that actually collects the number.
 */
export const CreateCompanyBodySchema = CompanyIntakeBodySchema.extend({
  partyId: z
    .string({ required_error: "partyId is required", invalid_type_error: "partyId is required" })
    .min(1, "partyId is required"),
  /** The sandbox deployment's marker, checked against this box's own setting in `createCompany`. */
  synthetic: z.boolean({ invalid_type_error: "synthetic must be a boolean" }).optional(),
}).strict();

/**
 * `PATCH /companies/:companyId` — the §4.7 re-open. No `partyId`: the party is read from the
 * company, and a filing's responsible person is not editable.
 */
export const UpdateCompanyIntakeBodySchema = CompanyIntakeBodySchema.extend({
  /** §4.6a's second exit. Its `=== true` meaning is enforced at the door, not here: "file without
   *  one" is a choice a caller makes, never something a truthy value makes for them. */
  proceedWithoutSsn: z
    .boolean({ invalid_type_error: "proceedWithoutSsn must be a boolean" })
    .optional(),
}).strict();

/**
 * The first thing zod objected to, as the sentence the door answers with.
 *
 * A2's refusals name their field, and `apiOnError`'s generic ZodError mapping ("invalid request"
 * plus an issues array) does not. Unknown keys get the field named too — that is the whole point
 * of `.strict()` on a door that can carry an SSN.
 */
export function firstIssueMessage(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "invalid request body";
  if (issue.code === "unrecognized_keys")
    return `unknown field${issue.keys.length > 1 ? "s" : ""}: ${issue.keys.join(", ")}`;
  const path = issue.path.join(".");
  return path && !issue.message.startsWith(path) ? `${path}: ${issue.message}` : issue.message;
}
