/**
 * The claims ceiling, as a table.
 *
 * Every label here is a public statement about a real person: that a World ID verified human
 * vouched for an address, or that they did not. The live dashboard used to say "AgentBook ·
 * human-backed" in emerald off a single boolean — a claim the design forbids in those words, in
 * that colour, and (when a vouch is mid-flight) at that moment. This suite pins all 70
 * status × outcome × txHash combinations so no future edit can quietly widen what the chip asserts.
 *
 * Two final-review rulings are pinned here rather than described:
 *
 * - **FR-A**: a `failed` row's own `txHash` is NEVER the vouch link. Once the registry says
 *   "registered", the link goes to the AgentBook contract page, because the hash on a failed row
 *   is a reverted or never-mined transaction; and `failed` + `disputed` renders as Disputed by the
 *   same registry-outranks-the-row rule.
 * - **FR-B**: a `pending` row is awaiting the guardian's approval in World App — nothing has been
 *   submitted — so it falls through to the chain's answer. Only `submitted` wears the in-flight
 *   label.
 */
import { describe, expect, test } from "vitest";
import { agentBookChipState } from "@/lib/agentbook/chipState";
import type { AgentBookRowStatus, AgentBookOutcome, AgentBookStatusView } from "@/lib/api/types";

const VOUCHED = "Vouched in AgentBook ↗";
const NOT_IN = "Not in AgentBook";
const COULD_NOT = "Could not check";
const DISPUTED = "Disputed in AgentBook";
const IN_FLIGHT = "Vouch submitted, checking the registry";

const CONTRACT_PAGE = "https://worldscan.org/address/0xA23aB2712eA7BBa896930544C7d6636a96b944dA";

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
const BY_OUTCOME: Record<string, { label: string; kind: string }> = {
  undefined: { label: COULD_NOT, kind: "unknown" },
  registered: { label: VOUCHED, kind: "vouched" },
  unregistered: { label: NOT_IN, kind: "not-registered" },
  unknown: { label: COULD_NOT, kind: "unknown" },
  disputed: { label: DISPUTED, kind: "disputed" },
};

/** The whole precedence rule, written once as the table's oracle. */
function expected(
  status: AgentBookRowStatus | undefined,
  outcome: AgentBookOutcome | undefined,
  txHash: string | null,
): { label: string; kind: string } {
  const chain = BY_OUTCOME[String(outcome)];
  switch (status) {
    // FR-B: only a submitted row has been submitted.
    case "submitted":
      return { label: IN_FLIGHT, kind: "submitting" };
    case "disputed":
      return { label: DISPUTED, kind: "disputed" };
    case "failed":
      // FR-A: the registry outranks the row, in both directions.
      if (outcome === "registered" || outcome === "disputed") return chain;
      // Nothing was broadcast under a hash we know of, so there is no submission to be unsure
      // about: the chain's answer is the whole answer.
      if (txHash === null) return chain;
      return { label: COULD_NOT, kind: "failed" };
    default:
      // undefined, pending, confirmed, expired — the chain answers.
      return chain;
  }
}

describe("every status × outcome combination, with and without a transaction hash", () => {
  for (const txHash of [null, "0xabc"]) {
    for (const status of STATUSES) {
      for (const outcome of OUTCOMES) {
        const want = expected(status, outcome, txHash);
        test(`status=${status ?? "none"} outcome=${outcome ?? "none"} tx=${txHash ?? "none"} → "${want.label}"`, () => {
          const state = agentBookChipState(
            view({ status, outcome, txHash, registered: outcome === "registered" }),
          );
          expect(state?.label).toBe(want.label);
          expect(state?.kind).toBe(want.kind);
        });
      }
    }
  }
});

test("only a SUBMITTED row is rendered as in flight (FR-B)", () => {
  // The chain honestly reads "no entry" until the transaction is mined. Saying "Not in AgentBook"
  // there tells someone a permanent public statement about them did not happen, while it is
  // happening.
  for (const outcome of OUTCOMES) {
    const label = agentBookChipState(view({ status: "submitted", outcome }))?.label;
    expect(label).toBe(IN_FLIGHT);
    expect(label).not.toBe(NOT_IN);
  }
});

test("a pending row is awaiting approval, not submitted: it defers to the chain (FR-B)", () => {
  // Opening a session inserts a `pending` row before the guardian has seen a QR code, let alone
  // approved anything. Claiming "Vouch submitted" there is the false "it did happen" §5.2 forbids
  // — and it survives a declined or abandoned dialog for the whole session TTL.
  expect(agentBookChipState(view({ status: "pending", outcome: "unregistered" }))?.label).toBe(
    NOT_IN,
  );
  expect(agentBookChipState(view({ status: "pending", outcome: "unknown" }))?.label).toBe(COULD_NOT);
  const vouched = agentBookChipState(
    view({ status: "pending", outcome: "registered", registered: true, txHash: "0xabc" }),
  );
  expect(vouched?.label).toBe(VOUCHED);
  // The pending row's hash (there is none yet) is never the link, and neither is a stale one.
  expect(vouched?.href).toBe(CONTRACT_PAGE);
});

test("a failed submit shows §5.2's copy verbatim, as visible text and not only on hover", () => {
  const state = agentBookChipState(
    view({ status: "failed", errorCode: "InvalidNullifier", txHash: "0xabc" }),
  );
  expect(state?.kind).toBe("failed");
  expect(state?.label).toBe(COULD_NOT);
  expect(state?.note).toBe(FAILURE_COPY);
  expect(state?.title).toBe(FAILURE_COPY);
  expect(state?.label).not.toBe(NOT_IN);
});

test("a failed row with no transaction hash defers to the chain (FR-B)", () => {
  // `proof_rejected` and the refusals above it now leave the row `failed` without ever having
  // broadcast anything. There is no submission whose fate is unknown, so "it may still have gone
  // through" would be the false half of §5.2's sentence.
  const state = agentBookChipState(
    view({ status: "failed", txHash: null, outcome: "unregistered", errorCode: "InvalidNonce" }),
  );
  expect(state?.label).toBe(NOT_IN);
  expect(state?.kind).toBe("not-registered");
  expect(state?.note).toBeUndefined();
});

test("a failed row does not outlive the registry: a live 'registered' still reads as vouched", () => {
  // The failure copy says out loud that the transaction may still have gone through. Once the
  // chain says it did, repeating "could not check" is the false statement.
  const state = agentBookChipState(
    view({
      status: "failed",
      registered: true,
      outcome: "registered",
      errorCode: "replaced",
      txHash: "0xdeadbeef",
    }),
  );
  expect(state?.label).toBe(VOUCHED);
  expect(state?.note).toBeUndefined();
  // FR-A: the failed row's own hash is a reverted (or never-mined) transaction. Linking "Vouched
  // in AgentBook" to it presents a transaction that did not write the vouch as the one that did.
  expect(state?.href).toBe(CONTRACT_PAGE);
  expect(state?.href).not.toBe("https://worldscan.org/tx/0xdeadbeef");
});

test("a failed row the registry says is disputed reads as disputed (FR-A)", () => {
  const state = agentBookChipState(
    view({ status: "failed", outcome: "disputed", errorCode: "reverted", txHash: "0xdeadbeef" }),
  );
  expect(state?.label).toBe(DISPUTED);
  expect(state?.kind).toBe("disputed");
  expect(state?.href).toBeUndefined();
});

test("an agent with no payment address gets NO chip at all", () => {
  expect(agentBookChipState(view({ reason: "no-pocket-yet", address: undefined }))).toBeNull();
  expect(agentBookChipState(null)).toBeNull();
  expect(agentBookChipState(undefined)).toBeNull();
});

test("a live row still speaks even when the view claims there is no address yet", () => {
  // Ordering guard, not a real backend shape: `reason` must never suppress a vouch that is in
  // flight. Silence at that moment is the same false "it didn't happen" §5.2 forbids.
  const state = agentBookChipState(view({ status: "submitted", reason: "no-pocket-yet" }));
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

test("the vouched chip links to the transaction ONLY from a confirmed row (FR-A)", () => {
  // The pocket has no World Chain history: Novi Corpus sends the registration, so the pocket's
  // address page there is empty. An empty page is a worse answer than the registry it is in — and
  // a hash from a row that did NOT confirm is worse still, because it is a transaction that did
  // not write the vouch, presented as the one that did.
  const pocketPage = `https://worldscan.org/address/${ADDRESS}`;
  expect(
    agentBookChipState(
      view({ status: "confirmed", registered: true, outcome: "registered", txHash: "0xdeadbeef" }),
    )?.href,
  ).toBe("https://worldscan.org/tx/0xdeadbeef");
  for (const view_ of [
    view({ registered: true, outcome: "registered", txHash: null }),
    view({ registered: true, outcome: "registered", address: undefined }),
    // Not confirmed: the hash is not the vouch, whatever the row says.
    view({ status: "failed", registered: true, outcome: "registered", txHash: "0xdeadbeef" }),
    view({ status: "expired", registered: true, outcome: "registered", txHash: "0xdeadbeef" }),
    view({ status: "pending", registered: true, outcome: "registered", txHash: "0xdeadbeef" }),
  ]) {
    const href = agentBookChipState(view_)?.href;
    expect(href).toBe(CONTRACT_PAGE);
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
