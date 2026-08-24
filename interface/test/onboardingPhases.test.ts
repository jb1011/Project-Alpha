/**
 * The wizard's phase list, and the invariant the header and the rail depend on.
 *
 * `visiblePhases` is the only list that knows which steps THIS deployment has, and three things
 * index into it: the "Step N of M" counter, the Stepper rail, and the `screenLabel` eyebrow. A
 * phase that is not on it produces `-1` from every one of them — which is not an error anywhere,
 * just "Step 0", an unhighlighted rail and a wizard confidently reporting the wrong position.
 */
import { expect, test } from "vitest";
import {
  indexIn,
  nextPhase,
  PHASES,
  prevPhase,
  screenLabel,
  snapToVisiblePhase,
  visiblePhases,
} from "@/components/onboarding/types";

const withFormation = visiblePhases(true);
const withoutFormation = visiblePhases(false);

test("G2: a phase that IS on the list is returned untouched", () => {
  for (const p of withFormation) expect(snapToVisiblePhase(withFormation, p.id)).toBe(p.id);
  for (const p of withoutFormation) expect(snapToVisiblePhase(withoutFormation, p.id)).toBe(p.id);
});

test("G2: a restored `legal-identity` on a list without it snaps FORWARD to custody", () => {
  // The three ways this happens: /config still in flight, /config failed, formation turned off
  // between two visits. All three hide the step while storage still points at it.
  expect(snapToVisiblePhase(withoutFormation, "legal-identity")).toBe("custody");
  // Snapping backwards to `guardian` would re-run the accountable-human step for somebody who has
  // already completed it — custody is where the flow itself sends a user who skips this step.
});

test("G2: the snapped phase is always a member of the list — never index -1", () => {
  for (const p of PHASES) {
    for (const phases of [withFormation, withoutFormation]) {
      const snapped = snapToVisiblePhase(phases, p.id);
      expect(indexIn(phases, snapped), `${p.id} -> ${snapped}`).toBeGreaterThanOrEqual(0);
      // …which is the same thing the header and the eyebrow read.
      expect(screenLabel(phases, snapped)).not.toBe("Screen 0");
    }
  }
});

test("G2: a phase from corrupt storage falls back to the first visible phase", () => {
  expect(snapToVisiblePhase(withFormation, "not-a-phase" as never)).toBe("welcome");
});

test("G2: snapping never carries a user PAST a step, except the skipped one", () => {
  // Every snap either stays put, or lands earlier in the canonical order — the single exception
  // being `legal-identity`, whose whole point is that the flow skips it.
  const canonical = (id: string) => PHASES.findIndex((p) => p.id === id);
  for (const p of PHASES) {
    if (p.id === "legal-identity") continue;
    const snapped = snapToVisiblePhase(withoutFormation, p.id);
    expect(canonical(snapped), p.id).toBeLessThanOrEqual(canonical(p.id));
  }
});

test("G9: neighbours come from the VISIBLE list, so the optional step drops out of both", () => {
  expect(nextPhase(withFormation, "guardian")).toBe("legal-identity");
  expect(nextPhase(withoutFormation, "guardian")).toBe("custody");
  expect(prevPhase(withFormation, "custody")).toBe("legal-identity");
  expect(prevPhase(withoutFormation, "custody")).toBe("guardian");
});

test("G9: the ends are clamped — there is nothing before welcome or after dashboard", () => {
  expect(prevPhase(withFormation, "welcome")).toBe("welcome");
  expect(nextPhase(withFormation, "dashboard")).toBe("dashboard");
});
