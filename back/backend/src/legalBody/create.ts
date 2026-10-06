import type { SubmitCreateResult } from "../adapters/arc/legalBodyChain";
import type { LegalBodyRecord } from "../persistence/legalBodyRepository";
import type { LegalBodyLink } from "./link";
import type { LegalBodyOrderDeps } from "./orders";

/**
 * THE CREATE: the one way a create transaction is submitted for a reserved order. The link door
 * calls it right after the reserve; the resolver calls it to submit again. It imports neither.
 *
 * NOTHING IS SENT THAT WAS NOT RECORDED. The chain signs the create inside the executor's sender
 * lock and hands it to `record` before anything goes on the wire; it sends only when `record`
 * answered true. `record` writes the submission (hash, raw bytes, nonce) to the order's event log,
 * so the order can always be settled from the chain afterwards, whatever happens to this process.
 *
 * THE PLATFORM'S SPEND IS BOUNDED three ways, reverted and re-sent creates included:
 *  - at most `MAX_CREATE_SUBMISSIONS_PER_ORDER` submissions per order, ever;
 *  - the tenant's `maxCreatesPerTenantPerDay`, over the last 24 hours;
 *  - the deployment's `maxCreatesPerDay`, over the last 24 hours.
 * They are counted twice. Once before anything is asked of the chain: a cap reached then is a
 * `CreateCapError`, and the chain is not called. Then again inside `record`, in one synchronous
 * step and one database transaction with the write of the submission: that count is the one that
 * holds, since whatever was recorded in between (another order's create, a concurrent process) is
 * in it. A cap reached there answers false: nothing is recorded and nothing is sent.
 */

/** The most create submissions one order may ever make. */
export const MAX_CREATE_SUBMISSIONS_PER_ORDER = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A create cap is reached, and nothing was asked of the chain: the order's own submissions, the
 *  tenant's creates over 24 hours, or the deployment's. */
export class CreateCapError extends Error {
  constructor(readonly kind: "order" | "tenant" | "deployment") {
    super(`the ${kind} cap on legal-body creates is reached: nothing was submitted`);
    this.name = "CreateCapError";
  }
}

/** The link an order's row describes, rebuilt for a re-check or a re-submit. A row that holds no
 *  link (a draft, or an abandoned one) throws. */
export function linkOfRow(row: LegalBodyRecord): LegalBodyLink {
  const { agentId, oaManifestHash, linkDeadline } = row;
  if (agentId === null || oaManifestHash === null || linkDeadline === null)
    throw new Error(`legal body ${row.legalBodyId} holds no link`);
  return {
    agentId: BigInt(agentId),
    guardian: row.guardian,
    amendmentDelay: BigInt(row.amendmentDelay),
    operatingAgreementHash: oaManifestHash,
    deadline: BigInt(linkDeadline),
  };
}

/** The first cap the order's create would pass, in this order: the order's, the tenant's, the
 *  deployment's. `undefined` when there is room in all three. */
function capReached(
  deps: LegalBodyOrderDeps,
  row: LegalBodyRecord,
): CreateCapError["kind"] | undefined {
  const since = (deps.now ?? Date.now)() - DAY_MS;
  if (deps.repo.listDeploySubmissions(row.legalBodyId).length >= MAX_CREATE_SUBMISSIONS_PER_ORDER)
    return "order";
  if (deps.repo.countCreatesByTenant(row.tenantId, since) >= deps.maxCreatesPerTenantPerDay)
    return "tenant";
  if (deps.repo.countCreatesSince(deps.deployment, since) >= deps.maxCreatesPerDay)
    return "deployment";
  return undefined;
}

/**
 * Submit a create for a reserved row, recording first. The ONE way a create is submitted.
 *
 *  1. The three caps: the first one reached throws its `CreateCapError`, with no chain call.
 *  2. `chain.submitCreate` with the row's own link and signature. Its `record`, in one database
 *     transaction: with `onlyAtNonce` given, a create signed at any other nonce answers false;
 *     then the three caps are counted again, and one reached answers false; then the submission
 *     is written, and only while the row is still `reserved`.
 *
 * `not_recorded` means nothing was recorded and nothing was sent. Every throw from the chain means
 * nothing was sent (see `LegalBodyChain.submitCreate`); this function adds none after a send.
 */
export async function submitCreateFor(
  deps: LegalBodyOrderDeps,
  row: LegalBodyRecord,
  opts: { onlyAtNonce?: number } = {},
): Promise<SubmitCreateResult> {
  // 1.
  const reached = capReached(deps, row);
  if (reached !== undefined) throw new CreateCapError(reached);

  // 2.
  const link = linkOfRow(row);
  const signature = row.linkSignature;
  if (signature === null) throw new Error(`legal body ${row.legalBodyId} holds no link signature`);
  const id = row.legalBodyId;
  return deps.chain.submitCreate({
    link,
    signature,
    record: (signed) =>
      deps.transaction((): boolean => {
        if (opts.onlyAtNonce !== undefined && signed.nonce !== opts.onlyAtNonce) return false;
        if (capReached(deps, row) !== undefined) return false;
        return deps.repo.recordDeploySubmission(id, signed);
      }),
  });
}
