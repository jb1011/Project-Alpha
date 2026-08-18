import type { MonitorStore } from "./store";

/**
 * Alerts and their three sinks.
 *
 * Severity contract (the runbook depends on it):
 *  - INFO     recorded, never paged. The audit trail — "this happened and it was expected."
 *  - WARN     recorded + webhook. A human should look today.
 *  - CRITICAL recorded + webhook. A human should look NOW; every CRITICAL in this monitor is an
 *             event whose only mitigation is a fast human reaction (design §8: the 24h admin delay
 *             and the guardian veto are reaction windows, not automatic defenses).
 */
export type Severity = "INFO" | "WARN" | "CRITICAL";

export interface Alert {
  severity: Severity;
  /** Stable identifier, one per rule — the key the runbook is indexed by. */
  rule: string;
  /** WHAT the alert is about: a contract address, a treasury, an entity. */
  subject: string;
  detail: Record<string, unknown>;
  /** ms epoch. */
  ts: number;
  /**
   * Idempotency key. Derived from the log's (txHash, logIndex) for chain-derived alerts and from
   * (grant, interval) for the TTL sweep, so a re-scanned chunk or a restarted process re-derives
   * the SAME key and the alert is recorded once. Never include a wall clock in it.
   */
  dedupKey: string;
}

export interface AlertSink {
  emit(alert: Alert): Promise<void>;
}

/** Minimal fetch shape — injected so webhook behaviour is testable without a network. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface AlertSinkDeps {
  store: MonitorStore;
  /** Absent = webhook sink disabled (stdout + DB still record everything). */
  webhookUrl?: string;
  fetchImpl?: FetchLike;
  webhookTimeoutMs?: number;
  /** Seam for tests; defaults to console.log. */
  writeLine?: (line: string) => void;
}

/** One JSON line to stdout -> journald, matching the opsLog idiom (`journalctl -u legalbody-monitor
 *  | grep monitor_alert`). Kept as its own key so alerts are greppable apart from ops chatter. */
export function logAlertLine(alert: Alert, writeLine: (line: string) => void = console.log): void {
  writeLine(
    JSON.stringify({
      monitor_alert: {
        severity: alert.severity,
        rule: alert.rule,
        subject: alert.subject,
        detail: alert.detail,
        ts: new Date(alert.ts).toISOString(),
      },
    }),
  );
}

/** Human one-liner. Discord renders `content`, Slack renders `text`; both ignore the other keys. */
export function summarize(alert: Alert): string {
  return `[${alert.severity}] ${alert.rule} — ${alert.subject}`;
}

/**
 * Build the fan-out sink: dedup -> stdout -> webhook.
 *
 * Order is deliberate. The DB insert is the dedup gate, so it runs first; if it throws (disk full,
 * DB locked) we still emit the line rather than swallow an alert — losing a CRITICAL to a storage
 * problem is the one failure mode this component cannot have.
 */
export function buildAlertSink(deps: AlertSinkDeps): AlertSink {
  const write = deps.writeLine ?? ((l: string) => console.log(l));
  const doFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = deps.webhookTimeoutMs ?? 10_000;

  return {
    async emit(alert: Alert): Promise<void> {
      let fresh = true;
      try {
        fresh = deps.store.recordAlert(alert);
      } catch (err) {
        write(
          JSON.stringify({
            monitor_error: "alert_persist_failed",
            rule: alert.rule,
            message: (err as Error).message,
          }),
        );
      }
      if (!fresh) return; // already recorded (re-scanned chunk / restart) — stay silent.

      logAlertLine(alert, write);

      if (!deps.webhookUrl || alert.severity === "INFO") return;
      try {
        const res = await doFetch(deps.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            severity: alert.severity,
            rule: alert.rule,
            subject: alert.subject,
            detail: alert.detail,
            ts: new Date(alert.ts).toISOString(),
            // Discord requires `content`, Slack requires `text` — without these the POST is a 400
            // and the operator is left with a webhook that is configured but silent.
            content: summarize(alert),
            text: summarize(alert),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok)
          write(
            JSON.stringify({
              monitor_error: "webhook_rejected",
              rule: alert.rule,
              status: res.status,
            }),
          );
      } catch (err) {
        // Never fatal: a down webhook must not stop the watcher. The alert is already in the DB
        // and on stdout, which is why this can be a log line rather than a retry queue.
        write(
          JSON.stringify({
            monitor_error: "webhook_failed",
            rule: alert.rule,
            message: (err as Error).message,
          }),
        );
      }
    },
  };
}
