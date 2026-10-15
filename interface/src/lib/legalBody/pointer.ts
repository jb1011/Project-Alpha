/**
 * The browser branch's pointer step, its decisions each pure.
 *
 * The connected wallet owns the identity, so it writes ONE transaction: the pointer from its
 * identity to the legal body just created, `setMetadata(agentId, "legalBody", pointer)` on the
 * identity registry. Before the button is offered, in this order: the binding is read and asks for
 * a pointer; the allowlist accepts the call for this order (`pointerCallText`, shared with the
 * paste branch); the 96 bytes equal what the factory encodes for this body, read from the chain
 * (a mismatch is a stop); and the identity's owner now and at the body's creation are the owner the
 * order recorded, and the wallet connected here (`pointerPreflight`).
 *
 * Here: the sentence of what the wallet will write (`pointerSentence`); the gas line, in Arc's
 * native unit with its 18 decimals (`gasEstimateWei`, `gasLine`, `gasLines`); which screen the step
 * shows (`pointerStepState`, `browserPointerChecks`, `browserPointerScreen`) and its sentences; a
 * send that did not go through (`pointerFailureLines`, `pointerRefusalSentence`); the receipt
 * (`pointerTxStage`, `pointerTxView`, `sendOffered`); the refresh's answers (`refreshAnswer`,
 * `chainUnreadLine`, `bindingSettled`) and the reads after the refresh plan ends
 * (`bindingWatchDelayMs`); and the gas seed (`seedOffered`, `gasSeedAnswer`, `gasSeedSuccess`).
 *
 * Nothing here reads a chain, a clock or the network, or opens a wallet: the answers come in as
 * values, so every decision has a test and the screen only calls these.
 */
import {
  ApiError,
  type Address,
  type BindingState,
  type BindingView,
  type BrokenReason,
  type Hex,
  type LegalBodyOrderView,
  type PointerIntent,
} from "@/lib/api/types";
import { TIMEOUT_CODE } from "@/lib/api/timeout";
import { formatNative, pointerMatchesFactory, type Refusal } from "./chain";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import { gasSeedOutcome } from "./doorOutcome";
import { pointerPreflight, sameAddress, type PointerPreflight } from "./flow";
import {
  REGISTER_RECEIPT_TIMEOUT_MS,
  networkName,
  noGasLine,
  type RegisterSendFailure,
} from "./identity";
import { noticeSentence } from "./notice";
import { refreshErrorLine, type PointerCallText, type PointerChecks } from "./paste";
import { REFRESH_RETRY_MS } from "./polling";

const PT = LEGAL_BODY_COPY.pointer;
const P = LEGAL_BODY_COPY.paste;

type Environment = "sandbox" | "production";

// ---------------------------------------------------------------------------------------------
// The sentence
// ---------------------------------------------------------------------------------------------

/** What the wallet will write, from the binding's intent: the identity, the body, the network, and
 *  that it is the only transaction and approves nothing. */
export function pointerSentence(intent: PointerIntent, environment: Environment): string {
  return fillCopy(PT.sentence, {
    agentId: intent.agentId,
    body: intent.body,
    network: networkName(environment),
  });
}

/**
 * Whether the intent says what the call writes: the same identity, the same body, on the order's
 * chain. The sentence is built from the intent and the call from the order, so a disagreement
 * would make the sentence describe another transaction: it is refused instead.
 */
export function intentMatchesCall(
  intent: PointerIntent,
  call: PointerCallText,
  order: Pick<LegalBodyOrderView, "chainId" | "bodyAddress">,
): boolean {
  return (
    intent.action === "setLegalBodyPointer" &&
    intent.agentId === call.args[0] &&
    intent.chainId === order.chainId &&
    sameAddress(intent.body, order.bodyAddress)
  );
}

// ---------------------------------------------------------------------------------------------
// The gas line
// ---------------------------------------------------------------------------------------------

/** The native amount the transaction may cost: the gas the chain estimates for it times the fee
 *  per gas a wallet offers at most. Either read missing gives no estimate. */
export function gasEstimateWei(p: {
  gas: bigint | null | undefined;
  maxFeePerGas: bigint | null | undefined;
}): bigint | null {
  if (typeof p.gas !== "bigint" || typeof p.maxFeePerGas !== "bigint") return null;
  return p.gas * p.maxFeePerGas;
}

/**
 * The estimate and the wallet's balance as amounts of USDC, with Arc's 18 decimals (`formatNative`),
 * and whether the balance covers the estimate. What is not known is null, and so is `enough`
 * unless both are known.
 */
export function gasLine(p: { estimateWei: bigint | null; balanceWei: bigint | null }): {
  amount: string | null;
  balance: string | null;
  enough: boolean | null;
} {
  const { estimateWei, balanceWei } = p;
  return {
    amount: estimateWei === null ? null : formatNative(estimateWei),
    balance: balanceWei === null ? null : formatNative(balanceWei),
    enough: estimateWei === null || balanceWei === null ? null : balanceWei >= estimateWei,
  };
}

/**
 * Whether the pointer button is held back for gas: only when the balance is KNOWN to be below the
 * estimate. A balance or an estimate that could not be read keeps it offered, since the wallet
 * shows its own estimate when it opens. The gas line says what is short and where the native USDC
 * comes from (`gasLines`).
 */
export function gasBlocksSend(line: { enough: boolean | null }): boolean {
  return line.enough === false;
}

/**
 * The gas line's sentences: the estimate (or that it is on its way, or could not be made), the
 * balance, a balance below the estimate said in amber, and where the native USDC comes from. A
 * wallet that cannot be estimated still opens with its own estimate, so none of these is a stop.
 */
export function gasLines(p: {
  line: ReturnType<typeof gasLine>;
  estimating: boolean;
  environment: Environment;
}): { lines: string[]; tone: "info" | "warn" } {
  const { line } = p;
  const lines: string[] = [];
  if (line.amount !== null) lines.push(fillCopy(PT.gasEstimate, { amount: line.amount }));
  else lines.push(p.estimating ? PT.gasEstimating : PT.gasUnread);
  if (line.balance !== null) lines.push(fillCopy(PT.gasBalance, { balance: line.balance }));
  if (line.enough === false) lines.push(PT.notEnough);
  lines.push(p.environment === "sandbox" ? PT.gas : PT.gasProduction);
  return { lines, tone: line.enough === false ? "warn" : "info" };
}

// ---------------------------------------------------------------------------------------------
// Which screen
// ---------------------------------------------------------------------------------------------

export type PointerStepState = "loading" | "no_intent" | "preflight_refused" | "pointer_mismatch" | "ready";

/**
 * The step's state from the binding and the two chain checks, in the order they run: the binding
 * read and its intent; the pointer against the factory's own encoding (a mismatch is a stop, said
 * before the owners); then the owners (`pointerPreflight`). A check not answered yet waits, even
 * when a later one has already refused: the order of the checks is the order of the sentences.
 */
export function pointerStepState(p: {
  binding: BindingView | null;
  preflight: PointerPreflight | null;
  pointerOk: boolean | null;
}): PointerStepState {
  if (p.binding === null) return "loading";
  if (p.binding.intent === null) return "no_intent";
  if (p.pointerOk === null) return "loading";
  if (!p.pointerOk) return "pointer_mismatch";
  if (p.preflight === null) return "loading";
  if (!p.preflight.ok) return "preflight_refused";
  return "ready";
}

/**
 * The three reads as this branch reads them: whether any failed (unreadable, with a Try again);
 * the 96 bytes against the factory's encoding (null until it answers); and the preflight over the
 * two owner reads and the wallet connected here (null until both answer).
 */
export function browserPointerChecks(p: {
  call: PointerCallText;
  identityOwner: Address;
  connected: Address | null;
  checks: PointerChecks;
}): { unreadable: boolean; pointerOk: boolean | null; preflight: PointerPreflight | null } {
  const { factoryPointer, ownerOf, ownerAtCreation } = p.checks;
  const unreadable =
    factoryPointer === "unreadable" || ownerOf === "unreadable" || ownerAtCreation === "unreadable";
  const pointerOk =
    factoryPointer === null || factoryPointer === "unreadable"
      ? null
      : pointerMatchesFactory(p.call.args[2], factoryPointer);
  const preflight =
    ownerOf === null || ownerOf === "unreadable" || ownerAtCreation === null || ownerAtCreation === "unreadable"
      ? null
      : pointerPreflight({
          branch: "browser",
          connected: p.connected,
          identityOwner: p.identityOwner,
          ownerOf,
          ownerAtCreation,
        });
  return { unreadable, pointerOk, preflight };
}

export type BrowserPointerScreen =
  | { kind: "loading" }
  | { kind: "binding_unreadable" }
  | { kind: "no_intent"; title: string; body: string }
  | { kind: "refused"; problem: string }
  | { kind: "unreadable" }
  | { kind: "pointer_mismatch" }
  | { kind: "preflight_refused"; reason: Exclude<PointerPreflight, { ok: true }>["reason"] }
  | { kind: "ready"; intent: PointerIntent; call: PointerCallText; owner: Address };

/**
 * What the step shows, in the order of the checks: the binding (on its way, unreadable, or asking
 * for no pointer: winding down or dissolved, with the notice's words); the allowlist, which
 * refuses a revoked, replaced or superseded body before any read counts; an intent that does not
 * say what the call writes; a factory encoding already known not to match; a chain read that
 * failed; then `pointerStepState` over the factory's encoding and the owners. Only `ready` carries
 * a call, so only `ready` offers the button.
 */
export function browserPointerScreen(p: {
  binding: BindingView | null;
  /** The binding read failed; a binding read earlier is still used. */
  bindingFailed: boolean;
  order: LegalBodyOrderView;
  call: PointerCallText | Refusal;
  connected: Address | null;
  checks: PointerChecks;
  environment: Environment;
}): BrowserPointerScreen {
  const { binding, order, call } = p;
  if (binding === null) return { kind: p.bindingFailed ? "binding_unreadable" : "loading" };
  const intent = binding.intent;
  if (intent === null) {
    const sentence = noIntentSentence(binding.brokenReason ?? order.brokenReason, p.environment);
    return { kind: "no_intent", ...sentence };
  }
  if ("ok" in call) return { kind: "refused", problem: call.problem };
  const owner = order.identityOwner;
  if (owner === null) return { kind: "refused", problem: "no_identity_owner" };
  if (!intentMatchesCall(intent, call, order)) return { kind: "refused", problem: "intent_mismatch" };
  const checks = browserPointerChecks({ call, identityOwner: owner, connected: p.connected, checks: p.checks });
  // A mismatch already known is said first, as the order of the checks has it, even beside a read
  // that failed.
  if (checks.pointerOk === false) return { kind: "pointer_mismatch" };
  if (checks.unreadable) return { kind: "unreadable" };
  const state = pointerStepState({ binding, preflight: checks.preflight, pointerOk: checks.pointerOk });
  switch (state) {
    case "ready":
      return { kind: "ready", intent, call, owner };
    case "pointer_mismatch":
      return { kind: "pointer_mismatch" };
    case "preflight_refused":
      // `pointerStepState` says refused only for a preflight that answered with a reason.
      return checks.preflight !== null && !checks.preflight.ok
        ? { kind: "preflight_refused", reason: checks.preflight.reason }
        : { kind: "loading" };
    default:
      return { kind: "loading" };
  }
}

/** Why no pointer is asked for: the body winds down or is dissolved, in the notices' words, or
 *  the binding asks for none just now. */
export function noIntentSentence(
  brokenReason: BrokenReason | null,
  environment: Environment,
): { title: string; body: string } {
  if (brokenReason === "winding_down" || brokenReason === "dissolved") {
    const { title, body } = noticeSentence({ kind: brokenReason }, environment);
    return { title, body };
  }
  return { title: PT.noIntent.title, body: PT.noIntent.body };
}

/** The sentence for a refused preflight: no identity with this id, an identity that changed hands
 *  since the link, or an owner that is not the wallet connected here. */
export function preflightSentence(
  reason: Exclude<PointerPreflight, { ok: true }>["reason"],
  p: { agentId: string; owner: Address },
): string {
  switch (reason) {
    case "no_identity":
      return fillCopy(P.noIdentity, { agentId: p.agentId });
    case "identity_moved":
      return PT.identityMoved;
    case "not_this_wallet":
      return fillCopy(PT.notThisWallet, { agentId: p.agentId, owner: p.owner });
  }
}

// ---------------------------------------------------------------------------------------------
// A send that did not go through
// ---------------------------------------------------------------------------------------------

/** A failed send (`registerSendFailure` reads why): the wallet's no, with its words when it gave
 *  any; too little gas, where the native USDC comes from; anything else is a wallet that can sign
 *  but cannot send, the plain sentence. */
export function pointerFailureLines(f: RegisterSendFailure, environment: Environment): string[] {
  if (f.kind === "rejected")
    return [f.message === null ? PT.rejectedNoWords : fillCopy(PT.rejected, { message: f.message })];
  if (f.kind === "no_gas") return [noGasLine(environment)];
  return [PT.cannotSend];
}

/** The sentence for a request the allowlist or the chain check refused before the wallet opened. */
export function pointerRefusalSentence(problem: string, environment: Environment): string {
  const network = networkName(environment);
  if (problem === "wallet_on_another_chain") return fillCopy(PT.otherNetwork, { network });
  if (problem === "chain_not_configured") return fillCopy(PT.otherChain, { network });
  return fillCopy(PT.refusedBeforeWallet, { problem });
}

// ---------------------------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------------------------

/** How long the step waits for the pointer transaction's receipt: as long as for a registration. */
export const POINTER_RECEIPT_TIMEOUT_MS = REGISTER_RECEIPT_TIMEOUT_MS;

export type PointerTxStage = "waiting" | "confirmed" | "reverted" | "no_receipt";

/** The receipt, or null when none came back in time: confirmed only on `success`, reverted only on
 *  `reverted`; anything else is not known yet. */
export function pointerTxStage(receipt: { status?: string } | null): Exclude<PointerTxStage, "waiting"> {
  if (receipt === null) return "no_receipt";
  if (receipt.status === "success") return "confirmed";
  if (receipt.status === "reverted") return "reverted";
  return "no_receipt";
}

/** The sentence of a stage; amber when the pointer did not land, or may not have. */
export function pointerTxView(stage: PointerTxStage): { text: string; tone: "info" | "warn" } {
  switch (stage) {
    case "waiting":
      return { text: PT.waiting, tone: "info" };
    case "confirmed":
      return { text: PT.confirmed, tone: "info" };
    case "reverted":
      return { text: PT.reverted, tone: "warn" };
    case "no_receipt":
      return { text: PT.noReceipt, tone: "warn" };
  }
}

/**
 * Whether the button is offered: before a send, after one that failed on the chain, and after one
 * whose receipt never came once the checks have stopped with the body still not linked (the
 * transaction may have been dropped). Not while one waits, once one is confirmed, or while one
 * whose receipt never came is still being checked.
 */
export function sendOffered(stage: PointerTxStage | null, checking: boolean): boolean {
  if (stage === "no_receipt") return !checking;
  return stage === null || stage === "reverted";
}

// ---------------------------------------------------------------------------------------------
// The refresh, and the reads after it
// ---------------------------------------------------------------------------------------------

/**
 * A refresh that failed. A 503 `chain_unavailable` moved nothing on the server: the stored binding
 * stays on screen with "could not read the chain just now", and the plan goes on. Anything else is
 * the door's sentence as served, or no answer.
 */
export function refreshAnswer(e: unknown): { kind: "chain_unavailable" } | { kind: "line"; line: string } {
  if (e instanceof ApiError && e.code === "chain_unavailable") return { kind: "chain_unavailable" };
  return { kind: "line", line: refreshErrorLine(e) };
}

/** The line beside the stored binding when the chain could not be read. */
export function chainUnreadLine(state: BindingState): string {
  return fillCopy(PT.chainUnreadLine, { reason: PT.chainUnread, state });
}

/** Whether a binding state no longer waits for the pointer: `linked`, or anything but `deployed`
 *  and `broken`. The order is read again then, and the flow decides where it stands. */
export function bindingSettled(state: BindingState | null): boolean {
  return state !== null && state !== "deployed" && state !== "broken";
}

/** The longest wait between two reads of the binding after the refresh plan ends. */
export const BINDING_WATCH_MAX_MS = 300_000;

/**
 * When the binding is read next after the refresh plan ended without `linked`: 30 seconds after
 * the end, then twice as long each time, at most 5 minutes. Reads only, so "we keep checking"
 * stays true while the page is open; never a refresh.
 */
export function bindingWatchDelayMs(readsDone: number): number {
  if (!(readsDone >= 0)) return REFRESH_RETRY_MS;
  return Math.min(REFRESH_RETRY_MS * 2 ** Math.min(readsDone, 16), BINDING_WATCH_MAX_MS);
}

// ---------------------------------------------------------------------------------------------
// The gas seed
// ---------------------------------------------------------------------------------------------

/** The seed button: only where the deployment offers it, not once the balance is known to cover
 *  the estimate, and not after an answer that asking again cannot change. */
export function seedOffered(p: { gasSeedOffered: boolean; enough: boolean | null; final: boolean }): boolean {
  return p.gasSeedOffered && !p.final && p.enough !== true;
}

/** A seed request that failed: the door's sentence as served, and whether the button goes
 *  (`gasSeedOutcome`); no answer leaves the button. */
export function gasSeedAnswer(e: unknown): { line: string; final: boolean } {
  if (e instanceof ApiError && e.code !== TIMEOUT_CODE)
    return { line: e.message, final: gasSeedOutcome(e.code).final };
  return { line: PT.seedNoAnswer, final: false };
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** A sent seed: the sentence, and its transaction when the answer names one in the right shape. */
export function gasSeedSuccess(answer: unknown): { line: string; hash: Hex | null } {
  const hash =
    typeof answer === "object" && answer !== null ? (answer as { txHash?: unknown }).txHash : undefined;
  return { line: PT.seedSent, hash: typeof hash === "string" && TX_HASH.test(hash) ? (hash as Hex) : null };
}
