/**
 * The agreement step's decisions, each pure: which live draft is offered instead of a second
 * order, whether the frozen agreement served is the one its hash commits to, the facts shown
 * beside it (the draft's expiry and the amendment delay, in words), the terms as paragraphs, what
 * the screen does after the order door answered, and the two hand-offs to the shell (the
 * in-memory flag that moves an order whose agreement was read on to the identity step, and a
 * door's sentence carried back to the company step).
 *
 * Nothing here reads a clock: the time comes in as `nowMs`. Nothing here writes: the order is
 * placed by a click, never on mount, and reading the agreement records nothing.
 */
import { keccak256, stringToBytes, type Hex } from "viem";
import {
  ApiError,
  type Address,
  type LegalBodyAgreement,
  type LegalBodyOrderView,
} from "@/lib/api/types";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import {
  DRAFT_LIFETIME_MS,
  isDraftExpired,
  sameAddress,
  type LegalBodyDerivation,
} from "./flow";
import { isSignInRequired } from "./gates";
import type { LegalBodyRailPhase } from "./phases";

const A = LEGAL_BODY_COPY.agreement;
const W = A.words;

const HOUR_MS = 3_600_000;
/** The most hours a draft can have left: its whole life. */
const DRAFT_HOURS = DRAFT_LIFETIME_MS / HOUR_MS;

/** `createdAt` as milliseconds, or NaN when it cannot be parsed. */
function createdMs(order: LegalBodyOrderView): number {
  return Date.parse(order.createdAt);
}

/** For ordering only: an unparsable `createdAt` sorts oldest. */
function timeOf(order: LegalBodyOrderView): number {
  const ms = createdMs(order);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** An own property only: nothing inherited is read. */
function own(v: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(v, key)
    ? (v as Record<string, unknown>)[key]
    : undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------------
// The live draft, offered instead of a second order
// ---------------------------------------------------------------------------------------------

/**
 * The newest draft of this company that can still be linked: a draft, not revoked, under 24
 * hours old. Null when there is none. Offered before the click, so a person who already placed an
 * order (on another visit, or a moment ago with the answer lost) continues it instead of spending
 * another order against the caps.
 */
export function liveDraftFor(
  orders: LegalBodyOrderView[],
  companyId: string,
  nowMs: number,
): LegalBodyOrderView | null {
  return orders
    .filter(
      (o) =>
        o.companyId === companyId &&
        o.state === "draft" &&
        !o.revoked &&
        !isDraftExpired(o, nowMs),
    )
    .reduce<LegalBodyOrderView | null>(
      (best, o) => (best === null || timeOf(o) > timeOf(best) ? o : best),
      null,
    );
}

/** The age of a draft as the continue button says it: whole hours, the way a person says them. */
export function continueDraftLabel(order: LegalBodyOrderView, nowMs: number): string {
  const age = nowMs - createdMs(order);
  const hours = Number.isFinite(age) ? Math.max(0, Math.floor(age / HOUR_MS)) : 0;
  if (hours === 0) return A.continueDraftRecent;
  if (hours === 1) return A.continueDraftOneHour;
  return fillCopy(A.continueDraft, { hours: String(hours) });
}

/**
 * The draft the step offers instead of a new order, with its button's label: the live draft of
 * this company placed on this deployment. A draft made under another chain or factory cannot move
 * here, so it is not offered, and a new order is. Nor is `refused`, a draft the link door refused
 * on this visit: it is live by this browser's rules, and continuing it would meet the same
 * refusal again.
 */
export function draftOffer(p: {
  orders: LegalBodyOrderView[];
  companyId: string;
  where: { chainId: number; factory: Address };
  nowMs: number;
  refused?: string | null;
}): { order: LegalBodyOrderView; label: string } | null {
  const here = p.orders.filter(
    (o) =>
      o.id !== p.refused && o.chainId === p.where.chainId && sameAddress(o.factory, p.where.factory),
  );
  const order = liveDraftFor(here, p.companyId, p.nowMs);
  return order ? { order, label: continueDraftLabel(order, p.nowMs) } : null;
}

// ---------------------------------------------------------------------------------------------
// The frozen agreement, against its hash
// ---------------------------------------------------------------------------------------------

/** 32 bytes of hex. A hash's letter case is not information: both sides compare in lower case. */
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** keccak256 over the UTF-8 bytes of `text`, exactly as served: no normalisation. */
function utf8Keccak(text: string): Hex {
  return keccak256(stringToBytes(text));
}

/** The manifest's `terms.hash`, read from own properties only, or null when the manifest is not
 *  JSON or has no such hash of the right shape. */
function termsHashOf(manifest: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const terms = own(parsed, "terms");
  if (!isRecord(terms)) return null;
  const hash = own(terms, "hash");
  return typeof hash === "string" && HASH.test(hash) ? hash : null;
}

export type AgreementCheck =
  | { ok: true }
  | { ok: false; problem: "manifest_hash" | "terms_hash" | "manifest_json" };

/**
 * Whether the agreement served is the one the order froze, checked in the browser before a word
 * of it is shown: keccak256 of the manifest's UTF-8 bytes is `manifestHash` (the hash the link
 * will sign), the manifest is JSON whose `terms.hash` is a hash, and keccak256 of the terms'
 * UTF-8 bytes is that `terms.hash`. In that order, the first that fails is the problem. A field
 * that is not a string fails its check; nothing here throws.
 */
export function verifyAgreement(a: LegalBodyAgreement): AgreementCheck {
  const { manifest, manifestHash, termsDoc } = a;
  if (
    typeof manifest !== "string" ||
    typeof manifestHash !== "string" ||
    !HASH.test(manifestHash) ||
    utf8Keccak(manifest) !== manifestHash.toLowerCase()
  )
    return { ok: false, problem: "manifest_hash" };
  const termsHash = termsHashOf(manifest);
  if (termsHash === null) return { ok: false, problem: "manifest_json" };
  if (typeof termsDoc !== "string" || utf8Keccak(termsDoc) !== termsHash.toLowerCase())
    return { ok: false, problem: "terms_hash" };
  return { ok: true };
}

/**
 * Whether the agreement served is this order's own: the hash the order froze when it was placed
 * is the served manifest's hash. `verifyAgreement` proves the agreement agrees with itself; this
 * proves it is the one this order's link will sign. An order with no frozen agreement has none.
 */
export function agreementOfOrder(order: LegalBodyOrderView, a: LegalBodyAgreement): boolean {
  return (
    order.agreement !== null &&
    typeof a.manifestHash === "string" &&
    a.manifestHash.toLowerCase() === order.agreement.hash.toLowerCase()
  );
}

/** What stops the agreement step, or null: the agreement's own inconsistency first, then an
 *  agreement that is not this order's (`order_hash`). */
export function agreementProblem(
  order: LegalBodyOrderView,
  a: LegalBodyAgreement,
): Extract<AgreementCheck, { ok: false }>["problem"] | "order_hash" | null {
  const check = verifyAgreement(a);
  if (!check.ok) return check.problem;
  return agreementOfOrder(order, a) ? null : "order_hash";
}

/**
 * The wording's version, and whether it carries the draft badge. Only an approved wording goes
 * without the badge: a status this build does not know reads as a draft.
 */
export function agreementOnScreen(a: LegalBodyAgreement): { wordingVersion: string; draft: boolean } {
  return {
    wordingVersion: fillCopy(A.wordingVersion, { version: a.textVersion }),
    draft: a.textStatus !== "approved",
  };
}

/**
 * The terms as paragraphs: split on blank lines (a blank line may hold spaces or tabs, and line
 * ends may be CRLF), each paragraph trimmed, none empty. A single line break stays inside its
 * paragraph. The paragraphs are text: nothing is parsed as markup, and the screen renders them as
 * text, never as HTML.
 */
export function termsParagraphs(termsDoc: string): string[] {
  return termsDoc
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------------------------
// The facts beside the agreement
// ---------------------------------------------------------------------------------------------

/** Whole hours in words: under one is "less than an hour". */
export function hoursWords(hours: number): string {
  if (hours < 1) return W.lessThanAnHour;
  if (hours === 1) return W.hour;
  return fillCopy(W.hours, { n: String(hours) });
}

/** A duration in seconds in words, in the largest whole unit that says it exactly: 172800 is
 *  "48 hours", 5400 is "90 minutes", 61 is "61 seconds". */
export function durationWords(seconds: number): string {
  if (Number.isSafeInteger(seconds) && seconds > 0) {
    if (seconds % 3_600 === 0) {
      const h = seconds / 3_600;
      return h === 1 ? W.hour : fillCopy(W.hours, { n: String(h) });
    }
    if (seconds % 60 === 0) {
      const m = seconds / 60;
      return m === 1 ? W.minute : fillCopy(W.minutes, { n: String(m) });
    }
  }
  return seconds === 1 ? W.second : fillCopy(W.seconds, { n: String(seconds) });
}

export type AgreementFacts = {
  /** 24 hours after `createdAt`; NaN when `createdAt` cannot be read. */
  expiresAtMs: number;
  /** Whole hours before the expiry, never below 0 nor above the draft's 24. */
  hoursLeft: number;
  /** The amendment delay in words. */
  delayWords: string;
};

/**
 * The draft's expiry and the order's amendment delay. The hours left are whole hours, rounded
 * down, so the screen never promises more time than there is; a `createdAt` from a clock ahead
 * of this browser's never shows more than the draft's 24 hours.
 */
export function agreementFacts(order: LegalBodyOrderView, nowMs: number): AgreementFacts {
  const expiresAtMs = createdMs(order) + DRAFT_LIFETIME_MS;
  const left = expiresAtMs - nowMs;
  const hoursLeft = Number.isFinite(left)
    ? Math.min(DRAFT_HOURS, Math.max(0, Math.floor(left / HOUR_MS)))
    : 0;
  return { expiresAtMs, hoursLeft, delayWords: durationWords(order.amendmentDelay) };
}

/** A moment to the minute, in UTC ("2026-10-13 09:05 UTC"), or null for one that cannot be read. */
export function utcMinute(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The expiry line: the time in UTC and the hours left; null when the expiry is not known. */
export function expiryLine(facts: AgreementFacts): string | null {
  const time = utcMinute(facts.expiresAtMs);
  return time === null ? null : fillCopy(A.expiry, { time, left: hoursWords(facts.hoursLeft) });
}

/** The amendment delay line. */
export function delayLine(facts: AgreementFacts): string {
  return fillCopy(A.delay, { delay: facts.delayWords });
}

// ---------------------------------------------------------------------------------------------
// The order door's answer
// ---------------------------------------------------------------------------------------------

/**
 * The door's answer read as what it should be: a draft of this company, with an id. Anything else
 * is null, and the screen treats it as an answer it could not read (the list is read again).
 */
export function placedOrder(answer: unknown, companyId: string): LegalBodyOrderView | null {
  if (!isRecord(answer)) return null;
  const id = own(answer, "id");
  if (typeof id !== "string" || id.length === 0) return null;
  if (own(answer, "companyId") !== companyId || own(answer, "state") !== "draft") return null;
  return answer as LegalBodyOrderView;
}

export type OrderRefusalOutcome =
  /** The company cannot stand behind a body: back to the company step, with the door's sentence. */
  | { kind: "company"; sentence: string }
  /** The door's sentence, as served: the caps, an unapproved wording, and every other refusal. */
  | { kind: "sentence"; sentence: string }
  /** No answer of the API's: whether the order was placed is not known. */
  | { kind: "no_answer" };

/**
 * What the screen does after the order door refused. A refusal that means "sign in" is routed by
 * the shell before this is asked. The code is matched by equality, never by indexing.
 */
export function orderRefusalOutcome(e: unknown): OrderRefusalOutcome {
  if (!(e instanceof ApiError)) return { kind: "no_answer" };
  if (e.code === "company_not_eligible") return { kind: "company", sentence: e.message };
  return { kind: "sentence", sentence: e.message };
}

/**
 * A read of the agreement that failed: the API's sentence as served, else the step's own. A
 * refusal that means "sign in" is never shown: the retry routes it to the sign-in step.
 */
export function agreementReadSentence(e: unknown): string {
  return e instanceof ApiError && !isSignInRequired(e) ? e.message : A.unreadable;
}

// ---------------------------------------------------------------------------------------------
// The hand-offs to the shell
// ---------------------------------------------------------------------------------------------

/**
 * The phase the screen shows. The derivation sends a draft whose owner has not been chosen to the
 * agreement; once its agreement was read on this visit (`readFor`, an id held in memory only), the
 * same draft goes on to the identity step. Any other answer of the derivation stands as it is, and
 * the flag never moves an order past the draft. A reload forgets the flag, so the agreement is
 * shown again.
 */
export function withAgreementRead(
  derivation: LegalBodyDerivation,
  p: { order: LegalBodyOrderView | null; readFor: string | null },
): LegalBodyDerivation {
  if (derivation.phase !== "agreement" || derivation.notice !== undefined) return derivation;
  const { order, readFor } = p;
  if (order === null || order.state !== "draft" || readFor === null || order.id !== readFor)
    return derivation;
  return { phase: "identity" };
}

/**
 * The flag after a jump on the rail: a jump to the agreement shows it again, as the same jump
 * clears the owner choice; any other jump keeps it.
 */
export function agreementReadAfterJump(
  target: LegalBodyRailPhase,
  readFor: string | null,
): string | null {
  return target === "agreement" ? null : readFor;
}

/** A door's sentence carried back to the step it sends the person to. */
export type CarriedSentence = { to: LegalBodyRailPhase; sentence: string };

/** The carried sentence, on the step it names only; null anywhere else. */
export function sentenceOnArrival(
  carried: CarriedSentence | null,
  current: LegalBodyRailPhase,
): string | null {
  return carried !== null && carried.to === current ? carried.sentence : null;
}
