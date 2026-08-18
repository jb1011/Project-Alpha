import { describe, expect, test, vi } from "vitest";
import { type Alert, type FetchLike, buildAlertSink, logAlertLine } from "../../src/monitor/alerts";
import { SqliteMonitorStore } from "../../src/monitor/store";
import { ADDR } from "./helpers";

function alert(over: Partial<Alert> = {}): Alert {
  return {
    severity: "CRITICAL",
    rule: "beacon_upgraded",
    subject: ADDR.beacon,
    detail: { implementation: ADDR.attacker },
    ts: 1_700_000_000_000,
    dedupKey: "beacon_upgraded:0xtx:0",
    ...over,
  };
}

function harness(over: { webhookUrl?: string; fetchImpl?: FetchLike } = {}) {
  const lines: string[] = [];
  const store = SqliteMonitorStore.open(":memory:");
  const sink = buildAlertSink({
    store,
    webhookUrl: over.webhookUrl,
    fetchImpl: over.fetchImpl,
    writeLine: (l) => lines.push(l),
  });
  return { sink, store, lines };
}

describe("stdout sink", () => {
  test("emits exactly one grep-able {monitor_alert} line", async () => {
    const { sink, lines } = harness();
    await sink.emit(alert());
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.monitor_alert.severity).toBe("CRITICAL");
    expect(parsed.monitor_alert.rule).toBe("beacon_upgraded");
    expect(parsed.monitor_alert.subject).toBe(ADDR.beacon);
    expect(parsed.monitor_alert.ts).toBe("2023-11-14T22:13:20.000Z");
  });

  test("logAlertLine defaults to console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logAlertLine(alert());
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe("dedup", () => {
  test("a repeated alert is silent on every sink", async () => {
    const posts: string[] = [];
    const { sink, lines, store } = harness({
      webhookUrl: "https://example.invalid/hook",
      fetchImpl: async (_u, i) => {
        posts.push(i.body);
        return { ok: true, status: 204 };
      },
    });
    await sink.emit(alert());
    await sink.emit(alert());
    expect(lines).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(store.listAlerts()).toHaveLength(1);
  });
});

describe("webhook", () => {
  test("posts WARN and CRITICAL with the documented keys plus Discord/Slack bodies", async () => {
    let body: Record<string, unknown> = {};
    const { sink } = harness({
      webhookUrl: "https://example.invalid/hook",
      fetchImpl: async (_u, i) => {
        body = JSON.parse(i.body);
        return { ok: true, status: 204 };
      },
    });
    await sink.emit(alert({ severity: "WARN", dedupKey: "w" }));
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(["severity", "rule", "subject", "detail", "ts"]),
    );
    // Discord rejects a payload without `content`; Slack without `text`. Both must be present or
    // the operator has a configured webhook that silently 400s.
    expect(body.content).toBe(
      "[WARN] beacon_upgraded — 0x432ed0814FcDDd03330add098093482128Ad2CfD",
    );
    expect(body.text).toBe(body.content);
  });

  test("never posts INFO — the audit trail must not become a pager", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: true, status: 204 }));
    const { sink, lines } = harness({ webhookUrl: "https://example.invalid/hook", fetchImpl });
    await sink.emit(alert({ severity: "INFO", dedupKey: "i" }));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1); // still recorded + logged.
  });

  test("a THROWING webhook does not throw out of emit — the watcher must stay up", async () => {
    const { sink, lines, store } = harness({
      webhookUrl: "https://example.invalid/hook",
      fetchImpl: async () => {
        throw new Error("ETIMEDOUT");
      },
    });
    await expect(sink.emit(alert())).resolves.toBeUndefined();
    expect(store.listAlerts()).toHaveLength(1);
    const errorLine = lines.map((l) => JSON.parse(l)).find((l) => l.monitor_error);
    expect(errorLine?.monitor_error).toBe("webhook_failed");
    expect(errorLine?.message).toBe("ETIMEDOUT");
  });

  test("a non-2xx webhook is logged, not fatal", async () => {
    const { sink, lines } = harness({
      webhookUrl: "https://example.invalid/hook",
      fetchImpl: async () => ({ ok: false, status: 429 }),
    });
    await sink.emit(alert());
    const errorLine = lines.map((l) => JSON.parse(l)).find((l) => l.monitor_error);
    expect(errorLine?.monitor_error).toBe("webhook_rejected");
    expect(errorLine?.status).toBe(429);
  });

  test("the webhook URL is never written to stdout (it is a bearer credential)", async () => {
    const url = "https://discord.com/api/webhooks/123/SUPER-SECRET-TOKEN";
    const { sink, lines } = harness({
      webhookUrl: url,
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    await sink.emit(alert());
    for (const line of lines) expect(line).not.toContain("SUPER-SECRET-TOKEN");
  });

  test("with no webhook configured the DB and stdout still record everything", async () => {
    const { sink, lines, store } = harness();
    await sink.emit(alert());
    expect(lines).toHaveLength(1);
    expect(store.listAlerts()).toHaveLength(1);
  });
});

describe("storage failure", () => {
  test("an alert is still logged when the store throws — never swallow a CRITICAL", async () => {
    const lines: string[] = [];
    const sink = buildAlertSink({
      store: {
        recordAlert: () => {
          throw new Error("database is locked");
        },
      } as never,
      writeLine: (l) => lines.push(l),
    });
    await sink.emit(alert());
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.find((p) => p.monitor_error)?.monitor_error).toBe("alert_persist_failed");
    expect(parsed.find((p) => p.monitor_alert)?.monitor_alert.rule).toBe("beacon_upgraded");
  });
});
