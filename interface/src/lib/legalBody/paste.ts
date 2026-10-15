/**
 * The paste branch's decisions, each pure.
 *
 * The identity is owned by another key: an agent's signer, a hardware wallet, a Circle wallet. So
 * nothing is signed or sent in this browser. The person copies the link's typed data exactly as
 * served, signs it wherever that key lives, pastes the signature back, and sends the pointer
 * transaction from that key. This page never prompts a wallet on this branch and never asks for an
 * API key.
 *
 * Here: what a pasted signature becomes (`parsePastedSignature`); the copy box's text
 * (`servedTypedDataText`) and the gate in front of it (`pasteCopyGate`: the served link is shown
 * only once every field checks out); what one click on "Send the signature" does
 * (`pasteSubmitPlan`: a problem never reaches the door); how the link doors' answers read on this
 * branch (`pasteErrorOutcome`, `pasteOutcomeView`); the pointer call to send, decoded
 * (`pointerCallText`, `pointerCallRows`), the chain checks before it is shown
 * (`pointerChecksOf`, `pastePointerState`); and the timed watch of the pointer, which only reads
 * (`pointerSeen`, `pointerWatchInterval`, `pointerWatchStatus`).
 *
 * The link step's own decisions are reused, not repeated: the request (`linkRequestFor`), the
 * fields in words (`decodeLinkFields`, `linkFieldRows`), the answers (`linkAnswerOutcome`,
 * `linkErrorOutcome`, `linkOutcomeView`). Nothing here reads a clock or sends a request.
 */
import { decodeFunctionData } from "viem";
import {
  ApiError,
  type Address,
  type Hex,
  type LegalBodyConfig,
  type LegalBodyOrderView,
  type LinkMessageResult,
  type LinkTypedDataWire,
} from "@/lib/api/types";
import { TIMEOUT_CODE } from "@/lib/api/timeout";
import {
  allowedCall,
  identityRegistryAbi,
  pointerCall,
  pointerMatchesFactory,
  POINTER_KEY,
  type CallContext,
  type Refusal,
} from "./chain";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import { linkDoorRoute } from "./doorOutcome";
import { pointerPreflight, type LegalBodyDerivation } from "./flow";
import { isRevert, type OwnerRead } from "./identity";
import {
  linkErrorOutcome,
  linkOutcomeView,
  type LinkFieldRow,
  type LinkSendBack,
  type LinkStepOutcome,
} from "./link";
import { REFRESH_RETRY_MS, REFRESH_WINDOW_MS } from "./polling";
import { MIN_LINK_REMAINING_SECONDS, assertLinkTypedData } from "./typedData";

type AvailableConfig = Extract<LegalBodyConfig, { available: true }>;

const P = LEGAL_BODY_COPY.paste;

// ---------------------------------------------------------------------------------------------
// The pasted signature
// ---------------------------------------------------------------------------------------------

/** The longest signature the link door reads, in bytes. */
export const MAX_PASTED_SIGNATURE_BYTES = 2_048;

export type SignatureProblem = "empty" | "not_hex" | "odd_length" | "too_long";

const HEX_DIGITS = /^[0-9a-f]*$/;

/**
 * What a person pasted, as the link door reads a signature: the whitespace and newlines at either
 * end trimmed, `0x` added when it is missing, in lower case, whole bytes, at most 2,048 of them.
 * `0x` alone passes, as it does at the door. Anything else is the problem to say under the field,
 * and never reaches the door.
 */
export function parsePastedSignature(raw: string): Hex | { problem: SignatureProblem } {
  const value = raw.trim().toLowerCase();
  if (value === "") return { problem: "empty" };
  const digits = value.startsWith("0x") ? value.slice(2) : value;
  if (!HEX_DIGITS.test(digits)) return { problem: "not_hex" };
  if (digits.length > 2 * MAX_PASTED_SIGNATURE_BYTES) return { problem: "too_long" };
  if (digits.length % 2 !== 0) return { problem: "odd_length" };
  return `0x${digits}`;
}

// ---------------------------------------------------------------------------------------------
// The typed data as served, behind its gate
// ---------------------------------------------------------------------------------------------

/**
 * The copy box's text: the typed data exactly as served, `EIP712Domain` included, the keys in the
 * order they came and every uint256 the decimal string it was served as. A signer that takes whole
 * typed data signs this as is.
 */
export function servedTypedDataText(td: LinkTypedDataWire): string {
  return JSON.stringify(td, null, 2);
}

/** What the link is checked against: the order, the agreement read, the wallet in session (the
 *  guardian), the identity picked, this browser's clock and the served ceiling. */
export type PasteGateContext = Parameters<typeof assertLinkTypedData>[1];

/**
 * The one way the copy box gets its text: every field of the served link checked first, as on the
 * other branch, then the text. A refusal gives no text at all, so a link the check refused has no
 * path to the copy box. The identity's owner is another key by choice here, so it is not matched
 * to the wallet in session.
 */
export function pasteCopyGate(
  served: LinkMessageResult,
  ctx: PasteGateContext,
): { ok: true; text: string } | Refusal {
  const checked = assertLinkTypedData(served, ctx);
  if (!checked.ok) return checked;
  return { ok: true, text: servedTypedDataText(served.typedData) };
}

// ---------------------------------------------------------------------------------------------
// One click on "Send the signature"
// ---------------------------------------------------------------------------------------------

export type PasteSubmitPlan =
  | { kind: "send"; signature: Hex }
  | { kind: "problem"; problem: SignatureProblem }
  | { kind: "stale" };

/**
 * What one click does with the pasted text. A link with less than the five minutes the door needs
 * left by this browser's clock is `stale`, said first since no signature of it can help: the link
 * is asked for again and the new one signed. Then the field's own problem, if any. Only a
 * signature that parsed is sent, normalised.
 */
export function pasteSubmitPlan(p: {
  served: LinkMessageResult;
  raw: string;
  nowSeconds: number;
}): PasteSubmitPlan {
  // Written so that a clock or a deadline that cannot be read (NaN) is stale.
  const left = p.served.deadline - p.nowSeconds;
  if (!(left >= MIN_LINK_REMAINING_SECONDS)) return { kind: "stale" };
  const signature = parsePastedSignature(p.raw);
  if (typeof signature !== "string") return { kind: "problem", problem: signature.problem };
  return { kind: "send", signature };
}

// ---------------------------------------------------------------------------------------------
// The doors' answers on this branch
// ---------------------------------------------------------------------------------------------

/**
 * The link step's outcomes, plus this branch's own: what was pasted, refused by the door
 * (`pasted_not_hex`, with its sentence), the field's own problem, and a link too close to its
 * deadline to send.
 */
export type PasteOutcome =
  | LinkStepOutcome
  | { kind: "pasted_not_hex"; sentence: string }
  | { kind: "problem"; problem: SignatureProblem }
  | { kind: "stale" };

/**
 * A failed request to either link door, on this branch. The door's refusal of the signature or the
 * message it reads is what was pasted (`linkDoorRoute`'s `pasted_not_hex`); everything else reads
 * as on the other branch (`linkErrorOutcome`).
 */
export function pasteErrorOutcome(e: unknown, door: "message" | "submit"): PasteOutcome {
  if (
    e instanceof ApiError &&
    e.code !== TIMEOUT_CODE &&
    linkDoorRoute(e.code, "paste") === "pasted_not_hex"
  )
    return { kind: "pasted_not_hex", sentence: e.message };
  return linkErrorOutcome(e, door);
}

export type PasteOutcomeView = {
  /** The sentences shown above the buttons, the doors' as served. */
  lines: string[];
  /** The sentence under the signature field, or null. */
  fieldError: string | null;
  /** Whether the served link (its copy box and the field with it) is dropped: the next click asks
   *  for a fresh link. */
  dropLink: boolean;
  /** Whether the way out of a lapsed order is offered instead. */
  newOrder: boolean;
  /** The sentence carried to where the flow goes next, or null when it stays here. */
  sendBack: { to: LinkSendBack; sentence: string } | null;
};

/** The flat refusals after which no signature of this link can be taken: a new link is needed. */
const FRESH_LINK_CODES: readonly string[] = ["deadline_out_of_window", "already_created"];

/**
 * Whether the served link goes. It stays whenever the same link, signed again or sent again, can
 * still be taken: a signature from the wrong key, a limit, no answer. It goes when the door says a
 * link with a new deadline is needed, when the flow leaves this step, and when the gate refused it.
 */
function dropsServedLink(outcome: PasteOutcome): boolean {
  switch (outcome.kind) {
    case "refused":
      return outcome.lapsed || FRESH_LINK_CODES.includes(outcome.code);
    case "back":
    case "new_message":
    case "stop":
    case "stale":
      return true;
    default:
      return false;
  }
}

/**
 * What the panel says after an outcome. A flat refusal keeps the draft: the door's sentence as
 * served, the link and the pasted text kept, so the owner key can sign again; only a refusal that
 * needs a new link drops it. What was pasted, refused by the field or by the door, is said under
 * the field. The rest reads as on the other branch (`linkOutcomeView`), whose way out of a lapsed
 * order and whose sentences carried back are the same here.
 */
export function pasteOutcomeView(
  outcome: PasteOutcome,
  config: Pick<AvailableConfig, "chainId" | "environment">,
): PasteOutcomeView {
  const say = (lines: string[], fieldError: string | null = null): PasteOutcomeView => ({
    lines,
    fieldError,
    dropLink: dropsServedLink(outcome),
    newOrder: false,
    sendBack: null,
  });
  switch (outcome.kind) {
    case "problem":
      return say([], P.problems[outcome.problem]);
    case "pasted_not_hex":
      return say([], outcome.sentence);
    case "stale":
      return say([P.stale]);
    case "stop":
      return say([
        outcome.problem === "ttl_above_max"
          ? P.ttlAboveMax
          : fillCopy(P.refused, { problem: outcome.problem }),
      ]);
    case "unreadable":
      return say([P.unreadableAnswer]);
    case "refused":
      if (!outcome.lapsed && outcome.code === "agent_in_flight")
        return say([outcome.sentence, P.tryAgainSoon]);
      break;
  }
  const base = linkOutcomeView(outcome, config);
  return {
    lines: base.lines,
    fieldError: null,
    dropLink: dropsServedLink(outcome),
    newOrder: base.action === "new_order",
    sendBack: base.sendBack,
  };
}

// ---------------------------------------------------------------------------------------------
// The call to send
// ---------------------------------------------------------------------------------------------

/** The pointer transaction, decoded: where it goes, the function, its three arguments, and the
 *  calldata they encode to. */
export type PointerCallText = {
  to: Address;
  signature: "setMetadata(uint256,string,bytes)";
  args: [string, "legalBody", Hex];
  calldata: Hex;
};

/**
 * The call the owner key sends, for the selected order only: `pointerCall` builds it and
 * `allowedCall`, the one allowlist, accepts it or refuses it with the first rule broken (a
 * replaced, superseded or revoked body among them). The arguments shown are decoded from the
 * calldata the allowlist returned, so what is shown is what the calldata says.
 */
export function pointerCallText(
  config: CallContext["config"],
  order: LegalBodyOrderView,
): PointerCallText | Refusal {
  const req = pointerCall(config, order);
  if ("ok" in req) return req;
  const checked = allowedCall(req, { config, order });
  if (!checked.ok) return checked;
  const decoded = decodeFunctionData({ abi: identityRegistryAbi, data: checked.data });
  if (decoded.functionName !== "setMetadata") return { ok: false, problem: "not_allowed" };
  const [agentId, key, value] = decoded.args;
  if (key !== POINTER_KEY) return { ok: false, problem: "other_key" };
  return {
    to: config.identityRegistry,
    signature: "setMetadata(uint256,string,bytes)",
    args: [agentId.toString(), POINTER_KEY, value],
    calldata: checked.data,
  };
}

/** The rows the pointer panel shows: from the owner key, to the registry, the function, its three
 *  arguments, and no native value. */
export function pointerCallRows(
  call: PointerCallText,
  p: { owner: Address; body: Address; chainId: number },
): LinkFieldRow[] {
  return [
    { label: P.rows.from, value: p.owner, note: P.notes.from },
    { label: P.rows.to, value: call.to, note: P.notes.to },
    { label: P.rows.function, value: call.signature, note: null },
    { label: P.rows.agentId, value: call.args[0], note: null },
    { label: P.rows.key, value: call.args[1], note: null },
    {
      label: P.rows.value,
      value: call.args[2],
      note: fillCopy(P.notes.value, { chainId: String(p.chainId), body: p.body }),
    },
    { label: P.rows.nativeValue, value: "0", note: P.notes.nativeValue },
  ];
}

/** Which pointer screen the phase shows: this browser's wallet only on the browser branch; a phase
 *  with no branch never opens it. */
export function pointerScreen(derivation: LegalBodyDerivation): "browser" | "paste" {
  return derivation.branch === "browser" ? "browser" : "paste";
}

// ---------------------------------------------------------------------------------------------
// The chain checks before the call is shown
// ---------------------------------------------------------------------------------------------

/** A chain read as a query holds it. */
export type ChainRead = { status: "pending" | "error" | "success"; data?: unknown; error?: unknown };

/** The three reads, each null while on its way: the factory's own encoding of the pointer for this
 *  body, the identity's owner now, and the owner the factory recorded when it created the body. */
export type PointerChecks = {
  factoryPointer: Hex | "unreadable" | null;
  ownerOf: OwnerRead | null;
  ownerAtCreation: Address | "unreadable" | null;
};

const BYTES_HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;

function hexOf(r: ChainRead): Hex | "unreadable" | null {
  if (r.status === "pending") return null;
  if (r.status === "error") return "unreadable";
  return typeof r.data === "string" && BYTES_HEX.test(r.data) ? (r.data as Hex) : "unreadable";
}

function addressOf(r: ChainRead): Address | "unreadable" | null {
  if (r.status === "pending") return null;
  if (r.status === "error") return "unreadable";
  return typeof r.data === "string" && ADDRESS.test(r.data) ? (r.data as Address) : "unreadable";
}

/** `ownerOf` reverts for an id that was never minted (or was burned): "no identity". A zero owner
 *  owns nothing either. Any other failure is unreadable. */
function ownerOfRead(r: ChainRead): OwnerRead | null {
  if (r.status === "error") return isRevert(r.error) ? "none" : "unreadable";
  const owner = addressOf(r);
  return typeof owner === "string" && ZERO_ADDRESS.test(owner) ? "none" : owner;
}

/** The three reads as the checks read them. An answer of the wrong shape is unreadable, never
 *  trusted. */
export function pointerChecksOf(reads: {
  factoryPointer: ChainRead;
  ownerOf: ChainRead;
  ownerAtCreation: ChainRead;
}): PointerChecks {
  return {
    factoryPointer: hexOf(reads.factoryPointer),
    ownerOf: ownerOfRead(reads.ownerOf),
    ownerAtCreation: addressOf(reads.ownerAtCreation),
  };
}

export type PastePointerState =
  | { kind: "refused"; problem: string }
  | { kind: "loading" }
  | { kind: "unreadable" }
  | { kind: "pointer_mismatch" }
  | { kind: "moved"; reason: "no_identity" | "identity_moved" }
  | { kind: "ready"; call: PointerCallText; owner: Address };

/**
 * Whether the pointer panel shows the call. A call the allowlist refused is a stop before any read
 * counts. Then the three reads, all answered: the 96 bytes must equal what the factory encodes for
 * this body (a mismatch is a stop, not a call to send), and the identity's owner now and at the
 * body's creation must both be the owner the order recorded (`pointerPreflight` on this branch,
 * where the connected wallet does not matter). Otherwise the identity changed hands and a new link
 * from its current owner is needed.
 */
export function pastePointerState(p: {
  call: PointerCallText | Refusal;
  identityOwner: Address | null;
  checks: PointerChecks;
}): PastePointerState {
  const { call, checks } = p;
  if ("ok" in call) return { kind: "refused", problem: call.problem };
  if (p.identityOwner === null) return { kind: "refused", problem: "no_identity_owner" };
  const { factoryPointer, ownerOf, ownerAtCreation } = checks;
  if (factoryPointer === null || ownerOf === null || ownerAtCreation === null)
    return { kind: "loading" };
  if (factoryPointer === "unreadable" || ownerOf === "unreadable" || ownerAtCreation === "unreadable")
    return { kind: "unreadable" };
  if (!pointerMatchesFactory(call.args[2], factoryPointer)) return { kind: "pointer_mismatch" };
  const preflight = pointerPreflight({
    branch: "paste",
    connected: null,
    identityOwner: p.identityOwner,
    ownerOf,
    ownerAtCreation,
  });
  if (!preflight.ok)
    return {
      kind: "moved",
      reason: preflight.reason === "no_identity" ? "no_identity" : "identity_moved",
    };
  return { kind: "ready", call, owner: p.identityOwner };
}

// ---------------------------------------------------------------------------------------------
// The timed watch of the pointer: reads only
// ---------------------------------------------------------------------------------------------

/** The pointer is read every 30 seconds... */
export const POINTER_WATCH_MS = REFRESH_RETRY_MS;
/** ...for two minutes from when the call is shown. */
export const POINTER_WATCH_WINDOW_MS = REFRESH_WINDOW_MS;

/** Whether `getMetadata(agentId, "legalBody")` reads as this body's pointer. */
export function pointerSeen(read: unknown, expected: Hex): boolean {
  return typeof read === "string" && read.toLowerCase() === expected.toLowerCase();
}

/**
 * When the watch reads the pointer next: every 30 s for two minutes from when the call was shown,
 * and never once "I sent it" was clicked or the pointer is seen. A read, never a write: the one
 * refresh that follows is a click's.
 */
export function pointerWatchInterval(p: {
  startedAtMs: number;
  nowMs: number;
  sent: boolean;
  seen: boolean;
}): number | false {
  if (p.sent || p.seen) return false;
  // Written so that a clock that cannot be read (NaN) stops the watch.
  return p.nowMs - p.startedAtMs < POINTER_WATCH_WINDOW_MS ? POINTER_WATCH_MS : false;
}

/**
 * What the watch says, from its own reads: the pointer seen; or the two minutes of reads over; or
 * still reading. `lastReadAtMs` is when the latest read answered (0 before the first).
 */
export function pointerWatchStatus(p: {
  startedAtMs: number;
  lastReadAtMs: number;
  seen: boolean;
}): "watching" | "seen" | "ended" {
  if (p.seen) return "seen";
  return p.lastReadAtMs - p.startedAtMs >= POINTER_WATCH_WINDOW_MS ? "ended" : "watching";
}

/** A refresh that failed: the door's sentence as served, or no answer. */
export function refreshErrorLine(e: unknown): string {
  return e instanceof ApiError && e.code !== TIMEOUT_CODE ? e.message : P.refreshNoAnswer;
}
