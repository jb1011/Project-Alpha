/**
 * The external track record of one agent, as the guardian's settings screen reads it
 * (design 2026-10-23, section 4.2).
 *
 * Two halves, each with its own source and its own failure: the CHAIN half is what the configured
 * poster wrote to this agent's ERC-8004 identity on Arc, the RECORD half is the provider's own
 * record API, found through the wallet the identity names in its metadata. Neither is merged into
 * the other: when they disagree, both are served and `agreement` says so.
 *
 * Copied verbatim into `interface/src/lib/api/types.ts`.
 */
export interface ExternalRecordView {
  /** `recordUrl` only when it passed the link rule (an https URL on the provider's own host). */
  provider: { name: string; recordUrl: string | null };
  /** Decimal string. */
  agentId: string;
  chain:
    | {
        status: "ok";
        graded: number;
        correct: number;
        wrong: number;
        /** Entries from the poster, with both tags, in a value format the card does not read. */
        unrecognised: number;
        /** ISO 8601 UTC of the latest post; null = no post found, or the explorer did not answer. */
        lastGradedAt: string | null;
      }
    | { status: "unavailable"; reason: "rpc" | "decode" };
  record:
    | {
        status: "ok";
        lockingWallet: `0x${string}`;
        graded: number;
        correct: number;
        wrong: number;
        /** The most negative move against a graded call, in basis points; null = none graded. */
        worstMoveBps: number | null;
      }
    /** The identity names no wallet under the configured key, or not one on Ethereum (eip155:1). */
    | { status: "not_linked" }
    | {
        status: "unavailable";
        reason: "rpc" | "http" | "timeout" | "malformed" | "too_large";
        lockingWallet: `0x${string}` | null;
      };
  /** `chain.graded` against `record.graded`; unknown unless both halves are ok. */
  agreement: "match" | "differ" | "unknown";
  /** The only value today: the configuration refuses mainnet. */
  network: "testnet";
  /** ISO 8601. */
  checkedAt: string;
}
