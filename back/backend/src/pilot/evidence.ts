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
 * checked. Nothing else of an answer is read, and no natural person is named: the record names a
 * test entity and says whether a verified person controls it.
 *
 * Two kinds of refusal. An EvidenceError carries a code and names a field or a side, never a
 * value. A plain Error marks an input the record cannot be rendered from: a row that is not
 * contested yet, or facts the approved words have no sentence for (a job funded on another day
 * than it was created, a contest on another day than the delivery, two snapshots taken on
 * different days, a file with mixed or no line endings). Refusing keeps every filed word an
 * approved one.
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
 * is not the submitted one, a file that is not UTF-8 text of a known extension, a record that is
 * not `active` (unless `allowStanding` names its standing, which is then printed as it is; an
 * answer with no statement is refused whatever is allowed) and a name or description over its
 * cap. Throws a plain Error on the inputs the module comment lists.
 */
export function renderEvidence(i: EvidenceInput, opts?: { allowStanding?: string }): Evidence {
  // No mainnet notice is written: the TEST DATA notice would be false there.
  if (i.arcNetwork !== "testnet") throw new EvidenceError("mainnet_notice_missing");
  const { row, chain } = i;

  const jobId = required(row, "jobId");
  const createTxHash = required(row, "createTxHash");
  const fundTxHash = required(row, "fundTxHash");
  const submitTxHash = required(row, "submitTxHash");
  const created = formatUtcDate(required(row, "createdBlockTime"));
  const funded = formatUtcDate(required(row, "fundedBlockTime"));
  const submitted = formatUtcDate(required(row, "submittedBlockTime"));
  const contested = formatUtcDate(required(row, "contestedAt"));
  const reason = required(row, "contestReason");
  const reply = required(row, "contestReply");
  const expires = formatUtcDate(row.expiredAt);
  if (!CANONICAL_DECIMAL.test(row.budgetAtomic))
    throw new Error("evidence: row.budgetAtomic is not a decimal");
  const price = formatUsdc(BigInt(row.budgetAtomic));
  // Section 1 says the job was created and paid on one day, and contested the day it was delivered.
  if (funded !== created)
    throw new Error("evidence: the job was funded on another day than it was created");
  if (contested !== submitted)
    throw new Error("evidence: the job was contested on another day than it was delivered");

  const file = deliveredFile(i.deliverable, chain.submittedDeliverable);
  const buyer = recordFacts(i.records.buyer, "buyer", opts?.allowStanding);
  const seller = recordFacts(i.records.seller, "seller", opts?.allowStanding);
  // Section 6 dates the two records with one snapshot day.
  if (buyer.snapshotDay !== seller.snapshotDay)
    throw new Error("evidence: the two records were checked on different days");

  const lookupBase = withoutTrailingSlash(i.lookupBase);
  const explorerBase = withoutTrailingSlash(chain.explorerBase);
  const network = chain.networkLabel;

  const description = `${[
    NOTICE,
    "",
    `**1. The job in short.** The client agent created a job on ${network} on ${created} and paid the price, ${price} USDC (testnet), into the job's escrow. The provider agent submitted its delivery on ${submitted}. The client agent contested it the same day. The job expires on ${expires}. The job's referee (its "evaluator") is run by Novi Corpus.`,
    "",
    "**2. What the client asked for, word for word as written on chain:**",
    `"${chain.descriptionOnChain}"`,
    "",
    SECTION_3,
    "",
    `\`\`\`\n${file.text}${file.text.endsWith("\n") ? "" : "\n"}\`\`\``,
    "",
    `**4. The client's reason for contesting (${contested}):** "${reason}"`,
    "",
    `**5. The provider's reply (${contested}):** "${reply}"`,
    "",
    `**6. Who answers for each agent** (Novi Corpus records, snapshot taken when the case was created, ${buyer.snapshotDay}):`,
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
    `- Fingerprint of the delivered file recorded at submission: keccak256 ${file.keccak} (the ${file.kind} above as a UTF-8 file with ${file.lineEndings}, ${file.byteLength} bytes).`,
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
  if (v === null || v === undefined)
    throw new Error(`evidence: row.${field} is not set; the case is not contested yet`);
  return v as NonNullable<PilotCaseRecord[K]>;
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
  if (text.includes("```"))
    throw new Error("evidence: the delivered file holds a code fence, which would end its block");
  return {
    text,
    keccak,
    kind: d.extension.toUpperCase(),
    lineEndings: lineEndingNote(text),
    byteLength: d.bytes.length,
  };
}

/** "LF line endings and one trailing newline", read from the text. Only the four cases the record
 *  has words for: LF or CRLF throughout, ending in one line end or in none. */
function lineEndingNote(text: string): string {
  const lf = occurrences(text, "\n");
  const crlf = occurrences(text, "\r\n");
  if (lf === 0) throw new Error("evidence: the delivered file has no line ending");
  if (occurrences(text, "\r") !== crlf || (crlf !== 0 && crlf !== lf))
    throw new Error("evidence: the delivered file mixes line endings");
  const eol = crlf === 0 ? "\n" : "\r\n";
  if (text.endsWith(eol + eol))
    throw new Error("evidence: the delivered file ends in more than one line end");
  const trailing = text.endsWith(eol) ? "one trailing newline" : "no trailing newline";
  return `${crlf === 0 ? "LF" : "CRLF"} line endings and ${trailing}`;
}

function occurrences(s: string, sub: string): number {
  return s.split(sub).length - 1;
}

/** One side's line of section 6 and the day its answer was checked. Reads the five fields and no
 *  other: the legal name, the standing, the two control flags and `checkedAt`. */
function recordFacts(
  a: ByAgentAnswer,
  side: "buyer" | "seller",
  allowStanding: string | undefined,
): { text: string; snapshotDay: string } {
  // Without a statement there is no name to print, whatever standing the operator accepts.
  if (!a.legalBody || a.statement === null) throw new EvidenceError("record_not_active", side);
  const m = a.statement.message;
  if (m.standing !== "active" && m.standing !== allowStanding)
    throw new EvidenceError("record_not_active", side);
  if (m.legalName === "") throw new Error(`evidence: the ${side} record shows no legal name`);
  if (!ISO_INSTANT.test(a.checkedAt))
    throw new Error(`evidence: the ${side} record's checkedAt is not an ISO instant`);
  const control =
    m.guardianHumanVerified && m.controlVerified ? VERIFIED_CONTROL : UNVERIFIED_CONTROL;
  return {
    text: `"${m.legalName}" (test entity), a Wyoming DAO LLC, standing ${m.standing}, ${control}.`,
    snapshotDay: formatUtcDate(Math.floor(Date.parse(a.checkedAt) / 1000)),
  };
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
