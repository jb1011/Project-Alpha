import { type Hex, stringToHex } from "viem";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExternalRecordConfig } from "../../src/config/env";
import { type ExternalRecordSources, readExternalRecord } from "../../src/trackRecord/read";
import { RecordSourceError } from "../../src/trackRecord/recordApi";
import type { ReadAllFeedbackResult } from "../../src/trackRecord/reputationRead";
import {
  LOCKING_WALLET,
  POSTER,
  PROVIDER_HOST,
  REGISTRY,
  TAG1,
  TAG2,
  fixtureText,
} from "./helpers";

const CONFIG: ExternalRecordConfig = {
  poster: POSTER,
  tag1: TAG1,
  tag2: TAG2,
  apiBase: `https://${PROVIDER_HOST}`,
  metadataKey: "aevum:lockingWallet",
  providerName: "Aevum",
  explorerApi: "https://explorer.testnet.arc.io/api",
  fromBlock: 68_300_000,
};
const NOW = Date.parse("2026-11-03T10:00:00Z");

/** One correct and one wrong post from the poster, plus a stranger's post the filter must drop. */
const TWO_GRADED: ReadAllFeedbackResult = [
  [POSTER, POSTER, "0x000000000000000000000000000000000000dEaD"],
  [1n, 2n, 1n],
  [100n, 0n, 100n],
  [0, 0, 0],
  [TAG1, TAG1, TAG1],
  [TAG2, TAG2, TAG2],
  [false, false, false],
];

function explorerAnswer(timeStamps: string[]) {
  const log = JSON.parse(fixtureText("explorer-getLogs-897413.json")).result[0];
  log.topics[1] = "0x00000000000000000000000000000000000000000000000000000000000da9d7"; // 895447
  return { message: "OK", result: timeStamps.map((t) => ({ ...log, timeStamp: t })) };
}

function recordAnswer(correct: number, wrong: number, moves: number[]) {
  return JSON.stringify({
    summary: { marketCalls: { correct, wrong, void: 0 } },
    items: moves.map((moveBps, id) => ({ id, status: "verified", marketCall: { moveBps } })),
    recordUrl: `https://${PROVIDER_HOST}/check/${LOCKING_WALLET}`,
  });
}

function sources(over: Partial<ExternalRecordSources> = {}): ExternalRecordSources {
  return {
    readFeedback: async () => TWO_GRADED,
    readMetadata: async () => stringToHex(`eip155:1:${LOCKING_WALLET}`),
    readExplorerLogs: async () => explorerAnswer(["0x6907a000", "0x6908f180"]),
    readRecord: async () => recordAnswer(1, 1, [-314, 120]),
    ...over,
  };
}

function read(over: Partial<ExternalRecordSources> = {}) {
  return readExternalRecord(
    { config: CONFIG, registry: REGISTRY, sources: sources(over), now: () => NOW },
    895447n,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readExternalRecord", () => {
  test("every source answers: both halves, the link, a match, memoisable", async () => {
    const { view, definitive } = await read();
    expect(view).toEqual({
      provider: { name: "Aevum", recordUrl: `https://${PROVIDER_HOST}/check/${LOCKING_WALLET}` },
      agentId: "895447",
      chain: {
        status: "ok",
        graded: 2,
        correct: 1,
        wrong: 1,
        unrecognised: 0,
        lastGradedAt: new Date(0x6908f180 * 1000).toISOString(),
      },
      record: {
        status: "ok",
        lockingWallet: LOCKING_WALLET,
        graded: 2,
        correct: 1,
        wrong: 1,
        worstMoveBps: -314,
      },
      agreement: "match",
      network: "testnet",
      checkedAt: "2026-11-03T10:00:00.000Z",
    });
    expect(definitive).toBe(true);
  });

  test("asks the registry for the poster and both tags only", async () => {
    const readFeedback = vi.fn(async () => TWO_GRADED);
    await read({ readFeedback });
    expect(readFeedback).toHaveBeenCalledWith(895447n, { poster: POSTER, tag1: TAG1, tag2: TAG2 });
  });

  test("nothing posted yet: zero graded and no date, never an error", async () => {
    const empty: ReadAllFeedbackResult = [[], [], [], [], [], [], []];
    const { view, definitive } = await read({
      readFeedback: async () => empty,
      readExplorerLogs: async () => ({ message: "No logs found", result: [] }),
      readRecord: async () => fixtureText("record-running-2026-10-28.json"),
    });
    expect(view.chain).toEqual({
      status: "ok",
      graded: 0,
      correct: 0,
      wrong: 0,
      unrecognised: 0,
      lastGradedAt: null,
    });
    expect(view.record).toMatchObject({ status: "ok", graded: 0, worstMoveBps: null });
    expect(view.agreement).toBe("match");
    expect(definitive).toBe(true);
  });

  test("the halves disagree: both served, agreement differ", async () => {
    const { view } = await read({ readRecord: async () => recordAnswer(2, 1, [-314]) });
    expect(view.chain).toMatchObject({ graded: 2 });
    expect(view.record).toMatchObject({ graded: 3 });
    expect(view.agreement).toBe("differ");
  });

  test("the chain is down: counts unavailable, the record half still read", async () => {
    const { view, definitive } = await read({
      readFeedback: async () => {
        throw new Error("rpc down");
      },
    });
    expect(view.chain).toEqual({ status: "unavailable", reason: "rpc" });
    expect(view.record.status).toBe("ok");
    expect(view.agreement).toBe("unknown");
    expect(definitive).toBe(false);
  });

  test("an answer whose columns do not line up is decode", async () => {
    const bad = [
      [POSTER],
      [1n],
      [],
      [0],
      [TAG1],
      [TAG2],
      [false],
    ] as unknown as ReadAllFeedbackResult;
    const { view } = await read({ readFeedback: async () => bad });
    expect(view.chain).toEqual({ status: "unavailable", reason: "decode" });
  });

  test("the explorer is down: counts kept, no date, not memoisable", async () => {
    const { view, definitive } = await read({
      readExplorerLogs: async () => {
        throw new Error("429");
      },
    });
    expect(view.chain).toMatchObject({ status: "ok", graded: 2, lastGradedAt: null });
    expect(definitive).toBe(false);
  });

  test("the metadata read fails: record unavailable (rpc), no wallet", async () => {
    const { view, definitive } = await read({
      readMetadata: async () => {
        throw new Error("rpc down");
      },
    });
    expect(view.record).toEqual({ status: "unavailable", reason: "rpc", lockingWallet: null });
    expect(view.provider.recordUrl).toBeNull();
    expect(definitive).toBe(false);
  });

  test.each([
    ["no metadata", "0x" as Hex],
    ["another chain", stringToHex(`eip155:5042002:${LOCKING_WALLET}`)],
  ])("%s is not_linked, and memoisable", async (_label, bytes) => {
    const readRecord = vi.fn(async () => recordAnswer(1, 1, []));
    const { view, definitive } = await read({ readMetadata: async () => bytes, readRecord });
    expect(view.record).toEqual({ status: "not_linked" });
    expect(view.provider.recordUrl).toBeNull();
    expect(readRecord).not.toHaveBeenCalled();
    expect(definitive).toBe(true);
  });

  test.each(["http", "too_large", "timeout"] as const)(
    "a %s failure of the provider keeps the wallet and the chain half",
    async (reason) => {
      const { view, definitive } = await read({
        readRecord: async () => {
          throw new RecordSourceError(reason, "x");
        },
      });
      expect(view.record).toEqual({ status: "unavailable", reason, lockingWallet: LOCKING_WALLET });
      expect(view.chain.status).toBe("ok");
      expect(definitive).toBe(false);
    },
  );

  test("a malformed provider body is malformed, and nothing from it is served", async () => {
    const { view } = await read({ readRecord: async () => '{"summary":{}}' });
    expect(view.record).toEqual({
      status: "unavailable",
      reason: "malformed",
      lockingWallet: LOCKING_WALLET,
    });
    expect(view.provider.recordUrl).toBeNull();
  });

  test("a provider link to another host is dropped, the figures kept", async () => {
    const text = JSON.stringify({
      summary: { marketCalls: { correct: 1, wrong: 1 } },
      items: [],
      recordUrl: "https://evil.example/check",
    });
    const { view } = await read({ readRecord: async () => text });
    expect(view.provider.recordUrl).toBeNull();
    expect(view.record).toMatchObject({ status: "ok", graded: 2 });
  });

  test("a provider that hangs is timeout within its 4 s share, the rest unaffected", async () => {
    vi.useFakeTimers();
    const pending = read({ readRecord: () => new Promise<string>(() => undefined) });
    await vi.advanceTimersByTimeAsync(4_001);
    const { view } = await pending;
    expect(view.record).toEqual({
      status: "unavailable",
      reason: "timeout",
      lockingWallet: LOCKING_WALLET,
    });
    expect(view.chain.status).toBe("ok");
  });

  test("everything hangs: the answer still comes back within 8 s", async () => {
    vi.useFakeTimers();
    const never = () => new Promise<never>(() => undefined);
    const pending = read({
      readFeedback: never,
      readMetadata: never,
      readExplorerLogs: never,
      readRecord: never,
    });
    await vi.advanceTimersByTimeAsync(8_001);
    const { view, definitive } = await pending;
    expect(view.chain).toEqual({ status: "unavailable", reason: "rpc" });
    expect(view.record).toEqual({ status: "unavailable", reason: "rpc", lockingWallet: null });
    expect(definitive).toBe(false);
  });

  test("hands the explorer the abort signal of its deadline", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const pending = read({
      readExplorerLogs: (_url, signal) => {
        seen = signal;
        return new Promise<never>(() => undefined);
      },
    });
    await vi.advanceTimersByTimeAsync(4_001);
    await pending;
    expect(seen?.aborted).toBe(true);
  });
});
