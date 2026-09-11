import type { AgentBookStatusView } from "@/lib/api/types";

/**
 * What the AgentBook chip is allowed to say — the claims ceiling (design 2026-08-25 v3 §5.4, D9)
 * expressed once, as a pure function, so the dashboard and the vouch dialog cannot drift apart.
 *
 * The ceiling exists because every one of these labels is a statement about a real person. The
 * only permitted positive claim is "a World ID verified human has vouched for this agent's payment
 * address in AgentBook" — not that the guardian vouched, not that anything is proven about who
 * controls the address, and never the word "human-backed" on a chip. Nothing here is green: a
 * public registry entry is a fact to link to, not a badge to award.
 *
 * The order the answers are read in is the other half of the ceiling (§5.2). Our row comes first
 * in exactly ONE state — `submitted` — because a signed and broadcast transaction makes the chain's
 * "no entry" a timing artefact, and rendering that as "Not in AgentBook" tells someone a permanent,
 * public statement about them did not happen at the one moment they cannot check for themselves.
 * Everywhere else the chain outranks the row, in both directions: a `pending` row has not been
 * submitted at all, and a `failed` one is history the registry may already have overtaken.
 */

/** World Chain's public explorer. Vouches live on World Chain whatever chain the agent itself
 *  runs on, so this is deliberately not the agent's chain explorer. */
export const WORLDCHAIN_EXPLORER_URL = "https://worldscan.org";

/** AgentBook itself, on World Chain (design §1.2). Where the chip points when we know a vouch
 *  exists but not which transaction wrote it: the agent's own pocket has never transacted on World
 *  Chain — Novi Corpus sends the registration — so its address page is empty, and an empty page is
 *  a worse answer than the registry it is an entry in. */
export const AGENT_BOOK_ADDRESS = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA";

/** §5.2's states, minus the ones only the vouch dialog is ever in (`awaiting-approval`). */
export type AgentBookChipKind =
  | "vouched"
  | "not-registered"
  | "unknown"
  | "disputed"
  | "submitting"
  | "failed";

export type AgentBookChipState = {
  kind: AgentBookChipKind;
  /** One of the five permitted labels. Neutral styling only — never emerald, never "human-backed". */
  label: string;
  /** Hover copy. Expands the label; never claims more than the label does. */
  title: string;
  /** The registry entry on World Chain, when there is something to link to. */
  href?: string;
  /** Copy that has to be READ rather than hovered, because it corrects an impression the label
   *  alone would leave. Only the failure state sets it (§5.2, verbatim). */
  note?: string;
};

/** §5.2, verbatim. A failed submit is not a failed registration: the transaction may have landed
 *  and the reconciler may still be reading the chain. Exported because the vouch dialog owes the
 *  same sentence for a submit failure it cannot classify — one copy, one claim. */
export const FAILURE_COPY =
  "We could not confirm the registration. It may still have gone through; we are checking the registry and will update this.";

const VOUCHED: AgentBookChipState = {
  kind: "vouched",
  label: "Vouched in AgentBook ↗",
  title: "A World ID verified human has vouched for this agent's payment address in AgentBook.",
};

const NOT_REGISTERED: AgentBookChipState = {
  kind: "not-registered",
  label: "Not in AgentBook",
  title: "No AgentBook entry for this agent's payment address.",
};

const UNKNOWN: AgentBookChipState = {
  kind: "unknown",
  label: "Could not check",
  title: "AgentBook could not be read; this says nothing about whether a vouch exists.",
};

const DISPUTED: AgentBookChipState = {
  kind: "disputed",
  label: "Disputed in AgentBook",
  title: "Someone else has replaced the vouch for this address in AgentBook.",
};

const SUBMITTING: AgentBookChipState = {
  kind: "submitting",
  label: "Vouch submitted, checking the registry",
  title:
    "A vouch for this address has been submitted. We are reading World Chain and will update this when the registry answers.",
};

/** The failure state wears a permitted neutral label and carries §5.2's sentence as visible copy —
 *  a chip label cannot fit "it may still have gone through", and that clause is the whole point. */
const FAILED: AgentBookChipState = {
  kind: "failed",
  label: "Could not check",
  title: FAILURE_COPY,
  note: FAILURE_COPY,
};

/**
 * The transaction that wrote the vouch when we know it, else AgentBook itself. Never the pocket:
 * it has no World Chain history to show.
 *
 * A hash is only the vouch's transaction on a `confirmed` row (final review FR-A). Every other row
 * that carries a hash carries one we know did NOT write the entry the chip is pointing at: a
 * `failed` row keeps the hash of a transaction that reverted (`errorCode: "reverted"`) or was never
 * mined at all (`"replaced"`, where the explorer 404s), and a `submitted`/`pending` row's hash has
 * not been read back yet. When the registry nonetheless says "registered" — someone else's vouch,
 * or our own re-broadcast landing later — the honest link is the registry, not our receipt.
 */
function explorerHref(view: AgentBookStatusView): string {
  return view.status === "confirmed" && view.txHash
    ? `${WORLDCHAIN_EXPLORER_URL}/tx/${view.txHash}`
    : `${WORLDCHAIN_EXPLORER_URL}/address/${AGENT_BOOK_ADDRESS}`;
}

/**
 * Derive the chip from a status view. `null` means render NO chip.
 *
 * Nothing is said about an agent that has no payment address yet: there is no address to look up,
 * so "Not in AgentBook" would be an answer to a question nobody asked.
 */
export function agentBookChipState(
  view: AgentBookStatusView | null | undefined,
): AgentBookChipState | null {
  if (!view) return null;

  // 1. Our own row, while it is still moving (§5.2). `pending`, `confirmed` and `expired` fall
  //    through: a confirmed row is only as good as the chain's current answer, an expired one never
  //    reached the chain at all, and a PENDING one has not been submitted (see below).
  switch (view.status) {
    case "submitted":
      // The one state where our row outranks the chain. The transaction is signed and broadcast,
      // so the chain honestly reading "no entry" is a timing artefact, not an answer.
      return SUBMITTING;
    case "pending":
      // A pending row is a session waiting for the guardian to approve in World App — opened by
      // the dialog before a QR code is even shown. Nothing has been signed or sent, so the
      // in-flight label would claim a submission that may never happen (final review FR-B): a
      // declined or abandoned dialog would keep saying "Vouch submitted" for the whole session
      // TTL. The chain's answer is true at that moment, whatever it is.
      break;
    case "failed":
      // The registry outranks a failed row in BOTH directions: the row is history, the chain is
      // the truth. This is the case the failure copy anticipates out loud — "it may still have
      // gone through" — so once the chain says it did (or that someone else's vouch now stands),
      // repeating "could not check" is the false statement.
      if (view.outcome === "registered" || view.outcome === "disputed") break;
      // A refusal above the broadcast (a rejected proof, a refused signature) fails the row
      // without ever putting a transaction on the wire. There is no submission whose fate is
      // unknown, so §5.2's "it may still have gone through" would be false here too.
      if (view.txHash == null) break;
      return FAILED;
    case "disputed":
      return DISPUTED;
    default:
      break;
  }

  // 2. No address, no question (D9).
  if (view.reason === "no-pocket-yet") return null;

  // 3. The chain's answer. An absent `outcome` is a backend that predates the field, which is
  //    exactly "we have not been told": it reads as `unknown`, never as a vouch, because
  //    `registered: true` from an older shape is not enough to make a public claim about a person.
  if (view.outcome === undefined || view.outcome === "unknown") return UNKNOWN;
  // A disputed row outranks a registered outcome: of two claims, the more conservative wins.
  if (view.outcome === "disputed" || view.disputed === true) return DISPUTED;
  if (view.outcome === "registered") return { ...VOUCHED, href: explorerHref(view) };
  return NOT_REGISTERED;
}

/**
 * Whether the dashboard offers the vouch button at all.
 *
 * Once a vouch exists there is nothing left to offer: AgentBook has no second vouch to make from
 * this account and no removal function, so the button could only ever be shown disabled — which
 * is a control that says "you cannot do this" about something the guardian has already done. The
 * chip beside it ("Vouched in AgentBook ↗", linking to the transaction) is the whole answer.
 *
 * Every other state keeps the button, disabled or not, because in every one of them there is
 * something a guardian may still do or may still be owed a reason for: `not-registered` and
 * `unknown` can vouch, `disputed` may answer a replacement once (§5.2), and `submitting` is a
 * transaction in flight whose button carries the reason it is off.
 */
export function vouchButtonVisible(chip: AgentBookChipState | null | undefined): boolean {
  return chip?.kind !== "vouched";
}
