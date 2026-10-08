/**
 * Standing: what a legal body's public statement says of it, a pure function of one block's chain
 * facts and the facts the deployment recorded. The first matching rule decides:
 *  1. `inactive`: the body's status is not Active, the binding is broken, or the attestation is
 *     revoked;
 *  2. `pending`: the attestation is pending;
 *  3. `unknown`: the agreement hash on chain is not the frozen one, the filing is unverified, or a
 *     report is past due beyond grace;
 *  4. `active` otherwise.
 * `reasons` lists every failing condition, in that order. Missing evidence never reads `inactive`.
 */
import type { Hex } from "viem";
import { describe, expect, test } from "vitest";
import type { AttestationState } from "../../src/legalBody/attestation";
import type { FilingStatus } from "../../src/legalBody/filings";
import {
  type PublicBindingState,
  type Standing,
  type StandingReason,
  computeStanding,
} from "../../src/legalBody/standing";

/** A 32-byte value: one byte, written as two hex digits, repeated. */
const H = (byte: string) => `0x${byte.repeat(32)}` as Hex;
const FROZEN = H("ab");
const OTHER = H("cd");

interface Facts {
  bindingState: PublicBindingState;
  status: "active" | "winding_down" | "dissolved";
  oaHashOnChain: Hex;
  attestation: AttestationState;
  filingStatus: FilingStatus;
  beyondGrace: boolean;
}

/** Every fact holds. */
const ALL_HOLD: Facts = {
  bindingState: "linked",
  status: "active",
  oaHashOnChain: FROZEN,
  attestation: "active",
  filingStatus: "not_yet_due",
  beyondGrace: false,
};

function standingOf(over: Partial<Facts> = {}) {
  const f = { ...ALL_HOLD, ...over };
  return computeStanding(
    { bindingState: f.bindingState, status: f.status, oaHashOnChain: f.oaHashOnChain },
    {
      frozenOaHash: FROZEN,
      attestation: f.attestation,
      filing: { filingStatus: f.filingStatus, beyondGrace: f.beyondGrace },
    },
  );
}

/** The reasons in the order `reasons` lists them. */
const REASON_ORDER: readonly StandingReason[] = [
  "status_not_active",
  "binding_broken",
  "attestation_revoked",
  "attestation_pending",
  "agreement_mismatch",
  "filing_unverified",
  "filing_past_grace",
];
/** The reasons of the first rule: facts the chain or an operator recorded. */
const INACTIVE_REASONS: readonly StandingReason[] = [
  "status_not_active",
  "binding_broken",
  "attestation_revoked",
];

describe("computeStanding", () => {
  test.each<FilingStatus>(["not_yet_due", "filed", "past_due_unverified"])(
    "active when every fact holds, with the filing status %s within grace",
    (filingStatus) => {
      expect(standingOf({ filingStatus })).toEqual({ standing: "active", reasons: [] });
    },
  );

  test.each<[string, Partial<Facts>, Standing, StandingReason[]]>([
    ["a winding-down body", { status: "winding_down" }, "inactive", ["status_not_active"]],
    ["a dissolved body", { status: "dissolved" }, "inactive", ["status_not_active"]],
    ["a broken binding", { bindingState: "broken" }, "inactive", ["binding_broken"]],
    ["a revoked attestation", { attestation: "revoked" }, "inactive", ["attestation_revoked"]],
    ["a pending attestation", { attestation: "pending" }, "pending", ["attestation_pending"]],
    [
      "another agreement hash on chain",
      { oaHashOnChain: OTHER },
      "unknown",
      ["agreement_mismatch"],
    ],
    ["an unverified filing", { filingStatus: "unverified" }, "unknown", ["filing_unverified"]],
    [
      "a report past due beyond grace",
      { filingStatus: "past_due_unverified", beyondGrace: true },
      "unknown",
      ["filing_past_grace"],
    ],
  ])("each condition alone: %s", (_name, over, standing, reasons) => {
    expect(standingOf(over)).toEqual({ standing, reasons });
  });

  test("the agreement hashes are compared in lower case", () => {
    const upper = (h: Hex) => `0x${h.slice(2).toUpperCase()}` as Hex;
    expect(standingOf({ oaHashOnChain: upper(FROZEN) })).toEqual({
      standing: "active",
      reasons: [],
    });
    expect(
      computeStanding(
        { bindingState: "linked", status: "active", oaHashOnChain: FROZEN },
        {
          frozenOaHash: upper(FROZEN),
          attestation: "active",
          filing: { filingStatus: "filed", beyondGrace: false },
        },
      ),
    ).toEqual({ standing: "active", reasons: [] });
  });

  describe("the first matching rule decides", () => {
    test("a fact of the first rule beats a pending attestation", () => {
      // An attestation is revoked or pending, never both: the pair is a pending attestation with
      // another fact of the first rule.
      expect(standingOf({ status: "winding_down", attestation: "pending" })).toEqual({
        standing: "inactive",
        reasons: ["status_not_active", "attestation_pending"],
      });
      expect(standingOf({ bindingState: "broken", attestation: "pending" })).toEqual({
        standing: "inactive",
        reasons: ["binding_broken", "attestation_pending"],
      });
    });

    test("a revocation beats every fact of the third rule", () => {
      expect(
        standingOf({
          attestation: "revoked",
          oaHashOnChain: OTHER,
          filingStatus: "unverified",
        }),
      ).toEqual({
        standing: "inactive",
        reasons: ["attestation_revoked", "agreement_mismatch", "filing_unverified"],
      });
    });

    test("a pending attestation beats each fact of the third rule", () => {
      expect(standingOf({ attestation: "pending", oaHashOnChain: OTHER })).toEqual({
        standing: "pending",
        reasons: ["attestation_pending", "agreement_mismatch"],
      });
      expect(standingOf({ attestation: "pending", filingStatus: "unverified" })).toEqual({
        standing: "pending",
        reasons: ["attestation_pending", "filing_unverified"],
      });
      expect(
        standingOf({
          attestation: "pending",
          filingStatus: "past_due_unverified",
          beyondGrace: true,
        }),
      ).toEqual({ standing: "pending", reasons: ["attestation_pending", "filing_past_grace"] });
    });

    test("a mismatch alone reads unknown", () => {
      expect(standingOf({ oaHashOnChain: OTHER })).toEqual({
        standing: "unknown",
        reasons: ["agreement_mismatch"],
      });
    });
  });

  test("reasons are complete and in their fixed order", () => {
    // Every condition fails at once (an unverified filing beyond grace never comes out of the
    // filing facts, but each condition is read on its own).
    expect(
      standingOf({
        status: "dissolved",
        bindingState: "broken",
        attestation: "revoked",
        oaHashOnChain: OTHER,
        filingStatus: "unverified",
        beyondGrace: true,
      }),
    ).toEqual({
      standing: "inactive",
      reasons: [
        "status_not_active",
        "binding_broken",
        "attestation_revoked",
        "agreement_mismatch",
        "filing_unverified",
        "filing_past_grace",
      ],
    });
    expect(
      standingOf({
        status: "winding_down",
        bindingState: "broken",
        attestation: "pending",
        oaHashOnChain: OTHER,
        filingStatus: "past_due_unverified",
        beyondGrace: true,
      }),
    ).toEqual({
      standing: "inactive",
      reasons: [
        "status_not_active",
        "binding_broken",
        "attestation_pending",
        "agreement_mismatch",
        "filing_past_grace",
      ],
    });
  });

  test("missing evidence never reads inactive: a missing check is pending, missing filing evidence unknown", () => {
    expect(standingOf({ attestation: "pending", filingStatus: "unverified" }).standing).toBe(
      "pending",
    );
    expect(standingOf({ filingStatus: "unverified" }).standing).toBe("unknown");
  });

  test("over every combination of facts: each reason exactly when its condition fails, in order, and the standing from the first rule that matches", () => {
    let combinations = 0;
    for (const bindingState of ["linked", "broken"] as const)
      for (const status of ["active", "winding_down", "dissolved"] as const)
        for (const oaHashOnChain of [FROZEN, OTHER])
          for (const attestation of ["pending", "active", "revoked"] as const)
            for (const filingStatus of [
              "not_yet_due",
              "filed",
              "past_due_unverified",
              "unverified",
            ] as const)
              for (const beyondGrace of [false, true]) {
                combinations += 1;
                const facts = {
                  bindingState,
                  status,
                  oaHashOnChain,
                  attestation,
                  filingStatus,
                  beyondGrace,
                };
                const { standing, reasons } = standingOf(facts);
                const failing: Record<StandingReason, boolean> = {
                  status_not_active: status !== "active",
                  binding_broken: bindingState === "broken",
                  attestation_revoked: attestation === "revoked",
                  attestation_pending: attestation === "pending",
                  agreement_mismatch: oaHashOnChain !== FROZEN,
                  filing_unverified: filingStatus === "unverified",
                  filing_past_grace: beyondGrace,
                };
                const label = JSON.stringify(facts);
                expect(reasons, label).toEqual(REASON_ORDER.filter((r) => failing[r]));
                const expected: Standing = reasons.some((r) => INACTIVE_REASONS.includes(r))
                  ? "inactive"
                  : reasons.includes("attestation_pending")
                    ? "pending"
                    : reasons.length > 0
                      ? "unknown"
                      : "active";
                expect(standing, label).toBe(expected);
              }
    expect(combinations).toBe(288);
  });
});
