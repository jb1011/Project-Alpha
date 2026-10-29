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
import { UNAUTHORIZED_PROBLEM, checkKleros } from "./klerosCheck";
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
 *    before any call) and with no flag; testnet needs `--testnet` and live `--live`. The
 *    pre-flight reads only, then stores the evidence and the two records the filing serves.
 *  - A dispute is created only for a row the compare-and-set just moved from `contested` to
 *    `filing`, in the same command. That move writes the stage's chain, court and policy URI,
 *    which never change after. A create whose outcome is in doubt freezes the row at
 *    `filing_unknown`, and no later command creates again: a human resolves it.
 *  - A refusal the Kleros docs say sent nothing moves the row back to `contested`, to be filed
 *    again once the cause is fixed; the attempt's start time and deployment stay on the row.
 *  - Every Kleros write writes an event with its status and reference, and the row's moves are
 *    compare-and-set. The ids and hashes of a mined write are written whatever the row's status
 *    by then: they are facts about Kleros.
 *
 * No key is read here: the stage's client holds it. Every text an event or an outcome carries
 * from an exception goes through `publicErrorMessage` first.
 */

/** The escrow as the job adapter reads it from the chain. */
export type EscrowState = Awaited<ReturnType<JobAdapter["escrowState"]>>;

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
  sleep?: (ms: number) => Promise<void>;
}

export type Preflight =
  | {
      ok: true;
      evidence: Evidence;
      court: CourtClock;
      instructions: string | null;
      escrow: EscrowState;
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
/** Another write on the same key was running (nothing was sent): wait once, then call again. */
const WRITE_IN_PROGRESS = "WRITE_IN_PROGRESS";
const WRITE_IN_PROGRESS_WAIT_MS = 30_000;
/** The codes of a refusal that is ours, not the service's. */
const UNAUTHORIZED = "unauthorized";
const PIN_CHECKED_ONLY = "pin_checked_only";
const UNAUTHORIZED_TEXT =
  "the Dispute Service refused the key of this stage (HTTP 401): it is wrong or revoked; nothing was sent";
/** The alias slot keys of the preset when no Kleros config is set (a rehearsal box). */
const DEFAULT_ALIAS_CLIENT = "client";
const DEFAULT_ALIAS_PROVIDER = "provider";
/** The store's own names for the pilot's files; every one starts with this. */
const PILOT_FILE_PREFIX = "pilot-";
const LIVE_GATE =
  "file and look at a testnet case first: live mode files only once a testnet case is filed and recorded as seen in the Kleros Court interface (pilot:case seen-in-court)";

const unixNow = () => Math.floor(Date.now() / 1000);
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** An exception's text, fit to persist or print. */
const safe = (e: unknown) => withoutEmDash(publicErrorMessage(e));

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

/** Pre-flight again, then: advance contested -> filing (writing the stage's chain, court and policy URI); pin; create; submit; the row's final status per outcome. */
export async function fileDispute(
  d: FileDisputeDeps,
  caseId: string,
  opts: { allowStanding?: string; confirmedFlag: "--testnet" | "--live" | null },
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
  // both pass it. The deployment is written on the first filing and only compared after it.
  const moved = cases.transaction((): PilotCaseRecord | string => {
    const count = cases.countFiled(stage.mode);
    if (stage.cap !== null && count >= stage.cap) return capProblemOf(stage.mode, count, stage.cap);
    const current = cases.find(caseId);
    if (current?.klerosChain != null && !sameDeployment(current, deployment))
      return otherDeploymentProblemOf(current, deployment);
    const next = cases.advance(caseId, "contested", "filing", {
      filingStartedAt: now,
      ...(current?.klerosChain == null ? deployment : {}),
    });
    if (!next) return `pilot case ${caseId} moved from contested while this command ran`;
    cases.recordEvent(caseId, "filing", "started", deployment.klerosChain, null);
    return next;
  });
  if (typeof moved === "string") return notSent(null, moved);

  const write = <T>(step: string, call: () => Promise<T>) =>
    oneMoreCallAfterWriteInProgress(d, caseId, step, call);
  const { extension, bytes } = pre.deliverable;

  // 1. The delivered file, pinned once: a filing tried again reuses the attachment it pinned.
  let attachment: { fileUri: string; cid: string };
  if (moved.attachmentUri !== null && moved.attachmentCid !== null) {
    attachment = { fileUri: moved.attachmentUri, cid: moved.attachmentCid };
    cases.recordEvent(caseId, "pin", "reused", attachment.fileUri, attachment.cid);
  } else {
    let pinned: PinOutcome;
    try {
      pinned = await write("pin", () => stage.service.pin({ bytes, extension }));
    } catch (e) {
      cases.recordEvent(
        caseId,
        "pin",
        e instanceof KlerosRefusal ? "refused" : "failed",
        null,
        safe(e),
      );
      if (isUnauthorized(e)) return backToContested(d, caseId, UNAUTHORIZED, UNAUTHORIZED_TEXT);
      return backToContested(
        d,
        caseId,
        e instanceof KlerosRefusal ? e.code : null,
        `the delivered file was not pinned, so nothing was filed: ${safe(e)}`,
      );
    }
    if (pinned.status === "checked") {
      cases.recordEvent(
        caseId,
        "pin",
        "checked",
        null,
        "the key checked the file and published nothing",
      );
      return backToContested(
        d,
        caseId,
        PIN_CHECKED_ONLY,
        "the key only checked the delivered file and published nothing, so nothing was filed: read the key's instructions with pilot:kleros check",
      );
    }
    const published = pinned;
    cases.transaction(() => {
      cases.patch(caseId, { attachmentUri: published.fileUri, attachmentCid: published.cid });
      cases.recordEvent(caseId, "pin", "published", published.fileUri, published.cid);
    });
    attachment = { fileUri: published.fileUri, cid: published.cid };
  }

  // 2. The dispute, created once.
  const aliases: Record<string, Address> = {
    [d.klerosCfg?.aliasClient ?? DEFAULT_ALIAS_CLIENT]: moved.buyerAddress as Address,
    [d.klerosCfg?.aliasProvider ?? DEFAULT_ALIAS_PROVIDER]: moved.sellerAddress as Address,
  };
  let created: CreateOutcome;
  try {
    created = await write("create", () => stage.service.createDispute({ aliases }));
  } catch (e) {
    const detail = safe(e);
    if (isUnauthorized(e)) {
      cases.recordEvent(caseId, "create", "refused", null, detail);
      return backToContested(d, caseId, UNAUTHORIZED, UNAUTHORIZED_TEXT);
    }
    if (e instanceof KlerosRefusal && sentOf("dispute_create", e.code) === "no") {
      cases.recordEvent(caseId, "create", "refused", null, detail);
      return backToContested(
        d,
        caseId,
        e.code,
        `Kleros refused the filing and nothing was sent: ${detail}`,
      );
    }
    // Anything else may have been sent: never file again.
    cases.recordEvent(caseId, "create", "unknown", null, detail);
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
    cases.recordEvent(caseId, "create", "simulated", null, text);
    return backToContested(d, caseId, PRESET_SIMULATES, text);
  }
  if (created.status === "unknown") {
    const text = safe(created.text);
    cases.recordEvent(caseId, "create", "unknown", created.txHash ?? null, text);
    return frozenFiling(d, caseId, created.txHash, text);
  }
  const { coreDisputeId, localDisputeId, txHash: createTx } = created;
  cases.transaction(() => {
    cases.patch(caseId, {
      coreDisputeId,
      localDisputeId: localDisputeId ?? null,
      createDisputeTx: createTx,
      filedAt: (d.now ?? unixNow)(),
    });
    cases.recordEvent(caseId, "create", "mined", createTx, `dispute ${coreDisputeId}`);
  });
  const filed = { coreDisputeId, ...(localDisputeId === undefined ? {} : { localDisputeId }) };

  // 3. The evidence, submitted once: any answer but mined is the human's to read.
  let submitted: SubmitOutcome;
  try {
    submitted = await write("submit", () =>
      stage.service.submitEvidence({
        coreDisputeId,
        name: pre.evidence.name,
        description: pre.evidence.description,
        fileUri: attachment.fileUri,
        fileTypeExtension: extension,
      }),
    );
  } catch (e) {
    const detail = safe(e);
    const refused = e instanceof KlerosRefusal || isUnauthorized(e);
    cases.recordEvent(caseId, "submit", refused ? "refused" : "unknown", null, detail);
    return evidenceInDoubt(d, moved, filed, undefined, detail);
  }
  if (submitted.status === "simulated") {
    const text = `${PRESET_SIMULATES}: the key simulated the evidence; nothing was submitted`;
    cases.recordEvent(caseId, "submit", "simulated", null, text);
    return evidenceInDoubt(d, moved, filed, undefined, text);
  }
  if (submitted.status === "unknown") {
    const text = safe(submitted.text);
    cases.recordEvent(caseId, "submit", "unknown", submitted.txHash ?? null, text);
    return evidenceInDoubt(d, moved, filed, submitted.txHash, text);
  }
  const evidenceTx = submitted.txHash;
  cases.transaction(() => {
    const facts = { evidenceTx, evidenceStatus: "mined" };
    if (!cases.advance(caseId, "filing", "filed", facts)) cases.patch(caseId, facts);
    cases.recordEvent(caseId, "submit", "mined", evidenceTx, null);
  });
  noteFiled(moved, coreDisputeId);
  return { outcome: "filed", ...filed, evidenceStatus: "mined" };
}

/**
 * The pre-flight. Reads only until every check has passed; then writes the evidence and the two
 * records to the store and their names to the row, in one compare-and-set on `contested`.
 */
async function check(
  d: FileDisputeDeps,
  caseId: string,
  opts: { allowStanding?: string },
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
    return { ok: false, problem: stoppedFilingProblemOf(row), code: null, atFiling: row };
  if (row.status !== "contested") return no(statusProblemOf(row));
  const deployment = deploymentOf(d);
  if (row.klerosChain !== null && !sameDeployment(row, deployment))
    return no(otherDeploymentProblemOf(row, deployment));
  const filedCount = cases.countFiled(stage.mode);
  if (stage.cap !== null && filedCount >= stage.cap)
    return no(capProblemOf(stage.mode, filedCount, stage.cap));
  if (stage.mode === "live" && cases.countSeenInCourt("testnet") < 1) return no(LIVE_GATE);

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
  // is the lookup's answer exactly as it came back, as read for this filing.
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
  const stored = cases.transaction(() => {
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
  if (!stored) return no(`pilot case ${caseId} moved from contested while the pre-flight ran`);

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

/**
 * The job's side, read from the chain: the escrow is Submitted, far enough from its expiry, and
 * the case's own (its client the buyer, its evaluator the referee, its provider the seller); the
 * description as written on chain; and the delivered file, read back from the store and checked
 * against both the row's hash and the `JobSubmitted` deliverable of the submit's receipt.
 */
async function jobFactsOf(
  d: FileDisputeDeps,
  row: PilotCaseRecord,
): Promise<
  | string
  | {
      escrow: EscrowState;
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
  const jobId = BigInt(row.jobId);

  let escrow: EscrowState;
  try {
    escrow = await job.escrowState(jobId);
  } catch (e) {
    return `the escrow of job ${jobId} could not be read: ${safe(e)}`;
  }
  if (escrow.status !== JobStatusOnChain.submitted)
    return `job ${jobId} is at chain status ${escrow.status}, not Submitted (${JobStatusOnChain.submitted}): only a delivered job is disputed`;
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
    return stage.service instanceof FakeDisputeService
      ? undefined
      : "a rehearsal files with the fake Dispute Service only, and this stage holds another client: nothing was read or sent";
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
  return `the ${mode} cap is reached: ${count} ${mode} cases filed or in doubt, of ${cap}; nothing was sent`;
}

function statusProblemOf(row: PilotCaseRecord): string {
  if (row.status === "filing_unknown")
    return `pilot case ${row.caseId} is at filing_unknown: its dispute may exist on Kleros, so it is never filed again; find it in the Court interface by the alias addresses and the time and record its ids, or mark it failed once Kleros confirms none exists`;
  return `pilot case ${row.caseId} is at ${row.status}; only a contested case is filed`;
}

function stoppedFilingProblemOf(row: PilotCaseRecord): string {
  return row.coreDisputeId === null
    ? `pilot case ${row.caseId} is at filing with no dispute id: a filing stopped part way, so its dispute may exist on Kleros; it is treated as filing_unknown and never filed again`
    : `pilot case ${row.caseId} is at filing with dispute ${row.coreDisputeId}: its evidence submission stopped part way; it is treated as evidence_unknown`;
}

/** A row found at `filing`: a command stopped between a write and the row's move. */
function stoppedFiling(d: FileDisputeDeps, row: PilotCaseRecord): FileOutcome {
  const text = stoppedFilingProblemOf(row);
  if (row.coreDisputeId === null) {
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
  return {
    outcome: "filed",
    coreDisputeId: row.coreDisputeId,
    ...(row.localDisputeId === null ? {} : { localDisputeId: row.localDisputeId }),
    evidenceStatus: "unknown",
  };
}

/** Nothing was sent: the row goes back to `contested`, its attempt left on it as history. */
function backToContested(
  d: FileDisputeDeps,
  caseId: string,
  code: string | null,
  text: string,
): FileOutcome {
  const back = d.cases.advance(caseId, "filing", "contested");
  return notSent(code, back ? text : `${text} (the case had moved and was left as it is)`);
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

/** `WRITE_IN_PROGRESS` sent nothing: one wait, one more call, each call with its own event. */
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
      `${safe(e)}; waiting ${WRITE_IN_PROGRESS_WAIT_MS / 1000} s, then one more call`,
    );
    await (d.sleep ?? realSleep)(WRITE_IN_PROGRESS_WAIT_MS);
    return await call();
  }
}

const isUnauthorized = (e: unknown) => e instanceof KlerosHttpError && e.status === 401;

const notSent = (code: string | null, text: string): FileOutcome => ({
  outcome: "not_sent",
  code,
  text,
});
