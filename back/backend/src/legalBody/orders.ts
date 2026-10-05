import type { Address, Hex } from "viem";
import type { LegalBodyChainPort } from "../adapters/arc/legalBodyChain";
import { type WorldIdDeps, assertRealHuman } from "../api/routes/worldId";
import { ApiError } from "../errors";
import { opsLog } from "../observability/opsLog";
import { withKeyedLock } from "../payments/keyedMutex";
import type { CompanyCheckRepository } from "../persistence/companyCheckRepository";
import type { CompanyDeclarationRepository } from "../persistence/companyDeclarationRepository";
import type { CompanyRepository } from "../persistence/companyRepository";
import type { DocumentStore } from "../persistence/documentStore";
import type {
  BindingState,
  Deployment,
  LegalBodyRecord,
  LegalBodyRepository,
} from "../persistence/legalBodyRepository";
import { buildAgreement, storeAgreement } from "./agreement";
import { publicCompanyNames } from "./attestation";
import { CUSTOMER_PROVIDER } from "./provider";
import { refusal } from "./sentences";
import { LegalTextNotApprovedError, assertTextsServable } from "./texts/index";
import { LEGAL_BODY_OPERATING_AGREEMENT } from "./texts/operatingAgreement";

/**
 * LEGAL-BODY ORDERS: what a guardian orders, and the rules every door of the flow shares.
 *
 * An order is a `legal_bodies` row. It is born a `draft` for a company of its tenant, with its
 * operating agreement built, stored and frozen in the same transaction, so no draft ever exists
 * without the agreement the identity owner's link will sign. From there the link door reserves
 * it, the create deploys it and the binding check links it; this module holds what they all use:
 *  - the deps of every door (`LegalBodyOrderDeps`);
 *  - the one boundary between a door and the chain (`chainCall`);
 *  - the doors' throttles (`takeDoorTokens`);
 *  - the one rule of which company may stand behind a body (`companyEligible`);
 *  - the order's view, which serialises as it is (no bigint).
 *
 * A row made under another factory or chain than this deployment's is read-only here: it is
 * served, and every action on it answers 409 `other_deployment`.
 */

export interface LegalBodyOrderDeps {
  repo: LegalBodyRepository;
  companies: CompanyRepository;
  declarations: CompanyDeclarationRepository;
  checks: CompanyCheckRepository;
  world: WorldIdDeps | undefined;
  chain: LegalBodyChainPort;
  docStore: DocumentStore;
  /** The factory and chain new orders are made for, and the only ones an action may touch. */
  deployment: Deployment;
  /** The ERC-8004 identity registry the agreement names. */
  identityRegistry: Address;
  environment: "sandbox" | "production";
  /** Seconds: the amendment delay of every new order. */
  amendmentDelaySeconds: number;
  maxOpenPerTenant: number;
  maxOrdersPerTenantPerDay: number;
  maxCreatesPerTenantPerDay: number;
  maxCreatesPerDay: number;
  /** The legal-body doors' own budget, shared with nothing else. */
  doorBudget: { take(): boolean };
  tenantBucket: (tenantId: string) => { take(): boolean };
  identityBucket: (key: string) => { take(): boolean };
  /** One IMMEDIATE transaction on the database the repositories write to. */
  transaction: <T>(fn: () => T) => T;
  /** Unix milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to a `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** The key of an order's lock: the doors and the sweeper take this one, so each order has one
 *  writer at a time. */
export const orderLockKey = (legalBodyId: string) => `legal-body:${legalBodyId}`;

/**
 * The one boundary between a door and the chain.
 *
 * An `ApiError` passes as it is: it is an answer the door chose. Any other throw becomes the 503
 * `chain_unavailable`, after one log line that names the order, the stage and the error's NAME.
 * Never its message: a transport error's message can carry the node's URL, and an error with a
 * numeric `status` would otherwise be rendered with that message by the app's error handler.
 */
export async function chainCall<T>(
  orderId: string | undefined,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    opsLog("legal_body_chain_unavailable", {
      level: "warn",
      orderId: orderId ?? null,
      stage,
      errorName: err instanceof Error ? err.name : "not_an_error",
    });
    throw refusal("chain_unavailable", 503);
  }
}

/** Tenant bucket, then the doors' budget; either empty is a 429. */
export function takeDoorTokens(deps: LegalBodyOrderDeps, tenantId: string): void {
  // In this order, and the second only when the first gave a token: a tenant that has spent its
  // own bucket does not spend the budget every other tenant shares.
  if (!deps.tenantBucket(tenantId).take() || !deps.doorBudget.take())
    throw refusal("rate_limited", 429);
}

/** An order as the API shows it: ids, hex, decimals and numbers, never a bigint. */
export interface LegalBodyOrderView {
  id: string;
  publicId: string;
  companyId: string;
  state: BindingState;
  chainId: number;
  factory: Address;
  guardian: Address;
  /** Seconds. */
  amendmentDelay: number;
  agreement: { hash: Hex; version: number } | null;
  /** A uint256 in decimal. */
  agentId: string | null;
  identityOwner: Address | null;
  bodyAddress: Address | null;
  /** Unix seconds, like `deployedAt` and `pointerSeenAt`. */
  linkDeadline: number | null;
  createTxHash: Hex | null;
  deployedAt: number | null;
  pointerSeenAt: number | null;
  /** ISO 8601, in UTC and marked so: `YYYY-MM-DDTHH:MM:SSZ`. */
  createdAt: string;
}

export function toOrderView(row: LegalBodyRecord): LegalBodyOrderView {
  return {
    id: row.legalBodyId,
    publicId: row.publicId,
    companyId: row.companyId,
    state: row.bindingState,
    chainId: row.chainId,
    factory: row.factory,
    guardian: row.guardian,
    amendmentDelay: row.amendmentDelay,
    agreement:
      row.oaManifestHash !== null && row.oaManifestVersion !== null
        ? { hash: row.oaManifestHash, version: row.oaManifestVersion }
        : null,
    agentId: row.agentId,
    identityOwner: row.identityOwner,
    bodyAddress: row.bodyAddress,
    linkDeadline: row.linkDeadline,
    createTxHash: row.createTxHash,
    deployedAt: row.deployedAt,
    pointerSeenAt: row.pointerSeenAt,
    // The stored text is UTC with no zone marker, which a reader would take for local time.
    createdAt: `${row.createdAt.replace(" ", "T")}Z`,
  };
}

/**
 * The one rule of which company may stand behind a legal body: a customer's own company, not
 * abandoned, whose latest check passed. A failed, revoked or reinstated company waits for a new
 * passed check; a company filed through formation is never eligible here.
 */
export function companyEligible(deps: LegalBodyOrderDeps, companyId: string): boolean {
  const company = deps.companies.find(companyId);
  if (company === undefined) return false;
  if (company.provider !== CUSTOMER_PROVIDER || company.status === "abandoned") return false;
  return deps.checks.latest(companyId)?.result === "passed";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Orders a legal body for a company of the tenant, in this order:
 *  1. a real human: a verified credential, never a waiver;
 *  2. the agreement's wording can be served (a production deployment refuses a draft);
 *  3. the company is the tenant's (one 404 for unknown and not-yours) and eligible;
 *  4. the agreement is built, before anything is written. It names the company by the declared
 *     name and filing number its passed check stands behind, and nothing else;
 *  5. one transaction: the two caps are counted, the draft is created, the agreement is stored
 *     and frozen, and the tenant's `ordered` note is written.
 * A throw anywhere in step 5 rolls the row back. The files are written inside it, so a failure
 * after they were written leaves at most two orphan files, named by an id no row holds.
 */
export function createOrder(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  input: { companyId: string },
): LegalBodyOrderView {
  const nowMs = (deps.now ?? Date.now)();

  // 1.
  assertRealHuman(deps.world, tenantId, deps.environment);

  // 2.
  try {
    assertTextsServable(deps.environment, [LEGAL_BODY_OPERATING_AGREEMENT]);
  } catch (err) {
    if (err instanceof LegalTextNotApprovedError) throw refusal("legal_text_not_approved", 503);
    throw err;
  }

  // 3.
  const companyId = typeof input?.companyId === "string" ? input.companyId : undefined;
  if (companyId === undefined || deps.companies.findOwned(tenantId, companyId) === undefined)
    throw refusal("not_found", 404);
  if (!companyEligible(deps, companyId)) throw refusal("company_not_eligible", 409);

  // 4. A declaration erased, or paired with another company's check, names nothing.
  const names = publicCompanyNames(
    deps.declarations.find(companyId),
    deps.checks.latest(companyId),
  );
  if (names === null) throw refusal("company_not_eligible", 409);
  const built = buildAgreement(
    {
      companyName: names.legalName,
      filingNumber: names.filingNumber,
      jurisdiction: "WY",
      guardian: tenantId,
      amendmentDelaySeconds: deps.amendmentDelaySeconds,
      chainId: deps.deployment.chainId,
      factory: deps.deployment.factory,
      identityRegistry: deps.identityRegistry,
    },
    LEGAL_BODY_OPERATING_AGREEMENT,
  );

  // 5. The caps are counted inside the transaction that writes, which holds the write lock from
  //    its first statement: another writer cannot add an order between the count and the insert.
  const row = deps.transaction((): LegalBodyRecord => {
    if (deps.repo.countOpenByTenant(tenantId, nowMs) >= deps.maxOpenPerTenant)
      throw refusal("legal_body_cap", 409);
    if (
      deps.repo.countOrdersCreatedByTenant(tenantId, nowMs - DAY_MS) >=
      deps.maxOrdersPerTenantPerDay
    )
      throw refusal("legal_body_orders", 429);
    const created = deps.repo.create({
      tenantId,
      companyId,
      chainId: deps.deployment.chainId,
      factory: deps.deployment.factory,
      amendmentDelay: deps.amendmentDelaySeconds,
    });
    const id = created.legalBodyId;
    storeAgreement(deps.docStore, id, built);
    if (!deps.repo.freezeAgreement(id, { hash: built.manifestHash, version: built.version }))
      throw new Error(`legal body ${id}: the new draft did not take its agreement`);
    deps.repo.recordEvent(id, "note", "tenant", null, { act: "ordered" });
    const frozen = deps.repo.findById(id);
    if (frozen === undefined) throw new Error(`legal body ${id} vanished inside its own order`);
    return frozen;
  });
  return toOrderView(row);
}

/** The tenant's order, or the uniform 404: unknown and not-yours get one answer, so no door is an
 *  existence oracle over other tenants' ids. */
export function requireOwnedOrder(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  id: string,
): LegalBodyRecord {
  const row = deps.repo.findOwned(tenantId, id);
  if (row === undefined) throw refusal("not_found", 404);
  return row;
}

/** A row made under another factory or chain is read-only here. */
function assertThisDeployment(deps: LegalBodyOrderDeps, row: LegalBodyRecord): void {
  if (
    row.chainId !== deps.deployment.chainId ||
    row.factory.toLowerCase() !== deps.deployment.factory.toLowerCase()
  )
    throw refusal("other_deployment", 409);
}

/**
 * The tenant abandons its draft, under the order's lock. Any other state is a 409
 * `order_closed`, and so is a draft that another writer moved first.
 */
export async function abandonOrder(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  id: string,
): Promise<LegalBodyOrderView> {
  // Read once before the lock: an id that is not the tenant's order never gets a lock of its own.
  const owned = requireOwnedOrder(deps, tenantId, id);
  return withKeyedLock(orderLockKey(owned.legalBodyId), async () => {
    const row = requireOwnedOrder(deps, tenantId, owned.legalBodyId);
    assertThisDeployment(deps, row);
    if (
      row.bindingState !== "draft" ||
      !deps.repo.abandon(row.legalBodyId, "tenant_request", "tenant")
    )
      throw refusal("order_closed", 409);
    const abandoned = deps.repo.findById(row.legalBodyId);
    if (abandoned === undefined) throw new Error(`legal body ${row.legalBodyId} vanished`);
    return toOrderView(abandoned);
  });
}
