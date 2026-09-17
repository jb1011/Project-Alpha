import { BaseError } from "viem";

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

/** The public sentence for a throttled RPC. "Nothing was sent" is the actionable half. */
export const RATE_LIMIT_MESSAGE =
  "The chain RPC is rate-limiting us right now. Nothing was sent; try again in a minute.";

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

/** Every scheme-ful URL, greedily up to the first character that cannot be in one. */
const URL_RUN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]}\\]+/gi;

/** A hex run longer than a 32-byte hash: a raw transaction, calldata, a signature, a blob. */
const LONG_HEX = /0x[0-9a-fA-F]{65,}/g;

export function publicErrorMessage(e: unknown): string {
  const diagnostic = fullDiagnostic(e);
  if (RATE_LIMITED.test(diagnostic)) return RATE_LIMIT_MESSAGE;
  if (PLATFORM_OUT_OF_FUNDS.test(diagnostic)) return PLATFORM_FUNDS_MESSAGE;
  return sanitise(baseMessage(e));
}

/**
 * The text the two matchers read: the error's own message plus the numeric `status`/`code` that
 * viem carries as PROPERTIES rather than in the text.
 *
 * A 429 from a provider that sends no body reaches us as `HttpRequestError` whose message says
 * "HTTP request failed." and whose `status` is 429. Matching on text alone would miss it, which is
 * exactly the case the September retry storm was made of.
 *
 * NEVER returned to a caller — only tested against.
 */
function fullDiagnostic(e: unknown): string {
  const parts: string[] = [];
  for (let cur: unknown = e, hops = 0; cur != null && hops < MAX_CAUSE_HOPS; hops++) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      const { status, code, details } = cur as {
        status?: unknown;
        code?: unknown;
        details?: unknown;
      };
      if (typeof status === "number") parts.push(`status ${status}`);
      if (typeof code === "number") parts.push(`${code}`);
      if (typeof code === "string") parts.push(code);
      if (typeof details === "string") parts.push(details);
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
 * The order matters: URLs go first (so a key in a path is gone before anything else looks at the
 * text), then long hex runs (a raw transaction is not a secret, but it is 600 useless characters
 * that would eat the whole budget), then whitespace, then the cap.
 */
function sanitise(message: string): string {
  const withoutUrls = message.replace(URL_RUN, (raw) => originOf(raw));
  // First 10 characters — "0x" plus 8 hex — is enough to correlate with a log line and far too
  // little to be a signature, a key or a transaction.
  const withoutBlobs = withoutUrls.replace(LONG_HEX, (hex) => `${hex.slice(0, 10)}…`);
  const oneLine = withoutBlobs.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_LENGTH ? `${oneLine.slice(0, MAX_LENGTH - 1)}…` : oneLine;
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
