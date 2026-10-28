import { keccak256, toEventSelector, toFunctionSelector, toHex } from "viem";
import { describe, expect, test } from "vitest";
import {
  FeedbackDecodeError,
  NEW_FEEDBACK_TOPIC0,
  type ReadAllFeedbackResult,
  feedbackEntries,
  reputationReadAbi,
} from "../../src/trackRecord/reputationRead";
import { POSTER, feedbackFixture, fixtureText } from "./helpers";

describe("the hand-written registry fragment", () => {
  test("readAllFeedback has the selector of the verified implementation", () => {
    const fn = reputationReadAbi.find((e) => e.name === "readAllFeedback");
    expect(fn && toFunctionSelector(fn)).toBe("0xd9d84224");
  });

  test("NewFeedback has the topic of the verified implementation", () => {
    const ev = reputationReadAbi.find((e) => e.name === "NewFeedback");
    expect(ev && toEventSelector(ev)).toBe(NEW_FEEDBACK_TOPIC0);
    expect(NEW_FEEDBACK_TOPIC0).toBe(
      "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc",
    );
  });

  test("the fourth topic of the real post is keccak256 of its first tag", () => {
    const log = JSON.parse(fixtureText("explorer-getLogs-897413.json")).result[0];
    expect(log.topics[0]).toBe(NEW_FEEDBACK_TOPIC0);
    expect(log.topics[3]).toBe(keccak256(toHex("accuracy")));
  });
});

describe("feedbackEntries", () => {
  test("zips the real answer for the provider's test agent into one row", () => {
    expect(feedbackEntries(feedbackFixture("readAllFeedback-897413-filtered.hex"))).toEqual([
      {
        client: POSTER,
        value: 0n,
        valueDecimals: 0,
        tag1: "accuracy",
        tag2: "aevum-market-call",
        revoked: false,
      },
    ]);
  });

  test("zips the real unfiltered answer for agent 895447 into its two job entries", () => {
    const rows = feedbackEntries(feedbackFixture("readAllFeedback-895447-unfiltered.hex"));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tag1 === "job" && r.value === 5n)).toBe(true);
  });

  test("the real filtered answer for agent 895447 is empty today", () => {
    expect(feedbackEntries(feedbackFixture("readAllFeedback-895447-filtered.hex"))).toEqual([]);
  });

  test("refuses columns of different lengths", () => {
    const bad = [
      [POSTER],
      [1n],
      [],
      [0],
      ["a"],
      ["b"],
      [false],
    ] as unknown as ReadAllFeedbackResult;
    expect(() => feedbackEntries(bad)).toThrow(FeedbackDecodeError);
  });
});
