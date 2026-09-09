import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hexToString } from "viem";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { toJobView } from "../api/jobViews";
import { assertGuardianAllowed } from "../api/routes/worldId";
import {
  type EntityViewDeps,
  listCompanyViews,
  toCompanyDetailView,
  toEntityView,
  toEntityViews,
} from "../api/views";
import { custodyUnavailableMessage } from "../custody";
import {
  createFormationParty,
  formationDoorRefusal,
  formationUnavailableMessage,
  ssnNotOnThisDoorMessage,
  truncateTenant,
} from "../formation";
import { partyFieldsOf } from "../formation";
import { createCompany, updateCompanyParty } from "../formation/company";
import { describeIndustryLabels } from "../formation/naicsLabels";
import { FORMATION_PRODUCT, guardianOf, paymentView } from "../formation/payment";
import { deriveFormationStatus, hasLivePayment } from "../formation/status";
import type { JobRepository } from "../jobs/jobRepository";
import type { JobRunner } from "../jobs/jobRunner";
import { opsLog } from "../observability/opsLog";
import type { EntityPaymentService } from "../payments/entityPayment";
import { ROUTE_RECEIPT_TIMEOUT_MS } from "../payments/formationSettle";
import { withKeyedLock } from "../payments/keyedMutex";
import type { PocketFundingFn } from "../payments/pocketFunding";
import type { VerifiedKey } from "../persistence/apiKeyStore";
import type { EntityRepository } from "../persistence/entityRepository";
import type { PasskeyStore } from "../persistence/passkeyStore";
import { AgentSpecSchema, FormationPartySchema } from "../policy/agentSpec";
import { usdToUnits } from "../policy/units";
import {
  cancelFormationPayment,
  requoteFormationPayment,
  settleFormationPayment,
} from "../workflow/formationPayment";
import type { OnboardingRunner } from "../workflow/runner";
import { entityInScope, hasCapability } from "./scope";

/**
 * What the MCP tools need.
 *
 * The view dependencies are INHERITED from `EntityViewDeps` (C8), the same object `ApiDeps`
 * extends and the composition root builds once. They used to be two optional fields restated
 * here, and the transport passed one and forgot the other — so `get_entity` over MCP reported an
 * entity with no legal documents while REST reported the same entity with two. Inheriting the
 * object is what makes "wired on one surface only" unrepresentable rather than merely unlikely.
 */
export interface McpToolDeps extends EntityViewDeps {
  repo: EntityRepository;
  runner: OnboardingRunner;
  passkeys: PasskeyStore;
  /** Tier-0 custody: platform default + per-provider provisioning availability (mirrors ApiDeps). */
  walletProviderDefault: "turnkey" | "circle";
  circleCustodyAvailable: boolean;
  turnkeyCustodyAvailable: boolean;
  /** Audit fix C: the platform/manager account address, force-set into `roles.manager` on
   *  onboard_agent so an agent-first caller never needs to know or guess it. */
  platformManagerAddress: string;
  jobs: JobRepository;
  payments?: EntityPaymentService;
  /** Explicit treasury->pocket Gateway top-up (fund_pocket). Optional — mirrors `payments`:
   *  deployments without POCKET_MASTER_SEED/Turnkey configured leave this undefined and the tool
   *  reports "pocket funding unavailable" instead of the server failing to boot. */
  pocketFunding?: PocketFundingFn;
  jobRunner: JobRunner;
  jobClientAddress: string;
  jobEvaluatorAddress: string;
  /** Audit fix A: caps on run_job to stop an earn-capability agent from draining the platform's
   *  job-funding wallet via a loop of large-budget or many-in-flight jobs. */
  maxJobBudget: bigint;
  maxInflightJobsPerTenant: number;
  linkCodes: import("../persistence/linkCodeStore").LinkCodeStore;
  /** Arc adapter — live legal-status + ENSIP-25 reverse-binding reads for resolve_agent. Optional. */
  arc?: import("../adapters/arc/arcAdapter").ArcAdapter;
  /** ENS config for resolve_agent (parent name + registry for the ENSIP-25 verdict). Optional. */
  ens?: {
    parentName: string;
    identityRegistry: string;
    chainId: number;
    /** Vanity label -> publicId, same map the CCIP gateway uses. */
    labelAliases?: Record<string, string>;
  };
  /** World ID guardian gate (mirrors the REST /onboard gate). Optional. */
  worldId?: import("../api/routes/worldId").WorldIdDeps;
  /** doola formation (design §2/§5), the SAME object ApiDeps carries — availability, the
   *  requirement, the PII intake policy, the spend limits and the repositories. Absent =
   *  this deployment forms nothing, and neither the tools nor the gate exist. */
  formation?: import("../api/app").ApiDeps["formation"];
  /** The company store and the steps lookup, for `list_companies` and the entity projection —
   *  the SAME objects ApiDeps carries, so MCP and REST cannot describe a company differently. */
  companies?: import("../api/app").ApiDeps["companies"];
  formationSteps?: import("../api/app").ApiDeps["formationSteps"];
  /** Injectable clock (ms) for tests; defaults to Date.now. */
  now?: () => number;
}

/**
 * EVERY KEY OF `McpToolDeps` THAT IS COPIED VERBATIM — and a COMPILE ERROR if one is missing.
 *
 * `ENTITY_VIEW_DEP_KEYS`, one object out. The transport enumerated these by hand and dropped two
 * of them without a sound: the document index first (`get_entity` over MCP described an entity
 * with no legal documents while REST described the same entity with two), and then `now` — the
 * injectable clock, which every REST surface honours and which the MCP tools therefore could not
 * be tested against or frozen for. A hand-written pick is a subset by default, and the field it
 * omits is always the one added last.
 *
 * `ens` is deliberately ABSENT from this list: it is the one dependency the MCP layer takes a
 * NARROWING of rather than a copy, because `ApiDeps["ens"]` carries the gateway's signing account
 * and the tools have no business holding a private key. `mcpToolDepsOf` constructs it, and the
 * exhaustiveness check below excludes it by name so that omission is a decision somebody wrote
 * down rather than a gap.
 */
export const MCP_TOOL_DEP_KEYS = [
  "repo",
  "runner",
  "passkeys",
  "walletProviderDefault",
  "circleCustodyAvailable",
  "turnkeyCustodyAvailable",
  "platformManagerAddress",
  "jobs",
  "payments",
  "pocketFunding",
  "jobRunner",
  "jobClientAddress",
  "jobEvaluatorAddress",
  "maxJobBudget",
  "maxInflightJobsPerTenant",
  "linkCodes",
  "arc",
  "worldId",
  "formation",
  "companies",
  "formationSteps",
  "now",
  // The `EntityViewDeps` half — inherited, and listed here too because this list is about what
  // the TRANSPORT copies, and a view dep that reached REST and not MCP is the bug that started
  // all of this (A3's sharing label, field for field).
  "formationStepsMany",
  "company",
  "companyMany",
  "documents",
  "companyAgents",
] as const satisfies readonly (keyof McpToolDeps)[];

/** Fails to compile the moment `McpToolDeps` grows a key that is neither listed nor `ens`. */
type MissingMcpToolDep = Exclude<keyof McpToolDeps, (typeof MCP_TOOL_DEP_KEYS)[number] | "ens">;
const _assertEveryMcpToolDepListed: MissingMcpToolDep extends never ? true : never = true;
void _assertEveryMcpToolDepListed;

/**
 * Availability sentence for the onboard_agent description — agent-first callers have no GET
 * /config, so the tool description is their capability discovery surface. The formation note
 * follows the same pattern for the same reason: an agent that cannot read /config must still be
 * able to learn that this deployment will refuse an onboard without a companyId, and in WHICH
 * environment it files (the honesty invariant reaches the agent surface too).
 */
function custodyCapabilityNote(
  deps: Pick<
    McpToolDeps,
    "walletProviderDefault" | "circleCustodyAvailable" | "turnkeyCustodyAvailable"
  >,
): string {
  const available =
    [deps.circleCustodyAvailable && "'circle'", deps.turnkeyCustodyAvailable && "'turnkey'"]
      .filter(Boolean)
      .join(", ") || "none";
  return `('${deps.walletProviderDefault}'). Available on this deployment: ${available}.`;
}

/**
 * `create_company`'s description, as ONE constant plus the deployment's own sentence.
 *
 * It was a 900-character template literal inline in the registration, which is where a tool's
 * description is least readable and most likely to drift from the schema three lines below it.
 *
 * The industry list is CAPPED exactly as the REST refusal caps it (`describeIndustryLabels`),
 * and that shared cap is the point: this description is an agent's ONLY discovery surface for
 * the one enumerated field, and the day `refresh-naics.mts` is run against a real sandbox key it
 * becomes a few hundred federal labels. Uncapped, that is a tool description that crowds out
 * every other tool in the client's context window — paid for on every single request.
 */
const CREATE_COMPANY_DESCRIPTION =
  "Create the legal body (a Wyoming LLC) your agents will be filed under, and get back a companyId to pass to onboard_agent." +
  " %CAPABILITY%" +
  " partyId is the handle from create_formation_party — the natural person legally answerable for the filing." +
  " names is THREE candidates in order of preference: Wyoming refuses a name that is already taken, and the alternates are what let the filing proceed without a second fee." +
  " businessPurpose is a short description of what the COMPANY does, filed with it." +
  " industryLabel must be one of the industries we can file under (%INDUSTRIES%)." +
  " This call SPENDS: it is subject to your tenant's formation quota and the platform's daily ceiling." +
  " %PAYMENT%" +
  " ⚠ It NEVER takes an SSN, and never will — an SSN in a tool argument would sit in this client's context window and its logs; the field is declared only so that passing one is REFUSED rather than silently dropped." +
  " If the responsible party is a US person and wants the fast EIN route, create the company through the web form (POST /companies) instead." +
  " Agents attached to an existing company are free: pass its companyId to onboard_agent instead of creating a second one.";

function createCompanyDescription(deps: Pick<McpToolDeps, "formation">): string {
  return CREATE_COMPANY_DESCRIPTION.replace("%CAPABILITY%", formationCapabilityNote(deps))
    .replace("%PAYMENT%", formationPaymentNote(deps))
    .replace("%INDUSTRIES%", describeIndustryLabels());
}

/**
 * ⚠ WHAT THIS CALL COSTS, AND WHAT HAPPENS NEXT (finding B7).
 *
 * An agent reading `create_company` used to be told the call "SPENDS" against a quota and
 * nothing else. On a deployment that charges, the company then lands in `draft` owing a real fee,
 * the answer carries a quote the agent has no described way to act on, and the agent reports "the
 * company was created" — which is true and useless. What it needs to say, in the one place an
 * agent reads before calling: the amount, the state the company lands in, that a HUMAN's wallet
 * must sign (we cannot), and the names of the four tools that finish the job.
 */
function formationPaymentNote(deps: Pick<McpToolDeps, "formation">): string {
  const payment = deps.formation?.payment;
  if (!payment?.required)
    return "Formation is included on this deployment: no fee is charged and the company is ready to file immediately.";
  return (
    `⚠ THIS DEPLOYMENT CHARGES A FORMATION FEE of $${payment.feeUsdc} USDC per company.` +
    " The company lands in `draft` and the answer carries a QUOTE (amount, payee, nonce, expiry and the exact EIP-712 message to sign)." +
    " It cannot be filed until that quote is settled, and it can only be settled by the GUARDIAN's own wallet — we cannot sign it for them, because it authorizes a transfer of their USDC." +
    " Four tools finish the job: get_company_payment (re-read the quote, or find out what happened), submit_company_payment (their signature), cancel_company_payment (withdraw a stuck one — a second signature) and requote_company_payment (a fresh quote once nothing is live)."
  );
}

/** Formation availability sentence for the onboard_agent / create_formation_party descriptions. */
function formationCapabilityNote(deps: Pick<McpToolDeps, "formation">): string {
  if (!deps.formation) return "Formation is not available on this deployment.";
  const identity = deps.formation.sandboxSyntheticPii
    ? "This deployment files with a labeled SYNTHETIC sandbox identity: pass synthetic:true and no personal data — real personal data is refused."
    : "This deployment files real legal entities: real personal data is required and synthetic:true is refused.";
  const fee = deps.formation.payment?.required
    ? ` This deployment CHARGES $${deps.formation.payment.feeUsdc} USDC per company, payable by the guardian's own wallet before the filing can start (see create_company).`
    : "";
  return `Formation is ${deps.formation.required ? "REQUIRED" : "available"} on this deployment (doola, ${deps.formation.environment}). ${identity}${fee}`;
}

/**
 * THE COMPANY an ENTITY-SCOPED key may see — `entityInScope`, one key along (§7).
 *
 * `get_entity` and `list_entities` have narrowed to the key's own entity since the scoped-key
 * surface shipped. The two COMPANY reads were added without the equivalent, and a company is a
 * strictly wider object than the entity that points at it: an entity-scoped key could enumerate
 * every legal body its tenant owns and read any of them in full, including the ids and names of
 * every SIBLING agent attached. That is the fleet shape `/transparency` deliberately does not
 * publish, handed to a credential whose owner narrowed it on purpose.
 *
 * Returns `null` for a tenant-wide key — "no restriction" — and the entity's `company_id`
 * otherwise, which is `undefined` when the entity is unknown or attached to nothing. `undefined`
 * therefore matches no company at all, which is the right answer: an agent with no company has
 * no company to read.
 */
function scopedCompanyId(
  scope: VerifiedKey,
  repo: Pick<EntityRepository, "findByIdempotencyKey">,
): string | null | undefined {
  if (scope.entityId === null) return null;
  return repo.findByIdempotencyKey(scope.entityId)?.companyId ?? undefined;
}

/** What a refused tool call looks like. One shape, so the guards below can compose. */
type ToolRefusal = { content: { type: "text"; text: string }[]; isError: true };

const refuse = (text: string): ToolRefusal => ({
  content: [{ type: "text", text }],
  isError: true,
});

/**
 * THE PROVISIONING RUNG, asked once (§7).
 *
 * Four tools sit on it — `create_formation_party`, `create_company`, `update_company_party` and
 * `onboard_agent` — and every one of them spelled `if (!hasCapability(scope, "provision") ||
 * scope.entityId !== null) return { … "not authorized" … }` for itself. Both halves matter and
 * both are easy to half-write: "provision" is the top rung (these calls commit a tenant to a real
 * filing or provision a platform resource), and a TENANT-WIDE key is required because they create
 * something rather than acting on an existing entity — an entity-scoped key has no business
 * minting a second one. `null` = allowed.
 */
function requireProvisionTenantWide(scope: VerifiedKey): ToolRefusal | null {
  if (!hasCapability(scope, "provision") || scope.entityId !== null)
    return refuse("not authorized");
  return null;
}

/**
 * ⚠ AN `ssn` ARGUMENT IS REFUSED, on every tool that declares one (§4.1).
 *
 * The field is declared IN ORDER TO BE REFUSED: an undeclared field is not rejected by the SDK,
 * it is silently STRIPPED by the tool's zod schema before the handler runs — so a model that read
 * "US persons should supply an SSN" on the web form and helpfully passed one here would have got
 * back a success, with the number still sitting in the client's context window and its logs,
 * which is the entire harm §4.1 exists to prevent.
 *
 * Called FIRST in each handler, before any other validation, so the refusal is the whole answer
 * and nothing exists afterwards for the caller to clean up. `null` = no ssn was passed.
 */
function refuseSsn(args: unknown): ToolRefusal | null {
  return (args as { ssn?: unknown }).ssn !== undefined ? refuse(ssnNotOnThisDoorMessage()) : null;
}

/** Build a fresh, tenant-scoped MCP server. scope is closed over — never taken from a tool arg. */
export function buildMcpServer(scope: VerifiedKey, deps: McpToolDeps): McpServer {
  // The ACTING tools (fund_treasury/onboard_agent) enforce capability + entity scope, on top of the
  // tenant isolation shared by every tool below: fund_treasury requires "provision" capability and
  // `entityInScope`; onboard_agent requires "provision" capability AND a tenant-wide key (entityId ===
  // null), since it creates a new entity rather than acting on an existing one. "provision" is the top
  // rung of the capability ladder (read < earn < spend < provision) — these two tools move PLATFORM
  // funds / provision platform resources, a strictly higher privilege than "spend" (which only moves an
  // entity's own treasury funds). See back/docs/design/2026-07-20-s1-fund-treasury-authorization.md.
  // The read tools (get_job/list_jobs) enforce entityInScope. The P2a prerequisite (gate the acting
  // tools before the mint surface issues scoped keys) is resolved. See
  // back/docs/plans/2026-07-02-byoa-p2a-scope-and-reads.md.
  const tenantId = scope.tenantId;
  const { repo, runner } = deps;
  const server = new McpServer({ name: "project-alpha-brain", version: "1.0.0" });

  server.registerTool(
    "whoami",
    { title: "Who am I", description: "Return the authenticated tenant address." },
    async () => ({ content: [{ type: "text", text: tenantId }] }),
  );

  server.registerTool(
    "claim_connection",
    {
      title: "Claim connection",
      description:
        "Confirm this agent was intentionally linked to your legal body: submit the one-time link code from " +
        "the bootstrap page. Returns your tenant + entities (a binding confirmation, not a key).",
      inputSchema: { linkCode: z.string() },
    },
    async ({ linkCode }) => {
      // No capability gate: the tenant-scoped single-use consume IS the gate (a wrong-tenant
      // attempt fails uniformly and never burns the owner's code).
      if (!deps.linkCodes.consume(scope.tenantId, linkCode, Date.now()))
        return { content: [{ type: "text", text: "invalid or expired link code" }], isError: true };
      const entities = toEntityViews(repo.listByTenant(scope.tenantId), deps);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ tenantId: scope.tenantId, entities, bound: true }),
          },
        ],
      };
    },
  );

  server.registerResource(
    "agent-spec",
    "schema://agent-spec",
    {
      title: "AgentSpec schema",
      description: "JSON-schema for onboard_agent's spec argument",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(zodToJsonSchema(AgentSpecSchema)),
        },
      ],
    }),
  );

  server.registerTool(
    "list_entities",
    { title: "List entities", description: "List the caller's agent legal bodies." },
    async () => {
      const views = toEntityViews(
        repo
          .listByTenant(tenantId)
          .filter((e) => entityInScope(scope, e.idempotencyKey)), // an entity-scoped key lists only its entity
        deps,
      );
      return { content: [{ type: "text", text: JSON.stringify(views) }] };
    },
  );

  server.registerTool(
    "get_entity",
    {
      title: "Get entity",
      description: "Fetch one entity by id (idempotency key). Poll this after onboard_agent.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
        return { content: [{ type: "text", text: "entity not found" }], isError: true };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(toEntityView(rec, deps)),
          },
        ],
      };
    },
  );

  // Public verification: resolve any Novi Corpus agent by its ENS name and run the ENSIP-25
  // bidirectional check. Returns public data only (same as the ENS gateway serves), so no
  // capability/scope gate — a counterparty verifies an agent it does not own.
  server.registerTool(
    "resolve_agent",
    {
      title: "Resolve & verify an agent by ENS name",
      description:
        "Given a <publicId>.novicorpus.eth name, resolve the agent's public identity and run the ENSIP-25 bidirectional verification (ENS name <-> ERC-8004 registry on Arc): treasury, live legal status, and a verified verdict. Public data only; works for any Novi Corpus agent.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => {
      if (!deps.ens)
        return { content: [{ type: "text", text: "ENS not configured" }], isError: true };
      const suffix = `.${deps.ens.parentName}`.toLowerCase();
      const lname = name.toLowerCase();
      const label = lname.endsWith(suffix) ? lname.slice(0, lname.length - suffix.length) : lname;
      // Resolve vanity aliases exactly as the CCIP gateway does, or the two disagree.
      const aliases = deps.ens.labelAliases;
      const publicId =
        aliases && Object.hasOwn(aliases, label) ? (aliases[label] as string) : label;
      const rec = repo.findByPublicId(publicId);
      if (!rec)
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ name, resolved: false, reason: "unknown agent" }),
            },
          ],
        };

      let legalStatus = "unknown";
      let reverseName = "";
      let reverseVerified = false;
      if (deps.arc && rec.agentId) {
        try {
          const [status, paused] = await Promise.all([
            rec.proxy ? deps.arc.legalStatus(rec.proxy) : Promise.resolve(0),
            rec.treasury ? deps.arc.treasuryPaused(rec.treasury) : Promise.resolve(false),
          ]);
          legalStatus = status === 0 && !paused ? "Active" : "Suspended";
          const meta = await deps.arc.getAgentMetadata(BigInt(rec.agentId), "ens");
          reverseName = meta === "0x" ? "" : hexToString(meta);
          // Compare against the fully-qualified name: callers may pass a bare label, and the
          // on-chain record always stores `<label>.<parent>`.
          reverseVerified = reverseName.toLowerCase() === `${label}${suffix}`;
        } catch {
          // Degraded (Arc RPC issue): leave legalStatus "unknown" and reverse unverified.
        }
      }

      const verdict = {
        name,
        resolved: true,
        treasury: rec.treasury,
        operator: rec.operator,
        agentId: rec.agentId,
        legalStatus,
        registry: `eip155:${deps.ens.chainId}:${deps.ens.identityRegistry}`,
        ensip25: { forward: rec.agentId ? "1" : "", reverseName, reverseVerified },
        verified: Boolean(rec.treasury) && reverseVerified,
        note: reverseVerified
          ? "Bidirectional ENSIP-25 binding confirmed on-chain."
          : "Reverse binding not yet written on-chain (setMetadata(agentId,'ens',...)).",
      };
      return { content: [{ type: "text", text: JSON.stringify(verdict) }] };
    },
  );

  server.registerTool(
    "treasury_status",
    {
      title: "Treasury status",
      description: "Available balance, cap, paused, allowlist for one of your entities.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
        return { content: [{ type: "text", text: "entity not found" }], isError: true };
      if (!deps.payments)
        return { content: [{ type: "text", text: "payments unavailable" }], isError: true };
      const view = await deps.payments.status(rec);
      return { content: [{ type: "text", text: JSON.stringify(view) }] };
    },
  );

  server.registerTool(
    "pay",
    {
      title: "Pay",
      description:
        "Pay an x402 resource URL with USDC (atomic, 6 decimals), within your treasury's leash.",
      inputSchema: {
        id: z.string(),
        to: z.string(),
        amountUsdc: z.string(),
        idempotencyKey: z.string(),
      },
    },
    async ({ id, to, amountUsdc, idempotencyKey }) => {
      if (!hasCapability(scope, "spend"))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      // Decimal integers only — rejects hex ("0x10"), whitespace (" 100 "), exponential ("1e6"),
      // and decimals ("1.5") that BigInt() would otherwise silently accept. A leading "-" is still
      // allowed through so a negative amount reaches the <= 0n check below and gets the more
      // specific "must be positive" message rather than a generic format error.
      if (!/^-?\d+$/.test(amountUsdc))
        return { content: [{ type: "text", text: "invalid amountUsdc" }], isError: true };
      let amount: bigint;
      try {
        amount = BigInt(amountUsdc);
      } catch {
        return { content: [{ type: "text", text: "invalid amountUsdc" }], isError: true };
      }
      if (amount <= 0n)
        return { content: [{ type: "text", text: "amountUsdc must be positive" }], isError: true };
      if (!deps.payments)
        return { content: [{ type: "text", text: "payments unavailable" }], isError: true };
      const receipt = await deps.payments.pay(rec, {
        url: to,
        amountUsdc: amount,
        idempotencyKey,
        tenantId,
      });
      return { content: [{ type: "text", text: JSON.stringify(receipt) }], isError: !receipt.ok };
    },
  );

  server.registerTool(
    "fund_pocket",
    {
      title: "Fund pocket",
      description:
        "Top up your treasury's spending float (treasury -> operator -> pocket -> Gateway) so " +
        "`pay` can settle. Explicit only — never auto-triggered by pay. Costs on-chain gas + " +
        "Turnkey signatures. amountUsdc is atomic USDC (6 decimals).",
      inputSchema: { id: z.string(), amountUsdc: z.string() },
    },
    async ({ id, amountUsdc }) => {
      if (!hasCapability(scope, "spend"))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      // Same decimal-integer + positive validation as `pay` (atomic USDC, 6 decimals).
      if (!/^-?\d+$/.test(amountUsdc))
        return { content: [{ type: "text", text: "invalid amountUsdc" }], isError: true };
      let amount: bigint;
      try {
        amount = BigInt(amountUsdc);
      } catch {
        return { content: [{ type: "text", text: "invalid amountUsdc" }], isError: true };
      }
      if (amount <= 0n)
        return { content: [{ type: "text", text: "amountUsdc must be positive" }], isError: true };
      if (!deps.pocketFunding)
        return { content: [{ type: "text", text: "pocket funding unavailable" }], isError: true };
      try {
        const txHashes = await deps.pocketFunding(rec, amount);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, txHashes }) }] };
      } catch (e) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ ok: false, reason: (e as Error).message }) },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "run_job",
    {
      title: "Run job",
      description:
        "Have your agent earn USDC + reputation by running an ERC-8183 job (self-contained v1: the platform " +
        "stands in for the client + evaluator). Returns immediately with status 'pending'; poll get_job(jobKey).",
      inputSchema: { id: z.string(), budgetUsdc: z.string().optional() },
    },
    async ({ id, budgetUsdc }) => {
      if (!hasCapability(scope, "earn"))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      const rec = repo.findByIdempotencyKey(id);
      if (!rec || rec.ownerTenantId !== tenantId || !entityInScope(scope, id))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      const raw = budgetUsdc ?? "1.00";
      // At most 6 decimals (USDC precision): rejecting here keeps the error message uniform instead of
      // letting usdToUnits throw a different one deeper in.
      if (!/^\d+(\.\d{1,6})?$/.test(raw))
        return { content: [{ type: "text", text: "invalid budgetUsdc" }], isError: true };
      const budget = usdToUnits(raw);
      if (budget <= 0n)
        return { content: [{ type: "text", text: "budgetUsdc must be positive" }], isError: true };
      // Audit fix A: escrow is funded from the platform wallet (JOB_CLIENT_PRIVATE_KEY) and swept to
      // the caller's treasury — without these caps a loop of big-budget jobs drains platform USDC.
      if (budget > deps.maxJobBudget)
        return {
          content: [{ type: "text", text: "budgetUsdc exceeds the max job budget" }],
          isError: true,
        };
      const inflight = deps.jobs
        .listByTenant(tenantId)
        .filter((j) => !["completed", "reputed", "failed"].includes(j.status)).length;
      if (inflight >= deps.maxInflightJobsPerTenant)
        return {
          content: [{ type: "text", text: "too many jobs in flight, try again later" }],
          isError: true,
        };
      const jobKey = `${rec.idempotencyKey}:${Date.now()}-${randomUUID().slice(0, 8)}`;
      const { status } = deps.jobRunner.start({
        jobKey,
        entityKey: rec.idempotencyKey,
        tenantId,
        budget,
        description: "agent job (mcp)",
        clientAddress: deps.jobClientAddress,
        evaluatorAddress: deps.jobEvaluatorAddress,
        providerAddress: rec.operator ?? "0x",
      });
      return { content: [{ type: "text", text: JSON.stringify({ jobKey, status }) }] };
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description: "Fetch one job by jobKey (owned by you).",
      inputSchema: { jobKey: z.string() },
    },
    async ({ jobKey }) => {
      const rec = deps.jobs.findByKey(jobKey);
      if (!rec || rec.ownerTenantId !== scope.tenantId || !entityInScope(scope, rec.entityKey))
        return { content: [{ type: "text", text: "job not found" }], isError: true };
      return { content: [{ type: "text", text: JSON.stringify(toJobView(rec)) }] };
    },
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List jobs",
      description: "List jobs for one of your entities (id = entity idempotency key).",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      if (!entityInScope(scope, id))
        return {
          content: [{ type: "text", text: "entity not in this key's scope" }],
          isError: true,
        };
      const views = deps.jobs
        .listByEntity(id)
        .filter((j) => j.ownerTenantId === scope.tenantId)
        .map(toJobView);
      return { content: [{ type: "text", text: JSON.stringify(views) }] };
    },
  );

  server.registerTool(
    "fund_treasury",
    {
      title: "Fund treasury",
      description:
        "Fund a bound entity's treasury with atomic USDC (6 decimals), from the PLATFORM wallet. " +
        "Requires the provision capability.",
      inputSchema: { id: z.string(), amount: z.string() },
    },
    async ({ id, amount }) => {
      if (!hasCapability(scope, "provision"))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      if (!entityInScope(scope, id))
        return { content: [{ type: "text", text: "not found" }], isError: true };
      // Same decimal-integer + positive validation as `pay`/`fund_pocket` (atomic USDC, 6 decimals).
      // Rejects hex ("0x10") and a negative amount before it ever reaches runner.fund.
      if (!/^-?\d+$/.test(amount))
        return { content: [{ type: "text", text: "invalid amount" }], isError: true };
      let parsedAmount: bigint;
      try {
        parsedAmount = BigInt(amount);
      } catch {
        return { content: [{ type: "text", text: "invalid amount" }], isError: true };
      }
      if (parsedAmount <= 0n)
        return { content: [{ type: "text", text: "amount must be positive" }], isError: true };
      try {
        const { id: outId, status } = runner.fund({ id, tenantId, amount: parsedAmount });
        return { content: [{ type: "text", text: JSON.stringify({ id: outId, status }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    },
  );

  /**
   * PII intake, the MCP twin of POST /formation-party (design §5).
   *
   * Registered ONLY when the deployment forms entities: a tool that exists but always refuses
   * teaches an agent-first caller nothing, and a deployment with no formation has no business
   * exposing a PII surface at all.
   *
   * The identity travels in its OWN tool call, never inside `spec` — spec_json is persisted and
   * rendered — and the response is the handle alone: echoing the stored identity back would put
   * PII in a tool result, a transcript, and any client that logs them.
   *
   * ⚠ It DECLARES `ssn` IN ORDER TO REFUSE IT (§4.1), exactly like `create_company` and
   * `update_company_party`. This is the door a model reaches with an identity in hand, so it is
   * the likeliest of the three to be handed one — and an UNDECLARED field is not rejected by the
   * SDK, it is silently STRIPPED by the tool's zod parse before the handler runs. A model that
   * read "US persons should supply an SSN" on the web form and helpfully passed one here got back
   * a partyId, with the number thrown away and still sitting in the client's context window and
   * its logs, which is the entire harm §4.1 exists to prevent.
   *
   * Where it DOES belong: an SSN is sealed under an AAD of `party_id || company_id`, so it is
   * captured by `POST /companies` (which mints the pair) and re-captured by
   * `PATCH /companies/:companyId`. Never here, and never over MCP at all.
   */
  if (deps.formation)
    server.registerTool(
      "create_formation_party",
      {
        title: "Create formation party",
        description: `Register the legal identity of the natural person your agent's legal entity will be filed under, and get back an opaque partyId to pass to create_company. ${formationCapabilityNote(deps)} Personal data belongs ONLY in this call — never in create_company's arguments and never in onboard_agent's spec. A real party requires legalFirstName, legalLastName, email, PHONE and address (doola will not file a responsible party without a phone number). ⚠ It NEVER takes an SSN, and never will — an SSN in a tool argument would sit in this client's context window and its logs; the field is declared only so that passing one is REFUSED rather than silently dropped. An SSN is collected only by the web form (POST /companies), which mints the (party, company) pair it is sealed under. The response contains the handle and nothing else.`,
        inputSchema: {
          /** The sandbox shortcut: no personal data at all. */
          synthetic: z.boolean().optional(),
          legalFirstName: z.string().optional(),
          legalLastName: z.string().optional(),
          email: z.string().optional(),
          /** Optional HERE only because the synthetic shortcut passes no fields at all; a real
           *  party without one is refused by `FormationPartySchema` (C6) — doola will not file
           *  a responsible party with no phone. */
          phone: z.string().optional(),
          address: z.record(z.unknown()).optional(),
          /** ⚠ DECLARED IN ORDER TO BE REFUSED (§4.1) — see the block comment above. */
          ssn: z.string().optional(),
        },
      },
      async (args) => {
        // "provision" — the same rung onboard_agent sits on, and for the same reason: this call
        // is a step of provisioning a legal body, and it commits the tenant to a real filing. Then
        // the ssn, BEFORE anything is created, so the refusal is the whole answer and nothing
        // exists afterwards for the caller to clean up. Same order, same sentence, as the other
        // two PII doors.
        const denied = requireProvisionTenantWide(scope) ?? refuseSsn(args);
        if (denied) return denied;
        try {
          // `ssn` is destructured OUT as well as refused above: `FormationPartySchema` is
          // `.strict()`, so a key that reached it would be a validation error rather than the
          // sentence that says where the field belongs.
          const { synthetic, ssn: _ssn, ...body } = args as Record<string, unknown>;
          // The synthetic shortcut carries no PII, so it is never parsed as a party body.
          const parsed = synthetic === true ? undefined : FormationPartySchema.parse(body);
          const result = createFormationParty(
            {
              parties: deps.formation!.parties,
              sandboxSyntheticPii: deps.formation!.sandboxSyntheticPii,
            },
            tenantId,
            { synthetic, parsed },
          );
          if ("error" in result)
            return { content: [{ type: "text", text: result.error }], isError: true };
          opsLog("formation_party_created", {
            tenantId: truncateTenant(tenantId),
            partyId: result.partyId,
          });
          return { content: [{ type: "text", text: JSON.stringify({ partyId: result.partyId }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: (e as Error).message }], isError: true };
        }
      },
    );

  /**
   * `update_company_party` — the MCP twin of `PATCH /companies/:companyId/party` (design §7, A3).
   *
   * The one door that reopens a company doola refused on its PARTY, and it exists on BOTH
   * surfaces because an agent-first caller who registered an identity through
   * `create_formation_party` can equally have it refused, and a park with a browser-only exit is
   * a park an agent cannot leave.
   *
   * ⚠ ADDRESSED BY COMPANY. It took a `partyId` first, which let a mistyped handle rewrite the
   * responsible person of a DIFFERENT company mid-filing — a rule to enforce rather than a
   * sentence nobody can write. The party is resolved from the company's UNIQUE `company_id`, and
   * `companyId` is the id `get_company` already hands the caller for the park it is fixing.
   *
   * ⚠ It takes NO `ssn`, and — exactly like `create_company` — the field is DECLARED so that
   * passing one is refused rather than silently stripped (A2's finding 1, and this door reached
   * the same bug on its own: the first version left `ssn` undeclared on the reasoning that
   * nothing an SSN could mean here, and a test proved that a model passing one got back a
   * success while the number sat in its context window and its logs. "There was nothing it could
   * mean" is precisely why the caller has to be TOLD, not quietly agreed with.)
   *
   * Where it does belong: an SSN is sealed under an AAD of `party_id || company_id`, so it is
   * captured by `POST /companies` (which mints the pair) and re-captured by
   * `PATCH /companies/:companyId`. Never here, and never over MCP at all.
   */
  if (deps.formation)
    server.registerTool(
      "update_company_party",
      {
        title: "Update the company's responsible party",
        description: `Correct the legal identity of the responsible person on a filing the provider REFUSED — the one exit from a company parked on awaitingPartyEdit (see get_company). It is addressed by companyId: the party is the one this company was filed with, so no other company's person can be touched. Editable only until the filing has been sent: once the provider has the person, it is never asked for them again, and an edit here would change our copy and nothing else. Takes the same identity fields as create_formation_party and NEVER an ssn — an SSN is collected only by the web form, which is also the only place it can be re-captured. ${formationCapabilityNote(deps)} The response contains the handle and nothing else.`,
        inputSchema: {
          companyId: z.string(),
          legalFirstName: z.string(),
          legalLastName: z.string(),
          email: z.string(),
          /** REQUIRED, exactly as at intake (C6): doola will not file a party with no phone. */
          phone: z.string(),
          address: z.record(z.unknown()),
          /** ⚠ DECLARED IN ORDER TO BE REFUSED (§4.1) — see the block comment above. */
          ssn: z.string().optional(),
        },
      },
      async (args) => {
        // The same rung `create_formation_party` sits on: this call decides whose identity a real
        // Wyoming filing names. And the ssn refusal BEFORE anything else, so it is the whole
        // answer — same order, same sentence, as `create_company`.
        const denied = requireProvisionTenantWide(scope) ?? refuseSsn(args);
        if (denied) return denied;
        try {
          const { companyId, ssn: _ssn, ...rest } = args as Record<string, unknown>;
          // The SAME `.strict()` schema the create parses, so a field one door refuses cannot be
          // quietly accepted by the other — and an `ssn` key is refused BY that strictness rather
          // than by a check somebody has to remember to write.
          const body = FormationPartySchema.parse(rest);
          const result = updateCompanyParty(
            {
              ...deps.formation!.companyDeps,
              transaction: (fn) => deps.repo.transaction(fn),
            },
            tenantId,
            companyId as string,
            // The SAME wire→column mapping the REST door and the create use.
            partyFieldsOf(body),
          );
          if ("error" in result)
            return { content: [{ type: "text", text: result.error }], isError: true };
          return { content: [{ type: "text", text: JSON.stringify({ partyId: result.partyId }) }] };
        } catch (e) {
          return { content: [{ type: "text", text: (e as Error).message }], isError: true };
        }
      },
    );

  /**
   * COMPANIES over MCP (design §7). The same domain function the REST door calls.
   *
   * `create_formation_party` STAYS its own call: the bind CAS needs a party row that already
   * exists, and personal data must never ride in a spec-shaped tool argument. This tool takes the
   * partyId that one returns.
   *
   * ⚠ It takes NO `ssn`, deliberately and permanently (§4.1). An SSN in an MCP tool argument
   * would sit in an LLM client's context window and in its logs; the web form is the only place
   * one is ever collected.
   */
  if (deps.formation) {
    server.registerTool(
      "create_company",
      {
        title: "Create company",
        description: createCompanyDescription(deps),
        inputSchema: {
          partyId: z.string(),
          /** THREE ranked candidates (§5). */
          names: z.array(z.string()).length(3),
          /** The COMPANY's own purpose — the agent's description is no longer doola-visible. */
          businessPurpose: z.string(),
          /** One of the shipped NAICS labels. */
          industryLabel: z.string(),
          /** The sandbox deployment's marker, checked against this box's own setting. */
          synthetic: z.boolean().optional(),
          /**
           * ⚠ DECLARED IN ORDER TO BE REFUSED (§4.1), and for no other reason.
           *
           * This door never takes an SSN. But an UNDECLARED field is not rejected by the SDK — it
           * is SILENTLY STRIPPED before the handler ever sees it, because the tool's zod schema
           * parses the arguments and discards what it does not know. So a model that reads "US
           * persons should supply an SSN" on the web form and helpfully passes one here would
           * have got back a companyId, filed under the slow EIN route, with no indication that
           * the field had been thrown away — and with the number still sitting in the client's
           * context window and its logs, which is the entire harm §4.1 exists to prevent.
           *
           * Declaring it is what turns a silent strip into a loud refusal that says where the
           * field DOES belong.
           */
          ssn: z.string().optional(),
        },
      },
      async ({ partyId, names, businessPurpose, industryLabel, synthetic, ssn }) => {
        // The rung, then the ssn — the latter BEFORE anything is created and before any other
        // validation, so the refusal is the whole answer and nothing exists afterwards for the
        // caller to have to clean up.
        const denied = requireProvisionTenantWide(scope) ?? refuseSsn({ ssn });
        if (denied) return denied;
        try {
          const result = createCompany(
            // The composition root's ONE dependency set; this door supplies only its transaction.
            {
              ...deps.formation!.companyDeps,
              transaction: (fn) => deps.repo.transaction(fn),
            },
            tenantId,
            {
              partyId,
              names,
              businessPurpose,
              industryLabel,
              synthetic: synthetic === true ? true : undefined,
            },
          );
          if ("error" in result)
            return { content: [{ type: "text", text: result.error }], isError: true };
          return {
            content: [
              {
                type: "text",
                // The QUOTE rides along when this deployment charges (§6.1), in the SAME shape
                // REST returns — a parity test asserts the key sets are identical, because an
                // agent that got a companyId with no mention of a fee would report a company as
                // created and leave a guardian with an unfileable draft.
                text: JSON.stringify(
                  result.quote
                    ? { companyId: result.companyId, payment: result.quote }
                    : { companyId: result.companyId },
                ),
              },
            ],
          };
        } catch (e) {
          return { content: [{ type: "text", text: (e as Error).message }], isError: true };
        }
      },
    );
  }

  /**
   * THE PAYMENT TOOLS (design §6, MCP parity).
   *
   * Registered only where this deployment CHARGES — a box in the beta has no payment resource at
   * all, and an agent must not discover a tool whose every call would 404.
   *
   * ⚠ NO PII rides on any of them, and none is possible: a signature, an address and a company
   * handle are the whole surface. The guardian's SIGNATURE, though, is the one thing an agent
   * cannot produce for itself — it comes from a wallet a human controls — which is why
   * `create_company`'s answer says so and `submit_company_payment` takes the signature as an
   * argument rather than pretending to obtain one.
   */
  const paymentRunner = (company: import("../persistence/companyRepository").CompanyRecord) => {
    const payment = deps.formation?.payment;
    const executor = deps.formation?.paymentExecutor;
    if (!payment?.required || !executor || !deps.companies) return undefined;
    return {
      companies: deps.companies,
      entities: deps.repo,
      payment,
      // The request path's wait (finding B3), same as REST: an MCP client is a caller waiting on
      // a tool result, and `pending` + "poll get_company_payment" is the honest answer.
      executor: { ...executor, receiptTimeoutMs: ROUTE_RECEIPT_TIMEOUT_MS },
      transaction: <T>(fn: () => T) => deps.repo.transaction(fn),
      now: deps.now,
      company,
    };
  };

  /** Own the company, on the same terms `get_company` does — and narrow an entity-scoped key to
   *  the one company its agent is filed under. One helper, three tools. */
  const ownedCompany = (companyId: string) => {
    const company = deps.companies?.findOwned(tenantId, companyId);
    const only = scopedCompanyId(scope, deps.repo);
    if (!company || (only !== null && company.companyId !== only)) return undefined;
    return company;
  };

  if (deps.formation?.payment?.required && deps.companies) {
    server.registerTool(
      "get_company_payment",
      {
        title: "Get company payment",
        description:
          "What this company owes for its formation, and what has happened to the payment so far. While a quote is live and unexpired the answer carries `quote.typedData` — the exact EIP-712 message the GUARDIAN's wallet must sign (we cannot sign it; it authorizes a transfer of their USDC). A `settling` payment carries no quote on purpose: signing again while a broadcast is in flight would charge the guardian twice. Statuses: quoted (owed), settling (broadcast, outcome pending), settled (paid), expired (the window closed — request a new quote), failed (the transfer reverted on-chain), refunded.",
        inputSchema: { companyId: z.string() },
      },
      async ({ companyId }) => {
        if (!hasCapability(scope, "read")) return refuse("not authorized");
        const company = ownedCompany(companyId);
        if (!company) return refuse("company not found");
        const payment = deps.formation!.payment!;
        const row = payment.payments.findCurrent(company.companyId, FORMATION_PRODUCT);
        if (!row) return refuse("no payment for this company");
        const now = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(paymentView(row, guardianOf(company), payment, now)),
            },
          ],
        };
      },
    );

    server.registerTool(
      "submit_company_payment",
      {
        title: "Submit company payment",
        description:
          "Submit the guardian's signature over the quote from get_company_payment, so we can put the transfer on-chain and the company becomes fileable. `signature` is what their wallet returned for `quote.typedData`; `from` is the guardian's address, which must be the wallet this company is owned by. Nothing else is accepted from you: the amount, the payee, the nonce and the expiry all come from the stored quote, so this call cannot change what is paid or to whom. Answers `settled` when the receipt confirmed, or `pending` when the transaction is in flight — in which case poll get_company_payment rather than signing again.",
        inputSchema: { companyId: z.string(), signature: z.string(), from: z.string() },
      },
      async ({ companyId, signature, from }) => {
        const denied = requireProvisionTenantWide(scope);
        if (denied) return denied;
        const company = ownedCompany(companyId);
        if (!company) return refuse("company not found");
        const runner = paymentRunner(company);
        if (!runner) return refuse("this deployment does not take formation payments");
        const result = await withKeyedLock(`payment:${company.companyId}`, () =>
          settleFormationPayment(runner, company, {
            signature: signature as `0x${string}`,
            from: from as `0x${string}`,
          }),
        );
        if (!result.ok) return refuse(result.reason);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: result.status, txHash: result.txHash }),
            },
          ],
        };
      },
    );

    server.registerTool(
      "requote_company_payment",
      {
        title: "Re-quote company payment",
        description:
          "Ask for a NEW quote, with a new nonce, after the previous one ended without paying — expired, or a transfer that reverted. Deliberately its own call and not part of cancel: it is REFUSED while any payment is live, because issuing a second quote while the first authorization can still be mined is how a guardian gets charged twice. If this refuses with 'still settling', poll get_company_payment; if it refuses with 'a live quote', that quote is the one to sign.",
        inputSchema: { companyId: z.string() },
      },
      async ({ companyId }) => {
        const denied = requireProvisionTenantWide(scope);
        if (denied) return denied;
        const company = ownedCompany(companyId);
        if (!company) return refuse("company not found");
        const runner = paymentRunner(company);
        if (!runner) return refuse("this deployment does not take formation payments");
        // The keyed lock, as on the other two: a re-quote races a settle for the same company,
        // and the live-rows index is the backstop rather than the first line.
        const result = await withKeyedLock(`payment:${company.companyId}`, async () =>
          requoteFormationPayment(runner, company),
        );
        if (!result.ok) return refuse(result.reason);
        return { content: [{ type: "text", text: JSON.stringify(result.quote) }] };
      },
    );

    server.registerTool(
      "cancel_company_payment",
      {
        title: "Cancel company payment",
        description:
          "Withdraw a formation payment that is stuck, using a SECOND signature from the guardian — over `CancelAuthorization(authorizer, nonce)` against the USDC token's domain, with the nonce from get_company_payment. We cannot do this alone: the token verifies the guardian's signature, because the authorization is their promise and only they may take it back. Once it confirms, the payment is expired immediately and a new quote can be requested.",
        inputSchema: { companyId: z.string(), signature: z.string() },
      },
      async ({ companyId, signature }) => {
        const denied = requireProvisionTenantWide(scope);
        if (denied) return denied;
        const company = ownedCompany(companyId);
        if (!company) return refuse("company not found");
        const runner = paymentRunner(company);
        if (!runner) return refuse("this deployment does not take formation payments");
        const result = await withKeyedLock(`payment:${company.companyId}`, () =>
          cancelFormationPayment(runner, company, { signature: signature as `0x${string}` }),
        );
        if (!result.ok) return refuse(result.reason);
        return {
          content: [
            { type: "text", text: JSON.stringify({ status: "expired", txHash: result.txHash }) },
          ],
        };
      },
    );
  }

  /**
   * `list_companies` is registered wherever a COMPANY STORE is, exactly like REST
   * `GET /companies` — and deliberately not under `deps.formation` as it was.
   *
   * Reading the legal bodies you already own is not a formation capability: a box whose doola
   * credentials have been pulled still holds real Wyoming LLCs, and an agent surface that cannot
   * name them while the browser can is the silent asymmetry `EntityViewDeps` was made one object
   * to prevent. `create_company` stays gated on `deps.formation`, because that one spends money.
   */
  if (deps.companies) {
    server.registerTool(
      "list_companies",
      {
        title: "List companies",
        description:
          "List the legal bodies you own, NEWEST FIRST — the same ordering the web picker defaults to. Each row carries its filing status, how many agents share it, and the name candidates it was filed under. Attaching a new agent to one of these is free; pass its companyId to onboard_agent.",
        inputSchema: {},
      },
      async () => {
        if (!hasCapability(scope, "read"))
          return { content: [{ type: "text", text: "not authorized" }], isError: true };
        // The SAME projection REST `GET /companies` renders — literally the same function,
        // because the two are one API-level contract (the picker's ordering and its labels) and
        // two literals is how the agent surface quietly ended up dropping the business purpose,
        // the industry and both filing facts.
        const rows = listCompanyViews({ ...deps, companies: deps.companies! }, tenantId);
        // …and then `entityInScope`'s rule, one key along: a key minted for ONE agent lists the
        // one company that agent is filed under, never its tenant's whole fleet.
        const only = scopedCompanyId(scope, deps.repo);
        const companies = only === null ? rows : rows.filter((r) => r.companyId === only);
        return { content: [{ type: "text", text: JSON.stringify({ companies }) }] };
      },
    );
  }

  /**
   * `get_company` — the MCP twin of REST `GET /companies/:companyId`, rendered by the SAME
   * function over the SAME dependency object (§7).
   *
   * Registered beside `list_companies` and gated the same way, on the company STORE rather than
   * on `deps.formation`: reading the legal bodies you already own is not a formation capability.
   *
   * A parity test asserts the two doors answer with an identical key set. That is not ceremony —
   * `list_companies` had already silently drifted from `GET /companies` once, dropping the
   * business purpose, the industry and both filing facts, and nothing failed: the agent surface
   * was simply less true than the browser one.
   */
  if (deps.companies) {
    server.registerTool(
      "get_company",
      {
        title: "Get company",
        description:
          "Fetch one of your legal bodies in full: its filing state, the documents filed for it, the agents attached to it, and — if the filing has STOPPED — which of the three human decisions it is waiting on. A parked company does nothing until its owner acts: awaitingIntakeEdit is fixed by re-submitting names/purpose/industry, awaitingPartyEdit by correcting the responsible party, awaitingSsnDecision by re-supplying an SSN or confirming the slower EIN route. The last two go through the web form and update_company_party respectively; an SSN is never an argument here.",
        inputSchema: { companyId: z.string() },
      },
      async ({ companyId }) => {
        if (!hasCapability(scope, "read"))
          return { content: [{ type: "text", text: "not authorized" }], isError: true };
        // Tenant-scoped, and the SAME uniform answer REST gives: unknown and not-yours are one
        // reply, or the tool becomes an existence oracle over other tenants' company ids.
        const company = deps.companies!.findOwned(tenantId, companyId);
        // …and an ENTITY-scoped key reads only the company its own agent is filed under, with the
        // SAME uniform answer for "not yours" — a third reply here would make the tool an oracle
        // over the rest of its own tenant's fleet, which is precisely what narrowing a key is for.
        const only = scopedCompanyId(scope, deps.repo);
        if (!company || (only !== null && company.companyId !== only))
          return { content: [{ type: "text", text: "company not found" }], isError: true };
        const view = toCompanyDetailView({ ...deps, companies: deps.companies! }, company);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                only === null
                  ? view
                  : {
                      ...view,
                      // WHICH agents share the filing is withheld; HOW MANY is not. The count is
                      // already on this key's own `get_entity` (`sharedWith`), so redacting it
                      // would buy nothing and a `1` here would be a lie.
                      attachedAgents: view.attachedAgents.filter((a) => a.id === scope.entityId),
                    },
              ),
            },
          ],
        };
      },
    );
  }

  server.registerTool(
    "onboard_agent",
    {
      title: "Onboard agent",
      description: `Create an agent legal body. spec must match schema://agent-spec; the guardian is set automatically to your tenant and the manager is set automatically to the platform manager account — you don't need to know or supply either. passkeyId references a previously stored guardian passkey (POST /passkey). custody optionally picks the operator key custody: 'circle' (Novi-managed smart account, gasless) or 'turnkey' (guardian-passkey-rooted key vault) — omitted uses the platform default ${custodyCapabilityNote(deps)} companyId attaches this agent to a company you already own and is REQUIRED wherever formation is: attaching is free, and a company is created at its own door (create_company, after create_formation_party) — see list_companies for the ones you have. partyId is NOT accepted here and never will be; passing one is refused, not ignored. Never put personal data in spec. ${formationCapabilityNote(deps)} Returns immediately with status 'pending' — poll get_entity until 'bound'. Requires the provision capability and a tenant-wide key.`,
      inputSchema: {
        spec: z.record(z.unknown()),
        passkeyId: z.string(),
        idempotencyKey: z.string().optional(),
        custody: z.enum(["turnkey", "circle"]).optional(),
        /**
         * ⚠ DECLARED IN ORDER TO BE REFUSED (A3), exactly like `ssn` on `create_company`.
         *
         * A1's shim minted a 1:1 company for a party-only onboard; A3 removed it, so this door
         * attaches and never creates. An UNDECLARED field is not rejected by the SDK — it is
         * silently STRIPPED before the handler runs, because the tool's zod schema discards what
         * it does not know. A model that had just called `create_formation_party` and passed the
         * handle here would therefore have got back an entity id, with nothing filed and no
         * indication that the identity it registered was going nowhere.
         */
        partyId: z.string().optional(),
        companyId: z.string().optional(),
      },
    },
    async ({ spec, passkeyId, idempotencyKey, custody, partyId, companyId }) => {
      const denied = requireProvisionTenantWide(scope);
      if (denied) return denied;
      const passkey = deps.passkeys.get(tenantId, passkeyId);
      if (!passkey)
        return { content: [{ type: "text", text: "passkey handle not found" }], isError: true };
      try {
        // Tier-0 custody: same resolution, availability gates, and ORDER as the REST /onboard
        // route — gate before the World check and spec parse, circle first, so a request that is
        // both invalid-spec and unavailable-custody gets the same primary error on both surfaces.
        const resolvedCustody = custody ?? deps.walletProviderDefault;
        if (resolvedCustody === "circle" && !deps.circleCustodyAvailable)
          return {
            content: [{ type: "text", text: custodyUnavailableMessage("circle") }],
            isError: true,
          };
        if (resolvedCustody === "turnkey" && !deps.turnkeyCustodyAvailable)
          return {
            content: [{ type: "text", text: custodyUnavailableMessage("turnkey") }],
            isError: true,
          };
        // Formation gate: AFTER custody, BEFORE the World check — the SAME order as the REST
        // /onboard route, running the SAME function (src/formation.ts), so a request that is both
        // company-less and unattachable gets the identical primary error on both surfaces.
        //
        // `partyId` stays DECLARED in the schema below in order to be REFUSED here (A3, and the
        // same argument as `ssn` on create_company): an undeclared field is silently stripped by
        // the SDK's zod parse, so a model passing one would have got back an entity id with no
        // indication that the legal identity it had just registered was never going to be filed.
        const formationRefusal = formationDoorRefusal(deps, { tenantId, partyId, companyId });
        if (formationRefusal)
          return { content: [{ type: "text", text: formationRefusal }], isError: true };
        // Mirror of the REST gate: when World enforcement is on, the guardian must be a
        // World-ID-verified unique human under the per-human entity cap.
        assertGuardianAllowed(deps.worldId, tenantId);
        const raw = spec as Record<string, unknown>;
        const roles = {
          ...((raw.roles as object) ?? {}),
          guardian: tenantId,
          manager: deps.platformManagerAddress,
        };
        const parsed = AgentSpecSchema.parse({ ...raw, roles });
        const userKey = idempotencyKey && idempotencyKey.length > 0 ? idempotencyKey : parsed.name;
        const { id, status } = deps.runner.start({
          spec: parsed,
          userKey,
          tenantId,
          guardianPasskey: passkey,
          custody: resolvedCustody,
          companyId,
        });
        return { content: [{ type: "text", text: JSON.stringify({ id, status }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: (e as Error).message }], isError: true };
      }
    },
  );

  return server;
}
