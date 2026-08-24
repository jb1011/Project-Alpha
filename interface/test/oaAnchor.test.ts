/**
 * The dashboard's anchor labels — and the version number it must not invent.
 *
 * The chip used to fall back to `anchor.version + 1` whenever the backend sent no
 * `pendingVersion`. That is a guess presented as a fact, and it is wrong in exactly the case that
 * matters: a version can be superseded or abandoned while the schedule it already broadcast stays
 * executable on-chain forever, so the pending hash is often not "anchored + 1" at all. A guardian
 * sent to Settings looking for "v4" and finding a different version there learns to distrust the
 * card that sent them.
 */
import { expect, test } from "vitest";
import { oaAnchorLabel, pendingAnchorLabel } from "@/lib/oaAnchor";
import type { EntityView } from "@/lib/api/types";

type Anchor = EntityView["oaAnchor"];
const withAnchor = (oaAnchor: Anchor) => ({ oaAnchor });

const PENDING = "0xfeed000000000000000000000000000000000000000000000000000000000001";

test("G4: the pending version is shown only when the backend SENT one", () => {
  expect(
    pendingAnchorLabel(
      withAnchor({
        scheme: "manifest",
        hash: "0xabc",
        version: 3,
        pendingHash: PENDING,
        pendingVersion: 7,
      }),
    ),
  ).toBe("update pending (v7)");
});

test("G4: with no pendingVersion the chip names NO version — it does not guess anchored + 1", () => {
  const label = pendingAnchorLabel(
    withAnchor({ scheme: "manifest", hash: "0xabc", version: 3, pendingHash: PENDING }),
  );
  expect(label).toBe("update pending");
  expect(label).not.toContain("v4");
  expect(label).not.toMatch(/v\d/);
});

test("G4: nothing pending, a legacy row, or an unconfirmed v1 → no chip at all", () => {
  expect(
    pendingAnchorLabel(
      withAnchor({ scheme: "manifest", hash: "0xabc", version: 3, pendingHash: null }),
    ),
  ).toBeNull();
  expect(pendingAnchorLabel(withAnchor({ scheme: "legacy", hash: "0xabc" }))).toBeNull();
  expect(pendingAnchorLabel(withAnchor(undefined))).toBeNull();
  // A v1 that has simply not confirmed yet is the FIRST anchor arriving, not an update to one.
  expect(
    pendingAnchorLabel(
      withAnchor({ scheme: "manifest", hash: null, version: null, pendingHash: PENDING }),
    ),
  ).toBeNull();
});

test("G4: the row's NAME comes from the scheme, never from a version number", () => {
  expect(oaAnchorLabel(withAnchor(undefined))).toBe("OA hash");
  expect(oaAnchorLabel(withAnchor({ scheme: "legacy", hash: "0xabc" }))).toBe("OA hash");
  expect(
    oaAnchorLabel(withAnchor({ scheme: "manifest", hash: null, version: null, pendingHash: null })),
  ).toBe("OA anchor (pending)");
  expect(
    oaAnchorLabel(withAnchor({ scheme: "manifest", hash: "0xabc", version: 2, pendingHash: null })),
  ).toBe("OA anchor (v2)");
});
