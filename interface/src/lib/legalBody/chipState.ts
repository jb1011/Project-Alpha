import type { LegalBodyLookup } from "@/lib/api/types";

/**
 * What the "Legal body" chip is allowed to say — the second question, kept apart from the first.
 *
 * AgentBook answers "does a verified human vouch for this address?". This answers the other one
 * (design 2026-09-10 §1): "is this address the payment address of a Novi legal body in good
 * standing?". Two sources, two chips, side by side, and NEITHER may be rendered as evidence for
 * the other. In particular nothing here may say or imply that AgentBook shows this — it does not,
 * and the whole point of the lookup is that it is a second source of truth. Where the relation is
 * worth explaining at all, the one permitted sentence is exactly:
 *
 *   "Sellers that check both AgentBook and Novi see this agent as a legal body in good standing."
 *
 * The vocabulary ceiling is D7's, and it is narrow on purpose: "a registered legal body in good
 * standing" is what the chain carries, so that is what may be said. Never "verified company",
 * never "KYC'd", never "licensed", never anything about who the guardian is.
 *
 * `standing` is three-valued and the third value is not a negative (D8): `unknown` is a chain
 * read that failed. It says nothing about the body, and the chip says so out loud.
 */

/** The three chips, and the two ways there is no chip at all. */
export type LegalBodyChipKind = "active" | "inactive" | "unknown";

export type LegalBodyChipState = {
  kind: LegalBodyChipKind;
  /** One of the three permitted labels. */
  label: string;
  /** Hover copy. Expands the label; never claims more than the label does. */
  title: string;
  /** The PUBLIC transparency page, straight from the lookup's own `links.transparency` — never
   *  composed here, so an owner's chip points wherever this deployment tells strangers to look. */
  href?: string;
};

/**
 * Everything the dashboard can know about the lookup.
 *
 * `{ unreadable: true }` is the fourth answer the route can give and the three shapes above
 * cannot: a 400, a 404 (no resolver wired on this deployment), a 429 (either rate budget) or a
 * 503 (the local read failed) — plus a network failure. It is a DISTINCT variant rather than a
 * synthesized `standing: "unknown"` because the two have different causes and only one of them
 * is a fact about the address; they happen to deserve the same chip, and that is a decision this
 * function makes rather than one the caller fakes.
 */
export type LegalBodyView = LegalBodyLookup | { unreadable: true };

const ACTIVE: LegalBodyChipState = {
  kind: "active",
  label: "Legal body active",
  title:
    "A registered legal body in good standing on Arc: its LegalManager is active and its treasury is not paused. Novi's registry, read from the chain.",
};

const INACTIVE: LegalBodyChipState = {
  kind: "inactive",
  label: "Legal body paused",
  title:
    "The legal body exists but is not in good standing right now: its treasury is paused or its LegalManager is not active.",
};

const UNKNOWN: LegalBodyChipState = {
  kind: "unknown",
  label: "Could not check",
  title: "The chain could not be read; this says nothing about the body's standing.",
};

/**
 * Derive the chip from the lookup. `null` means render NO chip.
 *
 * Two silences, for the same reason the AgentBook chip has one: an agent with no payment address
 * has nothing to look up, so there is no question to answer; and `legalBody: false` cannot happen
 * for an agent on its own dashboard — every one of ours is an entity the resolver knows — so if
 * it ever does, the honest rendering is nothing at all. A "Not a legal body" chip on an owner's
 * own agent would be a claim about the agent built out of what is far more likely a lookup
 * pointed at the wrong address.
 */
export function legalBodyChipState(
  view: LegalBodyView | null | undefined,
): LegalBodyChipState | null {
  // No query yet (no pocket, still loading), or a query that could not be read.
  if (!view) return null;
  if ("unreadable" in view) return UNKNOWN;
  if (!view.legalBody) return null;

  switch (view.standing) {
    case "active":
      return { ...ACTIVE, href: view.links.transparency };
    case "inactive":
      return { ...INACTIVE, href: view.links.transparency };
    default:
      // `unknown` from the route, and anything a newer backend grows that this build has never
      // heard of. Both are "we were not told", and neither may become a claim.
      return { ...UNKNOWN, href: view.links.transparency };
  }
}
