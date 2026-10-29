/**
 * What can go wrong talking to the Kleros Dispute Service, and what each failure says about
 * whether anything left the service.
 *
 * A tool refusal is `isError: true` with a text shaped `CODE: message`. There is no code field,
 * and the docs ask clients to match a short leading phrase at most, because the prose moves
 * between releases. Each write tool has its own closed list of codes meaning "nothing was sent"
 * (Kleros docs, "One dispute, from creation to a ruling", section "When something goes wrong",
 * https://docs.kleros.io/ai-tools/dispute-service/dispute-flow). Outside a list the answer is
 * "maybe": a repeated filing pays a second fee and creates a second dispute, so a code is only
 * read as safe when the docs say so for that very tool.
 */
import type { KlerosChain } from "./deployments";

export type WriteTool = "dispute_create" | "evidence_pin" | "evidence_submit";
export type Sent = "no" | "maybe";

/**
 * Raised by the client when a write answers `simulated`: nothing was sent and no dispute exists.
 * Both keys are set to broadcast, so a simulation means the key is not configured as agreed and
 * its instructions must be read again. sent = "no".
 */
export const PRESET_SIMULATES = "PRESET_SIMULATES";

/** Another write on the same key was still running. The docs: nothing was sent, on all three tools. */
const WRITE_IN_PROGRESS = "WRITE_IN_PROGRESS";

/** The leading `CODE:` phrase of a refusal text, upper case, digits and underscores, or null. */
export function leadingCode(text: string): string | null {
  return /^\s*([A-Z][A-Z0-9_]{2,}):/.exec(text)?.[1] ?? null;
}

/**
 * A tool refusal (`isError: true`). The message is the service's text, which never holds our key.
 * `code` is null when the text does not start with a code; `sentOf` then answers "maybe".
 */
export class KlerosRefusal extends Error {
  readonly code: string | null;

  constructor(
    readonly tool: string,
    readonly text: string,
  ) {
    super(text);
    this.name = "KlerosRefusal";
    this.code = leadingCode(text);
  }
}

/** Raised before any request when a read names a chain other than the instance's deployment. */
export class KlerosWrongDeploymentError extends Error {
  constructor(
    readonly expected: KlerosChain,
    readonly got: string,
  ) {
    super(
      `Kleros read names chain ${JSON.stringify(got)}, but this service is bound to ${expected}`,
    );
    this.name = "KlerosWrongDeploymentError";
  }
}

/**
 * An HTTP status decided before JSON-RPC: 401 (missing or unrecognised key), 429 (over the
 * per-key rate), 413 (request body too large), or any other non-success status.
 */
export class KlerosHttpError extends Error {
  constructor(
    readonly status: 401 | 429 | 413 | number,
    readonly body: string,
  ) {
    super(`Kleros Dispute Service answered HTTP ${status}`);
    this.name = "KlerosHttpError";
  }
}

/** No usable answer: the network failed, a deadline passed, or the answer could not be parsed. */
export class KlerosTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KlerosTransportError";
  }
}

/**
 * dispute_create: nothing was sent. `TRANSACTION_REVERTED` is left out on purpose: no dispute
 * exists after a revert, but filing again is a human's call once they have read why it reverted.
 * `WRITE_IN_PROGRESS` comes from the docs' general table.
 */
export const CREATE_NOT_SENT: readonly string[] = Object.freeze([
  "INSUFFICIENT_BALANCE",
  "COST_CEILING_EXCEEDED",
  "ZERO_ADDRESS_ALIAS",
  "ALIASES_REQUIRED",
  "UNKNOWN_ALIAS_SLOT",
  "INVALID_ALIASES",
  "TEMPLATE_INVALID",
  "POLICY_URI_INVALID",
  "RULING_OPTIONS_INVALID",
  "COURT_OUT_OF_RANGE",
  "JURORS_INVALID",
  "CHAIN_NOT_SUPPORTED",
  "UNKNOWN",
  "VALIDATION_ERROR",
  "KEY_FILE_MISSING",
  "KEY_FILE_PERMISSIONS",
  WRITE_IN_PROGRESS,
]);

/**
 * evidence_submit: nothing was sent. `TRANSACTION_REVERTED` is left out for the same reason as on
 * dispute_create: nothing was recorded, but submitting again is a human's call.
 */
export const SUBMIT_NOT_SENT: readonly string[] = Object.freeze([
  "DISPUTE_INVALID",
  "NAME_INVALID",
  "DESCRIPTION_INVALID",
  "FILE_URI_INVALID",
  "EXTENSION_INVALID",
  "EVIDENCE_INVALID",
  "DISPUTE_NOT_FOUND",
  "DISPUTE_NOT_ADDRESSABLE",
  "SIMULATION_REVERTED",
  "INSUFFICIENT_BALANCE",
  "WRONG_CHAIN",
  "NUMBER_INVALID",
  "CHAIN_NOT_SUPPORTED",
  "UNKNOWN",
  "VALIDATION_ERROR",
  "KEY_FILE_MISSING",
  "KEY_FILE_PERMISSIONS",
  "KEY_FILE_UNREADABLE",
  "KEY_FILE_INVALID",
  WRITE_IN_PROGRESS,
]);

/**
 * evidence_pin: nothing was published. Outside this list a pin refusal is "in doubt", which for
 * a pin is safe to retry (the same bytes give the same CID, and a pin spends nothing), with two
 * exceptions `sentOf` reads as "no" on every write tool: `WRITE_IN_PROGRESS` (call again once the
 * other write has returned) and `PRESET_SIMULATES`.
 */
export const PIN_NOT_PUBLISHED: readonly string[] = Object.freeze([
  "ATTACHMENT_INVALID",
  "EXTENSION_INVALID",
  "FILE_UNREADABLE",
  "FILE_EMPTY",
  "FILE_TOO_LARGE",
  "UNKNOWN",
  "VALIDATION_ERROR",
]);

const NOT_SENT: Readonly<Record<WriteTool, readonly string[]>> = Object.freeze({
  dispute_create: CREATE_NOT_SENT,
  evidence_submit: SUBMIT_NOT_SENT,
  evidence_pin: PIN_NOT_PUBLISHED,
});

/**
 * What the docs say about a refusal of this tool: did anything leave the service? Closed lists;
 * anything unlisted is "maybe" for the two chain writes and "maybe" for the pin (safe to retry
 * anyway). A null code (prose without a leading code) is "maybe" too.
 */
export function sentOf(tool: WriteTool, code: string | null): Sent {
  if (code === null) return "maybe";
  if (code === WRITE_IN_PROGRESS || code === PRESET_SIMULATES) return "no";
  return NOT_SENT[tool].includes(code) ? "no" : "maybe";
}
