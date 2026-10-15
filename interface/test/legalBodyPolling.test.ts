/**
 * When the legal-body screens ask the server again, as tables. Every answer is a function of its
 * inputs: the times come in as numbers, nothing here reads a clock, and the screen calls the plan
 * once per tick. React StrictMode runs an effect twice, so the refresh plan is tested against the
 * second run as well: once a refresh is recorded, the same tick never asks for another one.
 */
import { describe, expect, test } from "vitest";
import { BINDING_STATES, type BindingState } from "@/lib/api/types";
import type { CompanyStep } from "@/lib/legalBody/flow";
import {
  COMPANY_POLL_MS,
  REFRESH_RETRY_MS,
  REFRESH_WINDOW_MS,
  RESERVED_POLL_MS,
  companyPollInterval,
  orderPollInterval,
  refreshPlan,
  type RefreshAction,
} from "@/lib/legalBody/polling";

/** The one clock of this file: the moment the pointer transaction was confirmed. */
const START = Date.parse("2026-10-12T12:00:00Z");
const SECOND = 1_000;

/** Fails `tsc` when the company screen gains a step the list below leaves out. */
type Exhaustive<Missing extends never> = Missing;
const STEPS = [
  "form",
  "loading",
  "evidence",
  "waiting",
  "failed",
  "revoked",
] as const satisfies readonly CompanyStep[];
export type CompanyStepsAreExhaustive = Exhaustive<Exclude<CompanyStep, (typeof STEPS)[number]>>;

describe("the four intervals", () => {
  test("are the exact values of the flow", () => {
    expect(RESERVED_POLL_MS).toBe(5_000);
    expect(REFRESH_RETRY_MS).toBe(30_000);
    expect(REFRESH_WINDOW_MS).toBe(120_000);
    expect(COMPANY_POLL_MS).toBe(60_000);
  });
});

describe("orderPollInterval", () => {
  const EXPECTED: Record<BindingState, number | false> = {
    draft: false,
    reserved: 5_000,
    deployed: false,
    linked: false,
    broken: false,
    lapsed: false,
    superseded: false,
    abandoned: false,
  };

  test("the table names each of the eight states", () => {
    expect(Object.keys(EXPECTED).sort()).toStrictEqual([...BINDING_STATES].sort());
  });

  test.each(BINDING_STATES.map((s) => [s, EXPECTED[s]] as const))(
    "%s polls at %s",
    (state, interval) => {
      expect(orderPollInterval(state)).toBe(interval);
    },
  );
});

describe("refreshPlan", () => {
  type Plan = Parameters<typeof refreshPlan>[0];
  const plan = (over: Partial<Plan> = {}): Plan => ({
    refreshes: 0,
    startedAtMs: START,
    lastRefreshAtMs: null,
    nowMs: START,
    state: "deployed",
    ...over,
  });

  test("refreshes at once after the pointer transaction", () => {
    expect(refreshPlan(plan())).toBe("refresh");
    expect(refreshPlan(plan({ state: "broken" }))).toBe("refresh");
  });

  test("waits 10 s after the first refresh", () => {
    expect(
      refreshPlan(plan({ refreshes: 1, lastRefreshAtMs: START, nowMs: START + 10 * SECOND })),
    ).toBe("wait");
  });

  test("refreshes again 30 s after the first", () => {
    expect(
      refreshPlan(plan({ refreshes: 1, lastRefreshAtMs: START, nowMs: START + 30 * SECOND })),
    ).toBe("refresh");
  });

  test("makes four refreshes inside two minutes while not linked, then stops", () => {
    let refreshes = 0;
    let lastRefreshAtMs: number | null = null;
    const at: number[] = [];
    const answers: RefreshAction[] = [];
    for (let nowMs = START; nowMs <= START + 300 * SECOND; nowMs += SECOND) {
      const action = refreshPlan(plan({ refreshes, lastRefreshAtMs, nowMs }));
      answers.push(action);
      if (action === "refresh") {
        refreshes += 1;
        lastRefreshAtMs = nowMs;
        at.push((nowMs - START) / SECOND);
      }
    }
    expect(at).toStrictEqual([0, 30, 60, 90]);
    expect(refreshes).toBe(4);
    // From the end of the window on, every tick says stop.
    expect(new Set(answers.slice(120))).toStrictEqual(new Set<RefreshAction>(["stop"]));
  });

  test("a late first refresh still leaves at most four inside the window", () => {
    let refreshes = 0;
    let lastRefreshAtMs: number | null = null;
    // The screen's first tick comes 7 s after the confirmation.
    for (let nowMs = START + 7 * SECOND; nowMs <= START + 300 * SECOND; nowMs += SECOND) {
      if (refreshPlan(plan({ refreshes, lastRefreshAtMs, nowMs })) === "refresh") {
        refreshes += 1;
        lastRefreshAtMs = nowMs;
      }
    }
    expect(refreshes).toBe(4);
  });

  test("linked stops at once", () => {
    expect(refreshPlan(plan({ state: "linked" }))).toBe("stop");
    expect(
      refreshPlan(
        plan({
          state: "linked",
          refreshes: 1,
          lastRefreshAtMs: START,
          nowMs: START + 30 * SECOND,
        }),
      ),
    ).toBe("stop");
  });

  test("a broken state after the window stops", () => {
    expect(
      refreshPlan(
        plan({
          state: "broken",
          refreshes: 4,
          lastRefreshAtMs: START + 90 * SECOND,
          nowMs: START + REFRESH_WINDOW_MS,
        }),
      ),
    ).toBe("stop");
    expect(
      refreshPlan(plan({ state: "broken", nowMs: START + REFRESH_WINDOW_MS + 60 * SECOND })),
    ).toBe("stop");
  });

  test("a state the pointer cannot lead to linked stops at once", () => {
    for (const state of ["draft", "reserved", "lapsed", "superseded", "abandoned"] as const) {
      expect(refreshPlan(plan({ state }))).toBe("stop");
    }
  });

  test("never refreshes from refreshes 0 with a refresh already recorded", () => {
    // The second run of a StrictMode effect: the first run recorded its refresh, the count has not
    // caught up yet. Whatever the time and the state, no second refresh.
    for (const state of BINDING_STATES) {
      for (let dt = -10 * SECOND; dt <= 200 * SECOND; dt += SECOND) {
        const answer = refreshPlan(
          plan({ state, refreshes: 0, lastRefreshAtMs: START, nowMs: START + dt }),
        );
        expect(answer).not.toBe("refresh");
      }
    }
  });

  test("never refreshes when a count has no recorded time", () => {
    for (let dt = 0; dt <= 200 * SECOND; dt += SECOND) {
      expect(
        refreshPlan(plan({ refreshes: 1, lastRefreshAtMs: null, nowMs: START + dt })),
      ).not.toBe("refresh");
    }
  });

  test("never refreshes before 30 s have passed since the last refresh", () => {
    for (let dt = 0; dt < REFRESH_RETRY_MS; dt += SECOND) {
      expect(
        refreshPlan(
          plan({ refreshes: 2, lastRefreshAtMs: START + 30 * SECOND, nowMs: START + 30 * SECOND + dt }),
        ),
      ).toBe("wait");
    }
  });

  test("the same inputs give the same answer, however often it is asked", () => {
    const inputs = plan({ refreshes: 1, lastRefreshAtMs: START, nowMs: START + 45 * SECOND });
    const first = refreshPlan(inputs);
    expect(refreshPlan({ ...inputs })).toBe(first);
    expect(refreshPlan({ ...inputs })).toBe(first);
  });
});

describe("companyPollInterval", () => {
  test("waiting on production polls every 60 s", () => {
    expect(companyPollInterval("waiting", "production")).toBe(60_000);
  });

  test("waiting on sandbox does not poll", () => {
    expect(companyPollInterval("waiting", "sandbox")).toBe(false);
  });

  test.each(STEPS.filter((s) => s !== "waiting"))("%s polls on neither environment", (step) => {
    expect(companyPollInterval(step, "production")).toBe(false);
    expect(companyPollInterval(step, "sandbox")).toBe(false);
  });
});
