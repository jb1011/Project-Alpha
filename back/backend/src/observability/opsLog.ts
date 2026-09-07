import { redactPii } from "../formation/pii";

/**
 * S5 — the money-path decision trail. One JSON line per event to stdout -> journald; no new
 * infra, `journalctl | grep` is the v1 query tool. This gap cost us twice in one week: an
 * undiagnosable World verify failure and an unexplainable Turnkey quota exhaustion.
 *
 * NEVER pass secrets in `fields` — amounts, paths, reasons, ids, addresses only (same discipline
 * as env.ts's redact()). Events are flat and grep-able: `journalctl -u legalbody-api | grep opslog`.
 */

/**
 * The fields whose VALUES are free text, and therefore the fields that can carry text we did not
 * write (design §4).
 *
 * Everything else an ops line holds is ours: an id, a count, a state, an event name. These four
 * are where a third party's sentence ends up — a provider's validation error quoting the field it
 * refused, an exception message embedding the request body — and that sentence is the one leak
 * vector for an SSN that no producer can be trusted to close on its own. So the redaction is
 * HERE, at the write, rather than at each of the dozens of call sites.
 */
const FREE_TEXT_FIELD = /error|message|reason|detail/i;

export function opsLog(event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields))
    safe[k] = typeof v === "string" && FREE_TEXT_FIELD.test(k) ? redactPii(v) : v;
  console.log(JSON.stringify({ opslog: event, at: new Date().toISOString(), ...safe }));
}
