/**
 * The World ID gate as a table.
 *
 * Two flows read the same guardian record and ask different questions of it. The onboarding
 * wizard accepts any row on record (a waiver included, shown in amber) and skips the step on a
 * deployment without World ID. A flow that needs a real person accepts only what the server's own
 * real-human check accepts, and treats a deployment without World ID as a stop. The rows below
 * pin both readings, and the one that a screen keys its title on: "accepted", never "verified".
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { WorldIdStatusRow } from "@/components/guardian/WorldIdGate";
import {
  worldIdGateState,
  worldIdMeStatus,
  type WorldIdGateInput,
  type WorldIdGateState,
} from "@/lib/legalBody/worldIdGate";
import { ApiError, type WorldIdMe } from "@/lib/api/types";

const row = (over: Partial<WorldIdMe> = {}): WorldIdMe => ({
  verified: true,
  required: true,
  credential: "orb",
  nullifier: "0xabc",
  ...over,
});

const input = (over: Partial<WorldIdGateInput> = {}): WorldIdGateInput => ({
  me: null,
  meStatus: "ok",
  requireRealHuman: false,
  forceRequired: false,
  ...over,
});

describe("worldIdGateState", () => {
  const cases: [string, WorldIdGateInput, WorldIdGateState][] = [
    ["the record is loading", input({ meStatus: "loading" }), { kind: "loading" }],
    ["the record could not be read", input({ meStatus: "error" }), { kind: "error" }],
    [
      "no World ID on this deployment, the wizard: a skip",
      input({ meStatus: "missing" }),
      { kind: "skip" },
    ],
    [
      "no World ID on this deployment, under forceRequired: a stop, not a skip",
      input({ meStatus: "missing", forceRequired: true }),
      { kind: "unavailable" },
    ],
    [
      "no row, required by the server",
      input({ me: row({ verified: false, required: true, credential: undefined }) }),
      { kind: "verify", required: true },
    ],
    [
      "no row, optional on the server",
      input({ me: row({ verified: false, required: false, credential: undefined }) }),
      { kind: "verify", required: false },
    ],
    [
      "no row, optional on the server but forceRequired",
      input({
        me: row({ verified: false, required: false, credential: undefined }),
        forceRequired: true,
      }),
      { kind: "verify", required: true },
    ],
    [
      "a waiver, the wizard: accepted, as today",
      input({ me: row({ credential: "waiver", realHuman: false }) }),
      { kind: "accepted", credential: "waiver" },
    ],
    [
      "a waiver under requireRealHuman: not accepted",
      input({ me: row({ credential: "waiver", realHuman: false }), requireRealHuman: true }),
      { kind: "not_accepted", credential: "waiver" },
    ],
    [
      "a real credential the real-human check accepts",
      input({ me: row({ credential: "orb", realHuman: true }), requireRealHuman: true }),
      { kind: "accepted", credential: "orb" },
    ],
    [
      "a real credential the real-human check refuses",
      input({ me: row({ credential: "passport", realHuman: false }), requireRealHuman: true }),
      { kind: "not_accepted", credential: "passport" },
    ],
    [
      "realHuman absent (an older backend) under requireRealHuman: not accepted",
      input({ me: row({ credential: "orb" }), requireRealHuman: true }),
      { kind: "not_accepted", credential: "orb" },
    ],
    [
      "realHuman absent, the wizard: accepted",
      input({ me: row({ credential: "orb" }) }),
      { kind: "accepted", credential: "orb" },
    ],
    [
      "a row with no credential named reads credential null",
      input({ me: row({ credential: undefined }) }),
      { kind: "accepted", credential: null },
    ],
  ];

  test.each(cases)("%s", (_name, given, expected) => {
    expect(worldIdGateState(given)).toEqual(expected);
  });

  test("the status decides before the row: a cached row does not hide a load, an error or a missing route", () => {
    const me = row();
    expect(worldIdGateState(input({ me, meStatus: "loading" }))).toEqual({ kind: "loading" });
    expect(worldIdGateState(input({ me, meStatus: "error" }))).toEqual({ kind: "error" });
    expect(worldIdGateState(input({ me, meStatus: "missing" }))).toEqual({ kind: "skip" });
  });

  test("ok with no record yet reads as loading, never as a decision", () => {
    expect(worldIdGateState(input({ me: null, meStatus: "ok" }))).toEqual({ kind: "loading" });
  });

  test("forceRequired changes nothing for a row on record", () => {
    expect(worldIdGateState(input({ me: row(), forceRequired: true }))).toEqual({
      kind: "accepted",
      credential: "orb",
    });
  });
});

describe("worldIdMeStatus", () => {
  const notFound = new ApiError(404, { code: "not_found", message: "Not found" });
  const failed = new ApiError(500, { code: "internal", message: "Something failed." });

  test("no record and no error: loading", () => {
    expect(worldIdMeStatus(null, null)).toBe("loading");
  });

  test("a record: ok", () => {
    expect(worldIdMeStatus(row(), null)).toBe("ok");
  });

  test("a 404 is a deployment without World ID, with or without a stale record", () => {
    expect(worldIdMeStatus(null, notFound)).toBe("missing");
    expect(worldIdMeStatus(row(), notFound)).toBe("missing");
  });

  test("any other failure with no record: error", () => {
    expect(worldIdMeStatus(null, failed)).toBe("error");
    expect(worldIdMeStatus(null, new Error("offline"))).toBe("error");
    expect(worldIdMeStatus(null, "not an error object")).toBe("error");
  });

  test("a failed refetch keeps the record it already has", () => {
    expect(worldIdMeStatus(row(), failed)).toBe("ok");
  });
});

describe("WorldIdStatusRow", () => {
  const html = (state: WorldIdGateState, notAcceptedSentence?: string) =>
    renderToString(createElement(WorldIdStatusRow, { state, notAcceptedSentence }));

  test("an accepted real credential: emerald, named", () => {
    const out = html({ kind: "accepted", credential: "orb" });
    expect(out).toContain("text-emerald-300");
    expect(out).not.toContain("text-amber-300");
    expect(out).toContain("Verified human");
    expect(out).toContain("orb</div>");
  });

  test("an accepted row with no credential named reads proof of personhood", () => {
    expect(html({ kind: "accepted", credential: null })).toContain("proof of personhood</div>");
  });

  test("an accepted waiver: amber, never a verified human", () => {
    const out = html({ kind: "accepted", credential: "waiver" });
    expect(out).toContain("text-amber-300");
    expect(out).not.toContain("text-emerald-300");
    expect(out).toContain("Guardian waiver on record");
    expect(out).not.toContain("Verified human ");
  });

  test("a row the gate refuses: amber, with the flow's own sentence", () => {
    const out = html({ kind: "not_accepted", credential: "orb" }, "Not accepted here.");
    expect(out).toContain("text-amber-300");
    expect(out).not.toContain("text-emerald-300");
    expect(out).toContain("Not accepted here.");
    expect(out).not.toContain("Verified human");
  });

  test("a refused row with no sentence given still renders amber", () => {
    expect(html({ kind: "not_accepted", credential: "waiver" })).toContain("text-amber-300");
    expect(html({ kind: "not_accepted", credential: "passport" })).toContain("text-amber-300");
  });

  test("no row, no line", () => {
    for (const state of [
      { kind: "loading" },
      { kind: "error" },
      { kind: "skip" },
      { kind: "unavailable" },
      { kind: "verify", required: true },
    ] as WorldIdGateState[]) {
      expect(html(state)).toBe("");
    }
  });
});
