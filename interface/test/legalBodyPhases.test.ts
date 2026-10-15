/**
 * The legal-body rail: which phases a deployment shows, where a derivation sits on it, what the
 * rail marks as done, and where a person may jump back to.
 */
import { describe, expect, test } from "vitest";
import {
  LEGAL_BODY_PHASES,
  canJumpTo,
  phaseLabel,
  railCurrentOf,
  railDone,
  railDoneOf,
  railPhaseOf,
  visibleLegalBodyPhases,
  type LegalBodyRailPhase,
} from "@/lib/legalBody/phases";
import type { LegalBodyDerivation } from "@/lib/legalBody/flow";
import type { LegalBodyConfig } from "@/lib/api/types";

type AvailableConfig = Extract<LegalBodyConfig, { available: true }>;

const config = (over: Partial<AvailableConfig> = {}): AvailableConfig => ({
  available: true,
  declarations: true,
  statements: true,
  environment: "sandbox",
  chainId: 5042002,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  factory: "0x069f4ADEabcBEd3ffFe2cB6Aaf9e7a66E8731456",
  gasSeedOffered: false,
  paymentRequired: false,
  linkTtl: { min: 600, max: 85_800, default: 3_600 },
  ...over,
});

describe("the phases", () => {
  test("all nine, in the flow's order, with their labels", () => {
    expect(LEGAL_BODY_PHASES).toEqual([
      { id: "signin", label: "Sign in" },
      { id: "human", label: "Accountable human" },
      { id: "company", label: "Your company" },
      { id: "agreement", label: "Agreement" },
      { id: "identity", label: "Your agent's identity" },
      { id: "link", label: "Sign the link" },
      { id: "pointer", label: "Point your identity" },
      { id: "payment", label: "Payment" },
      { id: "done", label: "Done" },
    ]);
  });

  test("closed is not on the rail", () => {
    expect(LEGAL_BODY_PHASES.map((p) => p.id)).not.toContain("closed");
  });

  test("a deployment that charges nothing shows eight, without payment", () => {
    const ids = visibleLegalBodyPhases(config()).map((p) => p.id);
    expect(ids).toEqual([
      "signin",
      "human",
      "company",
      "agreement",
      "identity",
      "link",
      "pointer",
      "done",
    ]);
  });

  test("a charging deployment shows nine, payment just before done", () => {
    const ids = visibleLegalBodyPhases(config({ paymentRequired: true })).map((p) => p.id);
    expect(ids).toHaveLength(9);
    expect(ids.indexOf("payment")).toBe(ids.indexOf("done") - 1);
  });
});

describe("railPhaseOf", () => {
  const rows: [LegalBodyDerivation, LegalBodyRailPhase][] = [
    [{ phase: "company", companyStep: "form" }, "company"],
    [{ phase: "company", companyStep: "failed", notice: { kind: "company_failed", reasonCode: null } }, "company"],
    [{ phase: "agreement" }, "agreement"],
    [{ phase: "identity" }, "identity"],
    [{ phase: "identity", notice: { kind: "identity_taken", agentId: "42" } }, "identity"],
    [{ phase: "link", branch: "browser" }, "link"],
    [{ phase: "link", branch: "paste", notice: { kind: "creating" } }, "link"],
    [{ phase: "pointer", branch: "browser" }, "pointer"],
    [{ phase: "payment" }, "payment"],
    [{ phase: "done" }, "done"],
    [{ phase: "done", notice: { kind: "winding_down" } }, "done"],
    // Where a closed order got to is not known: the rail shows its end.
    [{ phase: "closed", notice: { kind: "expired" } }, "done"],
    [{ phase: "closed", notice: { kind: "lapsed", reason: "deadline_passed" } }, "done"],
    [{ phase: "closed" }, "done"],
  ];

  test.each(rows)("%j sits on %s", (derivation, rail) => {
    expect(railPhaseOf(derivation)).toBe(rail);
  });
});

describe("phaseLabel", () => {
  test("each phase by its rail name; closed by the rail's end", () => {
    expect(phaseLabel("identity")).toBe("Your agent's identity");
    expect(phaseLabel("payment")).toBe("Payment");
    expect(phaseLabel("closed")).toBe("Done");
  });
});

describe("railCurrentOf", () => {
  test("a gate is its own phase, whatever the thread says", () => {
    expect(railCurrentOf("signin", { phase: "link" })).toBe("signin");
    expect(railCurrentOf("human", { phase: "done" })).toBe("human");
  });

  test("past the gates, the derivation's phase", () => {
    expect(railCurrentOf("flow", { phase: "pointer" })).toBe("pointer");
    expect(railCurrentOf("flow", { phase: "closed" })).toBe("done");
  });

  test("past the gates with no thread decided yet (loading, or a chooser): the first step of a thread", () => {
    expect(railCurrentOf("flow", null)).toBe("company");
  });
});

describe("railDone", () => {
  const phases = visibleLegalBodyPhases(config());

  test("every phase before the current one, and nothing from it on", () => {
    expect(railDone(phases, "identity")).toEqual({
      signin: true,
      human: true,
      company: true,
      agreement: true,
    });
  });

  test("at the first phase nothing is done", () => {
    expect(railDone(phases, "signin")).toEqual({});
  });

  test("a phase this deployment does not show marks nothing", () => {
    expect(railDone(phases, "payment")).toEqual({});
  });
});

describe("railDoneOf: a closed order never shows as progress", () => {
  const phases = visibleLegalBodyPhases(config());
  const expired: LegalBodyDerivation = { phase: "closed", notice: { kind: "expired" } };

  test("a closed order ticks the gates only: no step it never reached", () => {
    expect(railDoneOf(phases, "flow", expired)).toEqual({ signin: true, human: true });
    expect(railDoneOf(phases, "flow", { phase: "closed" })).toEqual({ signin: true, human: true });
  });

  test("on a charging deployment too", () => {
    const charging = visibleLegalBodyPhases(config({ paymentRequired: true }));
    expect(railDoneOf(charging, "flow", expired)).toEqual({ signin: true, human: true });
  });

  test("any other phase ticks every phase before it", () => {
    expect(railDoneOf(phases, "flow", { phase: "link" })).toEqual(railDone(phases, "link"));
    expect(railDoneOf(phases, "flow", { phase: "done" })).toEqual(railDone(phases, "done"));
    expect(railDoneOf(phases, "flow", null)).toEqual(railDone(phases, "company"));
  });

  test("on a gate, the gate's own map, whatever the thread says", () => {
    expect(railDoneOf(phases, "signin", expired)).toEqual({});
    expect(railDoneOf(phases, "human", expired)).toEqual({ signin: true });
  });
});

describe("canJumpTo", () => {
  const phases = visibleLegalBodyPhases(config());

  test("back to the gates from anywhere past them", () => {
    expect(canJumpTo(phases, "link", "signin")).toBe(true);
    expect(canJumpTo(phases, "link", "human")).toBe(true);
    expect(canJumpTo(phases, "human", "signin")).toBe(true);
  });

  test("back to an earlier step", () => {
    expect(canJumpTo(phases, "link", "identity")).toBe(true);
    expect(canJumpTo(phases, "link", "agreement")).toBe(true);
  });

  test("never forward, never to the current phase, never off the rail", () => {
    expect(canJumpTo(phases, "agreement", "link")).toBe(false);
    expect(canJumpTo(phases, "signin", "human")).toBe(false);
    expect(canJumpTo(phases, "link", "link")).toBe(false);
    expect(canJumpTo(phases, "done", "payment")).toBe(false);
    expect(canJumpTo(phases, "done", "closed")).toBe(false);
  });
});
