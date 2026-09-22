/**
 * ONE place a Circle rejection becomes a sentence an operator can act on.
 *
 * WHY THIS FILE EXISTS. Circle answers a malformed request with `"API parameter invalid"` and
 * nothing else: no field, no length, no hint. That one string has now cost a day twice — once for
 * a wallet metadata NAME that was a few characters too long, and once for a `refId` that was
 * (see `circleRefId.ts`). Both times the SDK error itself carried more than we ever read: an HTTP
 * status, Circle's numeric `code`, and sometimes an `errors[]` array that NAMES the offending
 * field.
 *
 * The reason nobody read it is that the useful half sits on an axios error whose `config` also
 * carries the API-key header and the entity-secret ciphertext of the body we just sent. Printing
 * the error whole would have leaked both, so the error was never printed at all, and the useful
 * half went down with the dangerous half.
 *
 * So this describer pulls fields BY NAME, from an allowlist, and nothing else:
 *  - never the error object, never `config`, never `request`, never headers;
 *  - never `invalidValue` — Circle's field errors echo the offending value, and for a Circle call
 *    the offending value is OUR request body, ciphertext included;
 *  - never kept as `cause`: a reference held in the chain is a leak waiting for the next helper
 *    that stringifies a cause chain. The original is gone by design, and what it knew is in the
 *    message.
 *
 * It then adds the three of OUR fields that have actually been at fault — `walletId`, the `refId`
 * length and the `callData` length — because the whole failure mode is that Circle refuses to say
 * which one it disliked.
 *
 * The result flows through `publicErrorMessage` on the saga path as ordinary text: no matcher
 * claims it, so what the operator reads is what Circle answered.
 */

/** Per-field cap. Circle's messages are short; a pathological one must not become the log. */
const FIELD_LIMIT = 200;
/** How many `errors[]` entries to quote. The first ones name the field; the rest repeat. */
const MAX_LISTED_ERRORS = 4;

/** The call, plus the fields of OURS that a bare "API parameter invalid" could be about. */
export interface CircleCallFields {
  /** SDK method name, e.g. `createContractExecutionTransaction`. */
  call: string;
  walletId?: string;
  /** The value, not the length — the length is what gets printed. */
  refId?: string;
  /** The value, not the length — the length is what gets printed. */
  callData?: string;
  /** Wallet metadata `name`: the field that produced the 2026-08-13 bare rejection. */
  metadataName?: string;
}

/**
 * A Circle request that was REFUSED (a synchronous rejection of the API call).
 *
 * Distinct from `CircleTxFailedError` (Circle accepted the request and the transaction then
 * reached a terminal failure state) and `CircleTxTimeoutError` (accepted, still in flight). Those
 * two say something about money; this one says the request never happened.
 */
export class CircleRequestError extends Error {
  /** HTTP status, when the rejection had one. */
  readonly status: number | undefined;
  /** Circle's own `code`, as text (it arrives as a number). */
  readonly circleCode: string | undefined;

  constructor(message: string, p: { status?: number; circleCode?: string } = {}) {
    super(message);
    this.name = "CircleRequestError";
    this.status = p.status;
    this.circleCode = p.circleCode;
  }
}

/** A printable scalar, trimmed and capped. Objects and blanks are dropped, not stringified. */
function scalar(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? undefined : t.slice(0, FIELD_LIMIT);
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** Circle's body: `e.response.data`, which is an object, or occasionally a bare string. */
function body(e: unknown): { data?: Record<string, unknown>; text?: string } {
  const raw = asRecord(asRecord(e)?.response)?.data;
  return { data: asRecord(raw), text: scalar(raw) };
}

/**
 * `errors[]`, allowlisted: WHERE (`location`/`param`/`field`) and WHAT (`message`/`error`).
 * `invalidValue` is deliberately absent — see the file header.
 */
function describeErrors(raw: unknown): string | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const listed = raw
    .slice(0, MAX_LISTED_ERRORS)
    .map((x) => {
      const direct = scalar(x);
      if (direct) return direct;
      const o = asRecord(x) ?? {};
      const where = scalar(o.location) ?? scalar(o.param) ?? scalar(o.field);
      const what = scalar(o.message) ?? scalar(o.error) ?? scalar(o.constraints);
      return [where ? `[${where}]` : undefined, what].filter(Boolean).join(" ");
    })
    .filter((s) => s !== "");
  if (listed.length === 0) return undefined;
  const hidden = raw.length - MAX_LISTED_ERRORS;
  return `errors: ${listed.join("; ")}${hidden > 0 ? ` (+${hidden} more)` : ""}`;
}

/** What Circle answered, as far as it is knowable from the rejection. */
function circleAnswer(e: unknown): {
  text: string;
  status: number | undefined;
  circleCode: string | undefined;
} {
  const rec = asRecord(e);
  const { data, text } = body(e);
  const statusRaw = asRecord(rec?.response)?.status ?? rec?.status ?? rec?.statusCode;
  const status = typeof statusRaw === "number" ? statusRaw : undefined;
  // Circle's numeric `code` first: axios puts its own `ERR_BAD_REQUEST` on `e.code`, which says
  // nothing we do not already know from the status.
  const circleCode = scalar(data?.code) ?? scalar(rec?.code);
  const message =
    scalar(data?.message) ?? text ?? scalar(rec?.message) ?? "no message on the rejection";
  const errors = describeErrors(data?.errors ?? rec?.errors);
  const head = [
    status === undefined ? undefined : `HTTP ${status}`,
    circleCode === undefined ? undefined : `code ${circleCode}`,
  ].filter(Boolean);
  return {
    text: [...head, `"${message}"`, errors].filter(Boolean).join(", "),
    status,
    circleCode,
  };
}

/** The fields of ours the rejection could be about. Lengths, because that is what bites. */
function describeOurFields(f: CircleCallFields): string | undefined {
  const parts = [
    f.walletId ? `walletId ${f.walletId}` : undefined,
    f.refId === undefined ? undefined : `refId ${f.refId.length} chars`,
    f.callData === undefined ? undefined : `callData ${f.callData.length} chars`,
    f.metadataName === undefined ? undefined : `metadata name ${f.metadataName.length} chars`,
  ].filter(Boolean);
  return parts.length === 0 ? undefined : `our fields: ${parts.join(", ")}`;
}

/**
 * Turn a rejected Circle SDK call into one sentence that names the call, everything Circle said,
 * and the fields of ours that could be at fault. Already-described rejections pass through
 * untouched, so a wrapper and a call site can both use this without nesting the same text twice.
 */
export function circleRequestError(e: unknown, f: CircleCallFields): CircleRequestError {
  if (e instanceof CircleRequestError) return e;
  const answer = circleAnswer(e);
  const message = [`circle ${f.call} rejected: ${answer.text}`, describeOurFields(f)]
    .filter(Boolean)
    .join(" — ");
  return new CircleRequestError(message, {
    status: answer.status,
    circleCode: answer.circleCode,
  });
}
