/**
 * The external track-record card (design 2026-10-23, section 4.6): every state, every string, and
 * the two rules that hold in all of them (a figure always names its source; a failed read is never
 * a zero), plus the copy guard and the link guard.
 */
import { describe, expect, test } from "vitest";
import type { ExternalRecordView } from "../src/lib/api/types";
import {
  type CardInput,
  externalRecordCardModel,
  formatMoveBps,
  NOT_ADVICE,
} from "../src/lib/externalRecord/cardModel";

const WALLET = "0x33F283b1d6e9a12b0F79289C75617E6c0f56Aff8" as const;
const LINK = `https://app.aevumprotocol.io/check/${WALLET}`;
const DAY = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function view(over: Partial<ExternalRecordView> = {}): ExternalRecordView {
  return {
    provider: { name: "Aevum", recordUrl: LINK },
    agentId: "895447",
    chain: {
      status: "ok",
      graded: 2,
      correct: 1,
      wrong: 1,
      unrecognised: 0,
      lastGradedAt: "2026-11-02T15:16:00.000Z",
    },
    record: {
      status: "ok",
      lockingWallet: WALLET,
      graded: 2,
      correct: 1,
      wrong: 1,
      worstMoveBps: -314,
    },
    agreement: "match",
    network: "testnet",
    checkedAt: "2026-11-03T10:00:00.000Z",
    ...over,
  };
}

const model = (input: CardInput) => externalRecordCardModel(input, "Aevum", DAY);
const ready = (v: ExternalRecordView) => model({ phase: "ready", view: v });

describe("formatMoveBps", () => {
  test.each([
    [-314, "-3.14%"],
    [120, "+1.20%"],
    [0, "0.00%"],
    [-5, "-0.05%"],
  ])("%d bps is %s", (bps, text) => {
    expect(formatMoveBps(bps)).toBe(text);
  });
});

describe("the card", () => {
  test("every state carries the title, the intro and the sandbox line", () => {
    for (const m of [model({ phase: "loading" }), model({ phase: "failed" }), ready(view())]) {
      expect(m.title).toBe("Independent track record");
      expect(m.intro).toBe(
        "Market calls graded by Aevum and posted to this agent's ERC-8004 identity on Arc testnet. Independent record of outcomes, not advice.",
      );
      expect(m.sandbox).toBe("Arc testnet. Test agent, test calls.");
    }
  });

  test("loading", () => {
    expect(model({ phase: "loading" })).toMatchObject({
      state: "loading",
      status: "Reading the record…",
      figures: [],
      retry: false,
      link: null,
    });
  });

  test("the request failed: one sentence and a retry, no figures", () => {
    expect(model({ phase: "failed" })).toMatchObject({
      state: "failed",
      status: "Could not read the record just now.",
      figures: [],
      retry: true,
    });
  });

  test("two graded calls: every figure with its source, and the link", () => {
    const m = ready(view());
    expect(m.status).toBeNull();
    expect(m.figures).toEqual([
      { label: "Graded calls", value: "2", source: "posted on Arc" },
      { label: "Correct", value: "1", source: "posted on Arc" },
      { label: "Wrong", value: "1", source: "posted on Arc" },
      { label: "Worst result", value: "-3.14%", source: "Aevum's record" },
      { label: "Last graded", value: "2026-11-02", source: "Arc explorer" },
    ]);
    expect(m.notices).toEqual([]);
    expect(m.link).toEqual({ href: LINK, label: "See the full record on Aevum" });
    expect(m.retry).toBe(false);
  });

  test("three graded calls: the copy follows the count", () => {
    const m = ready(
      view({
        chain: {
          status: "ok",
          graded: 3,
          correct: 2,
          wrong: 1,
          unrecognised: 0,
          lastGradedAt: "2026-11-10T16:00:00.000Z",
        },
        record: {
          status: "ok",
          lockingWallet: WALLET,
          graded: 3,
          correct: 2,
          wrong: 1,
          worstMoveBps: -314,
        },
      }),
    );
    expect(m.figures.slice(0, 3).map((f) => f.value)).toEqual(["3", "2", "1"]);
  });

  test("one graded call is singular", () => {
    const m = ready(
      view({
        chain: {
          status: "ok",
          graded: 1,
          correct: 1,
          wrong: 0,
          unrecognised: 0,
          lastGradedAt: "2026-11-02T15:16:00.000Z",
        },
        record: {
          status: "ok",
          lockingWallet: WALLET,
          graded: 1,
          correct: 1,
          wrong: 0,
          worstMoveBps: 120,
        },
      }),
    );
    expect(m.figures[0]).toEqual({ label: "Graded call", value: "1", source: "posted on Arc" });
    expect(m.figures[3]).toEqual({ label: "Worst result", value: "+1.20%", source: "Aevum's record" });
  });

  test("nothing graded yet: a sentence, no figures, the link kept", () => {
    const m = ready(
      view({
        chain: {
          status: "ok",
          graded: 0,
          correct: 0,
          wrong: 0,
          unrecognised: 0,
          lastGradedAt: null,
        },
        record: {
          status: "ok",
          lockingWallet: WALLET,
          graded: 0,
          correct: 0,
          wrong: 0,
          worstMoveBps: null,
        },
      }),
    );
    expect(m.status).toBe("No graded calls posted yet.");
    expect(m.figures).toEqual([]);
    expect(m.link?.href).toBe(LINK);
    expect(m.retry).toBe(false);
  });

  test("the chain could not be read: say so, retry, and the provider's figures under its name", () => {
    const m = ready(view({ chain: { status: "unavailable", reason: "rpc" }, agreement: "unknown" }));
    expect(m.status).toBe("Could not read Arc just now.");
    expect(m.retry).toBe(true);
    expect(m.figures).toEqual([
      { label: "Graded calls", value: "2", source: "Aevum's record" },
      { label: "Correct", value: "1", source: "Aevum's record" },
      { label: "Wrong", value: "1", source: "Aevum's record" },
      { label: "Worst result", value: "-3.14%", source: "Aevum's record" },
    ]);
  });

  test("both halves failed: no figure at all, never a zero", () => {
    const m = ready(
      view({
        chain: { status: "unavailable", reason: "rpc" },
        record: { status: "unavailable", reason: "timeout", lockingWallet: WALLET },
        agreement: "unknown",
      }),
    );
    expect(m.figures).toEqual([]);
    expect(m.status).toBe("Could not read Arc just now.");
    expect(m.retry).toBe(true);
  });

  test("the record could not be read: counts and date kept, worst result unavailable", () => {
    const m = ready(
      view({
        record: { status: "unavailable", reason: "http", lockingWallet: WALLET },
        agreement: "unknown",
        provider: { name: "Aevum", recordUrl: null },
      }),
    );
    expect(m.figures.find((f) => f.label === "Worst result")).toEqual({
      label: "Worst result",
      value: "unavailable",
      source: "Aevum's record could not be read",
    });
    expect(m.figures.find((f) => f.label === "Graded calls")?.value).toBe("2");
    expect(m.retry).toBe(true);
    expect(m.link).toBeNull();
  });

  test("nothing graded and the record could not be read: the failure is still said", () => {
    const m = ready(
      view({
        chain: {
          status: "ok",
          graded: 0,
          correct: 0,
          wrong: 0,
          unrecognised: 0,
          lastGradedAt: null,
        },
        record: { status: "unavailable", reason: "timeout", lockingWallet: WALLET },
        agreement: "unknown",
      }),
    );
    expect(m.notices).toEqual(["Aevum's record could not be read just now."]);
    expect(m.retry).toBe(true);
  });

  test("the identity names no wallet: counts kept, a notice, no worst result", () => {
    const m = ready(
      view({
        record: { status: "not_linked" },
        agreement: "unknown",
        provider: { name: "Aevum", recordUrl: null },
      }),
    );
    expect(m.notices).toEqual(["This identity names no Aevum wallet."]);
    expect(m.figures.map((f) => f.label)).toEqual([
      "Graded calls",
      "Correct",
      "Wrong",
      "Last graded",
    ]);
    expect(m.link).toBeNull();
  });

  test("the explorer did not answer: date unavailable, the counts unaffected", () => {
    const m = ready(
      view({
        chain: {
          status: "ok",
          graded: 2,
          correct: 1,
          wrong: 1,
          unrecognised: 0,
          lastGradedAt: null,
        },
      }),
    );
    expect(m.figures.find((f) => f.label === "Last graded")).toEqual({
      label: "Last graded",
      value: "date unavailable",
      source: "Arc explorer",
    });
  });

  test("the halves disagree: the chain's counts, and one sentence naming both", () => {
    const m = ready(
      view({
        record: {
          status: "ok",
          lockingWallet: WALLET,
          graded: 3,
          correct: 2,
          wrong: 1,
          worstMoveBps: -314,
        },
        agreement: "differ",
      }),
    );
    expect(m.figures[0]?.value).toBe("2");
    expect(m.notices).toEqual([
      "Aevum's record lists 3 graded calls; 2 are posted on Arc for this agent.",
    ]);
  });

  test("entries the card cannot read are counted apart and said", () => {
    const one = ready(
      view({
        chain: {
          status: "ok",
          graded: 2,
          correct: 1,
          wrong: 1,
          unrecognised: 1,
          lastGradedAt: "2026-11-02T15:16:00.000Z",
        },
      }),
    );
    expect(one.notices).toEqual(["1 entry in a format this card does not read."]);
  });

  test("a failed refresh keeps the previous figures, says they may be old, and offers a retry", () => {
    const m = model({ phase: "ready", view: view(), refreshFailed: true });
    expect(m.figures[0]?.value).toBe("2");
    expect(m.notices).toEqual(["Could not refresh just now; these figures may be out of date."]);
    expect(m.retry).toBe(true);
  });

  test.each([
    ["http", "http://app.aevumprotocol.io/check/x"],
    ["javascript", "javascript:alert(1)"],
    ["not a URL", "check/x"],
  ])("never links to %s", (_label, recordUrl) => {
    expect(ready(view({ provider: { name: "Aevum", recordUrl } })).link).toBeNull();
  });
});

describe("the copy", () => {
  const STATES: CardInput[] = [
    { phase: "loading" },
    { phase: "failed" },
    { phase: "ready", view: view() },
    { phase: "ready", view: view({ chain: { status: "unavailable", reason: "rpc" } }) },
    {
      phase: "ready",
      view: view({
        record: { status: "unavailable", reason: "http", lockingWallet: WALLET },
        agreement: "unknown",
      }),
    },
    { phase: "ready", view: view({ record: { status: "not_linked" }, agreement: "unknown" }) },
    {
      phase: "ready",
      view: view({
        record: {
          status: "ok",
          lockingWallet: WALLET,
          graded: 3,
          correct: 2,
          wrong: 1,
          worstMoveBps: -314,
        },
        agreement: "differ",
      }),
    },
  ];
  const ZERO = {
    status: "ok" as const,
    graded: 0,
    correct: 0,
    wrong: 0,
    unrecognised: 0,
    lastGradedAt: null,
  };
  STATES.push(
    { phase: "ready", view: view({ chain: ZERO }) },
    { phase: "ready", view: view({ chain: { ...ZERO, graded: 2, correct: 1, wrong: 1, unrecognised: 2 } }) },
    {
      phase: "ready",
      view: view({
        chain: ZERO,
        record: { status: "unavailable", reason: "timeout", lockingWallet: WALLET },
        agreement: "unknown",
      }),
    },
    { phase: "ready", view: view(), refreshFailed: true },
  );
  const ALL = STATES.flatMap((s) => {
    const m = model(s);
    return [
      m.title,
      m.intro,
      m.sandbox,
      m.status ?? "",
      m.link?.label ?? "",
      ...m.notices,
      ...m.figures.flatMap((f) => [f.label, f.value, f.source]),
    ];
  }).filter(Boolean);

  test.each(["verified", "proven", "guarantee", "recommend", "trustworthy", "safe"])(
    "no sentence says %j",
    (word) => {
      for (const s of ALL) expect(s.toLowerCase()).not.toContain(word);
    },
  );

  test("'advice' appears only in the fixed sentence, and once", () => {
    const saying = ALL.filter((x) => /advice/i.test(x));
    expect(saying.length).toBeGreaterThan(0);
    for (const s of saying) {
      expect(s).toContain(NOT_ADVICE);
      expect(s.match(/advice/gi)).toHaveLength(1);
    }
  });

  test("no sentence carries an em dash", () => {
    for (const s of ALL) expect(s).not.toContain("—");
  });
});
