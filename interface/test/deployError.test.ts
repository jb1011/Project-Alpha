/**
 * What the deploy step says when its poll goes wrong, and in which order.
 *
 * Two sources, one message: the entity the backend serves (whose `failed` status carries the
 * reason, or none), and the poll itself (which can fail to be read at all). A failed onboarding
 * outranks a poll error, because it is the answer the poll was waiting for; a poll error is shown
 * only while there is no such answer. Derived, not stored: the message goes away on its own when
 * the poll recovers.
 */
import { expect, test } from "vitest";
import { deployPollError } from "@/lib/onboarding/deployError";
import type { EntityView } from "@/lib/api/types";

const entity = (over: Partial<EntityView>): EntityView =>
  ({
    id: "ent_1",
    name: "Agent",
    status: "created",
    agentId: null,
    proxy: null,
    treasury: null,
    operator: null,
    manager: "0x1",
    guardian: "0x2",
    oaHash: null,
    metadataURI: null,
    createTxHash: null,
    bindTxHash: null,
    fundTxHash: null,
    error: null,
    perTxCap: null,
    trustPolicy: null,
    ...over,
  }) as EntityView;

test("nothing wrong reads as nothing: no entity, no poll error", () => {
  expect(deployPollError(null, null)).toBeNull();
  expect(deployPollError(entity({ status: "created" }), undefined)).toBeNull();
});

test("a failed onboarding shows the backend's reason", () => {
  expect(deployPollError(entity({ status: "failed", error: "registry refused" }), null)).toBe(
    "registry refused",
  );
});

test("a failed onboarding with no reason is still called a failure", () => {
  expect(deployPollError(entity({ status: "failed", error: null }), null)).toBe(
    "Onboarding failed.",
  );
});

test("a poll that cannot be read shows its message, or a plain fallback when it has none", () => {
  expect(deployPollError(entity({ status: "created" }), new Error("502 from upstream"))).toBe(
    "502 from upstream",
  );
  expect(deployPollError(null, new Error("Failed to fetch"))).toBe("Failed to fetch");
  expect(deployPollError(null, "not an Error")).toBe("Failed to poll entity status.");
  expect(deployPollError(null, { status: 500 })).toBe("Failed to poll entity status.");
});

test("THE ORDER: a failed onboarding outranks a poll error", () => {
  // The failure is the answer the poll was waiting for; a later read that failed must not hide it.
  expect(
    deployPollError(entity({ status: "failed", error: "registry refused" }), new Error("502")),
  ).toBe("registry refused");
  expect(deployPollError(entity({ status: "failed", error: null }), new Error("502"))).toBe(
    "Onboarding failed.",
  );
});

test("any other status defers to the poll error, and to nothing", () => {
  for (const status of ["pending", "provisioned", "translating", "created", "bound", "funded"] as const) {
    expect(deployPollError(entity({ status, error: "stale reason" }), null)).toBeNull();
    expect(deployPollError(entity({ status, error: "stale reason" }), new Error("502"))).toBe("502");
  }
});
