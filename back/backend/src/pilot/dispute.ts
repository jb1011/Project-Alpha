import { basename } from "node:path";
import { type Address, type Hex, keccak256 } from "viem";
import type { JobAdapter } from "../adapters/arc/jobAdapter";
import type {
  CourtClock,
  CreateOutcome,
  PinOutcome,
  SubmitOutcome,
} from "../adapters/kleros/disputeService";
import {
  KlerosHttpError,
  KlerosRefusal,
  PRESET_SIMULATES,
  sentOf,
} from "../adapters/kleros/errors";
import { FakeDisputeService } from "../adapters/kleros/fakeDisputeService";
import type { ByAgentAnswer } from "../api/routes/legalBodyStatements";
import type { KlerosConfig } from "../config/env";
import { JobStatusOnChain } from "../jobs/refund";
import { opsLog } from "../observability/opsLog";
import type { FileDocumentStore } from "../persistence/documentStore";
import { publicErrorMessage } from "../workflow/publicError";
import type { PilotCaseRepository } from "./casesRepository";
import type { KlerosStage, PilotChain } from "./composition";
import { type Evidence, renderEvidence } from "./evidence";
import { withoutEmDash } from "./job";
import { submittedDeliverableOf } from "./jobEvents";
import { UNAUTHORIZED_PROBLEM, checkKleros, klerosTextOf, withoutPaths } from "./klerosCheck";
import type { LookupClient } from "./lookup";
import type { KlerosChainOnRow, PilotCaseRecord } from "./types";

/**
 * FILING A PILOT CASE WITH KLEROS: the pre-flight, then three writes in order (pin the delivered
 * file, create the dispute, submit the evidence), once, on the deployment the mode selects.
 *
 * A dispute is public and permanent, and a second filing pays a second fee and creates a second
 * dispute. So:
 *
 *  - Nothing reaches Kleros before the stage gate and the pre-flight pass. The gate: a rehearsal
 *    files with the fake only (an `instanceof` check, so the real client in a rehearsal refuses
 *    before any call), with no deployment, cap or flag; testnet needs `--testnet` and live
 *    `--live`. The pre-flight reads only, then stores the evidence and the two records the
 *    filing serves, and only while the row is at `contested`.
 *  - A dispute is created only for a row the compare-and-set just moved from `contested` to
 *    `filing`, in the same command, with the stored evidence still the one this command is about
 *    to submit. That move writes the stage's chain, court and policy URI, which never change
 *    after. A row that already holds a dispute id or a create transaction is never filed again.
 *    A create whose outcome is in doubt freezes the row at `filing_unknown`: a human resolves it.
 *  - A refusal the Kleros docs say sent nothing, or an HTTP status decided before the call ran
 *    (401, 429, 413), moves the row back to `contested`, to be filed again once the cause is
 *    fixed; the attempt's start time and deployment stay on the row.
 *  - A row found at `filing` is another command's filing while it is under 30 minutes old (wait),
 *    and a stopped one after that, frozen for a human whatever its trail: `filing_unknown`, or
 *    `evidence_unknown` when it holds a dispute id. It never goes back to `contested`, so that a
 *    dispute is created once does not rest on any clock. The freeze says whether the create was
 *    marked as sent.
 *  - Every Kleros write writes an event with its status and reference (the create also when it is
 *    about to be sent), and the row's moves are compare-and-set. The ids and hashes of a mined
 *    write are written whatever the row's status by then: they are facts about Kleros.
 *
 * No key is read here: the stage's client holds it. A Kleros text keeps its own words with
 * credentials redacted (`klerosTextOf`); any other exception's text goes through
 * `publicErrorMessage`. Neither names an absolute path, only a file.
 */

/** The job's escrow as the job adapter reads it from the chain. */
export type EscrowOnChain = Awaited<ReturnType<JobAdapter["escrowState"]>>;

export interface FileDisputeDeps {
  chain: PilotChain;
  cases: PilotCaseRepository;
  docStore: FileDocumentStore;
  lookup: LookupClient;
  stage: KlerosStage;
  /** The alias slot keys and the policy URI; absent on a rehearsal box with no Kleros key. */
  klerosCfg?: KlerosConfig;
  arcNetwork: "testnet" | "mainnet";
  lookupBase: string;
  /** Unix seconds. */
  now?: () => number;
  /** Unused: the filing makes no wait of its own (the HTTP client waits out WRITE_IN_PROGRESS);
   *  kept so the dependencies stay the ones the commands pass. */
  sleep?: (ms: number) => Promise<void>;
}

export type Preflight =
  | {
      ok: true;
      evidence: Evidence;
      court: CourtClock;
      instructions: string | null;
      escrow: EscrowOnChain;
      records: { buyer: ByAgentAnswer; seller: ByAgentAnswer };
      filedCount: number;
      cap: number | null;
    }
  | { ok: false; problem: string };

export type FileOutcome =
  | {
      outcome: "filed";
      coreDisputeId: string;
      localDisputeId?: string;
      evidenceStatus: "mined" | "unknown";
    }
  | { outcome: "filing_unknown"; txHash?: Hex; text: string }
  | { outcome: "not_sent"; code: string | null; text: string };

/** An expired job refunds the client whatever the ruling: a case is filed with two hours left. */
const MIN_SECONDS_TO_EXPIRY = 7_200;
/**
 * A `filing` row younger than this is another command's filing in progress. It covers the
 * client's write deadlines (the create and the submit up to four minutes each), its own waits
 * on WRITE_IN_PROGRESS (up to two minutes a write) and the one more call after them.
 *
 * The client's worst case before the create is about 20 minutes (a pin of four 120 s attempts
 * and 120 s of WRITE_IN_PROGRESS waits, twice with the one more call, plus the rate limiter's
 * waits), so the window leaves a margin of about 8 to 10 minutes, and it must stay above that
 * bound whenever the client's deadlines or retries change. It decides liveness only: a slow
 * command frozen early sends nothing (its sending mark refuses a row it no longer owns), so no
 * dispute is ever created twice; the case then waits for a human.
 */
const FILING_IN_PROGRESS_SECONDS = 30 * 60;
/**
 * Another write on the same key was running and nothing was sent. The HTTP client has already
 * waited it out, so the filing calls once more at once; a second one is refused like any other.
 */
const WRITE_IN_PROGRESS = "WRITE_IN_PROGRESS";
/** The create and the submit keep a long Kleros text: a person may read the ids out of it. */
const KLEROS_FILING_TEXT_MAX = 4_500;
/** The codes of a refusal that is ours, not the service's. */
const UNAUTHORIZED = "unauthorized";
const PIN_CHECKED_ONLY = "pin_checked_only";
const FILING_IN_PROGRESS = "filing_in_progress";
const FILING_MOVED = "filing_moved";
/**
 * The filing's event steps are the Dispute Service's own tool names, so a trail filtered by step
 * never mixes them with the job's chain steps (`create`, `fund`, `submit`).
 */
const PIN_STEP = "evidence_pin";
const CREATE_STEP = "dispute_create";
const SUBMIT_STEP = "evidence_submit";
const DELIVERABLE_EXTENSION_INVALID = "deliverable_extension_invalid";
/** The extensions the Dispute Service attaches: one to ten lowercase letters or digits. */
const SERVICE_EXTENSION = /^[a-z0-9]{1,10}$/;
const UNAUTHORIZED_TEXT =
  "the Dispute Service refused the key of this stage (HTTP 401): it is wrong or revoked; nothing was sent";
/** The alias slot keys of the preset when no Kleros config is set (a rehearsal box). */
const DEFAULT_ALIAS_CLIENT = "client";
const DEFAULT_ALIAS_PROVIDER = "provider";
/** The store's own names for the pilot's files; every one starts with this. */
const PILOT_FILE_PREFIX = "pilot-";
const CANONICAL_DECIMAL = /^(0|[1-9]\d*)$/;
const LIVE_GATE =
  "file and look at a testnet case first: live mode files only once a testnet case is filed and recorded as seen in the Kleros Court interface (pilot:case seen-in-court)";

const unixNow = () => Math.floor(Date.now() / 1000);
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** An exception that is not Kleros's, fit to persist or print: no credential, no path. */
const safe = (e: unknown) => withoutEmDash(withoutPaths(publicErrorMessage(e)));

/** The pre-flight's inner answer: the public one, plus what the filing goes on with. */
type Checked =
  | (Extract<Preflight, { ok: true }> & {
      row: PilotCaseRecord;
      deliverable: { bytes: Uint8Array; extension: string };
    })
  | { ok: false; problem: string; code: string | null; atFiling?: PilotCaseRecord };

/** Reads only, then stores the evidence and the two records on the row and in the store. */
export async function preflightDispute(
  d: FileDisputeDeps,
  caseId: string,
  opts: { allowStanding?: string },
): Promise<Preflight> {
  const c = await check(d, caseId, opts);
  if (!c.ok) return { ok: false, problem: c.problem };
  const { evidence, court, instructions, escrow, records, filedCount, cap } = c;
  return { ok: true, evidence, court, instructions, escrow, records, filedCount, cap };
}

/**
 * Pre-flight again, then: advance contested -> filing (writing the stage's chain, court and policy URI); pin; create; submit; the row's final status per outcome.
 * `onlyAtFiling`: the caller read the row at `filing` and printed no banner, so a row found at
 * any other status is refused with no call.
 */
export async function fileDispute(
  d: FileDisputeDeps,
  caseId: string,
  opts: {
    allowStanding?: string;
    confirmedFlag: "--testnet" | "--live" | null;
    onlyAtFiling?: boolean;
  },
): Promise<FileOutcome> {
  const flagProblem = flagProblemOf(d.stage, opts.confirmedFlag);
  if (flagProblem) return notSent(null, flagProblem);
  const pre = await check(d, caseId, opts);
  if (!pre.ok)
    return pre.atFiling ? stoppedFiling(d, pre.atFiling) : notSent(pre.code, pre.problem);

  const { cases, stage } = d;
  const now = (d.now ?? unixNow)();
  const deployment = deploymentOf(d);
  // The cap is read again in the transaction that moves the row, so two filings at once cannot
  // both pass it; the stored evidence and records must still be the ones this command is about
  // to file, since another command's pre-flight may have stored its own since. The deployment
  // is written on the first filing and only compared after it.
  let moved: PilotCaseRecord | string;
  try {
    moved = cases.transaction((): PilotCaseRecord | string => {
      const count = cases.countFiled(stage.mode);
      if (stage.cap !== null && count >= stage.cap)
        return capProblemOf(stage.mode, count, stage.cap);
      if (stage.mode === "live" && cases.countSeenInCourt("testnet") < 1) return LIVE_GATE;
      const current = cases.find(caseId);
      if (current === undefined) return `no pilot case ${caseId}`;
      if (current.klerosChain !== null && !sameDeployment(current, deployment))
        return otherDeploymentProblemOf(current, deployment);
      if (!storedIsFiled(d, current, pre))
        return "the stored evidence changed while this command ran (another command stored its own): nothing was sent; run the command again";
      const next = cases.advance(caseId, "contested", "filing", {
        filingStartedAt: now,
        ...(current.klerosChain === null ? deployment : {}),
      });
      if (!next) return `pilot case ${caseId} moved from contested while this command ran`;
      cases.recordEvent(caseId, "filing", "started", deployment.klerosChain, null);
      return next;
    });
  } catch (e) {
    return notSent(null, `the case could not be moved to filing, so nothing was sent: ${safe(e)}`);
  }
  if (typeof moved === "string") return notSent(null, moved);

  const write = <T>(step: string, call: () => Promise<T>) =>
    oneMoreCallAfterWriteInProgress(d, caseId, step, call);
  const { extension, bytes } = pre.deliverable;

  // 1. The delivered file, pinned once: a filing tried again reuses the attachment it pinned.
  let attachment: { fileUri: string; cid: string };
  if (moved.attachmentUri !== null && moved.attachmentCid !== null) {
    attachment = { fileUri: moved.attachmentUri, cid: moved.attachmentCid };
    cases.recordEvent(caseId, PIN_STEP, "reused", attachment.fileUri, attachment.cid);
  } else {
    let pinned: PinOutcome;
    try {
      pinned = await write(PIN_STEP, () => stage.service.pin({ bytes, extension }));
    } catch (e) {
      const detail = klerosTextOf(e);
      cases.recordEvent(caseId, PIN_STEP, refusedOrFailed(e), null, detail);
      const never = neverRanCodeOf(e);
      if (never) return backToContested(d, moved, never, neverRanTextOf(never));
      return backToContested(
        d,
        moved,
        e instanceof KlerosRefusal ? e.code : null,
        `the delivered file was not pinned, so nothing was filed: ${detail}`,
      );
    }
    if (pinned.status === "checked") {
      cases.recordEvent(
        caseId,
        PIN_STEP,
        "checked",
        null,
        "the key checked the file and published nothing",
      );
      return backToContested(
        d,
        moved,
        PIN_CHECKED_ONLY,
        "the key only checked the delivered file and published nothing, so nothing was filed: read the key's instructions with pilot:kleros check",
      );
    }
    const published = pinned;
    cases.transaction(() => {
      cases.patch(caseId, { attachmentUri: published.fileUri, attachmentCid: published.cid });
      cases.recordEvent(caseId, PIN_STEP, "published", published.fileUri, published.cid);
    });
    attachment = { fileUri: published.fileUri, cid: published.cid };
  }

  // 2. The dispute, created once. Each call is marked as sending first, in a transaction that
  //    checks the row is still this command's filing (at `filing`, with this command's start): a
  //    row another command froze or filed again since is not this command's to create on, and a
  //    freeze never hides a dispute started after it. Only the window between the mark and the
  //    request remains, and the mark records it.
  const aliases: Record<string, Address> = {
    [d.klerosCfg?.aliasClient ?? DEFAULT_ALIAS_CLIENT]: moved.buyerAddress as Address,
    [d.klerosCfg?.aliasProvider ?? DEFAULT_ALIAS_PROVIDER]: moved.sellerAddress as Address,
  };
  let created: CreateOutcome;
  try {
    created = await write(CREATE_STEP, () => {
      let current: PilotCaseRecord | undefined;
      try {
        current = cases.transaction(() => {
          const now = cases.find(caseId);
          if (now?.status === "filing" && now.filingStartedAt === moved.filingStartedAt)
            cases.recordEvent(caseId, CREATE_STEP, "sending", null, null);
          return now;
        });
      } catch (e) {
        // Before the request: whatever failed here, nothing left this process.
        throw new MarkFailedError(safe(e));
      }
      if (current?.status !== "filing" || current.filingStartedAt !== moved.filingStartedAt)
        throw new FilingMovedError(current?.status ?? "missing");
      return stage.service.createDispute({ aliases });
    });
  } catch (e) {
    if (e instanceof MarkFailedError) {
      const text = `the create could not be marked as sending, so nothing was sent: ${e.text}`;
      cases.recordEvent(caseId, CREATE_STEP, "not_marked", null, text);
      return backToContested(d, moved, null, text);
    }
    if (e instanceof FilingMovedError) {
      const text = `pilot case ${caseId} moved from this command's filing before its create (it is now ${e.status}, or filed again by another command): nothing was sent; read pilot:case show ${caseId}`;
      cases.recordEvent(caseId, CREATE_STEP, FILING_MOVED, null, text);
      return notSent(FILING_MOVED, text);
    }
    const detail = klerosTextOf(e, KLEROS_FILING_TEXT_MAX);
    const never = neverRanCodeOf(e);
    if (never) {
      cases.recordEvent(caseId, CREATE_STEP, "refused", null, detail);
      return backToContested(d, moved, never, neverRanTextOf(never));
    }
    if (e instanceof KlerosRefusal && sentOf("dispute_create", e.code) === "no") {
      cases.recordEvent(caseId, CREATE_STEP, "refused", null, detail);
      return backToContested(
        d,
        moved,
        e.code,
        `Kleros refused the filing and nothing was sent: ${detail}`,
      );
    }
    // Anything else may have been sent: never file again.
    cases.recordEvent(caseId, CREATE_STEP, "unknown", null, detail);
    return frozenFiling(
      d,
      caseId,
      undefined,
      `the filing may have been sent, so it must not be filed again: ${detail}`,
    );
  }
  if (created.status === "simulated") {
    // A documented status of the service that neither key should give: nothing exists.
    const text = `${PRESET_SIMULATES}: the key simulated the filing; nothing was sent and no dispute exists. Read the key's instructions with pilot:kleros check`;
    cases.recordEvent(caseId, CREATE_STEP, "simulated", null, text);
    return backToContested(d, moved, PRESET_SIMULATES, text);
  }
  if (created.status === "unknown") {
    const text = klerosTextOf(created.text, KLEROS_FILING_TEXT_MAX);
    cases.recordEvent(caseId, CREATE_STEP, "unknown", created.txHash ?? null, text);
    return frozenFiling(d, caseId, created.txHash, text);
  }
  const { coreDisputeId, localDisputeId, txHash: createTx } = created;
  // Written first: if the row write below fails, the dispute's ids are still in the journal.
  noteCreated(moved, coreDisputeId, localDisputeId, createTx);
  cases.transaction(() => {
    cases.patch(caseId, {
      coreDisputeId,
      localDisputeId: localDisputeId ?? null,
      createDisputeTx: createTx,
      filedAt: (d.now ?? unixNow)(),
    });
    cases.recordEvent(caseId, CREATE_STEP, "mined", createTx, `dispute ${coreDisputeId}`);
  });
  const filed = { coreDisputeId, ...(localDisputeId === undefined ? {} : { localDisputeId }) };

  // 3. The evidence, submitted once: any answer but mined is the human's to read, and the
  //    dispute exists whatever the answer, so the row never goes back to `contested`.
  let submitted: SubmitOutcome;
  try {
    submitted = await write(SUBMIT_STEP, () =>
      stage.service.submitEvidence({
        coreDisputeId,
        name: pre.evidence.name,
        description: pre.evidence.description,
        fileUri: attachment.fileUri,
        fileTypeExtension: extension,
      }),
    );
  } catch (e) {
    const detail = klerosTextOf(e, KLEROS_FILING_TEXT_MAX);
    const refused = e instanceof KlerosRefusal || neverRanCodeOf(e) !== undefined;
    cases.recordEvent(caseId, SUBMIT_STEP, refused ? "refused" : "unknown", null, detail);
    return evidenceInDoubt(d, moved, filed, undefined, detail);
  }
  if (submitted.status === "simulated") {
    const text = `${PRESET_SIMULATES}: the key simulated the evidence; nothing was submitted`;
    cases.recordEvent(caseId, SUBMIT_STEP, "simulated", null, text);
    return evidenceInDoubt(d, moved, filed, undefined, text);
  }
  if (submitted.status === "unknown") {
    const text = klerosTextOf(submitted.text, KLEROS_FILING_TEXT_MAX);
    cases.recordEvent(caseId, SUBMIT_STEP, "unknown", submitted.txHash ?? null, text);
    return evidenceInDoubt(d, moved, filed, submitted.txHash, text);
  }
  const evidenceTx = submitted.txHash;
  cases.transaction(() => {
    const facts = { evidenceTx, evidenceStatus: "mined" };
    if (!cases.advance(caseId, "filing", "filed", facts)) cases.patch(caseId, facts);
    cases.recordEvent(caseId, SUBMIT_STEP, "mined", evidenceTx, null);
  });
  noteFiled(moved, coreDisputeId);
  return { outcome: "filed", ...filed, evidenceStatus: "mined" };
}

/**
 * The pre-flight. Reads only until every check has passed; then, while the row is still at
 * `contested`, writes the evidence and the two records to the store and their names to the row,
 * in one IMMEDIATE transaction, so a filing's move cannot fall between the files and the row.
 */
async function check(
  d: FileDisputeDeps,
  caseId: string,
  opts: { allowStanding?: string; onlyAtFiling?: boolean },
): Promise<Checked> {
  const no = (problem: string, code: string | null = null): Checked => ({
    ok: false,
    problem,
    code,
  });
  const { stage, cases } = d;

  const stageProblem = stageProblemOf(stage);
  if (stageProblem) return no(stageProblem);
  const row = cases.find(caseId);
  if (!row) return no(`no pilot case ${caseId}`);
  if (row.mode !== stage.mode)
    return no(
      `pilot case ${caseId} was created in ${row.mode} mode, and this stage files in ${stage.mode} mode`,
    );
  if (row.status === "filing")
    return { ok: false, problem: filingProblemOf(d, row), code: null, atFiling: row };
  if (opts.onlyAtFiling)
    return no(
      `pilot case ${caseId} moved from filing to ${row.status} while this command ran: nothing was sent; run the command again`,
    );
  if (row.status !== "contested") return no(statusProblemOf(row));
  if (row.coreDisputeId !== null || row.createDisputeTx !== null)
    return no(
      `pilot case ${caseId} already holds a dispute or a create transaction on Kleros (${row.coreDisputeId === null ? `transaction ${row.createDisputeTx}` : `dispute ${row.coreDisputeId}`}), so it is never filed again`,
    );
  const deployment = deploymentOf(d);
  if (row.klerosChain !== null && !sameDeployment(row, deployment))
    return no(otherDeploymentProblemOf(row, deployment));
  const filedCount = cases.countFiled(stage.mode);
  if (stage.cap !== null && filedCount >= stage.cap)
    return no(capProblemOf(stage.mode, filedCount, stage.cap));
  if (stage.mode === "live" && cases.countSeenInCourt("testnet") < 1) return no(LIVE_GATE);
  if (row.deliverableExtension !== null && !SERVICE_EXTENSION.test(row.deliverableExtension))
    return no(
      `the case's deliverable extension ${JSON.stringify(row.deliverableExtension)} is not one the Dispute Service accepts (one to ten lowercase letters or digits), so its file cannot be attached; the job's deliverable must be submitted under such an extension`,
      DELIVERABLE_EXTENSION_INVALID,
    );

  const job = await jobFactsOf(d, row);
  if (typeof job === "string") return no(job);

  const records = {} as { buyer: ByAgentAnswer; seller: ByAgentAnswer };
  for (const side of ["buyer", "seller"] as const) {
    try {
      records[side] = await d.lookup.byAgent(
        side === "buyer" ? row.buyerAgentId : row.sellerAgentId,
      );
    } catch (e) {
      return no(`the ${side}'s legal-body lookup failed: ${safe(e)}`);
    }
  }

  let evidence: Evidence;
  try {
    evidence = renderEvidence(
      {
        row,
        chain: {
          descriptionOnChain: job.description,
          submittedDeliverable: job.submitted,
          networkLabel: "Arc Testnet",
          chainId: d.chain.chainId,
          jobContract: d.chain.jobContract,
          explorerBase: d.chain.explorerBase,
        },
        deliverable: job.deliverable,
        records,
        lookupBase: d.lookupBase,
        arcNetwork: d.arcNetwork,
      },
      opts.allowStanding === undefined ? undefined : { allowStanding: opts.allowStanding },
    );
  } catch (e) {
    return no(`the evidence cannot be rendered: ${safe(e)}`);
  }

  const kleros = await checkKleros(stage);
  if (kleros.problems.length > 0 || kleros.court === null)
    return no(
      `the Kleros check found a problem: ${kleros.problems.join("; ")}`,
      kleros.problems.includes(UNAUTHORIZED_PROBLEM) ? UNAUTHORIZED : null,
    );

  // Every check passed: the bytes the dry run shows are the bytes the filing serves. Each record
  // is the lookup's answer exactly as it came back, as read for this filing. Nothing is written
  // once the row has left `contested`: the files of a filed case are the ones it filed.
  let stored: PilotCaseRecord | undefined;
  try {
    stored = cases.transaction(() => {
      if (cases.find(caseId)?.status !== "contested") return undefined;
      const evidenceFile = d.docStore.put(
        `${PILOT_FILE_PREFIX}${caseId}-evidence.txt`,
        evidence.description,
      );
      const buyerFile = d.docStore.put(
        `${PILOT_FILE_PREFIX}${caseId}-buyer-record.json`,
        JSON.stringify(records.buyer),
      );
      const sellerFile = d.docStore.put(
        `${PILOT_FILE_PREFIX}${caseId}-seller-record.json`,
        JSON.stringify(records.seller),
      );
      const next = cases.advance(caseId, "contested", "contested", {
        evidencePath: evidenceFile.id,
        evidenceSha256: evidence.sha256,
        evidenceName: evidence.name,
        buyerRecordPath: buyerFile.id,
        sellerRecordPath: sellerFile.id,
      });
      if (next) cases.recordEvent(caseId, "evidence", "stored", evidence.sha256, null);
      return next;
    });
  } catch (e) {
    return no(`the evidence could not be stored, so nothing was sent: ${safe(e)}`);
  }
  if (!stored)
    return no(
      `pilot case ${caseId} moved from contested while the pre-flight ran; nothing was stored`,
    );

  return {
    ok: true,
    evidence,
    court: kleros.court,
    instructions: kleros.instructions,
    escrow: job.escrow,
    records,
    filedCount,
    cap: stage.cap,
    row: stored,
    deliverable: job.deliverable,
  };
}

/** Whether the row's stored evidence and records are still the ones this command will file. */
function storedIsFiled(
  d: FileDisputeDeps,
  row: PilotCaseRecord,
  pre: Extract<Checked, { ok: true }>,
): boolean {
  if (row.evidenceSha256 !== pre.evidence.sha256) return false;
  const files: [string | null, string][] = [
    [row.evidencePath, pre.evidence.description],
    [row.buyerRecordPath, JSON.stringify(pre.records.buyer)],
    [row.sellerRecordPath, JSON.stringify(pre.records.seller)],
  ];
  try {
    return files.every(([id, text]) => id !== null && d.docStore.get(id) === text);
  } catch {
    return false;
  }
}

/**
 * The job's side, read from the chain: the escrow is Submitted, holds the row's budget and
 * expiry (the evidence prints both), is far enough from its expiry, and is the case's own (its
 * client the buyer, its evaluator the referee, its provider the seller); the description as
 * written on chain; and the delivered file, read back from the store and checked against both
 * the row's hash and the `JobSubmitted` deliverable of the submit's receipt.
 */
async function jobFactsOf(
  d: FileDisputeDeps,
  row: PilotCaseRecord,
): Promise<
  | string
  | {
      escrow: EscrowOnChain;
      description: string;
      submitted: Hex;
      deliverable: { bytes: Uint8Array; extension: string };
    }
> {
  const { job, publicClient } = d.chain;
  if (row.jobId === null) return `pilot case ${row.caseId} has no job id`;
  if (row.submitTxHash === null) return `pilot case ${row.caseId} has no submit transaction`;
  if (
    row.deliverablePath === null ||
    row.deliverableHash === null ||
    row.deliverableExtension === null
  )
    return `pilot case ${row.caseId} has no stored deliverable`;
  if (!CANONICAL_DECIMAL.test(row.budgetAtomic))
    return `pilot case ${row.caseId} has a budget that is not a decimal`;
  const jobId = BigInt(row.jobId);

  let escrow: EscrowOnChain;
  try {
    escrow = await job.escrowState(jobId);
  } catch (e) {
    return `the escrow of job ${jobId} could not be read: ${safe(e)}`;
  }
  if (escrow.status !== JobStatusOnChain.submitted)
    return `job ${jobId} is at chain status ${escrow.status}, not Submitted (${JobStatusOnChain.submitted}): only a delivered job is disputed`;
  if (escrow.budget !== BigInt(row.budgetAtomic))
    return `job ${jobId} holds a budget of ${escrow.budget}, not the case's ${row.budgetAtomic} (atomic USDC)`;
  if (escrow.expiredAt !== BigInt(row.expiredAt))
    return `job ${jobId} expires at ${escrow.expiredAt}, not at the case's ${row.expiredAt}`;
  const left = escrow.expiredAt - BigInt((d.now ?? unixNow)());
  if (left < BigInt(MIN_SECONDS_TO_EXPIRY))
    return `job ${jobId} expires in ${left > 0n ? left : 0n} s, under ${MIN_SECONDS_TO_EXPIRY} s: an expired job refunds the client whatever the ruling`;
  if (!sameAddress(escrow.client, row.buyerAddress))
    return `job ${jobId} has client ${escrow.client}, not the case's buyer ${row.buyerAddress}`;
  if (!sameAddress(escrow.evaluator, row.refereeAddress))
    return `job ${jobId} has evaluator ${escrow.evaluator}, not the case's referee ${row.refereeAddress}`;
  let onChain: Awaited<ReturnType<JobAdapter["getJob"]>>;
  try {
    onChain = await job.getJob(jobId);
  } catch (e) {
    return `job ${jobId} could not be read: ${safe(e)}`;
  }
  if (!sameAddress(onChain.provider, row.sellerAddress))
    return `job ${jobId} has provider ${onChain.provider}, not the case's seller ${row.sellerAddress}`;
  // The evidence quotes the chain's text and the case view serves the row's: they must agree.
  if (onChain.description !== row.description)
    return `job ${jobId} carries another description than the case's`;

  let receipt: Awaited<ReturnType<typeof publicClient.getTransactionReceipt>>;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: row.submitTxHash as Hex });
  } catch (e) {
    return `the submit receipt ${row.submitTxHash} could not be read: ${safe(e)}`;
  }
  if (receipt.status !== "success") return `the submit transaction ${row.submitTxHash} reverted`;
  let submitted: Hex | undefined;
  try {
    submitted = submittedDeliverableOf(receipt.logs, row.jobContract, jobId);
  } catch (e) {
    return `the submit receipt's JobSubmitted logs cannot be read: ${safe(e)}`;
  }
  if (submitted === undefined) return "the submit receipt carries no JobSubmitted log";

  // The store is flat: the row may hold the file's absolute path or its id, and the file is the
  // one of that name in the store, and only a pilot file.
  const name = basename(row.deliverablePath);
  if (!name.startsWith(PILOT_FILE_PREFIX))
    return `the case's deliverable ${name} is not a pilot file of the document store`;
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(d.docStore.getBytes(name));
  } catch {
    return `the stored deliverable ${name} cannot be read`;
  }
  const hash = keccak256(bytes);
  if (hash !== row.deliverableHash.toLowerCase())
    return `the stored deliverable ${name} hashes to ${hash}, not the case's deliverable hash ${row.deliverableHash}`;
  if (hash !== submitted.toLowerCase())
    return `the stored deliverable ${name} hashes to ${hash}, not the JobSubmitted deliverable ${submitted}`;
  return {
    escrow,
    description: onChain.description,
    submitted,
    deliverable: { bytes, extension: row.deliverableExtension },
  };
}

/** What the stage must be before anything is read. */
function stageProblemOf(stage: KlerosStage): string | undefined {
  if (stage.mode === "rehearsal")
    return stage.service instanceof FakeDisputeService &&
      stage.deployment === null &&
      stage.cap === null &&
      stage.flag === null
      ? undefined
      : "a rehearsal files with the fake Dispute Service only, and with no deployment, cap or flag; this stage is not that: nothing was read or sent";
  if (stage.deployment === null || stage.cap === null || stage.service.deployment !== stage.mode)
    return `the ${stage.mode} stage must hold the ${stage.mode} deployment's own client and cap: nothing was read or sent`;
  return undefined;
}

/** The flag a filing must be confirmed with: none in a rehearsal, the mode's own otherwise. */
function flagProblemOf(
  stage: KlerosStage,
  flag: "--testnet" | "--live" | null,
): string | undefined {
  if (stage.mode === "rehearsal")
    return flag === null
      ? undefined
      : `${flag} is refused in rehearsal mode, which sends nothing to Kleros: nothing was read or sent`;
  const wanted = stage.mode === "testnet" ? "--testnet" : "--live";
  if (flag === wanted) return undefined;
  return flag === null
    ? `a filing in ${stage.mode} mode needs ${wanted} --yes: nothing was read or sent`
    : `${flag} does not confirm a filing in ${stage.mode} mode, which needs ${wanted}: nothing was read or sent`;
}

/** The chain, court and policy URI the stage files on, as the row records them. */
function deploymentOf(d: FileDisputeDeps): {
  klerosChain: KlerosChainOnRow;
  klerosCourtId: number | null;
  klerosPolicyUri: string | null;
} {
  return {
    klerosChain: d.stage.deployment?.chain ?? "fake",
    klerosCourtId: d.stage.deployment?.courtId ?? null,
    klerosPolicyUri: d.klerosCfg?.policyUri ?? null,
  };
}

function sameDeployment(row: PilotCaseRecord, dep: ReturnType<typeof deploymentOf>): boolean {
  return (
    row.klerosChain === dep.klerosChain &&
    row.klerosCourtId === dep.klerosCourtId &&
    row.klerosPolicyUri === dep.klerosPolicyUri
  );
}

function otherDeploymentProblemOf(
  row: PilotCaseRecord,
  dep: ReturnType<typeof deploymentOf>,
): string {
  const of = (chain: string | null, court: number | null, policy: string | null) =>
    `${chain}, court ${court ?? "none"}, policy ${policy ?? "none"}`;
  return `this case was started on another deployment: ${of(row.klerosChain, row.klerosCourtId, row.klerosPolicyUri)}; this stage files on ${of(dep.klerosChain, dep.klerosCourtId, dep.klerosPolicyUri)}, and a case's deployment never changes`;
}

function capProblemOf(mode: string, count: number, cap: number): string {
  return `the ${mode} cap is reached: ${count} ${mode} cases filed, in doubt or failed after filing, of ${cap}; nothing was sent`;
}

function statusProblemOf(row: PilotCaseRecord): string {
  if (row.status === "filing_unknown")
    return `pilot case ${row.caseId} is at filing_unknown: its dispute may exist on Kleros, so it is never filed again; find it in the Court interface by the alias addresses and the time and record its ids, or mark it failed once Kleros confirms none exists`;
  return `pilot case ${row.caseId} is at ${row.status}; only a contested case is filed`;
}

/** How a row found at `filing` reads: another command's filing in progress, or one that stopped. */
type FilingState =
  | { kind: "in_progress"; age: number }
  | { kind: "stopped"; age: number; createMarked: boolean; coreDisputeId: string | null };

function filingStateOf(d: FileDisputeDeps, row: PilotCaseRecord): FilingState {
  const age =
    row.filingStartedAt === null
      ? Number.POSITIVE_INFINITY
      : (d.now ?? unixNow)() - row.filingStartedAt;
  if (age < FILING_IN_PROGRESS_SECONDS) return { kind: "in_progress", age };
  return {
    kind: "stopped",
    age,
    createMarked: createWasMarked(d.cases, row),
    coreDisputeId: row.coreDisputeId,
  };
}

/**
 * Whether this attempt's trail (since its `filing` start) marks a create as sent, or the row
 * holds a create transaction. A fact for the person who resolves the case, never a reason to
 * file again: a slower command may still send its create after this was read.
 */
function createWasMarked(cases: PilotCaseRepository, row: PilotCaseRecord): boolean {
  if (row.createDisputeTx !== null) return true;
  const events = cases.events(row.caseId);
  let start = -1;
  events.forEach((e, i) => {
    if (e.step === "filing" && e.status === "started") start = i;
  });
  return events.slice(start + 1).some((e) => e.step === CREATE_STEP && e.status === "sending");
}

function filingProblemOf(d: FileDisputeDeps, row: PilotCaseRecord): string {
  const state = filingStateOf(d, row);
  if (state.kind === "in_progress")
    return `pilot case ${row.caseId} is being filed by another command, started ${state.age} s ago: a filing is in progress: wait, then run the command again (a filing still at filing after ${FILING_IN_PROGRESS_SECONDS / 60} minutes is treated as stopped)`;
  const started = row.filingStartedAt === null ? "at an unrecorded time" : `${state.age} s ago`;
  const marked = state.createMarked
    ? "its create was marked as sent"
    : "no create was marked as sent, but a slower command may still send one";
  if (state.coreDisputeId === null)
    return `pilot case ${row.caseId} is at filing with no dispute id, a filing started ${started} that stopped part way; ${marked}; it is frozen at filing_unknown and never filed again: check Kleros for a dispute by the alias addresses and the time before recording its ids or marking the case failed`;
  return `pilot case ${row.caseId} is at filing with dispute ${state.coreDisputeId}, a filing started ${started} whose evidence submission stopped part way; ${marked}; it is treated as evidence_unknown`;
}

/** A row found at `filing`: another command's filing, or one that stopped, frozen for a human. */
function stoppedFiling(d: FileDisputeDeps, row: PilotCaseRecord): FileOutcome {
  const state = filingStateOf(d, row);
  const text = filingProblemOf(d, row);
  if (state.kind === "in_progress") return notSent(FILING_IN_PROGRESS, text);
  if (state.coreDisputeId === null) {
    d.cases.transaction(() => {
      if (d.cases.advance(row.caseId, "filing", "filing_unknown", { error: text }))
        d.cases.recordEvent(row.caseId, "filing", "filing_unknown", row.createDisputeTx, text);
    });
    return {
      outcome: "filing_unknown",
      ...(row.createDisputeTx === null ? {} : { txHash: row.createDisputeTx as Hex }),
      text,
    };
  }
  d.cases.transaction(() => {
    if (
      d.cases.advance(row.caseId, "filing", "evidence_unknown", {
        evidenceStatus: "unknown",
        error: text,
      })
    )
      d.cases.recordEvent(row.caseId, "filing", "evidence_unknown", row.evidenceTx, text);
  });
  noteFiled(row, state.coreDisputeId);
  return {
    outcome: "filed",
    coreDisputeId: state.coreDisputeId,
    ...(row.localDisputeId === null ? {} : { localDisputeId: row.localDisputeId }),
    evidenceStatus: "unknown",
  };
}

/**
 * Nothing was sent: the row goes back to `contested`, its attempt left on it as history, but only
 * while it is still this command's filing (at `filing`, with this command's start). A row another
 * command froze or is filing again is left as it is, with an event saying so: a filing that sent
 * nothing never undoes another command's filing.
 */
function backToContested(
  d: FileDisputeDeps,
  own: PilotCaseRecord,
  code: string | null,
  text: string,
): FileOutcome {
  const { cases } = d;
  const back = cases.transaction(() => {
    const now = cases.find(own.caseId);
    if (now?.status === "filing" && now.filingStartedAt === own.filingStartedAt)
      return cases.advance(own.caseId, "filing", "contested") !== undefined;
    cases.recordEvent(
      own.caseId,
      "filing",
      "not_its_own",
      null,
      `the case was no longer this command's filing (it is now ${now?.status ?? "missing"}), so it was not moved back to contested`,
    );
    return false;
  });
  return notSent(
    code,
    back ? text : `${text} (the case was no longer this command's filing and was left as it is)`,
  );
}

/** The create may have been sent: the row freezes, with the hash when there is one. */
function frozenFiling(
  d: FileDisputeDeps,
  caseId: string,
  txHash: Hex | undefined,
  text: string,
): FileOutcome {
  const patch = { error: text, ...(txHash === undefined ? {} : { createDisputeTx: txHash }) };
  if (!d.cases.advance(caseId, "filing", "filing_unknown", patch) && txHash !== undefined)
    d.cases.patch(caseId, { createDisputeTx: txHash });
  return { outcome: "filing_unknown", ...(txHash === undefined ? {} : { txHash }), text };
}

/** The dispute exists and its evidence is in doubt: the row is `evidence_unknown`. */
function evidenceInDoubt(
  d: FileDisputeDeps,
  row: PilotCaseRecord,
  filed: { coreDisputeId: string; localDisputeId?: string },
  txHash: Hex | undefined,
  text: string,
): FileOutcome {
  const facts = {
    evidenceStatus: "unknown",
    error: text,
    ...(txHash === undefined ? {} : { evidenceTx: txHash }),
  };
  if (!d.cases.advance(row.caseId, "filing", "evidence_unknown", facts))
    d.cases.patch(row.caseId, facts);
  noteFiled(row, filed.coreDisputeId);
  return { outcome: "filed", ...filed, evidenceStatus: "unknown" };
}

/** The ops line of a mined create, with the ids a person needs. Observes, never gates. */
function noteCreated(
  row: PilotCaseRecord,
  coreDisputeId: string,
  localDisputeId: string | undefined,
  txHash: Hex,
): void {
  try {
    opsLog("pilot_dispute_created", {
      caseId: row.caseId,
      mode: row.mode,
      klerosChain: row.klerosChain,
      coreDisputeId,
      localDisputeId: localDisputeId ?? null,
      txHash,
    });
  } catch {
    // observe, never gate
  }
}

/** The ops line of a dispute that exists. Observes, never gates. */
function noteFiled(row: PilotCaseRecord, coreDisputeId: string): void {
  try {
    opsLog("pilot_case_filed", {
      caseId: row.caseId,
      mode: row.mode,
      klerosChain: row.klerosChain,
      coreDisputeId,
    });
  } catch {
    // observe, never gate
  }
}

/** `WRITE_IN_PROGRESS` sent nothing and the client has waited it out: one more call, at once. */
async function oneMoreCallAfterWriteInProgress<T>(
  d: FileDisputeDeps,
  caseId: string,
  step: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof KlerosRefusal) || e.code !== WRITE_IN_PROGRESS) throw e;
    d.cases.recordEvent(
      caseId,
      step,
      "write_in_progress",
      null,
      `${klerosTextOf(e)}; calling once more`,
    );
    return await call();
  }
}

/**
 * An HTTP status the service decides before the call runs (Kleros docs, "When something goes
 * wrong"): 401 (the key), 429 (the per-key rate) and 413 (the body's size). Nothing was sent. Any
 * other status may come from a proxy after the request reached the service, and stays in doubt.
 */
function neverRanCodeOf(e: unknown): string | undefined {
  if (!(e instanceof KlerosHttpError)) return undefined;
  if (e.status === 401) return UNAUTHORIZED;
  if (e.status === 429 || e.status === 413) return `http_${e.status}`;
  return undefined;
}

function neverRanTextOf(code: string): string {
  return code === UNAUTHORIZED
    ? UNAUTHORIZED_TEXT
    : `the Dispute Service refused the call before it ran (HTTP ${code.slice("http_".length)}), so nothing was sent`;
}

/** The create's sending mark could not be written: the request was never made. */
class MarkFailedError extends Error {
  constructor(readonly text: string) {
    super(`the create could not be marked as sending: ${text}`);
    this.name = "MarkFailedError";
  }
}

/** The row stopped being this command's filing before its create: nothing is sent. */
class FilingMovedError extends Error {
  constructor(readonly status: string) {
    super(`the case moved from this command's filing (it is now ${status})`);
    this.name = "FilingMovedError";
  }
}

const refusedOrFailed = (e: unknown) =>
  e instanceof KlerosRefusal || neverRanCodeOf(e) !== undefined ? "refused" : "failed";

const notSent = (code: string | null, text: string): FileOutcome => ({
  outcome: "not_sent",
  code,
  text,
});
