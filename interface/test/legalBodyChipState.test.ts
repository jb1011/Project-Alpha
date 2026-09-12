/**
 * The second question's claims ceiling, as a table.
 *
 * The AgentBook chip beside this one says whether a verified human vouched. This one says whether
 * Novi's own registry holds a legal body in good standing for the same address — a different
 * source, a different fact, and the pair is only useful while neither is rendered as evidence for
 * the other. So the assertions here are as much about what the chip may NOT say as about what it
 * does: no claim when there is nothing to look up, no claim built out of a failed read, and none
 * of D7's forbidden vocabulary ("verified company", "KYC", "licensed") anywhere at all.
 */
import { describe, expect, test } from "vitest";
import { legalBodyChipState, type LegalBodyView } from "@/lib/legalBody/chipState";
import type { LegalBodyLookup } from "@/lib/api/types";

const ADDRESS = "0xeE85Fd00521d1Aa4c510BDdAb78F375830119354";
const TRANSPARENCY = "https://www.novicorpus.com/transparency";

const ACTIVE = "Legal body active";
const PAUSED = "Legal body paused";
const COULD_NOT = "Could not check";

/** A body the route answered about, in whichever standing. */
const body = (
  standing: "active" | "inactive" | "unknown",
  over: Partial<Extract<LegalBodyLookup, { legalBody: true }>> = {},
): LegalBodyLookup => ({
  address: ADDRESS,
  legalBody: true,
  standing,
  agentId: "843704",
  publicId: "pub_1",
  name: "TestMB2",
  network: "testnet",
  links: { transparency: TRANSPARENCY, metadata: null },
  formation: null,
  checkedAt: "2026-09-11T00:00:00.000Z",
  ...over,
});

/** "Not one of ours" — a definitive answer, and still not a chip. */
const notABody: LegalBodyLookup = {
  address: ADDRESS,
  legalBody: false,
  standing: null,
  checkedAt: "2026-09-11T00:00:00.000Z",
};

/** The lookup could not be read at all: 400, 404, 429, 503, or no network. */
const unreadable: LegalBodyView = { unreadable: true };

describe("the table", () => {
  const cases: [string, LegalBodyView | null | undefined, { label: string; kind: string } | null][] =
    [
      ["standing active", body("active"), { label: ACTIVE, kind: "active" }],
      ["standing inactive", body("inactive"), { label: PAUSED, kind: "inactive" }],
      ["standing unknown", body("unknown"), { label: COULD_NOT, kind: "unknown" }],
      ["the lookup could not be read", unreadable, { label: COULD_NOT, kind: "unknown" }],
      ["not a legal body", notABody, null],
      ["no pocket / no query yet", undefined, null],
      ["no data", null, null],
    ];

  for (const [name, view, want] of cases) {
    test(`${name} → ${want ? `"${want.label}"` : "no chip"}`, () => {
      const state = legalBodyChipState(view);
      if (!want) {
        expect(state).toBeNull();
        return;
      }
      expect(state?.label).toBe(want.label);
      expect(state?.kind).toBe(want.kind);
    });
  }
});

test("an agent with no pocket gets NO chip: there is nothing to look up", () => {
  // The query is not even enabled without an address, so the chip's input is `undefined` — and
  // the honest rendering of "we did not ask" is silence, not "Could not check" (which claims we
  // tried) and certainly not a standing.
  expect(legalBodyChipState(undefined)).toBeNull();
  expect(legalBodyChipState(null)).toBeNull();
});

test("`legalBody: false` renders nothing, never a claim about the agent", () => {
  // It cannot happen for one of our own agents on its own dashboard: every one is an entity the
  // resolver knows. If it ever does, the likeliest cause is a lookup pointed at the wrong
  // address, and "Not a legal body" would be a statement about an agent built out of that.
  expect(legalBodyChipState(notABody)).toBeNull();
});

test("a failed read is 'could not check', with no link and no standing", () => {
  // 400, 404 (no resolver on this deployment), 429 (either rate budget) and 503 all arrive here.
  // None of them is an answer about the address (D8), so none of them may be rendered as one.
  const state = legalBodyChipState(unreadable);
  expect(state?.kind).toBe("unknown");
  expect(state?.label).toBe(COULD_NOT);
  expect(state?.title).toBe(
    "The chain could not be read; this says nothing about the body's standing.",
  );
  expect(state?.href).toBeUndefined();
  expect(state?.label).not.toBe(PAUSED);
});

test("`standing: \"unknown\"` is not a negative", () => {
  // A chain read that failed for a body we DO know about. The registry answer is still ours to
  // link to; what we cannot say is anything about its standing.
  const state = legalBodyChipState(body("unknown"));
  expect(state?.kind).toBe("unknown");
  expect(state?.label).not.toBe(PAUSED);
  expect(state?.label).not.toBe(ACTIVE);
  expect(state?.href).toBe(TRANSPARENCY);
});

test("the titles are the ones the design fixed, verbatim", () => {
  expect(legalBodyChipState(body("active"))?.title).toBe(
    "A registered legal body in good standing on Arc: its LegalManager is active and its treasury is not paused. Novi's registry, read from the chain.",
  );
  expect(legalBodyChipState(body("inactive"))?.title).toBe(
    "The legal body exists but is not in good standing right now: its treasury is paused or its LegalManager is not active.",
  );
});

test("the link is the lookup's own transparency url, never one composed here", () => {
  // A deployment that points strangers at a different host must point its owners there too: the
  // chip an owner clicks is the page their counterparties are told to read.
  const elsewhere = "https://staging.example.test/transparency";
  const state = legalBodyChipState(
    body("active", { links: { transparency: elsewhere, metadata: null } }),
  );
  expect(state?.href).toBe(elsewhere);
  expect(legalBodyChipState(body("active"))?.href).toBe(TRANSPARENCY);
});

test("nothing claims more than the chain carries, and nothing mentions AgentBook (D7)", () => {
  for (const view of [body("active"), body("inactive"), body("unknown"), unreadable]) {
    const state = legalBodyChipState(view);
    if (!state) continue;
    const copy = `${state.label} ${state.title}`.toLowerCase();
    for (const forbidden of [
      "verified company",
      "kyc",
      "licensed",
      "human-backed",
      "guarantee",
      // The two sources are separate on purpose: this chip must never imply AgentBook shows it.
      "agentbook",
    ]) {
      expect(copy).not.toContain(forbidden);
    }
    expect([ACTIVE, PAUSED, COULD_NOT]).toContain(state.label);
  }
});

test("an unrecognised standing from a newer backend reads as 'could not check'", () => {
  // Deploy-order safety, the same rule the AgentBook chip applies to an absent `outcome`: a value
  // this build has never heard of is "we were not told", never a claim.
  const future = body("active", {
    standing: "suspended" as unknown as "active",
  });
  const state = legalBodyChipState(future);
  expect(state?.kind).toBe("unknown");
  expect(state?.label).toBe(COULD_NOT);
});
