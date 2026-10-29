import { describe, expect, test } from "vitest";
import { classifyFeedback } from "../../src/trackRecord/classify";
import { type FeedbackEntry, feedbackEntries } from "../../src/trackRecord/reputationRead";
import { POSTER, TAG1, TAG2, feedbackFixture } from "./helpers";

const FILTER = { poster: POSTER, tag1: TAG1, tag2: TAG2 };

function entry(over: Partial<FeedbackEntry>): FeedbackEntry {
  return {
    client: POSTER,
    value: 100n,
    valueDecimals: 0,
    tag1: TAG1,
    tag2: TAG2,
    revoked: false,
    ...over,
  };
}

describe("classifyFeedback", () => {
  test("the real post on the provider's test agent is one wrong call", () => {
    const rows = feedbackEntries(feedbackFixture("readAllFeedback-897413-filtered.hex"));
    expect(classifyFeedback(rows, FILTER)).toEqual({
      graded: 1,
      correct: 0,
      wrong: 1,
      unrecognised: 0,
    });
  });

  test("the two job entries on agent 895447 never count, even if the registry passed them", () => {
    const rows = feedbackEntries(feedbackFixture("readAllFeedback-895447-unfiltered.hex"));
    expect(classifyFeedback(rows, FILTER)).toEqual({
      graded: 0,
      correct: 0,
      wrong: 0,
      unrecognised: 0,
    });
  });

  test("100 is correct, 0 is wrong, anything else is unrecognised", () => {
    const rows = [
      entry({ value: 100n }),
      entry({ value: 0n }),
      entry({ value: 5n }),
      entry({ value: 100n, valueDecimals: 2 }),
      entry({ value: -100n }),
    ];
    expect(classifyFeedback(rows, FILTER)).toEqual({
      graded: 2,
      correct: 1,
      wrong: 1,
      unrecognised: 3,
    });
  });

  test("drops revoked rows, other posters and other tags", () => {
    const rows = [
      entry({ revoked: true }),
      entry({ client: "0x000000000000000000000000000000000000dEaD" }),
      entry({ tag1: "job" }),
      entry({ tag2: "" }),
      entry({ client: POSTER.toLowerCase() as `0x${string}`, value: 0n }),
    ];
    expect(classifyFeedback(rows, FILTER)).toEqual({
      graded: 1,
      correct: 0,
      wrong: 1,
      unrecognised: 0,
    });
  });
});
