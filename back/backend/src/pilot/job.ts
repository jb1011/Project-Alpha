import { Buffer } from "node:buffer";
import {
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  decodeFunctionData,
  keccak256,
  parseEventLogs,
} from "viem";
import { iErc8183JobAbi, iIdentityRegistryAbi } from "../abis/generated";
import {
  ChainTxRevertedError,
  ChainTxUnconfirmedError,
  JobFundRevertedError,
  JobFundUnconfirmedError,
} from "../errors";
import type { FileDocumentStore } from "../persistence/documentStore";
import { publicErrorMessage } from "../workflow/publicError";
import { type PilotCaseRepository, newCaseId } from "./casesRepository";
import type { PilotChain } from "./composition";
import { createdJobIdOf, jobSubmittedEventAbi, submittedDeliverableOf } from "./jobEvents";
import { type LookupClient, activeLegalName } from "./lookup";
import type { PilotCaseRecord, PilotMode } from "./types";

/**
 * THE PILOT JOB: an ERC-8183 job between two agents with legal bodies, created and funded by the
 * buyer, budgeted and submitted by the seller, with the referee as its evaluator. Recorded as a
 * pilot case, one status per mined step, so a run that dies part way is resumed from the chain.
 *
 * Nothing is sent until the pre-flight passes. Every mined step writes an event with its hash; a
 * step whose transaction reverted or could not be confirmed writes an event with that hash and
 * rethrows, and the row keeps its status so the case can be resumed.
 */
export interface CreatePilotJobInput {
  label: string;
  description: string;
  deliverable: { bytes: Uint8Array; extension: string };
  budgetAtomic: bigint;
  expirySeconds: number;
  /** The mode of the command that creates the job; the case is filed and settled in it only. */
  mode: PilotMode;
  /**
   * On a resume: the hash of a fund or a submit that landed when the case lost it (the run
   * failed between the send and the receipt). It is tried before any recorded hash, through the
   * same proof, and refused with the proof's reason when it does not match.
   */
  givenTx?: { fund?: Hex; submit?: Hex };
}

export interface PilotJobDeps {
  chain: PilotChain;
  cases: PilotCaseRepository;
  docStore: FileDocumentStore;
  lookup: LookupClient;
  agentIds: { buyer: string; seller: string };
  /** Unix seconds. */
  now?: () => number;
  maxBudgetAtomic: bigint;
}

/** What the buyer must hold beyond the budget: 0.5 USDC, in 6-decimal atomic units. */
const BALANCE_MARGIN_ATOMIC = 500_000n;
const DAY = 86_400;
/** testnet and live: a day to thirty days, so the expiry is well past the time a ruling takes. */
const MIN_EXPIRY_SECONDS = DAY;
const MAX_EXPIRY_SECONDS = 30 * DAY;
/** rehearsal: short enough to watch an expiry happen. */
const MIN_REHEARSAL_EXPIRY_SECONDS = 120;
/**
 * testnet and live, on a resume: the job must have an hour left, so a step sent now lands well
 * before the expiry. A day is the minimum to create a job, not to finish one.
 */
const MIN_RESUME_SECONDS_LEFT = 3_600;
/** The job contract's status numbers. */
const OPEN = 0;
const FUNDED = 1;
const SUBMITTED = 2;

const unixNow = () => Math.floor(Date.now() / 1000);

export async function preflightPilotJob(
  d: PilotJobDeps,
  input: CreatePilotJobInput,
): Promise<
  | { ok: true; buyerBalance: bigint; buyerName: string; sellerName: string }
  | { ok: false; problem: string }
> {
  const r = await checks(d, input, { balance: true });
  return r.ok ? { ...r, buyerBalance: r.buyerBalance as bigint } : r;
}

/**
 * The pre-flight's checks. A fresh job and a resume whose chain reads Open run all of them; a
 * resume whose chain reads Funded skips the balance, which the escrow has already taken.
 */
async function checks(
  d: PilotJobDeps,
  input: Pick<CreatePilotJobInput, "budgetAtomic" | "expirySeconds" | "mode" | "deliverable">,
  /** `resumingJob`: the expiry is the time this job has left, not an option the operator gave. */
  o: { balance: boolean; resumingJob?: bigint },
): Promise<
  | { ok: true; buyerBalance: bigint | null; buyerName: string; sellerName: string }
  | { ok: false; problem: string }
> {
  const refuse = (problem: string) => ({ ok: false as const, problem });

  if (input.budgetAtomic <= 0n) return refuse("the budget must be above zero");
  if (input.budgetAtomic > d.maxBudgetAtomic)
    return refuse(
      `the budget ${input.budgetAtomic} is above the maximum of ${d.maxBudgetAtomic} (atomic USDC)`,
    );
  const expiryProblem =
    o.resumingJob === undefined
      ? expiryProblemOf(input.mode, input.expirySeconds)
      : timeLeftProblemOf(input.mode, input.expirySeconds, o.resumingJob);
  if (expiryProblem) return refuse(expiryProblem);
  if (!/^[A-Za-z0-9]{1,16}$/.test(input.deliverable.extension))
    return refuse(
      `the deliverable extension ${JSON.stringify(input.deliverable.extension)} must be 1 to 16 letters or digits`,
    );

  const names: Record<"buyer" | "seller", string> = { buyer: "", seller: "" };
  for (const role of ["buyer", "seller"] as const) {
    const agentId = d.agentIds[role];
    let answer: Awaited<ReturnType<LookupClient["byAgent"]>>;
    try {
      answer = await d.lookup.byAgent(agentId);
    } catch (e) {
      return refuse(`the ${role}'s legal-body lookup failed: ${publicErrorMessage(e)}`);
    }
    if (!answer.legalBody) return refuse(`the ${role}'s agent ${agentId} has no legal body`);
    if (answer.standing !== "active")
      return refuse(
        `the ${role}'s legal body (agent ${agentId}) is ${answer.standing}, not active`,
      );
    const named = activeLegalName(answer);
    if (!named)
      return refuse(`the ${role}'s legal body (agent ${agentId}) has no signed statement`);
    names[role] = named.legalName;

    const expected = d.chain.addresses[role];
    let owner: string;
    try {
      owner = (await d.chain.publicClient.readContract({
        address: d.chain.identityRegistry,
        abi: iIdentityRegistryAbi,
        functionName: "ownerOf",
        args: [BigInt(agentId)],
      })) as string;
    } catch (e) {
      // A revert is the registry's answer (no such agent); anything else is a failed read.
      if (isRevert(e))
        return refuse(`the ${role}'s agent ${agentId} has no owner in the identity registry`);
      return refuse(
        `the ${role}'s agent ${agentId}'s owner could not be read from the identity registry: ${publicErrorMessage(e)}`,
      );
    }
    if (owner.toLowerCase() !== expected.toLowerCase())
      return refuse(
        `the ${role}'s agent ${agentId} is owned by ${owner}, not by the ${role}'s address ${expected}`,
      );
  }

  // The seller sends setBudget and submit, and the referee settles later: each needs gas.
  for (const role of ["seller", "referee"] as const) {
    const address = d.chain.addresses[role];
    let gas: bigint;
    try {
      gas = await d.chain.publicClient.getBalance({ address });
    } catch (e) {
      return refuse(`the ${role}'s gas balance could not be read: ${publicErrorMessage(e)}`);
    }
    if (gas === 0n)
      return refuse(`the ${role}'s address ${address} holds no gas to send its transactions`);
  }

  if (!o.balance)
    return { ok: true, buyerBalance: null, buyerName: names.buyer, sellerName: names.seller };
  let buyerBalance: bigint;
  try {
    buyerBalance = await d.chain.job.usdcBalanceOf(d.chain.usdc, d.chain.addresses.buyer);
  } catch (e) {
    return refuse(`the buyer's USDC balance could not be read: ${publicErrorMessage(e)}`);
  }
  const needed = input.budgetAtomic + BALANCE_MARGIN_ATOMIC;
  if (buyerBalance < needed)
    return refuse(
      `the buyer's USDC balance ${buyerBalance} is below the budget plus 0.5 USDC (${needed}, atomic)`,
    );
  return { ok: true, buyerBalance, buyerName: names.buyer, sellerName: names.seller };
}

/** A contract call the chain answered with a revert, as opposed to a read that failed. */
function isRevert(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  if (e.walk((x) => x instanceof ContractFunctionRevertedError)) return true;
  // A node that reports the revert only in its message, as some RPC proxies do.
  return /execution reverted/i.test(e.message);
}

function expiryProblemOf(mode: PilotMode, seconds: number): string | undefined {
  if (!Number.isSafeInteger(seconds)) return "the expiry must be a whole number of seconds";
  // Thirty days at most in every mode: a rehearsal job is a real job on Arc testnet too.
  if (mode === "rehearsal")
    return seconds >= MIN_REHEARSAL_EXPIRY_SECONDS && seconds <= MAX_EXPIRY_SECONDS
      ? undefined
      : `the expiry must be between ${MIN_REHEARSAL_EXPIRY_SECONDS} and ${MAX_EXPIRY_SECONDS} seconds in rehearsal mode (got ${seconds})`;
  return seconds >= MIN_EXPIRY_SECONDS && seconds <= MAX_EXPIRY_SECONDS
    ? undefined
    : `the expiry must be between ${MIN_EXPIRY_SECONDS} and ${MAX_EXPIRY_SECONDS} seconds in ${mode} mode (got ${seconds})`;
}

/** On a resume: a job with less time left than the mode's minimum is not continued. */
function timeLeftProblemOf(
  mode: PilotMode,
  secondsLeft: number,
  jobId: bigint,
): string | undefined {
  const minimum = mode === "rehearsal" ? MIN_REHEARSAL_EXPIRY_SECONDS : MIN_RESUME_SECONDS_LEFT;
  if (!Number.isSafeInteger(secondsLeft)) return "the time left must be a whole number of seconds";
  if (secondsLeft < minimum)
    return `job ${jobId} has ${Math.max(secondsLeft, 0)} seconds left, under the resume minimum of ${minimum} for ${mode} mode; it waits for expiry and a refund`;
  if (secondsLeft > MAX_EXPIRY_SECONDS)
    return `job ${jobId} has ${secondsLeft} seconds left, over the maximum of ${MAX_EXPIRY_SECONDS}`;
  return undefined;
}

/**
 * The case an error belongs to, once a row exists: `createPilotJob` sets it on whatever it
 * rethrows after the insert, and on every failure of a resume of a case shown resumable, so the
 * caller can name the case to resume. The error itself is the original, with its class and its hash.
 */
export function pilotCaseIdOf(e: unknown): string | undefined {
  const id = (e as { pilotCaseId?: unknown } | null)?.pilotCaseId;
  return typeof id === "string" ? id : undefined;
}

/** Marks `e` as a failure of pilot case `caseId` (see `pilotCaseIdOf`) and returns it. */
export function withPilotCaseId<E>(e: E, caseId: string): E {
  if (typeof e === "object" && e !== null && Object.isExtensible(e))
    Object.defineProperty(e, "pilotCaseId", { value: caseId, enumerable: false });
  return e;
}

/**
 * Whether `e` is a create that failed without a hash after the pre-flight passed: the
 * transaction may have been sent, and no row records it, so the caller warns before a re-run.
 */
export function createMayHaveBeenSent(e: unknown): boolean {
  return (
    (e as { pilotCreateMayHaveBeenSent?: unknown } | null)?.pilotCreateMayHaveBeenSent === true
  );
}

/** Marks `e` as a create that may have been sent (see `createMayHaveBeenSent`) and returns it. */
export function withCreateMayHaveBeenSent<E>(e: E): E {
  if (typeof e === "object" && e !== null && Object.isExtensible(e))
    Object.defineProperty(e, "pilotCreateMayHaveBeenSent", { value: true, enumerable: false });
  return e;
}

/** Pre-flight, then create, budget and fund, submit; resumable from created and funded. */
export async function createPilotJob(
  d: PilotJobDeps,
  input: CreatePilotJobInput,
  resumeCaseId?: string,
): Promise<PilotCaseRecord> {
  if (resumeCaseId !== undefined) {
    // The case id is attached only once the case is shown to exist, be resumable and be this
    // mode's: a hint to resume an unknown or a finished case would send the operator in a loop.
    const row = resumable(d, input, resumeCaseId);
    try {
      return await resume(d, input, row);
    } catch (e) {
      throw withPilotCaseId(e, resumeCaseId);
    }
  }

  const pre = await preflightPilotJob(d, input);
  if (!pre.ok) throw new Error(`refusing to create the pilot job: ${pre.problem}`);

  const { chain } = d;
  const caseId = newCaseId();
  const expiredAt = (d.now ?? unixNow)() + input.expirySeconds;
  // No row exists before the job does: a failed createJob leaves nothing to resume, and its
  // error carries the hash when one was sent. One without a hash may still have been sent.
  let created: { jobId: bigint; txHash: Hex };
  try {
    created = await chain.job.createJob({
      provider: chain.addresses.seller,
      evaluator: chain.addresses.referee,
      expiredAt: BigInt(expiredAt),
      description: input.description,
    });
  } catch (e) {
    const hashed = e instanceof ChainTxRevertedError || e instanceof ChainTxUnconfirmedError;
    throw hashed ? e : withCreateMayHaveBeenSent(e);
  }
  const { jobId, txHash } = created;
  // The row and its hash are written before anything else is read, so a failure after this point
  // leaves a case to resume rather than a job nobody recorded.
  d.cases.transaction(() => {
    d.cases.insert({
      caseId,
      label: input.label,
      mode: input.mode,
      chainId: chain.chainId,
      jobContract: chain.jobContract,
      buyerAddress: chain.addresses.buyer,
      buyerAgentId: d.agentIds.buyer,
      sellerAddress: chain.addresses.seller,
      sellerAgentId: d.agentIds.seller,
      refereeAddress: chain.addresses.referee,
      budgetAtomic: input.budgetAtomic.toString(),
      description: input.description,
      expiredAt,
      deliverablePath: null,
      deliverableHash: null,
      deliverableExtension: null,
    });
    d.cases.patch(caseId, { jobId: jobId.toString(), createTxHash: txHash });
    d.cases.recordEvent(caseId, "create", "mined", txHash, null);
  });
  try {
    const row = await settleCreate(d, d.cases.find(caseId) as PilotCaseRecord);
    return await continueCase(d, input, row);
  } catch (e) {
    throw withPilotCaseId(e, caseId);
  }
}

/**
 * The create's receipt, read once the row exists: its block time, and the job id the deployed
 * contract's `JobCreated` log names for our parties and expiry. A simulated id can name another
 * job on a busy contract; when the log names a different one, the row takes the log's and an
 * event says so. A receipt without such a log (the local mock emits another shape) keeps the
 * simulated id. The row is inserted before this read, so a failure here leaves a case whose
 * resume reads the receipt again.
 */
async function settleCreate(d: PilotJobDeps, row: PilotCaseRecord): Promise<PilotCaseRecord> {
  const { chain, cases } = d;
  const hash = row.createTxHash as Hex;
  const receipt = await chain.publicClient.getTransactionReceipt({ hash });
  const block = await chain.publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const logged = createdJobIdOf(receipt.logs, chain.jobContract, {
    client: row.buyerAddress,
    provider: row.sellerAddress,
    evaluator: row.refereeAddress,
    expiredAt: BigInt(row.expiredAt),
  });
  return cases.transaction(() => {
    if (logged !== undefined && logged.toString() !== row.jobId) {
      cases.recordEvent(
        row.caseId,
        "create",
        "job_id_from_log",
        hash,
        `the simulation gave job ${row.jobId}; the JobCreated log of the create gives job ${logged}`,
      );
      cases.patch(row.caseId, { jobId: logged.toString() });
    }
    return cases.patch(row.caseId, { createdBlockTime: Number(block.timestamp) });
  });
}

/** The row to resume, or a refusal: it must exist, be at created or funded, and be this mode's. */
function resumable(d: PilotJobDeps, input: CreatePilotJobInput, caseId: string): PilotCaseRecord {
  const row = d.cases.find(caseId);
  if (!row) throw new Error(`refusing to resume: no pilot case ${caseId}`);
  if (row.status !== "created" && row.status !== "funded")
    throw new Error(
      `refusing to resume pilot case ${caseId}: it is at ${row.status}; only created and funded resume`,
    );
  if (row.mode !== input.mode)
    throw new Error(
      `refusing to resume pilot case ${caseId}: it was created in ${row.mode} mode, and this command runs in ${input.mode} mode`,
    );
  if (row.jobId === null)
    throw new Error(`refusing to resume pilot case ${caseId}: it has no job id`);
  // The case's own parties: a resume under another agent configuration would vet other agents
  // and sign with other keys. Ids and addresses only; no key is named.
  const pairs: [string, string, string, boolean][] = [
    ["buyer's agent id", row.buyerAgentId, d.agentIds.buyer, false],
    ["seller's agent id", row.sellerAgentId, d.agentIds.seller, false],
    ["buyer's address", row.buyerAddress, d.chain.addresses.buyer, true],
    ["seller's address", row.sellerAddress, d.chain.addresses.seller, true],
  ];
  for (const [what, onRow, now, isAddress] of pairs)
    if (isAddress ? !sameAddress(onRow, now) : onRow !== now)
      throw new Error(
        `refusing to resume pilot case ${caseId}: the case's ${what} is ${onRow}, and this command's is ${now}`,
      );
  return row;
}

/**
 * A resume runs the pre-flight again before anything is sent: in full while the chain reads Open
 * (nothing is escrowed, so the money gate stands), without the balance while it reads Funded. The
 * budget is the row's and the expiry is the time the job has left. A job already at Submitted is
 * only adopted, which sends nothing, so no check runs for it.
 */
async function resume(
  d: PilotJobDeps,
  input: CreatePilotJobInput,
  start: PilotCaseRecord,
): Promise<PilotCaseRecord> {
  let row = start;
  // A run that stopped right after the create never read its receipt: read it now, so the case
  // carries the mined job id and the block time the later steps need.
  if (row.createdBlockTime === null && row.createTxHash !== null) row = await settleCreate(d, row);
  const onChain = await chainStatusOf(d, row);
  if (onChain === OPEN || onChain === FUNDED) {
    const pre = await checks(
      d,
      {
        budgetAtomic: BigInt(row.budgetAtomic),
        expirySeconds: row.expiredAt - (d.now ?? unixNow)(),
        mode: row.mode,
        deliverable: input.deliverable,
      },
      { balance: onChain === OPEN, resumingJob: BigInt(row.jobId as string) },
    );
    if (!pre.ok) throw new Error(`refusing to resume pilot case ${row.caseId}: ${pre.problem}`);
  }
  return continueCase(d, input, row);
}

/**
 * The job's status on chain, once the job is shown to be this case's: its client is the buyer,
 * its provider the seller, its evaluator the referee, its expiry and description the row's, and
 * once funded its budget the row's. A job id taken from a simulate can name another job (two
 * creates at once with the same keys), and adopting that job would make the row lie.
 */
async function chainStatusOf(d: PilotJobDeps, row: PilotCaseRecord): Promise<number> {
  const jobId = BigInt(row.jobId as string);
  const s = await d.chain.job.getJob(jobId);
  const refuse = (what: string) =>
    new Error(`refusing to continue pilot case ${row.caseId}: job ${jobId} ${what}`);
  if (!sameAddress(s.client, row.buyerAddress))
    throw refuse(`has client ${s.client}, not the buyer ${row.buyerAddress}`);
  if (!sameAddress(s.provider, row.sellerAddress))
    throw refuse(`has provider ${s.provider}, not the seller ${row.sellerAddress}`);
  if (!sameAddress(s.evaluator, row.refereeAddress))
    throw refuse(`has evaluator ${s.evaluator}, not the referee ${row.refereeAddress}`);
  if (s.expiredAt !== BigInt(row.expiredAt))
    throw refuse(`expires at ${s.expiredAt}, not at the case's ${row.expiredAt}`);
  if (s.description !== row.description) throw refuse("has another description than the case's");
  if ((s.status === FUNDED || s.status === SUBMITTED) && s.budget.toString() !== row.budgetAtomic)
    throw refuse(`holds a budget of ${s.budget}, not the case's ${row.budgetAtomic}`);
  return s.status;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** From the row's status and the chain's, one step at a time until the row is at submitted. */
async function continueCase(
  d: PilotJobDeps,
  input: CreatePilotJobInput,
  start: PilotCaseRecord,
): Promise<PilotCaseRecord> {
  let row = start;
  const jobId = BigInt(row.jobId as string);
  while (row.status !== "submitted") {
    const onChain = await chainStatusOf(d, row);
    // A hash given for a step the chain says has not happened names nothing to adopt, and the
    // steps before it would be sent: refuse before anything is sent.
    if (input.givenTx?.fund !== undefined && onChain === OPEN)
      throw new Error(
        `refusing to continue pilot case ${row.caseId}: job ${jobId} is Open on chain, so no fund landed: run the resume without --fund-tx`,
      );
    if (input.givenTx?.submit !== undefined && onChain < SUBMITTED)
      throw new Error(
        `refusing to continue pilot case ${row.caseId}: job ${jobId} is ${onChain === OPEN ? "Open" : "Funded"} on chain, not Submitted, so a submit cannot be adopted for it: run the resume without --submit-tx`,
      );
    if (row.status === "created" && onChain === OPEN) row = await budgetAndFund(d, row, jobId);
    else if (row.status === "created" && onChain === FUNDED)
      row = await adoptFund(d, input, row, jobId);
    else if (row.status === "funded" && onChain === FUNDED)
      row = await submitDeliverable(d, input, row, jobId);
    else if (row.status === "funded" && onChain === SUBMITTED)
      row = await adoptSubmit(d, input, row, jobId);
    else
      throw new Error(
        `refusing to continue pilot case ${row.caseId}: the row is at ${row.status} and job ${jobId} is at chain status ${onChain}`,
      );
  }
  return row;
}

async function budgetAndFund(
  d: PilotJobDeps,
  row: PilotCaseRecord,
  jobId: bigint,
): Promise<PilotCaseRecord> {
  const { chain, cases } = d;
  const budget = BigInt(row.budgetAtomic);
  const budgetHash = await recorded(d, row.caseId, "setBudget", () =>
    chain.job.setBudget(jobId, budget, chain.wallets.seller),
  );
  cases.recordEvent(row.caseId, "setBudget", "mined", budgetHash, null);
  const fundHash = await recorded(d, row.caseId, "fund", () =>
    chain.job.approveAndFund(jobId, chain.usdc, budget),
  );
  cases.recordEvent(row.caseId, "fund", "mined", fundHash, null);
  const fundedBlockTime = await blockTimeOf(chain, fundHash);
  return moved(d, row, "funded", { fundTxHash: fundHash, fundedBlockTime });
}

/**
 * The row says created and the chain says Funded: a fund this process sent has landed after the
 * run stopped (unconfirmed in time, or mined and the run died before the row moved). The fund is
 * adopted only once a transaction is proven to be the buyer's `fund` of this job with a successful
 * receipt; the hash and block time come from it. Nothing proven, nothing adopted.
 */
async function adoptFund(
  d: PilotJobDeps,
  input: CreatePilotJobInput,
  row: PilotCaseRecord,
  jobId: bigint,
): Promise<PilotCaseRecord> {
  const proven = await provenSent(d, row, "fund", input.givenTx?.fund, async (hash) => {
    const p = await callProofOf(d, hash, {
      fn: "fund",
      verb: "funds",
      jobId,
      sender: row.buyerAddress,
      role: "buyer",
    });
    return typeof p === "string" ? p : { blockNumber: p.receipt.blockNumber };
  });
  const block = await d.chain.publicClient.getBlock({ blockNumber: proven.blockNumber });
  return d.cases.transaction(() => {
    d.cases.recordEvent(row.caseId, "fund", "observed_on_chain", proven.hash, null);
    return moved(d, row, "funded", {
      fundTxHash: proven.hash,
      fundedBlockTime: Number(block.timestamp),
    });
  });
}

/** Event statuses whose hash names a transaction that may be on chain; a revert is not one. */
const SENT_STATUSES: ReadonlySet<string> = new Set(["mined", "unconfirmed"]);

/**
 * The first transaction proven to be this case's `step`: the hash given on the resume when there
 * is one (refused outright when it does not prove), else the case's sent hashes for the step,
 * newest first. A refusal names the case and how to give the hash.
 */
async function provenSent(
  d: PilotJobDeps,
  row: PilotCaseRecord,
  step: "fund" | "submit",
  given: Hex | undefined,
  prove: (hash: Hex) => Promise<{ blockNumber: bigint } | string>,
): Promise<{ hash: Hex; blockNumber: bigint }> {
  const refuse = (what: string) =>
    new Error(`refusing to adopt the ${step} of pilot case ${row.caseId}: ${what}`);
  if (given !== undefined) {
    const proof = await prove(given);
    if (typeof proof === "string") throw refuse(`${given} ${proof}`);
    return { hash: given, blockNumber: proof.blockNumber };
  }
  const hint = `if you know its hash, run the same command with --resume ${row.caseId} --${step}-tx <hash> --yes`;
  const sent = d.cases
    .events(row.caseId)
    .filter((e) => e.step === step && e.ref !== null && SENT_STATUSES.has(e.status))
    .map((e) => e.ref as Hex);
  const newestFirst = [...new Set(sent.reverse())];
  if (newestFirst.length === 0)
    throw refuse(
      `job ${row.jobId} is ${step === "fund" ? "Funded" : "Submitted"} on chain but this case recorded no ${step} transaction; ${hint}`,
    );
  const misses: string[] = [];
  for (const hash of newestFirst) {
    const proof = await prove(hash);
    if (typeof proof !== "string") return { hash, blockNumber: proof.blockNumber };
    misses.push(`${hash} ${proof}`);
  }
  throw refuse(`${misses.join("; ")}; ${hint}`);
}

/**
 * The row says funded and the chain says Submitted: a submit this process sent landed after the
 * run stopped (unconfirmed in time, or mined and the block read after it failed). It is adopted
 * once a transaction is proven to be the seller's `submit` of this job with the hash of the bytes
 * given now and a successful receipt. A `JobSubmitted` log, when the contract emits one, must
 * agree on the deliverable and the provider; its absence is not a refusal, since a contract may
 * emit another shape (the local mock does). The hash and block time come from the receipt.
 */
async function adoptSubmit(
  d: PilotJobDeps,
  input: CreatePilotJobInput,
  row: PilotCaseRecord,
  jobId: bigint,
): Promise<PilotCaseRecord> {
  const { chain, cases } = d;
  const { bytes, extension } = input.deliverable;
  const deliverableHash = keccak256(bytes);
  const proven = await provenSent(d, row, "submit", input.givenTx?.submit, (hash) =>
    submitProofOf(d, row, jobId, hash, deliverableHash),
  );
  const block = await chain.publicClient.getBlock({ blockNumber: proven.blockNumber });
  const stored = d.docStore.putBytes(
    `pilot-${row.caseId}-deliverable.${extension}`,
    Buffer.from(bytes),
  );
  return cases.transaction(() => {
    cases.recordEvent(row.caseId, "submit", "observed_on_chain", proven.hash, null);
    return moved(d, row, "submitted", {
      deliverablePath: stored.id,
      deliverableHash,
      deliverableExtension: extension,
      submitTxHash: proven.hash,
      submittedBlockTime: Number(block.timestamp),
    });
  });
}

/**
 * Whether one sent transaction is the `fn` call of this job by `sender`: the decoded arguments
 * and the receipt when it is, or what did not match (recipient, sender, call, job id or receipt).
 * Hashes and addresses only; never the calldata.
 */
async function callProofOf(
  d: PilotJobDeps,
  hash: Hex,
  want: {
    fn: "fund" | "submit";
    verb: string;
    jobId: bigint;
    sender: string;
    role: "buyer" | "seller";
  },
): Promise<
  | {
      args: readonly unknown[];
      receipt: Awaited<ReturnType<PilotChain["publicClient"]["getTransactionReceipt"]>>;
    }
  | string
> {
  const { chain } = d;
  let tx: Awaited<ReturnType<typeof chain.publicClient.getTransaction>>;
  try {
    tx = await chain.publicClient.getTransaction({ hash });
  } catch {
    return "could not be read from the node yet; resume again once it is mined";
  }
  if (tx.to === null || tx.to === undefined || !sameAddress(tx.to, chain.jobContract))
    return `has recipient ${tx.to ?? "none"}, not the job contract ${chain.jobContract}`;
  if (!sameAddress(tx.from, want.sender))
    return `has sender ${tx.from}, not the ${want.role} ${want.sender}`;
  let call: ReturnType<typeof decodeFunctionData<typeof iErc8183JobAbi>>;
  try {
    call = decodeFunctionData({ abi: iErc8183JobAbi, data: tx.input });
  } catch {
    return `is not a call of the job contract's ${want.fn}`;
  }
  if (call.functionName !== want.fn) return `calls ${call.functionName}, not ${want.fn}`;
  const calledJob = (call.args as readonly unknown[])[0];
  if (calledJob !== want.jobId) return `${want.verb} job ${calledJob}, not job ${want.jobId}`;
  let receipt: Awaited<ReturnType<typeof chain.publicClient.getTransactionReceipt>>;
  try {
    receipt = await chain.publicClient.getTransactionReceipt({ hash });
  } catch {
    return "has a receipt that could not be read yet; resume again once it is mined";
  }
  if (receipt.status !== "success") return "has a receipt that says it reverted on chain";
  return { args: call.args as readonly unknown[], receipt };
}

/**
 * Whether one sent transaction is this case's submit: the shared call proof, then the
 * deliverable hash in the calldata and, when the contract emits one, the `JobSubmitted` log.
 */
async function submitProofOf(
  d: PilotJobDeps,
  row: PilotCaseRecord,
  jobId: bigint,
  hash: Hex,
  deliverableHash: Hex,
): Promise<{ blockNumber: bigint } | string> {
  const { chain } = d;
  const proof = await callProofOf(d, hash, {
    fn: "submit",
    verb: "submits",
    jobId,
    sender: row.sellerAddress,
    role: "seller",
  });
  if (typeof proof === "string") return proof;
  const { args, receipt } = proof;
  const calledDeliverable = args[1] as Hex;
  if (calledDeliverable.toLowerCase() !== deliverableHash.toLowerCase())
    return `submits deliverable hash ${calledDeliverable}, and the deliverable given hashes to ${deliverableHash}`;
  let logged: Hex | undefined;
  try {
    logged = submittedDeliverableOf(receipt.logs, chain.jobContract, jobId);
  } catch {
    return `has JobSubmitted logs for job ${jobId} that disagree on the deliverable hash`;
  }
  if (logged !== undefined && logged.toLowerCase() !== deliverableHash.toLowerCase())
    return `has a JobSubmitted log for job ${jobId} with deliverable hash ${logged}, and the deliverable given hashes to ${deliverableHash}`;
  const otherProvider = parseEventLogs({ abi: jobSubmittedEventAbi, logs: receipt.logs }).find(
    (l) =>
      sameAddress(l.address, chain.jobContract) &&
      l.args.jobId === jobId &&
      !sameAddress(l.args.provider, row.sellerAddress),
  );
  if (otherProvider)
    return `has a JobSubmitted log for job ${jobId} naming provider ${otherProvider.args.provider}, not the seller ${row.sellerAddress}`;
  return { blockNumber: receipt.blockNumber };
}

async function submitDeliverable(
  d: PilotJobDeps,
  input: CreatePilotJobInput,
  row: PilotCaseRecord,
  jobId: bigint,
): Promise<PilotCaseRecord> {
  const { chain, cases } = d;
  const { bytes, extension } = input.deliverable;
  const deliverableHash = keccak256(bytes);
  const stored = d.docStore.putBytes(
    `pilot-${row.caseId}-deliverable.${extension}`,
    Buffer.from(bytes),
  );
  const submitHash = await recorded(d, row.caseId, "submit", () =>
    chain.job.submit(jobId, deliverableHash, chain.wallets.seller),
  );
  cases.recordEvent(row.caseId, "submit", "mined", submitHash, null);
  const submittedBlockTime = await blockTimeOf(chain, submitHash);
  return moved(d, row, "submitted", {
    deliverablePath: stored.id,
    deliverableHash,
    deliverableExtension: extension,
    submitTxHash: submitHash,
    submittedBlockTime,
  });
}

/** Advance the row from its status to `to` (compare-and-set), or refuse if it moved meanwhile. */
function moved(
  d: PilotJobDeps,
  row: PilotCaseRecord,
  to: "funded" | "submitted",
  patch: Partial<PilotCaseRecord>,
): PilotCaseRecord {
  const next = d.cases.advance(row.caseId, row.status, to, patch);
  if (!next)
    throw new Error(
      `pilot case ${row.caseId} moved from ${row.status} while this step ran; its status was not changed`,
    );
  return next;
}

/**
 * Run one chain step. A failure is written as an event before it is rethrown: with its hash and
 * `reverted` or `unconfirmed` when a transaction was sent, `failed` with no hash otherwise. The
 * detail goes through `publicErrorMessage`, because the case view serves this trail.
 */
async function recorded(
  d: PilotJobDeps,
  caseId: string,
  step: string,
  send: () => Promise<Hex>,
): Promise<Hex> {
  try {
    return await send();
  } catch (e) {
    const detail = withoutEmDash(publicErrorMessage(e));
    if (e instanceof ChainTxRevertedError || e instanceof JobFundRevertedError)
      d.cases.recordEvent(caseId, stepOf(e, step), "reverted", e.txHash, detail);
    else if (e instanceof ChainTxUnconfirmedError || e instanceof JobFundUnconfirmedError)
      d.cases.recordEvent(caseId, stepOf(e, step), "unconfirmed", e.txHash, detail);
    else d.cases.recordEvent(caseId, step, "failed", null, detail);
    throw e;
  }
}

/**
 * The text of an existing error class, made fit to persist or print: each em dash it carries
 * becomes a colon, and nothing else changes.
 */
export const withoutEmDash = (text: string): string => text.replace(/\s*\u2014\s*/g, ": ");

/** The escrow funding names its own sub-step (`approve` or `fund`); the others are the step. */
const stepOf = (e: Error, step: string): string =>
  e instanceof JobFundRevertedError || e instanceof JobFundUnconfirmedError ? e.step : step;

/** The block time of a mined transaction, in Unix seconds. */
async function blockTimeOf(chain: PilotChain, hash: Hex): Promise<number> {
  const receipt = await chain.publicClient.getTransactionReceipt({ hash });
  const block = await chain.publicClient.getBlock({ blockNumber: receipt.blockNumber });
  return Number(block.timestamp);
}
