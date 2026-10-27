/**
 * The HTTP client against answers the Kleros testnet deployment gave to a read-only check: court 8
 * and public case 186 on arbitrum-sepolia-testnet, each kept in `test/fixtures/kleros/` as the
 * JSON-RPC message received, untouched.
 *
 * Each is served back in the SSE frame it arrived in, so the parsers stay pinned to the real
 * shapes: the court object at the top level with its clock as numeric strings; the dispute as
 * `items[0]` with numeric option values, a 0 option included, and a null deadline; and a payload
 * text that carries suggested commands in prose after its JSON, next to a `_meta` member the
 * client does not read.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KLEROS_DEPLOYMENTS } from "../../../src/adapters/kleros/deployments";
import {
  HttpDisputeService,
  normaliseRulingValue,
  parseToolPayload,
} from "../../../src/adapters/kleros/httpDisputeService";

const TESTNET = KLEROS_DEPLOYMENTS.testnet.chain;
const COURT_FILE = "court-get-8.json";
const DISPUTE_FILE = "dispute-get-186.json";

interface Recorded {
  result: { content: { type: string; text: string }[] };
}

function recorded(file: string): Recorded {
  const url = new URL(`../../fixtures/kleros/${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Recorded;
}

function textOf(message: Recorded): string {
  const text = message.result.content[0]?.text;
  if (typeof text !== "string") throw new Error("the recorded answer carries no text");
  return text;
}

/** A testnet client whose fetch answers the recorded message once, framed as it arrived. */
function serving(message: Recorded) {
  const requests: unknown[] = [];
  const fetchStub = async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length > 1) throw new Error("the recorded answer is served once");
    return new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const svc = new HttpDisputeService({
    apiUrl: "https://dispute-service.example.test/mcp",
    apiKey: "test-key-testnet",
    deployment: "testnet",
    fetch: fetchStub as typeof fetch,
  });
  return { svc, requests };
}

const paramsOf = (body: unknown) =>
  (body as { params: { name: string; arguments: unknown } }).params;

describe("the answers the testnet deployment gave", () => {
  it.each([[COURT_FILE], [DISPUTE_FILE]])(
    "%s: the payload text carries prose after its JSON",
    (file) => {
      const text = textOf(recorded(file));
      const json = JSON.stringify(parseToolPayload(text));
      expect(text.startsWith(json)).toBe(true);
      expect(text.slice(json.length)).toMatch(/^\n\nSuggested commands:\n {2}kleros \S/);
    },
  );

  it("reads court 8: its clock from numeric strings, its votes hidden", async () => {
    const message = recorded(COURT_FILE);
    const { svc, requests } = serving(message);
    const clock = await svc.getCourt({ chain: TESTNET, courtId: 8 });
    expect(clock.courtId).toBe(8);
    expect(clock.timesPerPeriod).toEqual([900, 2700, 1800, 2700]);
    expect(clock.hiddenVotes).toBe(true);
    expect(clock.raw).toEqual(parseToolPayload(textOf(message)));
    expect(requests).toHaveLength(1);
    expect(paramsOf(requests[0])).toEqual({
      name: "court_get",
      arguments: { chain: TESTNET, id: "8" },
    });
  });

  it("reads case 186: executed, ruling 2 of four options from 0 to 3", async () => {
    const message = recorded(DISPUTE_FILE);
    const { svc, requests } = serving(message);
    const read = await svc.getDispute({ chain: TESTNET, coreDisputeId: "186" });
    expect(read.status).toBe("Executed");
    expect(read.ruling).toBe("2");
    expect(read.tied).toBe(false);
    expect(read.ruled).toBe(true);
    expect(read.roundCount).toBe(1);
    expect(read.deadline).toBeNull();
    expect(read.unresolvedFields).toEqual([]);
    expect(read.rulingOptions).toEqual([
      { value: "0", title: "Refuse to Arbitrate / Invalid" },
      { value: "1", title: "Accept buyer; refund 100%." },
      { value: "2", title: "Do not accept; pay merchant." },
      { value: "3", title: "Partial; refund 50%." },
    ]);
    expect(read.lastPeriodChange).toBe("2026-10-15T12:31:45.000Z");
    expect(read.rulingLabel).toBe("Do not accept; pay merchant.");
    expect(read.rulingOptions.map((o) => normaliseRulingValue(o.value))).toEqual([0n, 1n, 2n, 3n]);
    // The ruling is matched to its option on the value, as later code reads it.
    const ruled = read.rulingOptions.find(
      (o) => normaliseRulingValue(o.value) === normaliseRulingValue(read.ruling),
    );
    expect(ruled?.title).toBe(read.rulingLabel);
    expect(read.raw).toEqual((parseToolPayload(textOf(message)) as { items: unknown[] }).items[0]);
    expect(requests).toHaveLength(1);
    expect(paramsOf(requests[0])).toEqual({
      name: "dispute_get",
      arguments: { id: "186", chain: TESTNET },
    });
  });
});
