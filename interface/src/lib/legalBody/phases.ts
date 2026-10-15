import type { LegalBodyConfig } from "@/lib/api/types";
import { LEGAL_BODY_COPY } from "@/lib/legalBody/copy";
import type { LegalBodyDerivation, LegalBodyPhase } from "@/lib/legalBody/flow";

/**
 * The legal-body flow's rail: the two gates, then the thread's phases.
 *
 * The rail shows where a person is; it never decides it. Past the gates the derivation says the
 * phase (`railPhaseOf`), and a jump back only re-renders: the derivation decides again, so a jump
 * never skips a door.
 */

/** A phase on the rail. `closed` is a derivation's phase, never the rail's: it shows as `done`. */
export type LegalBodyRailPhase = "signin" | "human" | LegalBodyPhase;

/** Where the screen is past its data: a gate, or the thread's own step. */
export type RailGate = "signin" | "human" | "flow";

const L = LEGAL_BODY_COPY.rail.labels;

/** Every phase the flow can show, in order. Payment is shown only where the deployment charges. */
export const LEGAL_BODY_PHASES: { id: LegalBodyRailPhase; label: string }[] = [
  { id: "signin", label: L.signin },
  { id: "human", label: L.human },
  { id: "company", label: L.company },
  { id: "agreement", label: L.agreement },
  { id: "identity", label: L.identity },
  { id: "link", label: L.link },
  { id: "pointer", label: L.pointer },
  { id: "payment", label: L.payment },
  { id: "done", label: L.done },
];

/** The phases this deployment shows: without `payment` unless it charges. */
export function visibleLegalBodyPhases(
  config: Extract<LegalBodyConfig, { available: true }>,
): { id: LegalBodyRailPhase; label: string }[] {
  return LEGAL_BODY_PHASES.filter((p) => p.id !== "payment" || config.paymentRequired);
}

/** Where a derivation sits on the rail. A closed order's last phase is not known: it shows at the
 *  rail's end. */
export function railPhaseOf(derivation: LegalBodyDerivation): LegalBodyRailPhase {
  return derivation.phase === "closed" ? "done" : derivation.phase;
}

/** A phase's name on the rail; `closed`, which the rail shows as its end, is named as the end. */
export function phaseLabel(phase: LegalBodyRailPhase): string {
  return LEGAL_BODY_PHASES.find((p) => p.id === phase)?.label ?? L.done;
}

/** The rail's current phase: the gate, or the thread's phase; with no thread decided yet (its data
 *  loading, or a chooser), the first phase of a thread. */
export function railCurrentOf(
  gate: RailGate,
  derivation: LegalBodyDerivation | null,
): LegalBodyRailPhase {
  if (gate !== "flow") return gate;
  return derivation ? railPhaseOf(derivation) : "company";
}

/** Every shown phase before the current one, as the rail's `done` map. */
export function railDone(
  phases: { id: LegalBodyRailPhase }[],
  current: LegalBodyRailPhase,
): Record<string, boolean> {
  const at = phases.findIndex((p) => p.id === current);
  const done: Record<string, boolean> = {};
  for (const p of phases.slice(0, Math.max(at, 0))) done[p.id] = true;
  return done;
}

/**
 * The rail's done map for what is on screen. A closed order never got as far as the rail could
 * claim: it may have lapsed before its body or expired before its link, so only the two gates it
 * passed are ticked, never a step it may not have reached.
 */
export function railDoneOf(
  phases: { id: LegalBodyRailPhase }[],
  gate: RailGate,
  derivation: LegalBodyDerivation | null,
): Record<string, boolean> {
  if (gate === "flow" && derivation?.phase === "closed") {
    const done: Record<string, boolean> = {};
    for (const p of phases) if (p.id === "signin" || p.id === "human") done[p.id] = true;
    return done;
  }
  return railDone(phases, railCurrentOf(gate, derivation));
}

/**
 * Whether the screen shows the rail. A closed order's screen is a terminal notice with its own way
 * out: nothing on it is in progress and nothing past the gates is done, so it shows no rail at
 * all. Every other screen, the gates and a thread still loading included, shows it.
 */
export function showRail(gate: RailGate, derivation: LegalBodyDerivation | null): boolean {
  return !(gate === "flow" && derivation?.phase === "closed");
}

/** A jump goes back only: to a gate, or to an earlier shown phase of the thread. */
export function canJumpTo(
  phases: { id: LegalBodyRailPhase }[],
  current: LegalBodyRailPhase,
  target: LegalBodyRailPhase,
): boolean {
  const at = phases.findIndex((p) => p.id === current);
  const to = phases.findIndex((p) => p.id === target);
  return to >= 0 && at >= 0 && to < at;
}
