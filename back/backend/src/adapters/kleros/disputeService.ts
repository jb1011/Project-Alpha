/**
 * The Kleros Dispute Service as the rest of the backend sees it: one interface, implemented by
 * the HTTP client (one instance per key) and by a scripted fake that rehearsals use.
 *
 * The outcomes are the service's documented statuses and nothing more. A write that may have gone
 * out is its own status (`unknown`), never folded into a failure: a second filing pays a second
 * fee and creates a second dispute, so the caller must be able to tell "refused" from "in doubt".
 */
import type { Address, Hex } from "viem";
import type { KlerosDeploymentName, KlerosReadChain } from "./deployments";

export interface KlerosDisputeService {
  /** Which deployment this instance is bound to (one instance per key; the fake answers "fake"). */
  readonly deployment: KlerosDeploymentName | "fake";
  /** tools/list: the names this key may call. */
  listTools(): Promise<string[]>;
  /**
   * The server's `instructions` string, read with one stateless `initialize` POST, or null when
   * the server does not answer one. It names the key's deployment, court, juror count and
   * broadcast setting, and the docs say to believe it over any page.
   */
  instructions(): Promise<string | null>;
  /**
   * court_get. `chain` is mandatory: court_get refuses to run without one. The HTTP client refuses
   * a chain other than its deployment's ("fake" included) before any request.
   */
  getCourt(p: { chain: KlerosReadChain; courtId: number }): Promise<CourtClock>;
  /** evidence_pin: bytes in, "/ipfs/<cid>" out. status checked = nothing published. */
  pin(p: { bytes: Uint8Array; extension: string }): Promise<PinOutcome>;
  /**
   * dispute_create with the aliases only (no chain: the key decides the deployment). Keys are the
   * slot keys `client` and `provider`.
   */
  createDispute(p: { aliases: Record<string, Address> }): Promise<CreateOutcome>;
  /** evidence_submit against the core id. */
  submitEvidence(p: {
    coreDisputeId: string;
    name: string;
    description: string;
    fileUri?: string;
    fileTypeExtension?: string;
  }): Promise<SubmitOutcome>;
  /**
   * dispute_get, items[0]. `chain` is mandatory and comes from the row that created the dispute:
   * without it the read fans out over ethereum, gnosis and arbitrum-one and never reaches the
   * testnet.
   */
  getDispute(p: { chain: KlerosReadChain; coreDisputeId: string }): Promise<DisputeRead>;
}

/** The court's clock, parsed from the court_get payload. */
export interface CourtClock {
  courtId: number;
  /** Seconds, in the court's order: evidence, commit, vote, appeal. */
  timesPerPeriod: [number, number, number, number];
  hiddenVotes: boolean;
  raw: unknown;
}

export type PinOutcome =
  | { status: "published"; fileUri: string; cid: string }
  | { status: "checked" };

/**
 * `unknown` means broadcast with no receipt in time: the dispute probably exists, so it is never
 * filed again. `simulated` stays in the union (and in `SubmitOutcome`) because the fake answers
 * it; the HTTP client raises a `PRESET_SIMULATES` refusal instead, since neither key is meant to
 * simulate.
 */
export type CreateOutcome =
  | { status: "mined"; coreDisputeId: string; localDisputeId?: string; txHash: Hex }
  | { status: "simulated" }
  | { status: "unknown"; txHash?: Hex; text: string };

export type SubmitOutcome =
  | { status: "mined"; txHash: Hex }
  | { status: "simulated" }
  | { status: "unknown"; txHash?: Hex; text: string };

export interface DisputeRead {
  /** The current period. A value outside these five is a transport error, never a guess. */
  status: "Evidence" | "Commit" | "Vote" | "Appeal" | "Executed";
  /** As the service sent it; a number is kept as its decimal string. */
  ruling: string;
  tied: boolean;
  ruled: boolean;
  roundCount: number;
  rulingLabel?: string;
  rulingOptions: { value: string; title: string }[];
  /** null when absent, empty, or the unix epoch, which the docs say means "unset". */
  deadline: string | null;
  lastPeriodChange?: string;
  /** Fields the service could not resolve (commonest on the testnet); a state, not an outage. */
  unresolvedFields: string[];
  raw: unknown;
}
