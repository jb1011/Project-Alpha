/**
 * S5 — the money-path decision trail. One JSON line per event to stdout -> journald; no new
 * infra, `journalctl | grep` is the v1 query tool. This gap cost us twice in one week: an
 * undiagnosable World verify failure and an unexplainable Turnkey quota exhaustion.
 *
 * NEVER pass secrets in `fields` — amounts, paths, reasons, ids, addresses only (same discipline
 * as env.ts's redact()). Events are flat and grep-able: `journalctl -u legalbody-api | grep opslog`.
 */
export function opsLog(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ opslog: event, at: new Date().toISOString(), ...fields }));
}
