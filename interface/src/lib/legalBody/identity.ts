/**
 * The identity step's decisions: which on-chain identity the legal body will stand behind, and
 * who owns it.
 *
 * Three ways in. The identity this wallet owns; a new identity this wallet registers with one
 * `register` transaction; or an identity another key owns, which signs elsewhere. For the first
 * and the third, the chain says who owns the id (`ownerOf`, read through the public client with
 * the pinned ABI), and `identityCardOutcome` decides from that and from the tenant's orders. An id
 * that was never minted makes `ownerOf` revert: that revert means "no identity with this id",
 * never an error, while a read that failed for any other reason means "not known yet".
 *
 * Nothing here reads a chain or opens a wallet: the answers come in as values, so every decision
 * has a test, and the screen only calls these.
 */
import { maxUint256 } from "viem";
import type { Address, LegalBodyOrderView } from "@/lib/api/types";
import { agentIdFromMint } from "./chain";
import { LEGAL_BODY_COPY, fillCopy } from "./copy";
import { identityHasBody, sameAddress, type LegalBodyDerivation } from "./flow";
import { noticeSentence } from "./notice";
import type { OwnerChoice } from "./storage";

const I = LEGAL_BODY_COPY.identity;

type Environment = "sandbox" | "production";

/** The network's name, as the pointer sentence says it. */
export function networkName(environment: Environment): string {
  const { networkSandbox, networkProduction } = LEGAL_BODY_COPY.pointer;
  return environment === "sandbox" ? networkSandbox : networkProduction;
}

// ---------------------------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------------------------

/** A uint256 in canonical decimal: no sign, no leading zero, at most 78 digits. */
const CANONICAL_DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;

/** The agent id as the registry serves it: the trimmed input in canonical decimal, at most
 *  2^256 - 1; anything else is null. */
export function parseAgentId(input: string): string | null {
  const value = input.trim();
  if (!CANONICAL_DECIMAL.test(value)) return null;
  return BigInt(value) <= maxUint256 ? value : null;
}

/** The longest agent URI this page sends. */
const MAX_URI_LENGTH = 2048;
/** A space anywhere, or a control, format (zero-width, direction override), surrogate,
 *  private-use or unassigned character. A URL parser would drop a tab or a newline without a
 *  word, so they are refused here instead. */
const SPACE_OR_INVISIBLE = /[\s\p{C}]/u;

/**
 * The optional agent URI: null for none (empty or spaces only), the trimmed value for an https
 * address of at most 2,048 characters, or the problem to show under the field.
 */
export function parseAgentUri(input: string): string | null | { problem: string } {
  const value = input.trim();
  if (value === "") return null;
  if ([...value].length > MAX_URI_LENGTH) return { problem: I.uriProblems.length };
  if (SPACE_OR_INVISIBLE.test(value)) return { problem: I.uriProblems.characters };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: I.uriProblems.https };
  }
  if (url.protocol !== "https:" || url.hostname === "") return { problem: I.uriProblems.https };
  return value;
}

// ---------------------------------------------------------------------------------------------
// Which identity a card lands on
// ---------------------------------------------------------------------------------------------

/** The two cards that name an existing identity: this wallet's, or another key's. */
export type IdentityCard = "this-wallet" | "elsewhere";

export type IdentityCardOutcome =
  | { kind: "this_wallet" }
  | { kind: "elsewhere"; owner: Address }
  | { kind: "no_identity" }
  | { kind: "taken" }
  | { kind: "other_chain" };

/**
 * Where a card lands once the chain has said who owns the id, in this order:
 *  1. an identity that already has a body for this tenant on this deployment is taken, whatever
 *     the chain says (replacing a body is not offered);
 *  2. a reverted `ownerOf` is no identity;
 *  3. owned by the connected wallet: this wallet's;
 *  4. owned by any other key: elsewhere, with that owner.
 * The facts decide, not the card: the card is what the person expected, and the screen words the
 * answer for it (`cardOutcomeView`). `other_chain` is `identityChainOutcome`'s, before any read.
 */
export function identityCardOutcome(p: {
  card: IdentityCard;
  agentId: string;
  ownerOf: Address | "none";
  connected: Address;
  orders: LegalBodyOrderView[];
  where: { chainId: number; factory: Address };
}): IdentityCardOutcome {
  if (identityHasBody(p.orders, p.agentId, p.where)) return { kind: "taken" };
  if (p.ownerOf === "none") return { kind: "no_identity" };
  if (sameAddress(p.ownerOf, p.connected)) return { kind: "this_wallet" };
  return { kind: "elsewhere", owner: p.ownerOf };
}

/** A deployment whose chain this site does not read: no identity can be read or registered
 *  here, so the step says so before any read or wallet request. */
export function identityChainOutcome(
  chainId: number,
  siteChainIds: readonly number[],
): { kind: "other_chain" } | null {
  return siteChainIds.includes(chainId) ? null : { kind: "other_chain" };
}

/** What the person reads for an outcome, and what a pick writes to the memory. */
export type CardOutcomeView = {
  tone: "warn" | "info";
  title: string | null;
  text: string;
  /** The memory a pick writes, when the outcome can be picked. */
  pick: { ownerChoice: OwnerChoice; agentId: string } | null;
  /** Picked at once, without a second click: this wallet's identity on this wallet's card. */
  auto: boolean;
  /** This wallet's card found another key's identity: the third card is offered. */
  toThirdCard: boolean;
};

/**
 * The words for a card's outcome. This wallet's identity is picked as this wallet's from either
 * card (the server derives the same branch once the link is signed); another key's identity is
 * picked only from the third card, after its owner is shown, and this wallet's card points there.
 */
export function cardOutcomeView(p: {
  card: IdentityCard;
  agentId: string;
  outcome: IdentityCardOutcome;
  environment: Environment;
}): CardOutcomeView {
  const { card, agentId, outcome, environment } = p;
  const none = { title: null, pick: null, auto: false, toThirdCard: false };
  switch (outcome.kind) {
    case "taken": {
      const n = noticeSentence({ kind: "identity_taken", agentId }, environment);
      return { ...none, tone: "warn", title: n.title, text: n.body };
    }
    case "no_identity":
      return {
        ...none,
        tone: "warn",
        text: fillCopy(I.noIdentity, { agentId, network: networkName(environment) }),
      };
    case "other_chain":
      return { ...none, tone: "warn", text: fillCopy(I.otherChain, { network: networkName(environment) }) };
    case "this_wallet":
      return {
        ...none,
        tone: "info",
        text: fillCopy(I.ownedHere, { agentId }),
        pick: { ownerChoice: "this-wallet", agentId },
        auto: card === "this-wallet",
      };
    case "elsewhere":
      return card === "this-wallet"
        ? {
            ...none,
            tone: "warn",
            text: fillCopy(I.notThisWallet, { agentId, owner: outcome.owner }),
            toThirdCard: true,
          }
        : {
            ...none,
            tone: "info",
            text: fillCopy(I.ownedElsewhere, { agentId, owner: outcome.owner }),
            pick: { ownerChoice: "elsewhere", agentId },
          };
  }
}

/** The identity the derivation refused because it already has a body: the screen keeps the
 *  refusal on screen and the memory forgets the identity, so the person picks another. */
export function takenAgentIdOf(derivation: LegalBodyDerivation): string | null {
  return derivation.notice?.kind === "identity_taken" ? derivation.notice.agentId : null;
}

// ---------------------------------------------------------------------------------------------
// Reading the owner
// ---------------------------------------------------------------------------------------------

/** Each error of a cause chain, the first one included; a chain that loops ends. */
function causesOf(e: unknown): unknown[] {
  const chain: unknown[] = [];
  let at: unknown = e;
  while (at !== null && at !== undefined && chain.length < 12 && !chain.includes(at)) {
    chain.push(at);
    at = typeof at === "object" ? (at as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

function field(e: unknown, key: string): unknown {
  return typeof e === "object" && e !== null ? (e as Record<string, unknown>)[key] : undefined;
}

/** JSON-RPC's internal error, which viem reads as a revert whenever it carries a message. */
const INTERNAL_ERROR = -32603;
const REVERTED = /revert/i;

/**
 * Whether a failed read means the call reverted on chain. viem names a revert
 * `ContractFunctionRevertedError`; it also gives that name to an RPC's internal error that carries
 * any message, and a node that is only unwell answers that way too, so an internal error counts
 * only when its own words say it reverted. Anything else (a network failure, a timeout, no
 * contract at the address) is not a revert.
 */
export function isRevert(e: unknown): boolean {
  const chain = causesOf(e);
  if (!chain.some((x) => field(x, "name") === "ContractFunctionRevertedError")) return false;
  const internal = chain.find((x) => field(x, "code") === INTERNAL_ERROR);
  if (internal === undefined) return true;
  const details = field(internal, "details");
  const words = typeof details === "string" ? details : field(internal, "message");
  return typeof words === "string" && REVERTED.test(words);
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/;

/** `ownerOf(agentId)`: the owner; "none" when the call reverted (or named the zero address, which
 *  owns nothing); "unreadable" when the chain could not be read. */
export type OwnerRead = Address | "none" | "unreadable";

/** One read of the owner, through `read` (the public client's `readContract`). */
export async function readOwnerOf(read: () => Promise<unknown>): Promise<OwnerRead> {
  let owner: unknown;
  try {
    owner = await read();
  } catch (e) {
    return isRevert(e) ? "none" : "unreadable";
  }
  if (typeof owner !== "string" || !ADDRESS.test(owner)) return "unreadable";
  return ZERO_ADDRESS.test(owner) ? "none" : (owner as Address);
}

// ---------------------------------------------------------------------------------------------
// Registering a new identity
// ---------------------------------------------------------------------------------------------

/** How long the step waits for the register transaction's receipt. */
export const REGISTER_RECEIPT_TIMEOUT_MS = 180_000;

export type RegisterReceiptOutcome =
  | { kind: "registered"; agentId: string }
  | { kind: "reverted" }
  | { kind: "unreadable" };

/** The receipt of the register transaction: the id minted to this wallet, a transaction that
 *  failed on chain, or a receipt that names no id the page can trust (`agentIdFromMint`). */
export function registerReceiptOutcome(
  receipt: { status?: string; logs: readonly { address: string; topics: readonly string[] }[] },
  ctx: { registry: Address; owner: Address },
): RegisterReceiptOutcome {
  if (receipt.status === "reverted") return { kind: "reverted" };
  const agentId = agentIdFromMint(receipt, ctx);
  return agentId === null ? { kind: "unreadable" } : { kind: "registered", agentId };
}

/** The stages after the transaction was sent that leave the person on this step. */
export type RegistrationStage = "waiting" | "unreadable" | "no_receipt" | "reverted";

/** The sentence of a stage, and whether the person may enter the agent id by hand (the
 *  transaction's link is shown with every stage). */
export function registrationView(stage: RegistrationStage): {
  text: string;
  tone: "warn" | "info";
  manualEntry: boolean;
} {
  switch (stage) {
    case "waiting":
      return { text: I.waiting, tone: "info", manualEntry: false };
    case "unreadable":
      return { text: I.receiptUnreadable, tone: "warn", manualEntry: true };
    case "no_receipt":
      return { text: I.noReceipt, tone: "warn", manualEntry: true };
    case "reverted":
      return { text: I.reverted, tone: "warn", manualEntry: false };
  }
}

/** EIP-1193's "the user rejected the request". */
const USER_REJECTED = 4001;
const MAX_WALLET_WORDS = 200;

export type RegisterSendFailure = { kind: "rejected"; message: string | null } | { kind: "cannot_send" };

/** A wallet's words, as one short line: the first line, its spaces squeezed, cut at 200. */
function shortLine(words: unknown): string | null {
  if (typeof words !== "string") return null;
  const line = (words.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  return line === "" ? null : line.slice(0, MAX_WALLET_WORDS);
}

/**
 * Why the send threw: the wallet said no (EIP-1193 4001, or viem's `UserRejectedRequestError`),
 * with its own words when it gave any; or anything else, which this step reads as a wallet that
 * can sign but cannot send. The deepest rejection in the chain is the wallet's own; a viem error
 * speaks through its short message, never its long one.
 */
export function registerSendFailure(e: unknown): RegisterSendFailure {
  const rejections = causesOf(e).filter(
    (x) => field(x, "code") === USER_REJECTED || field(x, "name") === "UserRejectedRequestError",
  );
  if (rejections.length === 0) return { kind: "cannot_send" };
  for (const x of rejections.reverse()) {
    const short = field(x, "shortMessage");
    const words = shortLine(typeof short === "string" ? short : field(x, "message"));
    if (words !== null) return { kind: "rejected", message: words };
  }
  return { kind: "rejected", message: null };
}

/** The lines for a failed send: the wallet's no with its message; otherwise the plain sentence
 *  that the wallet cannot send on Arc, and the way on. */
export function registerFailureLines(f: RegisterSendFailure): string[] {
  if (f.kind === "rejected")
    return [f.message === null ? I.rejectedNoWords : fillCopy(I.rejected, { message: f.message })];
  return [LEGAL_BODY_COPY.pointer.cannotSend, I.cannotSendWayOut];
}

/** The sentence for a request the allowlist or the chain check refused before the wallet opened. */
export function registerRefusalSentence(problem: string, environment: Environment): string {
  const network = networkName(environment);
  if (problem === "wallet_on_another_chain") return fillCopy(I.otherNetwork, { network });
  if (problem === "chain_not_configured") return fillCopy(I.otherChain, { network });
  return fillCopy(I.refusedBeforeWallet, { problem });
}
