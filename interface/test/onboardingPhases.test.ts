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
  resumePhase,
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

test("G2: a restored `legal-body` on a list without it snaps FORWARD to custody", () => {
  // The three ways this happens: /config still in flight, /config failed, formation turned off
  // between two visits. All three hide the step while storage still points at it.
  expect(snapToVisiblePhase(withoutFormation, "legal-body")).toBe("custody");
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
  // being `legal-body`, whose whole point is that the flow skips it.
  const canonical = (id: string) => PHASES.findIndex((p) => p.id === id);
  for (const p of PHASES) {
    if (p.id === "legal-body") continue;
    const snapped = snapToVisiblePhase(withoutFormation, p.id);
    expect(canonical(snapped), p.id).toBeLessThanOrEqual(canonical(p.id));
  }
});

test("G9: neighbours come from the VISIBLE list, so the optional step drops out of both", () => {
  expect(nextPhase(withFormation, "guardian")).toBe("legal-body");
  expect(nextPhase(withoutFormation, "guardian")).toBe("custody");
  expect(prevPhase(withFormation, "custody")).toBe("legal-body");
  expect(prevPhase(withoutFormation, "custody")).toBe("guardian");
});

test("G9: the ends are clamped — there is nothing before welcome or after dashboard", () => {
  expect(prevPhase(withFormation, "welcome")).toBe("welcome");
  expect(nextPhase(withFormation, "dashboard")).toBe("dashboard");
});

/* ── the resume rule (design §7, A3) ───────────────────────────────────────── */

const resume = (over: Partial<Parameters<typeof resumePhase>[0]> = {}) =>
  resumePhase({
    phases: withFormation,
    storedPhase: "agreement",
    formationAvailable: true,
    formationRequired: false,
    companyId: null,
    entityId: null,
    needsCompany: false,
    ...over,
  });

test("A3: a MIGRATED v2 session with a party and no company cannot reach `agreement`", () => {
  // The bug this pins: A1's shim turned a party handle into a company inside the claim. A3
  // removed the shim and the onboard door REFUSES a partyId, so a v2 session resuming at
  // `agreement` would have submitted with `companyId: null` — silently onboarding an agent with
  // no legal body on a box the user had asked to file one on.
  expect(resume({ needsCompany: true })).toBe("legal-body");
  // …on a deployment that merely OFFERS formation, not only one that requires it.
  expect(resume({ needsCompany: true, formationRequired: false })).toBe("legal-body");
  expect(resume({ needsCompany: true, formationRequired: true })).toBe("legal-body");
});

test("A3: the bounce never carries a session FORWARD to a step it has not reached", () => {
  for (const storedPhase of ["welcome", "guardian", "legal-body"] as const)
    expect(resume({ needsCompany: true, storedPhase })).toBe(storedPhase);
});

test("A3: a deployment that forms NOTHING never bounces — there is no company to pick", () => {
  expect(
    resumePhase({
      phases: withoutFormation,
      storedPhase: "agreement",
      formationAvailable: false,
      formationRequired: false,
      companyId: null,
      entityId: null,
      needsCompany: true,
    }),
  ).toBe("agreement");
});

test("A3: a company, or an entity, ends the bounce", () => {
  expect(resume({ needsCompany: true, companyId: "company_1" })).toBe("agreement");
  // By `deploy` the handle has been consumed by /onboard; sending the user back to pick another
  // company would be nonsense.
  expect(resume({ needsCompany: true, entityId: "ent_1" })).toBe("agreement");
  expect(resume({ formationRequired: true, entityId: "ent_1" })).toBe("agreement");
});

test("A3: a REQUIRED deployment bounces a company-less session with no migration involved", () => {
  expect(resume({ formationRequired: true })).toBe("legal-body");
  // …and an optional one leaves a deliberate skip alone, which is why the migration flag exists
  // rather than the rule simply widening to `formationAvailable`.
  expect(resume({ formationRequired: false })).toBe("agreement");
});

test("A3: `dashboard` is never bounced — the wizard is over", () => {
  expect(resume({ needsCompany: true, storedPhase: "dashboard" })).toBe("dashboard");
});
