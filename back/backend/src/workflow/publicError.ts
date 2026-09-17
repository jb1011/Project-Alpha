import { createHash } from "node:crypto";
import { BaseError } from "viem";
import { BroadcastUnconfirmedError, PriorTransferUnconfirmedError } from "../errors";

/**
 * THE ONE PLACE a failure becomes a sentence we are willing to show a stranger.
 *
 * 2026-09-16: a deploy failed, the runner stored `e.message` verbatim in `entity.error`, and the
 * wizard rendered it under "Deployment failed". That message was a viem diagnostic, and a viem
 * diagnostic quotes back everything it was given: the RPC URL **with the provider API key in its
 * path**, the request body, the whole raw signed transaction and the calldata. All of it went on
 * screen, and `entity.error` is persisted, so all of it is still in the database.
 *
 * So this is not "prettier errors". It is the boundary between an exception (which may say
 * anything, because nobody wrote it for an audience) and a stored, rendered string. Everything
 * that reaches `entity.error` or an ops line goes through here.
 *
 * Three things happen, in this order:
 *
 *  1. **Pick the base text.** viem's `shortMessage` is the one-line version of a page-long
 *     diagnostic ("HTTP request failed." vs. that plus Status, URL, Request body, Details and
 *     Version), so it is preferred whenever there is one — including when a viem error is nested
 *     as the `cause` of one of ours.
 *  2. **Recognise the two failures we can explain.** A throttled RPC and an empty platform wallet
 *     are not mysteries; they are the two incidents that produced this file. Each gets a plain
 *     sentence that says what happened and whether anything was sent. The matchers read the FULL
 *     diagnostic (not the sanitised text) because that is where the 429, the `-32005` and the
 *     revert string live — reading it is safe precisely because the output is a fixed sentence.
 *  3. **Sanitise whatever is left.** The fall-through is the path that has to be safe on its own:
 *     a matcher that never fires must not be the only thing standing between an API key and the
 *     browser.
 *
 * ⚠ This does NOT redact PII — `opsLog` does that for the fields it writes (`redactPii`), and
 * nothing in a chain error carries an SSN. It redacts CREDENTIALS and BYTES.
 */

/** How far to walk a `cause` chain. Same bound as `decodedRevertName` in adapters/arc/relay.ts. */
const MAX_CAUSE_HOPS = 8;

/**
 * The public sentence for a throttled RPC.
 *
 * ⚠ "Nothing was sent" is a claim about a BROADCAST, and it is only true in one of the two windows
 * a 429 arrives in. It survives here because the other window is now caught above it by type:
 * `BroadcastUnconfirmedError` is thrown the moment a hash exists, so anything that reaches this
 * sentence was refused before the send. Two gates keep that true — the type check, and R2's
 * requirement that a viem error be in the chain at all. Do not add a third caller.
 */
export const RATE_LIMIT_MESSAGE =
  "The chain RPC is rate-limiting us right now. Nothing was sent; try again in a minute.";

/** The sent-but-unknown sentence. Names the hash so a founder can read it off the screen, and
 *  forbids the retry that would otherwise move the same money twice. */
export const broadcastUnconfirmedMessage = (txHash: string) =>
  `The transfer was sent (${shortHash(txHash)}) but we could not confirm it yet. Do not retry: it will appear on the dashboard once confirmed.`;

/** The refusal: a previous broadcast is unresolved, so this request did nothing. */
export const priorTransferUnconfirmedMessage = (txHash: string) =>
  `A previous transfer (${shortHash(txHash)}) has not been confirmed yet, so nothing new was sent. Do not retry until it appears on the dashboard.`;

/** `0x1234…efab` — enough to find the transaction, short enough to read off a screenshot. */
function shortHash(txHash: string): string {
  return txHash.length > 12 ? `${txHash.slice(0, 6)}…${txHash.slice(-4)}` : txHash;
}

/** The public sentence for the 2026-09-14 incident: the platform wallet was at 0.676 USDC. */
export const PLATFORM_FUNDS_MESSAGE =
  "The platform funding wallet cannot cover this transfer right now.";

/** The cap. One line of UI copy, not a log. */
const MAX_LENGTH = 300;

/**
 * Rate limiting, as the four rails actually spell it: an HTTP status, the JSON-RPC code every
 * provider uses for it, and the two English phrasings.
 *
 * Kept deliberately small. A matcher that tries to recognise everything recognises the wrong
 * thing, and the cost of a miss here is only that the caller sees the sanitised message instead
 * of a nicer one.
 */
const RATE_LIMITED =
  /rate.?limit|too.?many.?requests|(?:^|[^\d-])-32005(?![\d])|(?:status|http(?:\serror)?)\W{0,3}429\b/i;

/**
 * An empty (or too-empty) funding wallet, in the three shapes it arrives in: viem's pre-flight
 * cost check, the ERC-20 revert string, and a node's own wording.
 *
 * ⚠ "exceeds balance" is matched, "execution reverted" alone is NOT: a revert has a hundred
 * causes and claiming the platform wallet is empty for all of them would send an operator to top
 * up a wallet that is full.
 */
const PLATFORM_OUT_OF_FUNDS = /insufficient\s+funds|exceeds\s+the\s+balance|exceeds\s+balance/i;

/**
 * Every scheme-ful URL, greedily up to the first character that cannot be in one.
 *
 * ⚠ NO leading `\b` (review R4). It could not match between `_` and `h`, so
 * `RPC_URL_https://host/v2/KEY` was invisible to the scan and passed through whole, key included.
 * The pattern needs no anchor: without one it can only ever match MORE.
 */
const URL_RUN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]}\\]+/gi;

/**
 * A hex run longer than a 32-byte hash: a raw transaction, calldata, a signature, a blob.
 *
 * ⚠ The threshold is deliberate and it is a TRADE (review R5): a 64-hex value is kept, because
 * that is the shape of a transaction hash and an operator needs it — but it is also the shape of a
 * private key or a seed. Nothing in this codebase prints one today (checked: viem's key validators
 * throw value-free, and `src/secrets/index.ts` prints the NAME), and the labelled shape
 * (`private key 0x…`, `seed 0x…`) is caught by `LABELLED_SECRET` below rather than by length.
 */
const LONG_HEX = /0x[0-9a-fA-F]{65,}/g;

/**
 * A credential named by its own label, outside a URL (review R6).
 *
 * `Authorization: Bearer …`, `"x-api-key":"…"`, `apiKey=…`, `private key 0x…`. No producer does
 * this today — viem prints Status/URL/body and never headers — but the whole point of this file is
 * to hold when a producer surprises us.
 *
 * The value must LOOK like a credential (12+ characters from a credential alphabet), which is what
 * keeps "token expired", "secret invalid" and `DOOLA_WEBHOOK_SECRET is missing` readable: erring
 * toward redaction is right, erring toward unreadable diagnostics is not.
 */
const LABELLED_SECRET =
  /\b(authorization|bearer|api[-_ ]?key|apikey|x-api-key|token|secret|seed|private[-_ ]?key)\b(\s*["']?\s*[:=]\s*["']?\s*|\s+)([A-Za-z0-9._~+/=-]{12,})/gi;

/** The operator's budget. Bigger than the browser's, and through the same sanitiser. */
const MAX_DIAGNOSTIC_LENGTH = 600;

export function publicErrorMessage(e: unknown): string {
  // ── TYPE FIRST, text second. The two money-truth cases are facts the thrower KNEW, and no
  //    amount of message matching can recover a fact that was never in the text.
  const unconfirmed = firstInChain(e, isBroadcastUnconfirmed);
  if (unconfirmed) return broadcastUnconfirmedMessage(unconfirmed.txHash);
  const prior = firstInChain(e, isPriorTransferUnconfirmed);
  if (prior) return priorTransferUnconfirmedMessage(prior.txHash);

  const diagnostic = fullDiagnostic(e);
  // ⚠ Gated on a viem error being in the chain (review R2). `fullDiagnostic` reads a numeric
  // `status` off ANY error, and axios exposes `e.status === 429` — so a Circle or doola 429 used
  // to be reported as the CHAIN rate-limiting us, and as nothing having been sent, while a Circle
  // transaction was in flight. The sentence names an actor; it may only be used once that actor
  // has been identified.
  if (viemErrorIn(e) && RATE_LIMITED.test(diagnostic)) return RATE_LIMIT_MESSAGE;
  if (PLATFORM_OUT_OF_FUNDS.test(diagnostic)) return PLATFORM_FUNDS_MESSAGE;
  return sanitise(baseMessage(e), MAX_LENGTH);
}

/**
 * THE OPERATOR'S VERSION: the whole cause chain, sanitised, no matcher substitution (Q4).
 *
 * The browser gets one sentence because a founder can act on one sentence. journald gets the chain
 * because an operator cannot act on "the chain RPC is rate-limiting us" three days later. One
 * sanitiser, two budgets, and neither output carries a credential — journald is a lower bar than
 * the browser (readable by every member of `systemd-journal`, and copied into `/var/log/syslog`
 * wherever rsyslog is installed), not a vault.
 */
export function operatorDiagnostic(e: unknown): string {
  return sanitise(fullDiagnostic(e, { withNames: true }), MAX_DIAGNOSTIC_LENGTH);
}

/**
 * A stable 8-hex join key for one failure (Q4).
 *
 * Appended to the stored public sentence and emitted on the ops line, so a founder's screenshot
 * ("… (ref 4f2a9c11)") finds the journald entry that has the whole chain — with nothing secret in
 * transit either way. Digested from the RAW diagnostic, deliberately: the digest reveals nothing,
 * and hashing the raw text is what makes the same failure produce the same ref.
 */
export function errorRef(e: unknown): string {
  return createHash("sha256")
    .update(fullDiagnostic(e, { withNames: true }))
    .digest("hex")
    .slice(0, 8);
}

/**
 * The three fields a FAILURE is recorded with: the sentence (ref-suffixed), the operator's chain,
 * and the key that joins them.
 *
 * One function rather than three calls at each site, so a caller cannot store a sentence whose ref
 * belongs to a different error.
 */
export function publicFailure(e: unknown): { error: string; errorDetail: string; ref: string } {
  const ref = errorRef(e);
  return {
    error: `${publicErrorMessage(e)} (ref ${ref})`,
    errorDetail: operatorDiagnostic(e),
    ref,
  };
}

/** Walk the `cause` chain for the first error a predicate accepts. Hop-bounded (cycles exist). */
function firstInChain<T>(e: unknown, pick: (x: unknown) => T | undefined): T | undefined {
  for (let cur: unknown = e, hops = 0; cur != null && hops < MAX_CAUSE_HOPS; hops++) {
    const hit = pick(cur);
    if (hit) return hit;
    if (!(cur instanceof Error)) return undefined;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * `instanceof` by NAME as well as by class.
 *
 * The class check is the real one. The name check is the seatbelt: `src/errors.ts` is loaded once,
 * but a bundler, a duplicated dependency tree or a structured-clone boundary can produce a second
 * copy of a class, and the cost of a missed `instanceof` here is the message that invites a double
 * transfer.
 */
function isBroadcastUnconfirmed(x: unknown): BroadcastUnconfirmedError | undefined {
  return x instanceof BroadcastUnconfirmedError ||
    ((x as Error)?.name === "BroadcastUnconfirmedError" &&
      typeof (x as BroadcastUnconfirmedError)?.txHash === "string")
    ? (x as BroadcastUnconfirmedError)
    : undefined;
}

function isPriorTransferUnconfirmed(x: unknown): PriorTransferUnconfirmedError | undefined {
  return x instanceof PriorTransferUnconfirmedError ||
    ((x as Error)?.name === "PriorTransferUnconfirmedError" &&
      typeof (x as PriorTransferUnconfirmedError)?.txHash === "string")
    ? (x as PriorTransferUnconfirmedError)
    : undefined;
}

/** The viem error in the chain, if any — the gate on every sentence that blames the chain. */
function viemErrorIn(e: unknown): BaseError | undefined {
  return firstInChain(e, (x) => (x instanceof BaseError ? x : undefined));
}

/**
 * The text the two matchers read: the error's own message plus the numeric `status`/`code` that
 * viem carries as PROPERTIES rather than in the text.
 *
 * A 429 from a provider that sends no body reaches us as `HttpRequestError` whose message says
 * "HTTP request failed." and whose `status` is 429. Matching on text alone would miss it, which is
 * exactly the case the September retry storm was made of.
 *
 * NEVER returned to a caller RAW — the matchers test against it, and `operatorDiagnostic` returns
 * it only after `sanitise`.
 *
 * `withNames` adds each hop's class name (and viem's `shortMessage`), which is what makes the
 * operator's copy readable — `HttpRequestError` before "HTTP request failed." is the difference
 * between a log line and a diagnosis. The matchers do not need it, so they do not pay for it.
 */
function fullDiagnostic(e: unknown, opts: { withNames?: boolean } = {}): string {
  const parts: string[] = [];
  for (let cur: unknown = e, hops = 0; cur != null && hops < MAX_CAUSE_HOPS; hops++) {
    if (cur instanceof Error) {
      parts.push(opts.withNames ? `${cur.name}: ${cur.message}` : cur.message);
      const { status, code, details, shortMessage } = cur as {
        status?: unknown;
        code?: unknown;
        details?: unknown;
        shortMessage?: unknown;
      };
      // ⚠ The property branch is LOAD-BEARING (review R8): a 429 from a transport that renders no
      // `Status:` line exists only here. Deleting these lines used to leave the suite green;
      // `publicError.test.ts` now has a BaseError whose 429 is a property and nothing else.
      if (typeof status === "number") parts.push(`status ${status}`);
      if (typeof code === "number") parts.push(`${code}`);
      if (typeof code === "string") parts.push(code);
      if (typeof details === "string") parts.push(details);
      if (opts.withNames && typeof shortMessage === "string") parts.push(shortMessage);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" | ");
}

/** viem's one-liner where there is one, else the plain message, else the stringified value. */
function baseMessage(e: unknown): string {
  // viem's own traversal first, for the reason adapters/arc/relay.ts gives: `walk` is the
  // supported API, and a hand-rolled version silently breaks on an internal nesting change.
  if (e instanceof BaseError) {
    const short =
      e.shortMessage || (e.walk((x) => x instanceof BaseError) as BaseError | null)?.shortMessage;
    if (short) return short;
  }
  // One of OURS wrapping one of viem's — `ContractRevertError` does exactly this (`{ cause: err }`)
  // and its own message embeds the full diagnostic.
  for (let cur: unknown = e, hops = 0; cur instanceof Error && hops < MAX_CAUSE_HOPS; hops++) {
    if (cur instanceof BaseError && cur.shortMessage) return cur.shortMessage;
    cur = (cur as { cause?: unknown }).cause;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Strip credentials and bytes, then make it one line of bounded copy.
 *
 * The order matters. URLs go first, so a key in a path is gone before anything else looks at the
 * text. Then LABELLED credentials — after the URL rule, because a URL is already an origin by
 * then and cannot be mistaken for a bearer token's value. Then long hex runs (a raw transaction is
 * not a secret, but it is 600 useless characters that would eat the whole budget), then
 * whitespace, then the cap.
 *
 * The cap is a parameter because there are two audiences with the same safety rules and different
 * budgets: 300 characters of copy for the browser, 600 for journald.
 */
function sanitise(message: string, cap: number): string {
  const withoutUrls = message.replace(URL_RUN, (raw) => originOf(raw));
  const withoutSecrets = withoutUrls.replace(LABELLED_SECRET, (_m, label, sep) => {
    // `sep` keeps the shape recognisable (`Bearer <redacted>`, `"x-api-key":"<redacted>"`) so the
    // line still reads as the header it was.
    return `${label}${sep}<redacted>`;
  });
  // First 10 characters — "0x" plus 8 hex — is enough to correlate with a log line and far too
  // little to be a signature, a key or a transaction.
  const withoutBlobs = withoutSecrets.replace(LONG_HEX, (hex) => `${hex.slice(0, 10)}…`);
  const oneLine = withoutBlobs.replace(/\s+/g, " ").trim();
  return oneLine.length > cap ? `${oneLine.slice(0, cap - 1)}…` : oneLine;
}

/**
 * `https://host` — scheme and host, nothing else.
 *
 * Drops the path (where our provider key lives), the query (where everyone else's does) and the
 * userinfo. The origin is kept rather than the whole URL being dropped because "which host
 * refused us" is the first thing an operator asks and it is not a secret.
 */
function originOf(raw: string): string {
  try {
    const u = new URL(raw);
    // `origin` is "null" for non-special schemes (ws://, ipc://…), so compose it by hand there —
    // `u.host` never includes userinfo.
    return u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`;
  } catch {
    // Unparseable: keep the scheme only. Never the original string.
    return `${raw.split("://")[0]}://(redacted)`;
  }
}
