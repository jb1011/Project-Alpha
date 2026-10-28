import { Buffer } from "node:buffer";
import { type Hex, keccak256, parseEventLogs } from "viem";
import { iIdentityRegistryAbi } from "../abis/generated";
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
/** The job contract's status numbers. */
const OPEN = 0;
const FUNDED = 1;
const SUBMITTED = 2;

/**
 * The job contract's `Submitted` event, as the mock contract and the backend's earlier plans
 * declare it: the backend's interface ABI carries no events. A log of another shape is simply not
 * found, and the case refuses rather than guessing.
 */
const submittedEventAbi = [
  {
    type: "event",
    name: "Submitted",
    inputs: [
      { name: "jobId", type: "uint256", indexed: true },
      { name: "deliverable", type: "bytes32", indexed: false },
    ],
  },
] as const;

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
  o: { balance: boolean },
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
  const expiryProblem = expiryProblemOf(input.mode, input.expirySeconds);
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
    } catch {
      return refuse(`the ${role}'s agent ${agentId} has no owner in the identity registry`);
    }
    if (owner.toLowerCase() !== expected.toLowerCase())
      return refuse(
        `the ${role}'s agent ${agentId} is owned by ${owner}, not by the ${role}'s address ${expected}`,
      );
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

function expiryProblemOf(mode: PilotMode, seconds: number): string | undefined {
  if (!Number.isSafeInteger(seconds)) return "the expiry must be a whole number of seconds";
  if (mode === "rehearsal")
    return seconds >= MIN_REHEARSAL_EXPIRY_SECONDS
      ? undefined
      : `the expiry must be at least ${MIN_REHEARSAL_EXPIRY_SECONDS} seconds in rehearsal (got ${seconds})`;
  return seconds >= MIN_EXPIRY_SECONDS && seconds <= MAX_EXPIRY_SECONDS
    ? undefined
    : `the expiry must be between ${MIN_EXPIRY_SECONDS} and ${MAX_EXPIRY_SECONDS} seconds in ${mode} mode (got ${seconds})`;
}

/** Pre-flight, then create, budget and fund, submit; resumable from created and funded. */
export async function createPilotJob(
  d: PilotJobDeps,
  input: CreatePilotJobInput,
  resumeCaseId?: string,
): Promise<PilotCaseRecord> {
  if (resumeCaseId !== undefined) return resume(d, input, resumable(d, input, resumeCaseId));

  const pre = await preflightPilotJob(d, input);
  if (!pre.ok) throw new Error(`refusing to create the pilot job: ${pre.problem}`);

  const { chain } = d;
  const caseId = newCaseId();
  const expiredAt = (d.now ?? unixNow)() + input.expirySeconds;
  // No row exists before the job does: a failed createJob leaves nothing to resume, and its
  // error carries the hash when one was sent.
  const { jobId, txHash } = await chain.job.createJob({
    provider: chain.addresses.seller,
    evaluator: chain.addresses.referee,
    expiredAt: BigInt(expiredAt),
    description: input.description,
  });
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
  const row = d.cases.patch(caseId, { createdBlockTime: await blockTimeOf(chain, txHash) });
  return continueCase(d, input, row);
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
  row: PilotCaseRecord,
): Promise<PilotCaseRecord> {
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
      { balance: onChain === OPEN },
    );
    if (!pre.ok) throw new Error(`refusing to resume pilot case ${row.caseId}: ${pre.problem}`);
  }
  return continueCase(d, input, row);
}

/**
 * The job's status on chain, once the job is shown to be this case's: its client is the buyer
 * and its evaluator the referee, and once funded its budget is the row's. A job id taken from a
 * simulate can name another job, and adopting that job would make the row lie.
 */
async function chainStatusOf(d: PilotJobDeps, row: PilotCaseRecord): Promise<number> {
  const jobId = BigInt(row.jobId as string);
  const s = await d.chain.job.escrowState(jobId);
  const refuse = (what: string) =>
    new Error(`refusing to continue pilot case ${row.caseId}: job ${jobId} ${what}`);
  if (!sameAddress(s.client, row.buyerAddress))
    throw refuse(`has client ${s.client}, not the buyer ${row.buyerAddress}`);
  if (!sameAddress(s.evaluator, row.refereeAddress))
    throw refuse(`has evaluator ${s.evaluator}, not the referee ${row.refereeAddress}`);
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
    if (row.status === "created" && onChain === OPEN) row = await budgetAndFund(d, row, jobId);
    else if (row.status === "created" && onChain === FUNDED) row = adoptFund(d, row);
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
 * run stopped (unconfirmed in time, or mined and the run died before the row moved). The row
 * takes the hash of the last fund event; the block time stays unknown.
 */
function adoptFund(d: PilotJobDeps, row: PilotCaseRecord): PilotCaseRecord {
  const sent =
    d.cases
      .events(row.caseId)
      .filter((e) => e.step === "fund" && e.ref !== null && SENT_STATUSES.has(e.status))
      .at(-1)?.ref ?? null;
  return d.cases.transaction(() => {
    d.cases.recordEvent(row.caseId, "fund", "observed_on_chain", sent, null);
    return moved(d, row, "funded", { fundTxHash: sent });
  });
}

/** Event statuses whose hash names a transaction that may be on chain; a revert is not one. */
const SENT_STATUSES: ReadonlySet<string> = new Set(["mined", "unconfirmed"]);

/**
 * The row says funded and the chain says Submitted: a submit this process sent landed after the
 * run stopped (unconfirmed in time, or mined and the block read after it failed). The row is
 * moved only when the last submit event's transaction mined a `Submitted` log for this job whose
 * deliverable is the hash of the bytes given now; the hash and block time come from its receipt.
 */
async function adoptSubmit(
  d: PilotJobDeps,
  input: CreatePilotJobInput,
  row: PilotCaseRecord,
  jobId: bigint,
): Promise<PilotCaseRecord> {
  const { chain, cases } = d;
  const refuse = (what: string) =>
    new Error(`refusing to adopt the submit of pilot case ${row.caseId}: ${what}`);
  const sent = cases
    .events(row.caseId)
    .filter((e) => e.step === "submit" && e.ref !== null && SENT_STATUSES.has(e.status))
    .at(-1)?.ref as Hex | undefined;
  if (!sent)
    throw refuse(`job ${jobId} is Submitted on chain but this case recorded no submit transaction`);
  let receipt: Awaited<ReturnType<typeof chain.publicClient.getTransactionReceipt>>;
  try {
    receipt = await chain.publicClient.getTransactionReceipt({ hash: sent });
  } catch {
    throw refuse(`the receipt of ${sent} could not be read yet; resume again once it is mined`);
  }
  if (receipt.status !== "success") throw refuse(`${sent} reverted on chain`);
  const log = parseEventLogs({ abi: submittedEventAbi, logs: receipt.logs }).find(
    (l) => sameAddress(l.address, chain.jobContract) && l.args.jobId === jobId,
  );
  if (!log) throw refuse(`${sent} carries no Submitted log for job ${jobId}`);
  const { bytes, extension } = input.deliverable;
  const deliverableHash = keccak256(bytes);
  if (log.args.deliverable.toLowerCase() !== deliverableHash.toLowerCase())
    throw refuse(
      `the chain holds deliverable hash ${log.args.deliverable}, and the deliverable given hashes to ${deliverableHash}`,
    );
  const block = await chain.publicClient.getBlock({ blockNumber: receipt.blockNumber });
  const stored = d.docStore.putBytes(
    `pilot-${row.caseId}-deliverable.${extension}`,
    Buffer.from(bytes),
  );
  return cases.transaction(() => {
    cases.recordEvent(row.caseId, "submit", "observed_on_chain", sent, null);
    return moved(d, row, "submitted", {
      deliverablePath: stored.path,
      deliverableHash,
      deliverableExtension: extension,
      submitTxHash: sent,
      submittedBlockTime: Number(block.timestamp),
    });
  });
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
    deliverablePath: stored.path,
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
    const detail = publicErrorMessage(e);
    if (e instanceof ChainTxRevertedError || e instanceof JobFundRevertedError)
      d.cases.recordEvent(caseId, stepOf(e, step), "reverted", e.txHash, detail);
    else if (e instanceof ChainTxUnconfirmedError || e instanceof JobFundUnconfirmedError)
      d.cases.recordEvent(caseId, stepOf(e, step), "unconfirmed", e.txHash, detail);
    else d.cases.recordEvent(caseId, step, "failed", null, detail);
    throw e;
  }
}

/** The escrow funding names its own sub-step (`approve` or `fund`); the others are the step. */
const stepOf = (e: Error, step: string): string =>
  e instanceof JobFundRevertedError || e instanceof JobFundUnconfirmedError ? e.step : step;

/** The block time of a mined transaction, in Unix seconds. */
async function blockTimeOf(chain: PilotChain, hash: Hex): Promise<number> {
  const receipt = await chain.publicClient.getTransactionReceipt({ hash });
  const block = await chain.publicClient.getBlock({ blockNumber: receipt.blockNumber });
  return Number(block.timestamp);
}
