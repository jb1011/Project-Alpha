import { describe, expect, test } from "vitest";
import {
  ExplorerAnswerError,
  explorerLogsUrl,
  lastGradedAtFromLogs,
} from "../../src/trackRecord/explorerLogs";
import { NEW_FEEDBACK_TOPIC0 } from "../../src/trackRecord/reputationRead";
import { POSTER, REGISTRY, TAG1, fixtureText } from "./helpers";

const QUERY = {
  explorerApi: "https://explorer.testnet.arc.io/api",
  registry: REGISTRY,
  agentId: 897413n,
  poster: POSTER,
  tag1: TAG1,
  fromBlock: 68_300_000n,
};

function realAnswer() {
  return JSON.parse(fixtureText("explorer-getLogs-897413.json"));
}

describe("explorerLogsUrl", () => {
  test("asks for the event, the agent and the poster from the configured block", () => {
    const u = new URL(explorerLogsUrl(QUERY));
    expect(u.origin + u.pathname).toBe("https://explorer.testnet.arc.io/api");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      module: "logs",
      action: "getLogs",
      fromBlock: "68300000",
      toBlock: "latest",
      address: REGISTRY,
      topic0: NEW_FEEDBACK_TOPIC0,
      topic1: "0x00000000000000000000000000000000000000000000000000000000000db185",
      topic2: `0x000000000000000000000000${POSTER.slice(2).toLowerCase()}`,
      topic0_1_opr: "and",
      topic0_2_opr: "and",
      topic1_2_opr: "and",
    });
  });
});

describe("lastGradedAtFromLogs", () => {
  test("reads the real post's block timestamp", () => {
    expect(lastGradedAtFromLogs(realAnswer(), QUERY)).toBe("2026-10-21T16:16:25.000Z");
  });

  test("keeps the latest of several posts", () => {
    const answer = realAnswer();
    const later = { ...answer.result[0], timeStamp: "0x6ad8e600" };
    answer.result.push(later);
    expect(lastGradedAtFromLogs(answer, QUERY)).toBe(new Date(0x6ad8e600 * 1000).toISOString());
  });

  test("drops a log from another poster", () => {
    const answer = realAnswer();
    answer.result[0].topics[2] = `0x${"0".repeat(24)}${"de".repeat(20)}`;
    expect(lastGradedAtFromLogs(answer, QUERY)).toBeNull();
  });

  test("drops a log under another first tag", () => {
    const answer = realAnswer();
    expect(lastGradedAtFromLogs(answer, { ...QUERY, tag1: "job" })).toBeNull();
  });

  test("drops a log from another contract", () => {
    const answer = realAnswer();
    answer.result[0].address = "0x0000000000000000000000000000000000000001";
    expect(lastGradedAtFromLogs(answer, QUERY)).toBeNull();
  });

  test("drops a log whose timestamp is not hex", () => {
    const answer = realAnswer();
    answer.result[0].timeStamp = "1761063385";
    expect(lastGradedAtFromLogs(answer, QUERY)).toBeNull();
  });

  test("a timestamp beyond what a date can hold drops that log only", () => {
    const answer = realAnswer();
    answer.result.push({ ...answer.result[0], timeStamp: "0xffffffffffff" });
    expect(lastGradedAtFromLogs(answer, QUERY)).toBe("2026-10-21T16:16:25.000Z");
  });

  test("an empty list is no post, not a failure", () => {
    expect(lastGradedAtFromLogs({ message: "No logs found", result: [] }, QUERY)).toBeNull();
  });

  test("an answer with no list is a failure", () => {
    expect(() =>
      lastGradedAtFromLogs({ message: "NOTOK", result: "Max rate limit reached" }, QUERY),
    ).toThrow(ExplorerAnswerError);
    expect(() => lastGradedAtFromLogs(null, QUERY)).toThrow(ExplorerAnswerError);
  });
});
