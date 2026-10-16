/**
 * The link step's decisions, each pure.
 *
 * The link is the one signature that creates a legal body: the identity's owner signs it, and the
 * link door reserves the body and creates it. On the browser branch the owner is the wallet in
 * session, which is also the guardian. So the step asks for the link only on a click of "Sign",
 * checks every field of it before the wallet opens (`linkSignGate`, beside the statement's gate),
 * shows the five fields and the domain decoded, and sends the signed link once per click.
 *
 * Here: what is asked for (`linkRequestFor`), the fields in words (`decodeLinkFields`,
 * `linkFieldRows`), the owner check the browser branch adds to the field checks
 * (`identityOwnerCheck`), which screen the phase shows (`linkScreen`), how every answer of the two
 * link doors is read (`linkAnswerOutcome`, `linkErrorOutcome`), what the next click does
 * (`keepsSignedLink`, `linkClickPlan`) and what the step says and offers after each outcome
 * (`linkOutcomeView`).
 *
 * Nothing here reads a clock or sends a request: the time comes in as seconds, and every request
 * is a click's. A screen shows the doors' sentences as served and never rewrites them.
 */
import {
  ApiError,
  type Address,
  type Hex,
  type LegalBodyConfig,
  type LegalBodyOrderView,
  type LinkMessageResult,
  type LinkSubmitAnswer,
  type LinkTypedDataWire,
} from "@/lib/api/types";
import { TIMEOUT_CODE } from "@/lib/api/timeout";
import { durationWords, hoursWords, utcMinute } from "./agreement";
import type { Refusal } from "./chain";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import { linkDoorRoute, linkSubmitOutcome } from "./doorOutcome";
import { sameAddress, type LegalBodyDerivation, type OwnerBranch } from "./flow";
import { MIN_LINK_REMAINING_SECONDS } from "./typedData";

type AvailableConfig = Extract<LegalBodyConfig, { available: true }>;

const L = LEGAL_BODY_COPY.link;
const W = LEGAL_BODY_COPY.agreement.words;

// ---------------------------------------------------------------------------------------------
// What is asked for
// ---------------------------------------------------------------------------------------------

/** The paste branch's link life: six hours, since its signer is not in this browser. */
export const PASTE_LINK_TTL_SECONDS = 21_600;

/**
 * The lifetime the link-message door is asked for. The browser branch asks for none, so the
 * server's default (an hour, by the chain's clock) applies. The paste branch asks for six hours,
 * and is refused before any door when the deployment serves a smaller ceiling.
 */
export function linkRequestFor(
  branch: OwnerBranch,
  config: Pick<AvailableConfig, "linkTtl">,
): { ttlSeconds?: number } | { problem: "ttl_above_max" } {
  if (branch === "browser") return {};
  // Written so that a ceiling that cannot be read (NaN) refuses.
  if (!(PASTE_LINK_TTL_SECONDS <= config.linkTtl.max)) return { problem: "ttl_above_max" };
  return { ttlSeconds: PASTE_LINK_TTL_SECONDS };
}

// ---------------------------------------------------------------------------------------------
// The served link, shown decoded
// ---------------------------------------------------------------------------------------------

export type DecodedLink = {
  agentId: string;
  guardian: Address;
  /** The amendment delay in words: "48 hours". */
  amendmentDelay: string;
  agreementHash: Hex;
  /** The deadline in ISO 8601, in UTC; "" for one no date can hold. */
  deadlineIso: string;
  /** Whole minutes before the deadline, rounded down and never below zero. */
  minutesLeft: number;
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
};

/**
 * The link's five fields and its domain, decoded for a person: the delay in words, the deadline
 * as a date and as the minutes left. `nowSeconds` is this browser's clock; the minutes are
 * rounded down, so the screen never promises more time than there is. Call it on a link the gate
 * accepted; it never throws on one it did not.
 */
export function decodeLinkFields(td: LinkTypedDataWire, nowSeconds: number): DecodedLink {
  const m = td.message;
  const deadline = Number(m.deadline);
  const at = new Date(deadline * 1000);
  const left = deadline - nowSeconds;
  return {
    agentId: m.agentId,
    guardian: m.guardian,
    amendmentDelay: durationWords(Number(m.amendmentDelay)),
    agreementHash: m.operatingAgreementHash,
    deadlineIso: Number.isNaN(at.getTime()) ? "" : at.toISOString(),
    minutesLeft: Number.isFinite(left) ? Math.max(0, Math.floor(left / 60)) : 0,
    domain: {
      name: td.domain.name,
      version: td.domain.version,
      chainId: td.domain.chainId,
      verifyingContract: td.domain.verifyingContract,
    },
  };
}

export type LinkFieldRow = { label: string; value: string; note: string | null };

/** The minutes left in words: "59 minutes", "1 minute", "less than a minute". */
function minutesWords(minutes: number): string {
  if (minutes < 1) return L.lessThanAMinute;
  if (minutes === 1) return W.minute;
  return fillCopy(W.minutes, { n: String(minutes) });
}

/** The time left in words: minutes in the browser, where a link lives an hour; on the paste
 *  branch, whose link lives six, whole hours, rounded down, and minutes under the last hour. */
function timeLeftWords(minutes: number, branch: OwnerBranch): string {
  if (branch === "paste" && minutes >= 60) return hoursWords(Math.floor(minutes / 60));
  return minutesWords(minutes);
}

/**
 * The rows the step shows, one per field in the link's order and then the domain: the guardian is
 * "your wallet" and the agreement hash "the one you read", since the gate has already found both
 * equal to this wallet and to the agreement checked on this order. The deadline's time left is
 * said in the unit that suits the branch's link life.
 */
export function linkFieldRows(d: DecodedLink, branch: OwnerBranch = "browser"): LinkFieldRow[] {
  const deadlineAt = d.deadlineIso === "" ? null : utcMinute(Date.parse(d.deadlineIso));
  return [
    { label: L.fields.agentId, value: d.agentId, note: null },
    { label: L.fields.guardian, value: d.guardian, note: L.yourWallet },
    { label: L.fields.amendmentDelay, value: d.amendmentDelay, note: null },
    { label: L.fields.agreementHash, value: d.agreementHash, note: L.theOneYouRead },
    {
      label: L.fields.deadline,
      value: deadlineAt ?? d.deadlineIso,
      note: fillCopy(L.deadlineIn, { left: timeLeftWords(d.minutesLeft, branch) }),
    },
    {
      label: L.fields.domain,
      value: fillCopy(L.domainValue, {
        name: d.domain.name,
        version: d.domain.version,
        chainId: String(d.domain.chainId),
        contract: d.domain.verifyingContract,
      }),
      note: null,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// The identity's owner, on the browser branch
// ---------------------------------------------------------------------------------------------

/**
 * The owner the link-message door read for the identity, against the wallet in session. On the
 * browser branch the wallet in session signs the link, and only the identity's owner can: another
 * owner (the identity changed hands since it was picked) is a stop before any wallet prompt. On
 * the paste branch the owner is another key by choice, so there is nothing to match here.
 */
export function identityOwnerCheck(
  served: LinkMessageResult,
  p: { branch: OwnerBranch; sessionAddress: Address },
): { ok: true } | Refusal {
  if (p.branch !== "browser") return { ok: true };
  const owner: unknown = served?.identityOwner;
  // An answer that names no owner is not an identity that moved: a stop of its own.
  if (typeof owner !== "string") return { ok: false, problem: "no_identity_owner" };
  if (!sameAddress(owner, p.sessionAddress)) return { ok: false, problem: "identity_owner" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Which screen
// ---------------------------------------------------------------------------------------------

/**
 * What the link phase shows: the body being created (`reserved`, whichever key signed), the sign
 * screen in this browser, or the panel for a key elsewhere. A phase with no branch never opens
 * this browser's wallet.
 */
export function linkScreen(derivation: LegalBodyDerivation): "creating" | "sign" | "paste" {
  if (derivation.notice?.kind === "creating") return "creating";
  return derivation.branch === "browser" ? "sign" : "paste";
}

// ---------------------------------------------------------------------------------------------
// The link doors' answers
// ---------------------------------------------------------------------------------------------

/**
 * - `rederive`: the order as it now stands; the order is read again and the derivation decides;
 * - `unreadable`: an answer that is not this order, so nothing in it is read;
 * - `refused`: the link door's flat refusal, its sentence as served; `lapsed` once it came after
 *   the reservation, else the draft is kept;
 * - `back`: the door's house refusal sends the person to an earlier step, with its sentence;
 * - `wait`, `retry`: a limit, or nothing changed; the same click may be tried again;
 * - `new_message`: a link with a new deadline is needed;
 * - `bug`: the door could not read what this page built;
 * - `sentence`: any other house refusal, its sentence as served;
 * - `no_answer`: nothing came back from that door;
 * - `stop`: the gate refused the served link, and the wallet was not opened;
 * - `declined`: the wallet opened and did not sign;
 * - `not_connected`: the wallet in session is not connected in this browser.
 */
export type LinkStepOutcome =
  | { kind: "rederive" }
  | { kind: "unreadable" }
  | { kind: "refused"; code: string; sentence: string; lapsed: boolean }
  | { kind: "back"; to: "agreement" | "company" | "identity"; sentence: string }
  | { kind: "wait" | "retry" | "new_message" | "sentence"; sentence: string }
  | { kind: "bug" }
  | { kind: "no_answer"; door: "message" | "submit" }
  | { kind: "stop"; problem: string }
  | { kind: "declined"; walletChainId: number | undefined }
  | { kind: "not_connected" };

/** An own property only: nothing inherited is read. */
function own(v: object, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(v, key)
    ? (v as Record<string, unknown>)[key]
    : undefined;
}

/** This order, as an answer: an object with this order's id and a state. */
function isThisOrder(v: unknown, orderId: string): v is LegalBodyOrderView {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return own(v, "id") === orderId && typeof own(v, "state") === "string";
}

/**
 * The link door's answer without an error, read only when it carries this order: a 200 or a 202
 * whose body is not an order (an empty body, another order, an order with no state) is
 * `unreadable` before anything reads its state, and so is a flat refusal whose order is not this
 * one. Otherwise `linkSubmitOutcome` reads it: the order as it now stands, or the refusal.
 */
export function linkAnswerOutcome(answer: LinkSubmitAnswer, orderId: string): LinkStepOutcome {
  const carried = answer.status === 422 ? answer.body?.order : answer.body;
  if (!isThisOrder(carried, orderId)) return { kind: "unreadable" };
  const outcome = linkSubmitOutcome(answer);
  if (outcome.next === "rederive") return { kind: "rederive" };
  return { kind: "refused", code: outcome.code, sentence: outcome.sentence, lapsed: outcome.lapsed };
}

/**
 * A failed request to either link door. A refusal that means "sign in" is routed by the shell
 * before this is asked. A house refusal is routed by its code (`linkDoorRoute`, browser branch),
 * with its sentence as served; a timeout, or a failure that is not the API's, is no answer from
 * that door.
 */
export function linkErrorOutcome(e: unknown, door: "message" | "submit"): LinkStepOutcome {
  if (!(e instanceof ApiError) || e.code === TIMEOUT_CODE) return { kind: "no_answer", door };
  const sentence = e.message;
  switch (linkDoorRoute(e.code, "browser")) {
    case "agreement":
      return { kind: "back", to: "agreement", sentence };
    case "company":
      return { kind: "back", to: "company", sentence };
    case "identity":
      return { kind: "back", to: "identity", sentence };
    case "wait":
      return { kind: "wait", sentence };
    case "retry":
      return { kind: "retry", sentence };
    case "new_message":
      return { kind: "new_message", sentence };
    case "bug":
      return { kind: "bug" };
    default:
      return { kind: "sentence", sentence };
  }
}

/**
 * Where an order goes after a door said it cannot be linked any more (`back` to the agreement),
 * once it was read again. The link-message door says so of every order that is not a draft, one
 * reserved from another tab among them, so a new order is offered only while the order is still a
 * draft (its agreement outdated, or expired by the server's clock): otherwise the derivation shows
 * the order where it now is. An order that could not be read again goes by the door's table.
 */
export function afterOrderRefused(
  fresh: LegalBodyOrderView | null | undefined,
): "new_order" | "rederive" {
  return fresh && fresh.state !== "draft" ? "rederive" : "new_order";
}

// ---------------------------------------------------------------------------------------------
// The next click
// ---------------------------------------------------------------------------------------------

/** A link the gate accepted and the wallet signed, as it was served. */
export type SignedLink = { served: LinkMessageResult; signature: Hex };

/**
 * Whether the signed link is kept for "Try again" after this outcome: only when the door changed
 * nothing and the same link may be sent again as it is (a limit, nothing changed, or no answer
 * from the link door, where sending it again answers the order as it stands). After anything else
 * the link is dropped, a refused `deadline_out_of_window` and a used link among them: the next
 * click asks for a fresh one.
 */
export function keepsSignedLink(outcome: LinkStepOutcome): boolean {
  switch (outcome.kind) {
    case "wait":
    case "retry":
      return true;
    case "no_answer":
      return outcome.door === "submit";
    default:
      return false;
  }
}

export type LinkClickPlan = { kind: "fresh" } | { kind: "resubmit"; link: SignedLink };

/**
 * What one click does. "Sign" always asks for a fresh link, checks it and opens the wallet: it
 * never signs or sends an old one. "Try again" sends the kept signed link once more, without a
 * wallet prompt, while it still has the five minutes the door needs by this browser's clock;
 * otherwise, or with nothing kept, it asks for a fresh link as "Sign" does.
 */
export function linkClickPlan(p: {
  click: "sign" | "retry";
  held: SignedLink | null;
  nowSeconds: number;
}): LinkClickPlan {
  if (p.click !== "retry" || p.held === null) return { kind: "fresh" };
  // Written so that a clock or a deadline that cannot be read (NaN) asks for a fresh link.
  const left = p.held.served.deadline - p.nowSeconds;
  return left >= MIN_LINK_REMAINING_SECONDS ? { kind: "resubmit", link: p.held } : { kind: "fresh" };
}

// ---------------------------------------------------------------------------------------------
// What the step says and offers
// ---------------------------------------------------------------------------------------------

/** Where the flow goes with a door's sentence: an earlier step, or the order's closed screen. */
export type LinkSendBack = "agreement" | "company" | "identity" | "closed";

export type LinkOutcomeView = {
  /** The sentences shown, the doors' as served. */
  lines: string[];
  /** The step's button: Sign (a fresh link), Try again (the same click once more), or the way out
   *  of a lapsed order. */
  action: "sign" | "retry" | "new_order";
  /** The sentence carried to where the flow goes next, or null when it stays here. */
  sendBack: { to: LinkSendBack; sentence: string } | null;
};

function networkOf(environment: AvailableConfig["environment"]): string {
  const { networkSandbox, networkProduction } = LEGAL_BODY_COPY.pointer;
  return environment === "sandbox" ? networkSandbox : networkProduction;
}

/**
 * What the step says after an outcome, and what it offers. A lapsed order offers its way out (a
 * new order) and carries the door's sentence to its closed screen; `agent_in_flight` adds that
 * the order is kept and Sign is the retry; a limit, nothing changed, or no answer offers Try
 * again, once per click and never by itself.
 */
export function linkOutcomeView(
  outcome: LinkStepOutcome,
  config: Pick<AvailableConfig, "chainId" | "environment">,
): LinkOutcomeView {
  const say = (lines: string[], action: LinkOutcomeView["action"] = "sign"): LinkOutcomeView => ({
    lines,
    action,
    sendBack: null,
  });
  switch (outcome.kind) {
    case "rederive":
      return say([]);
    case "unreadable":
      return say([L.unreadableAnswer]);
    case "refused":
      if (outcome.lapsed)
        return {
          lines: [outcome.sentence],
          action: "new_order",
          sendBack: { to: "closed", sentence: outcome.sentence },
        };
      if (outcome.code === "agent_in_flight") return say([outcome.sentence, L.tryAgainSoon]);
      return say([outcome.sentence]);
    case "back":
      return {
        lines: [outcome.sentence],
        action: "sign",
        sendBack: { to: outcome.to, sentence: outcome.sentence },
      };
    case "wait":
    case "retry":
      return say([outcome.sentence], "retry");
    case "new_message":
    case "sentence":
      return say([outcome.sentence]);
    case "bug":
      return say([L.buildFailed]);
    case "no_answer":
      return say([outcome.door === "message" ? L.noAnswerMessage : L.noAnswerSubmit], "retry");
    case "stop":
      // The identity changed hands since it was picked: another identity, or its new owner, is
      // picked on the identity step.
      if (outcome.problem === "identity_owner")
        return {
          lines: [L.ownerMoved],
          action: "sign",
          sendBack: { to: "identity", sentence: L.ownerMoved },
        };
      // The answer named no owner: nothing says the identity moved, so it is kept.
      if (outcome.problem === "no_identity_owner") return say([L.ownerMissing]);
      return say([fillCopy(L.refused, { problem: outcome.problem })]);
    case "declined":
      return say([
        outcome.walletChainId === undefined || outcome.walletChainId === config.chainId
          ? L.declined
          : fillCopy(L.declinedOtherNetwork, { network: networkOf(config.environment) }),
      ]);
    case "not_connected":
      return say([L.notConnected]);
  }
}
