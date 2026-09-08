/**
 * The claims ceiling, as a table.
 *
 * Every label here is a public statement about a real person: that a World ID verified human
 * vouched for an address, or that they did not. The live dashboard used to say "AgentBook ·
 * human-backed" in emerald off a single boolean — a claim the design forbids in those words, in
 * that colour, and (when a vouch is mid-flight) at that moment. This suite pins all 35
 * status × outcome combinations so no future edit can quietly widen what the chip asserts.
 */
import { describe, expect, test } from "vitest";
import { agentBookChipState } from "@/lib/agentbook/chipState";
import type { AgentBookRowStatus, AgentBookOutcome, AgentBookStatusView } from "@/lib/api/types";

const VOUCHED = "Vouched in AgentBook ↗";
const NOT_IN = "Not in AgentBook";
const COULD_NOT = "Could not check";
const DISPUTED = "Disputed in AgentBook";
const IN_FLIGHT = "Vouch submitted, checking the registry";

const FAILURE_COPY =
  "We could not confirm the registration. It may still have gone through; we are checking the registry and will update this.";

const view = (over: Partial<AgentBookStatusView> = {}): AgentBookStatusView => ({
  registered: false,
  address: "0x00000000000000000000000000000000000000a1",
  ...over,
});

const STATUSES: (AgentBookRowStatus | undefined)[] = [
  undefined,
  "pending",
  "submitted",
  "confirmed",
  "disputed",
  "failed",
  "expired",
];

const OUTCOMES: (AgentBookOutcome | undefined)[] = [
  undefined,
  "registered",
  "unregistered",
  "unknown",
  "disputed",
];

/** What the chain's answer alone says, for the statuses that defer to it. */
const BY_OUTCOME: Record<string, string> = {
  undefined: COULD_NOT,
  registered: VOUCHED,
  unregistered: NOT_IN,
  unknown: COULD_NOT,
  disputed: DISPUTED,
};

/** What OUR row says, for the statuses that answer on their own. */
const BY_STATUS: Partial<Record<AgentBookRowStatus, string>> = {
  pending: IN_FLIGHT,
  submitted: IN_FLIGHT,
  disputed: DISPUTED,
  failed: COULD_NOT,
};

describe("every status × outcome combination", () => {
  for (const status of STATUSES) {
    for (const outcome of OUTCOMES) {
      const expected =
        (status && BY_STATUS[status]) ?? BY_OUTCOME[String(outcome)];
      test(`status=${status ?? "none"} outcome=${outcome ?? "none"} → "${expected}"`, () => {
        const state = agentBookChipState(
          view({ status, outcome, registered: outcome === "registered" }),
        );
        expect(state?.label).toBe(expected);
      });
    }
  }
});

test("a submitted vouch is never rendered as a terminal answer (§5.2)", () => {
  // The chain honestly reads "no entry" until the transaction is mined. Saying "Not in AgentBook"
  // there tells someone a permanent public statement about them did not happen, while it is
  // happening.
  for (const status of ["pending", "submitted"] as const) {
    for (const outcome of OUTCOMES) {
      const label = agentBookChipState(view({ status, outcome }))?.label;
      expect(label).toBe(IN_FLIGHT);
      expect(label).not.toBe(NOT_IN);
    }
  }
});

test("a failed submit shows §5.2's copy verbatim, as visible text and not only on hover", () => {
  const state = agentBookChipState(view({ status: "failed", errorCode: "InvalidNullifier" }));
  expect(state?.kind).toBe("failed");
  expect(state?.label).toBe(COULD_NOT);
  expect(state?.note).toBe(FAILURE_COPY);
  expect(state?.title).toBe(FAILURE_COPY);
  expect(state?.label).not.toBe(NOT_IN);
});

test("an agent with no payment address gets NO chip at all", () => {
  expect(agentBookChipState(view({ reason: "no-pocket-yet", address: undefined }))).toBeNull();
  expect(agentBookChipState(null)).toBeNull();
  expect(agentBookChipState(undefined)).toBeNull();
});

test("an absent outcome is 'could not check', never a vouch — even with registered: true", () => {
  // An older backend that predates `outcome` has told us nothing we may make a public claim on.
  const state = agentBookChipState(view({ registered: true, humanId: "0xhuman" }));
  expect(state?.label).toBe(COULD_NOT);
  expect(state?.kind).toBe("unknown");
});

test("a disputed row outranks a registered outcome", () => {
  const state = agentBookChipState(view({ registered: true, outcome: "registered", disputed: true }));
  expect(state?.label).toBe(DISPUTED);
});

test("an expired row falls back to the chain, exactly like no row", () => {
  expect(agentBookChipState(view({ status: "expired", outcome: "unregistered" }))?.label).toBe(NOT_IN);
  expect(agentBookChipState(view({ status: "expired", outcome: "registered" }))?.label).toBe(VOUCHED);
});

test("the vouched chip links to World Chain — the transaction when there is one, else the address", () => {
  expect(
    agentBookChipState(view({ registered: true, outcome: "registered", txHash: "0xdeadbeef" }))?.href,
  ).toBe("https://worldscan.org/tx/0xdeadbeef");
  expect(
    agentBookChipState(view({ registered: true, outcome: "registered", txHash: null }))?.href,
  ).toBe("https://worldscan.org/address/0x00000000000000000000000000000000000000a1");
  expect(
    agentBookChipState(
      view({ registered: true, outcome: "registered", address: undefined }),
    )?.href,
  ).toBeUndefined();
});

test("no label anywhere claims 'human-backed', and only the vouch links out", () => {
  for (const status of STATUSES) {
    for (const outcome of OUTCOMES) {
      const state = agentBookChipState(view({ status, outcome, txHash: "0xabc" }));
      if (!state) continue;
      expect(state.label.toLowerCase()).not.toContain("human-backed");
      expect(state.label.toLowerCase()).not.toContain("proves");
      expect([VOUCHED, NOT_IN, COULD_NOT, DISPUTED, IN_FLIGHT]).toContain(state.label);
      if (state.kind !== "vouched") expect(state.href).toBeUndefined();
    }
  }
});
