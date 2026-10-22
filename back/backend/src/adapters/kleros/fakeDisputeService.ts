/**
 * The fake Kleros Dispute Service: a scripted twin for rehearsals and tests.
 *
 * A rehearsal runs the whole flow on Arc testnet against this fake, and its answers are written
 * to the case row exactly as a real answer would be, then the job is settled from them. So the
 * fake answers in the real client's shapes and outcome types, and refuses the arguments the
 * service refuses, with the same tool and the same leading code (Kleros docs, "One dispute, from
 * creation to a ruling"), so a rehearsal catches what a real filing would. It never reaches the
 * network: beyond types, its only import is a hash.
 */
import { createHash } from "node:crypto";
import type { Address, Hex } from "viem";
import type { KlerosReadChain } from "./deployments";
import type {
  CourtClock,
  CreateOutcome,
  DisputeRead,
  KlerosDisputeService,
  PinOutcome,
  SubmitOutcome,
} from "./disputeService";
import { KlerosRefusal } from "./errors";

export type FakeScript =
  | "pay"
  | "refund"
  | "tie"
  | "refuse"
  | "stalled"
  | "unknown-create"
  | "unknown-submit"
  | "write-in-progress-once"
  | "insufficient-balance"
  | "simulated";

export interface FakeDisputeServiceOptions {
  script: FakeScript;
  /** The first dispute id handed out (core and local alike); default 1000. */
  firstCoreId?: number;
  /** The read of a case that first answers Appeal; default 4 (Evidence, Commit, Vote before it). */
  readsUntilAppeal?: number;
  /** Merged onto the clock of the court asked for; the court id stays the one asked. */
  court?: Partial<CourtClock>;
  now?: () => number;
  /** The preset's alias slot keys; default the pilot preset's `client` and `provider`. */
  aliasSlots?: readonly string[];
}

type Period = DisputeRead["status"];

interface FakeCase {
  reads: number;
  status: Period;
  /** When the current period was entered: the filing for Evidence, else the read that saw it. */
  since: number;
}

const SCRIPTS: readonly string[] = [
  "pay",
  "refund",
  "tie",
  "refuse",
  "stalled",
  "unknown-create",
  "unknown-submit",
  "write-in-progress-once",
  "insufficient-balance",
  "simulated",
];
const TOOLS: readonly string[] = [
  "dispute_create",
  "evidence_pin",
  "evidence_submit",
  "dispute_get",
  "court_get",
];
const INSTRUCTIONS =
  "This is the fake Kleros Dispute Service, for rehearsals and tests: every answer is scripted " +
  "and nothing is sent to Kleros (no dispute is filed, no file is published, no fee is paid).";

/** The two courts' clocks as read on 19 October 2026, in seconds: evidence, commit, vote, appeal. */
const COURT_TIMES: ReadonlyMap<number, readonly [number, number, number, number]> = new Map([
  [8, [900, 2700, 1800, 2700]],
  [34, [600, 2700, 1800, 129600]],
]);

/**
 * Spelled the way the template writes its answers (hex ids) while `ruling` arrives as a decimal
 * string, so every rehearsal goes through the reader's value normalisation.
 */
const RULING_OPTIONS: readonly { value: string; title: string }[] = [
  { value: "0x01", title: "Pay the provider" },
  { value: "0x02", title: "Refund the client" },
];
/** The service renders 0 with the refusal wording whether or not the round is tied. */
const REFUSE_LABEL = "Invalid / Refuse to Arbitrate";
/**
 * The first-round verdict at Appeal. The write-path scripts that still mine a dispute
 * (`unknown-submit`, `write-in-progress-once`) rule as `pay`, so the rest of the flow can be
 * rehearsed after them.
 */
const APPEAL_RULINGS: Readonly<Partial<Record<FakeScript, { ruling: string; tied: boolean }>>> = {
  refund: { ruling: "2", tied: false },
  tie: { ruling: "0", tied: true },
  refuse: { ruling: "0", tied: false },
};
const PAY_RULING = { ruling: "1", tied: false };

const PRE_APPEAL: readonly Period[] = ["Evidence", "Commit", "Vote"];
const PERIOD_AHEAD_MS = 10 * 60_000;
const APPEAL_AHEAD_MS = 36 * 3_600_000;
/** A stalled Vote reports a deadline already passed, as the testnet does when jurors are missing. */
const STALLED_BEHIND_MS = 3_600_000;
/** A tie that survives the appeal period finalises as 0: a refusal. */
const TIE_READS_TO_EXECUTED = 3;

const EXTENSION = /^[a-z0-9]{1,10}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
/** The docs cap `name` and `description` in UTF-8 bytes, not characters. */
const NAME_MAX_BYTES = 1024;
const DESCRIPTION_MAX_BYTES = 65_536;
const CID_HEX_CHARS = 46;

/**
 * The service prefixes an `unknown` with a plain-English warning before the JSON, so a reader
 * that parses the whole text throws; the fake does the same so the reader's last-object parse is
 * exercised.
 */
const CREATE_WARNING =
  "Warning: this filing was broadcast but no receipt arrived in time, so the dispute probably " +
  "exists and must not be filed again (a scripted answer: the fake sent nothing to Kleros).";
const SUBMIT_WARNING =
  "Warning: this submission was broadcast but no receipt arrived in time, so the document is " +
  "probably recorded and must not be submitted again (a scripted answer: the fake sent nothing " +
  "to Kleros).";

export class FakeDisputeService implements KlerosDisputeService {
  readonly deployment = "fake" as const;
  /** Every call, refused ones included, in order: the Kleros tool name and the arguments. */
  readonly calls: { tool: string; args: unknown; at: number }[] = [];
  readonly #script: FakeScript;
  readonly #readsUntilAppeal: number;
  readonly #court: Partial<CourtClock>;
  readonly #now: () => number;
  readonly #slots: readonly string[];
  readonly #cases = new Map<string, FakeCase>();
  #nextId: number;
  #writes = 0;
  #refusedOnce = false;

  constructor(o: FakeDisputeServiceOptions) {
    // The script and the counts may come from a command line: a typo must not rehearse another
    // outcome than the one asked for.
    if (!SCRIPTS.includes(o.script)) {
      throw new Error(`unknown fake Dispute Service script ${JSON.stringify(o.script)}`);
    }
    const firstId = o.firstCoreId ?? 1000;
    if (!Number.isSafeInteger(firstId) || firstId < 0) {
      throw new Error("fake Dispute Service firstCoreId must be a non-negative integer");
    }
    const readsUntilAppeal = o.readsUntilAppeal ?? 4;
    if (!Number.isSafeInteger(readsUntilAppeal) || readsUntilAppeal < 1) {
      throw new Error("fake Dispute Service readsUntilAppeal must be a positive integer");
    }
    this.#script = o.script;
    this.#nextId = firstId;
    this.#readsUntilAppeal = readsUntilAppeal;
    this.#court = o.court ?? {};
    this.#now = o.now ?? Date.now;
    this.#slots = o.aliasSlots ?? ["client", "provider"];
  }

  async listTools(): Promise<string[]> {
    this.#record("tools/list", {});
    return [...TOOLS];
  }

  async instructions(): Promise<string | null> {
    this.#record("initialize", {});
    return INSTRUCTIONS;
  }

  /** Any chain is answered: the fake is no deployment's, and a rehearsal row names "fake". */
  async getCourt(p: { chain: KlerosReadChain; courtId: number }): Promise<CourtClock> {
    this.#record("court_get", p);
    const times = COURT_TIMES.get(p.courtId);
    if (times === undefined) {
      throw new KlerosRefusal(
        "court_get",
        `COURT_NOT_FOUND: the fake answers courts 8 and 34 only, not ${String(p.courtId)}`,
      );
    }
    const timesPerPeriod: CourtClock["timesPerPeriod"] = [...(this.#court.timesPerPeriod ?? times)];
    const hiddenVotes = this.#court.hiddenVotes ?? true;
    const raw = this.#court.raw ?? {
      id: String(p.courtId),
      timesPerPeriod: [...timesPerPeriod],
      hiddenVotes,
      chain: p.chain,
    };
    return { courtId: p.courtId, timesPerPeriod, hiddenVotes, raw };
  }

  /** The CID is derived from the bytes alone, so the same file always gets the same URI. */
  async pin(p: { bytes: Uint8Array; extension: string }): Promise<PinOutcome> {
    this.#record("evidence_pin", { extension: p.extension, byteLength: p.bytes.byteLength });
    if (!EXTENSION.test(p.extension)) {
      throw new KlerosRefusal(
        "evidence_pin",
        "EXTENSION_INVALID: extension must be 1 to 10 lowercase letters or digits, such as pdf",
      );
    }
    if (p.bytes.byteLength === 0) {
      throw new KlerosRefusal("evidence_pin", "FILE_EMPTY: the attachment has no bytes");
    }
    const cid = `fake-${sha256Hex(p.bytes).slice(0, CID_HEX_CHARS)}`;
    return { status: "published", fileUri: `/ipfs/${cid}`, cid };
  }

  /**
   * The arguments are checked before the script answers. A refused or unmined filing takes no
   * id: only a mined one opens a case that `submitEvidence` and `getDispute` can find.
   */
  async createDispute(p: { aliases: Record<string, Address> }): Promise<CreateOutcome> {
    const tool = "dispute_create";
    const at = this.#record(tool, p);
    const aliases: unknown = p.aliases;
    if (!isPlainObject(aliases)) {
      throw new KlerosRefusal(
        tool,
        "ALIASES_REQUIRED: aliases is required as an object of slot to address; send {} to name no parties",
      );
    }
    for (const [slot, address] of Object.entries(aliases)) {
      if (!this.#slots.includes(slot)) {
        throw new KlerosRefusal(
          tool,
          `UNKNOWN_ALIAS_SLOT: ${JSON.stringify(slot)} is not a slot of this preset (${this.#slots.join(", ")})`,
        );
      }
      if (typeof address === "string" && ZERO_ADDRESS.test(address)) {
        throw new KlerosRefusal(
          tool,
          `ZERO_ADDRESS_ALIAS: ${slot} is the zero address; omit the slot to leave the party unknown`,
        );
      }
    }
    if (this.#script === "insufficient-balance") {
      throw new KlerosRefusal(
        tool,
        "INSUFFICIENT_BALANCE: the wallet cannot cover the arbitration fee; nothing was sent",
      );
    }
    if (this.#script === "write-in-progress-once" && !this.#refusedOnce) {
      this.#refusedOnce = true;
      throw new KlerosRefusal(
        tool,
        "WRITE_IN_PROGRESS: another write on this key is still running; nothing was sent",
      );
    }
    if (this.#script === "simulated") return { status: "simulated" };
    if (this.#script === "unknown-create") {
      const txHash = this.#txHash(tool);
      return { status: "unknown", txHash, text: unknownText(CREATE_WARNING, txHash) };
    }
    const coreDisputeId = String(this.#nextId++);
    this.#cases.set(coreDisputeId, { reads: 0, status: "Evidence", since: at });
    return {
      status: "mined",
      coreDisputeId,
      localDisputeId: coreDisputeId,
      txHash: this.#txHash(tool),
    };
  }

  async submitEvidence(p: {
    coreDisputeId: string;
    name: string;
    description: string;
    fileUri?: string;
    fileTypeExtension?: string;
  }): Promise<SubmitOutcome> {
    const tool = "evidence_submit";
    this.#record(tool, p);
    if (!withinBytes(p.name, NAME_MAX_BYTES)) {
      throw new KlerosRefusal(tool, "NAME_INVALID: name must be 1 to 1024 UTF-8 bytes");
    }
    if (!withinBytes(p.description, DESCRIPTION_MAX_BYTES)) {
      throw new KlerosRefusal(
        tool,
        "DESCRIPTION_INVALID: description must be 1 to 65536 UTF-8 bytes",
      );
    }
    if (p.fileTypeExtension !== undefined && p.fileUri === undefined) {
      throw new KlerosRefusal(tool, "FILE_URI_INVALID: fileTypeExtension was sent without fileUri");
    }
    if (!this.#cases.has(p.coreDisputeId)) {
      throw new KlerosRefusal(tool, notFound(p.coreDisputeId));
    }
    const txHash = this.#txHash(tool);
    if (this.#script === "unknown-submit") {
      return { status: "unknown", txHash, text: unknownText(SUBMIT_WARNING, txHash) };
    }
    return { status: "mined", txHash };
  }

  /** Each case walks its own script, one step per read of that case. */
  async getDispute(p: { chain: KlerosReadChain; coreDisputeId: string }): Promise<DisputeRead> {
    const at = this.#record("dispute_get", p);
    const c = this.#cases.get(p.coreDisputeId);
    if (c === undefined) throw new KlerosRefusal("dispute_get", notFound(p.coreDisputeId));
    c.reads++;
    const { status, ruling, tied } = this.#step(c.reads);
    if (status !== c.status) {
      c.status = status;
      c.since = at;
    }
    const ruled = status === "Executed";
    const rulingLabel = labelOf(ruling);
    const deadline = this.#deadline(status, at);
    return {
      status,
      ruling,
      tied,
      ruled,
      roundCount: 1,
      rulingLabel,
      rulingOptions: options(),
      deadline,
      lastPeriodChange: iso(c.since),
      unresolvedFields: [],
      raw: {
        id: p.coreDisputeId,
        status,
        ruling,
        tied,
        ruled,
        roundCount: 1,
        rulingLabel,
        rulingOptions: options(),
        deadline,
        chain: p.chain,
      },
    };
  }

  /**
   * Read `n` of a case. Before Appeal no option leads ("0", tied), which is the docs' trap: a
   * reader that ignores `tied` reports a vote that has not happened as a refusal.
   */
  #step(n: number): { status: Period; ruling: string; tied: boolean } {
    const appealAt = this.#script === "stalled" ? Number.POSITIVE_INFINITY : this.#readsUntilAppeal;
    if (n < appealAt) {
      return { status: PRE_APPEAL[Math.min(n, PRE_APPEAL.length) - 1]!, ruling: "0", tied: true };
    }
    if (this.#script === "tie" && n >= appealAt + TIE_READS_TO_EXECUTED) {
      return { status: "Executed", ruling: "0", tied: false };
    }
    return { status: "Appeal", ...(APPEAL_RULINGS[this.#script] ?? PAY_RULING) };
  }

  #deadline(status: Period, at: number): string | null {
    if (status === "Executed") return null;
    if (status === "Appeal") return iso(at + APPEAL_AHEAD_MS);
    if (status === "Vote" && this.#script === "stalled") return iso(at - STALLED_BEHIND_MS);
    return iso(at + PERIOD_AHEAD_MS);
  }

  /** A 32-byte hash, deterministic for the same sequence of writes. */
  #txHash(tool: string): Hex {
    this.#writes++;
    return `0x${sha256Hex(`fake:${tool}:${this.#writes}`)}`;
  }

  #record(tool: string, args: unknown): number {
    const at = this.#now();
    this.calls.push({ tool, args, at });
    return at;
  }
}

function labelOf(ruling: string): string {
  if (ruling === "1") return "Pay the provider";
  if (ruling === "2") return "Refund the client";
  return REFUSE_LABEL;
}

function options(): { value: string; title: string }[] {
  return RULING_OPTIONS.map((o) => ({ ...o }));
}

function notFound(coreDisputeId: string): string {
  return `DISPUTE_NOT_FOUND: the fake created no dispute ${JSON.stringify(coreDisputeId)}`;
}

function unknownText(warning: string, txHash: Hex): string {
  return `${warning}\n${JSON.stringify({ status: "unknown", txHash })}`;
}

function withinBytes(s: unknown, max: number): boolean {
  return typeof s === "string" && s !== "" && new TextEncoder().encode(s).byteLength <= max;
}

/** An object literal: not null, not an array, not a class instance. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
