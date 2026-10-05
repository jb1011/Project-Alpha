import { type Address, type Hex, getAddress, isAddressEqual, maxUint256 } from "viem";
import { legalBodyFactoryAbi } from "../abis/generated";
import { assertRealHuman } from "../api/routes/worldId";
import { withKeyedLock } from "../payments/keyedMutex";
import {
  type LegalBodyRecord,
  type ReserveOutcome,
  isDraftExpired,
} from "../persistence/legalBodyRepository";
import { readVerifiedAgreement } from "./agreement";
import { type LinkCheck, checkLink } from "./checkLink";
import {
  DEFAULT_LINK_TTL_SECONDS,
  type LegalBodyLink,
  LinkShapeError,
  type LinkTypedDataWire,
  MAX_SERVED_LINK_TTL_SECONDS,
  linkDeadline,
  linkFromWire,
  linkTypedDataWire,
} from "./link";
import {
  type LegalBodyOrderDeps,
  type LegalBodyOrderView,
  assertThisDeployment,
  chainCall,
  companyEligible,
  orderLockKey,
  requireOwnedOrder,
  takeDoorTokens,
  toOrderView,
} from "./orders";
import { refusal } from "./sentences";
import { LegalTextNotApprovedError, assertTextsServable } from "./texts/index";
import { LEGAL_BODY_OPERATING_AGREEMENT } from "./texts/operatingAgreement";

/**
 * THE LINK DOOR: the message an identity's owner signs to authorise a legal body for an order,
 * and the signed link, accepted up to the reserve.
 *
 *  - `linkMessage` serves the EIP-712 typed data of the order's link, its deadline counted from
 *    the chain's time, with the owner the registry names now. It writes nothing.
 *  - `submitLink` checks a signed link by simulation, lets the other orders for the same identity
 *    give way to the current owner's fresh signature, and reserves the identity for this order,
 *    all in one transaction; then it hands the reserved row to `after.create`.
 *
 * ONE WRITER PER ORDER: `submitLink` runs under the order's lock, which the sweeper takes too. A
 * move on ANOTHER order's row takes no second lock: it is a compare-and-set inside the reserve's
 * transaction, so a resolver half-way through that row loses its next write and sends nothing.
 * Nothing called from here, `after.create` included, may take this order's lock again: the lock is
 * not re-entrant, and a second take waits for ever.
 *
 * A refusal before the reserve keeps the draft; a chain that could not answer is a 503 that
 * changed nothing (`chainCall`).
 *
 * Two consequences of the give-way, both by design:
 *  - a row lapsed with `owner_changed` may leave signed bytes that can still be mined if the
 *    identity returns to its first owner before the deadline. The body is then an orphan: no
 *    intent is served for it and a lapsed row is never revived;
 *  - `checkLink` reads the owner at one block and simulates at the latest: a transfer between the
 *    two stores the previous owner, and the body later reads `foreign`. Rare; the resolver lapses
 *    such a row.
 */

/** The longest link signature read, in bytes: room for a smart account's own encoding. */
export const MAX_LINK_SIGNATURE_BYTES = 2_048;
/** The shortest link lifetime served: a link must outlive the wallet round trip and the create. */
export const MIN_SERVED_LINK_TTL_SECONDS = 600n;

export interface LinkMessageResult {
  typedData: LinkTypedDataWire;
  identityOwner: Address;
  /** Unix seconds, in chain time. */
  deadline: number;
}

export type LinkSubmitResult =
  | { status: "deployed" | "reserved" | "linked"; order: LegalBodyOrderView }
  | {
      status: "refused";
      code: string;
      order: LegalBodyOrderView;
      detail: Record<string, string>;
    };

/** What happens once the row is reserved. `blockTime` is the head's time, in unix seconds. */
export interface AfterReserve {
  create: (row: LegalBodyRecord, blockTime: number) => Promise<LinkSubmitResult>;
}

/** A uint256 in canonical decimal: digits only, no leading zero but "0" itself, 78 at most. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const WHOLE_BYTES_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The factory's own error names: the only names a refusal's detail repeats. */
const FACTORY_ERROR_NAMES: ReadonlySet<string> = new Set(
  legalBodyFactoryAbi.flatMap((item) => (item.type === "error" ? [item.name] : [])),
);

/**
 * Rule 1, shared by both functions, on the tenant's order: a frozen draft of this deployment,
 * created less than 24 hours ago, not revoked, for a company still eligible, whose stored agreement
 * re-verifies and was written on the current text, which this deployment serves.
 */
function assertLinkableDraft(deps: LegalBodyOrderDeps, row: LegalBodyRecord, nowMs: number): Hex {
  const hash = row.oaManifestHash;
  if (row.bindingState !== "draft" || hash === null) throw refusal("order_closed", 409);
  assertThisDeployment(deps, row);
  if (isDraftExpired(row, nowMs)) throw refusal("order_expired", 409);
  if (deps.repo.isRevoked(row.legalBodyId)) throw refusal("order_revoked", 409);
  if (!companyEligible(deps, row.companyId)) throw refusal("company_not_eligible", 409);
  // A failure has already written its error line, naming the order and a fixed reason.
  const verified = readVerifiedAgreement(deps.docStore, row.legalBodyId, hash);
  if (verified === undefined) throw refusal("agreement_unreadable", 500);
  const current = LEGAL_BODY_OPERATING_AGREEMENT;
  if (
    verified.terms.textId !== current.id ||
    verified.terms.textVersion !== current.version ||
    !servable(deps.environment)
  )
    throw refusal("agreement_outdated", 409);
  return hash;
}

/** Whether this deployment serves the current agreement text. */
function servable(environment: LegalBodyOrderDeps["environment"]): boolean {
  try {
    assertTextsServable(environment, [LEGAL_BODY_OPERATING_AGREEMENT]);
    return true;
  } catch (err) {
    if (err instanceof LegalTextNotApprovedError) return false;
    throw err;
  }
}

/**
 * The typed data the identity's owner signs for this order, and the owner the registry names now.
 * In this order:
 *  0. a real human (never a waiver), then the tenant's bucket and the doors' budget;
 *  1. the order's rule 1 (`assertLinkableDraft`), after the uniform 404;
 *  2. `agentId` is a uint256 in canonical decimal; `ttlSeconds`, if given, a whole number of
 *     seconds from `MIN_SERVED_LINK_TTL_SECONDS` to `MAX_SERVED_LINK_TTL_SECONDS`;
 *  3. the head, then the identity's owner at that head: none is a 422 `identity_not_found`;
 *  4. the link: this agent, the tenant as guardian, the order's delay and agreement, and a
 *     deadline counted from the CHAIN's time.
 * Writes nothing.
 */
export async function linkMessage(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  id: string,
  input: { agentId: string; ttlSeconds?: number },
): Promise<LinkMessageResult> {
  const nowMs = (deps.now ?? Date.now)();

  // 0.
  assertRealHuman(deps.world, tenantId, deps.environment);
  takeDoorTokens(deps, tenantId);

  // 1.
  const row = requireOwnedOrder(deps, tenantId, id);
  const agreementHash = assertLinkableDraft(deps, row, nowMs);

  // 2.
  const agentId = canonicalAgentId(input?.agentId);
  if (agentId === undefined) throw refusal("invalid_agent_id", 400);
  const ttl = servedTtl(input?.ttlSeconds);
  if (ttl === undefined) throw refusal("invalid_link_ttl", 400);

  // 3.
  const orderId = row.legalBodyId;
  const head = await chainCall(orderId, "head", () => deps.chain.head());
  const identityOwner = await chainCall(orderId, "identity_owner", () =>
    deps.chain.identityOwner(agentId, head.number),
  );
  if (identityOwner === undefined) throw refusal("identity_not_found", 422);

  // 4.
  const link: LegalBodyLink = {
    agentId,
    guardian: getAddress(tenantId),
    amendmentDelay: BigInt(row.amendmentDelay),
    operatingAgreementHash: agreementHash,
    deadline: linkDeadline(head.timestamp, ttl),
  };
  return {
    typedData: linkTypedDataWire({
      chainId: deps.deployment.chainId,
      factory: deps.deployment.factory,
      link,
    }),
    identityOwner,
    deadline: Number(link.deadline),
  };
}

/** The agentId as a bigint, or undefined when it is not a uint256 in canonical decimal. */
function canonicalAgentId(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !CANONICAL_DECIMAL.test(value)) return undefined;
  const parsed = BigInt(value);
  return parsed <= maxUint256 ? parsed : undefined;
}

/** The lifetime to serve, or undefined when the one given is not a served lifetime. */
function servedTtl(value: unknown): bigint | undefined {
  if (value === undefined) return DEFAULT_LINK_TTL_SECONDS;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  const ttl = BigInt(value);
  return ttl >= MIN_SERVED_LINK_TTL_SECONDS && ttl <= MAX_SERVED_LINK_TTL_SECONDS ? ttl : undefined;
}

/** Thrown inside the reserve's transaction to roll it back: no row moves for an order that did
 *  not reserve. Never leaves this module. */
class ReserveRefused extends Error {
  constructor(readonly outcome: Exclude<ReserveOutcome, "reserved">) {
    super(`the reserve answered ${outcome}`);
    this.name = "ReserveRefused";
  }
}

/**
 * Accepts the identity owner's signed link for the tenant's order, up to the reserve, then hands
 * the reserved row to `after.create`. In this order:
 *  0. a real human (never a waiver), then the tenant's bucket and the doors' budget;
 *  then, under the order's lock:
 *  2. by state: `reserved`, `deployed` or `linked` answers that state with the order (a repeated
 *     submit changes nothing); a draft goes on with the rest of rule 1; anything else is a 409;
 *  3. the message is the served shape (400 `malformed_link`), the signature whole bytes of hex,
 *     at most `MAX_LINK_SIGNATURE_BYTES` (400 `malformed_signature`; an empty `0x` is read);
 *  4. one token from the identity's bucket, keyed `chainId:agentId:tenantId` so that a stranger
 *     cannot empty the bucket the owner's tenant needs;
 *  5. the create caps, per tenant (429) and for the deployment (503), counted over 24 hours,
 *     reverted and re-sent creates included;
 *  6. `checkLink`: a refusal is answered with its code, the order and a detail of hex and
 *     decimals, and the draft is kept;
 *  7. the head, read once: its time is the block time of any lapse below, and of `after.create`;
 *  8. ONE transaction: every `deployed` row for the identity, whoever ordered it, is superseded by
 *     this order; a `reserved` row of a previous owner is lapsed with `owner_changed`; a
 *     `reserved` row of the same owner blocks with `agent_in_flight`; then the reserve. If the
 *     reserve does not answer `reserved`, the whole transaction is rolled back;
 *  9. `after.create(row, blockTime)`.
 */
export async function submitLink(
  deps: LegalBodyOrderDeps,
  tenantId: Address,
  id: string,
  input: { message: unknown; signature: Hex },
  after: AfterReserve,
): Promise<LinkSubmitResult> {
  // 0.
  assertRealHuman(deps.world, tenantId, deps.environment);
  takeDoorTokens(deps, tenantId);

  // Read once before the lock: an id that is not the tenant's order never gets a lock of its own.
  const owned = requireOwnedOrder(deps, tenantId, id);
  return withKeyedLock(orderLockKey(owned.legalBodyId), async (): Promise<LinkSubmitResult> => {
    const nowMs = (deps.now ?? Date.now)();

    // 2.
    const row = requireOwnedOrder(deps, tenantId, owned.legalBodyId);
    const orderId = row.legalBodyId;
    const state = row.bindingState;
    if (state === "reserved" || state === "deployed" || state === "linked")
      return { status: state, order: toOrderView(row) };
    const agreementHash = assertLinkableDraft(deps, row, nowMs);

    // 3.
    let link: LegalBodyLink;
    try {
      link = linkFromWire(input?.message);
    } catch (err) {
      if (err instanceof LinkShapeError) throw refusal("malformed_link", 400);
      throw err;
    }
    const signature = input?.signature;
    if (
      typeof signature !== "string" ||
      signature.length > 2 + 2 * MAX_LINK_SIGNATURE_BYTES ||
      !WHOLE_BYTES_HEX.test(signature)
    )
      throw refusal("malformed_signature", 400);

    // 4.
    const identityKey = `${deps.deployment.chainId}:${link.agentId}:${getAddress(tenantId)}`;
    if (!deps.identityBucket(identityKey).take()) throw refusal("rate_limited", 429);

    // 5. A draft has no create of its own yet, so the cap of submissions per order cannot be
    //    reached here.
    if (deps.repo.countCreatesByTenant(tenantId, nowMs - DAY_MS) >= deps.maxCreatesPerTenantPerDay)
      throw refusal("legal_body_attempts", 429);
    if (deps.repo.countCreatesSince(deps.deployment, nowMs - DAY_MS) >= deps.maxCreatesPerDay)
      throw refusal("busy", 503);

    // 6.
    const check = await chainCall(orderId, "check_link", () =>
      checkLink(deps.chain, {
        link,
        signature,
        expected: {
          tenant: tenantId,
          operatingAgreementHash: agreementHash,
          amendmentDelay: BigInt(row.amendmentDelay),
        },
      }),
    );
    if (!check.ok)
      return {
        status: "refused",
        code: check.code,
        order: toOrderView(row),
        detail: detailOf(check),
      };

    // 7.
    const head = await chainCall(orderId, "head", () => deps.chain.head());
    const blockTime = Number(head.timestamp);

    // 8.
    const agentId = link.agentId.toString();
    try {
      deps.repo.transaction(() => {
        const inFlight = deps.repo.listInFlightByAgent(deps.deployment, agentId);
        // The same owner's order on its way stays: it settles within seconds, or lapses at its
        // deadline. Checked before anything moves.
        if (
          inFlight.some(
            (other) =>
              other.bindingState === "reserved" &&
              other.identityOwner !== null &&
              isAddressEqual(other.identityOwner, check.identityOwner),
          )
        )
          throw new ReserveRefused("agent_in_flight");
        for (const other of inFlight) {
          // A deployed body blocks nobody: it keeps its body and its pointer intent, and reads
          // `linked` again if the owner points at it. Each move is a compare-and-set.
          if (other.bindingState === "deployed") deps.repo.supersede(other.legalBodyId, orderId);
          else if (other.bindingState === "reserved")
            deps.repo.lapse(other.legalBodyId, { reason: "owner_changed", blockTime });
        }
        const outcome = deps.repo.reserve(orderId, {
          agentId,
          identityOwner: check.identityOwner,
          linkDigest: check.linkDigest,
          linkDeadline: Number(link.deadline),
          linkSignature: check.signature,
          bodyAddress: check.bodyAddress,
          observedAtBlock: Number(check.observedAtBlock),
          firstCheckAt: nowMs,
        });
        if (outcome !== "reserved") throw new ReserveRefused(outcome);
      });
    } catch (err) {
      if (!(err instanceof ReserveRefused)) throw err;
      switch (err.outcome) {
        case "agent_in_flight":
          return {
            status: "refused",
            code: "agent_in_flight",
            order: toOrderView(row),
            detail: {},
          };
        case "body_taken":
          throw refusal("link_already_used", 409);
        default:
          throw refusal("order_closed", 409);
      }
    }

    // 9.
    const reserved = deps.repo.findById(orderId);
    if (reserved === undefined) throw new Error(`legal body ${orderId} vanished inside its link`);
    return after.create(reserved, blockTime);
  });
}

/** A refusal's facts, as hex and decimals only: never a bigint, never text from the chain but
 *  the name of one of the factory's own errors. */
function detailOf(check: Extract<LinkCheck, { ok: false }>): Record<string, string> {
  const detail: Record<string, string> = {};
  if (check.identityOwner !== undefined) detail.identityOwner = check.identityOwner;
  if (check.bodyAddress !== undefined) detail.bodyAddress = check.bodyAddress;
  if (check.createdFor !== undefined) detail.createdFor = check.createdFor;
  if (check.gasEstimate !== undefined) detail.gasEstimate = check.gasEstimate.toString();
  if (check.errorName !== undefined && FACTORY_ERROR_NAMES.has(check.errorName))
    detail.errorName = check.errorName;
  return detail;
}
