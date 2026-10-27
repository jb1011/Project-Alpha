import { type Address, type Hex, keccak256, sha256 } from "viem";
import type { ByAgentAnswer } from "../api/routes/legalBodyStatements";
import type { PilotCaseRecord } from "./types";

/**
 * THE EVIDENCE A JUROR READS: the one record our referee files on a pilot case, rendered in the
 * approved words, section by section, from the real job and the two public lookup answers.
 *
 * What goes in: the job's own facts (the block times of its creation, funding and submission, the
 * contest's time, its expiry, its id, the parties' addresses and agent ids, the transaction
 * hashes, the description re-read from the chain and the delivered bytes) and five fields of each
 * lookup answer: the legal name, the standing, the two control flags and when the answer was
 * checked. Two more are read to refuse, never printed: the answer's agent id (it must be the row's
 * for that side) and the statement's environment (it must be the sandbox). Nothing else of an
 * answer is read, and no natural person is named: the record names a test entity and says whether
 * a verified person controls it.
 *
 * Dates are UTC days. A job funded on a later day than it was created, a contest on a later day
 * than the delivery, and two records checked on different days each name the other day in the
 * approved sentence's smallest variant; on one day, the sentence is the approved one unchanged.
 *
 * Two kinds of refusal, both naming fields or a side and never a value. An EvidenceError carries
 * one of the codes below. A plain Error marks an input that would make the record say something
 * false, or that it cannot be rendered from at all:
 *  - a row on another chain or job contract than the configured one;
 *  - a column the contested row must have that is not set;
 *  - times out of order (created, funded, delivered and contested in that order, then expiry);
 *  - a budget that is not a decimal, or that is finer than a cent;
 *  - a code fence in the on-chain description, the reason or the reply (in a Markdown view it
 *    would swallow the sections after it);
 *  - a record for another agent than the row's, of another environment than the sandbox, with no
 *    legal name, or checked at a time that is not a real ISO instant.
 *
 * Pure and deterministic: no clock, no locale, no I/O. The same input renders the same bytes.
 */

/** Kleros's caps, in UTF-8 bytes. */
export const EVIDENCE_NAME_MAX_BYTES = 1024;
export const EVIDENCE_DESCRIPTION_MAX_BYTES = 65536;

export interface EvidenceInput {
  row: PilotCaseRecord;
  chain: {
    /** The job's description as `getJob` returns it at filing time: the one the record quotes. */
    descriptionOnChain: string;
    /** The `deliverable` of the job's `Submitted` event. */
    submittedDeliverable: Hex;
    networkLabel: "Arc Testnet";
    chainId: number;
    jobContract: Address;
    explorerBase: string;
  };
  deliverable: { bytes: Uint8Array; extension: string };
  records: { buyer: ByAgentAnswer; seller: ByAgentAnswer };
  lookupBase: string;
  arcNetwork: "testnet" | "mainnet";
}

export interface Evidence {
  name: string;
  description: string;
  /** The sha256 of the description's UTF-8 bytes. */
  sha256: Hex;
  byteLength: number;
}

export type EvidenceErrorCode =
  | "mainnet_notice_missing"
  | "hash_mismatch"
  | "record_not_active"
  | "too_long"
  | "binary_deliverable_unsupported";

/** The record was refused. The message names the code and, at most, a field or a side. */
export class EvidenceError extends Error {
  constructor(
    readonly code: EvidenceErrorCode,
    where?: string,
  ) {
    super(
      where === undefined ? `evidence refused: ${code}` : `evidence refused: ${code} (${where})`,
    );
    this.name = "EvidenceError";
  }
}

/** The deliverables printed word for word. Any other extension is refused: the record has no
 *  words for a binary file. */
const TEXT_EXTENSIONS: readonly string[] = ["csv", "txt", "json", "md"];

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** An answer's `checkedAt`, as `Date.prototype.toISOString` writes it. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CANONICAL_DECIMAL = /^(0|[1-9]\d*)$/;
/** USDC has 6 decimals; the record prints 2. */
const ATOMIC_PER_CENT = 10_000n;

const NOTICE =
  "**TEST DATA.** This case is part of the Kleros x Novi Corpus pilot. The job runs on Arc Testnet with testnet USDC, which has no value. The companies named below are test entities, not real filings. Both agents are test agents operated by Novi Corpus, which also operates the referee that filed this record: a controlled test. Please decide it as a case between unrelated parties.";
const SECTION_3 =
  "**3. What the provider delivered, word for word.** This is the delivered file. Its fingerprint (keccak256 hash), recorded on chain when the provider submitted it, matches this exact content (see section 8).";
const SECTION_6_CLOSE =
  "These records say who answers for each agent. They say nothing about the quality of the work (dispute policy, section 2).";
const SECTION_7 =
  '**7. The question.** Did the provider agent deliver what the ERC-8183 job on Arc describes? Answer 1, "Pay the provider", or Answer 2, "Refund the client". The dispute policy linked to this case says how to decide.';
const VERIFIED_CONTROL = "controlled by a person verified as a unique human (World ID)";
const UNVERIFIED_CONTROL = "control not verified on this record";

/** The day in UTC as "D Month YYYY", with English month names and no locale API. */
export function formatUtcDate(unixSeconds: number): string {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0)
    throw new Error("formatUtcDate: not a whole, non-negative number of seconds");
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "2.00": atomic units of 6 decimals, printed with exactly 2. Never rounds: an amount with more
 *  precision than a cent, or a negative one, throws. */
export function formatUsdc(atomic: bigint): string {
  if (atomic < 0n) throw new Error("formatUsdc: a negative amount");
  if (atomic % ATOMIC_PER_CENT !== 0n) throw new Error("formatUsdc: finer than a cent");
  const cents = atomic / ATOMIC_PER_CENT;
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/**
 * Renders the record. Throws an EvidenceError on a mainnet case, a delivered file whose keccak256
 * is not the submitted one, a file that is not UTF-8 text of a known extension or that the record
 * cannot print faithfully (mixed line endings, a code fence), a record that is
 * not `active` (unless `allowStanding` names its standing, which is then printed as it is; an
 * answer with no statement is refused whatever is allowed) and a name or description over its
 * cap. Throws a plain Error on the inputs the module comment lists.
 */
export function renderEvidence(i: EvidenceInput, opts?: { allowStanding?: string }): Evidence {
  // No mainnet notice is written: the TEST DATA notice would be false there.
  if (i.arcNetwork !== "testnet") throw new EvidenceError("mainnet_notice_missing");
  const { row, chain } = i;
  // Section 8 names the configured chain and contract: they must be the job's own.
  if (row.chainId !== chain.chainId)
    throw new Error("evidence: row.chainId is not the configured chain id");
  if (row.jobContract.toLowerCase() !== chain.jobContract.toLowerCase())
    throw new Error("evidence: row.jobContract is not the configured job contract");

  const jobId = required(row, "jobId");
  const createTxHash = required(row, "createTxHash");
  const fundTxHash = required(row, "fundTxHash");
  const submitTxHash = required(row, "submitTxHash");
  const createdAt = required(row, "createdBlockTime");
  const fundedAt = required(row, "fundedBlockTime");
  const submittedAt = required(row, "submittedBlockTime");
  const contestedAt = required(row, "contestedAt");
  // Section 1 tells the job in order; a row out of order would tell it falsely.
  notBefore("fundedBlockTime", fundedAt, "createdBlockTime", createdAt);
  notBefore("submittedBlockTime", submittedAt, "fundedBlockTime", fundedAt);
  notBefore("contestedAt", contestedAt, "submittedBlockTime", submittedAt);
  if (row.expiredAt <= contestedAt)
    throw new Error("evidence: row.expiredAt is not after row.contestedAt");
  const created = formatUtcDate(createdAt);
  const funded = formatUtcDate(fundedAt);
  const submitted = formatUtcDate(submittedAt);
  const contested = formatUtcDate(contestedAt);
  const expires = formatUtcDate(row.expiredAt);
  const reason = freeText("row.contestReason", required(row, "contestReason"));
  const reply = freeText("row.contestReply", required(row, "contestReply"));
  const asked = freeText("chain.descriptionOnChain", chain.descriptionOnChain);
  if (!CANONICAL_DECIMAL.test(row.budgetAtomic))
    throw new Error("evidence: row.budgetAtomic is not a decimal");
  const budget = BigInt(row.budgetAtomic);
  if (budget % ATOMIC_PER_CENT !== 0n)
    throw new Error("evidence: row.budgetAtomic is finer than a cent");
  const price = formatUsdc(budget);
  // Section 1's approved sentence pays on the creation day and contests on the delivery day; any
  // other day is named where it happened.
  const escrow =
    funded === created ? "into the job's escrow" : `into the job's escrow on ${funded}`;
  const contestDay = contested === submitted ? "the same day" : `on ${contested}`;

  const file = deliveredFile(i.deliverable, chain.submittedDeliverable);
  const buyer = recordFacts(i.records.buyer, "buyer", row.buyerAgentId, opts?.allowStanding);
  const seller = recordFacts(i.records.seller, "seller", row.sellerAgentId, opts?.allowStanding);
  // Section 6 names one snapshot day, or the client's and then the provider's.
  const snapshots =
    buyer.snapshotDay === seller.snapshotDay
      ? `snapshot taken when the case was created, ${buyer.snapshotDay}`
      : `snapshots taken when the case was created, ${buyer.snapshotDay} and ${seller.snapshotDay}`;

  const lookupBase = withoutTrailingSlash(i.lookupBase);
  const explorerBase = withoutTrailingSlash(chain.explorerBase);
  const network = chain.networkLabel;

  const description = `${[
    NOTICE,
    "",
    `**1. The job in short.** The client agent created a job on ${network} on ${created} and paid the price, ${price} USDC (testnet), ${escrow}. The provider agent submitted its delivery on ${submitted}. The client agent contested it ${contestDay}. The job expires on ${expires}. The job's referee (its "evaluator") is run by Novi Corpus.`,
    "",
    "**2. What the client asked for, word for word as written on chain:**",
    `"${asked}"`,
    "",
    SECTION_3,
    "",
    `\`\`\`\n${file.text}${file.text.endsWith("\n") ? "" : "\n"}\`\`\``,
    "",
    `**4. The client's reason for contesting (${contested}):** "${reason}"`,
    "",
    `**5. The provider's reply (${contested}):** "${reply}"`,
    "",
    `**6. Who answers for each agent** (Novi Corpus records, ${snapshots}):`,
    `- Client agent: ${buyer.text}`,
    `- Provider agent: ${seller.text}`,
    "",
    SECTION_6_CLOSE,
    "",
    SECTION_7,
    "",
    "**8. On-chain references** (for anyone who wants to check):",
    `- Network: ${network}, chain id ${chain.chainId}. Job contract (ERC-8183): ${chain.jobContract}. Job id: ${jobId}.`,
    `- Client agent: ${row.buyerAddress}, ERC-8004 agent id ${row.buyerAgentId}, public record ${lookupBase}/legal-bodies/by-agent/${row.buyerAgentId}`,
    `- Provider agent: ${row.sellerAddress}, ERC-8004 agent id ${row.sellerAgentId}, public record ${lookupBase}/legal-bodies/by-agent/${row.sellerAgentId}`,
    `- Referee (evaluator): ${row.refereeAddress}.`,
    `- Transactions: job creation ${createTxHash}, funding ${fundTxHash}, submission ${submitTxHash} (explorer: ${explorerBase}).`,
    `- Fingerprint of the delivered file recorded at submission: keccak256 ${file.keccak} (the ${file.kind} above as a UTF-8 file with ${file.lineEndings}, ${byteCount(file.byteLength)}).`,
  ].join("\n")}\n`;

  const name = `Job ${row.label}: the complete record (test data)`;
  const encoder = new TextEncoder();
  if (encoder.encode(name).length > EVIDENCE_NAME_MAX_BYTES)
    throw new EvidenceError("too_long", "name");
  const bytes = encoder.encode(description);
  if (bytes.length > EVIDENCE_DESCRIPTION_MAX_BYTES)
    throw new EvidenceError("too_long", "description");
  return { name, description, sha256: sha256(bytes), byteLength: bytes.length };
}

/** A column the contested row must have set. */
function required<K extends keyof PilotCaseRecord>(
  row: PilotCaseRecord,
  field: K,
): NonNullable<PilotCaseRecord[K]> {
  const v = row[field];
  if (v === null || v === undefined) throw new Error(`evidence: row.${field} is not set`);
  return v as NonNullable<PilotCaseRecord[K]>;
}

/** Refuses a later event recorded before an earlier one, naming the two columns. */
function notBefore(later: string, laterAt: number, earlier: string, earlierAt: number): void {
  if (laterAt < earlierAt) throw new Error(`evidence: row.${later} is before row.${earlier}`);
}

/** A text the record quotes as it is. A code fence in it would open a block in a Markdown view
 *  and swallow the sections after it. */
function freeText(field: string, text: string): string {
  if (text.includes("```")) throw new Error(`evidence: ${field} holds a code fence`);
  return text;
}

/** "241 bytes", "1 byte". */
function byteCount(n: number): string {
  return n === 1 ? "1 byte" : `${n} bytes`;
}

/** The delivered file as the record prints it: checked against the submitted fingerprint first,
 *  then read as UTF-8 text of a known extension. */
function deliveredFile(
  d: EvidenceInput["deliverable"],
  submitted: Hex,
): { text: string; keccak: Hex; kind: string; lineEndings: string; byteLength: number } {
  const keccak = keccak256(d.bytes);
  if (keccak !== submitted.toLowerCase()) throw new EvidenceError("hash_mismatch");
  if (!TEXT_EXTENSIONS.includes(d.extension))
    throw new EvidenceError("binary_deliverable_unsupported", "extension");
  let text: string;
  try {
    // ignoreBOM keeps a byte order mark in the text: the block prints every byte.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(d.bytes);
  } catch {
    throw new EvidenceError("binary_deliverable_unsupported", "bytes");
  }
  // A file the record cannot print faithfully is refused like an unprintable one, with the same
  // code: a code fence would end the block early, and some line endings (see lineEndingNote)
  // have no true note. The deliverable is the operator's own file, to be fixed before filing.
  if (text.includes("```")) throw new EvidenceError("binary_deliverable_unsupported", "code fence");
  return {
    text,
    keccak,
    kind: d.extension.toUpperCase(),
    lineEndings: lineEndingNote(text),
    byteLength: d.bytes.length,
  };
}

/** "LF line endings and one trailing newline", read from the text: "CRLF" when its line ends are
 *  CRLF, else "LF"; "one trailing newline" when it ends in one line end, else "no trailing
 *  newline". Refused, because the note would be false: mixed line endings (LF beside CRLF, or a
 *  CR on its own), no line end at all, and more than one line end at the end (a blank last line). */
function lineEndingNote(text: string): string {
  const lf = occurrences(text, "\n");
  const crlf = occurrences(text, "\r\n");
  if (occurrences(text, "\r") !== crlf || (crlf !== 0 && crlf !== lf))
    throw new EvidenceError("binary_deliverable_unsupported", "line endings");
  if (lf === 0) throw new EvidenceError("binary_deliverable_unsupported", "no line ending");
  const eol = crlf === 0 ? "\n" : "\r\n";
  if (text.endsWith(eol + eol))
    throw new EvidenceError("binary_deliverable_unsupported", "blank last line");
  const trailing = text.endsWith(eol) ? "one trailing newline" : "no trailing newline";
  return `${crlf === 0 ? "LF" : "CRLF"} line endings and ${trailing}`;
}

function occurrences(s: string, sub: string): number {
  return s.split(sub).length - 1;
}

/** One side's line of section 6 and the day its answer was checked. Prints five fields and no
 *  other: the legal name, the standing, the two control flags and `checkedAt`. Reads two more to
 *  refuse: the answer's agent id, which must be the row's for that side, and the statement's
 *  environment, which must be the sandbox. */
function recordFacts(
  a: ByAgentAnswer,
  side: "buyer" | "seller",
  rowAgentId: string,
  allowStanding: string | undefined,
): { text: string; snapshotDay: string } {
  // First: a record for another agent says nothing about this side, whatever its standing.
  if (a.agentId !== rowAgentId)
    throw new Error(`evidence: the ${side} record's agentId is not the row's ${side}AgentId`);
  // Without a statement there is no name to print, whatever standing the operator accepts.
  if (!a.legalBody || a.statement === null) throw new EvidenceError("record_not_active", side);
  const m = a.statement.message;
  if (m.standing !== "active" && m.standing !== allowStanding)
    throw new EvidenceError("record_not_active", side);
  // The notice calls the companies test entities: only a sandbox record is one.
  if (m.environment !== "sandbox")
    throw new Error(`evidence: the ${side} record's environment is not the sandbox`);
  if (m.legalName === "") throw new Error(`evidence: the ${side} record shows no legal name`);
  return {
    text: `"${m.legalName}" (test entity), a Wyoming DAO LLC, standing ${m.standing}, ${control(m)}.`,
    snapshotDay: formatUtcDate(checkedAtSeconds(a.checkedAt, side)),
  };
}

function control(m: { guardianHumanVerified: boolean; controlVerified: boolean }): string {
  return m.guardianHumanVerified && m.controlVerified ? VERIFIED_CONTROL : UNVERIFIED_CONTROL;
}

/** An answer's `checkedAt` in unix seconds. Refused unless it is a real instant written as
 *  `toISOString` writes it: `Date.parse` rolls "02-30" over to March and "T24:00" to the next
 *  day, so the parsed time is written back and must give the same date and time. */
function checkedAtSeconds(iso: string, side: "buyer" | "seller"): number {
  const ms = ISO_INSTANT.test(iso) ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== iso.slice(0, 19))
    throw new Error(`evidence: the ${side} record's checkedAt is not a real ISO instant`);
  return Math.floor(ms / 1000);
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
