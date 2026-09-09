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

test("G2: snapping never carries a user PAST a step, except the skipped ones", () => {
  // Every snap either stays put, or lands earlier in the canonical order — the exceptions being
  // the OPTIONAL steps, whose whole point is that the flow skips them. `payment` (B1) joins
  // `legal-body` in that list: both snap forward to `custody`, which is where the flow itself
  // sends users when either is absent, and snapping backwards would re-run a completed step.
  const canonical = (id: string) => PHASES.findIndex((p) => p.id === id);
  for (const p of PHASES) {
    if (p.id === "legal-body" || p.id === "payment") continue;
    const snapped = snapToVisiblePhase(withoutFormation, p.id);
    expect(canonical(snapped), p.id).toBeLessThanOrEqual(canonical(p.id));
  }
});

/* ── the PAYMENT phase (B1, design §6.1) ───────────────────────────────────── */

test("B1: the payment step is absent during the beta, on every deployment", () => {
  // `visiblePhases(true)` is the beta shape and the default: a backend that predates
  // `/config.formationPaymentRequired` does not charge, and a step whose every endpoint would 404
  // is worse than no step at all.
  expect(withFormation.map((p) => p.id)).not.toContain("payment");
  expect(visiblePhases(true, false).map((p) => p.id)).not.toContain("payment");
});

test("B1: it appears between the legal body and custody where the deployment charges", () => {
  const charging = visiblePhases(true, true, true);
  expect(nextPhase(charging, "legal-body")).toBe("payment");
  expect(nextPhase(charging, "payment")).toBe("custody");
  expect(prevPhase(charging, "custody")).toBe("payment");
});

test("⚠ B5: with NO COMPANY there is no fee step — the skip must not land on one", () => {
  // With formation optional a user can skip the legal body entirely. A payment phase behind that
  // skip has no company to quote for, no endpoint that would answer and no exit: the wizard
  // would carry them into a dead end on a deployment that charges.
  const skipped = visiblePhases(true, true, false);
  expect(skipped.map((p) => p.id)).not.toContain("payment");
  expect(nextPhase(skipped, "legal-body")).toBe("custody");
  // …and the moment a company exists, the step is there.
  expect(nextPhase(visiblePhases(true, true, true), "legal-body")).toBe("payment");
});

test("B1: a deployment that forms NOTHING cannot charge for a formation", () => {
  // Subordinate, not independent: the payment phase goes wherever the legal-body one does,
  // whatever the flag says. A box that cannot form a company has nothing to take money for.
  expect(visiblePhases(false, true, true).map((p) => p.id)).not.toContain("payment");
  expect(visiblePhases(false, true, true).map((p) => p.id)).not.toContain("legal-body");
});

test("B1: a session stranded on `payment` after the flag goes off snaps FORWARD to custody", () => {
  // The `legal-body` rule, for the same reason: the fee step is one the flow itself skips, and
  // sending somebody back to re-pick a company they already chose would be worse than the snap.
  expect(snapToVisiblePhase(withFormation, "payment")).toBe("custody");
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
