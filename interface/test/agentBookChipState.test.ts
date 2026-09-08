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

/** The agent's own payment address — the thing AgentBook is asked about, and the thing the chip
 *  must never link to (it has no World Chain history of its own). */
const ADDRESS = "0x00000000000000000000000000000000000000a1";

const view = (over: Partial<AgentBookStatusView> = {}): AgentBookStatusView => ({
  registered: false,
  address: ADDRESS,
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
        // The one place the chain overrules our row: a failed submit whose registration the
        // registry can nonetheless see.
        status === "failed" && outcome === "registered"
          ? VOUCHED
          : (status && BY_STATUS[status]) ?? BY_OUTCOME[String(outcome)];
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

test("a failed row does not outlive the registry: a live 'registered' still reads as vouched", () => {
  // The failure copy says out loud that the transaction may still have gone through. Once the
  // chain says it did, repeating "could not check" is the false statement.
  const state = agentBookChipState(
    view({ status: "failed", registered: true, outcome: "registered", errorCode: "replaced" }),
  );
  expect(state?.label).toBe(VOUCHED);
  expect(state?.note).toBeUndefined();
});

test("an agent with no payment address gets NO chip at all", () => {
  expect(agentBookChipState(view({ reason: "no-pocket-yet", address: undefined }))).toBeNull();
  expect(agentBookChipState(null)).toBeNull();
  expect(agentBookChipState(undefined)).toBeNull();
});

test("a live row still speaks even when the view claims there is no address yet", () => {
  // Ordering guard, not a real backend shape: `reason` must never suppress a vouch that is in
  // flight. Silence at that moment is the same false "it didn't happen" §5.2 forbids.
  const state = agentBookChipState(view({ status: "pending", reason: "no-pocket-yet" }));
  expect(state?.label).toBe(IN_FLIGHT);
  expect(state).not.toBeNull();
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

test("the vouched chip links to the transaction, or to AgentBook itself — never to the pocket", () => {
  // The pocket has no World Chain history: Novi Corpus sends the registration, so the pocket's
  // address page there is empty. An empty page is a worse answer than the registry it is in.
  const pocketPage = `https://worldscan.org/address/${ADDRESS}`;
  expect(
    agentBookChipState(view({ registered: true, outcome: "registered", txHash: "0xdeadbeef" }))?.href,
  ).toBe("https://worldscan.org/tx/0xdeadbeef");
  for (const view_ of [
    view({ registered: true, outcome: "registered", txHash: null }),
    view({ registered: true, outcome: "registered", address: undefined }),
  ]) {
    const href = agentBookChipState(view_)?.href;
    expect(href).toBe("https://worldscan.org/address/0xA23aB2712eA7BBa896930544C7d6636a96b944dA");
    expect(href).not.toBe(pocketPage);
  }
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
