import type { EntityView } from "./api/types";

type WithAnchor = Pick<EntityView, "oaAnchor">;

/**
 * How to NAME the on-chain OA hash row.
 *
 * The scheme comes from the backend (`oaAnchor.scheme`), never from guessing at a version number:
 * a manifest entity whose v1 has not confirmed yet has a null version, and calling that "OA hash"
 * would describe a bundle anchor as a plain document hash. An absent `oaAnchor` means a backend
 * that predates the field, which is the legacy shape by definition.
 */
export function oaAnchorLabel(entity: WithAnchor): string {
  const anchor = entity.oaAnchor;
  if (!anchor || anchor.scheme === "legacy") return "OA hash";
  return anchor.version != null ? `OA anchor (v${anchor.version})` : "OA anchor (pending)";
}

/**
 * The "update pending" chip's text — or null when there is nothing pending.
 *
 * A pending amendment is a change to what the entity commits to, waiting out a timelock the
 * guardian can veto, so the dashboard says so where the anchor is shown rather than leaving it to
 * whoever opens Settings. Deliberately NOT rendered for a v1 that has simply not confirmed yet
 * (`version == null`): that is the first anchor arriving, not an update to an existing one.
 *
 * **The number is shown only when the backend SENT one.** It used to fall back to
 * `anchor.version + 1`, which is a guess dressed as a fact — and the guess is wrong in the case
 * that matters: a version can be superseded or abandoned while its schedule stays executable
 * on-chain forever, so the pending hash is often not `anchored + 1` at all. Naming a version the
 * guardian would then not find on the veto card is worse than naming none, because the veto card
 * is where they go to act. Absent a number, the chip still says an update is pending — which is
 * the part that is true, and the part that sends them to look.
 */
export function pendingAnchorLabel(entity: WithAnchor): string | null {
  const anchor = entity.oaAnchor;
  if (!anchor || anchor.scheme !== "manifest") return null;
  if (!anchor.pendingHash || anchor.version == null) return null;
  return anchor.pendingVersion != null
    ? `update pending (v${anchor.pendingVersion})`
    : "update pending";
}
