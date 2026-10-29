import { describe, expect, test } from "vitest";
import {
  RecordSourceError,
  fetchRecordText,
  parseRecordAnswer,
  recordUrlFor,
  safeRecordUrl,
} from "../../src/trackRecord/recordApi";
import { LOCKING_WALLET, PROVIDER_HOST, fixtureText } from "./helpers";

/** The provider's own test wallets, the subjects of the two graded fixtures (public record API). */
const WALLET_ONE = "0x3692f08070352D08E2281112CCC8a700C4d89256" as const;
const WALLET_OTHER = "0xbc2C6f49C34ae735a5A85cBC637b83B875d352e5" as const;

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof RecordSourceError ? e.reason : "other";
  }
  return undefined;
}

function answer(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    summary: { marketCalls: { correct: 0, wrong: 0, void: 0 } },
    items: [],
    recordUrl: `https://${PROVIDER_HOST}/check/${LOCKING_WALLET}`,
    ...over,
  });
}

describe("parseRecordAnswer", () => {
  test("the real answer of 28 October: two running calls, nothing graded, the link kept", () => {
    expect(
      parseRecordAnswer(
        fixtureText("record-running-2026-10-28.json"),
        PROVIDER_HOST,
        LOCKING_WALLET,
      ),
    ).toEqual({
      graded: 0,
      correct: 0,
      wrong: 0,
      worstMoveBps: null,
      recordUrl: `https://${PROVIDER_HOST}/check/${LOCKING_WALLET}`,
    });
  });

  test("a real graded answer: one wrong call at -216 bps", () => {
    const parsed = parseRecordAnswer(
      fixtureText("record-graded-one-wrong.json"),
      PROVIDER_HOST,
      WALLET_ONE,
    );
    expect(parsed).toMatchObject({ graded: 1, correct: 0, wrong: 1, worstMoveBps: -216 });
  });

  test("a real answer with one graded and one running call: worst is the graded one", () => {
    const parsed = parseRecordAnswer(
      fixtureText("record-graded-other.json"),
      PROVIDER_HOST,
      WALLET_OTHER,
    );
    expect(parsed).toMatchObject({ graded: 1, wrong: 1, worstMoveBps: -314 });
  });

  test("worst is the most negative move", () => {
    const items = [{ marketCall: { moveBps: -314 } }, { marketCall: { moveBps: 120 } }, {}];
    const text = answer({ summary: { marketCalls: { correct: 1, wrong: 1, void: 0 } }, items });
    expect(parseRecordAnswer(text, PROVIDER_HOST, LOCKING_WALLET)).toMatchObject({
      graded: 2,
      correct: 1,
      wrong: 1,
      worstMoveBps: -314,
    });
  });

  test("a record about another wallet is malformed", () => {
    const text = fixtureText("record-graded-one-wrong.json");
    expect(reason(() => parseRecordAnswer(text, PROVIDER_HOST, LOCKING_WALLET))).toBe("malformed");
  });

  test("the wallet is compared without regard to case", () => {
    const text = answer({ address: LOCKING_WALLET.toLowerCase() });
    expect(parseRecordAnswer(text, PROVIDER_HOST, LOCKING_WALLET).graded).toBe(0);
  });

  test("void calls are not graded", () => {
    const text = answer({ summary: { marketCalls: { correct: 1, wrong: 0, void: 3 } } });
    expect(parseRecordAnswer(text, PROVIDER_HOST, LOCKING_WALLET).graded).toBe(1);
  });

  test.each([
    ["not JSON", "<html>"],
    ["a string count", answer({ summary: { marketCalls: { correct: "1", wrong: 0 } } })],
    ["a negative count", answer({ summary: { marketCalls: { correct: -1, wrong: 0 } } })],
    ["no summary", JSON.stringify({ items: [] })],
    ["too many items", answer({ items: Array.from({ length: 600 }, () => ({})) })],
    ["a fractional move", answer({ items: [{ marketCall: { moveBps: 3.5 } }] })],
    ["an oversized asset", answer({ items: [{ marketCall: { asset: "x".repeat(65) } }] })],
  ])("refuses %s as malformed", (_label, text) => {
    expect(reason(() => parseRecordAnswer(text, PROVIDER_HOST, LOCKING_WALLET))).toBe("malformed");
  });
});

describe("safeRecordUrl", () => {
  test.each([
    ["http", `http://${PROVIDER_HOST}/check/x`],
    ["another host", "https://evil.example/check/x"],
    ["a subdomain", `https://a.${PROVIDER_HOST}/check/x`],
    ["a port", `https://${PROVIDER_HOST}:8443/check/x`],
    ["userinfo", `https://user@${PROVIDER_HOST}/check/x`],
    ["javascript", "javascript:alert(1)"],
    ["not a URL", "check/x"],
  ])("drops %s", (_label, raw) => {
    expect(safeRecordUrl(raw, PROVIDER_HOST)).toBeNull();
  });

  test("keeps an https link on the provider's host", () => {
    expect(safeRecordUrl(`https://${PROVIDER_HOST}/check/x`, PROVIDER_HOST)).toBe(
      `https://${PROVIDER_HOST}/check/x`,
    );
  });
});

describe("recordUrlFor", () => {
  test("builds the one runtime URL from config and the address", () => {
    expect(recordUrlFor("https://app.aevumprotocol.io", LOCKING_WALLET)).toBe(
      `https://app.aevumprotocol.io/api/record?address=${LOCKING_WALLET}`,
    );
  });
});

describe("fetchRecordText", () => {
  // A public IP literal: `safeFetch` classifies it without a DNS lookup, so no test reaches the
  // network. The fetch itself is the stub.
  const BASE = "https://93.184.216.34";

  async function fetchReason(fetchImpl: typeof fetch): Promise<string | undefined> {
    try {
      await fetchRecordText(fetchImpl, BASE, LOCKING_WALLET);
    } catch (e) {
      return e instanceof RecordSourceError ? e.reason : "other";
    }
    return undefined;
  }

  test("returns the body of a 200", async () => {
    const stub = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    expect(await fetchRecordText(stub, BASE, LOCKING_WALLET)).toBe("{}");
  });

  test("a non-2xx is http", async () => {
    expect(
      await fetchReason((async () => new Response("no", { status: 503 })) as typeof fetch),
    ).toBe("http");
  });

  test("a redirect is http (refused by the SSRF guard)", async () => {
    const stub = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere" },
      })) as typeof fetch;
    expect(await fetchReason(stub)).toBe("http");
  });

  test("a network failure is http", async () => {
    expect(
      await fetchReason((async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch),
    ).toBe("http");
  });

  test("an aborted request is timeout", async () => {
    expect(
      await fetchReason((async () => {
        throw new DOMException("aborted", "AbortError");
      }) as typeof fetch),
    ).toBe("timeout");
  });

  test("a body over 256 KiB is too_large", async () => {
    const big = "x".repeat(300 * 1024);
    expect(
      await fetchReason((async () => new Response(big, { status: 200 })) as typeof fetch),
    ).toBe("too_large");
  });

  test("a declared length over the cap is too_large before any read", async () => {
    const stub = (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": String(1024 * 1024) },
      })) as typeof fetch;
    expect(await fetchReason(stub)).toBe("too_large");
  });

  test("an abort stops a trickling body and cancels the stream", async () => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setInterval(() => controller.enqueue(new TextEncoder().encode("x")), 10);
      },
      cancel() {
        cancelled = true;
        clearInterval(timer);
      },
    });
    const stub = (async () => new Response(body, { status: 200 })) as typeof fetch;
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    await expect(fetchRecordText(stub, BASE, LOCKING_WALLET, ctrl.signal)).rejects.toMatchObject({
      reason: "timeout",
    });
    expect(cancelled).toBe(true);
    clearInterval(timer);
  });

  test("refuses a non-https base", async () => {
    const stub = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    await expect(fetchRecordText(stub, "http://93.184.216.34", LOCKING_WALLET)).rejects.toThrow(
      RecordSourceError,
    );
  });
});
