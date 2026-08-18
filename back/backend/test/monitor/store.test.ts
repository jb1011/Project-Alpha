import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Alert } from "../../src/monitor/alerts";
import { SqliteMonitorStore } from "../../src/monitor/store";
import { ADDR } from "./helpers";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "novi-monitor-")), "monitor.db");
}

function alert(over: Partial<Alert> = {}): Alert {
  return {
    severity: "CRITICAL",
    rule: "controller_role_granted",
    subject: ADDR.controller,
    detail: { role: "0x01", account: ADDR.helper },
    ts: 1_700_000_000_000,
    dedupKey: "controller_role_granted:0xtx:0",
    ...over,
  };
}

describe("cursor", () => {
  test("cold start reports no cursor", () => {
    const store = SqliteMonitorStore.open(":memory:");
    expect(store.getCursor()).toBeUndefined();
  });

  test("survives a restart — the whole point of persisting it", () => {
    const path = tempDbPath();
    const first = SqliteMonitorStore.open(path);
    first.setCursor(57_726_006n);
    first.close();

    const reopened = SqliteMonitorStore.open(path);
    expect(reopened.getCursor()).toBe(57_726_006n);
    reopened.close();
  });

  test("is a single row, not an append log", () => {
    const store = SqliteMonitorStore.open(":memory:");
    store.setCursor(1n);
    store.setCursor(2n);
    store.setCursor(3n);
    expect(store.getCursor()).toBe(3n);
  });

  test("round-trips a block number beyond Number.MAX_SAFE_INTEGER", () => {
    const store = SqliteMonitorStore.open(":memory:");
    const huge = 2n ** 70n;
    store.setCursor(huge);
    expect(store.getCursor()).toBe(huge);
  });
});

describe("open_grants", () => {
  test("opens, lists and closes on (role, account)", () => {
    const store = SqliteMonitorStore.open(":memory:");
    store.openGrant({
      role: "0xrole",
      account: ADDR.helper,
      grantedAtBlock: 100n,
      grantedAtTs: 1000,
    });
    expect(store.listOpenGrants()).toHaveLength(1);
    store.closeGrant("0xrole", ADDR.helper);
    expect(store.listOpenGrants()).toHaveLength(0);
  });

  test("addresses are matched case-insensitively (the chain gives us checksums)", () => {
    const store = SqliteMonitorStore.open(":memory:");
    store.openGrant({
      role: "0xROLE",
      account: ADDR.helper.toUpperCase(),
      grantedAtBlock: 1n,
      grantedAtTs: 1,
    });
    store.closeGrant("0xrole", ADDR.helper.toLowerCase());
    expect(store.listOpenGrants()).toHaveLength(0);
  });

  test("a re-scanned grant does NOT restart the TTL clock", () => {
    const store = SqliteMonitorStore.open(":memory:");
    store.openGrant({ role: "0xr", account: "0xa", grantedAtBlock: 1n, grantedAtTs: 1000 });
    store.openGrant({ role: "0xr", account: "0xa", grantedAtBlock: 1n, grantedAtTs: 9_999_999 });
    expect(store.listOpenGrants()[0]?.grantedAtTs).toBe(1000);
  });

  test("alertedCount persists across a restart, so escalation resumes where it stopped", () => {
    const path = tempDbPath();
    const first = SqliteMonitorStore.open(path);
    first.openGrant({ role: "0xr", account: "0xa", grantedAtBlock: 1n, grantedAtTs: 1000 });
    first.setGrantAlertedCount("0xr", "0xa", 4);
    first.close();

    const reopened = SqliteMonitorStore.open(path);
    expect(reopened.listOpenGrants()[0]?.alertedCount).toBe(4);
    reopened.close();
  });
});

describe("alerts", () => {
  test("records an alert and reports it as new", () => {
    const store = SqliteMonitorStore.open(":memory:");
    expect(store.recordAlert(alert())).toBe(true);
    const [stored] = store.listAlerts();
    expect(stored?.rule).toBe("controller_role_granted");
    expect(stored?.detail).toEqual({ role: "0x01", account: ADDR.helper });
  });

  test("the same dedup key is recorded ONCE and reported as not-new", () => {
    const store = SqliteMonitorStore.open(":memory:");
    expect(store.recordAlert(alert())).toBe(true);
    expect(store.recordAlert(alert({ ts: 2_000_000_000_000 }))).toBe(false);
    expect(store.listAlerts()).toHaveLength(1);
  });

  test("different dedup keys coexist", () => {
    const store = SqliteMonitorStore.open(":memory:");
    store.recordAlert(alert({ dedupKey: "a" }));
    store.recordAlert(alert({ dedupKey: "b" }));
    expect(store.listAlerts()).toHaveLength(2);
  });

  test("INFO is persisted too — the audit trail is the point", () => {
    const store = SqliteMonitorStore.open(":memory:");
    store.recordAlert(alert({ severity: "INFO", rule: "controller_relayed", dedupKey: "i" }));
    expect(store.listAlerts()[0]?.severity).toBe("INFO");
  });

  test("survives a restart (it is the audit log)", () => {
    const path = tempDbPath();
    const first = SqliteMonitorStore.open(path);
    first.recordAlert(alert());
    first.close();
    const reopened = SqliteMonitorStore.open(path);
    expect(reopened.listAlerts()).toHaveLength(1);
    // And a replay after the restart still dedups.
    expect(reopened.recordAlert(alert())).toBe(false);
    reopened.close();
  });
});

describe("migration", () => {
  test("is idempotent", () => {
    const path = tempDbPath();
    SqliteMonitorStore.open(path).close();
    expect(() => SqliteMonitorStore.open(path).close()).not.toThrow();
  });
});
