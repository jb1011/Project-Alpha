/**
 * The filing-environment vocabulary (design §2, the honesty invariant).
 *
 * These are the two failure directions the merge-gate review found, written as assertions. Both
 * came from one two-valued predicate — `formationEnvironment !== "production"` — being asked to
 * carry three facts, and both are the same bug seen from opposite ends: an UNKNOWN answer rendered
 * as a confident one.
 */
import { expect, test } from "vitest";
import {
  deriveFormationEnvironment,
  filingEnvironment,
  formationEnvironmentOf,
  isKnownEnvironment,
} from "@/lib/api/formationEnvironment";
import type { PublicConfig } from "@/lib/api/types";

const config = (over: Partial<PublicConfig> = {}): PublicConfig => ({
  walletProviderDefault: "circle",
  circleCustodyAvailable: true,
  ...over,
});

test("G1: a query still in flight is `loading` — never a guess at the environment", () => {
  expect(deriveFormationEnvironment({ data: undefined, isError: false })).toBe("loading");
});

test("G1: a FAILED /config is `unknown`, and unknown is not sandbox", () => {
  // The bug: a failed config collapsed to "sandbox", so the wizard offered a synthetic-identity
  // button and a "Skip — no legal filing" affordance on a deployment that allows neither.
  const environment = deriveFormationEnvironment({ data: undefined, isError: true });
  expect(environment).toBe("unknown");
  expect(isKnownEnvironment(environment)).toBe(false);
});

test("G1: a failed query holding STALE data is still `unknown`", () => {
  // react-query keeps the last successful data on a subsequent failure. A stale answer is not one
  // to make a filing claim on, so `isError` is checked before `data`.
  const environment = deriveFormationEnvironment({
    data: config({ formationAvailable: true, formationEnvironment: "production" }),
    isError: true,
  });
  expect(environment).toBe("unknown");
});

test("G1: an ABSENT environment field is `unknown`, not sandbox", () => {
  // A backend that predates the field, or one that reports `formationAvailable` without the
  // environment. Defaulting to "sandbox" here is how a real filing gets labelled a demo.
  expect(deriveFormationEnvironment({ data: config(), isError: false })).toBe("unknown");
  expect(
    deriveFormationEnvironment({
      data: config({ formationAvailable: true, formationEnvironment: null }),
      isError: false,
    }),
  ).toBe("unknown");
});

test("G1: only the two literal values produce a confident answer", () => {
  expect(deriveFormationEnvironment({ data: config({ formationEnvironment: "sandbox" }), isError: false })).toBe(
    "sandbox",
  );
  expect(
    deriveFormationEnvironment({ data: config({ formationEnvironment: "production" }), isError: false }),
  ).toBe("production");

  // A value from a backend newer than this build reads as unknown rather than as the safer-looking
  // of the two — this UI cannot describe an environment it has never heard of.
  expect(formationEnvironmentOf("staging")).toBe("unknown");
  expect(formationEnvironmentOf("Production")).toBe("unknown");
  expect(formationEnvironmentOf(null)).toBe("unknown");
  expect(formationEnvironmentOf(undefined)).toBe("unknown");
});

test("G1: isKnownEnvironment is the gate every consequential action sits behind", () => {
  expect(isKnownEnvironment("sandbox")).toBe(true);
  expect(isKnownEnvironment("production")).toBe(true);
  expect(isKnownEnvironment("loading")).toBe(false);
  expect(isKnownEnvironment("unknown")).toBe(false);
});

/* ── the filing's own environment, and what a retry has to retry (§7, A3) ──── */

test("A3: an agent with NO company reads the deployment, and retries /config", () => {
  // A deployment that can form entities still onboards agents that asked for no filing.
  for (const deployment of ["loading", "unknown", "sandbox", "production"] as const)
    expect(
      filingEnvironment({
        forming: false,
        deployment,
        company: { hasData: false, isError: false },
      }),
    ).toEqual({ environment: deployment, retryTarget: "config" });
});

test("A3: a FILING agent reads the COMPANY ROW, and the deployment cannot override it", () => {
  // The pin is stamped at creation and immutable after, so a company minted in sandbox stays a
  // sandbox filing on a box since re-pointed at production — which the deployment's own answer
  // would get exactly backwards.
  expect(
    filingEnvironment({
      forming: true,
      deployment: "production",
      company: { environment: "sandbox", hasData: true, isError: false },
    }),
  ).toEqual({ environment: "sandbox", retryTarget: "company" });
  expect(
    filingEnvironment({
      forming: true,
      deployment: "sandbox",
      company: { environment: "production", hasData: true, isError: false },
    }),
  ).toEqual({ environment: "production", retryTarget: "company" });
});

test("A3: a word from a newer backend is `unknown`, never a guess at `sandbox`", () => {
  expect(
    filingEnvironment({
      forming: true,
      deployment: "production",
      company: { environment: "staging", hasData: true, isError: false },
    }).environment,
  ).toBe("unknown");
});

test("A3: the RETRY targets the query that would actually change the answer", () => {
  // The bug: this screen read the company row while its Retry button refetched `/config`. On the
  // one screen where the button matters it refetched a query the screen was not using — the
  // spinner spun, and the blocked submit stayed blocked forever.
  expect(
    filingEnvironment({
      forming: true,
      deployment: "production",
      company: { hasData: false, isError: true },
    }),
  ).toEqual({ environment: "unknown", retryTarget: "company" });
  expect(
    filingEnvironment({
      forming: true,
      deployment: "production",
      company: { hasData: false, isError: false },
    }),
  ).toEqual({ environment: "loading", retryTarget: "company" });
  // …and both of those are NEUTRAL, so the confirm stays disabled while they hold.
  for (const env of ["loading", "unknown"] as const) expect(isKnownEnvironment(env)).toBe(false);
});
